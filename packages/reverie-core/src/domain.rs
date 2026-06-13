use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::activity::{ActivityState, ActivityStatus};

pub type WorkspaceId = Uuid;
pub type ProjectId = Uuid;
pub type FocusId = Uuid;
pub type SessionId = Uuid;

/// Top-level workspace record shown in the dashboard. The persistence layer and
/// the Tauri wire format both use this shape.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: WorkspaceId,
    pub name: String,
    pub general_label: String,
    /// The single workspace-wide auto-approve (YOLO) default. Topics inherit it
    /// and a session falls back to it when its `dangerous_mode_override` is unset.
    /// Surfaced by both the dashboard/empty-state control and the settings toggle.
    pub default_dangerous_mode: bool,
    /// Agent CLIs the user has explicitly switched off in settings. Absence
    /// means enabled, so a fresh workspace has every detected CLI available.
    /// A disabled CLI is never offered as a session agent and never has its
    /// config files written (the inter-agent bridge).
    #[serde(default)]
    pub disabled_agent_kinds: Vec<AgentKind>,
    /// Persisted light/dark appearance for the workspace. The renderer reads
    /// this on load to seed the live theme; it survives restarts.
    #[serde(default)]
    pub theme: ThemeMode,
    /// Default agent kind seeded into the new-session composer. Only a starting
    /// value for the form; it does not change any existing session.
    #[serde(default = "default_agent_kind")]
    pub default_agent_kind: AgentKind,
    /// Terminal font size in CSS px. The renderer measures the terminal cell
    /// from this and the configured monospace font, so the cell tracks the
    /// setting. Defaults to 14 so existing/serialized rows without it upgrade
    /// unchanged. The domain stores it verbatim; the renderer validates/clamps.
    #[serde(default = "default_terminal_font_size")]
    pub terminal_font_size: u16,
    /// Opaque, frontend-owned UI view state (the last selected focus/session,
    /// active surface, and sidebar accordion), persisted so the workspace
    /// reopens where the user left it instead of resetting to the dashboard on
    /// every reload or relaunch. The domain never reads or interprets this; it
    /// is a JSON string the renderer round-trips. `None` means "never saved"
    /// (a fresh workspace), which the renderer treats as "seed a default view".
    #[serde(default)]
    pub nav_state: Option<String>,
    /// Opt-in "keep my Mac awake while tasks run" toggle. When on, the desktop
    /// app holds a macOS power assertion (PreventUserIdleSystemSleep) while at
    /// least one agent session is alive, so long-running tasks survive idle and
    /// the user can walk away. Off by default (explicit opt-in). The domain only
    /// stores the intent; the desktop app owns the native assertion. Has no
    /// effect off macOS.
    #[serde(default)]
    pub keep_awake_enabled: bool,
    /// Secondary opt-in that, together with `keep_awake_enabled`, also keeps the
    /// display on (PreventUserIdleDisplaySleep) while tasks run. Off by default,
    /// so the screen is free to sleep while the system stays awake. Meaningless
    /// unless `keep_awake_enabled` is also set.
    #[serde(default)]
    pub keep_display_awake: bool,
}

impl Workspace {
    pub fn new(name: impl Into<String>, general_label: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            general_label: general_label.into(),
            default_dangerous_mode: false,
            disabled_agent_kinds: Vec::new(),
            theme: ThemeMode::Dark,
            default_agent_kind: default_agent_kind(),
            terminal_font_size: default_terminal_font_size(),
            nav_state: None,
            keep_awake_enabled: false,
            keep_display_awake: false,
        }
    }
}

/// Default agent kind for `Workspace::default_agent_kind` when absent from
/// persisted or serialized data: Claude Code, the first entry in the agent
/// priority order (see `agents::built_in_adapters`: Claude Code, then Codex,
/// then Cortex, then any later additions). A new session seeds its CLI from
/// here, and the frontend re-points it to the next usable CLI in that order if
/// this one is switched off or not installed.
fn default_agent_kind() -> AgentKind {
    AgentKind::ClaudeCode
}

/// Default terminal font size (CSS px) when absent from persisted or serialized
/// data, matching the renderer's default.
fn default_terminal_font_size() -> u16 {
    14
}

/// Persisted light/dark appearance. Serializes as "light"/"dark" to match the
/// frontend `ThemeMode` union.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Light,
    #[default]
    Dark,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    pub path: PathBuf,
    pub archived: bool,
    /// Position in the left-nav project list, for drag-to-reorder. Spaced by 10
    /// on create so neighbors leave room; defaults to 0 for pre-reorder projects
    /// (which then fall back to name order as a stable tiebreak).
    #[serde(default)]
    pub sort_order: i64,
}

impl Project {
    pub fn new(name: impl Into<String>, path: PathBuf) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            path,
            archived: false,
            sort_order: 0,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Focus {
    pub id: FocusId,
    pub project_id: Option<ProjectId>,
    pub title: String,
    pub description: Option<String>,
    pub sort_order: i64,
    pub archived: bool,
    /// Topic-wide default dangerous (auto-approve) mode. Sessions in this
    /// focus inherit it unless they carry their own override. None falls
    /// through to the workspace default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_dangerous_mode: Option<bool>,
}

impl Focus {
    pub fn general(title: impl Into<String>, sort_order: i64) -> Self {
        Self {
            id: Uuid::new_v4(),
            project_id: None,
            title: title.into(),
            description: None,
            sort_order,
            archived: false,
            default_dangerous_mode: None,
        }
    }

    pub fn for_project(project_id: ProjectId, title: impl Into<String>, sort_order: i64) -> Self {
        Self {
            id: Uuid::new_v4(),
            project_id: Some(project_id),
            title: title.into(),
            description: None,
            sort_order,
            archived: false,
            default_dangerous_mode: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    ClaudeCode,
    CodexCli,
    CortexCode,
}

impl AgentKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::CodexCli => "codex_cli",
            Self::CortexCode => "cortex_code",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchMode {
    New,
    Resume,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    NotStarted,
    Running,
    Exited,
    Restorable,
    RestoreFailed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSessionRef {
    pub kind: AgentKind,
    #[serde(alias = "session_id")]
    pub session_id: Option<String>,
    #[serde(alias = "metadata_path")]
    pub metadata_path: Option<PathBuf>,
    #[serde(default, alias = "adapter_payload")]
    pub adapter_payload: serde_json::Value,
}

impl NativeSessionRef {
    pub fn cortex(session_id: impl Into<String>, metadata_path: Option<PathBuf>) -> Self {
        Self {
            kind: AgentKind::CortexCode,
            session_id: Some(session_id.into()),
            metadata_path,
            adapter_payload: serde_json::Value::Null,
        }
    }

    /// A Claude Code resume ref. `transcript_path` is the discovered
    /// `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, kept for
    /// diagnostics; resume only needs `session_id` (`claude --resume <id>`).
    pub fn claude(session_id: impl Into<String>, transcript_path: Option<PathBuf>) -> Self {
        Self {
            kind: AgentKind::ClaudeCode,
            session_id: Some(session_id.into()),
            metadata_path: transcript_path,
            adapter_payload: serde_json::Value::Null,
        }
    }

    /// A Codex CLI resume ref. `rollout_path` is the discovered
    /// `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`, kept for
    /// diagnostics; resume only needs `session_id` (`codex resume <id>`).
    pub fn codex(session_id: impl Into<String>, rollout_path: Option<PathBuf>) -> Self {
        Self {
            kind: AgentKind::CodexCli,
            session_id: Some(session_id.into()),
            metadata_path: rollout_path,
            adapter_payload: serde_json::Value::Null,
        }
    }
}

// No PartialEq: `latest_activity` holds an ActivityState, which is not PartialEq.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: SessionId,
    pub focus_id: FocusId,
    pub title: String,
    pub agent_kind: AgentKind,
    pub cwd: PathBuf,
    #[serde(default)]
    pub native_session_ref: Option<NativeSessionRef>,
    pub launch_mode: LaunchMode,
    pub dangerous_mode_override: Option<bool>,
    pub status: SessionStatus,
    pub last_exit_code: Option<i32>,
    /// Whether the user has archived this session. Archived sessions leave the
    /// Home dashboard and the left-nav focus lists; they live only in the
    /// focus's archived list and can be restored at any time. Closing a session
    /// (from the tab bar or the sidebar) archives it. A session is also
    /// *effectively* archived (hidden the same way) when its focus or project is
    /// archived; that is computed by walking ancestry on the frontend, not stored
    /// here, so restoring the ancestor brings the session back exactly as it was.
    /// Defaults to false so pre-archive persisted sessions surface after upgrade.
    #[serde(default)]
    pub archived: bool,
    /// Last observed activity-state snapshot from whichever adapter owns this
    /// session. Persisted as a denormalized cache so the dashboard paints
    /// immediately on app start, before any live signal arrives.
    #[serde(default)]
    pub latest_activity: Option<ActivityState>,
    /// Position within its focus (topic), for drag-to-reorder. Spaced by 10 on
    /// create so neighbors leave room; defaults to 0 for pre-reorder sessions.
    #[serde(default)]
    pub sort_order: i64,
    /// When the user last viewed this session (ISO 8601 / RFC 3339, frontend
    /// clock). Compared against the activity feed's last turn-completion time to
    /// derive the `finished` ("Ready for you") state: a turn that completed after
    /// this, while the session was off-screen, is unseen. `None` means never
    /// recorded; the migration backfills existing rows to upgrade time so a fresh
    /// launch does not mass-badge sessions that finished long ago.
    #[serde(default)]
    pub last_viewed_at: Option<String>,
    /// When the session last entered each meaningful state. The dashboards order
    /// each status group by transition recency (most-recently-changed first); see
    /// [`SessionStateTimeline`]. Reverie-owned bookkeeping, not part of any CLI
    /// contract. `Default` (all `None`) for pre-timeline persisted rows.
    #[serde(default)]
    pub state_timeline: SessionStateTimeline,
}

/// Reverie's durable record of when a session last entered each meaningful
/// state. Used to order the dashboards by transition recency (the session that
/// most recently became "Ready for you" sits at the top of that group, and so
/// on) and available for future "since when" displays. Distinct from the
/// producer's [`ActivityState`]: these are Reverie's interpretation of the
/// transitions it observes, persisted so ordering survives restarts. Every field
/// is an ISO 8601 / RFC 3339 string in the same format as `ActivityState.updated_at`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStateTimeline {
    /// When the session record was created. Orders the `fresh` group.
    #[serde(default)]
    pub created_at: Option<String>,
    /// When the agent last entered `working` (mid-turn). Orders the `active` group.
    #[serde(default)]
    pub working_since: Option<String>,
    /// When the agent last came to rest: a turn finished (`done`), it paused for
    /// input (`awaiting_input`), or it hit a recoverable error. Orders the
    /// `finished` ("Ready for you") group and feeds the `idle` key.
    #[serde(default)]
    pub resting_since: Option<String>,
    /// When the session last entered an attention state: a blocking ask
    /// (permission / question / plan), a hard (unrecoverable) error, or a failed
    /// resume. Orders the `attention` group.
    #[serde(default)]
    pub blocked_since: Option<String>,
    /// When the session's process last exited into a resumable/ended state. Feeds
    /// the `idle` key for sessions with no activity feed.
    #[serde(default)]
    pub exited_at: Option<String>,
}

/// Coarse class an activity snapshot falls into, used only to decide which
/// timeline marker a transition advances. Two statuses in the same class are not
/// a transition (e.g. `awaiting_input` -> `done` are both at rest), so moving
/// between them does not restamp.
#[derive(Clone, Copy, PartialEq, Eq)]
enum StateClass {
    Working,
    Resting,
    Blocked,
}

impl StateClass {
    fn of(activity: &ActivityState) -> Self {
        match activity.status {
            ActivityStatus::Working => Self::Working,
            ActivityStatus::AwaitingInput | ActivityStatus::Done => Self::Resting,
            ActivityStatus::AwaitingPermission | ActivityStatus::AwaitingResponse => Self::Blocked,
            // A recoverable error reads as a rest state (idle), a hard one as
            // attention, mirroring the dashboard's classification.
            ActivityStatus::Error => {
                if activity
                    .last_error
                    .as_ref()
                    .map(|error| error.recoverable)
                    .unwrap_or(false)
                {
                    Self::Resting
                } else {
                    Self::Blocked
                }
            }
        }
    }
}

impl SessionStateTimeline {
    fn enter(&mut self, class: StateClass, at: String) {
        match class {
            StateClass::Working => self.working_since = Some(at),
            StateClass::Resting => self.resting_since = Some(at),
            StateClass::Blocked => self.blocked_since = Some(at),
        }
    }
}

impl Session {
    pub fn new(
        focus_id: FocusId,
        title: impl Into<String>,
        agent_kind: AgentKind,
        cwd: PathBuf,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            focus_id,
            title: title.into(),
            agent_kind,
            cwd,
            native_session_ref: None,
            launch_mode: LaunchMode::New,
            dangerous_mode_override: None,
            status: SessionStatus::NotStarted,
            last_exit_code: None,
            archived: false,
            latest_activity: None,
            sort_order: 0,
            last_viewed_at: None,
            state_timeline: SessionStateTimeline {
                created_at: Some(crate::time::now_iso8601()),
                ..SessionStateTimeline::default()
            },
        }
    }

    /// Advance the state timeline from an incoming activity snapshot, stamping the
    /// marker for the class it just entered. Idempotent: a snapshot in the same
    /// class as the last one (including a relaunch re-read of the persisted state)
    /// does not restamp, so dashboard ordering survives restarts. Call BEFORE
    /// replacing `latest_activity`, since it compares against the prior snapshot.
    pub fn note_activity_transition(&mut self, incoming: &ActivityState) {
        let new_class = StateClass::of(incoming);
        let prior_class = self.latest_activity.as_ref().map(StateClass::of);
        if prior_class == Some(new_class) {
            return;
        }
        self.state_timeline
            .enter(new_class, incoming.updated_at.clone());
    }

    /// Stamp the moment the session came to rest. Used by boot reconciliation
    /// when a crashed mid-turn session is forced from a live state to rest:
    /// `note_activity_transition` cannot apply there (it compares against the very
    /// activity being normalized), so the caller stamps it directly. `at` should
    /// be the activity's own last-update time, so the session orders by when it
    /// was last active rather than floating to "just now" on every reboot.
    pub fn note_resting(&mut self, at: String) {
        self.state_timeline.resting_since = Some(at);
    }

    /// Stamp the moment the session's process exited into a resumable/ended
    /// (idle) state. `at` is a backend wall-clock ISO 8601 string.
    pub fn note_exited(&mut self, at: String) {
        self.state_timeline.exited_at = Some(at);
    }

    /// Stamp the moment the session entered an attention state via a lifecycle
    /// failure (e.g. a failed resume), distinct from an activity-driven block.
    pub fn note_blocked(&mut self, at: String) {
        self.state_timeline.blocked_since = Some(at);
    }

    /// Resolve the effective dangerous mode: the session's own override
    /// wins, then the focus (topic) default, then the workspace default.
    pub fn effective_dangerous_mode(
        &self,
        focus_default: Option<bool>,
        workspace_default: bool,
    ) -> bool {
        self.dangerous_mode_override
            .or(focus_default)
            .unwrap_or(workspace_default)
    }

    pub fn mark_restorable(&mut self, native_session_ref: NativeSessionRef) {
        self.native_session_ref = Some(native_session_ref);
        self.launch_mode = LaunchMode::Resume;
        self.status = SessionStatus::Restorable;
    }
}

/// Full workspace state served to the frontend on every workspace command.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub workspace: Workspace,
    pub projects: Vec<Project>,
    pub focuses: Vec<Focus>,
    pub sessions: Vec<Session>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dangerous_mode_defaults_to_workspace_setting() {
        let focus = Focus::general("Security", 0);
        let mut session = Session::new(
            focus.id,
            "Cortex",
            AgentKind::CortexCode,
            PathBuf::from("/tmp/reverie"),
        );

        assert!(session.effective_dangerous_mode(None, true));
        assert!(!session.effective_dangerous_mode(None, false));

        // A focus default beats the workspace default when set.
        assert!(session.effective_dangerous_mode(Some(true), false));
        assert!(!session.effective_dangerous_mode(Some(false), true));

        session.dangerous_mode_override = Some(false);
        assert!(!session.effective_dangerous_mode(None, true));

        // The session override beats both.
        assert!(!session.effective_dangerous_mode(Some(true), true));

        session.dangerous_mode_override = Some(true);
        assert!(session.effective_dangerous_mode(None, false));
        assert!(session.effective_dangerous_mode(Some(false), false));
    }

    #[test]
    fn native_session_ref_moves_session_to_restorable_resume_mode() {
        let focus = Focus::general("Branding", 0);
        let mut session = Session::new(
            focus.id,
            "Cortex",
            AgentKind::CortexCode,
            PathBuf::from("/tmp/reverie"),
        );

        session.mark_restorable(NativeSessionRef::cortex("abc-123", None));

        assert_eq!(session.launch_mode, LaunchMode::Resume);
        assert_eq!(session.status, SessionStatus::Restorable);
        assert_eq!(
            session
                .native_session_ref
                .as_ref()
                .and_then(|native| native.session_id.as_deref()),
            Some("abc-123")
        );
    }

    #[test]
    fn native_session_ref_serializes_for_tauri_camel_case_with_snake_case_compatibility() {
        let native = NativeSessionRef {
            kind: AgentKind::CortexCode,
            session_id: Some("abc-123".to_owned()),
            metadata_path: Some(PathBuf::from("/tmp/reverie/meta.json")),
            adapter_payload: serde_json::json!({ "cwd": "/tmp/reverie" }),
        };

        let encoded = serde_json::to_value(&native).expect("native ref should serialize");
        assert_eq!(encoded["sessionId"], "abc-123");
        assert_eq!(encoded["metadataPath"], "/tmp/reverie/meta.json");
        assert_eq!(encoded["adapterPayload"]["cwd"], "/tmp/reverie");
        assert!(encoded.get("session_id").is_none());

        let decoded: NativeSessionRef = serde_json::from_value(serde_json::json!({
            "kind": "cortex_code",
            "session_id": "legacy-123",
            "metadata_path": "/tmp/reverie/legacy-meta.json",
            "adapter_payload": { "cwd": "/tmp/reverie" }
        }))
        .expect("legacy snake_case native refs should keep decoding");

        assert_eq!(decoded.session_id.as_deref(), Some("legacy-123"));
        assert_eq!(
            decoded.metadata_path.as_deref(),
            Some(std::path::Path::new("/tmp/reverie/legacy-meta.json"))
        );
        assert_eq!(decoded.adapter_payload["cwd"], "/tmp/reverie");
    }

    #[test]
    fn workspace_serializes_with_camel_case_wire_format() {
        let workspace = Workspace::new("Reverie", "General");
        let encoded = serde_json::to_value(&workspace).expect("workspace serializes");
        assert!(encoded.get("generalLabel").is_some());
        assert!(encoded.get("defaultDangerousMode").is_some());
        assert!(encoded.get("disabledAgentKinds").is_some());
        assert!(encoded.get("defaultAgentKind").is_some());
        assert!(encoded.get("general_label").is_none());
        assert!(encoded.get("default_dangerous_mode").is_none());
        assert!(encoded.get("disabled_agent_kinds").is_none());
        assert!(encoded.get("default_agent_kind").is_none());
        // The theme enum serializes to its lowercase wire value.
        assert_eq!(encoded["theme"], serde_json::json!("dark"));
        // default_agent_kind keeps the snake_case enum value, like agentKind.
        assert_eq!(
            encoded["defaultAgentKind"],
            serde_json::json!("claude_code")
        );
    }

    #[test]
    fn focus_serializes_with_camel_case_wire_format() {
        let focus = Focus::for_project(Uuid::new_v4(), "Branding", 3);
        let encoded = serde_json::to_value(&focus).expect("focus serializes");
        assert!(encoded.get("projectId").is_some());
        assert!(encoded.get("sortOrder").is_some());
        assert!(encoded.get("project_id").is_none());
        assert!(encoded.get("sort_order").is_none());
    }

    #[test]
    fn session_serializes_with_camel_case_wire_format() {
        let session = Session::new(
            Uuid::new_v4(),
            "Cortex",
            AgentKind::CortexCode,
            PathBuf::from("/tmp/reverie"),
        );
        let encoded = serde_json::to_value(&session).expect("session serializes");
        for key in [
            "focusId",
            "agentKind",
            "nativeSessionRef",
            "launchMode",
            "dangerousModeOverride",
            "lastExitCode",
            "archived",
            "latestActivity",
        ] {
            assert!(encoded.get(key).is_some(), "missing camelCase key {key}");
        }
        for snake in [
            "focus_id",
            "agent_kind",
            "native_session_ref",
            "launch_mode",
            "dangerous_mode_override",
            "last_exit_code",
            "latest_activity",
        ] {
            assert!(
                encoded.get(snake).is_none(),
                "leaked snake_case key {snake}"
            );
        }
        // The struct rename does not touch enum values: agentKind stays snake_case.
        assert_eq!(encoded["agentKind"], serde_json::json!("cortex_code"));
    }

    #[test]
    fn workspace_snapshot_serializes_with_camel_case_wire_format() {
        let snapshot = WorkspaceSnapshot {
            workspace: Workspace::new("Reverie", "General"),
            projects: Vec::new(),
            focuses: Vec::new(),
            sessions: Vec::new(),
        };
        let encoded = serde_json::to_value(&snapshot).expect("snapshot serializes");
        for key in ["workspace", "projects", "focuses", "sessions"] {
            assert!(encoded.get(key).is_some(), "missing key {key}");
        }
    }

    #[test]
    fn session_decodes_with_defaults_for_omitted_fields() {
        // The persistence and wire layers may omit nativeSessionRef /
        // latestActivity; serde defaults must fill them in rather than error.
        let decoded: Session = serde_json::from_value(serde_json::json!({
            "id": Uuid::new_v4().to_string(),
            "focusId": Uuid::new_v4().to_string(),
            "title": "Recovered",
            "agentKind": "claude_code",
            "cwd": "/tmp/reverie",
            "launchMode": "new",
            "dangerousModeOverride": null,
            "status": "not_started",
            "lastExitCode": null
        }))
        .expect("session decodes with defaults");
        assert!(decoded.native_session_ref.is_none());
        assert!(decoded.latest_activity.is_none());
    }
}
