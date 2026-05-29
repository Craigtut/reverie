//! The catalog of `reverie.*` MCP tools and the dispatch from each tool call
//! to a [`BridgeTransport`] method.
//!
//! Tool descriptions deliberately carry the agent-behavior guidance: when to
//! call, when not to, what return shapes look like. The model reads these
//! every turn, so this is where "do not request a connection unless the user
//! asks" lives. There is no separate session-start prompt; the catalog is
//! the contract.

use reverie_core::bridge_protocol::{
    CloseConnectionParams, CloseConnectionResult, GetConnectionParams, GetConnectionResult,
    ListConnectionsParams, ListConnectionsResult, ListPeersParams, ListPeersResult,
    PeerStatusParams, PeerStatusResult, PendingMessagesParams, PendingMessagesResult,
    PollDecisionParams, PollDecisionResult, RequestConnectionParams, RequestConnectionResult,
    SendMessageParams, SendMessageResult, WaitForDecisionParams, WaitForDecisionResult, methods,
};
use serde_json::{Value, json};

use crate::client::{BridgeCallError, BridgeTransport};
use crate::mcp::{CallToolResult, ToolDefinition};

/// Returns the static tool catalog. Stable; safe to cache. The MCP
/// `tools/list` handler returns this verbatim.
pub fn catalog() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: tool_names::LIST_PEERS.to_owned(),
            description: "\
List sibling agent sessions currently active in the workspace. Call this \
when the user mentions another session by name or asks you to coordinate \
with another agent. `scope` defaults to \"focus\" (only your own focus's \
peers); widen to \"project\" or \"workspace\" if the user names a session \
elsewhere."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "scope": {
                        "type": "string",
                        "enum": ["focus", "project", "workspace"],
                        "description": "Optional. Defaults to \"focus\"."
                    }
                },
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: tool_names::PEER_STATUS.to_owned(),
            description: "\
Fetch a richer view of one peer session: address, current activity, and \
whether you already have an open connection to it. Useful before \
requesting a connection."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "required": ["peerSessionId"],
                "properties": {
                    "peerSessionId": { "type": "string", "format": "uuid" }
                },
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: tool_names::REQUEST_CONNECTION.to_owned(),
            description: "\
Open a connection to a sibling agent session so you and that agent can \
exchange messages directly. Call this ONLY when the user has explicitly \
asked you to coordinate with another agent; do not request connections on \
your own initiative. The user will be prompted to accept (unless policy \
auto-allows). Returns one of: { kind: \"allowed\", connectionId }, \
{ kind: \"pending\", connectionId, requestId } (use `wait_for_decision` or \
`poll_decision` next), or { kind: \"already_open\", connectionId }."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "required": ["targetSessionId", "reason", "ttlMs"],
                "properties": {
                    "targetSessionId": { "type": "string", "format": "uuid" },
                    "reason": {
                        "type": "string",
                        "description": "Short prose shown verbatim to the user in the accept banner.",
                        "minLength": 1
                    },
                    "ttlMs": {
                        "type": "integer",
                        "description": "Wall-clock window the user has to decide, in milliseconds. Typical: 600000 (10 min).",
                        "minimum": 1000
                    }
                },
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: tool_names::WAIT_FOR_DECISION.to_owned(),
            description: "\
Block until a pending connection request is accepted, denied, or times out. \
Call this after `request_connection` returns { kind: \"pending\", requestId }. \
Returns { kind: \"allowed\" | \"denied\" | \"timeout\" | \"unknown\" }."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "required": ["requestId", "timeoutMs"],
                "properties": {
                    "requestId": { "type": "string", "format": "uuid" },
                    "timeoutMs": {
                        "type": "integer",
                        "description": "Server-side wait window in milliseconds. Set comfortably under your own tool timeout.",
                        "minimum": 1000
                    }
                },
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: tool_names::POLL_DECISION.to_owned(),
            description: "\
Non-blocking check for a pending request's decision. Returns `null` if the \
user has not yet decided. Useful when an earlier `wait_for_decision` \
timed out and you want to check on the next turn."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "required": ["requestId"],
                "properties": {
                    "requestId": { "type": "string", "format": "uuid" }
                },
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: tool_names::SEND_MESSAGE.to_owned(),
            description: "\
Send a message through an open connection. The peer agent receives this on \
its next turn (or sooner via push, depending on its CLI)."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "required": ["connectionId", "body"],
                "properties": {
                    "connectionId": { "type": "string", "format": "uuid" },
                    "body": { "type": "string", "minLength": 1 }
                },
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: tool_names::PENDING_MESSAGES.to_owned(),
            description: "\
Fetch inbound messages addressed to you on a connection, with sequence \
greater than `sinceSequence`. Call this when Reverie has notified you that \
a peer has sent something. Each returned message has a `sequence`; pass the \
last one as `sinceSequence` on the next call to avoid re-receiving."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "required": ["connectionId"],
                "properties": {
                    "connectionId": { "type": "string", "format": "uuid" },
                    "sinceSequence": {
                        "type": "integer",
                        "minimum": 0,
                        "default": 0
                    }
                },
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: tool_names::CLOSE_CONNECTION.to_owned(),
            description: "\
Close an open connection. Call when the coordinated work is done. Optional \
`reason` is recorded in the activity log and shown to the peer."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "required": ["connectionId"],
                "properties": {
                    "connectionId": { "type": "string", "format": "uuid" },
                    "reason": { "type": "string" }
                },
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: tool_names::LIST_CONNECTIONS.to_owned(),
            description: "\
List every connection you participate in, in every status. Useful for \
auditing what coordination history you have."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: tool_names::GET_CONNECTION.to_owned(),
            description: "\
Fetch one connection by id, including its full record (participants, \
status, opened/closed timestamps, etc.)."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "required": ["connectionId"],
                "properties": {
                    "connectionId": { "type": "string", "format": "uuid" }
                },
                "additionalProperties": false
            }),
        },
    ]
}

/// Canonical tool names. These are what the agent's `tools/call` sees.
pub mod tool_names {
    pub const LIST_PEERS: &str = "reverie.list_peers";
    pub const PEER_STATUS: &str = "reverie.peer_status";
    pub const REQUEST_CONNECTION: &str = "reverie.request_connection";
    pub const WAIT_FOR_DECISION: &str = "reverie.wait_for_decision";
    pub const POLL_DECISION: &str = "reverie.poll_decision";
    pub const SEND_MESSAGE: &str = "reverie.send_message";
    pub const PENDING_MESSAGES: &str = "reverie.pending_messages";
    pub const CLOSE_CONNECTION: &str = "reverie.close_connection";
    pub const LIST_CONNECTIONS: &str = "reverie.list_connections";
    pub const GET_CONNECTION: &str = "reverie.get_connection";
}

/// Dispatch a single MCP `tools/call`. Translates `arguments` into the
/// matching bridge params, issues the bridge request, packages the result as
/// a [`CallToolResult`]. Bridge errors are surfaced as `isError: true`
/// content so the agent gets a readable description without the bridge
/// failure being mistaken for a tool-server crash.
pub fn dispatch<T: BridgeTransport>(
    transport: &mut T,
    name: &str,
    arguments: &Value,
) -> CallToolResult {
    match name {
        tool_names::LIST_PEERS => call_typed::<_, _, ListPeersResult>(
            transport,
            methods::LIST_PEERS,
            arguments,
            decode_or_default::<ListPeersParams>,
        ),
        tool_names::PEER_STATUS => call_typed::<_, _, PeerStatusResult>(
            transport,
            methods::PEER_STATUS,
            arguments,
            decode_required::<PeerStatusParams>,
        ),
        tool_names::REQUEST_CONNECTION => call_typed::<_, _, RequestConnectionResult>(
            transport,
            methods::REQUEST_CONNECTION,
            arguments,
            decode_required::<RequestConnectionParams>,
        ),
        tool_names::WAIT_FOR_DECISION => call_typed::<_, _, WaitForDecisionResult>(
            transport,
            methods::WAIT_FOR_DECISION,
            arguments,
            decode_required::<WaitForDecisionParams>,
        ),
        tool_names::POLL_DECISION => call_typed::<_, _, PollDecisionResult>(
            transport,
            methods::POLL_DECISION,
            arguments,
            decode_required::<PollDecisionParams>,
        ),
        tool_names::SEND_MESSAGE => call_typed::<_, _, SendMessageResult>(
            transport,
            methods::SEND_MESSAGE,
            arguments,
            decode_required::<SendMessageParams>,
        ),
        tool_names::PENDING_MESSAGES => call_typed::<_, _, PendingMessagesResult>(
            transport,
            methods::PENDING_MESSAGES,
            arguments,
            decode_required::<PendingMessagesParams>,
        ),
        tool_names::CLOSE_CONNECTION => call_typed::<_, _, CloseConnectionResult>(
            transport,
            methods::CLOSE_CONNECTION,
            arguments,
            decode_required::<CloseConnectionParams>,
        ),
        tool_names::LIST_CONNECTIONS => call_typed::<_, _, ListConnectionsResult>(
            transport,
            methods::LIST_CONNECTIONS,
            arguments,
            decode_or_default::<ListConnectionsParams>,
        ),
        tool_names::GET_CONNECTION => call_typed::<_, _, GetConnectionResult>(
            transport,
            methods::GET_CONNECTION,
            arguments,
            decode_required::<GetConnectionParams>,
        ),
        unknown => CallToolResult::text_err(format!("unknown tool: {unknown}")),
    }
}

fn call_typed<T, P, R>(
    transport: &mut T,
    method: &'static str,
    arguments: &Value,
    decode: fn(&Value) -> Result<P, CallToolResult>,
) -> CallToolResult
where
    T: BridgeTransport,
    P: serde::Serialize,
    R: serde::de::DeserializeOwned + serde::Serialize,
{
    let params = match decode(arguments) {
        Ok(params) => params,
        Err(err) => return err,
    };
    match transport.call::<P, R>(method, &params) {
        Ok(result) => CallToolResult::text_ok(&result),
        Err(BridgeCallError::Server { code, message }) => {
            CallToolResult::text_err(format!("bridge error [{code}]: {message}"))
        }
        Err(BridgeCallError::Protocol(message)) => {
            CallToolResult::text_err(format!("bridge protocol error: {message}"))
        }
        Err(BridgeCallError::Transport(message)) => {
            CallToolResult::text_err(format!("bridge transport error: {message}"))
        }
    }
}

fn decode_required<P: serde::de::DeserializeOwned>(arguments: &Value) -> Result<P, CallToolResult> {
    serde_json::from_value(arguments.clone())
        .map_err(|err| CallToolResult::text_err(format!("invalid arguments: {err}")))
}

fn decode_or_default<P: serde::de::DeserializeOwned + Default>(
    arguments: &Value,
) -> Result<P, CallToolResult> {
    if arguments.is_null() {
        return Ok(P::default());
    }
    if arguments.is_object() && arguments.as_object().map(|m| m.is_empty()).unwrap_or(false) {
        return Ok(P::default());
    }
    serde_json::from_value(arguments.clone())
        .map_err(|err| CallToolResult::text_err(format!("invalid arguments: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::test_support::MockBridgeTransport;
    use reverie_core::connection_service::PeerScope;

    #[test]
    fn catalog_lists_every_tool_with_input_schema() {
        let catalog = catalog();
        assert!(!catalog.is_empty());
        let names: Vec<_> = catalog.iter().map(|t| t.name.as_str()).collect();
        for expected in [
            tool_names::LIST_PEERS,
            tool_names::PEER_STATUS,
            tool_names::REQUEST_CONNECTION,
            tool_names::WAIT_FOR_DECISION,
            tool_names::POLL_DECISION,
            tool_names::SEND_MESSAGE,
            tool_names::PENDING_MESSAGES,
            tool_names::CLOSE_CONNECTION,
            tool_names::LIST_CONNECTIONS,
            tool_names::GET_CONNECTION,
        ] {
            assert!(names.contains(&expected), "missing tool {expected}");
        }
        for tool in &catalog {
            assert_eq!(tool.input_schema["type"], "object");
            assert!(!tool.description.is_empty());
        }
    }

    #[test]
    fn list_peers_dispatch_translates_arguments_and_returns_text_ok() {
        let mut transport = MockBridgeTransport::new();
        transport.push_ok(&ListPeersResult { peers: vec![] });
        let result = dispatch(
            &mut transport,
            tool_names::LIST_PEERS,
            &json!({ "scope": "focus" }),
        );
        assert!(!result.is_error);
        assert_eq!(transport.calls[0].0, methods::LIST_PEERS);
        // The text body MUST be valid JSON parseable as ListPeersResult.
        let text = match &result.content[0] {
            crate::mcp::ToolContent::Text { text } => text,
        };
        let parsed: ListPeersResult = serde_json::from_str(text).unwrap();
        assert!(parsed.peers.is_empty());
    }

    #[test]
    fn list_peers_dispatch_accepts_empty_object_arguments() {
        let mut transport = MockBridgeTransport::new();
        transport.push_ok(&ListPeersResult { peers: vec![] });
        let result = dispatch(&mut transport, tool_names::LIST_PEERS, &json!({}));
        assert!(!result.is_error);
    }

    #[test]
    fn unknown_tool_returns_is_error() {
        let mut transport = MockBridgeTransport::new();
        let result = dispatch(&mut transport, "reverie.does_not_exist", &Value::Null);
        assert!(result.is_error);
    }

    #[test]
    fn bridge_server_error_surfaces_as_is_error_with_code_in_text() {
        let mut transport = MockBridgeTransport::new();
        transport.push_err(
            reverie_core::bridge_protocol::error_codes::TARGET_NOT_REGISTERED,
            "no such peer",
        );
        let result = dispatch(
            &mut transport,
            tool_names::PEER_STATUS,
            &json!({"peerSessionId": "00000000-0000-0000-0000-000000000000"}),
        );
        assert!(result.is_error);
        match &result.content[0] {
            crate::mcp::ToolContent::Text { text } => {
                assert!(text.contains("bridge error"));
                assert!(text.contains("no such peer"));
            }
        }
    }

    #[test]
    fn invalid_arguments_return_is_error_without_calling_bridge() {
        let mut transport = MockBridgeTransport::new();
        let result = dispatch(
            &mut transport,
            tool_names::SEND_MESSAGE,
            &json!({"body": "missing connection id"}),
        );
        assert!(result.is_error);
        assert!(
            transport.calls.is_empty(),
            "bridge MUST NOT be called on invalid args"
        );
    }

    #[test]
    fn list_peers_dispatch_round_trips_scope_value() {
        let mut transport = MockBridgeTransport::new();
        transport.push_ok(&ListPeersResult { peers: vec![] });
        dispatch(
            &mut transport,
            tool_names::LIST_PEERS,
            &json!({"scope": "workspace"}),
        );
        let scope: PeerScope =
            serde_json::from_value(transport.calls[0].1["scope"].clone()).unwrap();
        assert_eq!(scope, PeerScope::Workspace);
    }
}
