//! Wire protocol for the inter-agent connection bridge.
//!
//! The desktop process listens on a local socket; the `reverie-bridge` helper
//! binary (spawned as a stdio MCP server child of each agent CLI) connects to
//! that socket and tunnels MCP tool calls into desktop-side
//! [`ConnectionService`](crate::connection_service::ConnectionService) calls.
//! This module defines the wire format only. Transport (Unix sockets, named
//! pipes) and dispatch live in the helper crate and the desktop respectively.
//!
//! ## Frame format
//!
//! Newline-delimited JSON (NDJSON): one complete JSON object per `\n`-
//! terminated line, no embedded literal newlines. Lines must be valid UTF-8
//! and parse as a [`BridgeMessage`]. Implementations MUST set a generous
//! per-line ceiling (default 1 MiB) and MUST treat oversize lines as a
//! protocol error.
//!
//! ## Message shapes
//!
//! The protocol piggybacks on the JSON-RPC 2.0 shape because it is well
//! understood and matches MCP's transport. Three variants:
//!
//! - [`BridgeRequest`]: a numbered `id`, a `method`, typed `params`. The
//!   receiver MUST reply with a matching [`BridgeResponse`].
//! - [`BridgeResponse`]: the same `id`, exactly one of `result` or `error`.
//! - [`BridgeNotification`]: no `id`, no response expected. Used for
//!   server-pushed progress notifications during long-poll waits.
//!
//! ## Methods
//!
//! Every connection MUST issue [`methods::HANDSHAKE`] as its first request.
//! Subsequent requests are authenticated implicitly: the connection's
//! authenticated session id is whoever passed handshake. Failed handshakes
//! return [`error_codes::AUTH_FAILED`].
//!
//! The other methods correspond one-for-one to [`ConnectionService`] entry
//! points; see [`methods`] for names and the typed param/result structs in
//! this module for shapes.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::connection::{Connection, ConnectionId, ConnectionMessage, MessageId, RequestId};
use crate::connection_service::{PeerScope, PeerView, RequestOutcome, SessionAddress, WaitOutcome};
use crate::domain::SessionId;

/// JSON-RPC version string used in every frame.
pub const JSONRPC_VERSION: &str = "2.0";

/// Default frame ceiling, in bytes. Implementations may raise this for
/// debugging but must enforce a hard upper bound.
pub const DEFAULT_MAX_LINE_BYTES: usize = 1 << 20;

/// Top-level frame on the wire. Three variants distinguished by whether `id`
/// and `method` are present.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BridgeMessage {
    Request(BridgeRequest),
    Response(BridgeResponse),
    Notification(BridgeNotification),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BridgeRequest {
    pub jsonrpc: String,
    pub id: i64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BridgeResponse {
    pub jsonrpc: String,
    pub id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BridgeError>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BridgeNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// Structured error payload. Matches JSON-RPC 2.0's `error` object.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BridgeError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl BridgeRequest {
    pub fn new<P: Serialize>(id: i64, method: impl Into<String>, params: &P) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id,
            method: method.into(),
            params: serde_json::to_value(params).unwrap_or(Value::Null),
        }
    }
}

impl BridgeResponse {
    pub fn ok<R: Serialize>(id: i64, result: &R) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id,
            result: Some(serde_json::to_value(result).unwrap_or(Value::Null)),
            error: None,
        }
    }

    pub fn err(id: i64, error: BridgeError) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id,
            result: None,
            error: Some(error),
        }
    }

    pub fn is_ok(&self) -> bool {
        self.error.is_none()
    }
}

impl BridgeNotification {
    pub fn new<P: Serialize>(method: impl Into<String>, params: &P) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            method: method.into(),
            params: serde_json::to_value(params).unwrap_or(Value::Null),
        }
    }
}

impl BridgeError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data<D: Serialize>(mut self, data: &D) -> Self {
        self.data = serde_json::to_value(data).ok();
        self
    }
}

/// Error codes. JSON-RPC reserves `-32768..=-32000` for protocol use; we
/// stay above `-32000` for bridge-specific codes per spec convention.
pub mod error_codes {
    /// `-32700`. The peer sent a frame that did not parse as JSON.
    pub const PARSE_ERROR: i32 = -32700;
    /// `-32600`. The frame parsed but did not match the JSON-RPC shape.
    pub const INVALID_REQUEST: i32 = -32600;
    /// `-32601`. The method name is not recognized.
    pub const METHOD_NOT_FOUND: i32 = -32601;
    /// `-32602`. The params shape did not match what the method expects.
    pub const INVALID_PARAMS: i32 = -32602;
    /// `-32603`. The server encountered an internal error.
    pub const INTERNAL_ERROR: i32 = -32603;

    // Bridge-specific (-32000 to -32099 reserved by spec for server errors).
    /// `-32001`. Handshake failed (unknown session id or wrong secret).
    pub const AUTH_FAILED: i32 = -32001;
    /// `-32002`. A request arrived before [`super::methods::HANDSHAKE`] succeeded.
    pub const HANDSHAKE_REQUIRED: i32 = -32002;
    /// `-32003`. A referenced entity (session, connection, request, message)
    /// does not exist.
    pub const NOT_FOUND: i32 = -32003;
    /// `-32004`. A request id has already been accepted or denied.
    pub const ALREADY_DECIDED: i32 = -32004;
    /// `-32005`. Operation rejected because the connection is not Open.
    pub const CONNECTION_NOT_OPEN: i32 = -32005;
    /// `-32006`. Caller is not a participant of the named connection.
    pub const NOT_A_PARTICIPANT: i32 = -32006;
    /// `-32007`. A target session is not currently registered with the bridge.
    pub const TARGET_NOT_REGISTERED: i32 = -32007;
    /// `-32008`. Defensive: caller attempted a self-connection.
    pub const SELF_CONNECTION: i32 = -32008;
    /// `-32009`. A wait timed out on the server side.
    pub const WAIT_TIMEOUT: i32 = -32009;
}

/// Method names. Use these constants on both ends so a typo is a compile error
/// rather than a runtime mismatch.
pub mod methods {
    pub const HANDSHAKE: &str = "handshake";
    pub const LIST_PEERS: &str = "list_peers";
    pub const PEER_STATUS: &str = "peer_status";
    pub const REQUEST_CONNECTION: &str = "request_connection";
    pub const WAIT_FOR_DECISION: &str = "wait_for_decision";
    pub const POLL_DECISION: &str = "poll_decision";
    pub const SEND_MESSAGE: &str = "send_message";
    pub const PENDING_MESSAGES: &str = "pending_messages";
    pub const CLOSE_CONNECTION: &str = "close_connection";
    pub const LIST_CONNECTIONS: &str = "list_connections";
    pub const GET_CONNECTION: &str = "get_connection";
}

/// Notification names emitted by the desktop to bridge clients. The only one
/// in v1 is `progress`, sent periodically during long [`methods::WAIT_FOR_DECISION`]
/// calls so any progress-aware MCP client can render a "still waiting"
/// indicator instead of going silent.
pub mod notifications {
    pub const PROGRESS: &str = "progress";
}

// ---------------------------------------------------------------------------
// Typed params and results, one struct per method.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeParams {
    pub session_id: SessionId,
    pub secret: String,
    /// Optional protocol version the helper believes it speaks. Reserved for
    /// future use; v1 implementations should send `1` and the desktop should
    /// accept any value, returning its own version in [`HandshakeResult`].
    #[serde(default)]
    pub protocol_version: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeResult {
    pub address: SessionAddress,
    /// Protocol version the desktop will speak on this connection.
    pub protocol_version: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPeersParams {
    #[serde(default)]
    pub scope: Option<PeerScope>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPeersResult {
    pub peers: Vec<PeerView>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerStatusParams {
    pub peer_session_id: SessionId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerStatusResult {
    /// Null if the peer is not currently registered or not visible to the
    /// caller under the workspace policy.
    pub peer: Option<PeerView>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestConnectionParams {
    pub target_session_id: SessionId,
    pub reason: String,
    /// Wall-clock window the desktop should consider the request alive for,
    /// in milliseconds. The desktop derives `expires_at` from this and its
    /// own clock; the helper supplies no timestamp.
    pub ttl_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestConnectionResult {
    pub outcome: RequestOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitForDecisionParams {
    pub request_id: RequestId,
    /// How long to block before returning [`WaitOutcome::Timeout`].
    /// Implementations should set this comfortably under the client's
    /// MCP tool timeout to leave time for graceful return.
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitForDecisionResult {
    pub outcome: WaitOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollDecisionParams {
    pub request_id: RequestId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollDecisionResult {
    /// `None` if the request is still waiting on a user decision.
    pub outcome: Option<WaitOutcome>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageParams {
    pub connection_id: ConnectionId,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageResult {
    pub message_id: MessageId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMessagesParams {
    pub connection_id: ConnectionId,
    /// Caller's last-seen `sequence`. Pass `0` to fetch the full inbound
    /// transcript on this connection.
    #[serde(default)]
    pub since_sequence: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMessagesResult {
    pub messages: Vec<ConnectionMessage>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseConnectionParams {
    pub connection_id: ConnectionId,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloseConnectionResult {}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListConnectionsParams {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListConnectionsResult {
    pub connections: Vec<Connection>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetConnectionParams {
    pub connection_id: ConnectionId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetConnectionResult {
    pub connection: Option<Connection>,
}

/// Payload of [`notifications::PROGRESS`]. Sent by the desktop during long
/// [`methods::WAIT_FOR_DECISION`] calls so a progress-aware MCP client can
/// surface "still waiting" without timing out silently.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressNotification {
    /// Correlates with the in-flight request id. The helper uses this to
    /// forward progress to the right MCP `progressToken`.
    pub request_id: i64,
    pub message: String,
    /// Sequence number of this progress notification within the request.
    /// Starts at 1, monotonically increasing.
    pub sequence: u64,
}

// ---------------------------------------------------------------------------
// NDJSON framing helpers.
// ---------------------------------------------------------------------------

/// Serialize a [`BridgeMessage`] into a single NDJSON line (without the
/// trailing newline). Writers MUST append `\n` to the returned buffer.
pub fn encode_line(message: &BridgeMessage) -> Result<String, serde_json::Error> {
    serde_json::to_string(message)
}

/// Parse a single NDJSON line into a [`BridgeMessage`]. The line MUST NOT
/// contain the trailing newline.
pub fn decode_line(line: &str) -> Result<BridgeMessage, serde_json::Error> {
    serde_json::from_str(line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::ConnectionPolicy;
    use crate::connection_service::PeerScope;
    use crate::domain::AgentKind;
    use uuid::Uuid;

    fn fake_address() -> SessionAddress {
        SessionAddress {
            agent_kind: AgentKind::ClaudeCode,
            project_id: None,
            project_name: None,
            focus_id: Uuid::from_bytes([0x10; 16]),
            focus_title: "General".to_owned(),
            session_title: "Claude".to_owned(),
        }
    }

    fn fake_session() -> SessionId {
        Uuid::from_bytes([0x01; 16])
    }

    #[test]
    fn round_trip_request_response_pair() {
        let req = BridgeRequest::new(
            7,
            methods::LIST_PEERS,
            &ListPeersParams {
                scope: Some(PeerScope::Focus),
            },
        );

        let line = encode_line(&BridgeMessage::Request(req.clone())).unwrap();
        assert!(!line.contains('\n'), "encode_line MUST NOT embed newlines");

        match decode_line(&line).unwrap() {
            BridgeMessage::Request(decoded) => {
                assert_eq!(decoded.id, 7);
                assert_eq!(decoded.method, methods::LIST_PEERS);
                let params: ListPeersParams = serde_json::from_value(decoded.params).unwrap();
                assert_eq!(params.scope, Some(PeerScope::Focus));
            }
            other => panic!("expected Request, got {other:?}"),
        }

        let resp = BridgeResponse::ok(
            7,
            &ListPeersResult {
                peers: vec![PeerView {
                    session_id: fake_session(),
                    address: fake_address(),
                    current_activity: None,
                    current_summary: None,
                    open_connection_id: None,
                }],
            },
        );
        let line = encode_line(&BridgeMessage::Response(resp.clone())).unwrap();
        match decode_line(&line).unwrap() {
            BridgeMessage::Response(decoded) => {
                assert_eq!(decoded.id, 7);
                assert!(decoded.is_ok());
                let result: ListPeersResult =
                    serde_json::from_value(decoded.result.unwrap()).unwrap();
                assert_eq!(result.peers.len(), 1);
                assert_eq!(result.peers[0].session_id, fake_session());
            }
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[test]
    fn untagged_dispatch_distinguishes_request_response_notification() {
        let req_line = encode_line(&BridgeMessage::Request(BridgeRequest::new(
            1,
            methods::HANDSHAKE,
            &HandshakeParams {
                session_id: fake_session(),
                secret: "s".into(),
                protocol_version: Some(1),
            },
        )))
        .unwrap();
        let resp_line = encode_line(&BridgeMessage::Response(BridgeResponse::ok(
            1,
            &HandshakeResult {
                address: fake_address(),
                protocol_version: 1,
            },
        )))
        .unwrap();
        let notif_line = encode_line(&BridgeMessage::Notification(BridgeNotification::new(
            notifications::PROGRESS,
            &ProgressNotification {
                request_id: 1,
                message: "still waiting".into(),
                sequence: 1,
            },
        )))
        .unwrap();

        assert!(matches!(
            decode_line(&req_line).unwrap(),
            BridgeMessage::Request(_)
        ));
        assert!(matches!(
            decode_line(&resp_line).unwrap(),
            BridgeMessage::Response(_)
        ));
        assert!(matches!(
            decode_line(&notif_line).unwrap(),
            BridgeMessage::Notification(_)
        ));
    }

    #[test]
    fn error_response_carries_code_and_message() {
        let resp =
            BridgeResponse::err(42, BridgeError::new(error_codes::AUTH_FAILED, "bad secret"));
        let line = encode_line(&BridgeMessage::Response(resp)).unwrap();
        let parsed = decode_line(&line).unwrap();
        match parsed {
            BridgeMessage::Response(decoded) => {
                assert!(!decoded.is_ok());
                let err = decoded.error.unwrap();
                assert_eq!(err.code, error_codes::AUTH_FAILED);
                assert_eq!(err.message, "bad secret");
                assert!(err.data.is_none());
            }
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[test]
    fn error_data_attaches_additional_context() {
        #[derive(Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ConflictDetail {
            existing_connection_id: ConnectionId,
        }
        let err = BridgeError::new(error_codes::CONNECTION_NOT_OPEN, "already open").with_data(
            &ConflictDetail {
                existing_connection_id: Uuid::from_bytes([0xAA; 16]),
            },
        );
        assert_eq!(err.code, error_codes::CONNECTION_NOT_OPEN);
        let detail = err.data.expect("data populated");
        assert!(detail.get("existingConnectionId").is_some());
    }

    #[test]
    fn handshake_params_serialize_camel_case() {
        let params = HandshakeParams {
            session_id: fake_session(),
            secret: "deadbeef".into(),
            protocol_version: Some(1),
        };
        let json = serde_json::to_value(&params).unwrap();
        assert!(json.get("sessionId").is_some());
        assert!(json.get("protocolVersion").is_some());
        assert!(json.get("session_id").is_none());
    }

    #[test]
    fn request_outcome_pending_round_trips() {
        let outcome = RequestOutcome::Pending {
            connection_id: Uuid::from_bytes([0xBB; 16]),
            request_id: Uuid::from_bytes([0xCC; 16]),
        };
        let result = RequestConnectionResult { outcome };
        let resp = BridgeResponse::ok(11, &result);
        let line = encode_line(&BridgeMessage::Response(resp)).unwrap();
        let parsed = decode_line(&line).unwrap();
        match parsed {
            BridgeMessage::Response(decoded) => {
                let decoded_result: RequestConnectionResult =
                    serde_json::from_value(decoded.result.unwrap()).unwrap();
                match decoded_result.outcome {
                    RequestOutcome::Pending { .. } => {}
                    other => panic!("expected Pending, got {other:?}"),
                }
            }
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[test]
    fn wait_outcome_allowed_and_timeout_serialize_distinctly() {
        let allowed = WaitOutcome::Allowed {
            connection_id: Uuid::from_bytes([0xDD; 16]),
        };
        let timeout = WaitOutcome::Timeout;
        let allowed_json = serde_json::to_value(&allowed).unwrap();
        let timeout_json = serde_json::to_value(&timeout).unwrap();
        assert_eq!(allowed_json["kind"], "allowed");
        assert!(allowed_json.get("connectionId").is_some());
        assert_eq!(timeout_json["kind"], "timeout");
        assert!(timeout_json.get("connectionId").is_none());
    }

    #[test]
    fn pending_messages_params_defaults_since_to_zero() {
        // Omitting sinceSequence on the wire should decode as 0.
        let line = r#"{"connectionId":"deadbeef-dead-beef-dead-beefdeadbeef"}"#;
        let params: PendingMessagesParams = serde_json::from_str(line).unwrap();
        assert_eq!(params.since_sequence, 0);
    }

    #[test]
    fn close_connection_params_accepts_omitted_reason() {
        let line = r#"{"connectionId":"deadbeef-dead-beef-dead-beefdeadbeef"}"#;
        let params: CloseConnectionParams = serde_json::from_str(line).unwrap();
        assert!(params.reason.is_none());
    }

    #[test]
    fn progress_notification_round_trips() {
        let notif = BridgeNotification::new(
            notifications::PROGRESS,
            &ProgressNotification {
                request_id: 42,
                message: "waiting on user".into(),
                sequence: 3,
            },
        );
        let line = encode_line(&BridgeMessage::Notification(notif)).unwrap();
        match decode_line(&line).unwrap() {
            BridgeMessage::Notification(decoded) => {
                assert_eq!(decoded.method, notifications::PROGRESS);
                let payload: ProgressNotification = serde_json::from_value(decoded.params).unwrap();
                assert_eq!(payload.request_id, 42);
                assert_eq!(payload.sequence, 3);
            }
            other => panic!("expected Notification, got {other:?}"),
        }
    }

    #[test]
    fn decode_rejects_invalid_json() {
        assert!(decode_line("{not json").is_err());
    }

    #[test]
    fn encoded_line_has_no_embedded_newlines_even_for_unicode_body() {
        let req = BridgeRequest::new(
            1,
            methods::SEND_MESSAGE,
            &SendMessageParams {
                connection_id: Uuid::from_bytes([0xFF; 16]),
                body: "hello\nworld\ncafé 🚀".into(),
            },
        );
        let line = encode_line(&BridgeMessage::Request(req)).unwrap();
        // serde_json escapes embedded newlines as `\n`, so the line itself
        // must not contain a literal newline.
        assert!(!line.contains('\n'));
    }

    #[test]
    fn methods_and_error_codes_compile_as_constants() {
        // Touch the constants so a typo at definition time becomes a build
        // error rather than a silent runtime mismatch.
        let _ = methods::HANDSHAKE;
        let _ = methods::LIST_PEERS;
        let _ = methods::PEER_STATUS;
        let _ = methods::REQUEST_CONNECTION;
        let _ = methods::WAIT_FOR_DECISION;
        let _ = methods::POLL_DECISION;
        let _ = methods::SEND_MESSAGE;
        let _ = methods::PENDING_MESSAGES;
        let _ = methods::CLOSE_CONNECTION;
        let _ = methods::LIST_CONNECTIONS;
        let _ = methods::GET_CONNECTION;
        let _ = error_codes::PARSE_ERROR;
        let _ = error_codes::AUTH_FAILED;
        let _ = error_codes::HANDSHAKE_REQUIRED;
        let _ = error_codes::NOT_FOUND;
        let _ = error_codes::ALREADY_DECIDED;
        let _ = error_codes::CONNECTION_NOT_OPEN;
        let _ = error_codes::NOT_A_PARTICIPANT;
        let _ = error_codes::TARGET_NOT_REGISTERED;
        let _ = error_codes::SELF_CONNECTION;
        let _ = error_codes::WAIT_TIMEOUT;
        let _ = notifications::PROGRESS;
    }

    #[test]
    fn unicode_handshake_secret_survives_round_trip() {
        let params = HandshakeParams {
            session_id: fake_session(),
            secret: "🦀-secret".to_owned(),
            protocol_version: Some(1),
        };
        let line = encode_line(&BridgeMessage::Request(BridgeRequest::new(
            1,
            methods::HANDSHAKE,
            &params,
        )))
        .unwrap();
        let parsed = decode_line(&line).unwrap();
        if let BridgeMessage::Request(req) = parsed {
            let decoded: HandshakeParams = serde_json::from_value(req.params).unwrap();
            assert_eq!(decoded.secret, "🦀-secret");
        } else {
            panic!("expected request");
        }
    }

    #[test]
    fn unknown_wait_outcome_variant_is_rejected() {
        // Forward compatibility check: if the desktop ever ships a new variant
        // (e.g. "expired"), older helpers should fail loudly rather than
        // silently misinterpret. This locks in serde's default behavior.
        let json = r#"{"kind":"expired"}"#;
        assert!(serde_json::from_str::<WaitOutcome>(json).is_err());
    }

    #[test]
    fn unused_imports_compile() {
        // Ensures ConnectionPolicy and other re-exports stay touched so the
        // protocol module's type surface remains coherent with the rest of
        // the crate.
        let _ = ConnectionPolicy::AlwaysAsk;
    }
}
