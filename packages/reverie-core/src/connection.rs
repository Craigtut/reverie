//! Typed model for inter-agent connections.
//!
//! A `Connection` joins two `Session`s and persists until severed. It is the
//! unit of consent: once a user (or policy) has allowed two sessions to talk,
//! messages flow freely both ways until the connection is closed. Individual
//! messages are not separately consented to.
//!
//! This module defines the persistent domain types only. The
//! `ConnectionService` trait that drives the lifecycle, the in-memory
//! implementation used in tests, and the local-socket bridge protocol that
//! agent CLIs speak to live in sibling modules. See
//! `docs/technical/inter-agent-connections.md` for the canonical design.
//!
//! Timestamps are ISO-8601 strings, matching `activity.rs`: this crate stays
//! free of any time-source dependency, and callers supply the current time at
//! every state transition. Tests can therefore pin time deterministically.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::SessionId;

pub type ConnectionId = Uuid;
pub type RequestId = Uuid;
pub type MessageId = Uuid;

/// Top-level connection state. Persisted alongside the rest of the connection
/// record so the dashboard and the activity stream can render history
/// uniformly. The shape mirrors the `state` column in the SQL sketch in
/// `inter-agent-connections.md`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    /// An agent has asked to open the connection; awaiting a decision.
    Requested,
    /// Both sides may now exchange messages.
    Open,
    /// The connection was opened at some point and is now severed; its
    /// transcript is preserved.
    Closed,
    /// The connection never opened: a request was declined or expired.
    Denied,
}

/// Who asked for this connection to exist.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConnectionInitiator {
    /// An agent CLI called `request_connection` from inside one of the
    /// participant sessions.
    Agent { session_id: SessionId },
    /// The user opened the connection directly from Reverie's UI; their intent
    /// is the consent and no accept banner was shown.
    User,
}

/// Who or what closed (or denied) the connection. Held as an enum so the
/// activity log can render the closure reason without a separate lookup.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConnectionClosedBy {
    /// One of the participant agents called `close_connection`.
    Agent { session_id: SessionId },
    /// The user clicked Disconnect or Deny.
    User,
    /// A participating session ended (process exited, terminated, etc.).
    SessionEnded { session_id: SessionId },
    /// The system closed the connection on its own. Used for request expiry
    /// and similar lifecycle-driven closures. `reason` is short and durable
    /// for replay in the activity log.
    Policy { reason: String },
}

/// Workspace-level (or focus-overridden) policy controlling how connection
/// requests are gated.
///
/// Cross-scope requests (cross-focus inside same project, cross-project
/// anywhere) always ask regardless of policy. That rule lives in the service
/// layer, not in this enum: the enum captures the *configured* policy at the
/// moment a connection was opened, so the activity log records what was in
/// effect even if the user later changes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionPolicy {
    AlwaysAsk,
    AutoAllowFocus,
    AutoAllowProject,
    AutoAllowWorkspace,
}

/// In-flight request metadata. Populated when `status == Requested` and
/// cleared (set to `None`) when the request resolves.
///
/// Held inline on `Connection` rather than as a separate persisted record so
/// the bridge's long-poll handler has a single source of truth. If the
/// desktop restarts while a request is pending, the agent's long-poll fails
/// closed and may retry; this trade-off is acceptable for v1.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRequest {
    pub request_id: RequestId,
    pub requested_at: String,
    pub expires_at: String,
}

/// Persistent record of a connection between two sessions.
///
/// `participant_a` and `participant_b` are not ordered by role: either may
/// have initiated. The participants are however held in canonical (sorted)
/// order so two attempts to open the same pair produce the same key. Use
/// [`Connection::other_participant`] to look up the peer from a known caller.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: ConnectionId,
    pub participant_a: SessionId,
    pub participant_b: SessionId,
    pub initiator: ConnectionInitiator,
    pub status: ConnectionStatus,
    pub reason_opened: String,
    pub policy_at_open: ConnectionPolicy,

    /// Short auto-derived (or user-edited) title shown in connection lists.
    /// Derived from `reason_opened` on open; either agent or the user may
    /// update it later.
    #[serde(default)]
    pub topic: Option<String>,

    /// When the connection record came into being. For agent-initiated
    /// connections this is the request time; for user-initiated it is the
    /// open time.
    pub created_at: String,

    /// When the request was accepted into `Open`. `None` while `Requested`
    /// or `Denied`; `Some(_)` once the connection has ever been open
    /// (including after a later close).
    #[serde(default)]
    pub accepted_at: Option<String>,

    /// When the connection moved to a terminal state (`Closed` or `Denied`).
    #[serde(default)]
    pub closed_at: Option<String>,

    /// Who closed or denied the connection. `None` only while not in a
    /// terminal state.
    #[serde(default)]
    pub closed_by: Option<ConnectionClosedBy>,

    /// Optional short prose explaining the closure. May be supplied by the
    /// closing agent, the user, or omitted.
    #[serde(default)]
    pub reason_closed: Option<String>,

    /// Populated only while `status == Requested`. Cleared on accept, deny,
    /// or expiry.
    #[serde(default)]
    pub pending_request: Option<PendingRequest>,

    /// Monotonic version of this record, incremented on every state change.
    /// Used by the UI to deduplicate event-driven refreshes and by tests to
    /// assert transition counts.
    pub sequence: u64,
}

/// A single message sent through an open connection. Held as its own record
/// so a connection's timeline survives independently of either participant
/// session's terminal transcript.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionMessage {
    pub id: MessageId,
    pub connection_id: ConnectionId,
    pub from_session: SessionId,
    pub to_session: SessionId,
    pub body: String,
    pub sent_at: String,
    #[serde(default)]
    pub delivered_at: Option<String>,
    pub sequence: u64,
}

/// Error returned when a transition is attempted from an incompatible state.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConnectionTransitionError {
    #[error("connection is in {actual:?}; expected {expected:?}")]
    UnexpectedStatus {
        expected: ConnectionStatus,
        actual: ConnectionStatus,
    },
}

impl Connection {
    /// Build a fresh agent-initiated connection in `Requested` state.
    ///
    /// `initiator` is the session whose agent called `request_connection`;
    /// `target` is the peer. The participants are stored in canonical order
    /// (sorted by UUID) so the same pair always maps to the same key shape,
    /// but `initiator` is preserved separately in `ConnectionInitiator`.
    pub fn agent_requested(
        initiator: SessionId,
        target: SessionId,
        reason: impl Into<String>,
        policy: ConnectionPolicy,
        request_id: RequestId,
        requested_at: impl Into<String>,
        expires_at: impl Into<String>,
    ) -> Self {
        let (participant_a, participant_b) = canonical_pair(initiator, target);
        let requested_at = requested_at.into();
        let reason: String = reason.into();
        let topic = derive_topic(&reason);
        Self {
            id: Uuid::new_v4(),
            participant_a,
            participant_b,
            initiator: ConnectionInitiator::Agent {
                session_id: initiator,
            },
            status: ConnectionStatus::Requested,
            reason_opened: reason,
            policy_at_open: policy,
            topic,
            created_at: requested_at.clone(),
            accepted_at: None,
            closed_at: None,
            closed_by: None,
            reason_closed: None,
            pending_request: Some(PendingRequest {
                request_id,
                requested_at,
                expires_at: expires_at.into(),
            }),
            sequence: 1,
        }
    }

    /// Build a fresh user-initiated connection directly in `Open` state.
    /// User intent is the consent, so no request flow is recorded.
    pub fn user_opened(
        a: SessionId,
        b: SessionId,
        reason: impl Into<String>,
        policy: ConnectionPolicy,
        opened_at: impl Into<String>,
    ) -> Self {
        let (participant_a, participant_b) = canonical_pair(a, b);
        let opened_at = opened_at.into();
        let reason: String = reason.into();
        let topic = derive_topic(&reason);
        Self {
            id: Uuid::new_v4(),
            participant_a,
            participant_b,
            initiator: ConnectionInitiator::User,
            status: ConnectionStatus::Open,
            reason_opened: reason,
            policy_at_open: policy,
            topic,
            created_at: opened_at.clone(),
            accepted_at: Some(opened_at),
            closed_at: None,
            closed_by: None,
            reason_closed: None,
            pending_request: None,
            sequence: 1,
        }
    }

    /// Promote a `Requested` connection to `Open`. Records `accepted_at` and
    /// clears the pending-request metadata. The caller is whoever made the
    /// decision (banner accept or auto-allow policy).
    pub fn accept(
        &mut self,
        accepted_at: impl Into<String>,
    ) -> Result<(), ConnectionTransitionError> {
        if self.status != ConnectionStatus::Requested {
            return Err(ConnectionTransitionError::UnexpectedStatus {
                expected: ConnectionStatus::Requested,
                actual: self.status,
            });
        }
        self.status = ConnectionStatus::Open;
        self.accepted_at = Some(accepted_at.into());
        self.pending_request = None;
        self.sequence += 1;
        Ok(())
    }

    /// Move a `Requested` connection to `Denied`. The connection never opened;
    /// no transcript is recorded.
    pub fn deny(
        &mut self,
        denied_at: impl Into<String>,
        closed_by: ConnectionClosedBy,
        reason: Option<String>,
    ) -> Result<(), ConnectionTransitionError> {
        if self.status != ConnectionStatus::Requested {
            return Err(ConnectionTransitionError::UnexpectedStatus {
                expected: ConnectionStatus::Requested,
                actual: self.status,
            });
        }
        self.status = ConnectionStatus::Denied;
        self.closed_at = Some(denied_at.into());
        self.closed_by = Some(closed_by);
        self.reason_closed = reason;
        self.pending_request = None;
        self.sequence += 1;
        Ok(())
    }

    /// Close an `Open` connection. Preserves the transcript, records who
    /// closed it and (optionally) a short reason.
    pub fn close(
        &mut self,
        closed_at: impl Into<String>,
        closed_by: ConnectionClosedBy,
        reason: Option<String>,
    ) -> Result<(), ConnectionTransitionError> {
        if self.status != ConnectionStatus::Open {
            return Err(ConnectionTransitionError::UnexpectedStatus {
                expected: ConnectionStatus::Open,
                actual: self.status,
            });
        }
        self.status = ConnectionStatus::Closed;
        self.closed_at = Some(closed_at.into());
        self.closed_by = Some(closed_by);
        self.reason_closed = reason;
        self.sequence += 1;
        Ok(())
    }

    /// Returns the peer of a known caller, or `None` if the caller is not a
    /// participant.
    pub fn other_participant(&self, caller: SessionId) -> Option<SessionId> {
        if self.participant_a == caller {
            Some(self.participant_b)
        } else if self.participant_b == caller {
            Some(self.participant_a)
        } else {
            None
        }
    }

    /// True if `session` is one of the two participants.
    pub fn involves(&self, session: SessionId) -> bool {
        self.participant_a == session || self.participant_b == session
    }

    /// True when the connection currently accepts inbound or outbound
    /// messages. `Requested`, `Closed`, and `Denied` all return false.
    pub fn is_open(&self) -> bool {
        matches!(self.status, ConnectionStatus::Open)
    }
}

fn canonical_pair(a: SessionId, b: SessionId) -> (SessionId, SessionId) {
    if a <= b { (a, b) } else { (b, a) }
}

/// Derive a short topic from the opening reason: trim, take the first line,
/// and cap at 80 chars. The full reason is preserved separately; `topic` is
/// purely a list-view label.
fn derive_topic(reason: &str) -> Option<String> {
    let first_line = reason.lines().next()?.trim();
    if first_line.is_empty() {
        return None;
    }
    const MAX: usize = 80;
    if first_line.len() <= MAX {
        Some(first_line.to_owned())
    } else {
        // Truncate on a char boundary to avoid splitting a multi-byte glyph.
        let cut = first_line
            .char_indices()
            .take_while(|(idx, _)| *idx < MAX - 1)
            .last()
            .map(|(idx, ch)| idx + ch.len_utf8())
            .unwrap_or(0);
        Some(format!("{}…", &first_line[..cut]))
    }
}

impl ConnectionMessage {
    /// Build a fresh outbound message record in `sent` state (not yet
    /// delivered). The service marks it delivered when the receiving side
    /// fetches it via `recv_from_connection`.
    pub fn new(
        connection_id: ConnectionId,
        from: SessionId,
        to: SessionId,
        body: impl Into<String>,
        sent_at: impl Into<String>,
        sequence: u64,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            connection_id,
            from_session: from,
            to_session: to,
            body: body.into(),
            sent_at: sent_at.into(),
            delivered_at: None,
            sequence,
        }
    }

    pub fn mark_delivered(&mut self, delivered_at: impl Into<String>) {
        self.delivered_at = Some(delivered_at.into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_id(byte: u8) -> SessionId {
        // Deterministic UUIDs for tests so canonical-pair ordering is stable.
        Uuid::from_bytes([byte; 16])
    }

    #[test]
    fn agent_requested_starts_in_requested_with_pending_metadata() {
        let alice = session_id(0x01);
        let bob = session_id(0x02);
        let request_id = Uuid::new_v4();
        let conn = Connection::agent_requested(
            alice,
            bob,
            "Hand off the protocol summary so Cortex can update the diagram.",
            ConnectionPolicy::AlwaysAsk,
            request_id,
            "2026-05-28T12:00:00.000Z",
            "2026-05-28T12:10:00.000Z",
        );

        assert_eq!(conn.status, ConnectionStatus::Requested);
        assert!(conn.is_open() == false);
        assert_eq!(conn.sequence, 1);
        assert_eq!(
            conn.initiator,
            ConnectionInitiator::Agent { session_id: alice }
        );
        let pending = conn.pending_request.as_ref().expect("pending populated");
        assert_eq!(pending.request_id, request_id);
        assert_eq!(pending.requested_at, "2026-05-28T12:00:00.000Z");
        assert_eq!(pending.expires_at, "2026-05-28T12:10:00.000Z");
        assert_eq!(conn.created_at, "2026-05-28T12:00:00.000Z");
        assert!(conn.accepted_at.is_none());
        assert!(conn.closed_at.is_none());
        assert_eq!(
            conn.topic.as_deref(),
            Some("Hand off the protocol summary so Cortex can update the diagram.")
        );
    }

    #[test]
    fn user_opened_skips_request_and_opens_directly() {
        let conn = Connection::user_opened(
            session_id(0x01),
            session_id(0x02),
            "User-initiated session pairing.",
            ConnectionPolicy::AlwaysAsk,
            "2026-05-28T12:00:00.000Z",
        );

        assert_eq!(conn.status, ConnectionStatus::Open);
        assert!(conn.is_open());
        assert_eq!(conn.initiator, ConnectionInitiator::User);
        assert!(conn.pending_request.is_none());
        assert_eq!(
            conn.accepted_at.as_deref(),
            Some("2026-05-28T12:00:00.000Z")
        );
    }

    #[test]
    fn participants_are_stored_in_canonical_order() {
        let small = session_id(0x01);
        let big = session_id(0xFF);

        let a = Connection::user_opened(small, big, "r", ConnectionPolicy::AlwaysAsk, "t");
        let b = Connection::user_opened(big, small, "r", ConnectionPolicy::AlwaysAsk, "t");

        assert_eq!(a.participant_a, small);
        assert_eq!(a.participant_b, big);
        assert_eq!(b.participant_a, small);
        assert_eq!(b.participant_b, big);
    }

    #[test]
    fn accept_transitions_requested_to_open() {
        let mut conn = Connection::agent_requested(
            session_id(0x01),
            session_id(0x02),
            "r",
            ConnectionPolicy::AlwaysAsk,
            Uuid::new_v4(),
            "t0",
            "t10",
        );

        conn.accept("t1").expect("accept from requested");
        assert_eq!(conn.status, ConnectionStatus::Open);
        assert_eq!(conn.accepted_at.as_deref(), Some("t1"));
        assert!(conn.pending_request.is_none());
        assert_eq!(conn.sequence, 2);
    }

    #[test]
    fn accept_refuses_when_not_requested() {
        let mut conn = Connection::user_opened(
            session_id(0x01),
            session_id(0x02),
            "r",
            ConnectionPolicy::AlwaysAsk,
            "t0",
        );

        let err = conn.accept("t1").unwrap_err();
        assert_eq!(
            err,
            ConnectionTransitionError::UnexpectedStatus {
                expected: ConnectionStatus::Requested,
                actual: ConnectionStatus::Open,
            }
        );
        // Sequence unchanged; record untouched.
        assert_eq!(conn.sequence, 1);
    }

    #[test]
    fn deny_moves_requested_to_denied_with_closer_metadata() {
        let mut conn = Connection::agent_requested(
            session_id(0x01),
            session_id(0x02),
            "r",
            ConnectionPolicy::AlwaysAsk,
            Uuid::new_v4(),
            "t0",
            "t10",
        );

        conn.deny("t1", ConnectionClosedBy::User, Some("not now".into()))
            .expect("deny from requested");
        assert_eq!(conn.status, ConnectionStatus::Denied);
        assert_eq!(conn.closed_at.as_deref(), Some("t1"));
        assert_eq!(conn.closed_by, Some(ConnectionClosedBy::User));
        assert_eq!(conn.reason_closed.as_deref(), Some("not now"));
        assert!(
            conn.accepted_at.is_none(),
            "denied connections never opened"
        );
        assert!(conn.pending_request.is_none());
    }

    #[test]
    fn deny_refuses_when_already_open() {
        let mut conn = Connection::user_opened(
            session_id(0x01),
            session_id(0x02),
            "r",
            ConnectionPolicy::AlwaysAsk,
            "t0",
        );
        let err = conn
            .deny("t1", ConnectionClosedBy::User, None)
            .expect_err("deny from open is invalid");
        assert!(matches!(
            err,
            ConnectionTransitionError::UnexpectedStatus {
                actual: ConnectionStatus::Open,
                ..
            }
        ));
    }

    #[test]
    fn close_preserves_accepted_at_and_records_closure() {
        let mut conn = Connection::user_opened(
            session_id(0x01),
            session_id(0x02),
            "r",
            ConnectionPolicy::AlwaysAsk,
            "t0",
        );
        let accepted = conn.accepted_at.clone();

        conn.close(
            "t5",
            ConnectionClosedBy::Agent {
                session_id: session_id(0x01),
            },
            Some("done".into()),
        )
        .expect("close from open");

        assert_eq!(conn.status, ConnectionStatus::Closed);
        assert_eq!(conn.accepted_at, accepted, "accepted_at preserved on close");
        assert_eq!(conn.closed_at.as_deref(), Some("t5"));
        assert!(
            matches!(conn.closed_by, Some(ConnectionClosedBy::Agent { .. })),
            "close_by records the closing participant"
        );
        assert_eq!(conn.sequence, 2);
    }

    #[test]
    fn close_refuses_when_already_closed() {
        let mut conn = Connection::user_opened(
            session_id(0x01),
            session_id(0x02),
            "r",
            ConnectionPolicy::AlwaysAsk,
            "t0",
        );
        conn.close("t5", ConnectionClosedBy::User, None).unwrap();
        let err = conn
            .close("t6", ConnectionClosedBy::User, None)
            .expect_err("double-close is invalid");
        assert!(matches!(
            err,
            ConnectionTransitionError::UnexpectedStatus {
                actual: ConnectionStatus::Closed,
                ..
            }
        ));
    }

    #[test]
    fn other_participant_resolves_peer_or_none() {
        let conn = Connection::user_opened(
            session_id(0x01),
            session_id(0x02),
            "r",
            ConnectionPolicy::AlwaysAsk,
            "t0",
        );
        assert_eq!(
            conn.other_participant(session_id(0x01)),
            Some(session_id(0x02))
        );
        assert_eq!(
            conn.other_participant(session_id(0x02)),
            Some(session_id(0x01))
        );
        assert_eq!(conn.other_participant(session_id(0x03)), None);
    }

    #[test]
    fn involves_checks_participation() {
        let conn = Connection::user_opened(
            session_id(0x01),
            session_id(0x02),
            "r",
            ConnectionPolicy::AlwaysAsk,
            "t0",
        );
        assert!(conn.involves(session_id(0x01)));
        assert!(conn.involves(session_id(0x02)));
        assert!(!conn.involves(session_id(0x03)));
    }

    #[test]
    fn message_records_delivery_timestamp_when_marked() {
        let conn_id = Uuid::new_v4();
        let mut msg = ConnectionMessage::new(
            conn_id,
            session_id(0x01),
            session_id(0x02),
            "hello",
            "t1",
            1,
        );
        assert!(msg.delivered_at.is_none());

        msg.mark_delivered("t2");
        assert_eq!(msg.delivered_at.as_deref(), Some("t2"));
        assert_eq!(msg.connection_id, conn_id);
        assert_eq!(msg.body, "hello");
    }

    #[test]
    fn connection_serializes_with_camel_case_wire_format() {
        let conn = Connection::agent_requested(
            session_id(0x01),
            session_id(0x02),
            "test reason",
            ConnectionPolicy::AutoAllowFocus,
            Uuid::from_bytes([0xAA; 16]),
            "2026-05-28T12:00:00.000Z",
            "2026-05-28T12:10:00.000Z",
        );

        let encoded = serde_json::to_value(&conn).expect("serializes");
        assert_eq!(encoded["status"], "requested");
        assert_eq!(encoded["policyAtOpen"], "auto_allow_focus");
        assert!(encoded.get("policy_at_open").is_none());
        assert_eq!(encoded["createdAt"], "2026-05-28T12:00:00.000Z");
        assert_eq!(encoded["participantA"].is_string(), true);
        assert_eq!(
            encoded["pendingRequest"]["requestedAt"],
            "2026-05-28T12:00:00.000Z"
        );
        assert_eq!(encoded["initiator"]["kind"], "agent");
        assert_eq!(encoded["sequence"], 1);
    }

    #[test]
    fn connection_round_trips_through_serde() {
        let mut conn = Connection::user_opened(
            session_id(0x01),
            session_id(0x02),
            "round trip",
            ConnectionPolicy::AutoAllowWorkspace,
            "t0",
        );
        conn.close(
            "t9",
            ConnectionClosedBy::SessionEnded {
                session_id: session_id(0x02),
            },
            Some("session ended".into()),
        )
        .unwrap();

        let json = serde_json::to_string(&conn).expect("serializes");
        let decoded: Connection = serde_json::from_str(&json).expect("round trips");
        assert_eq!(decoded, conn);
    }

    #[test]
    fn message_serializes_with_camel_case_wire_format() {
        let msg = ConnectionMessage::new(
            Uuid::from_bytes([0xBB; 16]),
            session_id(0x01),
            session_id(0x02),
            "hi there",
            "2026-05-28T12:00:00.000Z",
            7,
        );
        let encoded = serde_json::to_value(&msg).expect("serializes");
        assert_eq!(encoded["connectionId"].is_string(), true);
        assert_eq!(encoded["fromSession"].is_string(), true);
        assert_eq!(encoded["toSession"].is_string(), true);
        assert_eq!(encoded["sentAt"], "2026-05-28T12:00:00.000Z");
        assert_eq!(encoded["sequence"], 7);
        assert!(encoded.get("delivered_at").is_none());
    }

    #[test]
    fn topic_truncates_at_eighty_chars_on_char_boundary() {
        let long = "x".repeat(200);
        let conn = Connection::user_opened(
            session_id(0x01),
            session_id(0x02),
            long.as_str(),
            ConnectionPolicy::AlwaysAsk,
            "t0",
        );
        let topic = conn.topic.expect("topic derived");
        assert!(
            topic.ends_with('…'),
            "topic ends with ellipsis when truncated"
        );
        // 79 x's + ellipsis = 80 chars / 82 bytes (… is 3 bytes UTF-8).
        assert_eq!(topic.chars().count(), 80);
    }

    #[test]
    fn topic_takes_only_the_first_line_of_reason() {
        let conn = Connection::user_opened(
            session_id(0x01),
            session_id(0x02),
            "Short topic line\nWith additional context that should not appear.",
            ConnectionPolicy::AlwaysAsk,
            "t0",
        );
        assert_eq!(conn.topic.as_deref(), Some("Short topic line"));
    }

    #[test]
    fn topic_is_none_for_empty_reason() {
        let conn = Connection::user_opened(
            session_id(0x01),
            session_id(0x02),
            "   \n   ",
            ConnectionPolicy::AlwaysAsk,
            "t0",
        );
        assert!(conn.topic.is_none());
    }
}
