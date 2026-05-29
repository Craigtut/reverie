//! Binary entry point for the `reverie-bridge` helper.
//!
//! Reads identity from the environment, connects to the Reverie desktop's
//! Unix socket, handshakes, and drives the MCP loop over stdio. All of the
//! useful logic lives in `lib.rs`; this file is the thin shell that wires
//! `BridgeEnv` to [`UnixBridgeTransport`] and to [`run`].

use std::io::{BufReader, stdin, stdout};
use std::process::ExitCode;

use anyhow::{Context, Result};

fn main() -> ExitCode {
    match real_main() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            reverie_bridge::print_startup_error(&err);
            ExitCode::from(1)
        }
    }
}

fn real_main() -> Result<()> {
    let env = reverie_bridge::ensure_bridge_env().context("reading bridge environment")?;
    let mut transport = reverie_bridge::UnixBridgeTransport::connect(&env.socket_path)
        .context("connecting to Reverie bridge socket")?;
    let _address = reverie_bridge::handshake(&mut transport, env.session_id, &env.secret)
        .context("authenticating bridge session")?;
    let stdin = stdin();
    let stdout = stdout();
    reverie_bridge::run(&mut transport, BufReader::new(stdin.lock()), stdout.lock())
        .context("running MCP loop")?;
    Ok(())
}
