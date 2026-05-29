use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::activity::ActivityState;

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
    pub default_dangerous_mode: bool,
    /// Agent CLIs the user has explicitly switched off in settings. Absence
    /// means enabled, so a fresh workspace has every detected CLI available.
    /// A disabled CLI is never offered as a session agent and never has its
    /// config files written (the inter-agent bridge).
    #[serde(default)]
    pub disabled_agent_kinds: Vec<AgentKind>,
}

impl Workspace {
    pub fn new(name: impl Into<String>, general_label: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            general_label: general_label.into(),
            default_dangerous_mode: false,
            disabled_agent_kinds: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    pub path: PathBuf,
    pub archived: bool,
}

impl Project {
    pub fn new(name: impl Into<String>, path: PathBuf) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            path,
            archived: false,
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
    /// Whether this session currently has a visible tab in the workspace.
    #[serde(default = "default_true")]
    pub tab_visible: bool,
    /// Last observed activity-state snapshot from whichever adapter owns this
    /// session. Persisted as a denormalized cache so the dashboard paints
    /// immediately on app start, before any live signal arrives.
    #[serde(default)]
    pub latest_activity: Option<ActivityState>,
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
            tab_visible: true,
            latest_activity: None,
        }
    }

    pub fn effective_dangerous_mode(&self, workspace_default: bool) -> bool {
        self.dangerous_mode_override.unwrap_or(workspace_default)
    }

    pub fn mark_restorable(&mut self, native_session_ref: NativeSessionRef) {
        self.native_session_ref = Some(native_session_ref);
        self.launch_mode = LaunchMode::Resume;
        self.status = SessionStatus::Restorable;
    }
}

/// Default for `Session::tab_visible` when absent from persisted or serialized
/// data: sessions are visible unless explicitly hidden.
fn default_true() -> bool {
    true
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

        assert!(session.effective_dangerous_mode(true));
        assert!(!session.effective_dangerous_mode(false));

        session.dangerous_mode_override = Some(false);
        assert!(!session.effective_dangerous_mode(true));

        session.dangerous_mode_override = Some(true);
        assert!(session.effective_dangerous_mode(false));
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
        assert!(encoded.get("general_label").is_none());
        assert!(encoded.get("default_dangerous_mode").is_none());
        assert!(encoded.get("disabled_agent_kinds").is_none());
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
            "tabVisible",
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
            "tab_visible",
            "latest_activity",
        ] {
            assert!(
                encoded.get(snake).is_none(),
                "leaked snake_case key {snake}"
            );
        }
        // tab_visible defaults true and serializes as a bool, not null.
        assert_eq!(encoded["tabVisible"], serde_json::json!(true));
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
        // The persistence and wire layers may omit tabVisible / nativeSessionRef /
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
        assert!(decoded.tab_visible);
        assert!(decoded.native_session_ref.is_none());
        assert!(decoded.latest_activity.is_none());
    }
}
