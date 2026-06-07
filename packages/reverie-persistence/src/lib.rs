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
use reverie_core::connection::{
    Connection as DomainConnection, ConnectionId, ConnectionMessage, MessageId,
};
use reverie_core::connection_repository::ConnectionRepository;
use reverie_core::domain::{
    AgentKind, Focus, LaunchMode, NativeSessionRef, Project, ProjectId, Session, SessionId,
    SessionStatus, ThemeMode, Workspace, WorkspaceId, WorkspaceSnapshot,
};
use reverie_core::repository::{PersistenceError, RepoResult, WorkspaceRepository};

/// Ordered schema migrations. Index `i` migrates `user_version` from `i` to
/// `i + 1`. Never edit a shipped entry; append a new one for each change.
const MIGRATIONS: &[&str] = &[
    // v0 -> v1: initial schema. Uses IF NOT EXISTS so a database created by the
    // pre-migration-system code (which never set user_version, so it reads as 0
    // here) is adopted in place rather than erroring on a re-create.
    "CREATE TABLE IF NOT EXISTS workspace (
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
        tab_visible INTEGER NOT NULL DEFAULT 1,
        latest_activity_json TEXT
     );",
    // v1 -> v2: inter-agent connections. See
    // docs/technical/inter-agent-connections.md for the contract. We
    // serialise the polymorphic enum-shaped fields (initiator, closed_by,
    // pending_request) as JSON so connection.rs stays the single source of
    // truth for the wire shape.
    "CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        participant_a TEXT NOT NULL,
        participant_b TEXT NOT NULL,
        initiator_json TEXT NOT NULL,
        status TEXT NOT NULL,
        reason_opened TEXT NOT NULL,
        policy_at_open TEXT NOT NULL,
        topic TEXT,
        created_at TEXT NOT NULL,
        accepted_at TEXT,
        closed_at TEXT,
        closed_by_json TEXT,
        reason_closed TEXT,
        pending_request_json TEXT,
        sequence INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_connections_participant_a ON connections(participant_a);
     CREATE INDEX IF NOT EXISTS idx_connections_participant_b ON connections(participant_b);
     CREATE TABLE IF NOT EXISTS connection_messages (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        from_session TEXT NOT NULL,
        to_session TEXT NOT NULL,
        body TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        delivered_at TEXT,
        sequence INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_connection_messages_conn_seq
        ON connection_messages(connection_id, sequence);",
    // v2 -> v3: per-CLI enablement. The user can switch individual agent CLIs
    // off in settings; we persist the disabled set as a JSON array of the
    // snake_case agent-kind wire strings. Absence (the default) means every
    // detected CLI is enabled, so existing workspaces upgrade with no change
    // in behavior.
    "ALTER TABLE workspace ADD COLUMN disabled_agent_kinds TEXT NOT NULL DEFAULT '[]';",
    // v3 -> v4: durable per-session terminal transcript. An append-only log of
    // the raw PTY byte stream, the source of truth behind full-history
    // scrollback + search. One row per batched chunk; `byte_offset` is the
    // cumulative byte position so a range can be read across chunk boundaries.
    "CREATE TABLE IF NOT EXISTS session_transcript_chunk (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        byte_offset INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY (session_id, seq)
     );
     CREATE INDEX IF NOT EXISTS idx_session_transcript_chunk_offset
        ON session_transcript_chunk(session_id, byte_offset);",
    // v4 -> v5: per-session archive flag. Closing a session archives it: it
    // leaves the Home dashboard and the sidebar focus lists for the focus's
    // archived list, restorable anytime. Defaults to 0 so existing sessions
    // surface as active (non-archived) after upgrade.
    "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;",
    // v5 -> v6: a separate "default YOLO for new sessions" workspace flag.
    // Retired: it duplicated default_dangerous_mode (the single workspace
    // auto-approve default) and only ever seeded the composer's initial value,
    // so the settings toggle now reads/writes default_dangerous_mode directly
    // and the domain no longer maps this column. The migration stays (never edit
    // a shipped entry); the column lives on dormant. Defaults to 0.
    "ALTER TABLE workspace ADD COLUMN default_new_session_dangerous INTEGER NOT NULL DEFAULT 0;",
    // v6 -> v7: persisted workspace appearance and default new-session agent.
    // `theme` stores the light/dark wire string the renderer seeds on load;
    // `default_agent_kind` seeds the new-session composer's agent picker. Both
    // get safe defaults so existing workspaces upgrade unchanged.
    "ALTER TABLE workspace ADD COLUMN theme TEXT NOT NULL DEFAULT 'dark';
     ALTER TABLE workspace ADD COLUMN default_agent_kind TEXT NOT NULL DEFAULT 'cortex_code';",
    // v7 -> v8: per-focus default dangerous (auto-approve) mode.
    "ALTER TABLE focuses ADD COLUMN default_dangerous_mode INTEGER;",
    // v8 -> v9: drag-to-reorder positions for projects (left-nav list) and
    // sessions (within a focus). Spaced by 10 on create so neighbors leave room.
    // Defaults to 0 so existing rows upgrade unchanged and fall back to their
    // prior order (name for projects, insertion order for sessions) as a tiebreak.
    "ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;",
    // v9 -> v10: persisted UI view state so the workspace reopens where the user
    // left it (last focus/session, active surface, sidebar accordion) instead of
    // resetting to the dashboard on every reload or relaunch. An opaque, nullable
    // JSON blob the frontend owns; the backend stores it verbatim. Nullable with
    // no default so existing workspaces upgrade to "never saved" (NULL) and the
    // renderer seeds its usual first-focus default.
    "ALTER TABLE workspace ADD COLUMN nav_state TEXT;",
    // v10 -> v11: fresh-PTY transcript run boundaries. A Reverie session can be
    // resumed many times, but each launch starts with a clean terminal state.
    // `run_index` lets deep-history replay stitch rendered rows across launches
    // without carrying VT state from one launch into the next.
    "ALTER TABLE session_transcript_chunk ADD COLUMN run_index INTEGER NOT NULL DEFAULT 0;
     CREATE INDEX IF NOT EXISTS idx_session_transcript_chunk_run_seq
        ON session_transcript_chunk(session_id, run_index, seq);",
    // v11 -> v12: drop terminal transcript capture entirely. Reverie persists no
    // terminal history; a restart resumes the CLI (see
    // docs/technical/terminal/decisions.md, D5 and D7). The capture writer,
    // deep-history replay, and the store impl are gone, so retire the table and
    // its indexes rather than carry dead schema.
    "DROP INDEX IF EXISTS idx_session_transcript_chunk_offset;
     DROP INDEX IF EXISTS idx_session_transcript_chunk_run_seq;
     DROP TABLE IF EXISTS session_transcript_chunk;",
    // v12 -> v13: persisted terminal font size (CSS px). The renderer measures
    // the cell from this and the configured monospace font, so cell size tracks
    // the setting. Defaults to 14 so existing workspaces upgrade unchanged.
    "ALTER TABLE workspace ADD COLUMN terminal_font_size INTEGER NOT NULL DEFAULT 14;",
    // v13 -> v14: per-session last-viewed timestamp (ISO 8601), the seen-marker
    // behind the `finished` ("Ready for you") state. A turn that completes after
    // this, while the session is off-screen, is unseen. Backfill existing rows to
    // upgrade time so a fresh launch does not mass-badge sessions that finished
    // before this shipped; new rows insert NULL (treated as the epoch) and get
    // stamped the first time the user views them.
    "ALTER TABLE sessions ADD COLUMN last_viewed_at TEXT;
     UPDATE sessions SET last_viewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');",
];

const CONNECTION_COLUMNS: &str = "id, participant_a, participant_b, initiator_json, status, \
     reason_opened, policy_at_open, topic, created_at, accepted_at, closed_at, closed_by_json, \
     reason_closed, pending_request_json, sequence";

const CONNECTION_MESSAGE_COLUMNS: &str =
    "id, connection_id, from_session, to_session, body, sent_at, delivered_at, sequence";

const SESSION_COLUMNS: &str = "id, focus_id, title, agent_kind, cwd, native_session_ref_json, \
     launch_mode, dangerous_mode_override, status, last_exit_code, tab_visible, \
     latest_activity_json, archived, sort_order, last_viewed_at";

pub struct SqliteWorkspaceRepository {
    conn: Mutex<Connection>,
}

impl SqliteWorkspaceRepository {
    /// Open (or create) a database at `path`, apply PRAGMAs and migrations.
    pub fn open(path: impl AsRef<Path>) -> RepoResult<Self> {
        let path = path.as_ref();
        // "Or create" includes the parent directory: SQLite creates the database
        // file but not its folder, and a fresh app-data dir (e.g. a new bundle
        // identifier's first launch, like the dev channel) has none yet.
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|err| {
                PersistenceError::Backend(format!(
                    "failed to create database directory {}: {err}",
                    parent.display()
                ))
            })?;
        }
        let conn = Connection::open(path).map_err(backend)?;
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
    // A database stamped *newer* than this build knows about means a shipped
    // migration was removed or reordered, or the file was written by a future
    // Reverie. Because migration keys are positional (the count of applied
    // entries), reading on with a stale schema would later blow up on a missing
    // column and look like vanished data. Refuse loudly instead so the failure
    // surfaces as a real error, not a silently empty workspace.
    if current > MIGRATIONS.len() {
        return Err(PersistenceError::Backend(format!(
            "workspace database schema version {current} is newer than this build of Reverie \
             supports ({}); the database was created by a newer version or migrations were \
             reordered. Refusing to open it with a mismatched schema.",
            MIGRATIONS.len()
        )));
    }
    if current < MIGRATIONS.len() {
        // One concise line so a dev watching `npm run dev` can see migrations
        // run (and notice an unexpected jump that signals a desync).
        eprintln!(
            "[reverie-persistence] migrating workspace database from v{current} to v{}",
            MIGRATIONS.len()
        );
    }
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
                "INSERT INTO workspace
                    (id, name, general_label, default_dangerous_mode,
                     disabled_agent_kinds,
                     theme, default_agent_kind, nav_state, terminal_font_size)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    seed.id.to_string(),
                    seed.name,
                    seed.general_label,
                    bool_to_int(seed.default_dangerous_mode),
                    disabled_kinds_to_db(&seed.disabled_agent_kinds)?,
                    theme_mode_to_db(seed.theme)?,
                    agent_kind_to_db(seed.default_agent_kind)?,
                    seed.nav_state,
                    i64::from(seed.terminal_font_size),
                ],
            )
            .map_err(backend)?;
        }
        Ok(())
    }

    fn save_workspace(&self, workspace: &Workspace) -> RepoResult<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO workspace
                (id, name, general_label, default_dangerous_mode,
                 disabled_agent_kinds,
                 theme, default_agent_kind, nav_state, terminal_font_size)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                general_label = excluded.general_label,
                default_dangerous_mode = excluded.default_dangerous_mode,
                disabled_agent_kinds = excluded.disabled_agent_kinds,
                theme = excluded.theme,
                default_agent_kind = excluded.default_agent_kind,
                nav_state = excluded.nav_state,
                terminal_font_size = excluded.terminal_font_size",
            params![
                workspace.id.to_string(),
                workspace.name,
                workspace.general_label,
                bool_to_int(workspace.default_dangerous_mode),
                disabled_kinds_to_db(&workspace.disabled_agent_kinds)?,
                theme_mode_to_db(workspace.theme)?,
                agent_kind_to_db(workspace.default_agent_kind)?,
                workspace.nav_state,
                i64::from(workspace.terminal_font_size),
            ],
        )
        .map_err(backend)?;
        Ok(())
    }

    fn upsert_project(&self, project: &Project) -> RepoResult<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO projects (id, name, path, archived, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name, path = excluded.path, archived = excluded.archived,
                sort_order = excluded.sort_order",
            params![
                project.id.to_string(),
                project.name,
                path_to_db(&project.path),
                bool_to_int(project.archived),
                project.sort_order,
            ],
        )
        .map_err(backend)?;
        Ok(())
    }

    fn upsert_focus(&self, focus: &Focus) -> RepoResult<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO focuses (id, project_id, title, description, sort_order, archived, default_dangerous_mode)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                project_id = excluded.project_id, title = excluded.title,
                description = excluded.description, sort_order = excluded.sort_order,
                archived = excluded.archived,
                default_dangerous_mode = excluded.default_dangerous_mode",
            params![
                focus.id.to_string(),
                focus.project_id.map(|id| id.to_string()),
                focus.title,
                focus.description,
                focus.sort_order,
                bool_to_int(focus.archived),
                focus.default_dangerous_mode.map(bool_to_int),
            ],
        )
        .map_err(backend)?;
        Ok(())
    }

    fn upsert_session(&self, session: &Session) -> RepoResult<()> {
        let conn = self.conn()?;
        upsert_session_row(&conn, session)?;
        Ok(())
    }

    fn delete_session(&self, id: SessionId) -> RepoResult<()> {
        let conn = self.conn()?;
        let changed = conn
            .execute(
                "DELETE FROM sessions WHERE id = ?1",
                params![id.to_string()],
            )
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

    fn claim_native_session(
        &self,
        session_id: SessionId,
        native_session_ref: NativeSessionRef,
    ) -> RepoResult<bool> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(backend)?;
        let sessions = load_sessions(&tx)?;
        let Some(mut session) = sessions
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
        else {
            return Err(PersistenceError::NotFound {
                kind: "session",
                id: session_id.to_string(),
            });
        };
        if let Some(native_session_id) = native_session_ref.session_id.as_deref() {
            if sessions.iter().any(|other| {
                other.id != session_id
                    && other
                        .native_session_ref
                        .as_ref()
                        .and_then(|reference| reference.session_id.as_deref())
                        == Some(native_session_id)
            }) {
                return Ok(false);
            }
        }
        session.native_session_ref = Some(native_session_ref);
        session.launch_mode = LaunchMode::Resume;
        if session.status != SessionStatus::Running {
            session.status = SessionStatus::Restorable;
        }
        upsert_session_row(&tx, &session)?;
        tx.commit().map_err(backend)?;
        Ok(true)
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

fn upsert_session_row(conn: &Connection, session: &Session) -> RepoResult<()> {
    let native_session_ref_json = native_session_ref_to_db(&session.native_session_ref)?;
    let latest_activity_json = match &session.latest_activity {
        Some(state) => Some(
            serde_json::to_string(state)
                .map_err(|err| PersistenceError::Serialization(err.to_string()))?,
        ),
        None => None,
    };
    conn.execute(
        "INSERT INTO sessions (
            id, focus_id, title, agent_kind, cwd, native_session_ref_json, launch_mode,
            dangerous_mode_override, status, last_exit_code, tab_visible, latest_activity_json,
            archived, sort_order, last_viewed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(id) DO UPDATE SET
            focus_id = excluded.focus_id, title = excluded.title,
            agent_kind = excluded.agent_kind, cwd = excluded.cwd,
            native_session_ref_json = excluded.native_session_ref_json,
            launch_mode = excluded.launch_mode,
            dangerous_mode_override = excluded.dangerous_mode_override,
            status = excluded.status, last_exit_code = excluded.last_exit_code,
            tab_visible = excluded.tab_visible,
            latest_activity_json = excluded.latest_activity_json,
            archived = excluded.archived,
            sort_order = excluded.sort_order,
            last_viewed_at = excluded.last_viewed_at",
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
            bool_to_int(session.archived),
            session.sort_order,
            session.last_viewed_at,
        ],
    )
    .map_err(backend)?;
    Ok(())
}

impl ConnectionRepository for SqliteWorkspaceRepository {
    fn upsert_connection(&self, connection: &DomainConnection) -> RepoResult<()> {
        let initiator_json = serde_json::to_string(&connection.initiator)
            .map_err(|err| PersistenceError::Serialization(err.to_string()))?;
        let status = serde_json::to_value(connection.status)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or_else(|| {
                PersistenceError::Serialization("connection status did not encode as string".into())
            })?;
        let policy_at_open = serde_json::to_value(connection.policy_at_open)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or_else(|| {
                PersistenceError::Serialization("connection policy did not encode as string".into())
            })?;
        let closed_by_json = match &connection.closed_by {
            Some(closed_by) => Some(
                serde_json::to_string(closed_by)
                    .map_err(|err| PersistenceError::Serialization(err.to_string()))?,
            ),
            None => None,
        };
        let pending_request_json = match &connection.pending_request {
            Some(request) => Some(
                serde_json::to_string(request)
                    .map_err(|err| PersistenceError::Serialization(err.to_string()))?,
            ),
            None => None,
        };
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO connections (
                id, participant_a, participant_b, initiator_json, status,
                reason_opened, policy_at_open, topic, created_at, accepted_at,
                closed_at, closed_by_json, reason_closed, pending_request_json, sequence
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(id) DO UPDATE SET
                participant_a = excluded.participant_a,
                participant_b = excluded.participant_b,
                initiator_json = excluded.initiator_json,
                status = excluded.status,
                reason_opened = excluded.reason_opened,
                policy_at_open = excluded.policy_at_open,
                topic = excluded.topic,
                created_at = excluded.created_at,
                accepted_at = excluded.accepted_at,
                closed_at = excluded.closed_at,
                closed_by_json = excluded.closed_by_json,
                reason_closed = excluded.reason_closed,
                pending_request_json = excluded.pending_request_json,
                sequence = excluded.sequence",
            params![
                connection.id.to_string(),
                connection.participant_a.to_string(),
                connection.participant_b.to_string(),
                initiator_json,
                status,
                connection.reason_opened,
                policy_at_open,
                connection.topic,
                connection.created_at,
                connection.accepted_at,
                connection.closed_at,
                closed_by_json,
                connection.reason_closed,
                pending_request_json,
                connection.sequence as i64,
            ],
        )
        .map_err(backend)?;
        Ok(())
    }

    fn get_connection(&self, id: ConnectionId) -> RepoResult<Option<DomainConnection>> {
        let conn = self.conn()?;
        let query = format!("SELECT {CONNECTION_COLUMNS} FROM connections WHERE id = ?1");
        match conn.query_row(&query, params![id.to_string()], read_connection_row) {
            Ok(connection) => Ok(Some(connection)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(other) => Err(backend(other)),
        }
    }

    fn list_connections_for(&self, session: SessionId) -> RepoResult<Vec<DomainConnection>> {
        let conn = self.conn()?;
        let query = format!(
            "SELECT {CONNECTION_COLUMNS} FROM connections \
             WHERE participant_a = ?1 OR participant_b = ?1 \
             ORDER BY rowid"
        );
        let mut statement = conn.prepare(&query).map_err(backend)?;
        let rows = statement
            .query_map(params![session.to_string()], read_connection_row)
            .map_err(backend)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(backend)
    }

    fn append_message(&self, message: &ConnectionMessage) -> RepoResult<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO connection_messages (
                id, connection_id, from_session, to_session, body, sent_at, delivered_at, sequence
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                connection_id = excluded.connection_id,
                from_session = excluded.from_session,
                to_session = excluded.to_session,
                body = excluded.body,
                sent_at = excluded.sent_at,
                delivered_at = excluded.delivered_at,
                sequence = excluded.sequence",
            params![
                message.id.to_string(),
                message.connection_id.to_string(),
                message.from_session.to_string(),
                message.to_session.to_string(),
                message.body,
                message.sent_at,
                message.delivered_at,
                message.sequence as i64,
            ],
        )
        .map_err(backend)?;
        Ok(())
    }

    fn messages_after(
        &self,
        connection: ConnectionId,
        since_sequence: u64,
    ) -> RepoResult<Vec<ConnectionMessage>> {
        let conn = self.conn()?;
        let query = format!(
            "SELECT {CONNECTION_MESSAGE_COLUMNS} FROM connection_messages \
             WHERE connection_id = ?1 AND sequence > ?2 \
             ORDER BY sequence"
        );
        let mut statement = conn.prepare(&query).map_err(backend)?;
        let rows = statement
            .query_map(
                params![connection.to_string(), since_sequence as i64],
                read_message_row,
            )
            .map_err(backend)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(backend)
    }

    fn mark_message_delivered(&self, id: MessageId, delivered_at: &str) -> RepoResult<()> {
        let conn = self.conn()?;
        let changed = conn
            .execute(
                "UPDATE connection_messages SET delivered_at = COALESCE(delivered_at, ?2) \
                 WHERE id = ?1",
                params![id.to_string(), delivered_at],
            )
            .map_err(backend)?;
        if changed == 0 {
            return Err(PersistenceError::NotFound {
                kind: "connection_message",
                id: id.to_string(),
            });
        }
        Ok(())
    }
}

fn read_connection_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DomainConnection> {
    let id_str: String = row.get(0)?;
    let id = ConnectionId::parse_str(&id_str).map_err(conversion_failure)?;
    let participant_a_str: String = row.get(1)?;
    let participant_b_str: String = row.get(2)?;
    let initiator_json: String = row.get(3)?;
    let status_str: String = row.get(4)?;
    let reason_opened: String = row.get(5)?;
    let policy_at_open_str: String = row.get(6)?;
    let topic: Option<String> = row.get(7)?;
    let created_at: String = row.get(8)?;
    let accepted_at: Option<String> = row.get(9)?;
    let closed_at: Option<String> = row.get(10)?;
    let closed_by_json: Option<String> = row.get(11)?;
    let reason_closed: Option<String> = row.get(12)?;
    let pending_request_json: Option<String> = row.get(13)?;
    let sequence: i64 = row.get(14)?;

    Ok(DomainConnection {
        id,
        participant_a: SessionId::parse_str(&participant_a_str).map_err(conversion_failure)?,
        participant_b: SessionId::parse_str(&participant_b_str).map_err(conversion_failure)?,
        initiator: serde_json::from_str(&initiator_json).map_err(conversion_failure)?,
        status: serde_json::from_value(serde_json::Value::String(status_str))
            .map_err(conversion_failure)?,
        reason_opened,
        policy_at_open: serde_json::from_value(serde_json::Value::String(policy_at_open_str))
            .map_err(conversion_failure)?,
        topic,
        created_at,
        accepted_at,
        closed_at,
        closed_by: match closed_by_json {
            Some(text) => Some(serde_json::from_str(&text).map_err(conversion_failure)?),
            None => None,
        },
        reason_closed,
        pending_request: match pending_request_json {
            Some(text) => Some(serde_json::from_str(&text).map_err(conversion_failure)?),
            None => None,
        },
        sequence: sequence as u64,
    })
}

fn read_message_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConnectionMessage> {
    let id_str: String = row.get(0)?;
    let connection_id_str: String = row.get(1)?;
    let from_session_str: String = row.get(2)?;
    let to_session_str: String = row.get(3)?;
    let body: String = row.get(4)?;
    let sent_at: String = row.get(5)?;
    let delivered_at: Option<String> = row.get(6)?;
    let sequence: i64 = row.get(7)?;
    Ok(ConnectionMessage {
        id: MessageId::parse_str(&id_str).map_err(conversion_failure)?,
        connection_id: ConnectionId::parse_str(&connection_id_str).map_err(conversion_failure)?,
        from_session: SessionId::parse_str(&from_session_str).map_err(conversion_failure)?,
        to_session: SessionId::parse_str(&to_session_str).map_err(conversion_failure)?,
        body,
        sent_at,
        delivered_at,
        sequence: sequence as u64,
    })
}

fn load_workspace(conn: &Connection) -> RepoResult<Workspace> {
    conn.query_row(
        "SELECT id, name, general_label, default_dangerous_mode,
                disabled_agent_kinds,
                theme, default_agent_kind, nav_state, terminal_font_size
         FROM workspace LIMIT 1",
        [],
        |row| {
            Ok(Workspace {
                id: parse_uuid_row(row.get::<_, String>(0)?)?,
                name: row.get(1)?,
                general_label: row.get(2)?,
                default_dangerous_mode: int_to_bool(row.get::<_, i64>(3)?),
                disabled_agent_kinds: disabled_kinds_from_db(&row.get::<_, String>(4)?),
                theme: theme_mode_from_db(&row.get::<_, String>(5)?)?,
                default_agent_kind: agent_kind_from_db(&row.get::<_, String>(6)?)?,
                nav_state: row.get::<_, Option<String>>(7)?,
                terminal_font_size: terminal_font_size_from_db(row.get::<_, i64>(8)?),
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
        .prepare(
            "SELECT id, name, path, archived, sort_order
             FROM projects ORDER BY sort_order, name COLLATE NOCASE",
        )
        .map_err(backend)?;
    let rows = statement
        .query_map([], |row| {
            Ok(Project {
                id: parse_uuid_row(row.get::<_, String>(0)?)?,
                name: row.get(1)?,
                path: PathBuf::from(row.get::<_, String>(2)?),
                archived: int_to_bool(row.get::<_, i64>(3)?),
                sort_order: row.get(4)?,
            })
        })
        .map_err(backend)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(backend)
}

fn load_focuses(conn: &Connection) -> RepoResult<Vec<Focus>> {
    let mut statement = conn
        .prepare(
            "SELECT id, project_id, title, description, sort_order, archived, default_dangerous_mode
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
                default_dangerous_mode: row.get::<_, Option<i64>>(6)?.map(int_to_bool),
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
        archived: int_to_bool(row.get::<_, i64>(12)?),
        sort_order: row.get(13)?,
        last_viewed_at: row.get::<_, Option<String>>(14)?,
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

/// Serialize the disabled-CLI set as a JSON array of snake_case wire strings,
/// e.g. `["claude_code"]`. Stored in the single `workspace.disabled_agent_kinds`
/// column.
fn disabled_kinds_to_db(kinds: &[AgentKind]) -> RepoResult<String> {
    serde_json::to_string(kinds)
        .map_err(|err| PersistenceError::Backend(format!("encoding disabled agent kinds: {err}")))
}

/// Parse the disabled-CLI set. A missing/garbled value decodes to "none
/// disabled" so a hand-edited or pre-migration row never bricks startup.
fn disabled_kinds_from_db(value: &str) -> Vec<AgentKind> {
    serde_json::from_str(value).unwrap_or_default()
}

fn agent_kind_from_db(value: &str) -> rusqlite::Result<AgentKind> {
    serde_json::from_value(serde_json::Value::String(value.to_owned())).map_err(conversion_failure)
}

fn theme_mode_to_db(value: ThemeMode) -> RepoResult<String> {
    string_enum(serde_json::to_value(value), "theme mode")
}

fn theme_mode_from_db(value: &str) -> rusqlite::Result<ThemeMode> {
    serde_json::from_value(serde_json::Value::String(value.to_owned())).map_err(conversion_failure)
}

/// Read the stored terminal font size, clamping any out-of-range or overflowing
/// value (e.g. a hand-edited row) into the renderer's supported range so it can
/// never produce a degenerate cell.
fn terminal_font_size_from_db(value: i64) -> u16 {
    value.clamp(9, 24) as u16
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

fn native_session_ref_from_db(value: Option<String>) -> rusqlite::Result<Option<NativeSessionRef>> {
    match value {
        Some(encoded) => serde_json::from_str(&encoded)
            .map(Some)
            .map_err(conversion_failure),
        None => Ok(None),
    }
}

fn activity_state_from_db(value: Option<String>) -> rusqlite::Result<Option<ActivityState>> {
    match value {
        Some(text) if !text.is_empty() => serde_json::from_str::<ActivityState>(&text)
            .map(Some)
            .map_err(conversion_failure),
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
    fn open_creates_a_missing_parent_directory() {
        // A fresh bundle identifier's app-data dir does not exist yet (the dev
        // channel's first launch is exactly this case). open() must create the
        // parent directory, not fail the way SQLite's bare open does.
        let base = std::env::temp_dir().join(format!("reverie-open-test-{}", uuid::Uuid::new_v4()));
        let db_path = base.join("nested").join("workspace-shell.v1.sqlite3");
        assert!(!db_path.exists());

        let repo = SqliteWorkspaceRepository::open(&db_path)
            .expect("open should create the missing parent directory");
        drop(repo);

        assert!(db_path.exists(), "database file should exist after open");
        let _ = std::fs::remove_dir_all(&base);
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
        repo.ensure_seeded(&Workspace::new("Other", "General"))
            .unwrap();
        assert_eq!(repo.load_snapshot().unwrap().workspace.id, first);
    }

    #[test]
    fn project_focus_session_round_trip_with_ordering() {
        let repo = seeded();
        repo.upsert_project(&Project::new("Zeta", PathBuf::from("/z")))
            .unwrap();
        repo.upsert_project(&Project::new("alpha", PathBuf::from("/a")))
            .unwrap();
        let focus = Focus::general("General", 0);
        repo.upsert_focus(&focus).unwrap();
        let session = Session::new(focus.id, "S", AgentKind::CortexCode, PathBuf::from("/repo"));
        repo.upsert_session(&session).unwrap();

        let snapshot = repo.load_snapshot().unwrap();
        // Projects come back name-sorted, case-insensitive.
        assert_eq!(
            snapshot
                .projects
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
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
        let mut session = Session::new(
            focus.id,
            "Cortex",
            AgentKind::CortexCode,
            PathBuf::from("/repo"),
        );
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
    fn claim_native_session_rejects_cross_session_collision() {
        let repo = seeded();
        let focus = Focus::general("General", 0);
        repo.upsert_focus(&focus).unwrap();
        let first = Session::new(
            focus.id,
            "First",
            AgentKind::CortexCode,
            PathBuf::from("/repo"),
        );
        let second = Session::new(
            focus.id,
            "Second",
            AgentKind::CortexCode,
            PathBuf::from("/repo"),
        );
        repo.upsert_session(&first).unwrap();
        repo.upsert_session(&second).unwrap();

        assert!(
            repo.claim_native_session(first.id, NativeSessionRef::cortex("native-42", None))
                .unwrap()
        );
        assert!(
            !repo
                .claim_native_session(second.id, NativeSessionRef::cortex("native-42", None))
                .unwrap()
        );

        let loaded_second = repo.get_session(second.id).unwrap().unwrap();
        assert!(loaded_second.native_session_ref.is_none());
        let by_native = repo.find_session_by_native_id("native-42").unwrap();
        assert_eq!(by_native.map(|session| session.id), Some(first.id));
    }

    #[test]
    fn upsert_session_updates_in_place() {
        let repo = seeded();
        let focus = Focus::general("General", 0);
        repo.upsert_focus(&focus).unwrap();
        let mut session = Session::new(
            focus.id,
            "Before",
            AgentKind::CortexCode,
            PathBuf::from("/repo"),
        );
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
        assert!(matches!(
            err,
            PersistenceError::NotFound {
                kind: "session",
                ..
            }
        ));
    }

    #[test]
    fn archive_project_cascade_hides_sessions_atomically() {
        let repo = seeded();
        let project = Project::new("Reverie", PathBuf::from("/repo"));
        repo.upsert_project(&project).unwrap();
        let focus = Focus::for_project(project.id, "Terminal", 10);
        repo.upsert_focus(&focus).unwrap();
        let session = Session::new(focus.id, "S", AgentKind::CortexCode, PathBuf::from("/repo"));
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
        let err = repo
            .archive_project_cascade(ProjectId::new_v4())
            .unwrap_err();
        assert!(matches!(
            err,
            PersistenceError::NotFound {
                kind: "project",
                ..
            }
        ));
    }

    #[test]
    fn save_workspace_updates_dangerous_mode() {
        let repo = seeded();
        let mut workspace = repo.load_snapshot().unwrap().workspace;
        workspace.default_dangerous_mode = true;
        repo.save_workspace(&workspace).unwrap();
        assert!(
            repo.load_snapshot()
                .unwrap()
                .workspace
                .default_dangerous_mode
        );
    }

    #[test]
    fn save_workspace_round_trips_theme_and_default_agent_kind() {
        let repo = seeded();
        // Fresh workspaces default to the dark theme and Claude Code, the first
        // agent in the priority order (see `domain::default_agent_kind`).
        let workspace = repo.load_snapshot().unwrap().workspace;
        assert_eq!(workspace.theme, ThemeMode::Dark);
        assert_eq!(workspace.default_agent_kind, AgentKind::ClaudeCode);

        // Flipping the theme persists and round-trips without touching the agent.
        let mut workspace = repo.load_snapshot().unwrap().workspace;
        workspace.theme = ThemeMode::Light;
        repo.save_workspace(&workspace).unwrap();
        let loaded = repo.load_snapshot().unwrap().workspace;
        assert_eq!(loaded.theme, ThemeMode::Light);
        assert_eq!(loaded.default_agent_kind, AgentKind::ClaudeCode);

        // Changing the default agent away from the seeded default persists and is
        // independent of the theme.
        let mut workspace = repo.load_snapshot().unwrap().workspace;
        workspace.default_agent_kind = AgentKind::CortexCode;
        repo.save_workspace(&workspace).unwrap();
        let loaded = repo.load_snapshot().unwrap().workspace;
        assert_eq!(loaded.default_agent_kind, AgentKind::CortexCode);
        assert_eq!(loaded.theme, ThemeMode::Light);
    }

    #[test]
    fn save_workspace_round_trips_terminal_font_size() {
        let repo = seeded();
        // A fresh workspace defaults to the renderer's default font size.
        assert_eq!(
            repo.load_snapshot().unwrap().workspace.terminal_font_size,
            14
        );

        // A new size persists and round-trips.
        let mut workspace = repo.load_snapshot().unwrap().workspace;
        workspace.terminal_font_size = 18;
        repo.save_workspace(&workspace).unwrap();
        assert_eq!(
            repo.load_snapshot().unwrap().workspace.terminal_font_size,
            18
        );

        // An out-of-range stored value is clamped on load so it can never produce
        // a degenerate cell.
        repo.conn()
            .unwrap()
            .execute("UPDATE workspace SET terminal_font_size = 999", [])
            .unwrap();
        assert_eq!(
            repo.load_snapshot().unwrap().workspace.terminal_font_size,
            24
        );
    }

    #[test]
    fn save_workspace_round_trips_nav_state() {
        let repo = seeded();
        // A fresh workspace has never saved a view, so the renderer seeds its
        // default rather than restoring one.
        assert_eq!(repo.load_snapshot().unwrap().workspace.nav_state, None);

        // An opaque JSON blob round-trips verbatim, independent of the theme.
        let blob = r#"{"surfaceMode":"terminal","selectedSessionId":"abc"}"#.to_owned();
        let mut workspace = repo.load_snapshot().unwrap().workspace;
        workspace.nav_state = Some(blob.clone());
        repo.save_workspace(&workspace).unwrap();
        let loaded = repo.load_snapshot().unwrap().workspace;
        assert_eq!(loaded.nav_state, Some(blob));
        assert_eq!(loaded.theme, ThemeMode::Dark);

        // Clearing it returns to the unsaved state.
        let mut workspace = repo.load_snapshot().unwrap().workspace;
        workspace.nav_state = None;
        repo.save_workspace(&workspace).unwrap();
        assert_eq!(repo.load_snapshot().unwrap().workspace.nav_state, None);
    }

    #[test]
    fn save_workspace_round_trips_disabled_agent_kinds() {
        let repo = seeded();
        // A fresh workspace has every CLI enabled.
        assert!(
            repo.load_snapshot()
                .unwrap()
                .workspace
                .disabled_agent_kinds
                .is_empty()
        );

        let mut workspace = repo.load_snapshot().unwrap().workspace;
        workspace.disabled_agent_kinds = vec![AgentKind::ClaudeCode, AgentKind::CodexCli];
        repo.save_workspace(&workspace).unwrap();

        let loaded = repo.load_snapshot().unwrap().workspace;
        assert_eq!(
            loaded.disabled_agent_kinds,
            vec![AgentKind::ClaudeCode, AgentKind::CodexCli]
        );

        // Re-enabling clears the set.
        workspace.disabled_agent_kinds = Vec::new();
        repo.save_workspace(&workspace).unwrap();
        assert!(
            repo.load_snapshot()
                .unwrap()
                .workspace
                .disabled_agent_kinds
                .is_empty()
        );
    }

    #[test]
    fn migrate_adopts_a_pre_versioned_database() {
        // Simulate a database created by the old code: the schema already
        // exists but user_version was never set, so it reads as 0.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS[0]).unwrap();
        let before: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(before, 0);

        // Migrating must adopt it (no "table already exists") and stamp the
        // current version rather than crash at startup.
        migrate(&conn).unwrap();
        let after: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after as usize, MIGRATIONS.len());
    }

    #[test]
    fn migrate_refuses_a_database_newer_than_the_build() {
        // A file stamped beyond the known migration count (downgrade, or a
        // reordered/removed migration) must be refused loudly rather than read
        // with a mismatched schema that later fails on a missing column.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!("PRAGMA user_version = {};", MIGRATIONS.len() + 1))
            .unwrap();
        let err = migrate(&conn).unwrap_err();
        assert!(
            matches!(err, PersistenceError::Backend(message) if message.contains("newer than this build")),
            "expected a clear schema-too-new backend error"
        );
    }

    #[test]
    fn migrate_from_v11_drops_terminal_transcript_table() {
        // Build a database at v11, where the transcript table + both its indexes
        // still exist, then migrate forward and confirm v11 -> v12 retires them.
        // Reverie persists no terminal history (decisions.md D5/D7), so the table
        // must not survive the upgrade.
        let conn = Connection::open_in_memory().unwrap();
        for version in 0..11 {
            conn.execute_batch(MIGRATIONS[version]).unwrap();
            conn.execute_batch(&format!("PRAGMA user_version = {};", version + 1))
                .unwrap();
        }

        assert!(table_has_column(
            &conn,
            "session_transcript_chunk",
            "run_index"
        ));
        assert!(index_exists(
            &conn,
            "session_transcript_chunk",
            "idx_session_transcript_chunk_run_seq"
        ));

        migrate(&conn).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version as usize, MIGRATIONS.len());
        assert!(!sqlite_object_exists(
            &conn,
            "table",
            "session_transcript_chunk"
        ));
        assert!(!sqlite_object_exists(
            &conn,
            "index",
            "idx_session_transcript_chunk_offset"
        ));
        assert!(!sqlite_object_exists(
            &conn,
            "index",
            "idx_session_transcript_chunk_run_seq"
        ));
    }

    fn sqlite_object_exists(conn: &Connection, kind: &str, name: &str) -> bool {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = ?1 AND name = ?2",
                params![kind, name],
                |row| row.get(0),
            )
            .unwrap();
        count > 0
    }

    fn table_has_column(conn: &Connection, table: &str, column: &str) -> bool {
        let mut statement = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap();
        rows.filter_map(Result::ok).any(|name| name == column)
    }

    fn index_exists(conn: &Connection, table: &str, index: &str) -> bool {
        let mut statement = conn
            .prepare(&format!("PRAGMA index_list({table})"))
            .unwrap();
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap();
        rows.filter_map(Result::ok).any(|name| name == index)
    }

    // -----------------------------------------------------------------
    // Connection persistence
    // -----------------------------------------------------------------

    mod connections {
        use super::super::*;
        use reverie_core::connection::{
            Connection as DomainConnection, ConnectionClosedBy, ConnectionMessage,
            ConnectionPolicy, ConnectionStatus,
        };
        use uuid::Uuid;

        fn open() -> SqliteWorkspaceRepository {
            SqliteWorkspaceRepository::open_in_memory().unwrap()
        }

        fn session_uuid(byte: u8) -> SessionId {
            Uuid::from_bytes([byte; 16])
        }

        #[test]
        fn round_trips_an_open_connection() {
            let repo = open();
            let conn = DomainConnection::user_opened(
                session_uuid(0x01),
                session_uuid(0x02),
                "Round-trip test",
                ConnectionPolicy::AlwaysAsk,
                "2026-05-28T12:00:00Z",
            );
            repo.upsert_connection(&conn).unwrap();
            let loaded = repo.get_connection(conn.id).unwrap().expect("present");
            assert_eq!(loaded, conn);
        }

        #[test]
        fn round_trips_a_requested_connection_with_pending_metadata() {
            let repo = open();
            let mut conn = DomainConnection::agent_requested(
                session_uuid(0x01),
                session_uuid(0x02),
                "Need to coordinate",
                ConnectionPolicy::AlwaysAsk,
                Uuid::new_v4(),
                "2026-05-28T12:00:00Z",
                "2026-05-28T12:10:00Z",
            );
            repo.upsert_connection(&conn).unwrap();
            let loaded = repo.get_connection(conn.id).unwrap().unwrap();
            assert_eq!(loaded.status, ConnectionStatus::Requested);
            assert!(loaded.pending_request.is_some());

            // Accept and re-persist; pending request is cleared, accepted_at filled.
            conn.accept("2026-05-28T12:01:00Z").unwrap();
            repo.upsert_connection(&conn).unwrap();
            let updated = repo.get_connection(conn.id).unwrap().unwrap();
            assert_eq!(updated.status, ConnectionStatus::Open);
            assert!(updated.pending_request.is_none());
            assert_eq!(updated.accepted_at.as_deref(), Some("2026-05-28T12:01:00Z"));
        }

        #[test]
        fn list_connections_for_filters_by_participation() {
            let repo = open();
            let one = DomainConnection::user_opened(
                session_uuid(0x01),
                session_uuid(0x02),
                "r",
                ConnectionPolicy::AlwaysAsk,
                "t0",
            );
            let two = DomainConnection::user_opened(
                session_uuid(0x03),
                session_uuid(0x04),
                "r",
                ConnectionPolicy::AlwaysAsk,
                "t0",
            );
            repo.upsert_connection(&one).unwrap();
            repo.upsert_connection(&two).unwrap();
            let for_two = repo.list_connections_for(session_uuid(0x02)).unwrap();
            assert_eq!(for_two.len(), 1);
            assert_eq!(for_two[0].id, one.id);
            assert!(
                repo.list_connections_for(session_uuid(0x09))
                    .unwrap()
                    .is_empty()
            );
        }

        #[test]
        fn messages_round_trip_with_sequence_filter_and_delivery_stamp() {
            let repo = open();
            let conn = DomainConnection::user_opened(
                session_uuid(0x01),
                session_uuid(0x02),
                "r",
                ConnectionPolicy::AlwaysAsk,
                "t0",
            );
            repo.upsert_connection(&conn).unwrap();
            let m1 = ConnectionMessage::new(
                conn.id,
                session_uuid(0x01),
                session_uuid(0x02),
                "hello",
                "t1",
                1,
            );
            let m2 = ConnectionMessage::new(
                conn.id,
                session_uuid(0x02),
                session_uuid(0x01),
                "hi",
                "t2",
                2,
            );
            repo.append_message(&m1).unwrap();
            repo.append_message(&m2).unwrap();

            let all = repo.messages_after(conn.id, 0).unwrap();
            assert_eq!(all.len(), 2);
            assert_eq!(all[0].sequence, 1);
            assert_eq!(all[1].sequence, 2);
            let only_new = repo.messages_after(conn.id, 1).unwrap();
            assert_eq!(only_new.len(), 1);
            assert_eq!(only_new[0].id, m2.id);

            repo.mark_message_delivered(m1.id, "t3").unwrap();
            let stamped = repo.messages_after(conn.id, 0).unwrap();
            assert_eq!(stamped[0].delivered_at.as_deref(), Some("t3"));
            // Idempotent (preserves first stamp).
            repo.mark_message_delivered(m1.id, "t4").unwrap();
            let again = repo.messages_after(conn.id, 0).unwrap();
            assert_eq!(again[0].delivered_at.as_deref(), Some("t3"));
        }

        #[test]
        fn mark_delivered_reports_not_found_for_unknown_id() {
            let repo = open();
            let err = repo
                .mark_message_delivered(Uuid::new_v4(), "t")
                .unwrap_err();
            assert!(matches!(
                err,
                PersistenceError::NotFound {
                    kind: "connection_message",
                    ..
                }
            ));
        }

        #[test]
        fn full_lifecycle_through_connection_service_on_sqlite() {
            use reverie_core::connection_service::{
                DecisionBy, RegisteredSession, RequestOutcome, SessionAddress,
            };
            use reverie_core::{ConnectionCaller, ConnectionService};
            use std::sync::Arc;

            let repo = Arc::new(open());
            let service = ConnectionService::new(repo.clone() as Arc<dyn ConnectionRepository>);

            let alice = session_uuid(0x01);
            let bob = session_uuid(0x02);
            let focus_id = Uuid::from_bytes([0x10; 16]);
            service.register_session(RegisteredSession {
                session_id: alice,
                secret: "alice".into(),
                address: SessionAddress {
                    agent_kind: AgentKind::CortexCode,
                    project_id: None,
                    project_name: None,
                    focus_id,
                    focus_title: "Design".into(),
                    session_title: "Cortex A".into(),
                },
            });
            service.register_session(RegisteredSession {
                session_id: bob,
                secret: "bob".into(),
                address: SessionAddress {
                    agent_kind: AgentKind::CortexCode,
                    project_id: None,
                    project_name: None,
                    focus_id,
                    focus_title: "Design".into(),
                    session_title: "Cortex B".into(),
                },
            });

            // Alice requests; AlwaysAsk policy → pending.
            let RequestOutcome::Pending {
                connection_id,
                request_id,
            } = service
                .request_connection(alice, bob, "Hand off summary", "t0", "t10")
                .unwrap()
            else {
                panic!("expected pending");
            };
            assert_eq!(service.list_pending_requests().unwrap().len(), 1);

            // User accepts.
            service
                .accept_request(request_id, DecisionBy::User, "t1")
                .unwrap();
            assert!(service.list_pending_requests().unwrap().is_empty());

            // Alice sends a message, Bob fetches.
            let _ = service
                .send_message(alice, connection_id, "Here is the summary", "t2")
                .unwrap();
            let inbound = service
                .pending_messages(bob, connection_id, 0, "t3")
                .unwrap();
            assert_eq!(inbound.len(), 1);
            assert_eq!(inbound[0].body, "Here is the summary");
            assert_eq!(inbound[0].delivered_at.as_deref(), Some("t3"));

            // Bob replies, Alice fetches.
            let _ = service
                .send_message(bob, connection_id, "Got it; updating diagram", "t4")
                .unwrap();
            let reply = service
                .pending_messages(alice, connection_id, 0, "t5")
                .unwrap();
            assert_eq!(reply.len(), 1);
            assert_eq!(reply[0].body, "Got it; updating diagram");

            // Close, and verify SQLite preserves the full record across a
            // fresh service instance backed by the same repository.
            service
                .close(
                    ConnectionCaller::User,
                    connection_id,
                    "t9",
                    Some("done".into()),
                )
                .unwrap();
            drop(service);

            let service2 = ConnectionService::new(repo.clone() as Arc<dyn ConnectionRepository>);
            let restored = service2.get_connection(connection_id).unwrap().unwrap();
            assert_eq!(restored.status, ConnectionStatus::Closed);
            assert_eq!(restored.reason_closed.as_deref(), Some("done"));
            // Transcript survives.
            let all = repo.messages_after(connection_id, 0).unwrap();
            assert_eq!(all.len(), 2);
        }

        #[test]
        fn closed_connection_preserves_closed_by_metadata() {
            let repo = open();
            let mut conn = DomainConnection::user_opened(
                session_uuid(0x01),
                session_uuid(0x02),
                "r",
                ConnectionPolicy::AlwaysAsk,
                "t0",
            );
            conn.close(
                "t5",
                ConnectionClosedBy::SessionEnded {
                    session_id: session_uuid(0x02),
                },
                Some("session ended".into()),
            )
            .unwrap();
            repo.upsert_connection(&conn).unwrap();
            let loaded = repo.get_connection(conn.id).unwrap().unwrap();
            assert_eq!(loaded.status, ConnectionStatus::Closed);
            assert!(matches!(
                loaded.closed_by,
                Some(ConnectionClosedBy::SessionEnded { .. })
            ));
            assert_eq!(loaded.reason_closed.as_deref(), Some("session ended"));
        }
    }
}
