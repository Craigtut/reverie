//! Binary entry point for the `reverie-bridge` helper.
//!
//! The helper's reason to exist is to bridge an agent CLI's stdio MCP
//! connection to the running Reverie desktop. But the bridge entry is
//! installed *globally* in each CLI's user config, so the helper is also
//! launched whenever the user starts that CLI outside Reverie (or while
//! Reverie is down). Crashing in that case would surface a confusing
//! "MCP startup failed" error on every non-Reverie session.
//!
//! So the helper has two modes:
//!
//! 1. **Connected** — `REVERIE_*` env present, socket reachable, handshake
//!    succeeds. Run the full MCP loop with the real catalog.
//! 2. **Degraded** — env missing, socket missing, or handshake fails. Run
//!    the MCP loop in unavailable mode: speak `initialize` cleanly, advertise
//!    zero tools, return a clean error on `tools/call`. The parent CLI sees
//!    a well-behaved server with no tools and moves on quietly.
//!
//! The exit code is always 0 in the degraded case so the parent CLI does
//! not treat startup as failed.

use std::io::{BufReader, stdin, stdout};
use std::process::ExitCode;

fn main() -> ExitCode {
    let stdin = stdin();
    let stdout = stdout();
    let reader = BufReader::new(stdin.lock());
    let mut writer = stdout.lock();

    let env = match reverie_bridge::ensure_bridge_env() {
        Ok(env) => env,
        Err(err) => {
            return run_degraded(reader, &mut writer, format!("env: {err}"));
        }
    };

    let mut transport = match reverie_bridge::UnixBridgeTransport::connect(&env.socket_path) {
        Ok(transport) => transport,
        Err(err) => {
            return run_degraded(reader, &mut writer, format!("socket: {err}"));
        }
    };

    if let Err(err) = reverie_bridge::handshake(&mut transport, env.session_id, &env.secret) {
        return run_degraded(reader, &mut writer, format!("handshake: {err}"));
    }

    match reverie_bridge::run(&mut transport, reader, &mut writer) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            // MCP loop IO error: the parent CLI's connection is gone anyway,
            // so logging is best-effort and we still exit 0.
            eprintln!("reverie-bridge: MCP loop ended: {err}");
            ExitCode::SUCCESS
        }
    }
}

fn run_degraded<R: std::io::BufRead, W: std::io::Write>(
    reader: R,
    writer: &mut W,
    reason: String,
) -> ExitCode {
    // Log the reason once on stderr so power users can `cortex --debug` /
    // similar and see why no Reverie tools are available, then serve the
    // degraded MCP loop.
    eprintln!("reverie-bridge: running in degraded mode ({reason})");
    if let Err(err) = reverie_bridge::run_unavailable(reader, writer, reason) {
        eprintln!("reverie-bridge: degraded MCP loop ended: {err}");
    }
    ExitCode::SUCCESS
}
