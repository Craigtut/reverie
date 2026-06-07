//! Storage boundary for Reverie's workspace model.
//!
//! [`WorkspaceRepository`] is the seam between the domain/service layer and
//! whichever store backs it. The SQLite implementation lives in the
//! `reverie-persistence` crate; [`InMemoryWorkspaceRepository`] here backs the
//! service's unit tests (and any future headless/harness use) without a real
//! database, mirroring the frontend's fixture-runtime pattern.
//!
//! The trait is incremental and by-id: callers mutate one entity at a time and
//! read the whole [`WorkspaceSnapshot`] when they need it. There is
//! deliberately no bulk `save_snapshot`; rewriting the entire graph on every
//! mutation was the previous design's central flaw.

use std::sync::Mutex;

use crate::domain::{
    Focus, FocusId, NativeSessionRef, Project, ProjectId, Session, SessionId, Workspace,
    WorkspaceSnapshot,
};

/// Errors surfaced by a [`WorkspaceRepository`]. Backend-specific failures
/// (SQLite, serde) are flattened into [`PersistenceError::Backend`] /
/// [`PersistenceError::Serialization`] so this trait, and the service above it,
/// never depend on a concrete storage engine.
#[derive(Debug, thiserror::Error)]
pub enum PersistenceError {
    #[error("{kind} {id} not found")]
    NotFound { kind: &'static str, id: String },
    #[error("persistence backend error: {0}")]
    Backend(String),
    #[error("persistence serialization error: {0}")]
    Serialization(String),
}

pub type RepoResult<T> = Result<T, PersistenceError>;

/// Incremental, by-id persistence of the workspace graph. Implementations must
/// be `Send + Sync` so the service can be shared as Tauri managed state.
pub trait WorkspaceRepository: Send + Sync {
    /// Load the full workspace graph. Errors if the store has never been
    /// seeded with a workspace row.
    fn load_snapshot(&self) -> RepoResult<WorkspaceSnapshot>;

    /// Insert the given workspace row iff no workspace exists yet. A no-op when
    /// one is already present, so first-run seeding is idempotent.
    fn ensure_seeded(&self, seed: &Workspace) -> RepoResult<()>;

    /// Replace the persisted workspace row (e.g. the dangerous-mode default).
    fn save_workspace(&self, workspace: &Workspace) -> RepoResult<()>;

    fn upsert_project(&self, project: &Project) -> RepoResult<()>;
    fn upsert_focus(&self, focus: &Focus) -> RepoResult<()>;
    fn upsert_session(&self, session: &Session) -> RepoResult<()>;

    /// Hard-delete a session row. Errors [`PersistenceError::NotFound`] when no
    /// such session exists.
    fn delete_session(&self, id: SessionId) -> RepoResult<()>;

    fn get_session(&self, id: SessionId) -> RepoResult<Option<Session>>;

    /// Find the session whose attached native session id matches, if any.
    fn find_session_by_native_id(&self, native_session_id: &str) -> RepoResult<Option<Session>>;

    /// Attach a native session ref to `session_id` only if no different session
    /// owns that native id. Returns `false` on a cross-session collision.
    fn claim_native_session(
        &self,
        session_id: SessionId,
        native_session_ref: NativeSessionRef,
    ) -> RepoResult<bool>;

    /// Set a project's own archived bit. Its focuses and sessions are not
    /// touched: they are hidden (or revealed) by walking ancestry, so restoring
    /// the project brings everything back exactly as it was, with any
    /// individually-archived descendant correctly staying archived. Errors
    /// NotFound if the project is unknown.
    fn set_project_archived(&self, id: ProjectId, archived: bool) -> RepoResult<()>;

    /// Set a focus's own archived bit. Its sessions are not touched (see
    /// [`Self::set_project_archived`]). Errors NotFound if the focus is unknown.
    fn set_focus_archived(&self, id: FocusId, archived: bool) -> RepoResult<()>;

    /// Permanently delete a project together with its focuses and their
    /// sessions, atomically. Errors NotFound if the project is unknown.
    fn delete_project_cascade(&self, id: ProjectId) -> RepoResult<()>;

    /// Permanently delete a focus together with its sessions, atomically. Errors
    /// NotFound if the focus is unknown.
    fn delete_focus_cascade(&self, id: FocusId) -> RepoResult<()>;
}

#[derive(Default)]
struct InMemoryState {
    workspace: Option<Workspace>,
    projects: Vec<Project>,
    focuses: Vec<Focus>,
    sessions: Vec<Session>,
}

/// In-memory [`WorkspaceRepository`] for tests and headless use. Not persisted;
/// every instance starts empty until [`WorkspaceRepository::ensure_seeded`].
/// Read ordering mirrors the SQLite backend so service tests see the same shape.
#[derive(Default)]
pub struct InMemoryWorkspaceRepository {
    state: Mutex<InMemoryState>,
}

impl InMemoryWorkspaceRepository {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> RepoResult<std::sync::MutexGuard<'_, InMemoryState>> {
        self.state
            .lock()
            .map_err(|_| PersistenceError::Backend("in-memory repository lock poisoned".to_owned()))
    }
}

impl WorkspaceRepository for InMemoryWorkspaceRepository {
    fn load_snapshot(&self) -> RepoResult<WorkspaceSnapshot> {
        let state = self.lock()?;
        let workspace = state
            .workspace
            .clone()
            .ok_or_else(|| PersistenceError::Backend("workspace has not been seeded".to_owned()))?;

        let mut projects = state.projects.clone();
        projects.sort_by(|a, b| {
            a.sort_order
                .cmp(&b.sort_order)
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        let mut focuses = state.focuses.clone();
        focuses.sort_by(|a, b| {
            let a_key = a.project_id.map(|id| id.to_string()).unwrap_or_default();
            let b_key = b.project_id.map(|id| id.to_string()).unwrap_or_default();
            a_key
                .cmp(&b_key)
                .then(a.sort_order.cmp(&b.sort_order))
                .then(a.title.to_lowercase().cmp(&b.title.to_lowercase()))
        });

        // Stable sort by sort_order keeps insertion order (the old SQLite
        // `ORDER BY rowid` behavior) for the many sessions that share the
        // default 0, while reordered sessions take their assigned slots.
        let mut sessions = state.sessions.clone();
        sessions.sort_by(|a, b| a.sort_order.cmp(&b.sort_order));

        Ok(WorkspaceSnapshot {
            workspace,
            projects,
            focuses,
            sessions,
        })
    }

    fn ensure_seeded(&self, seed: &Workspace) -> RepoResult<()> {
        let mut state = self.lock()?;
        if state.workspace.is_none() {
            state.workspace = Some(seed.clone());
        }
        Ok(())
    }

    fn save_workspace(&self, workspace: &Workspace) -> RepoResult<()> {
        let mut state = self.lock()?;
        state.workspace = Some(workspace.clone());
        Ok(())
    }

    fn upsert_project(&self, project: &Project) -> RepoResult<()> {
        let mut state = self.lock()?;
        match state.projects.iter_mut().find(|p| p.id == project.id) {
            Some(existing) => *existing = project.clone(),
            None => state.projects.push(project.clone()),
        }
        Ok(())
    }

    fn upsert_focus(&self, focus: &Focus) -> RepoResult<()> {
        let mut state = self.lock()?;
        match state.focuses.iter_mut().find(|f| f.id == focus.id) {
            Some(existing) => *existing = focus.clone(),
            None => state.focuses.push(focus.clone()),
        }
        Ok(())
    }

    fn upsert_session(&self, session: &Session) -> RepoResult<()> {
        let mut state = self.lock()?;
        match state.sessions.iter_mut().find(|s| s.id == session.id) {
            Some(existing) => *existing = session.clone(),
            None => state.sessions.push(session.clone()),
        }
        Ok(())
    }

    fn delete_session(&self, id: SessionId) -> RepoResult<()> {
        let mut state = self.lock()?;
        let before = state.sessions.len();
        state.sessions.retain(|s| s.id != id);
        if state.sessions.len() == before {
            return Err(PersistenceError::NotFound {
                kind: "session",
                id: id.to_string(),
            });
        }
        Ok(())
    }

    fn get_session(&self, id: SessionId) -> RepoResult<Option<Session>> {
        let state = self.lock()?;
        Ok(state.sessions.iter().find(|s| s.id == id).cloned())
    }

    fn find_session_by_native_id(&self, native_session_id: &str) -> RepoResult<Option<Session>> {
        let state = self.lock()?;
        Ok(state
            .sessions
            .iter()
            .find(|s| {
                s.native_session_ref
                    .as_ref()
                    .and_then(|reference| reference.session_id.as_deref())
                    == Some(native_session_id)
            })
            .cloned())
    }

    fn claim_native_session(
        &self,
        session_id: SessionId,
        native_session_ref: NativeSessionRef,
    ) -> RepoResult<bool> {
        let mut state = self.lock()?;
        let native_session_id = native_session_ref.session_id.as_deref();
        if let Some(native_session_id) = native_session_id {
            if state.sessions.iter().any(|session| {
                session.id != session_id
                    && session
                        .native_session_ref
                        .as_ref()
                        .and_then(|reference| reference.session_id.as_deref())
                        == Some(native_session_id)
            }) {
                return Ok(false);
            }
        }
        let Some(session) = state
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
        else {
            return Err(PersistenceError::NotFound {
                kind: "session",
                id: session_id.to_string(),
            });
        };
        session.native_session_ref = Some(native_session_ref);
        session.launch_mode = crate::domain::LaunchMode::Resume;
        if session.status != crate::domain::SessionStatus::Running {
            session.status = crate::domain::SessionStatus::Restorable;
        }
        Ok(true)
    }

    fn set_project_archived(&self, id: ProjectId, archived: bool) -> RepoResult<()> {
        let mut state = self.lock()?;
        let Some(project) = state.projects.iter_mut().find(|p| p.id == id) else {
            return Err(PersistenceError::NotFound {
                kind: "project",
                id: id.to_string(),
            });
        };
        project.archived = archived;
        Ok(())
    }

    fn set_focus_archived(&self, id: FocusId, archived: bool) -> RepoResult<()> {
        let mut state = self.lock()?;
        let Some(focus) = state.focuses.iter_mut().find(|focus| focus.id == id) else {
            return Err(PersistenceError::NotFound {
                kind: "focus",
                id: id.to_string(),
            });
        };
        focus.archived = archived;
        Ok(())
    }

    fn delete_project_cascade(&self, id: ProjectId) -> RepoResult<()> {
        let mut state = self.lock()?;
        if !state.projects.iter().any(|project| project.id == id) {
            return Err(PersistenceError::NotFound {
                kind: "project",
                id: id.to_string(),
            });
        }
        let focus_ids: Vec<FocusId> = state
            .focuses
            .iter()
            .filter(|focus| focus.project_id == Some(id))
            .map(|focus| focus.id)
            .collect();
        state
            .sessions
            .retain(|session| !focus_ids.contains(&session.focus_id));
        state.focuses.retain(|focus| focus.project_id != Some(id));
        state.projects.retain(|project| project.id != id);
        Ok(())
    }

    fn delete_focus_cascade(&self, id: FocusId) -> RepoResult<()> {
        let mut state = self.lock()?;
        if !state.focuses.iter().any(|focus| focus.id == id) {
            return Err(PersistenceError::NotFound {
                kind: "focus",
                id: id.to_string(),
            });
        }
        state.sessions.retain(|session| session.focus_id != id);
        state.focuses.retain(|focus| focus.id != id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{AgentKind, Session};
    use std::path::PathBuf;

    fn seeded() -> InMemoryWorkspaceRepository {
        let repo = InMemoryWorkspaceRepository::new();
        repo.ensure_seeded(&Workspace::new("Local workspace", "General"))
            .unwrap();
        repo
    }

    #[test]
    fn load_snapshot_errors_before_seeding() {
        let repo = InMemoryWorkspaceRepository::new();
        assert!(repo.load_snapshot().is_err());
    }

    #[test]
    fn ensure_seeded_is_idempotent() {
        let repo = seeded();
        let first = repo.load_snapshot().unwrap().workspace.id;
        repo.ensure_seeded(&Workspace::new("Other", "General"))
            .unwrap();
        let second = repo.load_snapshot().unwrap().workspace.id;
        assert_eq!(first, second, "second seed must not replace the workspace");
    }

    #[test]
    fn upsert_session_replaces_in_place_preserving_order() {
        let repo = seeded();
        let focus = Focus::general("General", 0);
        repo.upsert_focus(&focus).unwrap();
        let mut a = Session::new(focus.id, "A", AgentKind::CortexCode, PathBuf::from("/a"));
        let b = Session::new(focus.id, "B", AgentKind::CortexCode, PathBuf::from("/b"));
        repo.upsert_session(&a).unwrap();
        repo.upsert_session(&b).unwrap();
        a.title = "A-renamed".to_owned();
        repo.upsert_session(&a).unwrap();

        let sessions = repo.load_snapshot().unwrap().sessions;
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].title, "A-renamed");
        assert_eq!(sessions[1].title, "B");
    }

    #[test]
    fn delete_session_reports_not_found() {
        let repo = seeded();
        let err = repo.delete_session(SessionId::new_v4()).unwrap_err();
        assert!(matches!(
            err,
            PersistenceError::NotFound {
                kind: "session",
                ..
            }
        ));
    }

    #[test]
    fn find_session_by_native_id_matches_attached_ref() {
        let repo = seeded();
        let focus = Focus::general("General", 0);
        repo.upsert_focus(&focus).unwrap();
        let mut session = Session::new(
            focus.id,
            "Cortex",
            AgentKind::CortexCode,
            PathBuf::from("/c"),
        );
        session.mark_restorable(crate::domain::NativeSessionRef::cortex("native-7", None));
        repo.upsert_session(&session).unwrap();

        let found = repo.find_session_by_native_id("native-7").unwrap();
        assert_eq!(found.map(|s| s.id), Some(session.id));
        assert!(repo.find_session_by_native_id("missing").unwrap().is_none());
    }

    #[test]
    fn claim_native_session_rejects_cross_session_collision() {
        let repo = seeded();
        let focus = Focus::general("General", 0);
        repo.upsert_focus(&focus).unwrap();
        let a = Session::new(focus.id, "A", AgentKind::CortexCode, PathBuf::from("/repo"));
        let b = Session::new(focus.id, "B", AgentKind::CortexCode, PathBuf::from("/repo"));
        repo.upsert_session(&a).unwrap();
        repo.upsert_session(&b).unwrap();

        assert!(
            repo.claim_native_session(
                a.id,
                crate::domain::NativeSessionRef::cortex("native-7", None),
            )
            .unwrap()
        );
        assert!(
            !repo
                .claim_native_session(
                    b.id,
                    crate::domain::NativeSessionRef::cortex("native-7", None),
                )
                .unwrap()
        );
        assert!(
            repo.claim_native_session(
                a.id,
                crate::domain::NativeSessionRef::cortex("native-8", None),
            )
            .unwrap()
        );
        let found = repo.find_session_by_native_id("native-8").unwrap();
        assert_eq!(found.map(|session| session.id), Some(a.id));
    }

    #[test]
    fn set_project_archived_flips_only_the_projects_own_bit() {
        let repo = seeded();
        let project = Project::new("Reverie", PathBuf::from("/repo"));
        repo.upsert_project(&project).unwrap();
        let focus = Focus::for_project(project.id, "Terminal", 10);
        repo.upsert_focus(&focus).unwrap();
        let session = Session::new(focus.id, "S", AgentKind::CortexCode, PathBuf::from("/repo"));
        repo.upsert_session(&session).unwrap();

        repo.set_project_archived(project.id, true).unwrap();

        // Only the project carries the bit; descendants are hidden by ancestry,
        // not by writes, so restoring the project brings them back untouched.
        let snapshot = repo.load_snapshot().unwrap();
        assert!(snapshot.projects[0].archived);
        assert!(!snapshot.focuses[0].archived);
        assert!(!snapshot.sessions[0].archived);

        repo.set_project_archived(project.id, false).unwrap();
        assert!(!repo.load_snapshot().unwrap().projects[0].archived);
    }

    #[test]
    fn delete_project_cascade_removes_focuses_and_sessions() {
        let repo = seeded();
        let project = Project::new("Reverie", PathBuf::from("/repo"));
        repo.upsert_project(&project).unwrap();
        let focus = Focus::for_project(project.id, "Terminal", 10);
        repo.upsert_focus(&focus).unwrap();
        let session = Session::new(focus.id, "S", AgentKind::CortexCode, PathBuf::from("/repo"));
        repo.upsert_session(&session).unwrap();

        repo.delete_project_cascade(project.id).unwrap();

        let snapshot = repo.load_snapshot().unwrap();
        assert!(snapshot.projects.is_empty());
        assert!(snapshot.focuses.is_empty());
        assert!(snapshot.sessions.is_empty());
    }

    #[test]
    fn set_project_archived_reports_not_found() {
        let repo = seeded();
        let err = repo
            .set_project_archived(ProjectId::new_v4(), true)
            .unwrap_err();
        assert!(matches!(
            err,
            PersistenceError::NotFound {
                kind: "project",
                ..
            }
        ));
    }
}
