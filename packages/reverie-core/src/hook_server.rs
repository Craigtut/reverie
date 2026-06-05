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
//! This is the **push** transport of the ingestion spine: it emits the same
//! [`ActivityUpdate`] every other source does, keyed by [`SessionKey::Reverie`]
//! (the per-session token authenticates the owning Reverie session directly, so
//! no reverse native-id lookup is needed) at [`Fidelity::Definitive`].
//!
//! Scope of this module: parse + translate + emit. It does **not** write
//! Claude `settings.json` or Codex `config.toml` into each session's cwd, and
//! it does not yet enforce per-session secrets; those concerns live alongside
//! the session launch path in the Tauri shell.

use std::{
    collections::HashMap,
    io::Read,
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver, Sender},
    },
    thread::{self, JoinHandle},
};

use anyhow::{Context, Result, anyhow};
use serde::Deserialize;
use serde_json::Value;
use tiny_http::{Method, Response, Server, StatusCode};

use crate::activity::{
    ActiveTool, ActivityError, ActivityState, ActivityStatus, ErrorCategory, ExitReason, FinalExit,
    PermissionRequest,
};
use crate::activity_source::{ActivitySourceKind, ActivityUpdate, Fidelity, SessionKey};
use crate::domain::SessionId;

const ACTIVITY_VERSION: u32 = 1;

/// Which CLI sourced a translated update. Used internally for URL-path routing
/// and per-CLI token auth; the emitted [`ActivityUpdate`] carries the public
/// [`ActivitySourceKind`] instead.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub enum HookSource {
    ClaudeCode,
    CodexCli,
}

impl HookSource {
    fn activity_source_kind(self) -> ActivitySourceKind {
        match self {
            HookSource::ClaudeCode => ActivitySourceKind::ClaudeCode,
            HookSource::CodexCli => ActivitySourceKind::CodexCli,
        }
    }
}

/// Shared, cheaply-cloned control surface for the running hook server. The
/// Tauri shell holds one of these as managed state so the launch path can
/// register a per-session token and the worker thread can validate incoming
/// requests against the same map.
#[derive(Clone)]
pub struct HookServerControl {
    pub port: u16,
    auth: Arc<Mutex<HashMap<(HookSource, String), SessionId>>>,
}

impl HookServerControl {
    /// Authorize a token for one CLI source and bind it to the Reverie session
    /// that's about to use it. Subsequent POSTs to `/hooks/<cli>/<token>` are
    /// accepted, translated, and tagged with the Reverie session id so the
    /// correlator can bind directly without a reverse native-id lookup.
    pub fn register_session(
        &self,
        source: HookSource,
        token: String,
        reverie_session_id: SessionId,
    ) {
        let mut auth = self.auth.lock().unwrap_or_else(|err| err.into_inner());
        auth.insert((source, token), reverie_session_id);
    }

    /// Revoke a previously-registered token. Called when a Reverie session
    /// ends or is removed so a stale CLI process can't keep pushing state.
    pub fn revoke_session(&self, source: HookSource, token: &str) {
        let mut auth = self.auth.lock().unwrap_or_else(|err| err.into_inner());
        auth.remove(&(source, token.to_owned()));
    }
}

/// Read-only view onto the bridge that the hook server needs to assemble
/// `additionalContext` responses for `UserPromptSubmit` hooks. Implemented
/// by [`crate::connection_service::ConnectionService`] so the hook server
/// does not have to depend on the full service surface.
pub trait HookPushSource: Send + Sync {
    /// Return a short textual summary of inbound, undelivered messages for
    /// `reverie_session_id` across its currently-open connections. Empty
    /// string means no nudge; a non-empty string is injected verbatim as
    /// `additionalContext` on Claude/Codex's `UserPromptSubmit` response.
    fn pre_turn_nudge_for(&self, reverie_session_id: SessionId) -> String;
}

/// Handle returned by [`start_hook_server`]. Drain `events` for translated
/// updates. The server stops when the handle is dropped: tiny_http's accept
/// loop is unblocked, the worker exits, and the bound socket closes.
pub struct HookServerHandle {
    pub events: Receiver<ActivityUpdate>,
    pub control: HookServerControl,
    server: Arc<Server>,
    worker: Option<JoinHandle<()>>,
}

impl HookServerHandle {
    pub fn port(&self) -> u16 {
        self.control.port
    }

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
/// incoming hook POSTs into [`ActivityUpdate`]s. The `push_source` is
/// consulted on `UserPromptSubmit` hooks to inject `additionalContext` into
/// the reply so Claude / Codex agents see pending inter-agent messages at
/// the top of their next turn. Pass `None` to keep the legacy 204 reply.
pub fn start_hook_server() -> Result<HookServerHandle> {
    start_hook_server_with(None)
}

/// Variant of [`start_hook_server`] that wires a connection-bridge push
/// source for pre-turn message delivery.
pub fn start_hook_server_with(
    push_source: Option<Arc<dyn HookPushSource>>,
) -> Result<HookServerHandle> {
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

    let (tx, rx) = mpsc::channel::<ActivityUpdate>();
    let sequences: Arc<Mutex<HashMap<String, u64>>> = Arc::new(Mutex::new(HashMap::new()));
    let auth: Arc<Mutex<HashMap<(HookSource, String), SessionId>>> =
        Arc::new(Mutex::new(HashMap::new()));

    let worker_server = Arc::clone(&server);
    let worker_sequences = Arc::clone(&sequences);
    let worker_auth = Arc::clone(&auth);
    let worker_push = push_source.clone();
    let worker = thread::Builder::new()
        .name("reverie-hook-http-server".to_owned())
        .spawn(move || {
            run_request_loop(
                worker_server,
                worker_sequences,
                worker_auth,
                tx,
                worker_push,
            )
        })
        .context("spawning hook HTTP worker thread")?;

    Ok(HookServerHandle {
        events: rx,
        control: HookServerControl { port, auth },
        server,
        worker: Some(worker),
    })
}

/// Upper bound on hook request bodies. Claude/Codex hook envelopes are small
/// JSON objects; anything larger on this localhost endpoint is malformed or
/// hostile and is rejected rather than buffered.
const MAX_HOOK_BODY_BYTES: usize = 64 * 1024;

fn run_request_loop(
    server: Arc<Server>,
    sequences: Arc<Mutex<HashMap<String, u64>>>,
    auth: Arc<Mutex<HashMap<(HookSource, String), SessionId>>>,
    tx: Sender<ActivityUpdate>,
    push_source: Option<Arc<dyn HookPushSource>>,
) {
    for mut request in server.incoming_requests() {
        let url = request.url().to_owned();
        let method = request.method().clone();
        if method != Method::Post {
            let _ = request.respond(simple_response(405, "method not allowed"));
            continue;
        }
        let Some((source, token)) = parse_hook_path(&url) else {
            let _ = request.respond(simple_response(404, "not found"));
            continue;
        };

        // Validate the per-session token and resolve the Reverie session it
        // belongs to in one pass. The map is populated by the Tauri shell at
        // launch time via HookServerControl::register_session; revoked when
        // the session ends or is removed.
        let reverie_session_id = {
            let guard = auth.lock().unwrap_or_else(|err| err.into_inner());
            guard.get(&(source, token.to_owned())).copied()
        };
        let Some(reverie_session_id) = reverie_session_id else {
            let _ = request.respond(simple_response(401, "unauthorized"));
            continue;
        };

        // Cap the body twice: by the declared Content-Length, and again by the
        // bytes actually read, in case the length is absent or lies.
        if request
            .body_length()
            .is_some_and(|len| len > MAX_HOOK_BODY_BYTES)
        {
            let _ = request.respond(simple_response(413, "payload too large"));
            continue;
        }
        let mut body = String::new();
        if request
            .as_reader()
            .take((MAX_HOOK_BODY_BYTES + 1) as u64)
            .read_to_string(&mut body)
            .is_err()
        {
            let _ = request.respond(simple_response(400, "invalid utf-8 body"));
            continue;
        }
        if body.len() > MAX_HOOK_BODY_BYTES {
            let _ = request.respond(simple_response(413, "payload too large"));
            continue;
        }
        let payload: Value = match serde_json::from_str(&body) {
            Ok(value) => value,
            Err(_) => {
                let _ = request.respond(simple_response(400, "invalid json"));
                continue;
            }
        };

        // Record activity translation for either source first; the response
        // body only matters for UserPromptSubmit, but other hook events
        // still drive the activity stream.
        if let Some(update) = translate(source, reverie_session_id, &payload, &sequences) {
            let _ = tx.send(update);
        }

        // UserPromptSubmit is the entry point Reverie uses to inject
        // additionalContext for pending inter-agent messages. If we have a
        // push source and the payload is a UserPromptSubmit, fetch the
        // nudge for the relevant Reverie session and reply with the
        // hook-specific body. Anything else still gets a 204.
        let event_name = payload
            .get("hook_event_name")
            .and_then(Value::as_str)
            .unwrap_or("");
        if event_name == "UserPromptSubmit" {
            if let Some(source) = push_source.as_ref() {
                let nudge = source.pre_turn_nudge_for(reverie_session_id);
                if !nudge.is_empty() {
                    let body = build_user_prompt_submit_response(&nudge);
                    let response = Response::from_string(body.to_string())
                        .with_status_code(StatusCode(200))
                        .with_header(
                            tiny_http::Header::from_bytes(
                                &b"Content-Type"[..],
                                &b"application/json"[..],
                            )
                            .expect("static header"),
                        );
                    let _ = request.respond(response);
                    continue;
                }
            }
        }
        let _ = request.respond(simple_response(204, ""));
    }
}

/// Build the JSON body Reverie sends back for a `UserPromptSubmit` hook.
/// Format works for both Claude Code (which reads `hookSpecificOutput`) and
/// Codex CLI (which reads the same shape). `additionalContext` is the
/// agent-visible string.
fn build_user_prompt_submit_response(additional_context: &str) -> Value {
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": additional_context,
        }
    })
}

/// Extract `(source, token)` from a request URL of the form
/// `/hooks/<cli>/<token>` (or `/hooks/<cli>` for legacy/test usage with the
/// empty token, which still has to be registered explicitly to pass auth).
fn parse_hook_path(url: &str) -> Option<(HookSource, &str)> {
    // Strip query string if present.
    let path = url.split('?').next().unwrap_or(url);
    let mut segments = path.trim_start_matches('/').split('/');
    if segments.next()? != "hooks" {
        return None;
    }
    let source = match segments.next()? {
        "claude" => HookSource::ClaudeCode,
        "codex" => HookSource::CodexCli,
        _ => return None,
    };
    let token = segments.next().unwrap_or("");
    // Defense: don't accept further path segments.
    if segments.next().is_some() {
        return None;
    }
    Some((source, token))
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
    reverie_session_id: SessionId,
    payload: &Value,
    sequences: &Mutex<HashMap<String, u64>>,
) -> Option<ActivityUpdate> {
    match source {
        HookSource::ClaudeCode => translate_claude(reverie_session_id, payload, sequences),
        HookSource::CodexCli => translate_codex(reverie_session_id, payload, sequences),
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
    /// The kind of `Notification` event (`permission_prompt`, `idle_prompt`,
    /// `elicitation_dialog`, …). Only present on Notification payloads; it is
    /// how we tell a blocking ask apart from a benign toast.
    #[serde(default)]
    notification_type: Option<String>,
}

fn parse_envelope(payload: &Value) -> Option<HookEnvelope> {
    serde_json::from_value(payload.clone()).ok()
}

/// Build the [`ActivityUpdate`] a translated hook event produces: keyed by the
/// owning Reverie session (so it binds without a native-id lookup), tagged with
/// the source CLI, and definitive (a push hook is a first-class lifecycle
/// signal). The native CLI session id rides along in `state.session_id`.
fn hook_state_update(
    source: HookSource,
    reverie_session_id: SessionId,
    state: ActivityState,
) -> ActivityUpdate {
    ActivityUpdate::State {
        source: source.activity_source_kind(),
        key: SessionKey::Reverie(reverie_session_id),
        fidelity: Fidelity::Definitive,
        state,
    }
}

/// Built-in Claude tools that block the turn on a user response rather than
/// doing work: a multiple-choice question (`AskUserQuestion`) or a plan
/// approval (`ExitPlanMode`). They emit a `PreToolUse` like any tool but no
/// `PostToolUse` until the user answers, and no `Stop` (the turn is still
/// live), so without special-casing them the session sits on its last
/// `Working` state and reads as green while it is really waiting for you.
const CLAUDE_ASKING_TOOLS: &[&str] = &["AskUserQuestion", "ExitPlanMode"];

fn is_asking_tool(tool_name: &str) -> bool {
    CLAUDE_ASKING_TOOLS.contains(&tool_name)
}

/// Resolve a Claude `Notification` to a status change, or `None` when it
/// carries no turn-state meaning. `elicitation_dialog` (an MCP server asking
/// the user) blocks the turn, so it is an `AwaitingResponse`; its completion
/// resumes work. `idle_prompt` is deliberately ignored: it fires for ANY
/// session left untouched at the prompt, so escalating it would falsely amber
/// every resting session after a minute. `permission_prompt` is already covered
/// by the dedicated `PermissionRequest` hook, and `auth_success` is a toast.
fn claude_notification_status(notification_type: Option<&str>) -> Option<ActivityStatus> {
    match notification_type? {
        "elicitation_dialog" => Some(ActivityStatus::AwaitingResponse),
        "elicitation_complete" | "elicitation_response" => Some(ActivityStatus::Working),
        _ => None,
    }
}

fn translate_claude(
    reverie_session_id: SessionId,
    payload: &Value,
    sequences: &Mutex<HashMap<String, u64>>,
) -> Option<ActivityUpdate> {
    let envelope = parse_envelope(payload)?;
    let session_id = envelope.session_id.clone()?;
    let timestamp = envelope.timestamp.clone().unwrap_or_else(now_iso8601);
    let sequence = next_sequence(sequences, &session_id);
    let cwd = envelope.cwd.clone().unwrap_or_default();

    // Notification is the one event that can resolve to "no state change", so it
    // is handled apart from the match below (which always yields a state). The
    // trace line is the ground truth for what Claude actually sends here, which
    // the hook docs leave unspecified.
    if envelope.hook_event_name == "Notification" {
        let kind = envelope.notification_type.as_deref().unwrap_or("?");
        eprintln!(
            "[reverie] claude notification session={session_id} type={kind} message={:?}",
            envelope.message.as_deref().unwrap_or("")
        );
        let status = claude_notification_status(envelope.notification_type.as_deref())?;
        let state = build_simple_state(&session_id, timestamp, sequence, cwd, status);
        return Some(hook_state_update(
            HookSource::ClaudeCode,
            reverie_session_id,
            state,
        ));
    }

    let state = match envelope.hook_event_name.as_str() {
        "PermissionRequest" => build_state_awaiting_permission(
            &session_id,
            timestamp,
            sequence,
            cwd,
            envelope.tool_name.as_deref().unwrap_or("tool"),
            envelope.tool_input.as_ref(),
        ),
        // A tool is starting. A genuine work tool surfaces as the active tool so
        // the dashboard can show "Run shell: npm test" instead of a bare
        // "Working". An *asking* tool (AskUserQuestion / ExitPlanMode) instead
        // blocks the turn on the user: there is no PostToolUse and no Stop until
        // you answer, so we hold AwaitingResponse rather than leave it green.
        "PreToolUse" => {
            let tool = envelope.tool_name.as_deref().unwrap_or("tool");
            if is_asking_tool(tool) {
                eprintln!(
                    "[reverie] claude session={session_id} awaiting user response (PreToolUse:{tool})"
                );
                build_simple_state(
                    &session_id,
                    timestamp,
                    sequence,
                    cwd,
                    ActivityStatus::AwaitingResponse,
                )
            } else {
                build_state_working_tool(
                    &session_id,
                    timestamp,
                    sequence,
                    cwd,
                    tool,
                    envelope.tool_input.as_ref(),
                )
            }
        }
        // The tool finished; clear the active tool but stay Working until the
        // turn's Stop arrives. (For an asking tool this is the answer landing,
        // which correctly moves us off AwaitingResponse back to Working.)
        "PostToolUse" | "SessionStart" | "UserPromptSubmit" => build_simple_state(
            &session_id,
            timestamp,
            sequence,
            cwd,
            ActivityStatus::Working,
        ),
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
        // Unknown but well-formed events advance liveness rather than vanishing:
        // treat them as a Working heartbeat so the dashboard does not stick on a
        // stale state when a CLI emits a hook we do not model yet.
        _ => build_simple_state(
            &session_id,
            timestamp,
            sequence,
            cwd,
            ActivityStatus::Working,
        ),
    };

    Some(hook_state_update(
        HookSource::ClaudeCode,
        reverie_session_id,
        state,
    ))
}

fn translate_codex(
    reverie_session_id: SessionId,
    payload: &Value,
    sequences: &Mutex<HashMap<String, u64>>,
) -> Option<ActivityUpdate> {
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
        "PreToolUse" | "PostToolUse" | "SessionStart" | "UserPromptSubmit" => build_simple_state(
            &session_id,
            timestamp,
            sequence,
            cwd,
            ActivityStatus::Working,
        ),
        "Stop" => build_simple_state(
            &session_id,
            timestamp,
            sequence,
            cwd,
            ActivityStatus::AwaitingInput,
        ),
        // Mirror translate_claude: unknown but well-formed events become a
        // Working heartbeat instead of being silently dropped.
        _ => build_simple_state(
            &session_id,
            timestamp,
            sequence,
            cwd,
            ActivityStatus::Working,
        ),
    };

    Some(hook_state_update(
        HookSource::CodexCli,
        reverie_session_id,
        state,
    ))
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

/// Human-readable one-liner for a tool call, used both for the permission
/// prompt summary and the active-tool line. Keeps per-tool phrasing in one
/// place so "Run shell: …" reads the same whether the tool is pending approval
/// or already running.
fn tool_display_summary(tool_name: &str, tool_input: Option<&Value>) -> String {
    match tool_name {
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
    }
}

/// Working state carrying the single tool that just started, so the dashboard
/// can render the active-tool line. The model is intentionally one-tool-deep:
/// `PostToolUse` clears it back to a bare Working heartbeat.
fn build_state_working_tool(
    session_id: &str,
    timestamp: String,
    sequence: u64,
    cwd: String,
    tool_name: &str,
    tool_input: Option<&Value>,
) -> ActivityState {
    ActivityState {
        version: ACTIVITY_VERSION,
        session_id: session_id.to_owned(),
        status: ActivityStatus::Working,
        updated_at: timestamp.clone(),
        sequence,
        cwd,
        turn: None,
        active_tools: vec![ActiveTool {
            tool_call_id: format!("tool-{sequence}"),
            tool_name: tool_name.to_owned(),
            started_at: timestamp,
            display_summary: Some(tool_display_summary(tool_name, tool_input)),
            child_task_id: None,
        }],
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
    let display_summary = tool_display_summary(tool_name, tool_input);

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
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
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

    fn wait_for_update(handle: &HookServerHandle) -> ActivityUpdate {
        handle
            .events
            .recv_timeout(Duration::from_secs(3))
            .expect("hook update arrived")
    }

    const TEST_TOKEN: &str = "tok-test-001";

    fn claude_path() -> String {
        format!("/hooks/claude/{TEST_TOKEN}")
    }

    fn codex_path() -> String {
        format!("/hooks/codex/{TEST_TOKEN}")
    }

    /// A stable, valid Reverie session id (a UUID) used across the tests. The
    /// hook auth map stores `SessionId`, so registration takes one of these.
    fn test_reverie_session_id() -> SessionId {
        uuid::Uuid::from_bytes([0x11; 16])
    }

    fn started_with_token(source: HookSource) -> HookServerHandle {
        let handle = start_hook_server().expect("server starts");
        handle
            .control
            .register_session(source, TEST_TOKEN.to_owned(), test_reverie_session_id());
        handle
    }

    #[test]
    fn claude_permission_request_translates_to_awaiting_permission() {
        let handle = started_with_token(HookSource::ClaudeCode);
        let body = serde_json::json!({
            "hook_event_name": "PermissionRequest",
            "session_id": "claude-sess-1",
            "cwd": "/repo",
            "timestamp": "2026-05-28T12:34:56.000Z",
            "tool_name": "Bash",
            "tool_input": { "command": "rm -rf foo/" }
        })
        .to_string();

        let response = post_hook(handle.port(), &claude_path(), &body);
        assert!(response.starts_with("HTTP/1.1 204"), "response: {response}");

        match wait_for_update(&handle) {
            ActivityUpdate::State {
                source,
                key,
                fidelity,
                state,
            } => {
                assert_eq!(source, ActivitySourceKind::ClaudeCode);
                assert_eq!(key, SessionKey::Reverie(test_reverie_session_id()));
                assert_eq!(fidelity, Fidelity::Definitive);
                assert_eq!(state.session_id, "claude-sess-1");
                assert_eq!(state.status, ActivityStatus::AwaitingPermission);
                let perm = state.awaiting_permission.expect("permission set");
                assert_eq!(perm.tool_name, "Bash");
                assert_eq!(perm.display_summary, "Run shell: rm -rf foo/");
            }
            other => panic!("expected State, got {other:?}"),
        }
    }

    #[test]
    fn claude_pre_tool_use_surfaces_active_tool_with_summary() {
        let handle = started_with_token(HookSource::ClaudeCode);
        let body = serde_json::json!({
            "hook_event_name": "PreToolUse",
            "session_id": "claude-sess-2",
            "cwd": "/repo",
            "tool_name": "Bash",
            "tool_input": { "command": "npm test" }
        })
        .to_string();

        let response = post_hook(handle.port(), &claude_path(), &body);
        assert!(response.starts_with("HTTP/1.1 204"), "response: {response}");

        match wait_for_update(&handle) {
            ActivityUpdate::State { state, .. } => {
                assert_eq!(state.status, ActivityStatus::Working);
                assert_eq!(
                    state.active_tools.len(),
                    1,
                    "PreToolUse should set one active tool"
                );
                let tool = &state.active_tools[0];
                assert_eq!(tool.tool_name, "Bash");
                assert_eq!(tool.display_summary.as_deref(), Some("Run shell: npm test"));
            }
            other => panic!("expected State, got {other:?}"),
        }
    }

    #[test]
    fn claude_post_tool_use_clears_active_tool_but_stays_working() {
        let handle = started_with_token(HookSource::ClaudeCode);
        let body = serde_json::json!({
            "hook_event_name": "PostToolUse",
            "session_id": "claude-sess-3",
            "cwd": "/repo",
            "tool_name": "Bash"
        })
        .to_string();

        let _ = post_hook(handle.port(), &claude_path(), &body);
        match wait_for_update(&handle) {
            ActivityUpdate::State { state, .. } => {
                assert_eq!(state.status, ActivityStatus::Working);
                assert!(
                    state.active_tools.is_empty(),
                    "PostToolUse should clear active tools"
                );
            }
            other => panic!("expected State, got {other:?}"),
        }
    }

    #[test]
    fn claude_ask_user_question_pre_tool_use_marks_awaiting_response() {
        // AskUserQuestion blocks the turn on the user but, unlike a Stop, leaves
        // the turn live (no Stop fires). Surfacing it as Working would read as a
        // busy green agent; it must be AwaitingResponse so the dashboard shows it
        // needs you.
        let handle = started_with_token(HookSource::ClaudeCode);
        let body = serde_json::json!({
            "hook_event_name": "PreToolUse",
            "session_id": "claude-ask-1",
            "cwd": "/repo",
            "tool_name": "AskUserQuestion",
            "tool_input": { "questions": [] }
        })
        .to_string();

        let response = post_hook(handle.port(), &claude_path(), &body);
        assert!(response.starts_with("HTTP/1.1 204"), "response: {response}");

        match wait_for_update(&handle) {
            ActivityUpdate::State { state, .. } => {
                assert_eq!(state.status, ActivityStatus::AwaitingResponse);
                assert!(
                    state.active_tools.is_empty(),
                    "an asking tool is not a running work tool"
                );
            }
            other => panic!("expected State, got {other:?}"),
        }
    }

    #[test]
    fn claude_notification_elicitation_marks_awaiting_response() {
        let handle = started_with_token(HookSource::ClaudeCode);
        let body = serde_json::json!({
            "hook_event_name": "Notification",
            "session_id": "claude-note-1",
            "cwd": "/repo",
            "notification_type": "elicitation_dialog",
            "message": "An MCP server is asking for input"
        })
        .to_string();

        let response = post_hook(handle.port(), &claude_path(), &body);
        assert!(response.starts_with("HTTP/1.1 204"), "response: {response}");

        match wait_for_update(&handle) {
            ActivityUpdate::State { state, .. } => {
                assert_eq!(state.status, ActivityStatus::AwaitingResponse);
            }
            other => panic!("expected State, got {other:?}"),
        }
    }

    #[test]
    fn claude_notification_idle_prompt_emits_no_state_change() {
        // idle_prompt fires for any session left untouched at the prompt, so it
        // must NOT escalate a resting session to attention. The server still
        // accepts the POST, but no ActivityUpdate is produced.
        let handle = started_with_token(HookSource::ClaudeCode);
        let body = serde_json::json!({
            "hook_event_name": "Notification",
            "session_id": "claude-note-2",
            "cwd": "/repo",
            "notification_type": "idle_prompt",
            "message": "Claude is waiting for your input"
        })
        .to_string();

        let response = post_hook(handle.port(), &claude_path(), &body);
        assert!(response.starts_with("HTTP/1.1 204"), "response: {response}");
        assert!(
            handle
                .events
                .recv_timeout(Duration::from_millis(400))
                .is_err(),
            "idle_prompt must not produce an activity update"
        );
    }

    #[test]
    fn asking_tool_and_notification_mapping_units() {
        assert!(is_asking_tool("AskUserQuestion"));
        assert!(is_asking_tool("ExitPlanMode"));
        assert!(!is_asking_tool("Bash"));

        assert_eq!(
            claude_notification_status(Some("elicitation_dialog")),
            Some(ActivityStatus::AwaitingResponse)
        );
        assert_eq!(
            claude_notification_status(Some("elicitation_complete")),
            Some(ActivityStatus::Working)
        );
        assert_eq!(claude_notification_status(Some("idle_prompt")), None);
        assert_eq!(claude_notification_status(Some("permission_prompt")), None);
        assert_eq!(claude_notification_status(None), None);
    }

    #[test]
    fn codex_stop_hook_marks_session_awaiting_input() {
        let handle = started_with_token(HookSource::CodexCli);
        let body = serde_json::json!({
            "hook_event_name": "Stop",
            "session_id": "codex-sess-1",
            "cwd": "/repo",
            "timestamp": "2026-05-28T12:35:00.000Z"
        })
        .to_string();

        let response = post_hook(handle.port(), &codex_path(), &body);
        assert!(response.starts_with("HTTP/1.1 204"), "response: {response}");

        match wait_for_update(&handle) {
            ActivityUpdate::State {
                source, key, state, ..
            } => {
                assert_eq!(source, ActivitySourceKind::CodexCli);
                assert_eq!(key, SessionKey::Reverie(test_reverie_session_id()));
                assert_eq!(state.session_id, "codex-sess-1");
                assert_eq!(state.status, ActivityStatus::AwaitingInput);
                assert_eq!(state.sequence, 1);
            }
            other => panic!("expected State, got {other:?}"),
        }
    }

    #[test]
    fn sequence_increments_per_session() {
        let handle = started_with_token(HookSource::ClaudeCode);
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

        let _ = post_hook(handle.port(), &claude_path(), &body_one);
        let _ = post_hook(handle.port(), &claude_path(), &body_two);

        let first = wait_for_update(&handle);
        let second = wait_for_update(&handle);
        let seqs = [first, second]
            .into_iter()
            .map(|update| match update {
                ActivityUpdate::State { state, .. } => state.sequence,
                other => panic!("unexpected update {other:?}"),
            })
            .collect::<Vec<_>>();
        assert_eq!(seqs, vec![1, 2]);
    }

    #[test]
    fn unknown_paths_404_without_emitting() {
        let handle = start_hook_server().expect("server starts");
        let response = post_hook(handle.port(), "/hooks/unknown/whatever", r#"{}"#);
        assert!(response.starts_with("HTTP/1.1 404"), "response: {response}");
        assert!(handle.events.try_recv().is_err());
    }

    #[test]
    fn invalid_json_returns_400() {
        let handle = started_with_token(HookSource::ClaudeCode);
        let response = post_hook(handle.port(), &claude_path(), "not json");
        assert!(response.starts_with("HTTP/1.1 400"), "response: {response}");
        assert!(handle.events.try_recv().is_err());
    }

    #[test]
    fn unregistered_token_returns_401() {
        let handle = start_hook_server().expect("server starts");
        let body =
            serde_json::json!({"hook_event_name":"Stop","session_id":"x","cwd":"/"}).to_string();
        let response = post_hook(handle.port(), "/hooks/claude/never-registered", &body);
        assert!(response.starts_with("HTTP/1.1 401"), "response: {response}");
        assert!(handle.events.try_recv().is_err());
    }

    #[test]
    fn revoke_blocks_further_posts() {
        let handle = started_with_token(HookSource::ClaudeCode);
        let body =
            serde_json::json!({"hook_event_name":"Stop","session_id":"x","cwd":"/"}).to_string();
        let response = post_hook(handle.port(), &claude_path(), &body);
        assert!(
            response.starts_with("HTTP/1.1 204"),
            "first call: {response}"
        );

        handle
            .control
            .revoke_session(HookSource::ClaudeCode, TEST_TOKEN);
        let response = post_hook(handle.port(), &claude_path(), &body);
        assert!(
            response.starts_with("HTTP/1.1 401"),
            "after revoke: {response}"
        );
    }

    #[test]
    fn oversized_body_returns_413_without_emitting() {
        let handle = started_with_token(HookSource::ClaudeCode);
        let filler = "x".repeat(MAX_HOOK_BODY_BYTES + 1024);
        let body = serde_json::json!({
            "hook_event_name": "Stop",
            "session_id": "s-big",
            "cwd": "/repo",
            "message": filler
        })
        .to_string();
        assert!(body.len() > MAX_HOOK_BODY_BYTES);

        let response = post_hook(handle.port(), &claude_path(), &body);
        assert!(response.starts_with("HTTP/1.1 413"), "response: {response}");
        assert!(handle.events.try_recv().is_err());
    }

    #[test]
    fn unknown_claude_event_becomes_working_heartbeat() {
        let handle = started_with_token(HookSource::ClaudeCode);
        let body = serde_json::json!({
            "hook_event_name": "NotifyCompaction",
            "session_id": "claude-unknown",
            "cwd": "/repo"
        })
        .to_string();

        let response = post_hook(handle.port(), &claude_path(), &body);
        assert!(response.starts_with("HTTP/1.1 204"), "response: {response}");

        match wait_for_update(&handle) {
            ActivityUpdate::State { source, state, .. } => {
                assert_eq!(source, ActivitySourceKind::ClaudeCode);
                assert_eq!(state.session_id, "claude-unknown");
                assert_eq!(state.status, ActivityStatus::Working);
            }
            other => panic!("expected State, got {other:?}"),
        }
    }

    #[test]
    fn unknown_codex_event_becomes_working_heartbeat() {
        let handle = started_with_token(HookSource::CodexCli);
        let body = serde_json::json!({
            "hook_event_name": "NotifyCompaction",
            "session_id": "codex-unknown",
            "cwd": "/repo"
        })
        .to_string();

        let response = post_hook(handle.port(), &codex_path(), &body);
        assert!(response.starts_with("HTTP/1.1 204"), "response: {response}");

        match wait_for_update(&handle) {
            ActivityUpdate::State { source, state, .. } => {
                assert_eq!(source, ActivitySourceKind::CodexCli);
                assert_eq!(state.session_id, "codex-unknown");
                assert_eq!(state.status, ActivityStatus::Working);
            }
            other => panic!("expected State, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------
    // Phase 7: UserPromptSubmit -> additionalContext push delivery
    // -----------------------------------------------------------------

    /// Stub push source for tests: returns a canned nudge string.
    struct StubPushSource(String);
    impl HookPushSource for StubPushSource {
        fn pre_turn_nudge_for(&self, _: SessionId) -> String {
            self.0.clone()
        }
    }

    fn started_with_push(source: HookSource, push: Arc<dyn HookPushSource>) -> HookServerHandle {
        let handle = start_hook_server_with(Some(push)).expect("server starts");
        handle
            .control
            .register_session(source, TEST_TOKEN.to_owned(), test_reverie_session_id());
        handle
    }

    #[test]
    fn user_prompt_submit_returns_additional_context_when_push_source_has_nudge() {
        let push = Arc::new(StubPushSource("You have 1 unread message.".to_owned()));
        let handle = started_with_push(
            HookSource::ClaudeCode,
            push.clone() as Arc<dyn HookPushSource>,
        );
        let response = post_hook(
            handle.port(),
            &claude_path(),
            r#"{"hook_event_name":"UserPromptSubmit","session_id":"native-sess","cwd":"/repo"}"#,
        );
        assert!(
            response.starts_with("HTTP/1.1 200"),
            "expected 200 OK, got {response}"
        );
        let body_start = response.rfind("\r\n\r\n").expect("response has body");
        let body = &response[body_start + 4..];
        let parsed: Value = serde_json::from_str(body).expect("body is JSON");
        assert_eq!(
            parsed["hookSpecificOutput"]["additionalContext"],
            "You have 1 unread message."
        );
        assert_eq!(
            parsed["hookSpecificOutput"]["hookEventName"],
            "UserPromptSubmit"
        );
    }

    #[test]
    fn user_prompt_submit_falls_back_to_204_when_nudge_is_empty() {
        let push = Arc::new(StubPushSource(String::new()));
        let handle = started_with_push(
            HookSource::CodexCli,
            push.clone() as Arc<dyn HookPushSource>,
        );
        let response = post_hook(
            handle.port(),
            &codex_path(),
            r#"{"hook_event_name":"UserPromptSubmit","session_id":"native-c","cwd":"/repo"}"#,
        );
        assert!(
            response.starts_with("HTTP/1.1 204"),
            "expected 204 when nudge is empty, got {response}"
        );
    }
}
