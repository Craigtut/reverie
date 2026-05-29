//! Bridge protocol client: the helper's view of the desktop end.
//!
//! Exposes a [`BridgeTransport`] trait so the run loop is testable with a
//! mock, plus a [`UnixBridgeTransport`] for the real (UnixStream-backed)
//! transport. Both speak the NDJSON wire format defined in
//! [`reverie_core::bridge_protocol`].

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};

use anyhow::{Context, Result};
use reverie_core::PROTOCOL_VERSION;
use reverie_core::bridge_protocol::{
    BridgeError, BridgeMessage, BridgeRequest, BridgeResponse, HandshakeParams, HandshakeResult,
    decode_line, encode_line, methods,
};
use reverie_core::connection_service::SessionAddress;
use reverie_core::domain::SessionId;
use serde::Serialize;
use serde::de::DeserializeOwned;

/// Error from a single bridge call. Distinguishes transport-level failures
/// (which terminate the bridge connection) from server-level errors (which
/// are translated into MCP tool errors but leave the connection alive).
#[derive(Debug, thiserror::Error)]
pub enum BridgeCallError {
    #[error("bridge transport error: {0}")]
    Transport(String),
    #[error("bridge server error [{code}]: {message}")]
    Server { code: i32, message: String },
    #[error("bridge protocol error: {0}")]
    Protocol(String),
}

impl From<BridgeError> for BridgeCallError {
    fn from(value: BridgeError) -> Self {
        Self::Server {
            code: value.code,
            message: value.message,
        }
    }
}

/// Synchronous request-response client for the bridge. Implementations are
/// expected to be single-threaded: one request at a time, response read
/// before the next request is issued.
pub trait BridgeTransport {
    /// Issue a request, block until the matching response arrives, return
    /// the typed result. Server errors are surfaced as
    /// [`BridgeCallError::Server`]; transport breakage is
    /// [`BridgeCallError::Transport`] and SHOULD be treated as fatal.
    fn call<P: Serialize, R: DeserializeOwned>(
        &mut self,
        method: &str,
        params: &P,
    ) -> Result<R, BridgeCallError>;
}

/// Real bridge transport backed by a Unix-domain stream.
pub struct UnixBridgeTransport {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    next_id: AtomicI64,
}

/// Default read/write timeout for a single bridge call. Comfortably larger
/// than any reasonable wait_for_decision the desktop might hold, so we only
/// trip when the desktop is genuinely deadlocked or gone; the wall-clock
/// kill is still owned by the parent CLI's MCP tool timeout.
const DEFAULT_TRANSPORT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(700);

impl UnixBridgeTransport {
    /// Connect to the bridge socket at `socket_path`.
    pub fn connect(socket_path: &Path) -> Result<Self> {
        let stream = UnixStream::connect(socket_path)
            .with_context(|| format!("connect to bridge socket {}", socket_path.display()))?;
        // Set conservative read/write timeouts so a deadlocked desktop
        // cannot stall the helper forever. Errors here are non-fatal: an OS
        // that does not honor the call still gets the un-timed-out
        // behaviour (the parent CLI's per-tool timeout remains the outer
        // kill switch).
        let _ = stream.set_read_timeout(Some(DEFAULT_TRANSPORT_TIMEOUT));
        let _ = stream.set_write_timeout(Some(DEFAULT_TRANSPORT_TIMEOUT));
        let reader = BufReader::new(
            stream
                .try_clone()
                .context("clone bridge socket for reader")?,
        );
        Ok(Self {
            reader,
            writer: stream,
            next_id: AtomicI64::new(1),
        })
    }

    fn issue<P: Serialize, R: DeserializeOwned>(
        &mut self,
        method: &str,
        params: &P,
    ) -> Result<R, BridgeCallError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let request = BridgeRequest::new(id, method, params);
        let line = encode_line(&BridgeMessage::Request(request))
            .map_err(|err| BridgeCallError::Protocol(format!("encode: {err}")))?;
        self.writer
            .write_all(line.as_bytes())
            .map_err(|err| BridgeCallError::Transport(format!("write: {err}")))?;
        self.writer
            .write_all(b"\n")
            .map_err(|err| BridgeCallError::Transport(format!("write newline: {err}")))?;
        self.writer
            .flush()
            .map_err(|err| BridgeCallError::Transport(format!("flush: {err}")))?;

        // Skip notifications until we find the response with matching id.
        loop {
            let mut buf = String::new();
            let read = self
                .reader
                .read_line(&mut buf)
                .map_err(|err| BridgeCallError::Transport(format!("read: {err}")))?;
            if read == 0 {
                return Err(BridgeCallError::Transport("bridge closed".into()));
            }
            let trimmed = buf.trim_end_matches(['\n', '\r']);
            if trimmed.is_empty() {
                continue;
            }
            let message = decode_line(trimmed)
                .map_err(|err| BridgeCallError::Protocol(format!("decode: {err}")))?;
            match message {
                BridgeMessage::Response(response) => {
                    if response.id != id {
                        // Stray response; ignore and keep reading. In v1 we
                        // never multiplex, so this should not happen, but
                        // staying robust is cheap.
                        continue;
                    }
                    return interpret(response);
                }
                BridgeMessage::Notification(_notif) => {
                    // v1: ignore server-pushed notifications. Future work
                    // (progress, inbound message arrival) will route these
                    // somewhere; today we silently skip.
                    continue;
                }
                BridgeMessage::Request(_) => {
                    // The bridge does not initiate requests to helpers.
                    return Err(BridgeCallError::Protocol(
                        "bridge sent unexpected request frame".into(),
                    ));
                }
            }
        }
    }
}

impl BridgeTransport for UnixBridgeTransport {
    fn call<P: Serialize, R: DeserializeOwned>(
        &mut self,
        method: &str,
        params: &P,
    ) -> Result<R, BridgeCallError> {
        self.issue(method, params)
    }
}

fn interpret<R: DeserializeOwned>(response: BridgeResponse) -> Result<R, BridgeCallError> {
    if let Some(error) = response.error {
        return Err(error.into());
    }
    let value = response
        .result
        .ok_or_else(|| BridgeCallError::Protocol("response had neither result nor error".into()))?;
    serde_json::from_value(value)
        .map_err(|err| BridgeCallError::Protocol(format!("decode result: {err}")))
}

/// Issue the bridge handshake and return the authenticated session address.
/// All transports MUST call this exactly once, before any other method.
pub fn handshake<T: BridgeTransport>(
    transport: &mut T,
    session_id: SessionId,
    secret: &str,
) -> Result<SessionAddress, BridgeCallError> {
    let params = HandshakeParams {
        session_id,
        secret: secret.to_owned(),
        protocol_version: Some(PROTOCOL_VERSION),
    };
    let result: HandshakeResult = transport.call(methods::HANDSHAKE, &params)?;
    Ok(result.address)
}

/// In-memory transport used by unit tests and the e2e harness. Records every
/// call and returns canned responses in order.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use serde_json::Value;
    use std::collections::VecDeque;

    pub struct MockBridgeTransport {
        pub calls: Vec<(String, Value)>,
        pub responses: VecDeque<Result<Value, BridgeCallError>>,
    }

    impl MockBridgeTransport {
        pub fn new() -> Self {
            Self {
                calls: Vec::new(),
                responses: VecDeque::new(),
            }
        }

        pub fn push_ok<R: Serialize>(&mut self, value: &R) {
            self.responses
                .push_back(Ok(serde_json::to_value(value).unwrap()));
        }

        pub fn push_err(&mut self, code: i32, message: impl Into<String>) {
            self.responses.push_back(Err(BridgeCallError::Server {
                code,
                message: message.into(),
            }));
        }
    }

    impl Default for MockBridgeTransport {
        fn default() -> Self {
            Self::new()
        }
    }

    impl BridgeTransport for MockBridgeTransport {
        fn call<P: Serialize, R: DeserializeOwned>(
            &mut self,
            method: &str,
            params: &P,
        ) -> Result<R, BridgeCallError> {
            self.calls
                .push((method.to_owned(), serde_json::to_value(params).unwrap()));
            let response = self.responses.pop_front().ok_or_else(|| {
                BridgeCallError::Protocol(format!("no canned response for {method}"))
            })?;
            response.and_then(|value| {
                serde_json::from_value(value)
                    .map_err(|err| BridgeCallError::Protocol(format!("mock decode: {err}")))
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::MockBridgeTransport;
    use super::*;
    use reverie_core::bridge_protocol::{ListPeersParams, ListPeersResult};
    use reverie_core::connection_service::PeerScope;

    #[test]
    fn handshake_round_trip_via_mock_transport() {
        let mut transport = MockBridgeTransport::new();
        transport.push_ok(&HandshakeResult {
            address: SessionAddress {
                agent_kind: reverie_core::domain::AgentKind::ClaudeCode,
                project_id: None,
                project_name: None,
                focus_id: uuid::Uuid::from_bytes([0x10; 16]),
                focus_title: "F".into(),
                session_title: "Claude".into(),
            },
            protocol_version: PROTOCOL_VERSION,
        });
        let address = handshake(&mut transport, uuid::Uuid::from_bytes([0x01; 16]), "secret")
            .expect("handshake succeeds");
        assert_eq!(address.session_title, "Claude");
        assert_eq!(transport.calls.len(), 1);
        assert_eq!(transport.calls[0].0, methods::HANDSHAKE);
    }

    #[test]
    fn handshake_surfaces_server_error_distinctly() {
        let mut transport = MockBridgeTransport::new();
        transport.push_err(
            reverie_core::bridge_protocol::error_codes::AUTH_FAILED,
            "bad secret",
        );
        let err = handshake(&mut transport, uuid::Uuid::from_bytes([0x01; 16]), "secret")
            .expect_err("handshake fails");
        match err {
            BridgeCallError::Server { code, .. } => assert_eq!(
                code,
                reverie_core::bridge_protocol::error_codes::AUTH_FAILED
            ),
            other => panic!("expected Server error, got {other:?}"),
        }
    }

    #[test]
    fn typed_list_peers_round_trips() {
        let mut transport = MockBridgeTransport::new();
        transport.push_ok(&ListPeersResult { peers: vec![] });
        let result: ListPeersResult = transport
            .call(
                methods::LIST_PEERS,
                &ListPeersParams {
                    scope: Some(PeerScope::Focus),
                },
            )
            .expect("list_peers succeeds");
        assert!(result.peers.is_empty());
        assert_eq!(transport.calls[0].0, methods::LIST_PEERS);
        assert_eq!(transport.calls[0].1["scope"], "focus");
    }

    #[test]
    fn missing_canned_response_returns_protocol_error() {
        let mut transport = MockBridgeTransport::new();
        let err: BridgeCallError = transport
            .call::<_, ListPeersResult>(methods::LIST_PEERS, &ListPeersParams { scope: None })
            .unwrap_err();
        assert!(matches!(err, BridgeCallError::Protocol(_)));
    }
}
