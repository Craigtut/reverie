use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub type WorkspaceId = Uuid;
pub type ProjectId = Uuid;
pub type FocusId = Uuid;
pub type SessionId = Uuid;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceSettings {
    pub id: WorkspaceId,
    pub app_data_path: PathBuf,
    pub general_workspace_path: PathBuf,
    pub default_dangerous_mode: bool,
}

impl WorkspaceSettings {
    pub fn new(app_data_path: PathBuf, general_workspace_path: PathBuf) -> Self {
        Self {
            id: Uuid::new_v4(),
            app_data_path,
            general_workspace_path,
            default_dangerous_mode: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub id: SessionId,
    pub focus_id: FocusId,
    pub title: String,
    pub agent_kind: AgentKind,
    pub cwd: PathBuf,
    pub native_session_ref: Option<NativeSessionRef>,
    pub launch_mode: LaunchMode,
    pub dangerous_mode_override: Option<bool>,
    pub status: SessionStatus,
    pub last_exit_code: Option<i32>,
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
}
