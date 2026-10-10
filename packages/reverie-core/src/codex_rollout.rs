//! Reader for Codex CLI rollout JSONL session logs.
//!
//! Codex appends one JSON record per line to
//! `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. The first record
//! is `session_meta` (native id + cwd); subsequent records narrate the turn
//! (`task_started`, `function_call` / `function_call_output`, `task_complete`,
//! `turn_aborted`, goal updates, `error`, plus reasoning/message chatter we
//! ignore). Reverie
//! folds the log into the same unified [`ActivityState`] the Cortex watcher and
//! the Claude hook server produce, so the dashboard never learns it came from a
//! file rather than a hook.
//!
//! Pure parsing + discovery only. Filesystem watching lives in the shell. Codex
//! has no HTTP hook type and trust-gates command hooks, so this file watcher is
//! the baseline detail source. Explicit task completion works independently of
//! Codex's `agent-turn-complete` notifier; definitive `awaiting_permission` comes from
//! the trusted `PermissionRequest` command hook.

use std::{
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
    /// Whether this rollout belongs to an interactive root Codex CLI thread.
    /// Current Codex versions encode roots as `source: "cli"` and subagents as
    /// an object under `source.subagent`. Older rollout records predate the
    /// source field, so an absent value remains eligible for exact-id backfill.
    pub is_root_cli_session: bool,
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
            let is_root_cli_session = match record.payload.get("source") {
                None | Some(Value::Null) => true,
                Some(Value::String(source)) => source == "cli",
                Some(_) => false,
            };
            return Some(CodexRolloutMeta {
                session_id,
                cwd,
                is_root_cli_session,
            });
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
    // can match exact turn edges without assuming the opaque ids are ordered,
    // and so the rollout's `turn_aborted` can end the interrupted turn.
    current_turn_id: Option<String>,
    turn_started_at: Option<String>,
    turn_ended_at: Option<String>,
    turn_aborted: bool,
    /// Long-running goal liveness is independent from a single task record. An
    /// ordinary `task_complete` can be followed by another automatic goal turn,
    /// so an active goal stays working until a terminal goal update arrives.
    goal_active: bool,
    /// Whether a turn is open, independently of goal continuation.
    turn_open: bool,
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
            status: ActivityStatus::Idle,
            active: Vec::new(),
            last_error: None,
            last_timestamp: None,
            current_turn_id: None,
            turn_started_at: None,
            turn_ended_at: None,
            turn_aborted: false,
            goal_active: false,
            turn_open: false,
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
                self.turn_open = true;
                self.turn_started_at = self.last_timestamp.clone();
                self.turn_ended_at = None;
                self.turn_aborted = false;
                self.current_turn_id = turn_id_from(&record.payload);
                self.active.clear();
                self.pending_escalation = None;
                self.last_error = None;
            }
            // A tool call begins: still working, surface it as the active tool.
            // An escalated call also records a pending approval.
            (_, "function_call") | (_, "custom_tool_call") => {
                // A late/background tool record does not reopen a closed turn.
                // Working with a completed turn is reserved for explicit goal
                // continuation, which the cross-source reducer preserves.
                if self.current_turn_id.is_some() && !self.turn_open && !self.goal_active {
                    return;
                }
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
            // Completion is explicit evidence even if the notifier is lost.
            // An active goal independently keeps the overall session working.
            (_, "task_complete") => {
                self.status = ActivityStatus::AwaitingInput;
                self.turn_open = false;
                self.turn_ended_at = self.last_timestamp.clone();
                if let Some(id) = turn_id_from(&record.payload) {
                    self.current_turn_id = Some(id);
                }
                self.active.clear();
                self.pending_escalation = None;
            }
            // An interrupted turn may not emit the clean completion notifier.
            // `turn_aborted` is itself an explicit terminal edge.
            (_, "turn_aborted") => {
                self.status = ActivityStatus::Idle;
                self.turn_open = false;
                self.goal_active = false;
                self.turn_aborted = true;
                self.turn_ended_at = self.last_timestamp.clone();
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
                    self.goal_active = true;
                    if self.current_turn_id.as_deref() != turn_id_from(&record.payload).as_deref() {
                        self.turn_started_at = self.last_timestamp.clone();
                        self.turn_ended_at = None;
                    }
                    self.turn_aborted = false;
                    self.status = ActivityStatus::Working;
                    if let Some(id) = turn_id_from(&record.payload) {
                        self.current_turn_id = Some(id);
                    }
                    self.last_error = None;
                }
                Some("complete")
                | Some("usageLimited")
                | Some("budgetLimited")
                | Some("paused")
                | Some("blocked") => {
                    self.goal_active = false;
                    self.turn_ended_at = self.last_timestamp.clone();
                    self.turn_open = false;
                    self.status = ActivityStatus::AwaitingInput;
                    if let Some(id) = turn_id_from(&record.payload) {
                        self.current_turn_id = Some(id);
                    }
                    self.active.clear();
                    self.pending_escalation = None;
                }
                _ => {}
            },
            // Codex appends this when a thread is (re)opened, e.g. on every
            // `codex resume`, and when settings change between turns. With no
            // turn open and no goal running, the agent is idle at its prompt.
            (_, "thread_settings_applied") => {
                if !self.turn_open && !self.goal_active && self.pending_escalation.is_none() {
                    // Settings changes do not create a new completion.
                    self.status = ActivityStatus::Idle;
                    self.active.clear();
                }
            }
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
        let status = if self.active.iter().any(|tool| {
            matches!(
                tool.tool_name.as_str(),
                "request_user_input" | "functions.request_user_input"
            )
        }) {
            ActivityStatus::AwaitingResponse
        } else if self.pending_escalation.is_some() {
            ActivityStatus::AwaitingPermission
        } else if self.goal_active && self.status != ActivityStatus::Error {
            ActivityStatus::Working
        } else {
            self.status
        };
        // Stamp the narrated turn so the reconciler can match this edge against
        // the hook's exact turn id. Its `status` reflects whether it is running.
        let turn = self.current_turn_id.as_ref().map(|id| ActivityTurn {
            id: id.clone(),
            status: if self.turn_aborted {
                TurnStatus::Aborted
            } else if self.turn_open {
                TurnStatus::Running
            } else {
                TurnStatus::Completed
            },
            started_at: self.turn_started_at.clone().unwrap_or_default(),
            ended_at: self.turn_ended_at.clone(),
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

/// Find the rollout file whose `session_meta` native id equals `native_id`.
///
/// Codex embeds that id in the rollout filename (`rollout-<ts>-<id>.jsonl`), so
/// the scan reads `session_meta` only for the name-matching candidate. It also
/// requires an interactive root source, rejecting subagent rollouts even if a
/// bad upstream event presents their id. Used to enrich the exact native id
/// captured by the token-bound SessionStart hook.
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
            && read_codex_rollout_meta(path)
                .is_some_and(|meta| meta.session_id == native_id && meta.is_root_cli_session)
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
    if payload_type == "message" && payload.get("role").and_then(Value::as_str) == Some("assistant")
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
mod tests;
