use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};

use crate::domain::{AgentKind, LaunchMode, NativeSessionRef, Session, SessionId};
use crate::terminal::TerminalSpawnSpec;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CommandSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
}

impl CommandSpec {
    pub fn new(program: impl Into<PathBuf>, cwd: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: cwd.into(),
            env: BTreeMap::new(),
        }
    }

    pub fn with_arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn with_args(mut self, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LaunchContext {
    pub session_id: SessionId,
    pub cwd: PathBuf,
    pub dangerous_mode: bool,
    pub model: Option<String>,
    pub executable_path: Option<PathBuf>,
}

/// Inputs for adapter-driven native-session discovery after a launch.
/// `agent_home` is the CLI's home directory (e.g. `CORTEX_HOME`), resolved by
/// the shell so core stays free of environment lookups for it.
#[derive(Clone, Debug, Default)]
pub struct DiscoveryContext {
    pub cwd: PathBuf,
    pub launched_after_ms: Option<i64>,
    pub agent_home: Option<PathBuf>,
    /// Native session ids already owned by a *different* Reverie session.
    /// Filesystem discovery matches sessions by cwd + newest mtime, which cannot
    /// tell apart several sessions of the same CLI running in one folder (a
    /// first-class supported scenario). Without this exclusion, a launching
    /// session adopts whichever sibling most recently wrote its transcript and
    /// both then `--resume` into one conversation. Scanners skip any candidate
    /// in this set so they bind only to an unclaimed (i.e. this launch's) file.
    pub claimed_native_ids: BTreeSet<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterDetection {
    Available { executable: PathBuf },
    Missing { candidates: Vec<String> },
}

impl AdapterDetection {
    pub fn is_available(&self) -> bool {
        matches!(self, Self::Available { .. })
    }

    pub fn executable(&self) -> Option<&PathBuf> {
        match self {
            Self::Available { executable } => Some(executable),
            Self::Missing { .. } => None,
        }
    }
}

pub trait AgentAdapter: Send + Sync {
    fn kind(&self) -> AgentKind;
    fn display_name(&self) -> &'static str;
    fn executable_candidates(&self) -> &'static [&'static str];

    fn detect(&self) -> AdapterDetection {
        match find_executable(self.executable_candidates()) {
            Some(executable) => AdapterDetection::Available { executable },
            None => AdapterDetection::Missing {
                candidates: self
                    .executable_candidates()
                    .iter()
                    .map(|s| (*s).to_owned())
                    .collect(),
            },
        }
    }

    fn build_new_command(&self, ctx: &LaunchContext) -> Result<CommandSpec>;

    fn build_resume_command(
        &self,
        ctx: &LaunchContext,
        native: &NativeSessionRef,
    ) -> Result<CommandSpec>;

    fn dangerous_mode_arg(&self) -> Option<&'static str> {
        None
    }

    /// Discover the native session this CLI created for `ctx.cwd`, if any.
    /// Defaults to no discovery: adapters that record sessions on disk override
    /// this (Cortex via `meta.json`, Claude via its transcript scanner; Codex's
    /// rollout reader lands with the Phase 2 watcher). The caller only persists
    /// the returned ref; it does not interpret it.
    fn discover_native_session(&self, ctx: &DiscoveryContext) -> Result<Option<NativeSessionRef>> {
        let _ = ctx;
        Ok(None)
    }

    /// Extra CLI arguments that attach Reverie's externally-written per-session
    /// hook config file to this launch, given the path it was written to.
    ///
    /// Defaults to none: a CLI is either observed through its own on-disk state
    /// (Cortex) or attaches hooks by a different mechanism. Claude Code overrides
    /// this to pass `--settings <path>`, which merges the file on top of the
    /// user's settings for this run only, without redirecting the config or
    /// credential home. Pure: the shell owns writing the file and minting the
    /// token; the adapter only knows the flag.
    fn hook_config_args(&self, config_file: &Path) -> Vec<String> {
        let _ = config_file;
        Vec::new()
    }

    /// Turn a raw OSC terminal title this CLI emitted into a displayable session
    /// label, or `None` when it is just the CLI's default (its own name or the
    /// working folder) or pure status decoration not worth showing.
    ///
    /// The default handles every CLI we ship: it strips the leading animated
    /// status/spinner glyphs CLIs prefix their title with while working (see
    /// [`is_status_decoration`]) and suppresses the product/folder defaults.
    /// `folder_name` is the session's working-directory basename. This is the
    /// per-CLI plug-in point: a future CLI with a non-standard title scheme can
    /// override it. Pure: no IO, no terminal knowledge.
    fn normalize_title(&self, raw: &str, folder_name: &str) -> Option<String> {
        meaningful_title(clean_title(raw), folder_name, self.display_name())
    }
}

/// Status/spinner glyphs CLIs animate at the start of their terminal title while
/// they work. None of these ever begin a human-meaningful label, so we strip a
/// leading run of them. The braille block is the big one: both Claude (`⠂ ⠐ ...`)
/// and Codex (`⠙ ⠹ ...`) drive spinners from it. `✳` is Claude's idle/ready mark.
/// Add generic decoration here so every adapter (and future CLIs) benefits; keep
/// only truly CLI-specific title quirks in a per-adapter `normalize_title`.
fn is_status_decoration(c: char) -> bool {
    matches!(
        c,
        '\u{2800}'
            ..='\u{28FF}' // Braille Patterns: spinner frames (Claude, Codex)
        | '\u{2733}' // ✳ eight-spoked asterisk (Claude idle/ready)
    )
}

/// Strip a leading run of status decoration and whitespace from `raw`, then trim
/// the remainder. Only the leading run is stripped, so interior punctuation in a
/// real title (a `·`, a path slash) is preserved.
fn clean_title(raw: &str) -> &str {
    raw.trim_start_matches(|c: char| c.is_whitespace() || is_status_decoration(c))
        .trim()
}

/// A cleaned title is worth displaying only when it is non-empty and not just the
/// CLI's own name or the working folder (the values CLIs emit by default). Folder
/// comparison is case-insensitive; the product name match is exact.
fn meaningful_title(cleaned: &str, folder_name: &str, display_name: &str) -> Option<String> {
    if cleaned.is_empty()
        || cleaned == display_name
        || cleaned.eq_ignore_ascii_case(folder_name.trim())
    {
        None
    } else {
        Some(cleaned.to_owned())
    }
}

/// Resolve the per-CLI title rule for `kind` and normalize a raw OSC title into a
/// displayable session label, or `None` when the CLI is showing its default or
/// decoration. The terminal runtime calls this so normalization stays in the
/// domain layer (the worker never special-cases a CLI itself).
pub fn derive_session_title(kind: AgentKind, raw: &str, folder_name: &str) -> Option<String> {
    built_in_adapters()
        .into_iter()
        .find(|adapter| adapter.kind() == kind)
        .and_then(|adapter| adapter.normalize_title(raw, folder_name))
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CortexSessionMetadata {
    pub id: String,
    pub mode: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub cwd: PathBuf,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    #[serde(flatten)]
    pub adapter_payload: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CortexSessionDiscovery {
    pub metadata_path: PathBuf,
    pub metadata: CortexSessionMetadata,
}

impl CortexSessionMetadata {
    pub fn from_json(encoded: &str) -> Result<Self> {
        serde_json::from_str(encoded).context("failed to decode Cortex session metadata")
    }

    pub fn metadata_path(cortex_home: impl AsRef<Path>, session_id: &str) -> PathBuf {
        cortex_home
            .as_ref()
            .join("sessions")
            .join(session_id)
            .join("meta.json")
    }

    pub fn discover_latest_for_cwd(
        cortex_home: impl AsRef<Path>,
        cwd: impl AsRef<Path>,
        launched_after_ms: Option<i64>,
        claimed_native_ids: &BTreeSet<String>,
    ) -> Result<Option<CortexSessionDiscovery>> {
        let sessions_dir = cortex_home.as_ref().join("sessions");
        if !sessions_dir.exists() {
            return Ok(None);
        }

        let mut best: Option<CortexSessionDiscovery> = None;
        for entry in fs::read_dir(&sessions_dir).with_context(|| {
            format!(
                "failed to read Cortex sessions directory at {}",
                sessions_dir.display()
            )
        })? {
            let entry = entry.with_context(|| {
                format!(
                    "failed to inspect Cortex session entry under {}",
                    sessions_dir.display()
                )
            })?;
            let metadata_path = entry.path().join("meta.json");
            if !metadata_path.is_file() {
                continue;
            }

            let encoded = match fs::read_to_string(&metadata_path) {
                Ok(encoded) => encoded,
                Err(_) => continue,
            };
            let metadata = match Self::from_json(&encoded) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };

            if !same_logical_path(&metadata.cwd, cwd.as_ref()) {
                continue;
            }
            // Never adopt a native id another Reverie session already owns.
            if claimed_native_ids.contains(&metadata.id) {
                continue;
            }

            let timestamp = metadata
                .updated_at
                .or(metadata.created_at)
                .unwrap_or_default();
            if let Some(min_timestamp) = launched_after_ms {
                if timestamp < min_timestamp {
                    continue;
                }
            }

            let should_replace = best
                .as_ref()
                .map(|current| {
                    let current_timestamp = current
                        .metadata
                        .updated_at
                        .or(current.metadata.created_at)
                        .unwrap_or_default();
                    timestamp > current_timestamp
                        || (timestamp == current_timestamp && metadata.id > current.metadata.id)
                })
                .unwrap_or(true);

            if should_replace {
                best = Some(CortexSessionDiscovery {
                    metadata_path,
                    metadata,
                });
            }
        }

        Ok(best)
    }

    pub fn into_native_ref(self, metadata_path: impl Into<PathBuf>) -> NativeSessionRef {
        let mut payload = serde_json::Map::new();
        payload.insert("cwd".to_owned(), serde_json::json!(self.cwd));
        if let Some(mode) = self.mode {
            payload.insert("mode".to_owned(), serde_json::json!(mode));
        }
        if let Some(provider) = self.provider {
            payload.insert("provider".to_owned(), serde_json::json!(provider));
        }
        if let Some(model) = self.model {
            payload.insert("model".to_owned(), serde_json::json!(model));
        }
        if let Some(created_at) = self.created_at {
            payload.insert("createdAt".to_owned(), serde_json::json!(created_at));
        }
        if let Some(updated_at) = self.updated_at {
            payload.insert("updatedAt".to_owned(), serde_json::json!(updated_at));
        }
        for (key, value) in self.adapter_payload {
            payload.insert(key, value);
        }

        NativeSessionRef {
            kind: AgentKind::CortexCode,
            session_id: Some(self.id),
            metadata_path: Some(metadata_path.into()),
            adapter_payload: serde_json::Value::Object(payload),
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct CortexAdapter;

impl AgentAdapter for CortexAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::CortexCode
    }

    fn display_name(&self) -> &'static str {
        "Cortex Code"
    }

    fn executable_candidates(&self) -> &'static [&'static str] {
        &["cortex", "cortex-code"]
    }

    fn build_new_command(&self, ctx: &LaunchContext) -> Result<CommandSpec> {
        let mut command = CommandSpec::new(program_or_default(ctx, "cortex"), &ctx.cwd);

        if ctx.dangerous_mode {
            command.args.push("--yolo".to_owned());
        }

        if let Some(model) = &ctx.model {
            command.args.extend(["--model".to_owned(), model.clone()]);
        }

        Ok(command)
    }

    fn build_resume_command(
        &self,
        ctx: &LaunchContext,
        native: &NativeSessionRef,
    ) -> Result<CommandSpec> {
        if native.kind != AgentKind::CortexCode {
            bail!(
                "cannot resume {} native session with Cortex adapter",
                native.kind.as_str()
            );
        }

        let session_id = native
            .session_id
            .as_deref()
            .ok_or_else(|| anyhow!("Cortex resume requires a native Cortex session id"))?;

        let mut command = CommandSpec::new(program_or_default(ctx, "cortex"), &ctx.cwd)
            .with_args(["--resume", session_id]);

        if ctx.dangerous_mode {
            command.args.push("--yolo".to_owned());
        }

        Ok(command)
    }

    fn dangerous_mode_arg(&self) -> Option<&'static str> {
        Some("--yolo")
    }

    fn discover_native_session(&self, ctx: &DiscoveryContext) -> Result<Option<NativeSessionRef>> {
        let Some(cortex_home) = ctx.agent_home.as_ref() else {
            return Ok(None);
        };
        match CortexSessionMetadata::discover_latest_for_cwd(
            cortex_home,
            &ctx.cwd,
            ctx.launched_after_ms,
            &ctx.claimed_native_ids,
        )? {
            Some(discovery) => Ok(Some(
                discovery.metadata.into_native_ref(discovery.metadata_path),
            )),
            None => Ok(None),
        }
    }
}

/// Claude Code adapter command semantics from the public CLI reference, with
/// local transcript evidence under `~/.claude/projects/{escaped-cwd}/*.jsonl`.
/// Native session capture still needs a JSONL scanner, but command construction
/// can already use the documented `--resume <session-id>` path.
#[derive(Clone, Copy, Debug, Default)]
pub struct ClaudeCodeAdapter;

impl AgentAdapter for ClaudeCodeAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::ClaudeCode
    }

    fn display_name(&self) -> &'static str {
        "Claude Code"
    }

    fn executable_candidates(&self) -> &'static [&'static str] {
        &["claude"]
    }

    fn build_new_command(&self, ctx: &LaunchContext) -> Result<CommandSpec> {
        let mut command = CommandSpec::new(program_or_default(ctx, "claude"), &ctx.cwd);

        if ctx.dangerous_mode {
            command
                .args
                .push("--dangerously-skip-permissions".to_owned());
        }

        if let Some(model) = &ctx.model {
            command.args.extend(["--model".to_owned(), model.clone()]);
        }

        Ok(command)
    }

    fn build_resume_command(
        &self,
        ctx: &LaunchContext,
        native: &NativeSessionRef,
    ) -> Result<CommandSpec> {
        if native.kind != AgentKind::ClaudeCode {
            bail!(
                "cannot resume {} native session with Claude Code adapter",
                native.kind.as_str()
            );
        }

        let session_id = native
            .session_id
            .as_deref()
            .ok_or_else(|| anyhow!("Claude Code resume requires a native Claude session id"))?;

        let mut command = CommandSpec::new(program_or_default(ctx, "claude"), &ctx.cwd)
            .with_args(["--resume", session_id]);

        if ctx.dangerous_mode {
            command
                .args
                .push("--dangerously-skip-permissions".to_owned());
        }

        if let Some(model) = &ctx.model {
            command.args.extend(["--model".to_owned(), model.clone()]);
        }

        Ok(command)
    }

    fn dangerous_mode_arg(&self) -> Option<&'static str> {
        Some("--dangerously-skip-permissions")
    }

    /// Attach Reverie's per-session hook settings with `--settings <file>`.
    /// Claude merges this file additively over `~/.claude/settings.json` for
    /// this run, so the user's own hooks and credentials are untouched.
    fn hook_config_args(&self, config_file: &Path) -> Vec<String> {
        vec!["--settings".to_owned(), config_file.display().to_string()]
    }

    /// Hook-independent fallback capture: if the SessionStart hook never fired
    /// (hooks misconfigured, an older CLI, etc.) so `native_session_ref` stays
    /// empty after launch, find this launch's transcript under `~/.claude` and
    /// capture its session id so `claude --resume <id>` still works.
    fn discover_native_session(&self, ctx: &DiscoveryContext) -> Result<Option<NativeSessionRef>> {
        let Some(claude_home) = ctx.agent_home.as_ref() else {
            return Ok(None);
        };
        discover_latest_claude_transcript_for_cwd(
            claude_home,
            &ctx.cwd,
            ctx.launched_after_ms,
            &ctx.claimed_native_ids,
        )
    }
    // Title normalization uses the default: Claude's `✳` idle mark and `⠂ ⠐ ...`
    // working spinner are both handled by `is_status_decoration`.
}

/// Codex CLI adapter command semantics verified against `codex-cli 0.133.0`.
///
/// This only owns launch/resume command construction. Native session discovery is
/// still intentionally separate because Codex records sessions as JSONL under
/// `~/.codex/sessions/YYYY/MM/DD/...`, unlike Cortex's simple `meta.json` layout.
#[derive(Clone, Copy, Debug, Default)]
pub struct CodexCliAdapter;

impl AgentAdapter for CodexCliAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::CodexCli
    }

    fn display_name(&self) -> &'static str {
        "Codex CLI"
    }

    fn executable_candidates(&self) -> &'static [&'static str] {
        &["codex"]
    }

    fn build_new_command(&self, ctx: &LaunchContext) -> Result<CommandSpec> {
        let mut command = CommandSpec::new(program_or_default(ctx, "codex"), &ctx.cwd);

        command
            .args
            .extend(["--cd".to_owned(), ctx.cwd.display().to_string()]);

        if ctx.dangerous_mode {
            command
                .args
                .push("--dangerously-bypass-approvals-and-sandbox".to_owned());
        }

        if let Some(model) = &ctx.model {
            command.args.extend(["--model".to_owned(), model.clone()]);
        }

        Ok(command)
    }

    fn build_resume_command(
        &self,
        ctx: &LaunchContext,
        native: &NativeSessionRef,
    ) -> Result<CommandSpec> {
        if native.kind != AgentKind::CodexCli {
            bail!(
                "cannot resume {} native session with Codex CLI adapter",
                native.kind.as_str()
            );
        }

        let session_id = native
            .session_id
            .as_deref()
            .ok_or_else(|| anyhow!("Codex CLI resume requires a native Codex session id"))?;

        let mut command = CommandSpec::new(program_or_default(ctx, "codex"), &ctx.cwd)
            .with_args(["resume", session_id, "--cd"])
            .with_arg(ctx.cwd.display().to_string());

        if ctx.dangerous_mode {
            command
                .args
                .push("--dangerously-bypass-approvals-and-sandbox".to_owned());
        }

        if let Some(model) = &ctx.model {
            command.args.extend(["--model".to_owned(), model.clone()]);
        }

        Ok(command)
    }

    fn dangerous_mode_arg(&self) -> Option<&'static str> {
        Some("--dangerously-bypass-approvals-and-sandbox")
    }

    /// Capture the native session id from the rollout log so `codex resume <id>`
    /// works. Codex writes append-only `session_meta` JSONL under
    /// `$CODEX_HOME/sessions/YYYY/MM/DD/`; we read the first record, validated by
    /// cwd + launch window. This is the capture half of the Codex phase; live
    /// lifecycle state comes from the rollout watcher in the shell.
    fn discover_native_session(&self, ctx: &DiscoveryContext) -> Result<Option<NativeSessionRef>> {
        let Some(codex_home) = ctx.agent_home.as_ref() else {
            return Ok(None);
        };
        crate::codex_rollout::discover_latest_codex_rollout_for_cwd(
            codex_home,
            &ctx.cwd,
            ctx.launched_after_ms,
            &ctx.claimed_native_ids,
        )
    }
    // Title normalization uses the default: Codex's `⠙ ⠹ ...` working spinner is
    // handled by `is_status_decoration`, and its folder-name-when-idle default is
    // suppressed by the folder_name check in `meaningful_title`.
}

pub fn built_in_adapters() -> Vec<Box<dyn AgentAdapter>> {
    vec![
        Box::new(ClaudeCodeAdapter),
        Box::new(CodexCliAdapter),
        Box::new(CortexAdapter),
    ]
}

/// Build the terminal spawn spec for a session, choosing the adapter's resume
/// or new-launch command. Pure given the session, the workspace dangerous-mode
/// default, the terminal dimensions, the resolved executable, and the adapter:
/// it lives next to the adapters it drives, not in the persistence layer.
pub fn build_spawn_spec(
    session: &Session,
    workspace_default_dangerous_mode: bool,
    cols: u16,
    rows: u16,
    executable_path: PathBuf,
    adapter: &dyn AgentAdapter,
) -> Result<TerminalSpawnSpec> {
    if cols == 0 || rows == 0 {
        bail!("terminal launch requires non-zero dimensions");
    }
    if session.agent_kind != adapter.kind() {
        bail!(
            "cannot launch {:?} session through {} adapter",
            session.agent_kind,
            adapter.display_name()
        );
    }

    let context = LaunchContext {
        session_id: session.id,
        cwd: session.cwd.clone(),
        dangerous_mode: session
            .dangerous_mode_override
            .unwrap_or(workspace_default_dangerous_mode),
        model: None,
        executable_path: Some(executable_path),
    };
    let should_resume =
        session.launch_mode == LaunchMode::Resume || session.native_session_ref.is_some();
    let command = if should_resume {
        let native = session.native_session_ref.as_ref().ok_or_else(|| {
            anyhow!(
                "{} resume requested for session {} but no native session ref is attached",
                adapter.display_name(),
                session.id
            )
        })?;
        adapter.build_resume_command(&context, native)?
    } else {
        adapter.build_new_command(&context)?
    };

    let mut spec = TerminalSpawnSpec::new(command);
    spec.cols = cols;
    spec.rows = rows;
    spec.title = Some(format!("{} · {}", session.title, adapter.display_name()));
    Ok(spec)
}

pub(crate) fn same_logical_path(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

/// Minimal identity fields Reverie reads from a Claude transcript record. The
/// `.jsonl` lines carry far more (conversation content); we read only these and
/// ignore the rest.
#[derive(Debug, Deserialize)]
struct ClaudeTranscriptEnvelope {
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default, alias = "sessionId")]
    session_id: Option<String>,
}

/// Discover the newest Claude Code transcript for `cwd` written after the launch
/// window, returned as a resume ref.
///
/// The on-disk project directory name (`~/.claude/projects/<encoded>`) is a
/// lossy encoding of the cwd (both `/` and a literal `-` map to `-`), so we
/// never trust it: every candidate is validated against the `cwd` field inside
/// the transcript. The filename stem is the session id; we prefer the envelope's
/// `sessionId` and fall back to the stem. Metadata-only: we read just the first
/// lines until the identity fields appear and never parse conversation content.
pub fn discover_latest_claude_transcript_for_cwd(
    claude_home: impl AsRef<Path>,
    cwd: impl AsRef<Path>,
    launched_after_ms: Option<i64>,
    claimed_native_ids: &BTreeSet<String>,
) -> Result<Option<NativeSessionRef>> {
    let projects_dir = claude_home.as_ref().join("projects");
    if !projects_dir.exists() {
        return Ok(None);
    }
    let cwd = cwd.as_ref();

    let mut best: Option<(i64, NativeSessionRef)> = None;
    for project_entry in fs::read_dir(&projects_dir).with_context(|| {
        format!(
            "failed to read Claude projects directory at {}",
            projects_dir.display()
        )
    })? {
        let Ok(project_entry) = project_entry else {
            continue;
        };
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&project_path) else {
            continue;
        };
        for file_entry in files.flatten() {
            let path = file_entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            // Bound to the launch window by mtime so we pick this launch's
            // transcript, not an older session in the same project dir.
            let Some(modified_ms) = file_modified_ms(&path) else {
                continue;
            };
            if let Some(min) = launched_after_ms {
                if modified_ms < min {
                    continue;
                }
            }
            let Some(envelope) = read_claude_transcript_envelope(&path) else {
                continue;
            };
            // Validate the cwd from inside the file (the dir name is lossy).
            let Some(file_cwd) = envelope.cwd else {
                continue;
            };
            if !same_logical_path(Path::new(&file_cwd), cwd) {
                continue;
            }
            let session_id = envelope
                .session_id
                .or_else(|| path.file_stem().and_then(|s| s.to_str()).map(str::to_owned));
            let Some(session_id) = session_id else {
                continue;
            };
            // Never adopt a native id another Reverie session already owns, so a
            // session launched into a folder shared with its siblings binds to
            // its own transcript rather than whichever sibling wrote most
            // recently. The siblings hold the claimed ids; this launch's own
            // (not-yet-captured) transcript is unclaimed and still eligible.
            if claimed_native_ids.contains(&session_id) {
                continue;
            }

            let is_newer = best
                .as_ref()
                .map(|(ms, _)| modified_ms > *ms)
                .unwrap_or(true);
            if is_newer {
                best = Some((
                    modified_ms,
                    NativeSessionRef::claude(session_id, Some(path)),
                ));
            }
        }
    }

    Ok(best.map(|(_, reference)| reference))
}

pub(crate) fn file_modified_ms(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let dur = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(dur.as_millis() as i64)
}

/// Read the first lines of a transcript until the `cwd` and `sessionId` identity
/// fields are found (or a small line budget is exhausted). Returns `None` if
/// neither appears; the caller treats that as "not a usable transcript".
fn read_claude_transcript_envelope(path: &Path) -> Option<ClaudeTranscriptEnvelope> {
    use std::io::{BufRead, BufReader};
    let reader = BufReader::new(fs::File::open(path).ok()?);
    let mut cwd: Option<String> = None;
    let mut session_id: Option<String> = None;
    for line in reader.lines().take(64) {
        let Ok(line) = line else {
            break;
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(envelope) = serde_json::from_str::<ClaudeTranscriptEnvelope>(&line) else {
            continue;
        };
        if cwd.is_none() {
            cwd = envelope.cwd;
        }
        if session_id.is_none() {
            session_id = envelope.session_id;
        }
        if cwd.is_some() && session_id.is_some() {
            break;
        }
    }
    if cwd.is_none() && session_id.is_none() {
        return None;
    }
    Some(ClaudeTranscriptEnvelope { cwd, session_id })
}

fn program_or_default(ctx: &LaunchContext, fallback: &'static str) -> PathBuf {
    ctx.executable_path
        .clone()
        .unwrap_or_else(|| PathBuf::from(fallback))
}

fn find_executable(candidates: &[&str]) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    let path_dirs = env::split_paths(&path_var);

    for dir in path_dirs {
        for candidate in candidates {
            for executable_name in executable_names(candidate) {
                let path = dir.join(executable_name);
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }

    None
}

fn executable_names(candidate: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        let candidate_path = std::path::Path::new(candidate);
        if candidate_path.extension().is_some() {
            return vec![candidate.to_owned()];
        }

        let pathext = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned());
        pathext
            .split(';')
            .filter(|ext| !ext.is_empty())
            .map(|ext| format!("{candidate}{ext}"))
            .collect()
    }

    #[cfg(not(windows))]
    {
        vec![candidate.to_owned()]
    }
}

pub fn require_detected(adapter: &dyn AgentAdapter) -> Result<PathBuf> {
    match adapter.detect() {
        AdapterDetection::Available { executable } => Ok(executable),
        AdapterDetection::Missing { candidates } => Err(anyhow!(
            "{} is not installed or not on PATH; tried {}",
            adapter.display_name(),
            candidates.join(", ")
        ))
        .with_context(|| format!("detecting {}", adapter.display_name())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    /// No sibling has claimed a native id in these scanner tests.
    fn claimed() -> BTreeSet<String> {
        BTreeSet::new()
    }

    #[test]
    fn cortex_new_command_applies_yolo_and_model() {
        let adapter = CortexAdapter;
        let ctx = LaunchContext {
            session_id: Uuid::new_v4(),
            cwd: PathBuf::from("/tmp/reverie"),
            dangerous_mode: true,
            model: Some("gpt-test".to_owned()),
            executable_path: Some(PathBuf::from("/bin/cortex")),
        };

        let command = adapter.build_new_command(&ctx).unwrap();

        assert_eq!(command.program, PathBuf::from("/bin/cortex"));
        assert_eq!(command.args, vec!["--yolo", "--model", "gpt-test"]);
        assert_eq!(command.cwd, PathBuf::from("/tmp/reverie"));
    }

    #[test]
    fn cortex_resume_command_requires_cortex_native_session_id() {
        let adapter = CortexAdapter;
        let ctx = LaunchContext {
            session_id: Uuid::new_v4(),
            cwd: PathBuf::from("/tmp/reverie"),
            dangerous_mode: false,
            model: None,
            executable_path: None,
        };
        let native = NativeSessionRef::cortex("session-123", None);

        let command = adapter.build_resume_command(&ctx, &native).unwrap();

        assert_eq!(command.program, PathBuf::from("cortex"));
        assert_eq!(command.args, vec!["--resume", "session-123"]);
    }

    #[test]
    fn claude_commands_use_documented_resume_and_permission_flags() {
        let adapter = ClaudeCodeAdapter;
        let ctx = LaunchContext {
            session_id: Uuid::new_v4(),
            cwd: PathBuf::from("/tmp/reverie"),
            dangerous_mode: true,
            model: Some("sonnet".to_owned()),
            executable_path: Some(PathBuf::from("/bin/claude")),
        };

        let new_command = adapter.build_new_command(&ctx).unwrap();
        assert_eq!(new_command.program, PathBuf::from("/bin/claude"));
        assert_eq!(
            new_command.args,
            vec!["--dangerously-skip-permissions", "--model", "sonnet"]
        );

        let native = NativeSessionRef {
            kind: AgentKind::ClaudeCode,
            session_id: Some("37c6ba0c-e8a8-4cd3-8129-aa8ac289a9ca".to_owned()),
            metadata_path: Some(PathBuf::from(
                "/tmp/.claude/projects/-tmp-reverie/37c6ba0c-e8a8-4cd3-8129-aa8ac289a9ca.jsonl",
            )),
            adapter_payload: serde_json::json!({ "cwd": "/tmp/reverie" }),
        };

        let resume_command = adapter.build_resume_command(&ctx, &native).unwrap();
        assert_eq!(resume_command.program, PathBuf::from("/bin/claude"));
        assert_eq!(
            resume_command.args,
            vec![
                "--resume",
                "37c6ba0c-e8a8-4cd3-8129-aa8ac289a9ca",
                "--dangerously-skip-permissions",
                "--model",
                "sonnet"
            ]
        );
    }

    #[test]
    fn claude_transcript_scanner_captures_session_validated_by_cwd() {
        use std::io::Write;
        let home = tempfile::TempDir::new().unwrap();
        let cwd = "/Users/dev/Code/proj";

        // Lossy-encoded project dir for that cwd, with a transcript whose first
        // line is a mode record (no cwd) and a later line carries the identity.
        let project = home.path().join("projects").join("-Users-dev-Code-proj");
        fs::create_dir_all(&project).unwrap();
        let mut f = fs::File::create(project.join("sess-123.jsonl")).unwrap();
        writeln!(f, r#"{{"type":"mode","mode":"default"}}"#).unwrap();
        writeln!(
            f,
            r#"{{"type":"user","sessionId":"sess-123","cwd":"{cwd}","timestamp":"t"}}"#
        )
        .unwrap();
        drop(f);

        // Decoy under a different project/cwd: must be ignored even though it is
        // also a transcript under projects/.
        let other = home.path().join("projects").join("-Users-dev-Code-other");
        fs::create_dir_all(&other).unwrap();
        let mut g = fs::File::create(other.join("sess-999.jsonl")).unwrap();
        writeln!(
            g,
            r#"{{"sessionId":"sess-999","cwd":"/Users/dev/Code/other"}}"#
        )
        .unwrap();
        drop(g);

        let found = discover_latest_claude_transcript_for_cwd(home.path(), cwd, None, &claimed())
            .unwrap()
            .expect("cwd-matching transcript is found");
        assert_eq!(found.kind, AgentKind::ClaudeCode);
        assert_eq!(found.session_id.as_deref(), Some("sess-123"));
    }

    #[test]
    fn claude_transcript_scanner_respects_launch_window() {
        use std::io::Write;
        let home = tempfile::TempDir::new().unwrap();
        let cwd = "/tmp/proj";
        let project = home.path().join("projects").join("-tmp-proj");
        fs::create_dir_all(&project).unwrap();
        let mut f = fs::File::create(project.join("s.jsonl")).unwrap();
        writeln!(f, r#"{{"sessionId":"s","cwd":"{cwd}"}}"#).unwrap();
        drop(f);

        // A launch window in the far future filters out the just-written file.
        let far_future_ms = 32_503_680_000_000; // ~year 3000
        assert!(
            discover_latest_claude_transcript_for_cwd(
                home.path(),
                cwd,
                Some(far_future_ms),
                &claimed(),
            )
            .unwrap()
            .is_none()
        );
        // With no window it is captured.
        assert!(
            discover_latest_claude_transcript_for_cwd(home.path(), cwd, None, &claimed())
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn cortex_metadata_becomes_native_session_ref() {
        let metadata = CortexSessionMetadata::from_json(
            r#"{
              "id": "session-123",
              "mode": "build",
              "provider": "openai-codex",
              "model": "gpt-5.5",
              "cwd": "/tmp/reverie",
              "createdAt": 1779664765667,
              "updatedAt": 1779665243918,
              "contextTokenCount": 162804
            }"#,
        )
        .unwrap();

        let native = metadata.into_native_ref("/tmp/.cortex/sessions/session-123/meta.json");

        assert_eq!(native.kind, AgentKind::CortexCode);
        assert_eq!(native.session_id.as_deref(), Some("session-123"));
        assert_eq!(
            native.metadata_path,
            Some(PathBuf::from("/tmp/.cortex/sessions/session-123/meta.json"))
        );
        assert_eq!(
            native.adapter_payload["cwd"],
            serde_json::json!("/tmp/reverie")
        );
        assert_eq!(
            native.adapter_payload["provider"],
            serde_json::json!("openai-codex")
        );
        assert_eq!(
            native.adapter_payload["contextTokenCount"],
            serde_json::json!(162804)
        );
    }

    #[test]
    fn discovers_latest_cortex_metadata_for_cwd_after_launch_window() {
        let root = temp_root("cortex-discovery");
        let cortex_home = root.join(".cortex");
        let cwd = root.join("project");
        let other_cwd = root.join("other-project");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&other_cwd).unwrap();

        write_cortex_meta(&cortex_home, "old-match", &cwd, 1_000);
        write_cortex_meta(&cortex_home, "latest-match", &cwd, 2_000);
        write_cortex_meta(&cortex_home, "wrong-cwd", &other_cwd, 3_000);

        let discovered = CortexSessionMetadata::discover_latest_for_cwd(
            &cortex_home,
            &cwd,
            Some(1_500),
            &claimed(),
        )
        .unwrap()
        .expect("matching Cortex metadata should be discovered");

        assert_eq!(discovered.metadata.id, "latest-match");
        assert_eq!(
            discovered.metadata_path,
            cortex_home.join("sessions/latest-match/meta.json")
        );

        let too_late = CortexSessionMetadata::discover_latest_for_cwd(
            &cortex_home,
            &cwd,
            Some(2_500),
            &claimed(),
        )
        .unwrap();
        assert_eq!(too_late, None);

        let _ = fs::remove_dir_all(root);
    }

    fn write_cortex_meta(cortex_home: &Path, session_id: &str, cwd: &Path, updated_at: i64) {
        let metadata_dir = cortex_home.join("sessions").join(session_id);
        fs::create_dir_all(&metadata_dir).unwrap();
        let metadata = CortexSessionMetadata {
            id: session_id.to_owned(),
            mode: Some("build".to_owned()),
            provider: Some("openai-codex".to_owned()),
            model: None,
            cwd: cwd.to_path_buf(),
            created_at: Some(updated_at - 100),
            updated_at: Some(updated_at),
            adapter_payload: BTreeMap::new(),
        };
        fs::write(
            metadata_dir.join("meta.json"),
            serde_json::to_string(&metadata).unwrap(),
        )
        .unwrap();
    }

    fn temp_root(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("reverie-{label}-{}-{nanos}", std::process::id()))
    }

    #[test]
    fn cortex_adapter_discovers_native_session_via_context() {
        let root = temp_root("cortex-adapter-discovery");
        let cortex_home = root.join(".cortex");
        let cwd = root.join("project");
        fs::create_dir_all(&cwd).unwrap();
        write_cortex_meta(&cortex_home, "sess-1", &cwd, 2_000);

        let adapter = CortexAdapter;
        let native = adapter
            .discover_native_session(&DiscoveryContext {
                cwd: cwd.clone(),
                launched_after_ms: Some(1_000),
                agent_home: Some(cortex_home),
                ..Default::default()
            })
            .unwrap()
            .expect("matching Cortex session is discovered");
        assert_eq!(native.kind, AgentKind::CortexCode);
        assert_eq!(native.session_id.as_deref(), Some("sess-1"));

        // No agent_home means no filesystem discovery.
        let none = adapter
            .discover_native_session(&DiscoveryContext {
                cwd,
                launched_after_ms: None,
                agent_home: None,
                ..Default::default()
            })
            .unwrap();
        assert!(none.is_none());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn claude_title_strips_glyph_and_suppresses_default() {
        let adapter = ClaudeCodeAdapter;
        // Idle title is the product name behind the `✳` status glyph: suppressed.
        assert_eq!(adapter.normalize_title("✳ Claude Code", "reverie"), None);
        // While working, Claude animates a braille spinner (U+2800..) in front of
        // both its idle name and its task title. Both must be handled.
        assert_eq!(adapter.normalize_title("⠂ Claude Code", "reverie"), None);
        assert_eq!(adapter.normalize_title("⠐ Claude Code", "reverie"), None);
        assert_eq!(
            adapter.normalize_title("⠐ Write ocean haiku", "reverie"),
            Some("Write ocean haiku".to_owned())
        );
        // A real task title surfaces, with the `✳` glyph and spacing stripped.
        assert_eq!(
            adapter.normalize_title("✳ Fixing the parser", "reverie"),
            Some("Fixing the parser".to_owned())
        );
        // No glyph still works, and whitespace-only is suppressed.
        assert_eq!(
            adapter.normalize_title("Running tests", "reverie"),
            Some("Running tests".to_owned())
        );
        assert_eq!(adapter.normalize_title("   ", "reverie"), None);
    }

    #[test]
    fn codex_title_strips_spinner_and_suppresses_folder() {
        let adapter = CodexCliAdapter;
        // Default title is the working folder, with or without a spinner frame.
        assert_eq!(adapter.normalize_title("pixa", "pixa"), None);
        assert_eq!(adapter.normalize_title("⠙ pixa", "pixa"), None);
        assert_eq!(adapter.normalize_title("⠹ Pixa", "pixa"), None);
        // A task-specific title surfaces with the braille spinner stripped.
        assert_eq!(
            adapter.normalize_title("⠼ refactor adapters", "pixa"),
            Some("refactor adapters".to_owned())
        );
    }

    #[test]
    fn derive_session_title_routes_to_adapter_and_tolerates_silent_clis() {
        // Routes through the registry to the matching adapter.
        assert_eq!(
            derive_session_title(AgentKind::ClaudeCode, "✳ Writing docs", "reverie"),
            Some("Writing docs".to_owned())
        );
        assert_eq!(
            derive_session_title(AgentKind::CodexCli, "⠙ reverie", "reverie"),
            None
        );
        // Cortex emits no title yet: an empty raw never fights the seeded label.
        assert_eq!(
            derive_session_title(AgentKind::CortexCode, "", "reverie"),
            None
        );
    }
}
