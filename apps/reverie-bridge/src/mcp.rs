//! Minimal subset of the Model Context Protocol used by the helper.
//!
//! The helper only needs to be an MCP **server** over stdio. The methods it
//! must understand are:
//!
//! - [`methods::INITIALIZE`] — initial handshake from the client (the CLI).
//! - [`methods::NOTIFICATIONS_INITIALIZED`] — acknowledgement from the client;
//!   no response.
//! - [`methods::TOOLS_LIST`] — return the catalog of `reverie.*` tools.
//! - [`methods::TOOLS_CALL`] — dispatch one tool call.
//! - [`methods::PING`] — basic keepalive; respond with an empty object.
//!
//! Anything else triggers a JSON-RPC `Method not found` error. The MCP spec
//! ([2024-11-05]) defines many more methods (prompts, resources, sampling,
//! logging, etc.); none of them are relevant to the bridge today.
//!
//! [2024-11-05]: https://modelcontextprotocol.io/specification/2024-11-05

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// MCP protocol revision the helper speaks. Both Claude Code and Codex CLI
/// accept this revision.
pub const PROTOCOL_VERSION: &str = "2024-11-05";

/// JSON-RPC version. Constant; included in every frame.
pub const JSONRPC_VERSION: &str = "2.0";

/// Method names the helper recognizes.
pub mod methods {
    pub const INITIALIZE: &str = "initialize";
    pub const NOTIFICATIONS_INITIALIZED: &str = "notifications/initialized";
    pub const TOOLS_LIST: &str = "tools/list";
    pub const TOOLS_CALL: &str = "tools/call";
    pub const PING: &str = "ping";
    pub const NOTIFICATIONS_CANCELLED: &str = "notifications/cancelled";
}

/// JSON-RPC error codes used in MCP responses. Codes below `-32000` are
/// reserved by JSON-RPC for protocol-level errors; the server may define its
/// own in `-32000..=-32099`.
pub mod error_codes {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
}

/// A JSON-RPC 2.0 frame, untagged for the three valid shapes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum McpFrame {
    Request(McpRequest),
    Response(McpResponse),
    Notification(McpNotification),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct McpRequest {
    pub jsonrpc: String,
    pub id: McpId,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct McpResponse {
    pub jsonrpc: String,
    pub id: McpId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<McpError>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct McpNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// JSON-RPC ids may be a number, a string, or null. The MCP spec allows both
/// numeric and string ids; we preserve whichever the client sent so the
/// response correlates correctly.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum McpId {
    Number(i64),
    String(String),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct McpError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl McpResponse {
    pub fn ok<T: Serialize>(id: McpId, result: &T) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id,
            result: Some(serde_json::to_value(result).unwrap_or(Value::Null)),
            error: None,
        }
    }

    pub fn err(id: McpId, error: McpError) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id,
            result: None,
            error: Some(error),
        }
    }
}

impl McpError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Typed shapes for the methods the helper implements.
// ---------------------------------------------------------------------------

/// `initialize` request params. We only care about a handful of fields; the
/// rest stays in [`Value`] so unknown extensions do not cause parse errors.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InitializeParams {
    #[serde(rename = "protocolVersion", default)]
    pub protocol_version: Option<String>,
    #[serde(default)]
    pub capabilities: Value,
    #[serde(rename = "clientInfo", default)]
    pub client_info: Option<ClientInfo>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InitializeResult {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    pub capabilities: ServerCapabilities,
    #[serde(rename = "serverInfo")]
    pub server_info: ServerInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
}

/// Server capability advertisement. The helper only offers tools; future
/// versions may add `resources`, `prompts`, or `logging`.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
pub struct ServerCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<ToolsCapability>,
}

#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
pub struct ToolsCapability {
    /// Whether the server emits `notifications/tools/list_changed`. v1: no.
    #[serde(default, rename = "listChanged")]
    pub list_changed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
}

/// `tools/list` response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ListToolsResult {
    pub tools: Vec<ToolDefinition>,
}

/// One tool's schema and human-readable copy. `input_schema` is a JSON
/// Schema object describing the `arguments` field of `tools/call`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

/// `tools/call` request params.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CallToolParams {
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

/// `tools/call` response shape. MCP content is a typed array; for v1 we
/// always emit a single `text` block whose body is the JSON encoding of the
/// underlying bridge result. Agents parse the text on receipt.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CallToolResult {
    pub content: Vec<ToolContent>,
    #[serde(rename = "isError", default)]
    pub is_error: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolContent {
    Text { text: String },
}

impl CallToolResult {
    pub fn text_ok(payload: &impl Serialize) -> Self {
        let text = serde_json::to_string(payload).unwrap_or_else(|_| "null".to_owned());
        Self {
            content: vec![ToolContent::Text { text }],
            is_error: false,
        }
    }

    pub fn text_err(message: impl Into<String>) -> Self {
        Self {
            content: vec![ToolContent::Text {
                text: message.into(),
            }],
            is_error: true,
        }
    }
}

/// Encode an [`McpFrame`] for stdout. Returns the JSON body without a
/// trailing newline; callers MUST append `\n`.
pub fn encode_frame(frame: &McpFrame) -> Result<String, serde_json::Error> {
    serde_json::to_string(frame)
}

/// Decode a single NDJSON line into an [`McpFrame`].
pub fn decode_frame(line: &str) -> Result<McpFrame, serde_json::Error> {
    serde_json::from_str(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_round_trip() {
        let req = McpRequest {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id: McpId::Number(1),
            method: methods::INITIALIZE.to_owned(),
            params: serde_json::to_value(&InitializeParams {
                protocol_version: Some(PROTOCOL_VERSION.to_owned()),
                capabilities: Value::Object(Default::default()),
                client_info: Some(ClientInfo {
                    name: "claude-code".into(),
                    version: "1.0.0".into(),
                }),
            })
            .unwrap(),
        };
        let line = encode_frame(&McpFrame::Request(req)).unwrap();
        let decoded = decode_frame(&line).unwrap();
        match decoded {
            McpFrame::Request(decoded) => {
                let params: InitializeParams = serde_json::from_value(decoded.params).unwrap();
                assert_eq!(params.protocol_version.as_deref(), Some(PROTOCOL_VERSION));
                assert_eq!(params.client_info.unwrap().name, "claude-code");
            }
            other => panic!("expected Request, got {other:?}"),
        }
    }

    #[test]
    fn string_id_is_preserved() {
        let resp = McpResponse::ok(McpId::String("abc".into()), &Value::Null);
        let line = encode_frame(&McpFrame::Response(resp)).unwrap();
        let decoded = decode_frame(&line).unwrap();
        match decoded {
            McpFrame::Response(resp) => assert_eq!(resp.id, McpId::String("abc".into())),
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[test]
    fn tools_list_result_round_trips() {
        let result = ListToolsResult {
            tools: vec![ToolDefinition {
                name: "reverie.list_peers".into(),
                description: "Lists sibling sessions.".into(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {"scope": {"type": "string"}},
                }),
            }],
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["tools"][0]["name"], "reverie.list_peers");
        assert_eq!(value["tools"][0]["inputSchema"]["type"], "object");
    }

    #[test]
    fn call_tool_result_text_ok_wraps_payload_as_json_text() {
        #[derive(Serialize)]
        struct P {
            peers: Vec<u32>,
        }
        let payload = P {
            peers: vec![1, 2, 3],
        };
        let result = CallToolResult::text_ok(&payload);
        assert!(!result.is_error);
        match &result.content[0] {
            ToolContent::Text { text } => {
                let parsed: serde_json::Value = serde_json::from_str(text).unwrap();
                assert_eq!(parsed["peers"][1], 2);
            }
        }
    }

    #[test]
    fn call_tool_result_text_err_sets_is_error() {
        let result = CallToolResult::text_err("bridge unavailable");
        assert!(result.is_error);
        match &result.content[0] {
            ToolContent::Text { text } => assert_eq!(text, "bridge unavailable"),
        }
    }

    #[test]
    fn untagged_decode_distinguishes_request_response_notification() {
        let req = encode_frame(&McpFrame::Request(McpRequest {
            jsonrpc: "2.0".into(),
            id: McpId::Number(1),
            method: methods::PING.into(),
            params: Value::Null,
        }))
        .unwrap();
        let resp = encode_frame(&McpFrame::Response(McpResponse::ok(
            McpId::Number(1),
            &Value::Object(Default::default()),
        )))
        .unwrap();
        let notif = encode_frame(&McpFrame::Notification(McpNotification {
            jsonrpc: "2.0".into(),
            method: methods::NOTIFICATIONS_INITIALIZED.into(),
            params: Value::Null,
        }))
        .unwrap();
        assert!(matches!(decode_frame(&req).unwrap(), McpFrame::Request(_)));
        assert!(matches!(
            decode_frame(&resp).unwrap(),
            McpFrame::Response(_)
        ));
        assert!(matches!(
            decode_frame(&notif).unwrap(),
            McpFrame::Notification(_)
        ));
    }
}
