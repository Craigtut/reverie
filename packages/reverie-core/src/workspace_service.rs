//! Workspace business logic over a [`WorkspaceRepository`].
//!
//! This is the home for everything that used to live tangled inside the Tauri
//! shell's `AppShellStore`: input validation, boot-time session normalization,
//! the activity sequence-guard, and orchestration of incremental repository
//! writes. It depends only on the repository trait and the agent adapters, so
//! it is fully testable against [`InMemoryWorkspaceRepository`] without Tauri
//! or a real database, and it is `Send + Sync` for use as Tauri managed state.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};

use crate::activity::ActivityState;
use crate::agents::{
    CortexSessionMetadata, build_spawn_spec, built_in_adapters, require_detected,
};
use crate::domain::{
    AgentKind, Focus, FocusId, LaunchMode, NativeSessionRef, Project, ProjectId, Session,
    SessionId, SessionStatus, Workspace, WorkspaceId, WorkspaceSnapshot,
};
use crate::repository::WorkspaceRepository;
use crate::terminal::TerminalSpawnSpec;

/// Stable id for the single local workspace, so it is identical across restarts
/// regardless of which backend seeded it.
const SEED_WORKSPACE_ID: &str = "0f70f21f-55c0-4e2a-923e-73360342db80";

pub struct WorkspaceService {
    repo: Arc<dyn WorkspaceRepository>,
}

impl WorkspaceService {
    pub fn new(repo: Arc<dyn WorkspaceRepository>) -> Self {
        Self { repo }
    }

    /// Seed the workspace row on first run, then reconcile any sessions left in
    /// a transient state by an unclean shutdown. Idempotent.
    pub fn ensure_seeded(&self) -> Result<()> {
        let seed = Workspace {
            id: seed_workspace_id(),
            name: "Local workspace".to_owned(),
            general_label: "General".to_owned(),
            default_dangerous_mode: false,
        };
        self.repo.ensure_seeded(&seed)?;
        self.normalize_sessions()?;
        Ok(())
    }

    pub fn snapshot(&self) -> Result<WorkspaceSnapshot> {
        Ok(self.repo.load_snapshot()?)
    }

    pub fn create_project(&self, name: String, path: PathBuf) -> Result<WorkspaceSnapshot> {
        let name = required_text(name, "project name")?;
        if path.as_os_str().is_empty() {
            bail!("project path is required");
        }
        let snapshot = self.repo.load_snapshot()?;
        if snapshot
            .projects
            .iter()
            .any(|project| !project.archived && project.path == path)
        {
            bail!("project path is already in Reverie: {}", path.display());
        }
        self.repo.upsert_project(&Project::new(name, path))?;
        Ok(self.repo.load_snapshot()?)
    }

    pub fn create_focus(
        &self,
        project_id: Option<ProjectId>,
        title: String,
        description: Option<String>,
    ) -> Result<WorkspaceSnapshot> {
        let title = required_text(title, "focus title")?;
        let snapshot = self.repo.load_snapshot()?;
        if let Some(project_id) = project_id {
            let project_ok = snapshot
                .projects
                .iter()
                .any(|project| project.id == project_id && !project.archived);
            if !project_ok {
                bail!("cannot create focus for unknown or archived project {project_id}");
            }
        }
        let sort_order = snapshot
            .focuses
            .iter()
            .filter(|focus| focus.project_id == project_id && !focus.archived)
            .map(|focus| focus.sort_order)
            .max()
            .map_or(0, |current| current + 10);

        let focus = Focus {
            id: FocusId::new_v4(),
            project_id,
            title,
            description: description.and_then(optional_text),
            sort_order,
            archived: false,
        };
        self.repo.upsert_focus(&focus)?;
        Ok(self.repo.load_snapshot()?)
    }

    pub fn create_session(
        &self,
        focus_id: FocusId,
        title: String,
        agent_kind: AgentKind,
        cwd: PathBuf,
        dangerous_mode_override: Option<bool>,
    ) -> Result<WorkspaceSnapshot> {
        let title = required_text(title, "session title")?;
        if cwd.as_os_str().is_empty() {
            bail!("session cwd is required");
        }
        let snapshot = self.repo.load_snapshot()?;
        let focus_ok = snapshot
            .focuses
            .iter()
            .any(|focus| focus.id == focus_id && !focus.archived);
        if !focus_ok {
            bail!("cannot create session for unknown or archived focus {focus_id}");
        }

        let mut session = Session::new(focus_id, title, agent_kind, cwd);
        session.dangerous_mode_override = dangerous_mode_override;
        self.repo.upsert_session(&session)?;
        Ok(self.repo.load_snapshot()?)
    }

    pub fn set_session_tab_visibility(
        &self,
        session_id: SessionId,
        tab_visible: bool,
    ) -> Result<WorkspaceSnapshot> {
        self.update_session(session_id, |session| session.tab_visible = tab_visible)
    }

    pub fn set_session_dangerous_mode(
        &self,
        session_id: SessionId,
        dangerous_mode_override: Option<bool>,
    ) -> Result<WorkspaceSnapshot> {
        self.update_session(session_id, |session| {
            session.dangerous_mode_override = dangerous_mode_override;
        })
    }

    pub fn set_workspace_default_dangerous_mode(
        &self,
        default_dangerous_mode: bool,
    ) -> Result<WorkspaceSnapshot> {
        let mut workspace = self.repo.load_snapshot()?.workspace;
        workspace.default_dangerous_mode = default_dangerous_mode;
        self.repo.save_workspace(&workspace)?;
        Ok(self.repo.load_snapshot()?)
    }

    pub fn remove_session(&self, session_id: SessionId) -> Result<WorkspaceSnapshot> {
        self.repo.delete_session(session_id)?;
        Ok(self.repo.load_snapshot()?)
    }

    pub fn archive_focus(&self, focus_id: FocusId) -> Result<WorkspaceSnapshot> {
        self.repo.archive_focus_cascade(focus_id)?;
        Ok(self.repo.load_snapshot()?)
    }

    pub fn archive_project(&self, project_id: ProjectId) -> Result<WorkspaceSnapshot> {
        self.repo.archive_project_cascade(project_id)?;
        Ok(self.repo.load_snapshot()?)
    }

    pub fn mark_session_running(&self, session_id: SessionId) -> Result<WorkspaceSnapshot> {
        self.update_session(session_id, |session| {
            session.status = SessionStatus::Running;
            session.last_exit_code = None;
        })
    }

    pub fn mark_session_finished(
        &self,
        session_id: SessionId,
        child_success: bool,
    ) -> Result<WorkspaceSnapshot> {
        self.update_session(session_id, |session| {
            session.status = if session.native_session_ref.is_some() {
                SessionStatus::Restorable
            } else {
                SessionStatus::Exited
            };
            session.last_exit_code = Some(if child_success { 0 } else { 1 });
        })
    }

    pub fn mark_session_failed(&self, session_id: SessionId) -> Result<WorkspaceSnapshot> {
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

    /// Explicit Cortex capture (FE-triggered): read the session's `meta.json`,
    /// verify it matches the Reverie session, and attach it as a resume ref.
    pub fn capture_cortex_session(
        &self,
        shell_session_id: SessionId,
        cortex_session_id: String,
        metadata_path: Option<PathBuf>,
        cortex_home: PathBuf,
    ) -> Result<WorkspaceSnapshot> {
        let cortex_session_id = required_text(cortex_session_id, "Cortex session id")?;
        let metadata_path = metadata_path
            .unwrap_or_else(|| CortexSessionMetadata::metadata_path(&cortex_home, &cortex_session_id));
        let encoded = std::fs::read_to_string(&metadata_path).with_context(|| {
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
            bail!(
                "Cortex metadata id {} does not match requested session id {}",
                metadata.id,
                cortex_session_id
            );
        }
        let metadata_cwd = metadata.cwd.clone();
        let native_session_ref = metadata.into_native_ref(metadata_path);
        self.attach_native_session(
            shell_session_id,
            metadata_cwd,
            native_session_ref,
            AgentKind::CortexCode,
        )?;
        Ok(self.repo.load_snapshot()?)
    }

    /// Attach a discovered native session ref, moving the session to resume /
    /// restorable. Guards that the kind and cwd still match so an async
    /// discovery can't clobber a session that changed out from under it. Skips
    /// silently (Ok) if a ref is already attached. This is the generic seam the
    /// adapter-driven post-launch discovery (Phase 4) calls.
    pub fn attach_native_session(
        &self,
        session_id: SessionId,
        expected_cwd: PathBuf,
        native_session_ref: NativeSessionRef,
        expected_kind: AgentKind,
    ) -> Result<()> {
        let mut session = self
            .repo
            .get_session(session_id)?
            .ok_or_else(|| anyhow!("unknown Reverie session {session_id}"))?;
        if session.native_session_ref.is_some() {
            return Ok(());
        }
        if session.agent_kind != expected_kind {
            bail!(
                "cannot attach {:?} native session to {:?} session",
                expected_kind,
                session.agent_kind
            );
        }
        if session.cwd != expected_cwd {
            bail!(
                "Reverie session cwd {} does not match native session cwd {}",
                session.cwd.display(),
                expected_cwd.display()
            );
        }
        session.native_session_ref = Some(native_session_ref);
        session.launch_mode = LaunchMode::Resume;
        if session.status != SessionStatus::Running {
            session.status = SessionStatus::Restorable;
        }
        self.repo.upsert_session(&session)?;
        Ok(())
    }

    /// Persist the latest activity for whichever session owns `native_session_id`.
    /// Drops out-of-order updates by sequence. Returns whether a session matched.
    pub fn record_session_activity(
        &self,
        native_session_id: &str,
        activity: ActivityState,
    ) -> Result<bool> {
        let Some(mut session) = self.repo.find_session_by_native_id(native_session_id)? else {
            return Ok(false);
        };
        if let Some(existing) = &session.latest_activity {
            if existing.sequence > activity.sequence {
                return Ok(false);
            }
        }
        session.latest_activity = Some(activity);
        self.repo.upsert_session(&session)?;
        Ok(true)
    }

    pub fn clear_session_activity(&self, native_session_id: &str) -> Result<bool> {
        let Some(mut session) = self.repo.find_session_by_native_id(native_session_id)? else {
            return Ok(false);
        };
        if session.latest_activity.is_none() {
            return Ok(false);
        }
        session.latest_activity = None;
        self.repo.upsert_session(&session)?;
        Ok(true)
    }

    /// Persist activity for a session looked up by its Reverie id, capturing the
    /// CLI's native session id into `native_session_ref` the first time it is
    /// seen so future launches use the adapter's resume path.
    pub fn record_session_activity_by_id(
        &self,
        reverie_session_id: SessionId,
        native_session_id: &str,
        activity: ActivityState,
    ) -> Result<bool> {
        let Some(mut session) = self.repo.get_session(reverie_session_id)? else {
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
        self.repo.upsert_session(&session)?;
        Ok(true)
    }

    pub fn clear_session_activity_by_id(&self, reverie_session_id: SessionId) -> Result<bool> {
        let Some(mut session) = self.repo.get_session(reverie_session_id)? else {
            return Ok(false);
        };
        if session.latest_activity.is_none() {
            return Ok(false);
        }
        session.latest_activity = None;
        self.repo.upsert_session(&session)?;
        Ok(true)
    }

    /// Resolve the adapter for a session and build its terminal spawn spec.
    pub fn build_agent_spawn_spec(
        &self,
        session_id: SessionId,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSpawnSpec> {
        let snapshot = self.repo.load_snapshot()?;
        let session = snapshot
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .with_context(|| format!("unknown Reverie session {session_id}"))?;
        let adapter = built_in_adapters()
            .into_iter()
            .find(|adapter| adapter.kind() == session.agent_kind)
            .with_context(|| {
                format!("no built-in adapter registered for {:?}", session.agent_kind)
            })?;
        let executable_path = require_detected(adapter.as_ref())?;
        build_spawn_spec(
            session,
            snapshot.workspace.default_dangerous_mode,
            cols,
            rows,
            executable_path,
            adapter.as_ref(),
        )
    }

    fn update_session(
        &self,
        session_id: SessionId,
        update: impl FnOnce(&mut Session),
    ) -> Result<WorkspaceSnapshot> {
        let mut session = self
            .repo
            .get_session(session_id)?
            .ok_or_else(|| anyhow!("unknown Reverie session {session_id}"))?;
        update(&mut session);
        self.repo.upsert_session(&session)?;
        Ok(self.repo.load_snapshot()?)
    }

    fn normalize_sessions(&self) -> Result<()> {
        let snapshot = self.repo.load_snapshot()?;
        for mut session in snapshot.sessions {
            if normalize_session(&mut session) {
                self.repo.upsert_session(&session)?;
            }
        }
        Ok(())
    }
}

fn required_text(value: String, label: &'static str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        bail!("{label} is required");
    }
    Ok(trimmed.to_owned())
}

fn optional_text(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn seed_workspace_id() -> WorkspaceId {
    WorkspaceId::parse_str(SEED_WORKSPACE_ID).expect("seed workspace id is a valid uuid")
}

/// Reconcile a single session left in a transient state by an unclean shutdown.
/// Returns whether anything changed. These rules are load-bearing: dropping or
/// reordering them shows wrong session status after a restart.
fn normalize_session(session: &mut Session) -> bool {
    let mut changed = false;

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

    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::InMemoryWorkspaceRepository;

    fn service() -> (Arc<InMemoryWorkspaceRepository>, WorkspaceService) {
        let repo = Arc::new(InMemoryWorkspaceRepository::new());
        let service = WorkspaceService::new(repo.clone());
        service.ensure_seeded().unwrap();
        (repo, service)
    }

    fn make_focus(service: &WorkspaceService) -> FocusId {
        let snapshot = service.create_focus(None, "General".to_owned(), None).unwrap();
        snapshot.focuses[0].id
    }

    #[test]
    fn ensure_seeded_creates_a_stable_workspace() {
        let (_repo, service) = service();
        let snapshot = service.snapshot().unwrap();
        assert_eq!(snapshot.workspace.id, seed_workspace_id());
        assert_eq!(snapshot.workspace.general_label, "General");
    }

    #[test]
    fn create_project_validates_name_and_unique_path() {
        let (_repo, service) = service();
        assert!(service.create_project("  ".to_owned(), "/repo".into()).is_err());
        service.create_project("Reverie".to_owned(), "/repo".into()).unwrap();
        let dup = service.create_project("Other".to_owned(), "/repo".into());
        assert!(dup.is_err(), "duplicate non-archived path must be rejected");
    }

    #[test]
    fn create_focus_assigns_increasing_sort_order_and_checks_project() {
        let (_repo, service) = service();
        let unknown = service.create_focus(Some(ProjectId::new_v4()), "X".to_owned(), None);
        assert!(unknown.is_err());

        service.create_focus(None, "First".to_owned(), None).unwrap();
        let snapshot = service.create_focus(None, "Second".to_owned(), None).unwrap();
        let general: Vec<i64> = snapshot
            .focuses
            .iter()
            .filter(|f| f.project_id.is_none())
            .map(|f| f.sort_order)
            .collect();
        assert_eq!(general, vec![0, 10]);
    }

    #[test]
    fn create_session_requires_known_focus() {
        let (_repo, service) = service();
        let bad = service.create_session(
            FocusId::new_v4(),
            "S".to_owned(),
            AgentKind::CortexCode,
            "/tmp".into(),
            None,
        );
        assert!(bad.is_err());

        let focus = make_focus(&service);
        let snapshot = service
            .create_session(focus, "S".to_owned(), AgentKind::CortexCode, "/tmp".into(), None)
            .unwrap();
        assert_eq!(snapshot.sessions.len(), 1);
        assert!(snapshot.sessions[0].tab_visible);
        assert_eq!(snapshot.sessions[0].status, SessionStatus::NotStarted);
    }

    #[test]
    fn runtime_status_transitions_persist() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let snapshot = service
            .create_session(focus, "S".to_owned(), AgentKind::CortexCode, "/tmp".into(), None)
            .unwrap();
        let id = snapshot.sessions[0].id;

        let running = service.mark_session_running(id).unwrap();
        assert_eq!(running.sessions[0].status, SessionStatus::Running);

        // No native ref attached -> finishing exits cleanly.
        let finished = service.mark_session_finished(id, true).unwrap();
        assert_eq!(finished.sessions[0].status, SessionStatus::Exited);
        assert_eq!(finished.sessions[0].last_exit_code, Some(0));
    }

    #[test]
    fn boot_normalization_demotes_stale_running_and_fixes_resume() {
        let (repo, service) = service();
        let focus = Focus::general("General", 0);
        repo.upsert_focus(&focus).unwrap();

        let mut stale_running =
            Session::new(focus.id, "Running", AgentKind::CortexCode, "/a".into());
        stale_running.status = SessionStatus::Running;
        repo.upsert_session(&stale_running).unwrap();

        let mut resume_without_ref =
            Session::new(focus.id, "Resume", AgentKind::CortexCode, "/b".into());
        resume_without_ref.launch_mode = LaunchMode::Resume;
        repo.upsert_session(&resume_without_ref).unwrap();

        // Re-running ensure_seeded re-normalizes existing sessions.
        service.ensure_seeded().unwrap();
        let snapshot = service.snapshot().unwrap();

        let running = snapshot
            .sessions
            .iter()
            .find(|s| s.id == stale_running.id)
            .unwrap();
        assert_eq!(running.status, SessionStatus::Exited);

        let resume = snapshot
            .sessions
            .iter()
            .find(|s| s.id == resume_without_ref.id)
            .unwrap();
        assert_eq!(resume.launch_mode, LaunchMode::New);
    }

    #[test]
    fn attach_native_session_moves_session_to_restorable() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let snapshot = service
            .create_session(
                focus,
                "Cortex".to_owned(),
                AgentKind::CortexCode,
                "/tmp/reverie".into(),
                None,
            )
            .unwrap();
        let id = snapshot.sessions[0].id;

        service
            .attach_native_session(
                id,
                PathBuf::from("/tmp/reverie"),
                NativeSessionRef::cortex("native-1", None),
                AgentKind::CortexCode,
            )
            .unwrap();

        let session = service.snapshot().unwrap().sessions[0].clone();
        assert_eq!(session.launch_mode, LaunchMode::Resume);
        assert_eq!(session.status, SessionStatus::Restorable);
        assert_eq!(
            session
                .native_session_ref
                .and_then(|r| r.session_id),
            Some("native-1".to_owned())
        );
    }

    #[test]
    fn record_activity_matches_native_id_and_drops_stale_sequence() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let id = service
            .create_session(
                focus,
                "Cortex".to_owned(),
                AgentKind::CortexCode,
                "/tmp/reverie".into(),
                None,
            )
            .unwrap()
            .sessions[0]
            .id;
        service
            .attach_native_session(
                id,
                PathBuf::from("/tmp/reverie"),
                NativeSessionRef::cortex("native-9", None),
                AgentKind::CortexCode,
            )
            .unwrap();

        let state = |seq: u64| {
            crate::activity::parse_state(&format!(
                r#"{{"version":1,"sessionId":"native-9","status":"working","updatedAt":"t","sequence":{seq},"cwd":"/tmp/reverie"}}"#
            ))
            .unwrap()
        };

        assert!(service.record_session_activity("native-9", state(5)).unwrap());
        // Older sequence is dropped.
        assert!(!service.record_session_activity("native-9", state(3)).unwrap());
        // Unknown native id matches nothing.
        assert!(!service.record_session_activity("nope", state(7)).unwrap());

        let session = service.snapshot().unwrap().sessions[0].clone();
        assert_eq!(session.latest_activity.unwrap().sequence, 5);
    }

    #[test]
    fn record_activity_by_id_captures_native_ref_first_time() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let id = service
            .create_session(focus, "Claude".to_owned(), AgentKind::ClaudeCode, "/tmp".into(), None)
            .unwrap()
            .sessions[0]
            .id;

        let state = crate::activity::parse_state(
            r#"{"version":1,"sessionId":"claude-native","status":"working","updatedAt":"t","sequence":1,"cwd":"/tmp"}"#,
        )
        .unwrap();
        assert!(service.record_session_activity_by_id(id, "claude-native", state).unwrap());

        let session = service.snapshot().unwrap().sessions[0].clone();
        assert_eq!(
            session.native_session_ref.and_then(|r| r.session_id),
            Some("claude-native".to_owned())
        );
    }

    #[test]
    fn archive_project_cascade_hides_sessions() {
        let (_repo, service) = service();
        let snapshot = service.create_project("Reverie".to_owned(), "/repo".into()).unwrap();
        let project_id = snapshot.projects[0].id;
        let focus_snapshot = service
            .create_focus(Some(project_id), "Terminal".to_owned(), None)
            .unwrap();
        let focus_id = focus_snapshot
            .focuses
            .iter()
            .find(|f| f.project_id == Some(project_id))
            .unwrap()
            .id;
        let session_id = service
            .create_session(focus_id, "S".to_owned(), AgentKind::CortexCode, "/repo".into(), None)
            .unwrap()
            .sessions[0]
            .id;

        let snapshot = service.archive_project(project_id).unwrap();
        assert!(snapshot.projects.iter().find(|p| p.id == project_id).unwrap().archived);
        assert!(snapshot.focuses.iter().find(|f| f.id == focus_id).unwrap().archived);
        assert!(!snapshot.sessions.iter().find(|s| s.id == session_id).unwrap().tab_visible);
    }
}
