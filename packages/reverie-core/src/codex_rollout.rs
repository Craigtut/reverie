//! Reader for Codex CLI rollout JSONL session logs.
//!
//! Codex appends one JSON record per line to
//! `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. The first record
//! is `session_meta` (native id + cwd); subsequent records narrate the turn
//! (`task_started`, `function_call` / `function_call_output`, `task_complete`,
//! `turn_aborted`, `error`, plus reasoning/message chatter we ignore). Reverie
//! folds the log into the same unified [`ActivityState`] the Cortex watcher and
//! the Claude hook server produce, so the dashboard never learns it came from a
//! file rather than a hook.
//!
//! Pure parsing + discovery only. Filesystem watching lives in the shell. Codex
//! has no HTTP hook type and trust-gates command hooks, so this file watcher is
//! the baseline lifecycle source; the definitive `awaiting_permission` signal
//! comes from the (separately wired) trusted `PermissionRequest` command hook.

use std::{
    collections::BTreeSet,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;

use crate::activity::{
    ActiveTool, ActivityError, ActivityState, ActivityStatus, ActivityTurn, ErrorCategory,
    PermissionRequest, TurnStatus,
};
use crate::activity_source::{ActivitySourceKind, Fidelity};
use crate::agents::{file_modified_ms, same_logical_path};
use crate::domain::NativeSessionRef;
use crate::reentry_context::{ReentryBudget, ReentryContext, ReentryEntry};
use crate::session_log::{LogReadMode, SessionLogFold, SessionLogSource};

const ACTIVITY_VERSION: u32 = 1;

/// How many leading lines to scan for the `session_meta` record. It is always
/// the first record, but a budget keeps a malformed file from being read whole.
const META_LINE_BUDGET: usize = 8;

/// One rollout line: a top-level `type` + `timestamp` wrapping a `payload` whose
/// own `type` discriminates the event. We keep `payload` as a `Value` because
/// the union is wide and we only touch a few fields per arm.
#[derive(Debug, Deserialize)]
struct RolloutLine {
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(rename = "type")]
    record_type: String,
    #[serde(default)]
    payload: Value,
}

/// Identity captured from the rollout's first `session_meta` record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexRolloutMeta {
    pub session_id: String,
    pub cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexTitleContext {
    pub user_messages: Vec<String>,
    pub user_message_count: u64,
    pub sequence: u64,
}

/// Read the `session_meta` identity (native id + cwd) from a rollout file, or
/// `None` if it has not been written yet. Metadata-only: stops at the first
/// `session_meta` (the first record) within a small line budget.
pub fn read_codex_rollout_meta(path: &Path) -> Option<CodexRolloutMeta> {
    let reader = BufReader::new(fs::File::open(path).ok()?);
    for line in reader.lines().take(META_LINE_BUDGET) {
        let Ok(line) = line else {
            break;
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<RolloutLine>(&line) else {
            continue;
        };
        if record.record_type == "session_meta" {
            let session_id = record.payload.get("id").and_then(Value::as_str)?.to_owned();
            let cwd = record
                .payload
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            return Some(CodexRolloutMeta { session_id, cwd });
        }
    }
    None
}

pub fn read_codex_title_context(
    path: &Path,
    max_messages: usize,
    max_total_chars: usize,
) -> Result<Option<CodexTitleContext>> {
    let reader = BufReader::new(
        fs::File::open(path).with_context(|| format!("open Codex rollout {}", path.display()))?,
    );
    let mut sequence = 0_u64;
    let mut user_messages = Vec::new();

    for line in reader.lines() {
        let line = line?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<RolloutLine>(line) else {
            continue;
        };
        sequence += 1;
        if let Some(message) = extract_user_message_text(&record.payload) {
            user_messages.push(message);
        }
    }

    if user_messages.is_empty() {
        return Ok(None);
    }
    let user_message_count = user_messages.len() as u64;
    let user_messages = recent_messages_with_budget(user_messages, max_messages, max_total_chars);
    Ok(Some(CodexTitleContext {
        user_messages,
        user_message_count,
        sequence,
    }))
}

/// Read a re-entry window (recent user/assistant messages and tool actions) from
/// a Codex rollout, distilled into the CLI-agnostic [`ReentryContext`]. Unlike
/// [`read_codex_title_context`] (user messages only), this keeps the back-and-
/// forth so the summary can describe what the agent did and what it is asking.
pub fn read_codex_reentry_context(
    path: &Path,
    budget: ReentryBudget,
) -> Result<Option<ReentryContext>> {
    let reader = BufReader::new(
        fs::File::open(path).with_context(|| format!("open Codex rollout {}", path.display()))?,
    );
    let mut entries = Vec::new();
    for line in reader.lines() {
        let line = line?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<RolloutLine>(line) else {
            continue;
        };
        if let Some(text) = extract_user_message_text(&record.payload) {
            entries.push(ReentryEntry::user(text));
        } else if let Some(text) = extract_assistant_message_text(&record.payload) {
            entries.push(ReentryEntry::assistant(text));
        } else if let Some(text) = extract_tool_summary(&record.payload) {
            entries.push(ReentryEntry::tool(text));
        }
    }

    let context = ReentryContext::from_entries(entries, budget);
    if context.is_empty() {
        Ok(None)
    } else {
        Ok(Some(context))
    }
}

/// The Codex source: recognizes `rollout-*.jsonl` files and makes folds. This is
/// the thin per-CLI wrapper the [`crate::session_log`] engine drives; a future
/// append-log CLI is the same shape.
pub struct CodexLogSource;

impl SessionLogSource for CodexLogSource {
    fn matches(&self, path: &Path) -> bool {
        is_rollout_path(path)
    }

    fn new_fold(&self, _path: &Path) -> Box<dyn SessionLogFold> {
        Box::new(CodexRolloutFold::new())
    }
}

/// Whether `path` is a Codex rollout file (`.../rollout-*.jsonl`).
pub fn is_rollout_path(path: &Path) -> bool {
    let is_jsonl = path.extension().and_then(|ext| ext.to_str()) == Some("jsonl");
    let named_rollout = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("rollout-"));
    is_jsonl && named_rollout
}

/// Incremental fold of a Codex rollout into the current [`ActivityState`].
///
/// Holds a partial-line buffer so the watcher can feed it arbitrary byte chunks
/// (an appended tail may end mid-line): complete lines are processed, the
/// remainder is kept for the next chunk. `sequence` counts processed records so
/// a later read is always strictly newer. This is the whole reason the watcher
/// is cheap, it folds only new records, never the accumulated history.
pub struct CodexRolloutFold {
    partial: String,
    session_id: Option<String>,
    cwd: String,
    status: ActivityStatus,
    active: Vec<ActiveTool>,
    last_error: Option<ActivityError>,
    last_timestamp: Option<String>,
    // The turn the rollout is currently narrating (from `task_started`/end
    // records). Carried onto every emitted state so the cross-source reconciler
    // can tell a current turn edge from a stale one (turn_ids are time-ordered
    // UUIDv7), and so the rollout's `turn_aborted` can end the exact turn the
    // `Stop` hook missed.
    current_turn_id: Option<String>,
    sequence: u64,
    // Best-effort approval signal: Codex records the approval-triggering moment
    // as a `function_call` carrying `with_escalated_permissions: true`. While
    // such a call has no matching output, the user is (under the usual policies)
    // being prompted to approve it. The definitive signal is the trusted
    // `PermissionRequest` command hook; this keeps the dashboard honest until
    // (and where) that hook is not wired.
    pending_escalation: Option<PermissionRequest>,
}

impl CodexRolloutFold {
    pub fn new() -> Self {
        Self {
            partial: String::new(),
            session_id: None,
            cwd: String::new(),
            status: ActivityStatus::Working,
            active: Vec::new(),
            last_error: None,
            last_timestamp: None,
            current_turn_id: None,
            sequence: 0,
            pending_escalation: None,
        }
    }

    /// Fold one complete JSONL record line (newline already stripped).
    fn process_line(&mut self, line: &str) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        let Ok(record) = serde_json::from_str::<RolloutLine>(line) else {
            return;
        };
        self.sequence += 1;
        if let Some(ts) = &record.timestamp {
            self.last_timestamp = Some(ts.clone());
        }

        let payload_type = record
            .payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("");

        match (record.record_type.as_str(), payload_type) {
            ("session_meta", _) => {
                if let Some(id) = record.payload.get("id").and_then(Value::as_str) {
                    self.session_id = Some(id.to_owned());
                }
                if let Some(c) = record.payload.get("cwd").and_then(Value::as_str) {
                    self.cwd = c.to_owned();
                }
            }
            // A turn started: agent is working again; clear the previous turn's
            // tools, pending approval, and any prior error.
            (_, "task_started") => {
                self.status = ActivityStatus::Working;
                self.current_turn_id = turn_id_from(&record.payload);
                self.active.clear();
                self.pending_escalation = None;
                self.last_error = None;
            }
            // A tool call begins: still working, surface it as the active tool.
            // An escalated call also records a pending approval.
            (_, "function_call") | (_, "custom_tool_call") => {
                self.status = ActivityStatus::Working;
                if let Some(tool) = active_tool_from_call(
                    &record.payload,
                    self.sequence,
                    self.last_timestamp.as_deref(),
                ) {
                    if let Some(request) = escalated_permission_from_call(
                        &record.payload,
                        &tool,
                        self.last_timestamp.as_deref(),
                    ) {
                        self.pending_escalation = Some(request);
                    }
                    self.active.push(tool);
                }
            }
            // The matching tool finished: drop just that tool (by call id) and
            // clear a pending approval if it was for that call.
            (_, "function_call_output") | (_, "custom_tool_call_output") => {
                match record.payload.get("call_id").and_then(Value::as_str) {
                    Some(call_id) => {
                        self.active.retain(|tool| tool.tool_call_id != call_id);
                        if self
                            .pending_escalation
                            .as_ref()
                            .is_some_and(|req| req.id == call_id)
                        {
                            self.pending_escalation = None;
                        }
                    }
                    None => {
                        self.active.clear();
                        self.pending_escalation = None;
                    }
                }
            }
            // The turn ended (cleanly or interrupted): idle, waiting on the user.
            // Keep `current_turn_id` set to the turn that ended (preferring the
            // record's own turn_id) so the reconciler ends exactly that turn,
            // which is how `turn_aborted` backstops a missed `Stop` hook.
            (_, "task_complete") | (_, "turn_aborted") => {
                self.status = ActivityStatus::AwaitingInput;
                if let Some(id) = turn_id_from(&record.payload) {
                    self.current_turn_id = Some(id);
                }
                self.active.clear();
                self.pending_escalation = None;
            }
            // Long-running Codex goals keep emitting these after the ordinary
            // prompt/turn records. Treat an active goal as liveness, otherwise a
            // resumed goal can sit behind the last `task_complete` and read idle.
            (_, "thread_goal_updated") => match goal_status_from(&record.payload).as_deref() {
                Some("active") => {
                    self.status = ActivityStatus::Working;
                    if let Some(id) = turn_id_from(&record.payload) {
                        self.current_turn_id = Some(id);
                    }
                    self.last_error = None;
                }
                Some("complete") | Some("usageLimited") => {
                    self.status = ActivityStatus::AwaitingInput;
                    if let Some(id) = turn_id_from(&record.payload) {
                        self.current_turn_id = Some(id);
                    }
                    self.active.clear();
                    self.pending_escalation = None;
                }
                _ => {}
            },
            (_, "error") => {
                self.status = ActivityStatus::Error;
                let message = record
                    .payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex reported an error")
                    .to_owned();
                self.last_error = Some(ActivityError {
                    category: ErrorCategory::Other,
                    message,
                    // Conservative: a logged rollout error is usually a recoverable
                    // hiccup, so we do not escalate the session to "attention".
                    recoverable: true,
                    occurred_at: self.last_timestamp.clone().unwrap_or_default(),
                });
            }
            // reasoning / message / token_count / web_search / turn_context, etc.:
            // they advance liveness (the sequence) but do not change status.
            _ => {}
        }
    }

    /// The current state, or `None` until `session_meta` has given us the native
    /// id (nothing for the dashboard to key on before that).
    fn current_state(&self) -> Option<ActivityState> {
        let session_id = self.session_id.clone()?;
        // A still-pending escalation wins the status: the agent is blocked on the
        // user's approval, which the dashboard surfaces as a first-class state.
        let status = if self.pending_escalation.is_some() {
            ActivityStatus::AwaitingPermission
        } else {
            self.status
        };
        // Stamp the narrated turn so the reconciler can order this edge against
        // the hook's. Its `status` reflects whether the turn is still running.
        let turn = self.current_turn_id.as_ref().map(|id| ActivityTurn {
            id: id.clone(),
            status: match self.status {
                ActivityStatus::AwaitingInput | ActivityStatus::Done | ActivityStatus::Error => {
                    TurnStatus::Completed
                }
                _ => TurnStatus::Running,
            },
            started_at: self.last_timestamp.clone().unwrap_or_default(),
            ended_at: None,
        });
        Some(ActivityState {
            version: ACTIVITY_VERSION,
            session_id,
            status,
            updated_at: self.last_timestamp.clone().unwrap_or_default(),
            sequence: self.sequence,
            cwd: self.cwd.clone(),
            turn,
            active_tools: self.active.clone(),
            awaiting_permission: self.pending_escalation.clone(),
            last_error: self.last_error.clone(),
            final_exit: None,
        })
    }
}

impl Default for CodexRolloutFold {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionLogFold for CodexRolloutFold {
    fn read_mode(&self) -> LogReadMode {
        LogReadMode::Append
    }

    fn source_kind(&self) -> ActivitySourceKind {
        ActivitySourceKind::CodexCli
    }

    fn fidelity(&self) -> Fidelity {
        // The rollout's records are not first-class lifecycle transitions; working
        // and idle are reliable but `awaiting_permission` is folded heuristically
        // from `with_escalated_permissions`. The whole source is `Inferred` until
        // the definitive `PermissionRequest` command hook lands as a second source.
        Fidelity::Inferred
    }

    fn push(&mut self, chunk: &str) -> Option<ActivityState> {
        self.partial.push_str(chunk);
        // Process every complete line; keep an incomplete trailing line (a record
        // still being written) buffered for the next chunk.
        while let Some(newline) = self.partial.find('\n') {
            let line: String = self.partial.drain(..=newline).collect();
            self.process_line(&line);
        }
        self.current_state()
    }

    fn reset(&mut self) {
        *self = CodexRolloutFold::new();
    }
}

/// Fold a whole rollout file into the current [`ActivityState`] (used for the
/// watcher's initial read, and by tests). Goes through [`CodexRolloutFold`] so
/// the parsing lives in exactly one place; a trailing newline is ensured so a
/// final newline-less record is still folded.
pub fn read_codex_rollout_state(path: &Path) -> Result<Option<ActivityState>> {
    let mut content = fs::read_to_string(path)
        .with_context(|| format!("open Codex rollout {}", path.display()))?;
    if !content.ends_with('\n') {
        content.push('\n');
    }
    Ok(CodexRolloutFold::new().push(&content))
}

/// Discover the newest Codex rollout for `cwd` written after the launch window,
/// returned as a resume ref. Mirrors the Cortex/Claude discovery: bound the
/// date-partitioned scan by file mtime so we only read `session_meta` for files
/// from this launch, and validate the cwd from inside the file.
pub fn discover_latest_codex_rollout_for_cwd(
    codex_home: impl AsRef<Path>,
    cwd: impl AsRef<Path>,
    launched_after_ms: Option<i64>,
    claimed_native_ids: &BTreeSet<String>,
) -> Result<Option<NativeSessionRef>> {
    let sessions_dir = codex_home.as_ref().join("sessions");
    if !sessions_dir.exists() {
        return Ok(None);
    }
    let cwd = cwd.as_ref();

    let mut best: Option<(i64, NativeSessionRef)> = None;
    for path in rollout_files(&sessions_dir) {
        let Some(modified_ms) = file_modified_ms(&path) else {
            continue;
        };
        if let Some(min) = launched_after_ms {
            if modified_ms < min {
                continue;
            }
        }
        let Some(meta) = read_codex_rollout_meta(&path) else {
            continue;
        };
        if !same_logical_path(Path::new(&meta.cwd), cwd) {
            continue;
        }
        // Never adopt a native id another Reverie session already owns.
        if claimed_native_ids.contains(&meta.session_id) {
            continue;
        }
        let is_newer = best
            .as_ref()
            .map(|(ms, _)| modified_ms > *ms)
            .unwrap_or(true);
        if is_newer {
            best = Some((
                modified_ms,
                NativeSessionRef::codex(meta.session_id, Some(path)),
            ));
        }
    }

    Ok(best.map(|(_, reference)| reference))
}

/// Find the rollout file whose `session_meta` native id equals `native_id`.
///
/// Unlike [`discover_latest_codex_rollout_for_cwd`], which picks the newest
/// cwd-matching file by mtime and so cannot disambiguate several same-CLI
/// sessions sharing one folder, this keys on the exact native id. Codex embeds
/// that id in the rollout filename (`rollout-<ts>-<id>.jsonl`), so the scan only
/// reads `session_meta` for the single name-matching candidate. Used to backfill
/// the rollout path onto a session that captured its native id before the
/// launch-time scan bound the file, or where a sibling session in the same folder
/// won that scan.
pub fn find_codex_rollout_by_native_id(
    codex_home: impl AsRef<Path>,
    native_id: &str,
) -> Option<PathBuf> {
    let sessions_dir = codex_home.as_ref().join("sessions");
    if !sessions_dir.exists() {
        return None;
    }
    // The id is the trailing segment of the filename, so a name match narrows the
    // scan to one file before we confirm against the `session_meta` record.
    let suffix = format!("-{native_id}.jsonl");
    rollout_files(&sessions_dir).into_iter().find(|path| {
        let name_matches = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(suffix.as_str()));
        name_matches
            && read_codex_rollout_meta(path).is_some_and(|meta| meta.session_id == native_id)
    })
}

/// Collect `rollout-*.jsonl` files under a `sessions/` tree. Codex partitions by
/// `YYYY/MM/DD`, so we walk a bounded depth rather than the whole filesystem.
fn rollout_files(sessions_dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    collect_rollout_files(sessions_dir, 0, &mut out);
    out
}

fn collect_rollout_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    // sessions/YYYY/MM/DD/rollout-*.jsonl -> at most three directory levels deep.
    if depth > 3 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rollout_files(&path, depth + 1, out);
        } else if is_rollout_file(&path) {
            out.push(path);
        }
    }
}

fn is_rollout_file(path: &Path) -> bool {
    let is_jsonl = path.extension().and_then(|ext| ext.to_str()) == Some("jsonl");
    let named_rollout = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("rollout-"));
    is_jsonl && named_rollout
}

/// Extract a `turn_id` from a rollout event payload, when the record carries one
/// (`task_started`, `task_complete`, `turn_aborted`).
fn turn_id_from(payload: &Value) -> Option<String> {
    payload
        .get("turn_id")
        .or_else(|| payload.get("turnId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn goal_status_from(payload: &Value) -> Option<String> {
    payload
        .get("goal")
        .and_then(|goal| goal.get("status"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            payload
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
}

fn active_tool_from_call(
    payload: &Value,
    sequence: u64,
    timestamp: Option<&str>,
) -> Option<ActiveTool> {
    let tool_call_id = payload
        .get("call_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("codex-tool-{sequence}"));
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let summary = codex_tool_summary(name, payload.get("arguments").and_then(Value::as_str));
    Some(ActiveTool {
        tool_call_id,
        tool_name: name.to_owned(),
        started_at: timestamp.unwrap_or_default().to_owned(),
        display_summary: Some(summary),
        child_task_id: None,
    })
}

/// If a call requested escalated permissions, build the pending-approval detail.
/// Codex marks approval-requiring shell/patch calls with
/// `with_escalated_permissions: true` in the (JSON-string) call arguments.
fn escalated_permission_from_call(
    payload: &Value,
    tool: &ActiveTool,
    timestamp: Option<&str>,
) -> Option<PermissionRequest> {
    let escalated = payload
        .get("arguments")
        .and_then(Value::as_str)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|args| {
            args.get("with_escalated_permissions")
                .and_then(Value::as_bool)
        })
        .unwrap_or(false);
    if !escalated {
        return None;
    }
    Some(PermissionRequest {
        id: tool.tool_call_id.clone(),
        tool_name: tool.tool_name.clone(),
        display_summary: tool
            .display_summary
            .clone()
            .unwrap_or_else(|| format!("Approve {}", tool.tool_name)),
        args: None,
        requested_at: timestamp.unwrap_or_default().to_owned(),
    })
}

/// Human-readable one-liner for a Codex tool call. `shell` carries an argv array;
/// `apply_patch`/`update_plan` are self-describing; everything else falls back to
/// the tool name.
fn codex_tool_summary(name: &str, arguments: Option<&str>) -> String {
    match name {
        "shell" => arguments
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|args| args.get("command").map(command_to_string))
            .filter(|cmd| !cmd.is_empty())
            .map(|cmd| format!("Run shell: {cmd}"))
            .unwrap_or_else(|| "Run a shell command".to_owned()),
        "apply_patch" => "Edit files".to_owned(),
        "update_plan" => "Update plan".to_owned(),
        other => format!("Use {other}"),
    }
}

/// Render a `command` field, which Codex emits as an argv array (e.g.
/// `["bash","-lc","npm test"]`) but could also be a bare string.
fn command_to_string(command: &Value) -> String {
    match command {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

fn extract_user_message_text(payload: &Value) -> Option<String> {
    let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
    if payload_type == "message" && payload.get("role").and_then(Value::as_str) == Some("user") {
        return message_text_from_value(payload.get("content")?);
    }
    if payload_type == "user_message" {
        if let Some(text) = payload
            .get("text_elements")
            .and_then(message_text_from_value)
        {
            return Some(text);
        }
        if let Some(text) = payload.get("content").and_then(message_text_from_value) {
            return Some(text);
        }
        return payload.get("text").and_then(message_text_from_value);
    }
    if payload
        .get("message")
        .and_then(|message| message.get("role").and_then(Value::as_str))
        == Some("user")
    {
        return payload
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(message_text_from_value);
    }
    None
}

fn extract_assistant_message_text(payload: &Value) -> Option<String> {
    let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
    if payload_type == "message"
        && payload.get("role").and_then(Value::as_str) == Some("assistant")
    {
        return message_text_from_value(payload.get("content")?);
    }
    if payload
        .get("message")
        .and_then(|message| message.get("role").and_then(Value::as_str))
        == Some("assistant")
    {
        return payload
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(message_text_from_value);
    }
    None
}

/// A one-line description of a tool call record, reusing the same renderer the
/// activity fold uses for the permission/active-tool summary.
fn extract_tool_summary(payload: &Value) -> Option<String> {
    let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
    if payload_type != "function_call" && payload_type != "custom_tool_call" {
        return None;
    }
    let name = payload.get("name").and_then(Value::as_str)?;
    let arguments = payload.get("arguments").and_then(Value::as_str);
    Some(codex_tool_summary(name, arguments))
}

fn message_text_from_value(value: &Value) -> Option<String> {
    let mut parts = Vec::new();
    collect_message_text(value, &mut parts);
    let text = parts.join("\n\n");
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn collect_message_text(value: &Value, parts: &mut Vec<String>) {
    match value {
        Value::String(text) => push_message_part(text, parts),
        Value::Array(items) => {
            for item in items {
                collect_message_text(item, parts);
            }
        }
        Value::Object(object) => {
            for key in ["text", "content", "text_elements", "parts"] {
                if let Some(child) = object.get(key) {
                    collect_message_text(child, parts);
                }
            }
        }
        _ => {}
    }
}

fn push_message_part(text: &str, parts: &mut Vec<String>) {
    let trimmed = text.trim();
    if trimmed.is_empty() || is_codex_context_injection(trimmed) {
        return;
    }
    parts.push(trimmed.to_owned());
}

fn is_codex_context_injection(text: &str) -> bool {
    text.starts_with("# AGENTS.md instructions")
        || text.starts_with("<environment_context>")
        || text.starts_with("<developer_context>")
        || text.contains("<INSTRUCTIONS>")
}

fn recent_messages_with_budget(
    user_messages: Vec<String>,
    max_messages: usize,
    max_total_chars: usize,
) -> Vec<String> {
    if max_messages == 0 || max_total_chars == 0 {
        return Vec::new();
    }
    let mut remaining = max_total_chars;
    let mut recent = Vec::new();
    for message in user_messages.into_iter().rev().take(max_messages) {
        if remaining == 0 {
            break;
        }
        let clipped = truncate_chars(&message, remaining);
        remaining = remaining.saturating_sub(clipped.chars().count());
        recent.push(clipped);
    }
    recent.reverse();
    recent
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    if max_chars <= 3 {
        return text.chars().take(max_chars).collect();
    }
    let mut clipped: String = text.chars().take(max_chars - 3).collect();
    clipped.push_str("...");
    clipped
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    /// No sibling has claimed a native id in these scanner tests.
    fn claimed() -> BTreeSet<String> {
        BTreeSet::new()
    }

    // Empirical check of the live watcher path (not just the pure fold): start the
    // real session-log watcher, register a rollout file as the launch path does,
    // then append `task_complete` and assert the watcher folds it through to
    // `AwaitingInput`. This is the wiring the dashboard depends on to leave the
    // "working" state; if it never fires, a finished Codex session stays "active".
    #[test]
    fn watcher_detects_appended_task_complete() {
        use crate::activity_source::ActivityUpdate;
        use crate::session_log::start_session_log_watcher;
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        let dir = TempDir::new().unwrap();
        // Deliberately the raw (possibly symlinked, e.g. /tmp -> /private/tmp)
        // path: the watcher must canonicalize internally so its keys match the
        // resolved paths FSEvents reports, or every append event is dropped.
        let path = dir.path().join("rollout-live.jsonl");
        {
            let mut f = fs::File::create(&path).unwrap();
            writeln!(f, "{META}").unwrap();
            writeln!(
                f,
                r#"{{"type":"event_msg","payload":{{"type":"task_started"}}}}"#
            )
            .unwrap();
            f.flush().unwrap();
        }

        let watcher = start_session_log_watcher(Arc::new(CodexLogSource)).unwrap();
        watcher.control.register(path.clone());

        // Registration triggers an immediate read: we should see Working.
        let first = watcher
            .events
            .recv_timeout(Duration::from_secs(2))
            .expect("initial state on register");
        match first {
            ActivityUpdate::State { state, .. } => {
                assert_eq!(state.status, ActivityStatus::Working)
            }
            other => panic!("unexpected first update: {other:?}"),
        }

        // Append the turn-end record the way Codex does, then wait for the watcher
        // to deliver the AwaitingInput fold.
        {
            let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
            writeln!(
                f,
                r#"{{"type":"event_msg","payload":{{"type":"task_complete"}}}}"#
            )
            .unwrap();
            f.flush().unwrap();
        }

        let deadline = Instant::now() + Duration::from_secs(6);
        let mut got_awaiting = false;
        while Instant::now() < deadline {
            match watcher.events.recv_timeout(Duration::from_millis(500)) {
                Ok(ActivityUpdate::State { state, .. }) => {
                    if state.status == ActivityStatus::AwaitingInput {
                        got_awaiting = true;
                        break;
                    }
                }
                Ok(_) => {}
                Err(_) => {}
            }
        }
        assert!(
            got_awaiting,
            "watcher never delivered AwaitingInput after task_complete was appended"
        );
    }

    fn write_rollout(dir: &Path, name: &str, lines: &[&str]) -> PathBuf {
        let path = dir.join(name);
        let mut file = fs::File::create(&path).unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
        path
    }

    const META: &str = r#"{"timestamp":"2026-05-30T02:35:54.030Z","type":"session_meta","payload":{"id":"019e-codex","cwd":"/Users/dev/proj","cli_version":"0.135.0"}}"#;

    #[test]
    fn title_context_reads_recent_user_messages_and_skips_context_injections() {
        let dir = TempDir::new().unwrap();
        let path = write_rollout(
            dir.path(),
            "rollout-title.jsonl",
            &[
                META,
                r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\n<INSTRUCTIONS>ignore</INSTRUCTIONS>"},{"type":"input_text","text":"<environment_context>\n<cwd>/tmp</cwd>"}]}}"##,
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fix the parser tests"}]}}"#,
                r#"{"type":"event_msg","payload":{"type":"user_message","text_elements":[{"text":"Add Codex title generation"}]}}"#,
            ],
        );

        let context = read_codex_title_context(&path, 4, 10_000)
            .unwrap()
            .expect("title context");
        assert_eq!(context.user_message_count, 2);
        assert_eq!(
            context.user_messages,
            vec![
                "Fix the parser tests".to_owned(),
                "Add Codex title generation".to_owned(),
            ]
        );
        assert_eq!(context.sequence, 4);
    }

    #[test]
    fn reentry_context_keeps_users_assistants_and_tools_in_order() {
        let dir = TempDir::new().unwrap();
        let path = write_rollout(
            dir.path(),
            "rollout-reentry.jsonl",
            &[
                META,
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fix the failing parser test"}]}}"#,
                r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"c1","arguments":"{\"command\":[\"bash\",\"-lc\",\"npm test\"]}"}}"#,
                r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"The parser test passes now."}]}}"#,
            ],
        );

        let context = read_codex_reentry_context(&path, ReentryBudget::default())
            .unwrap()
            .expect("reentry context");
        assert_eq!(context.entries.len(), 3);
        assert_eq!(context.entries[0].role, crate::reentry_context::ReentryRole::User);
        assert_eq!(context.entries[0].text, "Fix the failing parser test");
        assert_eq!(context.entries[1].role, crate::reentry_context::ReentryRole::Tool);
        assert_eq!(context.entries[1].text, "Run shell: bash -lc npm test");
        assert_eq!(
            context.entries[2].role,
            crate::reentry_context::ReentryRole::Assistant
        );
        assert_eq!(context.entries[2].text, "The parser test passes now.");
    }

    #[test]
    fn reentry_context_is_none_for_an_empty_rollout() {
        let dir = TempDir::new().unwrap();
        let path = write_rollout(dir.path(), "rollout-empty.jsonl", &[META]);
        let context = read_codex_reentry_context(&path, ReentryBudget::default()).unwrap();
        assert!(context.is_none());
    }

    #[test]
    fn title_context_applies_message_and_char_budgets_from_the_end() {
        let dir = TempDir::new().unwrap();
        let path = write_rollout(
            dir.path(),
            "rollout-title-budget.jsonl",
            &[
                META,
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"first message"}]}}"#,
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"second message"}]}}"#,
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"third message with extra detail"}]}}"#,
            ],
        );

        let context = read_codex_title_context(&path, 2, 20)
            .unwrap()
            .expect("title context");
        assert_eq!(context.user_message_count, 3);
        assert_eq!(
            context.user_messages,
            vec!["third message wit...".to_owned()]
        );
    }

    #[test]
    fn folds_working_then_idle_with_tool_detail() {
        let dir = TempDir::new().unwrap();
        let path = write_rollout(
            dir.path(),
            "rollout-x.jsonl",
            &[
                META,
                r#"{"timestamp":"t1","type":"event_msg","payload":{"type":"task_started","turn_id":"a"}}"#,
                r#"{"timestamp":"t2","type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"c1","arguments":"{\"command\":[\"bash\",\"-lc\",\"npm test\"]}"}}"#,
            ],
        );

        let state = read_codex_rollout_state(&path).unwrap().expect("state");
        assert_eq!(state.session_id, "019e-codex");
        assert_eq!(state.cwd, "/Users/dev/proj");
        assert_eq!(state.status, ActivityStatus::Working);
        assert_eq!(state.active_tools.len(), 1);
        assert_eq!(
            state.active_tools[0].display_summary.as_deref(),
            Some("Run shell: bash -lc npm test")
        );
        let working_seq = state.sequence;

        // Append the tool output + task_complete -> idle, tool cleared, higher seq.
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            file,
            r#"{{"timestamp":"t3","type":"response_item","payload":{{"type":"function_call_output","call_id":"c1","output":"ok"}}}}"#
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"timestamp":"t4","type":"event_msg","payload":{{"type":"task_complete","turn_id":"a"}}}}"#
        )
        .unwrap();

        let state = read_codex_rollout_state(&path).unwrap().expect("state");
        assert_eq!(state.status, ActivityStatus::AwaitingInput);
        assert!(state.active_tools.is_empty());
        assert!(state.sequence > working_seq);
    }

    #[test]
    fn escalated_call_surfaces_awaiting_permission_until_resolved() {
        let dir = TempDir::new().unwrap();
        let path = write_rollout(
            dir.path(),
            "rollout-esc.jsonl",
            &[
                META,
                r#"{"type":"event_msg","payload":{"type":"task_started"}}"#,
                r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"e1","arguments":"{\"command\":[\"bash\",\"-lc\",\"npm i\"],\"with_escalated_permissions\":true,\"justification\":\"network\"}"}}"#,
            ],
        );

        let state = read_codex_rollout_state(&path).unwrap().expect("state");
        assert_eq!(state.status, ActivityStatus::AwaitingPermission);
        let perm = state.awaiting_permission.expect("approval detail");
        assert_eq!(perm.id, "e1");
        assert_eq!(perm.tool_name, "shell");

        // Once the call resolves, the approval clears and we are working again.
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            file,
            r#"{{"type":"response_item","payload":{{"type":"function_call_output","call_id":"e1","output":"ok"}}}}"#
        )
        .unwrap();
        let state = read_codex_rollout_state(&path).unwrap().expect("state");
        assert_eq!(state.status, ActivityStatus::Working);
        assert!(state.awaiting_permission.is_none());
    }

    #[test]
    fn active_goal_update_keeps_resumed_goal_working_after_turn_complete() {
        let dir = TempDir::new().unwrap();
        let path = write_rollout(
            dir.path(),
            "rollout-goal-active.jsonl",
            &[
                META,
                r#"{"timestamp":"t1","type":"event_msg","payload":{"type":"task_started","turn_id":"a"}}"#,
                r#"{"timestamp":"t2","type":"event_msg","payload":{"type":"task_complete","turn_id":"a"}}"#,
                r#"{"timestamp":"t3","type":"event_msg","payload":{"type":"thread_goal_updated","turnId":"b","threadId":"thread-1","goal":{"status":"active","objective":"private","createdAt":"t0","updatedAt":"t3","tokensUsed":10,"timeUsedSeconds":1}}}"#,
            ],
        );

        let state = read_codex_rollout_state(&path).unwrap().expect("state");
        assert_eq!(state.status, ActivityStatus::Working);
        assert_eq!(state.turn.as_ref().map(|turn| turn.id.as_str()), Some("b"));
        assert_eq!(
            state.turn.as_ref().map(|turn| turn.status).expect("turn"),
            TurnStatus::Running
        );
    }

    #[test]
    fn terminal_goal_update_returns_to_input_waiting() {
        let dir = TempDir::new().unwrap();
        let path = write_rollout(
            dir.path(),
            "rollout-goal-complete.jsonl",
            &[
                META,
                r#"{"timestamp":"t1","type":"event_msg","payload":{"type":"thread_goal_updated","turnId":"a","threadId":"thread-1","goal":{"status":"active","objective":"private","createdAt":"t0","updatedAt":"t1","tokensUsed":10,"timeUsedSeconds":1}}}"#,
                r#"{"timestamp":"t2","type":"event_msg","payload":{"type":"thread_goal_updated","turnId":"a","threadId":"thread-1","goal":{"status":"complete","objective":"private","createdAt":"t0","updatedAt":"t2","tokensUsed":20,"timeUsedSeconds":2}}}"#,
            ],
        );

        let state = read_codex_rollout_state(&path).unwrap().expect("state");
        assert_eq!(state.status, ActivityStatus::AwaitingInput);
        assert_eq!(state.turn.as_ref().map(|turn| turn.id.as_str()), Some("a"));
        assert_eq!(
            state.turn.as_ref().map(|turn| turn.status).expect("turn"),
            TurnStatus::Completed
        );
    }

    #[test]
    fn incremental_fold_handles_chunks_split_mid_line_and_only_folds_new_records() {
        let mut fold = CodexRolloutFold::new();
        // task_started before any session_meta: processed, but no id to bind yet.
        assert!(
            fold.push("{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n")
                .is_none()
        );

        // session_meta arrives split mid-line across two pushes (an appended tail
        // can end anywhere). The partial line must buffer until its newline.
        let meta = r#"{"type":"session_meta","payload":{"id":"c9","cwd":"/p"}}"#;
        let (head, rest) = meta.split_at(24);
        assert!(
            fold.push(head).is_none(),
            "partial line: nothing to emit yet"
        );
        let state = fold.push(&format!("{rest}\n")).expect("id now known");
        assert_eq!(state.session_id, "c9");
        assert_eq!(state.status, ActivityStatus::Working);
        let seq_after_meta = state.sequence;

        // An incomplete trailing record (no newline yet) buffers without being
        // folded: status and sequence are unchanged from the last complete line.
        let state = fold
            .push(r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#)
            .expect("id known");
        assert_eq!(state.status, ActivityStatus::Working);
        assert_eq!(state.sequence, seq_after_meta);

        // The newline completes it; only the one new record is folded (we never
        // re-read history), and the sequence advances so the consumer applies it.
        let state = fold
            .push("\n")
            .expect("newline completes the buffered record");
        assert_eq!(state.status, ActivityStatus::AwaitingInput);
        assert_eq!(state.sequence, seq_after_meta + 1);
    }

    #[test]
    fn returns_none_without_session_meta() {
        let dir = TempDir::new().unwrap();
        let path = write_rollout(
            dir.path(),
            "rollout-y.jsonl",
            &[r#"{"type":"event_msg","payload":{"type":"task_started"}}"#],
        );
        assert!(read_codex_rollout_state(&path).unwrap().is_none());
    }

    #[test]
    fn discovers_latest_rollout_validated_by_cwd_and_window() {
        let home = TempDir::new().unwrap();
        let day = home
            .path()
            .join("sessions")
            .join("2026")
            .join("05")
            .join("30");
        fs::create_dir_all(&day).unwrap();

        // Matching cwd.
        write_rollout(&day, "rollout-match.jsonl", &[META]);
        // Different cwd: ignored.
        write_rollout(
            &day,
            "rollout-other.jsonl",
            &[r#"{"type":"session_meta","payload":{"id":"other","cwd":"/somewhere/else"}}"#],
        );

        let found =
            discover_latest_codex_rollout_for_cwd(home.path(), "/Users/dev/proj", None, &claimed())
                .unwrap()
                .expect("cwd-matching rollout");
        assert_eq!(found.session_id.as_deref(), Some("019e-codex"));

        // A future launch window filters everything out.
        assert!(
            discover_latest_codex_rollout_for_cwd(
                home.path(),
                "/Users/dev/proj",
                Some(32_503_680_000_000),
                &claimed(),
            )
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn finds_rollout_by_native_id_across_sibling_sessions_in_one_cwd() {
        let home = TempDir::new().unwrap();
        let day = home
            .path()
            .join("sessions")
            .join("2026")
            .join("06")
            .join("16");
        fs::create_dir_all(&day).unwrap();

        // Two sessions in the SAME cwd: the cwd scan cannot tell them apart, but an
        // id lookup must return the file whose `session_meta` carries that id.
        write_rollout(
            &day,
            "rollout-2026-06-16T10-00-00-019ec4f2-aaaa.jsonl",
            &[
                r#"{"type":"session_meta","payload":{"id":"019ec4f2-aaaa","cwd":"/Users/dev/proj"}}"#,
            ],
        );
        write_rollout(
            &day,
            "rollout-2026-06-16T11-00-00-019ed136-bbbb.jsonl",
            &[
                r#"{"type":"session_meta","payload":{"id":"019ed136-bbbb","cwd":"/Users/dev/proj"}}"#,
            ],
        );

        let found = find_codex_rollout_by_native_id(home.path(), "019ec4f2-aaaa")
            .expect("rollout for the requested id");
        assert!(
            found
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap()
                .ends_with("019ec4f2-aaaa.jsonl")
        );

        assert!(find_codex_rollout_by_native_id(home.path(), "missing-id").is_none());
    }
}
