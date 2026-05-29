use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow};
use reverie_core::activity::ActivityState;
use reverie_core::agents::{built_in_adapters, require_detected};
use reverie_core::domain::{
    AgentKind, FocusId, LaunchMode, NativeSessionRef, ProjectId, SessionId, SessionStatus,
    WorkspaceId,
};
use reverie_core::{
    AgentAdapter, CortexSessionDiscovery, CortexSessionMetadata, LaunchContext, TerminalSpawnSpec,
};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

const SHELL_STORE_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceShellSnapshot {
    pub workspace: ShellWorkspace,
    pub projects: Vec<ShellProject>,
    pub focuses: Vec<ShellFocus>,
    pub sessions: Vec<ShellSession>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellWorkspace {
    pub id: WorkspaceId,
    pub name: String,
    pub general_label: String,
    pub default_dangerous_mode: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProject {
    pub id: ProjectId,
    pub name: String,
    pub path: PathBuf,
    pub archived: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellFocus {
    pub id: FocusId,
    pub project_id: Option<ProjectId>,
    pub title: String,
    pub description: Option<String>,
    pub sort_order: i64,
    pub archived: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSession {
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
    #[serde(default = "default_true")]
    pub tab_visible: bool,
    /// Last observed activity-state snapshot from whichever adapter owns this
    /// session (Cortex filesystem watcher today, Claude/Codex hook receiver
    /// soon). Persisted so the dashboard renders state immediately on app
    /// start, before any live signal arrives.
    #[serde(default)]
    pub latest_activity: Option<ActivityState>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub name: String,
    pub path: PathBuf,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFocusRequest {
    pub project_id: Option<ProjectId>,
    pub title: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    pub focus_id: FocusId,
    pub title: String,
    pub agent_kind: AgentKind,
    pub cwd: PathBuf,
    pub dangerous_mode_override: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionTabVisibilityRequest {
    pub shell_session_id: SessionId,
    pub tab_visible: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCortexSessionRequest {
    pub shell_session_id: SessionId,
    pub cortex_session_id: String,
    pub metadata_path: Option<PathBuf>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceShellDocument {
    schema_version: u32,
    snapshot: WorkspaceShellSnapshot,
}

#[derive(Clone, Debug)]
pub struct AppShellStore {
    db_path: PathBuf,
    snapshot: Arc<RwLock<WorkspaceShellSnapshot>>,
}

impl AppShellStore {
    pub fn load_or_seed(path: PathBuf) -> Result<Self> {
        let store_paths = StorePaths::from_requested_path(path);
        if let Some(parent) = store_paths.db_path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!(
                    "failed to create Reverie app shell database directory at {}",
                    parent.display()
                )
            })?;
        }

        let legacy_json_snapshot = load_legacy_json_snapshot(&store_paths.legacy_json_path)?;
        let conn = Connection::open(&store_paths.db_path).with_context(|| {
            format!(
                "failed to open Reverie app shell database at {}",
                store_paths.db_path.display()
            )
        })?;
        migrate_database(&conn)?;

        let mut snapshot = if database_has_workspace(&conn)? {
            load_snapshot_from_database(&conn)?
        } else if let Some(snapshot) = legacy_json_snapshot {
            snapshot
        } else {
            empty_workspace_snapshot()
        };

        let normalized = normalize_shell_snapshot(&mut snapshot);
        if normalized || !database_has_workspace(&conn)? {
            write_snapshot_to_database(&store_paths.db_path, &snapshot)?;
        }

        Ok(Self {
            db_path: store_paths.db_path,
            snapshot: Arc::new(RwLock::new(snapshot)),
        })
    }

    pub fn snapshot(&self) -> Result<WorkspaceShellSnapshot> {
        self.snapshot
            .read()
            .map_err(|_| anyhow!("Reverie app shell store lock poisoned"))
            .map(|snapshot| snapshot.clone())
    }

    pub fn build_agent_spawn_spec(
        &self,
        session_id: SessionId,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSpawnSpec> {
        let (workspace_default_dangerous_mode, session) = {
            let snapshot = self
                .snapshot
                .read()
                .map_err(|_| anyhow!("Reverie app shell store lock poisoned"))?;
            let session = snapshot
                .sessions
                .iter()
                .find(|session| session.id == session_id)
                .with_context(|| format!("unknown Reverie shell session {session_id}"))?
                .clone();

            (snapshot.workspace.default_dangerous_mode, session)
        };
        let adapter = built_in_adapters()
            .into_iter()
            .find(|adapter| adapter.kind() == session.agent_kind)
            .with_context(|| {
                format!(
                    "no built-in adapter registered for {:?}",
                    session.agent_kind
                )
            })?;
        let executable_path = require_detected(adapter.as_ref())?;

        build_agent_spawn_spec_for_session(
            &session,
            workspace_default_dangerous_mode,
            cols,
            rows,
            executable_path,
            adapter.as_ref(),
        )
    }

    pub fn create_project(&self, request: CreateProjectRequest) -> Result<WorkspaceShellSnapshot> {
        let name = required_text(request.name, "project name")?;
        if request.path.as_os_str().is_empty() {
            return Err(anyhow!("project path is required"));
        }

        let mut snapshot = self
            .snapshot
            .write()
            .map_err(|_| anyhow!("Reverie app shell store lock poisoned"))?;

        if snapshot
            .projects
            .iter()
            .any(|project| !project.archived && project.path == request.path)
        {
            return Err(anyhow!(
                "project path is already in Reverie: {}",
                request.path.display()
            ));
        }

        snapshot.projects.push(ShellProject {
            id: ProjectId::new_v4(),
            name,
            path: request.path,
            archived: false,
        });

        write_snapshot_to_database(&self.db_path, &snapshot)?;
        Ok(snapshot.clone())
    }

    pub fn create_focus(&self, request: CreateFocusRequest) -> Result<WorkspaceShellSnapshot> {
        let title = required_text(request.title, "focus title")?;
        let mut snapshot = self
            .snapshot
            .write()
            .map_err(|_| anyhow!("Reverie app shell store lock poisoned"))?;

        if let Some(project_id) = request.project_id {
            let project_exists = snapshot
                .projects
                .iter()
                .any(|project| project.id == project_id && !project.archived);
            if !project_exists {
                return Err(anyhow!(
                    "cannot create focus for unknown or archived project {project_id}"
                ));
            }
        }

        let sort_order = snapshot
            .focuses
            .iter()
            .filter(|focus| focus.project_id == request.project_id && !focus.archived)
            .map(|focus| focus.sort_order)
            .max()
            .map_or(0, |current| current + 10);

        snapshot.focuses.push(ShellFocus {
            id: FocusId::new_v4(),
            project_id: request.project_id,
            title,
            description: request.description.and_then(optional_text),
            sort_order,
            archived: false,
        });

        write_snapshot_to_database(&self.db_path, &snapshot)?;
        Ok(snapshot.clone())
    }

    pub fn create_session(&self, request: CreateSessionRequest) -> Result<WorkspaceShellSnapshot> {
        let title = required_text(request.title, "session title")?;
        if request.cwd.as_os_str().is_empty() {
            return Err(anyhow!("session cwd is required"));
        }

        let mut snapshot = self
            .snapshot
            .write()
            .map_err(|_| anyhow!("Reverie app shell store lock poisoned"))?;

        let focus_exists = snapshot
            .focuses
            .iter()
            .any(|focus| focus.id == request.focus_id && !focus.archived);
        if !focus_exists {
            return Err(anyhow!(
                "cannot create session for unknown or archived focus {}",
                request.focus_id
            ));
        }

        snapshot.sessions.push(ShellSession {
            id: SessionId::new_v4(),
            focus_id: request.focus_id,
            title,
            agent_kind: request.agent_kind,
            cwd: request.cwd,
            native_session_ref: None,
            launch_mode: LaunchMode::New,
            dangerous_mode_override: request.dangerous_mode_override,
            status: SessionStatus::NotStarted,
            last_exit_code: None,
            tab_visible: true,
            latest_activity: None,
        });

        write_snapshot_to_database(&self.db_path, &snapshot)?;
        Ok(snapshot.clone())
    }

    pub fn capture_cortex_session(
        &self,
        request: CaptureCortexSessionRequest,
        cortex_home: PathBuf,
    ) -> Result<WorkspaceShellSnapshot> {
        let cortex_session_id = required_text(request.cortex_session_id, "Cortex session id")?;
        let metadata_path = request.metadata_path.unwrap_or_else(|| {
            CortexSessionMetadata::metadata_path(&cortex_home, &cortex_session_id)
        });
        let encoded = fs::read_to_string(&metadata_path).with_context(|| {
            format!(
                "failed to read Cortex session metadata at {}",
                metadata_path.display()
            )
        })?;
        let metadata = CortexSessionMetadata::from_json(&encoded).with_context(|| {
            format!(
                "failed to parse Cortex session metadata at {}",
                metadata_path.display()
            )
        })?;

        if metadata.id != cortex_session_id {
            return Err(anyhow!(
                "Cortex metadata id {} does not match requested session id {}",
                metadata.id,
                cortex_session_id
            ));
        }

        let metadata_cwd = metadata.cwd.clone();
        let native_session_ref = metadata.into_native_ref(metadata_path);
        let mut snapshot = self
            .snapshot
            .write()
            .map_err(|_| anyhow!("Reverie app shell store lock poisoned"))?;
        let session = snapshot
            .sessions
            .iter_mut()
            .find(|session| session.id == request.shell_session_id)
            .with_context(|| {
                format!("unknown Reverie shell session {}", request.shell_session_id)
            })?;

        if session.agent_kind != AgentKind::CortexCode {
            return Err(anyhow!(
                "cannot attach Cortex native session to {:?} shell session",
                session.agent_kind
            ));
        }
        if session.cwd != metadata_cwd {
            return Err(anyhow!(
                "Cortex metadata cwd {} does not match Reverie session cwd {}",
                metadata_cwd.display(),
                session.cwd.display()
            ));
        }

        session.native_session_ref = Some(native_session_ref);
        session.launch_mode = LaunchMode::Resume;
        if session.status != SessionStatus::Running {
            session.status = SessionStatus::Restorable;
        }

        write_snapshot_to_database(&self.db_path, &snapshot)?;
        Ok(snapshot.clone())
    }

    pub fn capture_cortex_session_after_launch(
        &self,
        shell_session_id: SessionId,
        cortex_home: PathBuf,
        launched_after_ms: i64,
    ) -> Result<Option<WorkspaceShellSnapshot>> {
        let session_cwd = {
            let snapshot = self
                .snapshot
                .read()
                .map_err(|_| anyhow!("Reverie app shell store lock poisoned"))?;
            let session = snapshot
                .sessions
                .iter()
                .find(|session| session.id == shell_session_id)
                .with_context(|| format!("unknown Reverie shell session {shell_session_id}"))?;

            if session.agent_kind != AgentKind::CortexCode || session.native_session_ref.is_some() {
                return Ok(None);
            }

            session.cwd.clone()
        };

        let Some(discovery) = CortexSessionMetadata::discover_latest_for_cwd(
            &cortex_home,
            &session_cwd,
            Some(launched_after_ms),
        )?
        else {
            return Ok(None);
        };

        self.attach_cortex_discovery(shell_session_id, session_cwd, discovery)
            .map(Some)
    }

    fn attach_cortex_discovery(
        &self,
        shell_session_id: SessionId,
        expected_cwd: PathBuf,
        discovery: CortexSessionDiscovery,
    ) -> Result<WorkspaceShellSnapshot> {
        if discovery.metadata.cwd != expected_cwd {
            return Err(anyhow!(
                "Cortex metadata cwd {} does not match Reverie session cwd {}",
                discovery.metadata.cwd.display(),
                expected_cwd.display()
            ));
        }

        let native_session_ref = discovery.metadata.into_native_ref(discovery.metadata_path);
        let mut snapshot = self
            .snapshot
            .write()
            .map_err(|_| anyhow!("Reverie app shell store lock poisoned"))?;
        let session = snapshot
            .sessions
            .iter_mut()
            .find(|session| session.id == shell_session_id)
            .with_context(|| format!("unknown Reverie shell session {shell_session_id}"))?;

        if session.agent_kind != AgentKind::CortexCode {
            return Err(anyhow!(
                "cannot attach Cortex native session to {:?} shell session",
                session.agent_kind
            ));
        }
        if session.cwd != expected_cwd {
            return Err(anyhow!(
                "Reverie session cwd changed from {} to {} before Cortex capture completed",
                expected_cwd.display(),
                session.cwd.display()
            ));
        }

        session.native_session_ref = Some(native_session_ref);
        session.launch_mode = LaunchMode::Resume;
        if session.status != SessionStatus::Running {
            session.status = SessionStatus::Restorable;
        }

        write_snapshot_to_database(&self.db_path, &snapshot)?;
        Ok(snapshot.clone())
    }

    pub fn mark_session_running(&self, session_id: SessionId) -> Result<WorkspaceShellSnapshot> {
        self.update_session(session_id, |session| {
            session.status = SessionStatus::Running;
            session.last_exit_code = None;
        })
    }

    pub fn mark_session_finished(
        &self,
        session_id: SessionId,
        child_success: bool,
    ) -> Result<WorkspaceShellSnapshot> {
        self.update_session(session_id, |session| {
            session.status = if session.native_session_ref.is_some() {
                SessionStatus::Restorable
            } else {
                SessionStatus::Exited
            };
            session.last_exit_code = Some(if child_success { 0 } else { 1 });
        })
    }

    pub fn mark_session_failed(&self, session_id: SessionId) -> Result<WorkspaceShellSnapshot> {
        self.update_session(session_id, |session| {
            session.status = if session.launch_mode == LaunchMode::Resume
                || session.native_session_ref.is_some()
            {
                SessionStatus::RestoreFailed
            } else {
                SessionStatus::Exited
            };
            session.last_exit_code = Some(1);
        })
    }

    pub fn update_session_tab_visibility(
        &self,
        request: UpdateSessionTabVisibilityRequest,
    ) -> Result<WorkspaceShellSnapshot> {
        self.update_session(request.shell_session_id, |session| {
            session.tab_visible = request.tab_visible;
        })
    }

    pub fn set_session_dangerous_mode(
        &self,
        session_id: SessionId,
        dangerous_mode_override: Option<bool>,
    ) -> Result<WorkspaceShellSnapshot> {
        self.update_session(session_id, |session| {
            session.dangerous_mode_override = dangerous_mode_override;
        })
    }

    pub fn set_workspace_default_dangerous_mode(
        &self,
        default_dangerous_mode: bool,
    ) -> Result<WorkspaceShellSnapshot> {
        let mut snapshot = self
            .snapshot
            .write()
            .map_err(|_| anyhow!("Reverie app shell store lock poisoned"))?;
        snapshot.workspace.default_dangerous_mode = default_dangerous_mode;
        write_snapshot_to_database(&self.db_path, &snapshot)?;
        Ok(snapshot.clone())
    }

    pub fn remove_session(&self, session_id: SessionId) -> Result<WorkspaceShellSnapshot> {
        let mut snapshot = self
            .snapshot
            .write()
            .map_err(|_| anyhow!("Reverie app shell store lock poisoned"))?;
        let original_len = snapshot.sessions.len();
        snapshot.sessions.retain(|session| session.id != session_id);
        if snapshot.sessions.len() == original_len {
            return Err(anyhow!("unknown Reverie shell session {session_id}"));
        }

        write_snapshot_to_database(&self.db_path, &snapshot)?;
        Ok(snapshot.clone())
    }

    pub fn archive_focus(&self, focus_id: FocusId) -> Result<WorkspaceShellSnapshot> {
        let mut snapshot = self
            .snapshot
            .write()
            .map_err(|_| anyhow!("Reverie app shell store lock poisoned"))?;
        let focus = snapshot
            .focuses
            .iter_mut()
            .find(|focus| focus.id == focus_id)
            .with_context(|| format!("unknown Reverie focus {focus_id}"))?;
        focus.archived = true;
        for session in snapshot
            .sessions
            .iter_mut()
            .filter(|session| session.focus_id == focus_id)
        {
            session.tab_visible = false;
        }

        write_snapshot_to_database(&self.db_path, &snapshot)?;
        Ok(snapshot.clone())
    }

    pub fn archive_project(&self, project_id: ProjectId) -> Result<WorkspaceShellSnapshot> {
        let mut snapshot = self
            .snapshot
            .write()
            .map_err(|_| anyhow!("Reverie app shell store lock poisoned"))?;
        let project = snapshot
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
            .with_context(|| format!("unknown Reverie project {project_id}"))?;
        project.archived = true;
        let focus_ids: Vec<FocusId> = snapshot
            .focuses
            .iter_mut()
            .filter(|focus| focus.project_id == Some(project_id))
            .map(|focus| {
                focus.archived = true;
                focus.id
            })
            .collect();
        for session in snapshot
            .sessions
            .iter_mut()
            .filter(|session| focus_ids.contains(&session.focus_id))
        {
            session.tab_visible = false;
        }

        write_snapshot_to_database(&self.db_path, &snapshot)?;
        Ok(snapshot.clone())
    }

    /// Persist the latest observed activity state for whichever Reverie
    /// session owns the given CLI-native session id. Drops older updates by
    /// sequence so racing watcher events can't roll the column backwards.
    /// Returns whether a matching Reverie session was found and updated.
    pub fn record_session_activity(
        &self,
        native_session_id: &str,
        activity: ActivityState,
    ) -> Result<bool> {
        let mut snapshot = self
            .snapshot
            .write()
            .map_err(|_| anyhow!("Reverie app shell store lock poisoned"))?;
        let Some(session) = snapshot.sessions.iter_mut().find(|session| {
            session
                .native_session_ref
                .as_ref()
                .and_then(|reference| reference.session_id.as_deref())
                .map_or(false, |existing| existing == native_session_id)
        }) else {
            return Ok(false);
        };
        if let Some(existing) = &session.latest_activity {
            if existing.sequence > activity.sequence {
                return Ok(false);
            }
        }
        session.latest_activity = Some(activity);
        write_snapshot_to_database(&self.db_path, &snapshot)?;
        Ok(true)
    }

    /// Clear the persisted activity for whichever Reverie session owns the
    /// given native session id (called when the watcher reports `Removed`).
    pub fn clear_session_activity(&self, native_session_id: &str) -> Result<bool> {
        let mut snapshot = self
            .snapshot
            .write()
            .map_err(|_| anyhow!("Reverie app shell store lock poisoned"))?;
        let Some(session) = snapshot.sessions.iter_mut().find(|session| {
            session
                .native_session_ref
                .as_ref()
                .and_then(|reference| reference.session_id.as_deref())
                .map_or(false, |existing| existing == native_session_id)
        }) else {
            return Ok(false);
        };
        if session.latest_activity.is_none() {
            return Ok(false);
        }
        session.latest_activity = None;
        write_snapshot_to_database(&self.db_path, &snapshot)?;
        Ok(true)
    }

    /// Persist activity for a session looked up by its Reverie id (the launch
    /// path knows this from the moment it minted the hook token). Also
    /// captures the CLI's native session id into `native_session_ref` the
    /// first time we see it, so future launches use the adapter's resume
    /// path. Returns whether a matching Reverie session was found.
    pub fn record_session_activity_by_id(
        &self,
        reverie_session_id: SessionId,
        native_session_id: &str,
        activity: ActivityState,
    ) -> Result<bool> {
        let mut snapshot = self
            .snapshot
            .write()
            .map_err(|_| anyhow!("Reverie app shell store lock poisoned"))?;
        let Some(session) = snapshot
            .sessions
            .iter_mut()
            .find(|session| session.id == reverie_session_id)
        else {
            return Ok(false);
        };
        if let Some(existing) = &session.latest_activity {
            if existing.sequence > activity.sequence {
                return Ok(false);
            }
        }
        if session.native_session_ref.is_none() {
            session.native_session_ref = Some(NativeSessionRef {
                kind: session.agent_kind,
                session_id: Some(native_session_id.to_owned()),
                metadata_path: None,
                adapter_payload: serde_json::Value::Null,
            });
        }
        session.latest_activity = Some(activity);
        write_snapshot_to_database(&self.db_path, &snapshot)?;
        Ok(true)
    }

    /// Clear persisted activity for a Reverie session by id (paired with the
    /// hook adapter's `Removed` updates so the dashboard drops the row).
    pub fn clear_session_activity_by_id(&self, reverie_session_id: SessionId) -> Result<bool> {
        let mut snapshot = self
            .snapshot
            .write()
            .map_err(|_| anyhow!("Reverie app shell store lock poisoned"))?;
        let Some(session) = snapshot
            .sessions
            .iter_mut()
            .find(|session| session.id == reverie_session_id)
        else {
            return Ok(false);
        };
        if session.latest_activity.is_none() {
            return Ok(false);
        }
        session.latest_activity = None;
        write_snapshot_to_database(&self.db_path, &snapshot)?;
        Ok(true)
    }

    fn update_session(
        &self,
        session_id: SessionId,
        update: impl FnOnce(&mut ShellSession),
    ) -> Result<WorkspaceShellSnapshot> {
        let mut snapshot = self
            .snapshot
            .write()
            .map_err(|_| anyhow!("Reverie app shell store lock poisoned"))?;
        let session = snapshot
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .with_context(|| format!("unknown Reverie shell session {session_id}"))?;

        update(session);
        write_snapshot_to_database(&self.db_path, &snapshot)?;
        Ok(snapshot.clone())
    }
}

fn build_agent_spawn_spec_for_session(
    session: &ShellSession,
    workspace_default_dangerous_mode: bool,
    cols: u16,
    rows: u16,
    executable_path: PathBuf,
    adapter: &dyn AgentAdapter,
) -> Result<TerminalSpawnSpec> {
    if cols == 0 || rows == 0 {
        return Err(anyhow!("terminal launch requires non-zero dimensions"));
    }
    if session.agent_kind != adapter.kind() {
        return Err(anyhow!(
            "cannot launch {:?} shell session through {} adapter",
            session.agent_kind,
            adapter.display_name()
        ));
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
                "{} resume requested for Reverie session {} but no native session ref is attached",
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

/// First-launch snapshot used by `load_or_seed` when neither the database nor a legacy JSON
/// file is present. Returns just the workspace row plus the "General" bucket label, with no
/// projects, focuses, or sessions: users start with an empty workspace and build their own map.
pub fn empty_workspace_snapshot() -> WorkspaceShellSnapshot {
    let workspace_id = uuid("0f70f21f-55c0-4e2a-923e-73360342db80");
    WorkspaceShellSnapshot {
        workspace: ShellWorkspace {
            id: workspace_id,
            name: "Local workspace".to_owned(),
            general_label: "General".to_owned(),
            default_dangerous_mode: false,
        },
        projects: Vec::new(),
        focuses: Vec::new(),
        sessions: Vec::new(),
    }
}

/// Populated demo snapshot. Retained for tests that need a non-trivial shell shape; never
/// invoked from production startup. Production first-launch goes through
/// `empty_workspace_snapshot` above.
pub fn workspace_shell_snapshot() -> WorkspaceShellSnapshot {
    let workspace_id = uuid("0f70f21f-55c0-4e2a-923e-73360342db80");
    let general_focus_id = uuid("342f1d9a-6a8b-4f76-bf9a-4f0908744cc2");
    let reverie_project_id = uuid("cfbf2f41-b4e6-46ee-b6db-ae415bb69a84");
    let terminal_focus_id = uuid("f5ccdb88-b2ef-45c7-a585-f4a27dff4bf2");
    let product_focus_id = uuid("21bbf118-b7b7-4994-98e2-38837fe3a569");

    WorkspaceShellSnapshot {
        workspace: ShellWorkspace {
            id: workspace_id,
            name: "Local workspace".to_owned(),
            general_label: "General".to_owned(),
            default_dangerous_mode: false,
        },
        projects: vec![ShellProject {
            id: reverie_project_id,
            name: "Reverie".to_owned(),
            path: PathBuf::from("/Users/user/Code/reverie"),
            archived: false,
        }],
        focuses: vec![
            ShellFocus {
                id: general_focus_id,
                project_id: None,
                title: "General sessions".to_owned(),
                description: Some("Unprojected agent work stays available without forcing first-run project setup.".to_owned()),
                sort_order: 0,
                archived: false,
            },
            ShellFocus {
                id: terminal_focus_id,
                project_id: Some(reverie_project_id),
                title: "Terminal quality".to_owned(),
                description: Some("Ghostty-backed PTY runtime, Canvas rendering, resize, and lifecycle proof line.".to_owned()),
                sort_order: 10,
                archived: false,
            },
            ShellFocus {
                id: product_focus_id,
                project_id: Some(reverie_project_id),
                title: "Product shell".to_owned(),
                description: Some("Workspace, focus, session navigation around the stable runtime command surface.".to_owned()),
                sort_order: 20,
                archived: false,
            },
        ],
        sessions: vec![
            ShellSession {
                id: uuid("a4a7a693-bcf9-4915-8312-a82c2128f9da"),
                focus_id: general_focus_id,
                title: "Morning planning".to_owned(),
                agent_kind: AgentKind::CortexCode,
                cwd: PathBuf::from("/Users/user"),
                native_session_ref: None,
                launch_mode: LaunchMode::New,
                dangerous_mode_override: Some(false),
                status: SessionStatus::NotStarted,
                last_exit_code: None,
                tab_visible: true,
                latest_activity: None,
            },
            ShellSession {
                id: uuid("f6232926-ec20-470b-92c6-d3db1434ab84"),
                focus_id: terminal_focus_id,
                title: "Live PTY stream proof".to_owned(),
                agent_kind: AgentKind::CortexCode,
                cwd: PathBuf::from("/Users/user/Code/reverie"),
                native_session_ref: None,
                launch_mode: LaunchMode::New,
                dangerous_mode_override: Some(false),
                status: SessionStatus::NotStarted,
                last_exit_code: None,
                tab_visible: true,
                latest_activity: None,
            },
            ShellSession {
                id: uuid("85caac02-3893-4fdb-9428-9b05cf057d04"),
                focus_id: product_focus_id,
                title: "React product shell".to_owned(),
                agent_kind: AgentKind::CortexCode,
                cwd: PathBuf::from("/Users/user/Code/reverie"),
                native_session_ref: None,
                launch_mode: LaunchMode::New,
                dangerous_mode_override: Some(false),
                status: SessionStatus::NotStarted,
                last_exit_code: None,
                tab_visible: true,
                latest_activity: None,
            },
        ],
    }
}

#[cfg(test)]
fn write_snapshot(path: &PathBuf, snapshot: &WorkspaceShellSnapshot) -> Result<()> {
    let document = WorkspaceShellDocument {
        schema_version: SHELL_STORE_SCHEMA_VERSION,
        snapshot: snapshot.clone(),
    };
    let encoded = serde_json::to_string_pretty(&document)
        .context("failed to encode Reverie app shell store")?;
    fs::write(path, encoded).with_context(|| {
        format!(
            "failed to write Reverie app shell store at {}",
            path.display()
        )
    })?;
    Ok(())
}

#[derive(Clone, Debug)]
struct StorePaths {
    db_path: PathBuf,
    legacy_json_path: Option<PathBuf>,
}

impl StorePaths {
    fn from_requested_path(path: PathBuf) -> Self {
        if path.extension().and_then(|extension| extension.to_str()) == Some("json") {
            return Self {
                db_path: path.with_extension("sqlite3"),
                legacy_json_path: Some(path),
            };
        }

        let legacy_json_path = path
            .parent()
            .map(|parent| parent.join("workspace-shell.v1.json"));
        Self {
            db_path: path,
            legacy_json_path,
        }
    }
}

fn load_legacy_json_snapshot(path: &Option<PathBuf>) -> Result<Option<WorkspaceShellSnapshot>> {
    let Some(path) = path else {
        return Ok(None);
    };
    if !path.exists() || !looks_like_json_document(path)? {
        return Ok(None);
    }

    let encoded = fs::read_to_string(path).with_context(|| {
        format!(
            "failed to read legacy Reverie app shell JSON store at {}",
            path.display()
        )
    })?;
    let document: WorkspaceShellDocument = serde_json::from_str(&encoded).with_context(|| {
        format!(
            "failed to decode legacy Reverie app shell JSON store at {}",
            path.display()
        )
    })?;
    if document.schema_version != SHELL_STORE_SCHEMA_VERSION {
        return Err(anyhow!(
            "unsupported legacy Reverie app shell store schema version {}",
            document.schema_version
        ));
    }

    Ok(Some(document.snapshot))
}

fn looks_like_json_document(path: &Path) -> Result<bool> {
    let bytes = fs::read(path).with_context(|| {
        format!(
            "failed to inspect Reverie app shell store at {}",
            path.display()
        )
    })?;
    Ok(bytes
        .iter()
        .copied()
        .find(|byte| !byte.is_ascii_whitespace())
        .is_some_and(|byte| byte == b'{'))
}

fn migrate_database(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at_ms INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS workspace (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            general_label TEXT NOT NULL,
            default_dangerous_mode INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            archived INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS focuses (
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
            title TEXT NOT NULL,
            description TEXT,
            sort_order INTEGER NOT NULL,
            archived INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            focus_id TEXT NOT NULL REFERENCES focuses(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            agent_kind TEXT NOT NULL,
            cwd TEXT NOT NULL,
            native_session_ref_json TEXT,
            launch_mode TEXT NOT NULL,
            dangerous_mode_override INTEGER,
            status TEXT NOT NULL,
            last_exit_code INTEGER,
            tab_visible INTEGER NOT NULL DEFAULT 1
         );",
    )
    .context("failed to migrate Reverie app shell database")?;
    ensure_column(
        conn,
        "sessions",
        "tab_visible",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    ensure_column(conn, "sessions", "latest_activity_json", "TEXT")?;
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations (version, applied_at_ms) VALUES (?1, ?2)",
        params![SHELL_STORE_SCHEMA_VERSION, unix_time_ms()?],
    )
    .context("failed to record Reverie app shell database migration")?;
    Ok(())
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<()> {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .with_context(|| format!("failed to inspect Reverie database table {table}"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .with_context(|| format!("failed to query Reverie database columns for {table}"))?;
    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }

    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
        [],
    )
    .with_context(|| format!("failed to add Reverie database column {table}.{column}"))?;
    Ok(())
}

fn database_has_workspace(conn: &Connection) -> Result<bool> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM workspace", [], |row| row.get(0))
        .context("failed to inspect Reverie workspace table")?;
    Ok(count > 0)
}

fn load_snapshot_from_database(conn: &Connection) -> Result<WorkspaceShellSnapshot> {
    let workspace = conn
        .query_row(
            "SELECT id, name, general_label, default_dangerous_mode FROM workspace LIMIT 1",
            [],
            |row| {
                Ok(ShellWorkspace {
                    id: parse_uuid(row.get::<_, String>(0)?)?,
                    name: row.get(1)?,
                    general_label: row.get(2)?,
                    default_dangerous_mode: int_to_bool(row.get::<_, i64>(3)?),
                })
            },
        )
        .context("failed to load Reverie workspace")?;

    let projects = query_projects(conn)?;
    let focuses = query_focuses(conn)?;
    let sessions = query_sessions(conn)?;

    Ok(WorkspaceShellSnapshot {
        workspace,
        projects,
        focuses,
        sessions,
    })
}

fn query_projects(conn: &Connection) -> Result<Vec<ShellProject>> {
    let mut statement = conn
        .prepare("SELECT id, name, path, archived FROM projects ORDER BY name COLLATE NOCASE")
        .context("failed to prepare Reverie projects query")?;
    let rows = statement
        .query_map([], |row| {
            Ok(ShellProject {
                id: parse_uuid(row.get::<_, String>(0)?)?,
                name: row.get(1)?,
                path: PathBuf::from(row.get::<_, String>(2)?),
                archived: int_to_bool(row.get::<_, i64>(3)?),
            })
        })
        .context("failed to query Reverie projects")?;

    collect_rows(rows, "project")
}

fn query_focuses(conn: &Connection) -> Result<Vec<ShellFocus>> {
    let mut statement = conn
        .prepare(
            "SELECT id, project_id, title, description, sort_order, archived
             FROM focuses
             ORDER BY COALESCE(project_id, ''), sort_order, title COLLATE NOCASE",
        )
        .context("failed to prepare Reverie focuses query")?;
    let rows = statement
        .query_map([], |row| {
            let project_id = row
                .get::<_, Option<String>>(1)?
                .map(parse_uuid)
                .transpose()?;
            Ok(ShellFocus {
                id: parse_uuid(row.get::<_, String>(0)?)?,
                project_id,
                title: row.get(2)?,
                description: row.get(3)?,
                sort_order: row.get(4)?,
                archived: int_to_bool(row.get::<_, i64>(5)?),
            })
        })
        .context("failed to query Reverie focuses")?;

    collect_rows(rows, "focus")
}

fn query_sessions(conn: &Connection) -> Result<Vec<ShellSession>> {
    let mut statement = conn
        .prepare(
            "SELECT id, focus_id, title, agent_kind, cwd, native_session_ref_json,
                    launch_mode, dangerous_mode_override, status, last_exit_code, tab_visible,
                    latest_activity_json
             FROM sessions
             ORDER BY rowid",
        )
        .context("failed to prepare Reverie sessions query")?;
    let rows = statement
        .query_map([], |row| {
            Ok(ShellSession {
                id: parse_uuid(row.get::<_, String>(0)?)?,
                focus_id: parse_uuid(row.get::<_, String>(1)?)?,
                title: row.get(2)?,
                agent_kind: agent_kind_from_db(row.get::<_, String>(3)?)?,
                cwd: PathBuf::from(row.get::<_, String>(4)?),
                native_session_ref: native_session_ref_from_db(row.get::<_, Option<String>>(5)?)?,
                launch_mode: launch_mode_from_db(row.get::<_, String>(6)?)?,
                dangerous_mode_override: row.get::<_, Option<i64>>(7)?.map(int_to_bool),
                status: session_status_from_db(row.get::<_, String>(8)?)?,
                last_exit_code: row.get(9)?,
                tab_visible: int_to_bool(row.get::<_, i64>(10)?),
                latest_activity: activity_state_from_db(row.get::<_, Option<String>>(11)?)?,
            })
        })
        .context("failed to query Reverie sessions")?;

    collect_rows(rows, "session")
}

fn activity_state_from_db(json: Option<String>) -> rusqlite::Result<Option<ActivityState>> {
    match json {
        Some(text) if !text.is_empty() => serde_json::from_str::<ActivityState>(&text)
            .map(Some)
            .map_err(|err| {
                rusqlite::Error::FromSqlConversionFailure(
                    11,
                    rusqlite::types::Type::Text,
                    Box::new(err),
                )
            }),
        _ => Ok(None),
    }
}

fn collect_rows<T>(
    rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>>,
    label: &'static str,
) -> Result<Vec<T>> {
    let mut values = Vec::new();
    for row in rows {
        values.push(row.with_context(|| format!("failed to read Reverie {label} row"))?);
    }
    Ok(values)
}

fn write_snapshot_to_database(path: &Path, snapshot: &WorkspaceShellSnapshot) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create Reverie app shell database directory at {}",
                parent.display()
            )
        })?;
    }
    let mut conn = Connection::open(path).with_context(|| {
        format!(
            "failed to open Reverie app shell database at {}",
            path.display()
        )
    })?;
    migrate_database(&conn)?;
    let transaction = conn
        .transaction()
        .context("failed to start Reverie app shell database transaction")?;

    transaction.execute("DELETE FROM sessions", [])?;
    transaction.execute("DELETE FROM focuses", [])?;
    transaction.execute("DELETE FROM projects", [])?;
    transaction.execute("DELETE FROM workspace", [])?;

    transaction.execute(
        "INSERT INTO workspace (id, name, general_label, default_dangerous_mode)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            snapshot.workspace.id.to_string(),
            snapshot.workspace.name,
            snapshot.workspace.general_label,
            bool_to_int(snapshot.workspace.default_dangerous_mode),
        ],
    )?;

    for project in &snapshot.projects {
        transaction.execute(
            "INSERT INTO projects (id, name, path, archived) VALUES (?1, ?2, ?3, ?4)",
            params![
                project.id.to_string(),
                project.name,
                path_to_db(&project.path),
                bool_to_int(project.archived),
            ],
        )?;
    }

    for focus in &snapshot.focuses {
        transaction.execute(
            "INSERT INTO focuses (id, project_id, title, description, sort_order, archived)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                focus.id.to_string(),
                focus.project_id.map(|project_id| project_id.to_string()),
                focus.title,
                focus.description,
                focus.sort_order,
                bool_to_int(focus.archived),
            ],
        )?;
    }

    for session in &snapshot.sessions {
        let latest_activity_json = match &session.latest_activity {
            Some(state) => Some(serde_json::to_string(state).with_context(|| {
                format!(
                    "serializing latest activity for Reverie session {}",
                    session.id
                )
            })?),
            None => None,
        };
        transaction.execute(
            "INSERT INTO sessions (
                id, focus_id, title, agent_kind, cwd, native_session_ref_json, launch_mode,
                dangerous_mode_override, status, last_exit_code, tab_visible, latest_activity_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                session.id.to_string(),
                session.focus_id.to_string(),
                session.title,
                agent_kind_to_db(session.agent_kind)?,
                path_to_db(&session.cwd),
                native_session_ref_to_db(&session.native_session_ref)?,
                launch_mode_to_db(session.launch_mode)?,
                session.dangerous_mode_override.map(bool_to_int),
                session_status_to_db(session.status)?,
                session.last_exit_code,
                bool_to_int(session.tab_visible),
                latest_activity_json,
            ],
        )?;
    }

    transaction
        .commit()
        .context("failed to commit Reverie app shell database transaction")?;
    Ok(())
}

fn parse_uuid(value: String) -> rusqlite::Result<WorkspaceId> {
    WorkspaceId::parse_str(&value).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(err))
    })
}

fn agent_kind_to_db(value: AgentKind) -> Result<String> {
    serde_json::to_value(value)
        .context("failed to encode agent kind")?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("agent kind did not encode as a string"))
}

fn agent_kind_from_db(value: String) -> rusqlite::Result<AgentKind> {
    enum_from_db(&value)
}

fn launch_mode_to_db(value: LaunchMode) -> Result<String> {
    serde_json::to_value(value)
        .context("failed to encode launch mode")?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("launch mode did not encode as a string"))
}

fn launch_mode_from_db(value: String) -> rusqlite::Result<LaunchMode> {
    enum_from_db(&value)
}

fn session_status_to_db(value: SessionStatus) -> Result<String> {
    serde_json::to_value(value)
        .context("failed to encode session status")?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("session status did not encode as a string"))
}

fn session_status_from_db(value: String) -> rusqlite::Result<SessionStatus> {
    enum_from_db(&value)
}

fn enum_from_db<T>(value: &str) -> rusqlite::Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(serde_json::Value::String(value.to_owned())).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(err))
    })
}

fn native_session_ref_to_db(value: &Option<NativeSessionRef>) -> Result<Option<String>> {
    value
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .context("failed to encode native session ref")
}

fn native_session_ref_from_db(value: Option<String>) -> rusqlite::Result<Option<NativeSessionRef>> {
    value
        .map(|encoded| serde_json::from_str(&encoded))
        .transpose()
        .map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(err))
        })
}

fn path_to_db(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn bool_to_int(value: bool) -> i64 {
    i64::from(value)
}

fn default_true() -> bool {
    true
}

fn int_to_bool(value: i64) -> bool {
    value != 0
}

fn unix_time_ms() -> Result<i64> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before unix epoch")?;
    Ok(duration.as_millis() as i64)
}

fn normalize_shell_snapshot(snapshot: &mut WorkspaceShellSnapshot) -> bool {
    let mut changed = false;

    for session in &mut snapshot.sessions {
        if session.launch_mode == LaunchMode::Resume && session.native_session_ref.is_none() {
            session.launch_mode = LaunchMode::New;
            changed = true;
        }

        if session.native_session_ref.is_some() && session.launch_mode != LaunchMode::Resume {
            session.launch_mode = LaunchMode::Resume;
            changed = true;
        }

        if session.status == SessionStatus::Restorable && session.native_session_ref.is_none() {
            session.status = SessionStatus::NotStarted;
            session.last_exit_code = None;
            changed = true;
        }

        if session.status == SessionStatus::Running {
            session.status = if session.native_session_ref.is_some() {
                SessionStatus::Restorable
            } else {
                SessionStatus::Exited
            };
            if session.last_exit_code.is_none() {
                session.last_exit_code = Some(1);
            }
            changed = true;
        }

        if session.native_session_ref.is_some()
            && matches!(
                session.status,
                SessionStatus::NotStarted | SessionStatus::Exited
            )
        {
            session.status = SessionStatus::Restorable;
            changed = true;
        }
    }

    changed
}

fn required_text(value: String, label: &'static str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(anyhow!("{label} is required"))
    } else {
        Ok(trimmed.to_owned())
    }
}

fn optional_text(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn uuid(value: &str) -> WorkspaceId {
    WorkspaceId::parse_str(value).expect("seeded Reverie shell IDs must be valid UUIDs")
}

#[cfg(test)]
mod tests {
    use super::*;
    use reverie_core::agents::{ClaudeCodeAdapter, CodexCliAdapter, CortexAdapter};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn shell_snapshot_preserves_general_focus_without_project() {
        let snapshot = workspace_shell_snapshot();

        assert!(!snapshot.workspace.default_dangerous_mode);
        assert!(
            snapshot
                .focuses
                .iter()
                .any(|focus| focus.project_id.is_none())
        );
        assert!(snapshot.sessions.iter().any(|session| {
            snapshot
                .focuses
                .iter()
                .any(|focus| focus.id == session.focus_id && focus.project_id.is_none())
        }));
    }

    #[test]
    fn shell_snapshot_links_project_focus_sessions() {
        let snapshot = workspace_shell_snapshot();
        let project = snapshot
            .projects
            .first()
            .expect("seed project should exist");
        let project_focus_ids = snapshot
            .focuses
            .iter()
            .filter(|focus| focus.project_id == Some(project.id))
            .map(|focus| focus.id)
            .collect::<Vec<_>>();

        assert!(!project_focus_ids.is_empty());
        assert!(
            snapshot
                .sessions
                .iter()
                .any(|session| project_focus_ids.contains(&session.focus_id))
        );
    }

    #[test]
    fn app_shell_store_seeds_when_missing() {
        let path = temp_store_path("seed");
        let db_path = path.with_extension("sqlite3");
        let store = AppShellStore::load_or_seed(path.clone()).expect("store should seed");
        let snapshot = store.snapshot().expect("snapshot should load");

        assert!(db_path.exists());
        assert_eq!(snapshot.workspace.general_label, "General");

        let _ = fs::remove_file(path);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn app_shell_store_normalizes_invalid_resume_without_native_ref() {
        let path = temp_store_path("normalize-resume");
        let mut snapshot = workspace_shell_snapshot();
        let session = snapshot
            .sessions
            .first_mut()
            .expect("seed session should exist");
        session.launch_mode = LaunchMode::Resume;
        session.status = SessionStatus::Restorable;
        session.last_exit_code = Some(0);
        session.native_session_ref = None;
        let session_id = session.id;
        write_snapshot(&path, &snapshot).expect("invalid fixture should be written");

        let normalized = AppShellStore::load_or_seed(path.clone())
            .expect("store should load and normalize")
            .snapshot()
            .expect("snapshot should load");
        let session = normalized
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .expect("session should still exist");

        assert_eq!(session.launch_mode, LaunchMode::New);
        assert_eq!(session.status, SessionStatus::NotStarted);
        assert_eq!(session.last_exit_code, None);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn app_shell_store_normalizes_captured_session_to_restorable() {
        let path = temp_store_path("normalize-captured-restorable");
        let mut snapshot = workspace_shell_snapshot();
        let session = snapshot
            .sessions
            .first_mut()
            .expect("seed session should exist");
        session.launch_mode = LaunchMode::New;
        session.status = SessionStatus::Exited;
        session.last_exit_code = Some(1);
        session.native_session_ref = Some(NativeSessionRef::cortex("native-cortex-session", None));
        let session_id = session.id;
        write_snapshot(&path, &snapshot).expect("captured fixture should be written");

        let normalized = AppShellStore::load_or_seed(path.clone())
            .expect("store should load and normalize")
            .snapshot()
            .expect("snapshot should load");
        let session = normalized
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .expect("session should still exist");

        assert_eq!(session.launch_mode, LaunchMode::Resume);
        assert_eq!(session.status, SessionStatus::Restorable);
        assert_eq!(session.last_exit_code, Some(1));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn app_shell_store_normalizes_stale_running_sessions_on_load() {
        let path = temp_store_path("normalize-stale-running");
        let mut snapshot = workspace_shell_snapshot();
        let sessions = &mut snapshot.sessions;
        let uncaptured_session_id = sessions.first_mut().expect("seed session should exist").id;
        sessions
            .first_mut()
            .expect("seed session should exist")
            .status = SessionStatus::Running;
        let captured_session = sessions
            .get_mut(1)
            .expect("second seed session should exist");
        captured_session.status = SessionStatus::Running;
        captured_session.native_session_ref =
            Some(NativeSessionRef::cortex("native-cortex-session", None));
        let captured_session_id = captured_session.id;
        write_snapshot(&path, &snapshot).expect("stale running fixture should be written");

        let normalized = AppShellStore::load_or_seed(path.clone())
            .expect("store should load and normalize")
            .snapshot()
            .expect("snapshot should load");
        let uncaptured = normalized
            .sessions
            .iter()
            .find(|session| session.id == uncaptured_session_id)
            .expect("uncaptured session should still exist");
        let captured = normalized
            .sessions
            .iter()
            .find(|session| session.id == captured_session_id)
            .expect("captured session should still exist");

        assert_eq!(uncaptured.status, SessionStatus::Exited);
        assert_eq!(uncaptured.last_exit_code, Some(1));
        assert_eq!(captured.launch_mode, LaunchMode::Resume);
        assert_eq!(captured.status, SessionStatus::Restorable);
        assert_eq!(captured.last_exit_code, Some(1));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn create_focus_persists_and_round_trips() {
        let path = temp_store_path("focus");
        let store = AppShellStore::load_or_seed(path.clone()).expect("store should seed");

        let updated = store
            .create_focus(CreateFocusRequest {
                project_id: None,
                title: "Inbox".to_owned(),
                description: Some("Loose agent sessions".to_owned()),
            })
            .expect("focus should be created");

        assert!(
            updated
                .focuses
                .iter()
                .any(|focus| focus.project_id.is_none() && focus.title == "Inbox")
        );

        let reloaded = AppShellStore::load_or_seed(path.clone())
            .expect("store should reload")
            .snapshot()
            .expect("snapshot should reload");
        assert!(
            reloaded
                .focuses
                .iter()
                .any(|focus| focus.project_id.is_none() && focus.title == "Inbox")
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn create_session_rejects_unknown_focus() {
        let path = temp_store_path("session");
        let store = AppShellStore::load_or_seed(path.clone()).expect("store should seed");

        let err = store
            .create_session(CreateSessionRequest {
                focus_id: FocusId::new_v4(),
                title: "Detached session".to_owned(),
                agent_kind: AgentKind::CortexCode,
                cwd: PathBuf::from("/tmp"),
                dangerous_mode_override: Some(false),
            })
            .expect_err("unknown focus should be rejected");

        assert!(err.to_string().contains("unknown or archived focus"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn app_shell_store_persists_runtime_session_status_changes() {
        let path = temp_store_path("runtime-status");
        write_snapshot(&path, &workspace_shell_snapshot()).expect("demo fixture should be written");
        let store = AppShellStore::load_or_seed(path.clone()).expect("store should seed");
        let session_id = store
            .snapshot()
            .expect("snapshot should load")
            .sessions
            .first()
            .expect("seed session should exist")
            .id;

        let running = store
            .mark_session_running(session_id)
            .expect("session should be marked running");
        assert_eq!(
            running
                .sessions
                .iter()
                .find(|session| session.id == session_id)
                .expect("session should remain present")
                .status,
            SessionStatus::Running
        );

        store
            .mark_session_finished(session_id, false)
            .expect("session should be marked exited");
        let reloaded = AppShellStore::load_or_seed(path.clone())
            .expect("store should reload")
            .snapshot()
            .expect("snapshot should reload");
        let persisted = reloaded
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .expect("session should persist");

        assert_eq!(persisted.status, SessionStatus::Exited);
        assert_eq!(persisted.last_exit_code, Some(1));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn cortex_new_launch_spec_uses_shell_session_settings() {
        let snapshot = workspace_shell_snapshot();
        let mut session = snapshot
            .sessions
            .iter()
            .find(|session| session.cwd == PathBuf::from("/Users/user/Code/reverie"))
            .expect("seeded Reverie session should exist")
            .clone();
        session.dangerous_mode_override = Some(true);

        let adapter = CortexAdapter;
        let spec = build_agent_spawn_spec_for_session(
            &session,
            false,
            132,
            43,
            PathBuf::from("/opt/homebrew/bin/cortex"),
            &adapter,
        )
        .expect("new Cortex launch spec should build");

        assert_eq!(
            spec.command.program,
            PathBuf::from("/opt/homebrew/bin/cortex")
        );
        assert_eq!(spec.command.args, vec!["--yolo"]);
        assert_eq!(
            spec.command.cwd,
            PathBuf::from("/Users/user/Code/reverie")
        );
        assert_eq!(spec.cols, 132);
        assert_eq!(spec.rows, 43);
        assert_eq!(
            spec.title.as_deref(),
            Some("Live PTY stream proof · Cortex Code")
        );
    }

    #[test]
    fn cortex_resume_launch_spec_uses_native_session_ref() {
        let snapshot = workspace_shell_snapshot();
        let mut session = snapshot
            .sessions
            .iter()
            .find(|session| session.cwd == PathBuf::from("/Users/user/Code/reverie"))
            .expect("seeded Reverie session should exist")
            .clone();
        session.launch_mode = LaunchMode::Resume;
        session.native_session_ref = Some(NativeSessionRef::cortex("native-cortex-session", None));
        session.dangerous_mode_override = Some(false);

        let adapter = CortexAdapter;
        let spec = build_agent_spawn_spec_for_session(
            &session,
            true,
            100,
            32,
            PathBuf::from("/opt/homebrew/bin/cortex"),
            &adapter,
        )
        .expect("resume Cortex launch spec should build");

        assert_eq!(
            spec.command.program,
            PathBuf::from("/opt/homebrew/bin/cortex")
        );
        assert_eq!(spec.command.args, vec!["--resume", "native-cortex-session"]);
        assert_eq!(
            spec.command.cwd,
            PathBuf::from("/Users/user/Code/reverie")
        );
        assert_eq!(spec.cols, 100);
        assert_eq!(spec.rows, 32);
    }

    #[test]
    fn codex_launch_spec_uses_the_generic_agent_boundary() {
        let snapshot = workspace_shell_snapshot();
        let mut session = snapshot
            .sessions
            .iter()
            .find(|session| session.cwd == PathBuf::from("/Users/user/Code/reverie"))
            .expect("seeded Reverie session should exist")
            .clone();
        session.agent_kind = AgentKind::CodexCli;
        session.dangerous_mode_override = Some(true);

        let adapter = CodexCliAdapter;
        let spec = build_agent_spawn_spec_for_session(
            &session,
            false,
            120,
            40,
            PathBuf::from("/opt/homebrew/bin/codex"),
            &adapter,
        )
        .expect("new Codex launch spec should build");

        assert_eq!(
            spec.command.program,
            PathBuf::from("/opt/homebrew/bin/codex")
        );
        assert_eq!(
            spec.command.args,
            vec![
                "--cd",
                "/Users/user/Code/reverie",
                "--dangerously-bypass-approvals-and-sandbox"
            ]
        );
        assert_eq!(
            spec.command.cwd,
            PathBuf::from("/Users/user/Code/reverie")
        );
        assert_eq!(
            spec.title.as_deref(),
            Some("Live PTY stream proof · Codex CLI")
        );
        assert!(
            spec.command.env.is_empty(),
            "Codex launch should not redirect CODEX_HOME/HOME/XDG_CONFIG_HOME away from the user's normal auth"
        );
    }

    #[test]
    fn claude_launch_spec_preserves_user_auth_environment() {
        let snapshot = workspace_shell_snapshot();
        let mut session = snapshot
            .sessions
            .iter()
            .find(|session| session.cwd == PathBuf::from("/Users/user/Code/reverie"))
            .expect("seeded Reverie session should exist")
            .clone();
        session.agent_kind = AgentKind::ClaudeCode;
        session.dangerous_mode_override = Some(false);

        let adapter = ClaudeCodeAdapter;
        let spec = build_agent_spawn_spec_for_session(
            &session,
            false,
            120,
            40,
            PathBuf::from("/opt/homebrew/bin/claude"),
            &adapter,
        )
        .expect("new Claude launch spec should build");

        assert_eq!(
            spec.command.program,
            PathBuf::from("/opt/homebrew/bin/claude")
        );
        assert_eq!(
            spec.command.cwd,
            PathBuf::from("/Users/user/Code/reverie")
        );
        assert!(
            spec.command.env.is_empty(),
            "Claude launch should not redirect CLAUDE_CONFIG_DIR/HOME/XDG_CONFIG_HOME away from the user's normal auth"
        );
    }

    #[test]
    fn capture_cortex_session_persists_native_restore_ref() {
        let path = temp_store_path("cortex-capture");
        let cortex_home = temp_store_path("cortex-home");
        let cortex_session_id = "session-abc";
        let metadata_path = CortexSessionMetadata::metadata_path(&cortex_home, cortex_session_id);
        fs::create_dir_all(
            metadata_path
                .parent()
                .expect("metadata path should have parent"),
        )
        .expect("metadata directory should be created");
        fs::write(
            &metadata_path,
            r#"{
              "id": "session-abc",
              "mode": "build",
              "provider": "openai-codex",
              "model": "gpt-5.5",
              "cwd": "/Users/user/Code/reverie",
              "createdAt": 1779664765667,
              "updatedAt": 1779665243918,
              "contextTokenCount": 42
            }"#,
        )
        .expect("metadata should be written");

        write_snapshot(&path, &workspace_shell_snapshot()).expect("demo fixture should be written");
        let store = AppShellStore::load_or_seed(path.clone()).expect("store should seed");
        let session_id = store
            .snapshot()
            .expect("snapshot should load")
            .sessions
            .iter()
            .find(|session| session.cwd == PathBuf::from("/Users/user/Code/reverie"))
            .expect("seeded Reverie session should exist")
            .id;

        let updated = store
            .capture_cortex_session(
                CaptureCortexSessionRequest {
                    shell_session_id: session_id,
                    cortex_session_id: cortex_session_id.to_owned(),
                    metadata_path: None,
                },
                cortex_home.clone(),
            )
            .expect("Cortex session should be captured");
        let captured = updated
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .expect("session should still exist");

        assert_eq!(captured.launch_mode, LaunchMode::Resume);
        assert_eq!(captured.status, SessionStatus::Restorable);
        assert_eq!(
            captured
                .native_session_ref
                .as_ref()
                .and_then(|native| native.session_id.as_deref()),
            Some(cortex_session_id)
        );

        let _ = fs::remove_file(path);
        let _ = fs::remove_dir_all(cortex_home);
    }

    #[test]
    fn capture_cortex_session_after_launch_uses_cwd_and_launch_window() {
        let path = temp_store_path("cortex-launch-capture");
        let cortex_home = temp_store_path("cortex-launch-home");
        write_snapshot(&path, &workspace_shell_snapshot()).expect("demo fixture should be written");
        let store = AppShellStore::load_or_seed(path.clone()).expect("store should seed");
        let session_id = store
            .snapshot()
            .expect("snapshot should load")
            .sessions
            .iter()
            .find(|session| session.cwd == PathBuf::from("/Users/user/Code/reverie"))
            .expect("seeded Reverie session should exist")
            .id;

        write_cortex_metadata(
            &cortex_home,
            "too-old",
            "/Users/user/Code/reverie",
            1_000,
        );
        write_cortex_metadata(&cortex_home, "wrong-cwd", "/Users/user", 3_000);
        write_cortex_metadata(
            &cortex_home,
            "launched-session",
            "/Users/user/Code/reverie",
            2_000,
        );

        let updated = store
            .capture_cortex_session_after_launch(session_id, cortex_home.clone(), 1_500)
            .expect("launch discovery should not fail")
            .expect("matching Cortex session should be captured");
        let captured = updated
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .expect("session should still exist");

        assert_eq!(captured.launch_mode, LaunchMode::Resume);
        assert_eq!(captured.status, SessionStatus::Restorable);
        assert_eq!(
            captured
                .native_session_ref
                .as_ref()
                .and_then(|native| native.session_id.as_deref()),
            Some("launched-session")
        );

        let _ = fs::remove_file(path);
        let _ = fs::remove_dir_all(cortex_home);
    }

    fn write_cortex_metadata(cortex_home: &PathBuf, session_id: &str, cwd: &str, updated_at: i64) {
        let metadata_path = CortexSessionMetadata::metadata_path(cortex_home, session_id);
        fs::create_dir_all(
            metadata_path
                .parent()
                .expect("metadata path should have parent"),
        )
        .expect("metadata directory should be created");
        fs::write(
            metadata_path,
            format!(
                r#"{{
                  "id": "{session_id}",
                  "mode": "build",
                  "provider": "openai-codex",
                  "model": "gpt-5.5",
                  "cwd": "{cwd}",
                  "createdAt": {created_at},
                  "updatedAt": {updated_at},
                  "contextTokenCount": 42
                }}"#,
                created_at = updated_at - 100
            ),
        )
        .expect("metadata should be written");
    }

    fn temp_store_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "reverie-app-shell-store-{label}-{}-{nanos}.json",
            std::process::id()
        ))
    }
}
