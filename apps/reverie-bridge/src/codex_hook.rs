//! `reverie-codex-hook`: the Codex CLI lifecycle-hook forwarder.
//!
//! Codex runs this as a `type="command"` hook (installed per-session via `-c`,
//! see `reverie_core::codex_hooks`) on each lifecycle event (SessionStart,
//! UserPromptSubmit, PermissionRequest, Stop). It reads the hook JSON from stdin
//! and POSTs it verbatim to Reverie's localhost hook server at
//! `/hooks/codex/<token>`, where `translate_codex` turns it into an
//! `ActivityState`.
//!
//! The per-session token and port arrive in the environment
//! (`REVERIE_HOOK_TOKEN` / `REVERIE_HOOK_PORT`), never in the command string, so
//! the command string stays byte-identical across launches: its bytes are what
//! Codex's hook trust hash is computed over, and a stable string keeps the
//! pre-seeded trust valid.
//!
//! Codex runs hooks SYNCHRONOUSLY INLINE in the turn, so the lifecycle events
//! (SessionStart / UserPromptSubmit / Stop) must be fast and must never fail the
//! turn: those paths exit 0 with a tightly bounded socket budget, and a missing
//! server or env is a silent no-op (the rollout watcher remains the fallback).
//!
//! `PermissionRequest` is the deliberate exception. There the turn is *already*
//! blocked on the user, so this hook is allowed to block: the server holds the
//! connection open until the user answers Reverie's native approval card, then
//! replies with the decision body. We read that body and relay it verbatim to our
//! stdout, which Codex parses as this hook's PermissionRequest decision (allow /
//! deny), short-circuiting Codex's own prompt. If the server times out and
//! replies with no body, we print nothing and Codex shows its own prompt
//! (deny-safe). No dependencies beyond `std`.

use std::env;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::ExitCode;
use std::time::Duration;

/// Localhost connect/write budget, and the read budget for the fast lifecycle
/// events. Generous for a healthy local server, tight enough that a downed server
/// can never stall the agent's turn.
const SHORT_TIMEOUT: Duration = Duration::from_millis(750);

/// Read budget for a `PermissionRequest`: the server parks the connection while
/// the user answers the card. Sits above the server's own decision wait (570s)
/// and just under Codex's 600s hook ceiling, so we relay either the decision or
/// the server's no-decision reply before Codex abandons the hook.
const APPROVAL_READ_TIMEOUT: Duration = Duration::from_secs(595);

fn main() -> ExitCode {
    // Best-effort: the agent's turn must never fail because of us, so we always
    // exit 0 regardless of what happened.
    let _ = forward();
    ExitCode::SUCCESS
}

fn forward() -> std::io::Result<()> {
    // Always drain stdin first so Codex's write to our pipe completes even when
    // we have nothing to forward to.
    let mut body = Vec::new();
    std::io::stdin().read_to_end(&mut body)?;

    // No token/port means Reverie is not listening for this session: nothing to
    // do. (Reverie always injects both for the sessions it instruments.)
    let (Ok(port), Ok(token)) = (
        env::var("REVERIE_HOOK_PORT"),
        env::var("REVERIE_HOOK_TOKEN"),
    ) else {
        return Ok(());
    };

    // A PermissionRequest is the one event we hold open for a decision to relay.
    // The event name is the only place this token appears in the hook payload, so
    // a substring check is enough and keeps us free of a JSON dependency.
    let is_permission = contains(&body, b"PermissionRequest");

    let Ok(addr) = format!("127.0.0.1:{port}").parse::<SocketAddr>() else {
        return Ok(());
    };
    let mut stream = TcpStream::connect_timeout(&addr, SHORT_TIMEOUT)?;
    stream.set_write_timeout(Some(SHORT_TIMEOUT))?;
    stream.set_read_timeout(Some(if is_permission {
        APPROVAL_READ_TIMEOUT
    } else {
        SHORT_TIMEOUT
    }))?;

    let header = format!(
        "POST /hooks/codex/{token} HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\
         \r\n",
        len = body.len(),
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(&body)?;
    stream.flush()?;

    if is_permission {
        // The server parks the connection until the user decides, then replies
        // 200 with the decision JSON (or 204 with no body on timeout). Read the
        // whole response and relay only the JSON body to our stdout, which Codex
        // parses as this hook's decision output. An empty body relays nothing, so
        // Codex falls back to its own prompt (deny-safe).
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
        if let Some(json) = http_response_body(&response) {
            if !json.is_empty() {
                let mut stdout = std::io::stdout();
                let _ = stdout.write_all(json);
                let _ = stdout.flush();
            }
        }
    } else {
        // Best-effort drain of the response so the server finishes its write
        // cycle before we drop the socket; bounded by the read timeout.
        let mut sink = [0u8; 256];
        let _ = stream.read(&mut sink);
    }
    Ok(())
}

/// Whether `haystack` contains the byte sequence `needle`.
fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|window| window == needle)
}

/// The body of an HTTP/1.1 response: everything after the first CRLFCRLF that
/// separates the status line + headers from the body. `None` when no separator is
/// present (a truncated or malformed response).
fn http_response_body(response: &[u8]) -> Option<&[u8]> {
    const SEP: &[u8] = b"\r\n\r\n";
    response
        .windows(SEP.len())
        .position(|window| window == SEP)
        .map(|index| &response[index + SEP.len()..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contains_finds_the_event_name() {
        let payload = br#"{"hook_event_name":"PermissionRequest","tool_name":"Bash"}"#;
        assert!(contains(payload, b"PermissionRequest"));
        let other = br#"{"hook_event_name":"Stop"}"#;
        assert!(!contains(other, b"PermissionRequest"));
    }

    #[test]
    fn http_response_body_extracts_json_after_the_headers() {
        let response =
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
        assert_eq!(http_response_body(response), Some(&b"{}"[..]));
    }

    #[test]
    fn http_response_body_is_empty_for_a_204() {
        let response = b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
        assert_eq!(http_response_body(response), Some(&b""[..]));
    }

    #[test]
    fn http_response_body_is_none_without_a_separator() {
        assert_eq!(http_response_body(b"HTTP/1.1 200 OK"), None);
    }
}
