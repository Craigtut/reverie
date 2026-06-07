//! `reverie-codex-hook`: the Codex CLI lifecycle-hook forwarder.
//!
//! Codex runs this as a `type="command"` hook (installed per-session via `-c`,
//! see `reverie_core::codex_hooks`) on each lifecycle event (SessionStart,
//! UserPromptSubmit, Stop, ...). It reads the hook JSON from stdin and POSTs it
//! verbatim to Reverie's localhost hook server at `/hooks/codex/<token>`, where
//! `translate_codex` turns it into an `ActivityState`.
//!
//! The per-session token and port arrive in the environment
//! (`REVERIE_HOOK_TOKEN` / `REVERIE_HOOK_PORT`), never in the command string, so
//! the command string stays byte-identical across launches: its bytes are what
//! Codex's hook trust hash is computed over, and a stable string keeps the
//! pre-seeded trust valid.
//!
//! Codex runs hooks SYNCHRONOUSLY INLINE in the turn, so this must be fast and
//! must never fail the turn: every path exits 0, all socket I/O is bounded by a
//! short timeout, and a missing server or env is a silent no-op (the rollout
//! watcher remains the fallback signal). No dependencies beyond `std`.

use std::env;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::ExitCode;
use std::time::Duration;

/// Localhost connect/write/read budget. Generous for a healthy local server,
/// tight enough that a downed server can never stall the agent's turn. (A
/// refused connection fails immediately; this only bounds a server that accepts
/// but hangs.)
const TIMEOUT: Duration = Duration::from_millis(750);

fn main() -> ExitCode {
    // Best-effort: the agent's turn must never wait on us or fail because of us,
    // so we always exit 0 regardless of what happened.
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

    let Ok(addr) = format!("127.0.0.1:{port}").parse::<SocketAddr>() else {
        return Ok(());
    };
    let mut stream = TcpStream::connect_timeout(&addr, TIMEOUT)?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    stream.set_read_timeout(Some(TIMEOUT))?;

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

    // Best-effort drain of the response so the server finishes its write cycle
    // before we drop the socket; bounded by the read timeout.
    let mut sink = [0u8; 256];
    let _ = stream.read(&mut sink);
    Ok(())
}
