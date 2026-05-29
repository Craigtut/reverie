//! Server-side dispatch for the inter-agent connection bridge.
//!
//! The desktop runs this on its end of each Unix-socket connection from a
//! `reverie-bridge` helper. The wire format is the JSON-RPC 2.0 NDJSON shape
//! defined in [`crate::bridge_protocol`]. Dispatch flows are:
//!
//! 1. [`handle_handshake`] consumes the very first frame, validates the
//!    presented session id + secret against
//!    [`ConnectionService::authenticate`], and returns the [`BridgeSession`]
//!    every subsequent request must carry as its authenticated identity.
//! 2. [`dispatch_request`] maps each subsequent [`BridgeRequest`] to a
//!    [`ConnectionService`] call and produces a [`BridgeResponse`]. It is
//!    pure with respect to IO (it takes a `&dyn Clock`) so it is exhaustively
//!    unit-testable without sockets.
//! 3. [`serve_connection`] is the transport-bound wrapper that glues the two
//!    together: read a line, parse a [`BridgeMessage`], dispatch, write the
//!    response. One call drives one connection; the desktop spawns a thread
//!    per accepted socket.
//!
//! Long-poll: [`ConnectionService::wait_for_decision`] blocks the dispatch
//! thread for up to its configured timeout. Each helper has its own thread
//! per Unix-socket connection, so a blocked wait does not starve other
//! sessions. v1 does not emit `notifications/progress` during the wait; that
//! comes in P2 alongside Codex/Claude integration.

use std::io::{BufRead, Write};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::bridge_protocol::{
    BridgeError, BridgeMessage, BridgeRequest, BridgeResponse, CloseConnectionParams,
    CloseConnectionResult, DEFAULT_MAX_LINE_BYTES, GetConnectionParams, GetConnectionResult,
    HandshakeParams, HandshakeResult, ListConnectionsParams, ListConnectionsResult,
    ListPeersParams, ListPeersResult, PeerStatusParams, PeerStatusResult, PendingMessagesParams,
    PendingMessagesResult, PollDecisionParams, PollDecisionResult, RequestConnectionParams,
    RequestConnectionResult, SendMessageParams, SendMessageResult, WaitForDecisionParams,
    WaitForDecisionResult, decode_line, encode_line, error_codes, methods,
};
use crate::connection_service::{ConnectionCaller, ConnectionService, PeerScope, SessionAddress};
use crate::domain::SessionId;

/// Protocol version this server speaks. Returned in [`HandshakeResult`] so
/// helpers can choose their behavior. Bumped only on breaking wire changes.
pub const PROTOCOL_VERSION: u32 = 1;

/// Clock abstraction so dispatch stays pure for tests. The desktop wires this
/// to [`SystemClock`]; tests use [`FixedClock`] or similar to pin time.
pub trait Clock: Send + Sync {
    /// Current wall-clock time in ISO-8601 UTC ("YYYY-MM-DDTHH:MM:SSZ").
    fn now_iso8601(&self) -> String;

    /// ISO-8601 timestamp that is `ttl_ms` milliseconds in the future.
    /// Default implementation builds on [`Clock::now_iso8601`]; impls may
    /// override for higher precision.
    fn iso8601_after(&self, ttl_ms: u64) -> String;
}

/// Real clock used by the desktop. Format mirrors `hook_server::now_iso8601`
/// so timestamps written by this module and the hook server sort identically.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_iso8601(&self) -> String {
        let secs = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format_iso8601_utc(secs)
    }

    fn iso8601_after(&self, ttl_ms: u64) -> String {
        // Round up so sub-second TTLs do not produce an expires_at equal
        // to now. Important for tight test windows; harmless for the
        // typical multi-second human-decision windows agents pass.
        let bump = (ttl_ms + 999) / 1000;
        let secs = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
            .saturating_add(bump);
        format_iso8601_utc(secs)
    }
}

/// Deterministic clock for tests. Returns `now` from [`Clock::now_iso8601`]
/// and `now + ttl_ms` as an opaque-string "after" timestamp (tests should
/// pass a base time string and a clear ttl).
#[derive(Clone, Debug)]
pub struct FixedClock {
    pub base: String,
}

impl FixedClock {
    pub fn new(base: impl Into<String>) -> Self {
        Self { base: base.into() }
    }
}

impl Clock for FixedClock {
    fn now_iso8601(&self) -> String {
        self.base.clone()
    }
    fn iso8601_after(&self, ttl_ms: u64) -> String {
        format!("{}+{ttl_ms}ms", self.base)
    }
}

fn format_iso8601_utc(secs: u64) -> String {
    let (year, month, day, hour, minute, second) = unix_secs_to_ymdhms(secs);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn unix_secs_to_ymdhms(mut secs: u64) -> (u64, u32, u32, u32, u32, u32) {
    let second = (secs % 60) as u32;
    secs /= 60;
    let minute = (secs % 60) as u32;
    secs /= 60;
    let hour = (secs % 24) as u32;
    let mut days = secs / 24;
    let mut year: u64 = 1970;
    loop {
        let leap = is_leap_year(year);
        let year_days = if leap { 366 } else { 365 };
        if days < year_days {
            break;
        }
        days -= year_days;
        year += 1;
    }
    let leap = is_leap_year(year);
    let month_lengths = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month: u32 = 1;
    for (idx, length) in month_lengths.iter().enumerate() {
        if days < *length as u64 {
            month = idx as u32 + 1;
            break;
        }
        days -= *length as u64;
    }
    let day = days as u32 + 1;
    (year, month, day, hour, minute, second)
}

fn is_leap_year(year: u64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Identity for an authenticated bridge client. Produced by
/// [`handle_handshake`] on success; required as input to [`dispatch_request`].
/// Holding the address inline avoids a `ConnectionService::authenticate`
/// round-trip on every request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BridgeSession {
    pub session_id: SessionId,
    pub address: SessionAddress,
}

/// Result of validating a handshake frame. The caller installs the
/// [`BridgeSession`] when present and rejects future requests on this stream
/// when absent.
#[derive(Debug)]
pub struct HandshakeOutcome {
    pub response: BridgeResponse,
    pub session: Option<BridgeSession>,
}

/// Validate a handshake frame and produce a response plus the
/// [`BridgeSession`] for subsequent dispatches. Returns the failure response
/// with `session = None` if the handshake is rejected.
pub fn handle_handshake(service: &ConnectionService, request: &BridgeRequest) -> HandshakeOutcome {
    if request.method != methods::HANDSHAKE {
        return HandshakeOutcome {
            response: BridgeResponse::err(
                request.id,
                BridgeError::new(
                    error_codes::HANDSHAKE_REQUIRED,
                    format!(
                        "first request on a bridge connection must be `{}`, got `{}`",
                        methods::HANDSHAKE,
                        request.method
                    ),
                ),
            ),
            session: None,
        };
    }

    let params: HandshakeParams = match decode_params(&request.params) {
        Ok(params) => params,
        Err(err) => {
            return HandshakeOutcome {
                response: BridgeResponse::err(request.id, err),
                session: None,
            };
        }
    };

    match service.authenticate(params.session_id, &params.secret) {
        Ok(address) => HandshakeOutcome {
            response: BridgeResponse::ok(
                request.id,
                &HandshakeResult {
                    address: address.clone(),
                    protocol_version: PROTOCOL_VERSION,
                },
            ),
            session: Some(BridgeSession {
                session_id: params.session_id,
                address,
            }),
        },
        Err(err) => HandshakeOutcome {
            response: BridgeResponse::err(
                request.id,
                BridgeError::new(error_codes::AUTH_FAILED, err.to_string()),
            ),
            session: None,
        },
    }
}

/// Dispatch a single authenticated request. Returns the response to send
/// back. The caller is responsible for writing it to the wire.
///
/// All errors raised by [`ConnectionService`] are translated to JSON-RPC
/// errors with bridge-specific codes from [`error_codes`]; the caller never
/// sees raw `anyhow::Error` text on the wire.
pub fn dispatch_request(
    service: &ConnectionService,
    clock: &dyn Clock,
    session: &BridgeSession,
    request: &BridgeRequest,
) -> BridgeResponse {
    match request.method.as_str() {
        methods::HANDSHAKE => BridgeResponse::err(
            request.id,
            BridgeError::new(
                error_codes::INVALID_REQUEST,
                "handshake already completed on this connection",
            ),
        ),
        methods::LIST_PEERS => dispatch_list_peers(service, session, request),
        methods::PEER_STATUS => dispatch_peer_status(service, session, request),
        methods::REQUEST_CONNECTION => {
            dispatch_request_connection(service, clock, session, request)
        }
        methods::WAIT_FOR_DECISION => dispatch_wait_for_decision(service, session, request),
        methods::POLL_DECISION => dispatch_poll_decision(service, session, request),
        methods::SEND_MESSAGE => dispatch_send_message(service, clock, session, request),
        methods::PENDING_MESSAGES => dispatch_pending_messages(service, clock, session, request),
        methods::CLOSE_CONNECTION => dispatch_close_connection(service, clock, session, request),
        methods::LIST_CONNECTIONS => dispatch_list_connections(service, session, request),
        methods::GET_CONNECTION => dispatch_get_connection(service, session, request),
        unknown => BridgeResponse::err(
            request.id,
            BridgeError::new(
                error_codes::METHOD_NOT_FOUND,
                format!("unknown method: {unknown}"),
            ),
        ),
    }
}

fn dispatch_list_peers(
    service: &ConnectionService,
    session: &BridgeSession,
    request: &BridgeRequest,
) -> BridgeResponse {
    let params: ListPeersParams = match decode_params(&request.params) {
        Ok(params) => params,
        Err(err) => return BridgeResponse::err(request.id, err),
    };
    let scope = params.scope.unwrap_or(PeerScope::Focus);
    match service.list_peers(session.session_id, scope) {
        Ok(peers) => BridgeResponse::ok(request.id, &ListPeersResult { peers }),
        Err(err) => BridgeResponse::err(
            request.id,
            BridgeError::new(error_codes::INTERNAL_ERROR, err.to_string()),
        ),
    }
}

fn dispatch_peer_status(
    service: &ConnectionService,
    session: &BridgeSession,
    request: &BridgeRequest,
) -> BridgeResponse {
    let params: PeerStatusParams = match decode_params(&request.params) {
        Ok(params) => params,
        Err(err) => return BridgeResponse::err(request.id, err),
    };
    match service.peer_status(session.session_id, params.peer_session_id) {
        Ok(peer) => BridgeResponse::ok(request.id, &PeerStatusResult { peer }),
        Err(err) => BridgeResponse::err(
            request.id,
            BridgeError::new(error_codes::INTERNAL_ERROR, err.to_string()),
        ),
    }
}

fn dispatch_request_connection(
    service: &ConnectionService,
    clock: &dyn Clock,
    session: &BridgeSession,
    request: &BridgeRequest,
) -> BridgeResponse {
    let params: RequestConnectionParams = match decode_params(&request.params) {
        Ok(params) => params,
        Err(err) => return BridgeResponse::err(request.id, err),
    };
    let now = clock.now_iso8601();
    let expires_at = clock.iso8601_after(params.ttl_ms);
    match service.request_connection(
        session.session_id,
        params.target_session_id,
        params.reason,
        now,
        expires_at,
    ) {
        Ok(outcome) => BridgeResponse::ok(request.id, &RequestConnectionResult { outcome }),
        Err(err) => {
            let message = err.to_string();
            let code = if message.contains("own session") {
                error_codes::SELF_CONNECTION
            } else if message.contains("not registered") {
                error_codes::TARGET_NOT_REGISTERED
            } else {
                error_codes::INTERNAL_ERROR
            };
            BridgeResponse::err(request.id, BridgeError::new(code, message))
        }
    }
}

fn dispatch_wait_for_decision(
    service: &ConnectionService,
    _session: &BridgeSession,
    request: &BridgeRequest,
) -> BridgeResponse {
    let params: WaitForDecisionParams = match decode_params(&request.params) {
        Ok(params) => params,
        Err(err) => return BridgeResponse::err(request.id, err),
    };
    let outcome =
        service.wait_for_decision(params.request_id, Duration::from_millis(params.timeout_ms));
    BridgeResponse::ok(request.id, &WaitForDecisionResult { outcome })
}

fn dispatch_poll_decision(
    service: &ConnectionService,
    _session: &BridgeSession,
    request: &BridgeRequest,
) -> BridgeResponse {
    let params: PollDecisionParams = match decode_params(&request.params) {
        Ok(params) => params,
        Err(err) => return BridgeResponse::err(request.id, err),
    };
    let outcome = service.poll_decision(params.request_id);
    BridgeResponse::ok(request.id, &PollDecisionResult { outcome })
}

fn dispatch_send_message(
    service: &ConnectionService,
    clock: &dyn Clock,
    session: &BridgeSession,
    request: &BridgeRequest,
) -> BridgeResponse {
    let params: SendMessageParams = match decode_params(&request.params) {
        Ok(params) => params,
        Err(err) => return BridgeResponse::err(request.id, err),
    };
    let now = clock.now_iso8601();
    match service.send_message(session.session_id, params.connection_id, params.body, now) {
        Ok(message_id) => BridgeResponse::ok(request.id, &SendMessageResult { message_id }),
        Err(err) => {
            let message = err.to_string();
            let code = if message.contains("no such connection") {
                error_codes::NOT_FOUND
            } else if message.contains("not a participant") {
                error_codes::NOT_A_PARTICIPANT
            } else if message.contains("status is") {
                error_codes::CONNECTION_NOT_OPEN
            } else {
                error_codes::INTERNAL_ERROR
            };
            BridgeResponse::err(request.id, BridgeError::new(code, message))
        }
    }
}

fn dispatch_pending_messages(
    service: &ConnectionService,
    clock: &dyn Clock,
    session: &BridgeSession,
    request: &BridgeRequest,
) -> BridgeResponse {
    let params: PendingMessagesParams = match decode_params(&request.params) {
        Ok(params) => params,
        Err(err) => return BridgeResponse::err(request.id, err),
    };
    let now = clock.now_iso8601();
    match service.pending_messages(
        session.session_id,
        params.connection_id,
        params.since_sequence,
        now,
    ) {
        Ok(messages) => BridgeResponse::ok(request.id, &PendingMessagesResult { messages }),
        Err(err) => {
            let message = err.to_string();
            let code = if message.contains("no such connection") {
                error_codes::NOT_FOUND
            } else if message.contains("not a participant") {
                error_codes::NOT_A_PARTICIPANT
            } else {
                error_codes::INTERNAL_ERROR
            };
            BridgeResponse::err(request.id, BridgeError::new(code, message))
        }
    }
}

fn dispatch_close_connection(
    service: &ConnectionService,
    clock: &dyn Clock,
    session: &BridgeSession,
    request: &BridgeRequest,
) -> BridgeResponse {
    let params: CloseConnectionParams = match decode_params(&request.params) {
        Ok(params) => params,
        Err(err) => return BridgeResponse::err(request.id, err),
    };
    let now = clock.now_iso8601();
    let caller = ConnectionCaller::Session(session.session_id);
    match service.close(caller, params.connection_id, now, params.reason) {
        Ok(()) => BridgeResponse::ok(request.id, &CloseConnectionResult {}),
        Err(err) => {
            let message = err.to_string();
            let code = if message.contains("no such connection") {
                error_codes::NOT_FOUND
            } else if message.contains("not a participant") {
                error_codes::NOT_A_PARTICIPANT
            } else if message.contains("expected Open") {
                error_codes::CONNECTION_NOT_OPEN
            } else {
                error_codes::INTERNAL_ERROR
            };
            BridgeResponse::err(request.id, BridgeError::new(code, message))
        }
    }
}

fn dispatch_list_connections(
    service: &ConnectionService,
    session: &BridgeSession,
    request: &BridgeRequest,
) -> BridgeResponse {
    let _params: ListConnectionsParams = match decode_params(&request.params) {
        Ok(params) => params,
        Err(err) => return BridgeResponse::err(request.id, err),
    };
    match service.list_connections_for(session.session_id) {
        Ok(connections) => BridgeResponse::ok(request.id, &ListConnectionsResult { connections }),
        Err(err) => BridgeResponse::err(
            request.id,
            BridgeError::new(error_codes::INTERNAL_ERROR, err.to_string()),
        ),
    }
}

fn dispatch_get_connection(
    service: &ConnectionService,
    session: &BridgeSession,
    request: &BridgeRequest,
) -> BridgeResponse {
    let params: GetConnectionParams = match decode_params(&request.params) {
        Ok(params) => params,
        Err(err) => return BridgeResponse::err(request.id, err),
    };
    match service.get_connection(params.connection_id) {
        Ok(Some(connection)) => {
            if !connection.involves(session.session_id) {
                return BridgeResponse::err(
                    request.id,
                    BridgeError::new(
                        error_codes::NOT_A_PARTICIPANT,
                        format!(
                            "session {} is not a participant of {}",
                            session.session_id, params.connection_id
                        ),
                    ),
                );
            }
            BridgeResponse::ok(
                request.id,
                &GetConnectionResult {
                    connection: Some(connection),
                },
            )
        }
        Ok(None) => BridgeResponse::ok(request.id, &GetConnectionResult { connection: None }),
        Err(err) => BridgeResponse::err(
            request.id,
            BridgeError::new(error_codes::INTERNAL_ERROR, err.to_string()),
        ),
    }
}

fn decode_params<T: DeserializeOwned>(params: &Value) -> Result<T, BridgeError> {
    serde_json::from_value::<T>(params.clone()).map_err(|err| {
        BridgeError::new(
            error_codes::INVALID_PARAMS,
            format!("invalid params: {err}"),
        )
    })
}

/// Drive a single bridge connection: enforce handshake, then loop dispatching
/// requests until EOF, IO error, or a write failure. The dispatch is
/// synchronous: a slow [`ConnectionService::wait_for_decision`] blocks this
/// connection only; other connections served by their own threads are
/// unaffected.
///
/// Returns `Ok(())` on clean EOF and `Err` on protocol or IO failure. The
/// caller is responsible for closing the underlying transport.
pub fn serve_connection<R: BufRead, W: Write>(
    service: Arc<ConnectionService>,
    clock: Arc<dyn Clock>,
    mut reader: R,
    mut writer: W,
) -> Result<()> {
    let mut session: Option<BridgeSession> = None;
    let mut line_buf = String::new();

    loop {
        line_buf.clear();
        let read = reader
            .read_line(&mut line_buf)
            .context("reading from bridge stream")?;
        if read == 0 {
            return Ok(()); // clean EOF
        }
        if line_buf.len() > DEFAULT_MAX_LINE_BYTES {
            write_message(
                &mut writer,
                &BridgeMessage::Response(BridgeResponse::err(
                    -1,
                    BridgeError::new(error_codes::PARSE_ERROR, "frame exceeds maximum size"),
                )),
            )?;
            anyhow::bail!("oversized bridge frame; closing connection");
        }
        let trimmed = line_buf.trim_end_matches(['\n', '\r']);
        if trimmed.is_empty() {
            continue;
        }

        let message = match decode_line(trimmed) {
            Ok(message) => message,
            Err(err) => {
                write_message(
                    &mut writer,
                    &BridgeMessage::Response(BridgeResponse::err(
                        -1,
                        BridgeError::new(
                            error_codes::PARSE_ERROR,
                            format!("malformed frame: {err}"),
                        ),
                    )),
                )?;
                continue;
            }
        };

        let request = match message {
            BridgeMessage::Request(request) => request,
            BridgeMessage::Response(_) | BridgeMessage::Notification(_) => {
                // The server never expects unsolicited responses or
                // notifications from helpers. Ignore but stay connected.
                continue;
            }
        };

        let response = match &session {
            None => {
                let outcome = handle_handshake(&service, &request);
                if let Some(new_session) = outcome.session {
                    session = Some(new_session);
                }
                outcome.response
            }
            Some(active) => dispatch_request(&service, clock.as_ref(), active, &request),
        };

        write_message(&mut writer, &BridgeMessage::Response(response))?;
    }
}

fn write_message<W: Write>(writer: &mut W, message: &BridgeMessage) -> Result<()> {
    let line = encode_line(message).context("encoding bridge frame")?;
    writer
        .write_all(line.as_bytes())
        .context("writing bridge frame")?;
    writer
        .write_all(b"\n")
        .context("writing bridge frame newline")?;
    writer.flush().context("flushing bridge frame")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::ConnectionPolicy;
    use crate::connection_repository::InMemoryConnectionRepository;
    use crate::connection_service::RegisteredSession;
    use crate::domain::AgentKind;
    use std::io::{BufReader, Cursor};
    use uuid::Uuid;

    fn session_id(byte: u8) -> SessionId {
        Uuid::from_bytes([byte; 16])
    }

    fn address(focus: u8, title: &str) -> SessionAddress {
        SessionAddress {
            agent_kind: AgentKind::ClaudeCode,
            project_id: None,
            project_name: None,
            focus_id: Uuid::from_bytes([focus; 16]),
            focus_title: format!("Focus {focus:02x}"),
            session_title: title.to_owned(),
        }
    }

    fn service_with(sessions: &[(SessionId, &str, SessionAddress)]) -> Arc<ConnectionService> {
        let svc = Arc::new(ConnectionService::new(Arc::new(
            InMemoryConnectionRepository::new(),
        )));
        for (id, secret, addr) in sessions {
            svc.register_session(RegisteredSession {
                session_id: *id,
                secret: (*secret).to_owned(),
                address: addr.clone(),
            });
        }
        svc
    }

    fn make_handshake(id: i64, session: SessionId, secret: &str) -> BridgeRequest {
        BridgeRequest::new(
            id,
            methods::HANDSHAKE,
            &HandshakeParams {
                session_id: session,
                secret: secret.to_owned(),
                protocol_version: Some(PROTOCOL_VERSION),
            },
        )
    }

    fn make_list_peers(id: i64, scope: Option<PeerScope>) -> BridgeRequest {
        BridgeRequest::new(id, methods::LIST_PEERS, &ListPeersParams { scope })
    }

    #[test]
    fn handshake_accepts_registered_session_with_matching_secret() {
        let svc = service_with(&[(session_id(0x01), "s1", address(0x10, "Claude"))]);
        let outcome = handle_handshake(&svc, &make_handshake(1, session_id(0x01), "s1"));
        assert!(outcome.response.is_ok());
        let session = outcome.session.expect("authenticated");
        assert_eq!(session.session_id, session_id(0x01));
        assert_eq!(session.address.session_title, "Claude");
    }

    #[test]
    fn handshake_rejects_wrong_secret_with_auth_failed_code() {
        let svc = service_with(&[(session_id(0x01), "s1", address(0x10, "Claude"))]);
        let outcome = handle_handshake(&svc, &make_handshake(1, session_id(0x01), "wrong"));
        let err = outcome
            .response
            .error
            .expect("auth failure carries an error");
        assert_eq!(err.code, error_codes::AUTH_FAILED);
        assert!(outcome.session.is_none());
    }

    #[test]
    fn handshake_rejects_unregistered_session() {
        let svc = service_with(&[]);
        let outcome = handle_handshake(&svc, &make_handshake(1, session_id(0x02), "x"));
        let err = outcome.response.error.expect("error");
        assert_eq!(err.code, error_codes::AUTH_FAILED);
    }

    #[test]
    fn first_frame_other_than_handshake_is_rejected() {
        let svc = service_with(&[(session_id(0x01), "s1", address(0x10, "Claude"))]);
        let req = make_list_peers(1, None);
        let outcome = handle_handshake(&svc, &req);
        let err = outcome.response.error.expect("error");
        assert_eq!(err.code, error_codes::HANDSHAKE_REQUIRED);
    }

    #[test]
    fn dispatch_list_peers_returns_registered_peers() {
        let svc = service_with(&[
            (session_id(0x01), "s1", address(0x10, "Claude")),
            (session_id(0x02), "s2", address(0x10, "Cortex")),
            (session_id(0x03), "s3", address(0x20, "OtherFocus")),
        ]);
        let session = BridgeSession {
            session_id: session_id(0x01),
            address: address(0x10, "Claude"),
        };
        let resp = dispatch_request(
            &svc,
            &FixedClock::new("t0"),
            &session,
            &make_list_peers(7, Some(PeerScope::Workspace)),
        );
        assert_eq!(resp.id, 7);
        let result: ListPeersResult = serde_json::from_value(resp.result.unwrap()).unwrap();
        assert_eq!(result.peers.len(), 2);
        let ids: Vec<_> = result.peers.iter().map(|p| p.session_id).collect();
        assert!(ids.contains(&session_id(0x02)));
        assert!(ids.contains(&session_id(0x03)));
    }

    #[test]
    fn dispatch_list_peers_default_scope_is_focus() {
        let svc = service_with(&[
            (session_id(0x01), "s1", address(0x10, "A")),
            (session_id(0x02), "s2", address(0x20, "B")),
        ]);
        let session = BridgeSession {
            session_id: session_id(0x01),
            address: address(0x10, "A"),
        };
        let resp = dispatch_request(
            &svc,
            &FixedClock::new("t0"),
            &session,
            &make_list_peers(1, None),
        );
        let result: ListPeersResult = serde_json::from_value(resp.result.unwrap()).unwrap();
        assert!(
            result.peers.is_empty(),
            "different focus peers are filtered"
        );
    }

    #[test]
    fn dispatch_peer_status_returns_target_view() {
        let svc = service_with(&[
            (session_id(0x01), "s1", address(0x10, "Claude")),
            (session_id(0x02), "s2", address(0x10, "Cortex")),
        ]);
        let session = BridgeSession {
            session_id: session_id(0x01),
            address: address(0x10, "Claude"),
        };
        let req = BridgeRequest::new(
            9,
            methods::PEER_STATUS,
            &PeerStatusParams {
                peer_session_id: session_id(0x02),
            },
        );
        let resp = dispatch_request(&svc, &FixedClock::new("t0"), &session, &req);
        let result: PeerStatusResult = serde_json::from_value(resp.result.unwrap()).unwrap();
        let peer = result.peer.expect("peer present");
        assert_eq!(peer.session_id, session_id(0x02));
    }

    #[test]
    fn dispatch_unknown_method_returns_method_not_found() {
        let svc = service_with(&[(session_id(0x01), "s1", address(0x10, "Claude"))]);
        let session = BridgeSession {
            session_id: session_id(0x01),
            address: address(0x10, "Claude"),
        };
        let req = BridgeRequest::new(5, "reverie.does_not_exist", &Value::Null);
        let resp = dispatch_request(&svc, &FixedClock::new("t0"), &session, &req);
        let err = resp.error.expect("error");
        assert_eq!(err.code, error_codes::METHOD_NOT_FOUND);
    }

    #[test]
    fn dispatch_handshake_after_session_established_is_invalid() {
        let svc = service_with(&[(session_id(0x01), "s1", address(0x10, "Claude"))]);
        let session = BridgeSession {
            session_id: session_id(0x01),
            address: address(0x10, "Claude"),
        };
        let req = make_handshake(3, session_id(0x01), "s1");
        let resp = dispatch_request(&svc, &FixedClock::new("t0"), &session, &req);
        let err = resp.error.expect("error");
        assert_eq!(err.code, error_codes::INVALID_REQUEST);
    }

    #[test]
    fn dispatch_request_connection_routes_to_service() {
        let svc = service_with(&[
            (session_id(0x01), "s1", address(0x10, "A")),
            (session_id(0x02), "s2", address(0x10, "B")),
        ]);
        let session = BridgeSession {
            session_id: session_id(0x01),
            address: address(0x10, "A"),
        };
        svc.set_policy(ConnectionPolicy::AutoAllowFocus);
        let req = BridgeRequest::new(
            12,
            methods::REQUEST_CONNECTION,
            &RequestConnectionParams {
                target_session_id: session_id(0x02),
                reason: "test".into(),
                ttl_ms: 5_000,
            },
        );
        let resp = dispatch_request(&svc, &FixedClock::new("t0"), &session, &req);
        let result: RequestConnectionResult = serde_json::from_value(resp.result.unwrap()).unwrap();
        match result.outcome {
            crate::connection_service::RequestOutcome::Allowed { .. } => {}
            other => panic!("expected Allowed, got {other:?}"),
        }
    }

    #[test]
    fn dispatch_request_connection_to_self_returns_specific_code() {
        let svc = service_with(&[(session_id(0x01), "s1", address(0x10, "A"))]);
        let session = BridgeSession {
            session_id: session_id(0x01),
            address: address(0x10, "A"),
        };
        let req = BridgeRequest::new(
            12,
            methods::REQUEST_CONNECTION,
            &RequestConnectionParams {
                target_session_id: session_id(0x01),
                reason: "self".into(),
                ttl_ms: 5_000,
            },
        );
        let resp = dispatch_request(&svc, &FixedClock::new("t0"), &session, &req);
        let err = resp.error.expect("self-connection errors");
        assert_eq!(err.code, error_codes::SELF_CONNECTION);
    }

    #[test]
    fn dispatch_invalid_params_returns_invalid_params_code() {
        let svc = service_with(&[(session_id(0x01), "s1", address(0x10, "A"))]);
        let session = BridgeSession {
            session_id: session_id(0x01),
            address: address(0x10, "A"),
        };
        let req = BridgeRequest {
            jsonrpc: "2.0".into(),
            id: 1,
            method: methods::LIST_PEERS.into(),
            // List peers expects an object {scope?: PeerScope}; a bare number is wrong.
            params: serde_json::json!(42),
        };
        let resp = dispatch_request(&svc, &FixedClock::new("t0"), &session, &req);
        let err = resp.error.expect("error");
        assert_eq!(err.code, error_codes::INVALID_PARAMS);
    }

    #[test]
    fn serve_connection_handshake_then_list_peers_end_to_end() {
        let svc = service_with(&[
            (session_id(0x01), "s1", address(0x10, "Claude")),
            (session_id(0x02), "s2", address(0x10, "Cortex")),
        ]);

        let input = format!(
            "{}\n{}\n",
            encode_line(&BridgeMessage::Request(make_handshake(
                1,
                session_id(0x01),
                "s1"
            )))
            .unwrap(),
            encode_line(&BridgeMessage::Request(make_list_peers(
                2,
                Some(PeerScope::Focus)
            )))
            .unwrap(),
        );

        let reader = BufReader::new(Cursor::new(input.into_bytes()));
        let mut output: Vec<u8> = Vec::new();

        serve_connection(
            svc.clone(),
            Arc::new(FixedClock::new("t0")),
            reader,
            &mut output,
        )
        .expect("serves");

        let body = String::from_utf8(output).expect("utf-8 output");
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 2);

        // First reply is handshake ok.
        let first: BridgeMessage = serde_json::from_str(lines[0]).unwrap();
        let BridgeMessage::Response(resp) = first else {
            panic!("expected response");
        };
        assert!(resp.is_ok());
        assert_eq!(resp.id, 1);

        // Second reply is list_peers with one peer.
        let second: BridgeMessage = serde_json::from_str(lines[1]).unwrap();
        let BridgeMessage::Response(resp) = second else {
            panic!("expected response");
        };
        let result: ListPeersResult = serde_json::from_value(resp.result.unwrap()).unwrap();
        assert_eq!(result.peers.len(), 1);
        assert_eq!(result.peers[0].session_id, session_id(0x02));
    }

    #[test]
    fn serve_connection_rejects_first_frame_when_not_handshake() {
        let svc = service_with(&[(session_id(0x01), "s1", address(0x10, "Claude"))]);
        let input = format!(
            "{}\n",
            encode_line(&BridgeMessage::Request(make_list_peers(1, None))).unwrap(),
        );
        let reader = BufReader::new(Cursor::new(input.into_bytes()));
        let mut output: Vec<u8> = Vec::new();
        serve_connection(
            svc.clone(),
            Arc::new(FixedClock::new("t0")),
            reader,
            &mut output,
        )
        .expect("serves");
        let body = String::from_utf8(output).unwrap();
        let line = body.lines().next().unwrap();
        let message: BridgeMessage = serde_json::from_str(line).unwrap();
        let BridgeMessage::Response(resp) = message else {
            panic!("expected response");
        };
        let err = resp.error.expect("error");
        assert_eq!(err.code, error_codes::HANDSHAKE_REQUIRED);
    }

    #[test]
    fn serve_connection_recovers_from_malformed_line_and_continues() {
        let svc = service_with(&[
            (session_id(0x01), "s1", address(0x10, "Claude")),
            (session_id(0x02), "s2", address(0x10, "Cortex")),
        ]);
        let mut input = String::new();
        input.push_str(&format!(
            "{}\n",
            encode_line(&BridgeMessage::Request(make_handshake(
                1,
                session_id(0x01),
                "s1"
            )))
            .unwrap()
        ));
        input.push_str("{ this is not json }\n");
        input.push_str(&format!(
            "{}\n",
            encode_line(&BridgeMessage::Request(make_list_peers(
                2,
                Some(PeerScope::Workspace)
            )))
            .unwrap()
        ));

        let reader = BufReader::new(Cursor::new(input.into_bytes()));
        let mut output: Vec<u8> = Vec::new();
        serve_connection(
            svc.clone(),
            Arc::new(FixedClock::new("t0")),
            reader,
            &mut output,
        )
        .expect("serves");
        let lines: Vec<String> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|s| s.to_owned())
            .collect();
        assert_eq!(
            lines.len(),
            3,
            "handshake reply + parse error + list_peers reply"
        );

        let second: BridgeMessage = serde_json::from_str(&lines[1]).unwrap();
        let BridgeMessage::Response(resp) = second else {
            panic!("expected response");
        };
        let err = resp.error.expect("error");
        assert_eq!(err.code, error_codes::PARSE_ERROR);
    }

    #[test]
    fn system_clock_formats_iso8601_utc() {
        let formatted = SystemClock.now_iso8601();
        // YYYY-MM-DDTHH:MM:SSZ is 20 chars.
        assert_eq!(formatted.len(), 20);
        assert!(formatted.ends_with('Z'));
        assert_eq!(&formatted[4..5], "-");
        assert_eq!(&formatted[10..11], "T");
    }

    #[test]
    fn unix_secs_to_ymdhms_handles_epoch_and_known_dates() {
        assert_eq!(unix_secs_to_ymdhms(0), (1970, 1, 1, 0, 0, 0));
        // 2026-05-25T00:00:00Z = 1779667200 unix seconds.
        assert_eq!(unix_secs_to_ymdhms(1_779_667_200), (2026, 5, 25, 0, 0, 0),);
        // 2026-12-31T23:59:59Z = 1798761599 unix seconds; covers the
        // year-end month rollover and the last-second carry.
        assert_eq!(
            unix_secs_to_ymdhms(1_798_761_599),
            (2026, 12, 31, 23, 59, 59),
        );
    }
}
