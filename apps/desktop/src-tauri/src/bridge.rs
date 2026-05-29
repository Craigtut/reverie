//! Bridge listener wiring for the desktop process.
//!
//! Sets up the inter-agent connection bridge that helper subprocesses talk
//! to. The two pieces this module owns:
//!
//! 1. A [`ConnectionService`] backed by an in-memory repository. Phase 6 will
//!    swap this for a SQLite-backed repo via the
//!    [`ConnectionRepository`](reverie_core::ConnectionRepository) trait.
//! 2. A Unix-domain socket listener that, for each accepted connection,
//!    spawns a per-connection thread running
//!    [`reverie_core::serve_connection`]. One helper subprocess = one
//!    accepted connection = one dispatch thread.
//!
//! Windows support is a follow-up; the bridge is currently Unix-only because
//! the helper uses `UnixStream`. The path of least resistance for a Windows
//! port is to abstract the transport in `reverie-bridge` and reuse the same
//! framing over named pipes.

#![cfg(unix)]

use std::io::BufReader;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::SystemTime;

use anyhow::{Context, Result};
use reverie_core::{Clock, ConnectionRepository, ConnectionService, SystemClock, serve_connection};

/// Managed Tauri state holding the path agent CLIs (via the
/// `reverie-bridge` helper) should connect to. Injected into spawned-session
/// environment via `REVERIE_BRIDGE_SOCK`.
#[derive(Clone, Debug)]
pub(crate) struct BridgeInfo {
    pub(crate) socket_path: PathBuf,
}

/// Tiny static accessor for "now in ISO-8601 UTC". Wraps [`SystemClock`]
/// so command modules do not have to thread one through.
pub(crate) struct SystemClockIso;

impl SystemClockIso {
    pub(crate) fn now() -> String {
        SystemClock.now_iso8601()
    }
}

/// Best-effort: locate a writable, short-enough directory for the bridge
/// socket. Unix-domain socket paths are capped (~104 chars on macOS, ~108 on
/// Linux), so `$TMPDIR` is preferable to the app-data dir which can be quite
/// deep under macOS sandboxing.
///
/// Under macOS app-sandbox a deep `TMPDIR` can push us past the 104-byte
/// limit, which would make `bind()` fail with `ENAMETOOLONG` and silently
/// disable the entire bridge. As a fallback for that case we drop to a
/// hash-suffixed name under `/tmp` (always present and short).
pub(crate) fn default_socket_path() -> PathBuf {
    const SOFT_LIMIT: usize = 100;
    let dir = std::env::temp_dir();
    let pid = std::process::id();
    let stamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let preferred = dir.join(format!("reverie-bridge-{pid}-{stamp}.sock"));
    if preferred.to_string_lossy().len() <= SOFT_LIMIT {
        return preferred;
    }
    // Fall back to a short name. Mix pid and stamp into 8 hex chars so two
    // concurrent desktops cannot collide on the same file.
    let suffix = pid as u64 ^ stamp;
    PathBuf::from(format!("/tmp/rvb-{:016x}.sock", suffix))
}

/// Start the bridge. Binds the socket, spawns the accept thread, and returns
/// the live [`ConnectionService`] plus a [`BridgeInfo`] for managed state.
/// Errors only if the socket cannot be bound; per-connection errors are
/// logged to stderr and do not propagate.
pub(crate) fn start_bridge(
    socket_path: PathBuf,
    repository: Arc<dyn ConnectionRepository>,
) -> Result<(Arc<ConnectionService>, BridgeInfo)> {
    // Clean up any stale socket file from a prior crash. Best-effort: a
    // missing path is fine; an `EACCES` here will surface immediately on the
    // `bind` below with a more useful error.
    let _ = std::fs::remove_file(&socket_path);

    let listener = UnixListener::bind(&socket_path).with_context(|| {
        format!(
            "binding inter-agent bridge socket at {}",
            socket_path.display()
        )
    })?;

    let service: Arc<ConnectionService> = Arc::new(ConnectionService::new(repository));
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);

    let accept_service = Arc::clone(&service);
    let accept_clock = Arc::clone(&clock);

    thread::Builder::new()
        .name("reverie-bridge-accept".to_owned())
        .spawn(move || {
            for incoming in listener.incoming() {
                let stream = match incoming {
                    Ok(stream) => stream,
                    Err(err) => {
                        eprintln!("[reverie-bridge] accept error: {err}");
                        continue;
                    }
                };
                let svc = Arc::clone(&accept_service);
                let clk = Arc::clone(&accept_clock);
                thread::Builder::new()
                    .name("reverie-bridge-conn".to_owned())
                    .spawn(move || {
                        let reader = match stream.try_clone() {
                            Ok(stream) => BufReader::new(stream),
                            Err(err) => {
                                eprintln!("[reverie-bridge] clone stream: {err}");
                                return;
                            }
                        };
                        let writer = stream;
                        if let Err(err) = serve_connection(svc, clk, reader, writer) {
                            eprintln!("[reverie-bridge] connection error: {err}");
                        }
                    })
                    .ok();
            }
        })
        .context("spawn bridge accept thread")?;

    Ok((service, BridgeInfo { socket_path }))
}

/// Mint a short, random secret for per-session bridge authentication. Format
/// is 32 hex characters (128 bits) which is plenty for a local-only,
/// short-lived secret. Avoids pulling in `rand` by sourcing entropy from the
/// system clock and pid; collisions are not security-meaningful because the
/// secret only authenticates to a peer that already knows the session id.
pub(crate) fn mint_session_secret() -> String {
    let mut bytes = [0u8; 16];
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u128)
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let seed = nanos ^ (pid << 64);
    // Splitmix64 on the seed to spread bits, two rounds to fill 16 bytes.
    let mut state = seed as u64 ^ (seed >> 64) as u64;
    for chunk in bytes.chunks_mut(8) {
        state = state.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^= z >> 31;
        for (slot, byte) in chunk.iter_mut().zip(z.to_le_bytes()) {
            *slot = byte;
        }
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use reverie_core::SessionAddress;
    use reverie_core::connection_service::RegisteredSession;
    use reverie_core::domain::AgentKind;
    use std::os::unix::net::UnixStream;
    use std::time::Duration;
    use tempfile::TempDir;
    use uuid::Uuid;

    #[test]
    fn mint_session_secret_returns_32_hex_chars() {
        let s = mint_session_secret();
        assert_eq!(s.len(), 32);
        assert!(s.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn mint_session_secret_is_unique_across_calls() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..50 {
            assert!(seen.insert(mint_session_secret()), "duplicate secret");
        }
    }

    #[test]
    fn start_bridge_accepts_a_helper_connection_and_handshakes() {
        use reverie_core::InMemoryConnectionRepository;
        let tmp = TempDir::new().unwrap();
        let socket = tmp.path().join("bridge.sock");
        let (service, info) = start_bridge(
            socket.clone(),
            Arc::new(InMemoryConnectionRepository::new()),
        )
        .expect("start bridge");
        assert_eq!(info.socket_path, socket);

        // Register one session so handshake has something to authenticate against.
        let session_id = Uuid::new_v4();
        let secret = mint_session_secret();
        service.register_session(RegisteredSession {
            session_id,
            secret: secret.clone(),
            address: SessionAddress {
                agent_kind: AgentKind::ClaudeCode,
                project_id: None,
                project_name: None,
                focus_id: Uuid::from_bytes([0x10; 16]),
                focus_title: "F".into(),
                session_title: "Test".into(),
            },
        });

        // Connect as a fake helper and send a handshake frame.
        let mut stream = UnixStream::connect(&socket).expect("connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "handshake",
            "params": {
                "sessionId": session_id.to_string(),
                "secret": secret,
                "protocolVersion": 1,
            }
        });
        use std::io::{BufRead, BufReader, Write};
        writeln!(stream, "{}", serde_json::to_string(&frame).unwrap()).unwrap();

        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).expect("read reply");
        let parsed: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(parsed["id"], 1);
        assert!(
            parsed["result"].is_object(),
            "handshake should succeed: {parsed}"
        );
        assert_eq!(parsed["result"]["address"]["sessionTitle"], "Test");
    }
}
