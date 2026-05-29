//! `reverie-bridge-preturn-hook`: the Cortex pre-turn hook handler.
//!
//! Spawned by Cortex Code (and conceptually by any CLI with a similar hook
//! surface) at the start of each agent turn. Reads a JSON envelope from
//! stdin, asks the desktop bridge whether the current session has any
//! pending inbound messages on its open connections, and writes a JSON
//! response on stdout.
//!
//! Wire shape (envelope, stdin):
//! ```json
//! {"event":"pre_turn","sessionId":"...","cwd":"...","timestamp":"...","version":1,"userPrompt":"..."}
//! ```
//!
//! Wire shape (response, stdout):
//! ```json
//! {"additionalContext":"You have 1 unread message from <peer>. Call reverie.pending_messages to read."}
//! ```
//!
//! Failures (no env, bridge unreachable, etc.) produce an empty response so
//! the agent's turn proceeds normally. Errors go to stderr for diagnostics.

use std::io::{Read, Write, stdin, stdout};
use std::process::ExitCode;

use anyhow::{Context, Result};
use reverie_bridge::{BridgeCallError, BridgeTransport, UnixBridgeTransport, handshake};
use reverie_core::ConnectionStatus;
use reverie_core::bridge_protocol::{
    ListConnectionsParams, ListConnectionsResult, PendingMessagesParams, PendingMessagesResult,
    methods,
};
use serde::{Deserialize, Serialize};

fn main() -> ExitCode {
    match real_main() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            // Always emit a valid JSON response so the host treats us as
            // "no context to add" rather than failing the turn.
            let _ = stdout().write_all(b"{}\n");
            let _ = stdout().flush();
            eprintln!("reverie-bridge-preturn-hook: {err}");
            for cause in err.chain().skip(1) {
                eprintln!("  caused by: {cause}");
            }
            ExitCode::from(0)
        }
    }
}

fn real_main() -> Result<()> {
    let mut input = String::new();
    stdin()
        .read_to_string(&mut input)
        .context("reading hook envelope from stdin")?;
    // We do not actually need the envelope's fields today; the relevant
    // identity is in REVERIE_SESSION_ID/SECRET. Parse only to verify shape.
    let _envelope: serde_json::Value =
        serde_json::from_str(input.trim()).context("parsing hook envelope JSON")?;

    let env = reverie_bridge::ensure_bridge_env()
        .context("REVERIE_* env not set; pre-turn hook cannot reach the bridge")?;
    let mut transport = UnixBridgeTransport::connect(&env.socket_path)
        .context("connecting to Reverie bridge socket")?;
    let _address = handshake(&mut transport, env.session_id, &env.secret)
        .context("authenticating bridge session")?;

    let connections_result: ListConnectionsResult = transport
        .call(methods::LIST_CONNECTIONS, &ListConnectionsParams {})
        .map_err(map_bridge_error)?;

    let mut notices: Vec<String> = Vec::new();
    for connection in connections_result.connections {
        if connection.status != ConnectionStatus::Open {
            continue;
        }
        let messages: PendingMessagesResult = transport
            .call(
                methods::PENDING_MESSAGES,
                &PendingMessagesParams {
                    connection_id: connection.id,
                    since_sequence: 0,
                },
            )
            .map_err(map_bridge_error)?;
        let undelivered: Vec<_> = messages
            .messages
            .iter()
            .filter(|message| {
                message.to_session == env.session_id && message.delivered_at.is_none()
            })
            .collect();
        if undelivered.is_empty() {
            continue;
        }
        let peer_label = connection
            .topic
            .clone()
            .unwrap_or_else(|| connection.reason_opened.clone());
        let notice = format!(
            "You have {n} unread message{plural} on connection \"{label}\" (id {id}). \
Call `reverie.pending_messages` with that connection id to read them.",
            n = undelivered.len(),
            plural = if undelivered.len() == 1 { "" } else { "s" },
            label = peer_label,
            id = connection.id,
        );
        notices.push(notice);
    }

    let response = HookResponse {
        additional_context: if notices.is_empty() {
            None
        } else {
            Some(notices.join("\n"))
        },
    };
    let out = serde_json::to_string(&response).context("encoding hook response")?;
    let mut stdout = stdout().lock();
    stdout.write_all(out.as_bytes())?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    additional_context: Option<String>,
}

fn map_bridge_error(err: BridgeCallError) -> anyhow::Error {
    anyhow::anyhow!("bridge call failed: {err}")
}
