//! HTTP receiver for Claude Code and Codex CLI hook payloads.
//!
//! Claude and Codex both emit lifecycle hooks (PermissionRequest, Stop,
//! PostToolUse, SessionStart, SessionEnd, …) that can be configured to POST
//! JSON to a localhost endpoint. Reverie hosts that endpoint via this module:
//! a tiny synchronous HTTP/1.1 server bound to 127.0.0.1 on an OS-assigned
//! port, routing per-CLI on the URL path and translating each payload into
//! the unified [`ActivityState`] shape so the dashboard cares only about state
//! transitions, never about which CLI emitted them.
//!
//! Scope of this module: parse + translate + emit. It does **not** write
//! Claude `settings.json` or Codex `config.toml` into each session's cwd, and
//! it does not yet enforce per-session secrets; those concerns live alongside
//! the session launch path in the Tauri shell.

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex,
        mpsc::{self, Receiver, Sender},
    },
    thread::{self, JoinHandle},
};

use anyhow::{Context, Result, anyhow};
use serde::Deserialize;
use serde_json::Value;
use tiny_http::{Method, Response, Server, StatusCode};

use crate::activity::{
    ActivityError, ActivityState, ActivityStatus, ErrorCategory, ExitReason, FinalExit,
    PermissionRequest,
};

const ACTIVITY_VERSION: u32 = 1;
const CLAUDE_PATH_PREFIX: &str = "/hooks/claude";
const CODEX_PATH_PREFIX: &str = "/hooks/codex";

/// Which CLI sourced a translated update. Reverie carries this through to the
/// dashboard so adapter-specific copy and routing stay possible.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookSource {
    ClaudeCode,
    CodexCli,
}

/// One translated update from the hook stream. Mirrors the public shape used
/// by `CortexActivityUpdate` so the Tauri shell can fan both adapters into a
/// single dashboard channel.
#[derive(Clone, Debug)]
pub enum HookActivityUpdate {
    State {
        source: HookSource,
        native_session_id: String,
        state: ActivityState,
    },
    Removed {
        source: HookSource,
        native_session_id: String,
    },
}

/// Handle returned by [`start_hook_server`]. Drain `events` for translated
/// updates. The server stops when the handle is dropped: tiny_http's accept
/// loop is unblocked, the worker exits, and the bound socket closes.
pub struct HookServerHandle {
    pub events: Receiver<HookActivityUpdate>,
    pub port: u16,
    server: Arc<Server>,
    worker: Option<JoinHandle<()>>,
}

impl HookServerHandle {
    pub fn local_addr(&self) -> SocketAddr {
        // Server::server_addr returns ListeningAddr; for our IP-bound listener
        // this is always an IP socket address.
        match self.server.server_addr() {
            tiny_http::ListenAddr::IP(addr) => addr,
            tiny_http::ListenAddr::Unix(_) => unreachable!("hook server binds IP only"),
        }
    }
}

impl Drop for HookServerHandle {
    fn drop(&mut self) {
        // tiny_http::Server::unblock causes incoming_requests() to return None
        // so the worker thread exits its loop without blocking forever on a
        // closed socket.
        self.server.unblock();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Bind a localhost HTTP server on an OS-assigned port and start translating
/// incoming hook POSTs into [`HookActivityUpdate`]s.
pub fn start_hook_server() -> Result<HookServerHandle> {
    let server = Server::http("127.0.0.1:0")
        .map_err(|err| anyhow!("failed to bind hook HTTP server: {err}"))?;
    let server = Arc::new(server);

    let local = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr,
        tiny_http::ListenAddr::Unix(_) => {
            return Err(anyhow!("expected an IP socket for the hook server"));
        }
    };
    let port = local.port();

    let (tx, rx) = mpsc::channel::<HookActivityUpdate>();
    let sequences: Arc<Mutex<HashMap<String, u64>>> = Arc::new(Mutex::new(HashMap::new()));

    let worker_server = Arc::clone(&server);
    let worker_sequences = Arc::clone(&sequences);
    let worker = thread::Builder::new()
        .name("reverie-hook-http-server".to_owned())
        .spawn(move || run_request_loop(worker_server, worker_sequences, tx))
        .context("spawning hook HTTP worker thread")?;

    Ok(HookServerHandle {
        events: rx,
        port,
        server,
        worker: Some(worker),
    })
}

fn run_request_loop(
    server: Arc<Server>,
    sequences: Arc<Mutex<HashMap<String, u64>>>,
    tx: Sender<HookActivityUpdate>,
) {
    for mut request in server.incoming_requests() {
        let url = request.url().to_owned();
        let method = request.method().clone();
        if method != Method::Post {
            let _ = request.respond(simple_response(405, "method not allowed"));
            continue;
        }
        let source = if url.starts_with(CLAUDE_PATH_PREFIX) {
            HookSource::ClaudeCode
        } else if url.starts_with(CODEX_PATH_PREFIX) {
            HookSource::CodexCli
        } else {
            let _ = request.respond(simple_response(404, "not found"));
            continue;
        };

        let mut body = String::new();
        if request.as_reader().read_to_string(&mut body).is_err() {
            let _ = request.respond(simple_response(400, "invalid utf-8 body"));
            continue;
        }
        let payload: Value = match serde_json::from_str(&body) {
            Ok(value) => value,
            Err(_) => {
                let _ = request.respond(simple_response(400, "invalid json"));
                continue;
            }
        };

        if let Some(update) = translate(source, &payload, &sequences) {
            let _ = tx.send(update);
        }
        let _ = request.respond(simple_response(204, ""));
    }
}

fn simple_response(status: u16, body: &'static str) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body).with_status_code(StatusCode(status))
}

fn next_sequence(sequences: &Mutex<HashMap<String, u64>>, session_id: &str) -> u64 {
    let mut guard = sequences.lock().unwrap_or_else(|err| err.into_inner());
    let counter = guard.entry(session_id.to_owned()).or_insert(0);
    *counter += 1;
    *counter
}

fn translate(
    source: HookSource,
    payload: &Value,
    sequences: &Mutex<HashMap<String, u64>>,
) -> Option<HookActivityUpdate> {
    match source {
        HookSource::ClaudeCode => translate_claude(payload, sequences),
        HookSource::CodexCli => translate_codex(payload, sequences),
    }
}

/// Claude Code and Codex CLI both share a generic hook envelope: a top-level
/// `hook_event_name` discriminator plus a `session_id`, `cwd`, and event
/// payload fields. The exact set differs, but both honor this skeleton.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct HookEnvelope {
    hook_event_name: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    tool_input: Option<Value>,
    #[serde(default)]
    error_type: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

fn parse_envelope(payload: &Value) -> Option<HookEnvelope> {
    serde_json::from_value(payload.clone()).ok()
}

fn translate_claude(
    payload: &Value,
    sequences: &Mutex<HashMap<String, u64>>,
) -> Option<HookActivityUpdate> {
    let envelope = parse_envelope(payload)?;
    let session_id = envelope.session_id.clone()?;
    let timestamp = envelope.timestamp.clone().unwrap_or_else(now_iso8601);
    let sequence = next_sequence(sequences, &session_id);
    let cwd = envelope.cwd.clone().unwrap_or_default();

    let state = match envelope.hook_event_name.as_str() {
        "PermissionRequest" => build_state_awaiting_permission(
            &session_id,
            timestamp,
            sequence,
            cwd,
            envelope.tool_name.as_deref().unwrap_or("tool"),
            envelope.tool_input.as_ref(),
        ),
        "PostToolUse" | "PreToolUse" | "SessionStart" | "UserPromptSubmit" => {
            build_simple_state(&session_id, timestamp, sequence, cwd, ActivityStatus::Working)
        }
        "Stop" => build_simple_state(
            &session_id,
            timestamp,
            sequence,
            cwd,
            ActivityStatus::AwaitingInput,
        ),
        "StopFailure" => build_state_error(
            &session_id,
            timestamp,
            sequence,
            cwd,
            envelope
                .error_type
                .as_deref()
                .map(error_category_from_claude_label)
                .unwrap_or(ErrorCategory::Other),
            envelope
                .message
                .clone()
                .unwrap_or_else(|| "Claude Code reported an error".to_owned()),
        ),
        "SessionEnd" => build_state_done(&session_id, timestamp, sequence, cwd, ExitReason::Eof),
        _ => return None,
    };

    Some(HookActivityUpdate::State {
        source: HookSource::ClaudeCode,
        native_session_id: session_id,
        state,
    })
}

fn translate_codex(
    payload: &Value,
    sequences: &Mutex<HashMap<String, u64>>,
) -> Option<HookActivityUpdate> {
    let envelope = parse_envelope(payload)?;
    let session_id = envelope.session_id.clone()?;
    let timestamp = envelope.timestamp.clone().unwrap_or_else(now_iso8601);
    let sequence = next_sequence(sequences, &session_id);
    let cwd = envelope.cwd.clone().unwrap_or_default();

    let state = match envelope.hook_event_name.as_str() {
        "PermissionRequest" => build_state_awaiting_permission(
            &session_id,
            timestamp,
            sequence,
            cwd,
            envelope.tool_name.as_deref().unwrap_or("tool"),
            envelope.tool_input.as_ref(),
        ),
        "PreToolUse" | "PostToolUse" | "SessionStart" | "UserPromptSubmit" => {
            build_simple_state(&session_id, timestamp, sequence, cwd, ActivityStatus::Working)
        }
        "Stop" => build_simple_state(
            &session_id,
            timestamp,
            sequence,
            cwd,
            ActivityStatus::AwaitingInput,
        ),
        _ => return None,
    };

    Some(HookActivityUpdate::State {
        source: HookSource::CodexCli,
        native_session_id: session_id,
        state,
    })
}

fn build_simple_state(
    session_id: &str,
    timestamp: String,
    sequence: u64,
    cwd: String,
    status: ActivityStatus,
) -> ActivityState {
    ActivityState {
        version: ACTIVITY_VERSION,
        session_id: session_id.to_owned(),
        status,
        updated_at: timestamp,
        sequence,
        cwd,
        turn: None,
        active_tools: Vec::new(),
        awaiting_permission: None,
        last_error: None,
        final_exit: None,
    }
}

fn build_state_awaiting_permission(
    session_id: &str,
    timestamp: String,
    sequence: u64,
    cwd: String,
    tool_name: &str,
    tool_input: Option<&Value>,
) -> ActivityState {
    let display_summary = match tool_name {
        "Bash" => tool_input
            .and_then(|value| value.get("command").and_then(Value::as_str))
            .map(|cmd| format!("Run shell: {cmd}"))
            .unwrap_or_else(|| "Run a shell command".to_owned()),
        "Edit" | "Write" => tool_input
            .and_then(|value| value.get("file_path").and_then(Value::as_str))
            .map(|path| format!("Edit {path}"))
            .unwrap_or_else(|| format!("Use {tool_name}")),
        "Read" => tool_input
            .and_then(|value| value.get("file_path").and_then(Value::as_str))
            .map(|path| format!("Read {path}"))
            .unwrap_or_else(|| "Read a file".to_owned()),
        other => format!("Use {other}"),
    };

    ActivityState {
        version: ACTIVITY_VERSION,
        session_id: session_id.to_owned(),
        status: ActivityStatus::AwaitingPermission,
        updated_at: timestamp.clone(),
        sequence,
        cwd,
        turn: None,
        active_tools: Vec::new(),
        awaiting_permission: Some(PermissionRequest {
            id: format!("perm-{sequence}"),
            tool_name: tool_name.to_owned(),
            display_summary,
            args: tool_input.cloned(),
            requested_at: timestamp,
        }),
        last_error: None,
        final_exit: None,
    }
}

fn build_state_error(
    session_id: &str,
    timestamp: String,
    sequence: u64,
    cwd: String,
    category: ErrorCategory,
    message: String,
) -> ActivityState {
    ActivityState {
        version: ACTIVITY_VERSION,
        session_id: session_id.to_owned(),
        status: ActivityStatus::Error,
        updated_at: timestamp.clone(),
        sequence,
        cwd,
        turn: None,
        active_tools: Vec::new(),
        awaiting_permission: None,
        last_error: Some(ActivityError {
            category,
            message,
            recoverable: !matches!(category, ErrorCategory::Authentication),
            occurred_at: timestamp,
        }),
        final_exit: None,
    }
}

fn build_state_done(
    session_id: &str,
    timestamp: String,
    sequence: u64,
    cwd: String,
    reason: ExitReason,
) -> ActivityState {
    ActivityState {
        version: ACTIVITY_VERSION,
        session_id: session_id.to_owned(),
        status: ActivityStatus::Done,
        updated_at: timestamp,
        sequence,
        cwd,
        turn: None,
        active_tools: Vec::new(),
        awaiting_permission: None,
        last_error: None,
        final_exit: Some(FinalExit {
            code: Some(0),
            signal: None,
            reason,
        }),
    }
}

fn error_category_from_claude_label(label: &str) -> ErrorCategory {
    match label {
        "rate_limit" => ErrorCategory::RateLimit,
        "auth_failed" | "authentication" => ErrorCategory::Authentication,
        "network" => ErrorCategory::Network,
        "context_overflow" => ErrorCategory::ContextOverflow,
        "billing_error" => ErrorCategory::Other,
        "cancelled" => ErrorCategory::Cancelled,
        _ => ErrorCategory::Other,
    }
}

fn now_iso8601() -> String {
    // Producer hook payloads carry their own timestamps in practice; this
    // fallback uses seconds-since-epoch in ISO 8601 form so the output still
    // sorts correctly when a producer omits the field. We deliberately keep
    // this dependency-free.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let secs = now;
    // Cheap UTC formatter for "YYYY-MM-DDTHH:MM:SSZ"; correct for all dates
    // 1970..year 9999. Avoids pulling in `chrono`/`time` just for a fallback.
    let (year, month, day, hour, minute, second) = unix_secs_to_ymdhms(secs);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn unix_secs_to_ymdhms(mut secs: u64) -> (u64, u32, u32, u32, u32, u32) {
    let second = (secs % 60) as u32;
    secs /= 60;
    let minute = (secs % 60) as u32;
    secs /= 60;
    let hour = (secs % 24) as u32;
    let mut days = secs / 24;
    let mut year: u64 = 1970;
    loop {
        let leap = is_leap_year(year);
        let year_days = if leap { 366 } else { 365 };
        if days < year_days {
            break;
        }
        days -= year_days;
        year += 1;
    }
    let leap = is_leap_year(year);
    let month_lengths = [
        31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut month: u32 = 1;
    for (idx, length) in month_lengths.iter().enumerate() {
        if days < *length as u64 {
            month = idx as u32 + 1;
            break;
        }
        days -= *length as u64;
    }
    let day = days as u32 + 1;
    (year, month, day, hour, minute, second)
}

fn is_leap_year(year: u64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::{Shutdown, TcpStream},
        time::Duration,
    };

    fn post_hook(port: u16, path: &str, body: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connects to hook server");
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .expect("set read timeout");
        let request = format!(
            "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).expect("write request");
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        let _ = stream.shutdown(Shutdown::Both);
        response
    }

    fn wait_for_update(handle: &HookServerHandle) -> HookActivityUpdate {
        handle
            .events
            .recv_timeout(Duration::from_secs(3))
            .expect("hook update arrived")
    }

    #[test]
    fn claude_permission_request_translates_to_awaiting_permission() {
        let handle = start_hook_server().expect("server starts");
        let body = serde_json::json!({
            "hook_event_name": "PermissionRequest",
            "session_id": "claude-sess-1",
            "cwd": "/repo",
            "timestamp": "2026-05-28T12:34:56.000Z",
            "tool_name": "Bash",
            "tool_input": { "command": "rm -rf foo/" }
        })
        .to_string();

        let response = post_hook(handle.port, CLAUDE_PATH_PREFIX, &body);
        assert!(response.starts_with("HTTP/1.1 204"), "response: {response}");

        match wait_for_update(&handle) {
            HookActivityUpdate::State {
                source,
                native_session_id,
                state,
            } => {
                assert_eq!(source, HookSource::ClaudeCode);
                assert_eq!(native_session_id, "claude-sess-1");
                assert_eq!(state.status, ActivityStatus::AwaitingPermission);
                let perm = state.awaiting_permission.expect("permission set");
                assert_eq!(perm.tool_name, "Bash");
                assert_eq!(perm.display_summary, "Run shell: rm -rf foo/");
            }
            other => panic!("expected State, got {other:?}"),
        }
    }

    #[test]
    fn codex_stop_hook_marks_session_awaiting_input() {
        let handle = start_hook_server().expect("server starts");
        let body = serde_json::json!({
            "hook_event_name": "Stop",
            "session_id": "codex-sess-1",
            "cwd": "/repo",
            "timestamp": "2026-05-28T12:35:00.000Z"
        })
        .to_string();

        let response = post_hook(handle.port, CODEX_PATH_PREFIX, &body);
        assert!(response.starts_with("HTTP/1.1 204"), "response: {response}");

        match wait_for_update(&handle) {
            HookActivityUpdate::State {
                source,
                native_session_id,
                state,
            } => {
                assert_eq!(source, HookSource::CodexCli);
                assert_eq!(native_session_id, "codex-sess-1");
                assert_eq!(state.status, ActivityStatus::AwaitingInput);
                assert_eq!(state.sequence, 1);
            }
            other => panic!("expected State, got {other:?}"),
        }
    }

    #[test]
    fn sequence_increments_per_session() {
        let handle = start_hook_server().expect("server starts");
        let body_one = serde_json::json!({
            "hook_event_name": "SessionStart",
            "session_id": "s-1",
            "cwd": "/repo"
        })
        .to_string();
        let body_two = serde_json::json!({
            "hook_event_name": "Stop",
            "session_id": "s-1",
            "cwd": "/repo"
        })
        .to_string();

        let _ = post_hook(handle.port, CLAUDE_PATH_PREFIX, &body_one);
        let _ = post_hook(handle.port, CLAUDE_PATH_PREFIX, &body_two);

        let first = wait_for_update(&handle);
        let second = wait_for_update(&handle);
        let seqs = [first, second]
            .into_iter()
            .map(|update| match update {
                HookActivityUpdate::State { state, .. } => state.sequence,
                other => panic!("unexpected update {other:?}"),
            })
            .collect::<Vec<_>>();
        assert_eq!(seqs, vec![1, 2]);
    }

    #[test]
    fn unknown_paths_404_without_emitting() {
        let handle = start_hook_server().expect("server starts");
        let response = post_hook(handle.port, "/hooks/unknown", r#"{}"#);
        assert!(response.starts_with("HTTP/1.1 404"), "response: {response}");
        assert!(handle.events.try_recv().is_err());
    }

    #[test]
    fn invalid_json_returns_400() {
        let handle = start_hook_server().expect("server starts");
        let response = post_hook(handle.port, CLAUDE_PATH_PREFIX, "not json");
        assert!(response.starts_with("HTTP/1.1 400"), "response: {response}");
        assert!(handle.events.try_recv().is_err());
    }
}
