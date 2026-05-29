//! End-to-end gate test for Phase 0.
//!
//! Spawns the actual `reverie-bridge` binary as a subprocess with valid
//! `REVERIE_*` environment, runs an in-process bridge server backed by a
//! Cortex-free `ConnectionService` with two registered mock sessions, drives
//! the helper through `initialize`, `notifications/initialized`,
//! `tools/list`, and `tools/call: reverie.list_peers` over stdio, and
//! asserts the returned peer list matches.
//!
//! This test does not require an installed Tauri runtime or any of the agent
//! CLIs. The only system requirement is that `cargo test` is able to spawn
//! the binary it just built. Cargo wires the path through the
//! `CARGO_BIN_EXE_reverie-bridge` environment variable, which is set
//! automatically for integration tests of binary crates.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use reverie_core::bridge_protocol::ListPeersResult;
use reverie_core::connection_repository::InMemoryConnectionRepository;
use reverie_core::connection_service::{ConnectionService, RegisteredSession, SessionAddress};
use reverie_core::domain::{AgentKind, SessionId};
use reverie_core::{FixedClock, serve_connection};
use serde_json::Value;
use tempfile::TempDir;
use uuid::Uuid;

const HELPER_BIN: &str = env!("CARGO_BIN_EXE_reverie-bridge");
const HELPER_TIMEOUT: Duration = Duration::from_secs(10);

#[test]
fn end_to_end_handshake_then_list_peers_through_stdio_mcp() {
    let tmp = TempDir::new().expect("temp dir");
    let socket_path = tmp.path().join("reverie-bridge.sock");

    let service = Arc::new(ConnectionService::new(Arc::new(
        InMemoryConnectionRepository::new(),
    )));

    let caller_session_id: SessionId = Uuid::from_bytes([0xA1; 16]);
    let caller_secret = "caller-secret".to_owned();
    let peer_session_id: SessionId = Uuid::from_bytes([0xB2; 16]);

    let focus_id = Uuid::from_bytes([0x10; 16]);
    let caller_address = SessionAddress {
        agent_kind: AgentKind::ClaudeCode,
        project_id: None,
        project_name: None,
        focus_id,
        focus_title: "Inter-agent handoff design".to_owned(),
        session_title: "Claude orchestrator".to_owned(),
    };
    let peer_address = SessionAddress {
        agent_kind: AgentKind::CortexCode,
        project_id: None,
        project_name: None,
        focus_id,
        focus_title: "Inter-agent handoff design".to_owned(),
        session_title: "Cortex diagram".to_owned(),
    };

    service.register_session(RegisteredSession {
        session_id: caller_session_id,
        secret: caller_secret.clone(),
        address: caller_address.clone(),
    });
    service.register_session(RegisteredSession {
        session_id: peer_session_id,
        secret: "peer-secret".to_owned(),
        address: peer_address.clone(),
    });

    // Spin up the Unix-socket bridge server in a background thread. It only
    // accepts one connection (from the helper) and runs serve_connection for
    // it before exiting; the test thread joins it at the end.
    let listener = UnixListener::bind(&socket_path).expect("bind unix socket");
    let server_service = Arc::clone(&service);
    let server_thread = thread::Builder::new()
        .name("bridge-server-test".into())
        .spawn(move || {
            let (stream, _addr) = listener.accept().expect("accept helper connection");
            let reader = BufReader::new(stream.try_clone().expect("clone stream"));
            let writer = stream;
            serve_connection(
                server_service,
                Arc::new(FixedClock::new("2026-05-28T00:00:00Z")),
                reader,
                writer,
            )
            .expect("serves until eof");
        })
        .expect("spawn server thread");

    // Spawn the helper binary with our env.
    let mut helper = Command::new(HELPER_BIN)
        .env("REVERIE_SESSION_ID", caller_session_id.to_string())
        .env("REVERIE_SESSION_SECRET", &caller_secret)
        .env("REVERIE_BRIDGE_SOCK", &socket_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn helper");

    let mut helper_stdin = helper.stdin.take().expect("helper stdin");
    let helper_stdout = helper.stdout.take().expect("helper stdout");
    let helper_stderr = helper.stderr.take().expect("helper stderr");

    // Send: initialize -> notifications/initialized -> tools/list -> tools/call list_peers.
    let frames = [
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "e2e-test", "version": "0"}
            }
        }),
        serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }),
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list"
        }),
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "reverie.list_peers",
                "arguments": {"scope": "focus"}
            }
        }),
    ];

    for frame in &frames {
        writeln!(helper_stdin, "{}", serde_json::to_string(frame).unwrap())
            .expect("write frame to helper stdin");
    }
    drop(helper_stdin); // signal EOF so the helper exits its run loop cleanly

    // Read three responses (initialize, tools/list, tools/call). The
    // notification draws no response.
    let mut reader = BufReader::new(helper_stdout);
    let mut responses = Vec::new();
    let start = Instant::now();
    while responses.len() < 3 {
        if start.elapsed() > HELPER_TIMEOUT {
            let mut stderr = String::new();
            BufReader::new(helper_stderr)
                .read_to_string(&mut stderr)
                .ok();
            panic!("helper did not produce 3 responses in time. stderr was: {stderr}");
        }
        let mut line = String::new();
        let read = reader.read_line(&mut line).expect("read helper stdout");
        if read == 0 {
            // Helper EOF before all responses arrived; surface stderr for
            // diagnostics.
            let mut stderr = String::new();
            BufReader::new(helper_stderr)
                .read_to_string(&mut stderr)
                .ok();
            panic!(
                "helper closed stdout after {} responses. stderr was: {stderr}",
                responses.len()
            );
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(trimmed).expect("response is JSON");
        responses.push(value);
    }

    // Allow the helper to clean up.
    let status = helper.wait().expect("helper exits");
    assert!(status.success(), "helper must exit with code 0");

    // Make sure the server side also returned cleanly.
    server_thread.join().expect("server thread joins");

    // ----- assertions -----

    // Response 1: initialize result advertises tools capability and serverInfo.
    let initialize = &responses[0];
    assert_eq!(initialize["id"], 1);
    assert_eq!(initialize["result"]["protocolVersion"], "2024-11-05");
    assert!(initialize["result"]["capabilities"]["tools"].is_object());
    assert_eq!(initialize["result"]["serverInfo"]["name"], "reverie-bridge");

    // Response 2: tools/list contains the reverie.list_peers tool.
    let tools_list = &responses[1];
    assert_eq!(tools_list["id"], 2);
    let tools = tools_list["result"]["tools"]
        .as_array()
        .expect("tools array");
    let names: Vec<&str> = tools
        .iter()
        .map(|tool| tool["name"].as_str().unwrap_or_default())
        .collect();
    assert!(
        names.iter().any(|n| *n == "reverie.list_peers"),
        "expected reverie.list_peers in {names:?}"
    );

    // Response 3: tools/call returns a CallToolResult whose text body
    // contains the ListPeersResult JSON; the inner peers array MUST contain
    // exactly the one peer registered in the same focus.
    let tools_call = &responses[2];
    assert_eq!(tools_call["id"], 3);
    let call_result = &tools_call["result"];
    assert_eq!(
        call_result["isError"].as_bool().unwrap_or(true),
        false,
        "tools/call result should not be an error: {call_result}"
    );
    let content = call_result["content"]
        .as_array()
        .expect("content array")
        .first()
        .expect("at least one content block");
    assert_eq!(content["type"], "text");
    let text = content["text"].as_str().expect("text body");
    let inner: ListPeersResult =
        serde_json::from_str(text).expect("text body parses as ListPeersResult");
    assert_eq!(
        inner.peers.len(),
        1,
        "expected exactly one peer in same focus, got {:?}",
        inner.peers,
    );
    assert_eq!(inner.peers[0].session_id, peer_session_id);
    assert_eq!(inner.peers[0].address.session_title, "Cortex diagram");

    // Drop tmp keeps the socket file alive through the test, then cleans up.
    let _ = &tmp;
    let _ = PathBuf::from(HELPER_BIN); // ensure HELPER_BIN is read.
}

#[test]
fn helper_exits_nonzero_when_session_env_missing() {
    let helper = Command::new(HELPER_BIN)
        .env_remove("REVERIE_SESSION_ID")
        .env_remove("REVERIE_SESSION_SECRET")
        .env_remove("REVERIE_BRIDGE_SOCK")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn helper");
    let output = helper.wait_with_output().expect("helper exits");
    assert!(
        !output.status.success(),
        "helper without REVERIE_* must exit non-zero"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("REVERIE_SESSION_ID") || stderr.contains("bridge environment"),
        "stderr should name the missing env var, got: {stderr}"
    );
}

#[test]
fn helper_exits_nonzero_when_bridge_socket_unreachable() {
    let tmp = TempDir::new().expect("temp dir");
    let socket_path = tmp.path().join("missing.sock");
    let helper = Command::new(HELPER_BIN)
        .env("REVERIE_SESSION_ID", Uuid::new_v4().to_string())
        .env("REVERIE_SESSION_SECRET", "s")
        .env("REVERIE_BRIDGE_SOCK", &socket_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn helper");
    let output = helper.wait_with_output().expect("helper exits");
    assert!(
        !output.status.success(),
        "helper without a listening socket must exit non-zero"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("connect") || stderr.contains("socket"),
        "stderr should name the connection failure, got: {stderr}"
    );
}
