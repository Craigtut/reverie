//! SQLite-backed [`WorkspaceRepository`] for Reverie.
//!
//! This crate owns the only SQLite engine in the workspace. It implements the
//! repository trait from `reverie-core` with incremental, by-id writes: one
//! long-lived connection behind a `Mutex`, real ordered migrations keyed on
//! `PRAGMA user_version`, and per-statement autocommit (multi-row archives run
//! in a transaction). It replaces the previous "rewrite the whole graph on
//! every change" store.
//!
//! Backend errors (`rusqlite`, serde) are flattened into the core
//! [`PersistenceError`] so callers never depend on SQLite.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, params};

use reverie_core::ActivityState;
use reverie_core::domain::{
    AgentKind, Focus, LaunchMode, NativeSessionRef, Project, ProjectId, Session, SessionId,
    SessionStatus, Workspace, WorkspaceId, WorkspaceSnapshot,
};
use reverie_core::repository::{PersistenceError, RepoResult, WorkspaceRepository};

/// Ordered schema migrations. Index `i` migrates `user_version` from `i` to
/// `i + 1`. Never edit a shipped entry; append a new one for each change.
const MIGRATIONS: &[&str] = &[
    // v0 -> v1: initial schema.
    "CREATE TABLE workspace (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        general_label TEXT NOT NULL,
        default_dangerous_mode INTEGER NOT NULL
     );
     CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        archived INTEGER NOT NULL
     );
     CREATE TABLE focuses (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        description TEXT,
        sort_order INTEGER NOT NULL,
        archived INTEGER NOT NULL
     );
     CREATE TABLE sessions (
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
        tab_visible INTEGER NOT NULL DEFAULT 1,
        latest_activity_json TEXT
     );",
];

const SESSION_COLUMNS: &str = "id, focus_id, title, agent_kind, cwd, native_session_ref_json, \
     launch_mode, dangerous_mode_override, status, last_exit_code, tab_visible, latest_activity_json";

pub struct SqliteWorkspaceRepository {
    conn: Mutex<Connection>,
}

impl SqliteWorkspaceRepository {
    /// Open (or create) a database at `path`, apply PRAGMAs and migrations.
    pub fn open(path: impl AsRef<Path>) -> RepoResult<Self> {
        let conn = Connection::open(path.as_ref()).map_err(backend)?;
        Self::from_connection(conn)
    }

    /// In-memory database for tests: same PRAGMAs and migrations, no file.
    pub fn open_in_memory() -> RepoResult<Self> {
        let conn = Connection::open_in_memory().map_err(backend)?;
        Self::from_connection(conn)
    }

    fn from_connection(conn: Connection) -> RepoResult<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .map_err(backend)?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> RepoResult<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| PersistenceError::Backend("sqlite connection lock poisoned".to_owned()))
    }
}

fn migrate(conn: &Connection) -> RepoResult<()> {
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(backend)?;
    let mut current = current as usize;
    while current < MIGRATIONS.len() {
        conn.execute_batch(MIGRATIONS[current]).map_err(backend)?;
        current += 1;
        // PRAGMA values cannot be bound; `current` is a controlled integer.
        conn.execute_batch(&format!("PRAGMA user_version = {current};"))
            .map_err(backend)?;
    }
    Ok(())
}

impl WorkspaceRepository for SqliteWorkspaceRepository {
    fn load_snapshot(&self) -> RepoResult<WorkspaceSnapshot> {
        let conn = self.conn()?;
        Ok(WorkspaceSnapshot {
            workspace: load_workspace(&conn)?,
            projects: load_projects(&conn)?,
            focuses: load_focuses(&conn)?,
            sessions: load_sessions(&conn)?,
        })
    }

    fn ensure_seeded(&self, seed: &Workspace) -> RepoResult<()> {
        let conn = self.conn()?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspace", [], |row| row.get(0))
            .map_err(backend)?;
        if count == 0 {
            conn.execute(
                "INSERT INTO workspace (id, name, general_label, default_dangerous_mode)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    seed.id.to_string(),
                    seed.name,
                    seed.general_label,
                    bool_to_int(seed.default_dangerous_mode),
                ],
            )
            .map_err(backend)?;
        }
        Ok(())
    }

    fn save_workspace(&self, workspace: &Workspace) -> RepoResult<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO workspace (id, name, general_label, default_dangerous_mode)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                general_label = excluded.general_label,
                default_dangerous_mode = excluded.default_dangerous_mode",
            params![
                workspace.id.to_string(),
                workspace.name,
                workspace.general_label,
                bool_to_int(workspace.default_dangerous_mode),
            ],
        )
        .map_err(backend)?;
        Ok(())
    }

    fn upsert_project(&self, project: &Project) -> RepoResult<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO projects (id, name, path, archived) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name, path = excluded.path, archived = excluded.archived",
            params![
                project.id.to_string(),
                project.name,
                path_to_db(&project.path),
                bool_to_int(project.archived),
            ],
        )
        .map_err(backend)?;
        Ok(())
    }

    fn upsert_focus(&self, focus: &Focus) -> RepoResult<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO focuses (id, project_id, title, description, sort_order, archived)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                project_id = excluded.project_id, title = excluded.title,
                description = excluded.description, sort_order = excluded.sort_order,
                archived = excluded.archived",
            params![
                focus.id.to_string(),
                focus.project_id.map(|id| id.to_string()),
                focus.title,
                focus.description,
                focus.sort_order,
                bool_to_int(focus.archived),
            ],
        )
        .map_err(backend)?;
        Ok(())
    }

    fn upsert_session(&self, session: &Session) -> RepoResult<()> {
        let native_session_ref_json = native_session_ref_to_db(&session.native_session_ref)?;
        let latest_activity_json = match &session.latest_activity {
            Some(state) => Some(
                serde_json::to_string(state)
                    .map_err(|err| PersistenceError::Serialization(err.to_string()))?,
            ),
            None => None,
        };
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO sessions (
                id, focus_id, title, agent_kind, cwd, native_session_ref_json, launch_mode,
                dangerous_mode_override, status, last_exit_code, tab_visible, latest_activity_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                focus_id = excluded.focus_id, title = excluded.title,
                agent_kind = excluded.agent_kind, cwd = excluded.cwd,
                native_session_ref_json = excluded.native_session_ref_json,
                launch_mode = excluded.launch_mode,
                dangerous_mode_override = excluded.dangerous_mode_override,
                status = excluded.status, last_exit_code = excluded.last_exit_code,
                tab_visible = excluded.tab_visible,
                latest_activity_json = excluded.latest_activity_json",
            params![
                session.id.to_string(),
                session.focus_id.to_string(),
                session.title,
                agent_kind_to_db(session.agent_kind)?,
                path_to_db(&session.cwd),
                native_session_ref_json,
                launch_mode_to_db(session.launch_mode)?,
                session.dangerous_mode_override.map(bool_to_int),
                session_status_to_db(session.status)?,
                session.last_exit_code,
                bool_to_int(session.tab_visible),
                latest_activity_json,
            ],
        )
        .map_err(backend)?;
        Ok(())
    }

    fn delete_session(&self, id: SessionId) -> RepoResult<()> {
        let conn = self.conn()?;
        let changed = conn
            .execute("DELETE FROM sessions WHERE id = ?1", params![id.to_string()])
            .map_err(backend)?;
        if changed == 0 {
            return Err(PersistenceError::NotFound {
                kind: "session",
                id: id.to_string(),
            });
        }
        Ok(())
    }

    fn get_session(&self, id: SessionId) -> RepoResult<Option<Session>> {
        let conn = self.conn()?;
        let query = format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE id = ?1");
        match conn.query_row(&query, params![id.to_string()], read_session) {
            Ok(session) => Ok(Some(session)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(other) => Err(backend(other)),
        }
    }

    fn find_session_by_native_id(&self, native_session_id: &str) -> RepoResult<Option<Session>> {
        let conn = self.conn()?;
        let sessions = load_sessions(&conn)?;
        Ok(sessions.into_iter().find(|session| {
            session
                .native_session_ref
                .as_ref()
                .and_then(|reference| reference.session_id.as_deref())
                == Some(native_session_id)
        }))
    }

    fn archive_project_cascade(&self, id: ProjectId) -> RepoResult<()> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(backend)?;
        let changed = tx
            .execute(
                "UPDATE projects SET archived = 1 WHERE id = ?1",
                params![id.to_string()],
            )
            .map_err(backend)?;
        if changed == 0 {
            return Err(PersistenceError::NotFound {
                kind: "project",
                id: id.to_string(),
            });
        }
        tx.execute(
            "UPDATE focuses SET archived = 1 WHERE project_id = ?1",
            params![id.to_string()],
        )
        .map_err(backend)?;
        tx.execute(
            "UPDATE sessions SET tab_visible = 0
             WHERE focus_id IN (SELECT id FROM focuses WHERE project_id = ?1)",
            params![id.to_string()],
        )
        .map_err(backend)?;
        tx.commit().map_err(backend)?;
        Ok(())
    }

    fn archive_focus_cascade(&self, id: reverie_core::domain::FocusId) -> RepoResult<()> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(backend)?;
        let changed = tx
            .execute(
                "UPDATE focuses SET archived = 1 WHERE id = ?1",
                params![id.to_string()],
            )
            .map_err(backend)?;
        if changed == 0 {
            return Err(PersistenceError::NotFound {
                kind: "focus",
                id: id.to_string(),
            });
        }
        tx.execute(
            "UPDATE sessions SET tab_visible = 0 WHERE focus_id = ?1",
            params![id.to_string()],
        )
        .map_err(backend)?;
        tx.commit().map_err(backend)?;
        Ok(())
    }
}

fn load_workspace(conn: &Connection) -> RepoResult<Workspace> {
    conn.query_row(
        "SELECT id, name, general_label, default_dangerous_mode FROM workspace LIMIT 1",
        [],
        |row| {
            Ok(Workspace {
                id: parse_uuid_row(row.get::<_, String>(0)?)?,
                name: row.get(1)?,
                general_label: row.get(2)?,
                default_dangerous_mode: int_to_bool(row.get::<_, i64>(3)?),
            })
        },
    )
    .map_err(|err| match err {
        rusqlite::Error::QueryReturnedNoRows => {
            PersistenceError::Backend("workspace has not been seeded".to_owned())
        }
        other => backend(other),
    })
}

fn load_projects(conn: &Connection) -> RepoResult<Vec<Project>> {
    let mut statement = conn
        .prepare("SELECT id, name, path, archived FROM projects ORDER BY name COLLATE NOCASE")
        .map_err(backend)?;
    let rows = statement
        .query_map([], |row| {
            Ok(Project {
                id: parse_uuid_row(row.get::<_, String>(0)?)?,
                name: row.get(1)?,
                path: PathBuf::from(row.get::<_, String>(2)?),
                archived: int_to_bool(row.get::<_, i64>(3)?),
            })
        })
        .map_err(backend)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(backend)
}

fn load_focuses(conn: &Connection) -> RepoResult<Vec<Focus>> {
    let mut statement = conn
        .prepare(
            "SELECT id, project_id, title, description, sort_order, archived
             FROM focuses
             ORDER BY COALESCE(project_id, ''), sort_order, title COLLATE NOCASE",
        )
        .map_err(backend)?;
    let rows = statement
        .query_map([], |row| {
            let project_id = row
                .get::<_, Option<String>>(1)?
                .map(parse_uuid_row)
                .transpose()?;
            Ok(Focus {
                id: parse_uuid_row(row.get::<_, String>(0)?)?,
                project_id,
                title: row.get(2)?,
                description: row.get(3)?,
                sort_order: row.get(4)?,
                archived: int_to_bool(row.get::<_, i64>(5)?),
            })
        })
        .map_err(backend)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(backend)
}

fn load_sessions(conn: &Connection) -> RepoResult<Vec<Session>> {
    let query = format!("SELECT {SESSION_COLUMNS} FROM sessions ORDER BY rowid");
    let mut statement = conn.prepare(&query).map_err(backend)?;
    let rows = statement.query_map([], read_session).map_err(backend)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(backend)
}

fn read_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: parse_uuid_row(row.get::<_, String>(0)?)?,
        focus_id: parse_uuid_row(row.get::<_, String>(1)?)?,
        title: row.get(2)?,
        agent_kind: agent_kind_from_db(&row.get::<_, String>(3)?)?,
        cwd: PathBuf::from(row.get::<_, String>(4)?),
        native_session_ref: native_session_ref_from_db(row.get::<_, Option<String>>(5)?)?,
        launch_mode: launch_mode_from_db(&row.get::<_, String>(6)?)?,
        dangerous_mode_override: row.get::<_, Option<i64>>(7)?.map(int_to_bool),
        status: session_status_from_db(&row.get::<_, String>(8)?)?,
        last_exit_code: row.get(9)?,
        tab_visible: int_to_bool(row.get::<_, i64>(10)?),
        latest_activity: activity_state_from_db(row.get::<_, Option<String>>(11)?)?,
    })
}

fn backend(err: rusqlite::Error) -> PersistenceError {
    PersistenceError::Backend(err.to_string())
}

fn conversion_failure(err: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(err))
}

fn parse_uuid_row(value: String) -> rusqlite::Result<WorkspaceId> {
    WorkspaceId::parse_str(&value).map_err(conversion_failure)
}

fn agent_kind_to_db(value: AgentKind) -> RepoResult<String> {
    string_enum(serde_json::to_value(value), "agent kind")
}

fn agent_kind_from_db(value: &str) -> rusqlite::Result<AgentKind> {
    serde_json::from_value(serde_json::Value::String(value.to_owned())).map_err(conversion_failure)
}

fn launch_mode_to_db(value: LaunchMode) -> RepoResult<String> {
    string_enum(serde_json::to_value(value), "launch mode")
}

fn launch_mode_from_db(value: &str) -> rusqlite::Result<LaunchMode> {
    serde_json::from_value(serde_json::Value::String(value.to_owned())).map_err(conversion_failure)
}

fn session_status_to_db(value: SessionStatus) -> RepoResult<String> {
    string_enum(serde_json::to_value(value), "session status")
}

fn session_status_from_db(value: &str) -> rusqlite::Result<SessionStatus> {
    serde_json::from_value(serde_json::Value::String(value.to_owned())).map_err(conversion_failure)
}

fn string_enum(
    encoded: Result<serde_json::Value, serde_json::Error>,
    label: &'static str,
) -> RepoResult<String> {
    match encoded {
        Ok(serde_json::Value::String(value)) => Ok(value),
        Ok(_) => Err(PersistenceError::Serialization(format!(
            "{label} did not encode as a string"
        ))),
        Err(err) => Err(PersistenceError::Serialization(err.to_string())),
    }
}

fn native_session_ref_to_db(value: &Option<NativeSessionRef>) -> RepoResult<Option<String>> {
    match value {
        Some(reference) => serde_json::to_string(reference)
            .map(Some)
            .map_err(|err| PersistenceError::Serialization(err.to_string())),
        None => Ok(None),
    }
}

fn native_session_ref_from_db(
    value: Option<String>,
) -> rusqlite::Result<Option<NativeSessionRef>> {
    match value {
        Some(encoded) => serde_json::from_str(&encoded).map(Some).map_err(conversion_failure),
        None => Ok(None),
    }
}

fn activity_state_from_db(value: Option<String>) -> rusqlite::Result<Option<ActivityState>> {
    match value {
        Some(text) if !text.is_empty() => {
            serde_json::from_str::<ActivityState>(&text).map(Some).map_err(conversion_failure)
        }
        _ => Ok(None),
    }
}

fn path_to_db(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn bool_to_int(value: bool) -> i64 {
    i64::from(value)
}

fn int_to_bool(value: i64) -> bool {
    value != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> SqliteWorkspaceRepository {
        let repo = SqliteWorkspaceRepository::open_in_memory().unwrap();
        repo.ensure_seeded(&Workspace::new("Local workspace", "General"))
            .unwrap();
        repo
    }

    #[test]
    fn migrations_set_user_version() {
        let repo = SqliteWorkspaceRepository::open_in_memory().unwrap();
        let conn = repo.conn().unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version as usize, MIGRATIONS.len());
    }

    #[test]
    fn load_snapshot_errors_before_seeding() {
        let repo = SqliteWorkspaceRepository::open_in_memory().unwrap();
        assert!(repo.load_snapshot().is_err());
    }

    #[test]
    fn ensure_seeded_is_idempotent() {
        let repo = seeded();
        let first = repo.load_snapshot().unwrap().workspace.id;
        repo.ensure_seeded(&Workspace::new("Other", "General")).unwrap();
        assert_eq!(repo.load_snapshot().unwrap().workspace.id, first);
    }

    #[test]
    fn project_focus_session_round_trip_with_ordering() {
        let repo = seeded();
        repo.upsert_project(&Project::new("Zeta", PathBuf::from("/z"))).unwrap();
        repo.upsert_project(&Project::new("alpha", PathBuf::from("/a"))).unwrap();
        let focus = Focus::general("General", 0);
        repo.upsert_focus(&focus).unwrap();
        let session =
            Session::new(focus.id, "S", AgentKind::CortexCode, PathBuf::from("/repo"));
        repo.upsert_session(&session).unwrap();

        let snapshot = repo.load_snapshot().unwrap();
        // Projects come back name-sorted, case-insensitive.
        assert_eq!(
            snapshot.projects.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            vec!["alpha", "Zeta"]
        );
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].id, session.id);
        assert!(snapshot.sessions[0].tab_visible);
    }

    #[test]
    fn session_json_columns_round_trip() {
        let repo = seeded();
        let focus = Focus::general("General", 0);
        repo.upsert_focus(&focus).unwrap();
        let mut session =
            Session::new(focus.id, "Cortex", AgentKind::CortexCode, PathBuf::from("/repo"));
        session.native_session_ref = Some(NativeSessionRef::cortex("native-42", None));
        session.launch_mode = LaunchMode::Resume;
        session.status = SessionStatus::Restorable;
        session.latest_activity = Some(
            reverie_core::activity::parse_state(
                r#"{"version":1,"sessionId":"native-42","status":"working","updatedAt":"t","sequence":4,"cwd":"/repo"}"#,
            )
            .unwrap(),
        );
        repo.upsert_session(&session).unwrap();

        let loaded = repo.get_session(session.id).unwrap().unwrap();
        assert_eq!(loaded.launch_mode, LaunchMode::Resume);
        assert_eq!(loaded.status, SessionStatus::Restorable);
        assert_eq!(
            loaded.native_session_ref.and_then(|r| r.session_id),
            Some("native-42".to_owned())
        );
        assert_eq!(loaded.latest_activity.unwrap().sequence, 4);

        let by_native = repo.find_session_by_native_id("native-42").unwrap();
        assert_eq!(by_native.map(|s| s.id), Some(session.id));
    }

    #[test]
    fn upsert_session_updates_in_place() {
        let repo = seeded();
        let focus = Focus::general("General", 0);
        repo.upsert_focus(&focus).unwrap();
        let mut session =
            Session::new(focus.id, "Before", AgentKind::CortexCode, PathBuf::from("/repo"));
        repo.upsert_session(&session).unwrap();
        session.title = "After".to_owned();
        repo.upsert_session(&session).unwrap();

        let snapshot = repo.load_snapshot().unwrap();
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].title, "After");
    }

    #[test]
    fn delete_session_reports_not_found() {
        let repo = seeded();
        let err = repo.delete_session(SessionId::new_v4()).unwrap_err();
        assert!(matches!(err, PersistenceError::NotFound { kind: "session", .. }));
    }

    #[test]
    fn archive_project_cascade_hides_sessions_atomically() {
        let repo = seeded();
        let project = Project::new("Reverie", PathBuf::from("/repo"));
        repo.upsert_project(&project).unwrap();
        let focus = Focus::for_project(project.id, "Terminal", 10);
        repo.upsert_focus(&focus).unwrap();
        let session =
            Session::new(focus.id, "S", AgentKind::CortexCode, PathBuf::from("/repo"));
        repo.upsert_session(&session).unwrap();

        repo.archive_project_cascade(project.id).unwrap();

        let snapshot = repo.load_snapshot().unwrap();
        assert!(snapshot.projects[0].archived);
        assert!(snapshot.focuses[0].archived);
        assert!(!snapshot.sessions[0].tab_visible);
    }

    #[test]
    fn archive_project_cascade_reports_not_found() {
        let repo = seeded();
        let err = repo.archive_project_cascade(ProjectId::new_v4()).unwrap_err();
        assert!(matches!(err, PersistenceError::NotFound { kind: "project", .. }));
    }

    #[test]
    fn save_workspace_updates_dangerous_mode() {
        let repo = seeded();
        let mut workspace = repo.load_snapshot().unwrap().workspace;
        workspace.default_dangerous_mode = true;
        repo.save_workspace(&workspace).unwrap();
        assert!(repo.load_snapshot().unwrap().workspace.default_dangerous_mode);
    }
}
