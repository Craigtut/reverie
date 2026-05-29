//! Storage boundary for inter-agent connections.
//!
//! Mirrors the [`crate::repository::WorkspaceRepository`] pattern: this trait
//! is the seam between [`crate::connection_service::ConnectionService`] and
//! whichever store backs it. [`InMemoryConnectionRepository`] here is what the
//! service's unit tests and any headless harness use. A SQLite implementation
//! lands in Phase 6 (see `docs/technical/inter-agent-connections.md`).
//!
//! Only persistent records live here: [`crate::connection::Connection`] and
//! [`crate::connection::ConnectionMessage`]. The list of currently-running
//! registered sessions is intentionally **not** persisted, since a desktop
//! restart invalidates every running process anyway and the registry is
//! rebuilt from spawn-time information.

use std::sync::Mutex;

use crate::connection::{Connection, ConnectionId, ConnectionMessage, MessageId};
use crate::domain::SessionId;
use crate::repository::{PersistenceError, RepoResult};

/// Persistence trait for connections and their messages. Implementations must
/// be `Send + Sync` so the service can be shared as Tauri managed state.
pub trait ConnectionRepository: Send + Sync {
    /// Insert or replace a connection by id. New rows append; existing rows
    /// replace in place to preserve insertion order on enumeration.
    fn upsert_connection(&self, connection: &Connection) -> RepoResult<()>;

    fn get_connection(&self, id: ConnectionId) -> RepoResult<Option<Connection>>;

    /// All connections that have `session` as either participant, in insertion
    /// order. Includes connections in every status (Requested, Open, Closed,
    /// Denied), so the panel and activity log can render history uniformly.
    fn list_connections_for(&self, session: SessionId) -> RepoResult<Vec<Connection>>;

    /// Append a message. Messages are immutable once written; the only
    /// permitted post-write mutation is [`mark_message_delivered`].
    fn append_message(&self, message: &ConnectionMessage) -> RepoResult<()>;

    /// All messages on `connection` with `sequence > since_sequence`, in
    /// ascending sequence order. Pass `since_sequence = 0` to fetch the full
    /// transcript.
    fn messages_after(
        &self,
        connection: ConnectionId,
        since_sequence: u64,
    ) -> RepoResult<Vec<ConnectionMessage>>;

    /// Stamp `delivered_at` on a previously-undelivered message. Errors
    /// [`PersistenceError::NotFound`] if no such message exists. No-op if
    /// already delivered.
    fn mark_message_delivered(&self, id: MessageId, delivered_at: &str) -> RepoResult<()>;
}

#[derive(Default)]
struct InMemoryState {
    connections: Vec<Connection>,
    messages: Vec<ConnectionMessage>,
}

/// In-memory [`ConnectionRepository`] for tests and headless use. Not
/// persisted; every instance starts empty. Read ordering matches the
/// eventual SQLite backend (insertion order for both connections and
/// messages) so service tests see the same shape.
#[derive(Default)]
pub struct InMemoryConnectionRepository {
    state: Mutex<InMemoryState>,
}

impl InMemoryConnectionRepository {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> RepoResult<std::sync::MutexGuard<'_, InMemoryState>> {
        self.state.lock().map_err(|_| {
            PersistenceError::Backend("in-memory connection repository lock poisoned".to_owned())
        })
    }
}

impl ConnectionRepository for InMemoryConnectionRepository {
    fn upsert_connection(&self, connection: &Connection) -> RepoResult<()> {
        let mut state = self.lock()?;
        match state
            .connections
            .iter_mut()
            .find(|existing| existing.id == connection.id)
        {
            Some(existing) => *existing = connection.clone(),
            None => state.connections.push(connection.clone()),
        }
        Ok(())
    }

    fn get_connection(&self, id: ConnectionId) -> RepoResult<Option<Connection>> {
        let state = self.lock()?;
        Ok(state.connections.iter().find(|c| c.id == id).cloned())
    }

    fn list_connections_for(&self, session: SessionId) -> RepoResult<Vec<Connection>> {
        let state = self.lock()?;
        Ok(state
            .connections
            .iter()
            .filter(|connection| connection.involves(session))
            .cloned()
            .collect())
    }

    fn append_message(&self, message: &ConnectionMessage) -> RepoResult<()> {
        let mut state = self.lock()?;
        state.messages.push(message.clone());
        Ok(())
    }

    fn messages_after(
        &self,
        connection: ConnectionId,
        since_sequence: u64,
    ) -> RepoResult<Vec<ConnectionMessage>> {
        let state = self.lock()?;
        let mut filtered: Vec<ConnectionMessage> = state
            .messages
            .iter()
            .filter(|message| {
                message.connection_id == connection && message.sequence > since_sequence
            })
            .cloned()
            .collect();
        filtered.sort_by_key(|message| message.sequence);
        Ok(filtered)
    }

    fn mark_message_delivered(&self, id: MessageId, delivered_at: &str) -> RepoResult<()> {
        let mut state = self.lock()?;
        let message = state
            .messages
            .iter_mut()
            .find(|message| message.id == id)
            .ok_or_else(|| PersistenceError::NotFound {
                kind: "connection_message",
                id: id.to_string(),
            })?;
        if message.delivered_at.is_none() {
            message.delivered_at = Some(delivered_at.to_owned());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::{Connection, ConnectionMessage, ConnectionPolicy};
    use uuid::Uuid;

    fn session(byte: u8) -> SessionId {
        Uuid::from_bytes([byte; 16])
    }

    #[test]
    fn upsert_connection_inserts_then_replaces_in_place() {
        let repo = InMemoryConnectionRepository::new();
        let mut conn = Connection::user_opened(
            session(0x01),
            session(0x02),
            "r",
            ConnectionPolicy::AlwaysAsk,
            "t0",
        );

        repo.upsert_connection(&conn).unwrap();
        conn.topic = Some("renamed".into());
        repo.upsert_connection(&conn).unwrap();

        let listed = repo.list_connections_for(session(0x01)).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].topic.as_deref(), Some("renamed"));
    }

    #[test]
    fn list_connections_for_filters_by_participation() {
        let repo = InMemoryConnectionRepository::new();
        let one = Connection::user_opened(
            session(0x01),
            session(0x02),
            "r",
            ConnectionPolicy::AlwaysAsk,
            "t0",
        );
        let two = Connection::user_opened(
            session(0x03),
            session(0x04),
            "r",
            ConnectionPolicy::AlwaysAsk,
            "t0",
        );
        repo.upsert_connection(&one).unwrap();
        repo.upsert_connection(&two).unwrap();

        let for_two = repo.list_connections_for(session(0x02)).unwrap();
        assert_eq!(for_two.len(), 1);
        assert_eq!(for_two[0].id, one.id);

        let for_five = repo.list_connections_for(session(0x05)).unwrap();
        assert!(for_five.is_empty());
    }

    #[test]
    fn get_connection_returns_none_for_unknown_id() {
        let repo = InMemoryConnectionRepository::new();
        assert!(repo.get_connection(Uuid::new_v4()).unwrap().is_none());
    }

    #[test]
    fn append_and_replay_messages_in_sequence_order() {
        let repo = InMemoryConnectionRepository::new();
        let conn_id = Uuid::new_v4();

        // Append out of order; replay must come back sorted.
        let m2 = ConnectionMessage::new(conn_id, session(0x01), session(0x02), "second", "t2", 2);
        let m1 = ConnectionMessage::new(conn_id, session(0x01), session(0x02), "first", "t1", 1);
        let m3 = ConnectionMessage::new(conn_id, session(0x02), session(0x01), "third", "t3", 3);

        repo.append_message(&m2).unwrap();
        repo.append_message(&m1).unwrap();
        repo.append_message(&m3).unwrap();

        let all = repo.messages_after(conn_id, 0).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].sequence, 1);
        assert_eq!(all[1].sequence, 2);
        assert_eq!(all[2].sequence, 3);

        let after_one = repo.messages_after(conn_id, 1).unwrap();
        assert_eq!(after_one.len(), 2);
        assert_eq!(after_one[0].sequence, 2);
    }

    #[test]
    fn messages_after_isolates_by_connection() {
        let repo = InMemoryConnectionRepository::new();
        let conn_a = Uuid::new_v4();
        let conn_b = Uuid::new_v4();
        repo.append_message(&ConnectionMessage::new(
            conn_a,
            session(0x01),
            session(0x02),
            "a",
            "t1",
            1,
        ))
        .unwrap();
        repo.append_message(&ConnectionMessage::new(
            conn_b,
            session(0x01),
            session(0x02),
            "b",
            "t1",
            1,
        ))
        .unwrap();

        let only_a = repo.messages_after(conn_a, 0).unwrap();
        assert_eq!(only_a.len(), 1);
        assert_eq!(only_a[0].body, "a");
    }

    #[test]
    fn mark_message_delivered_stamps_once() {
        let repo = InMemoryConnectionRepository::new();
        let conn_id = Uuid::new_v4();
        let msg = ConnectionMessage::new(conn_id, session(0x01), session(0x02), "hi", "t1", 1);
        repo.append_message(&msg).unwrap();

        repo.mark_message_delivered(msg.id, "t2").unwrap();
        let after = repo.messages_after(conn_id, 0).unwrap();
        assert_eq!(after[0].delivered_at.as_deref(), Some("t2"));

        // Idempotent: second mark must not overwrite the first stamp.
        repo.mark_message_delivered(msg.id, "t3").unwrap();
        let again = repo.messages_after(conn_id, 0).unwrap();
        assert_eq!(again[0].delivered_at.as_deref(), Some("t2"));
    }

    #[test]
    fn mark_message_delivered_reports_not_found() {
        let repo = InMemoryConnectionRepository::new();
        let err = repo
            .mark_message_delivered(Uuid::new_v4(), "t1")
            .unwrap_err();
        assert!(matches!(
            err,
            PersistenceError::NotFound {
                kind: "connection_message",
                ..
            }
        ));
    }
}
