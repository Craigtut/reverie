//! HTTP receiver for Claude Code and Codex CLI hook payloads.
//!
//! Claude and Codex emit lifecycle hooks, and Codex also emits an external
//! `agent-turn-complete` notification. Small forwarders POST those JSON payloads
//! to a localhost endpoint. Reverie hosts that endpoint via this module:
//! a tiny synchronous HTTP/1.1 server bound to 127.0.0.1 on an OS-assigned
//! port, routing per-CLI on the URL path and translating each payload into
//! the unified [`crate::ActivityState`] shape so the dashboard cares only about state
//! transitions, never about which CLI emitted them.
//!
//! This is the **push** transport of the ingestion spine: it emits the same
//! [`ActivityUpdate`] every other source does, keyed by [`crate::activity_source::SessionKey::Reverie`]
//! (the per-session token authenticates the owning Reverie session directly, so
//! no reverse native-id lookup is needed) at [`crate::activity_source::Fidelity::Definitive`].
//!
//! Scope of this module: authenticate + receive + emit. It does **not** write
//! Claude `settings.json` or Codex `config.toml` into each session's cwd, and
//! the session launch path in the Tauri shell owns per-session config files.

use std::{
    collections::HashMap,
    io::Read,
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver, Sender},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use anyhow::{Context, Result, anyhow};
use serde_json::Value;
use tiny_http::{Method, Response, Server, StatusCode};

#[cfg(test)]
use crate::activity::ActivityStatus;
use crate::activity_source::{ActivitySourceKind, ActivityUpdate};
#[cfg(test)]
use crate::activity_source::{Fidelity, SessionKey};
use crate::approval::{ApprovalDecision, ApprovalRegistry};
use crate::domain::SessionId;

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
    /// Shared rendezvous for native tool-permission approvals. The worker thread
    /// parks a blocked `PermissionRequest` hook here; the Tauri `resolve_permission`
    /// command reaches the same registry (through this managed control) to hand
    /// the user's decision back to that hook. See [`crate::approval`].
    pub approvals: Arc<ApprovalRegistry>,
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
    let approvals = Arc::new(ApprovalRegistry::new());

    let worker_server = Arc::clone(&server);
    let worker_sequences = Arc::clone(&sequences);
    let worker_auth = Arc::clone(&auth);
    let worker_approvals = Arc::clone(&approvals);
    let worker_push = push_source.clone();
    let worker = thread::Builder::new()
        .name("reverie-hook-http-server".to_owned())
        .spawn(move || {
            run_request_loop(
                worker_server,
                worker_sequences,
                worker_auth,
                worker_approvals,
                tx,
                worker_push,
            )
        })
        .context("spawning hook HTTP worker thread")?;

    Ok(HookServerHandle {
        events: rx,
        control: HookServerControl {
            port,
            auth,
            approvals,
        },
        server,
        worker: Some(worker),
    })
}

/// Upper bound on hook request bodies. Claude/Codex hook envelopes are small
/// JSON objects; anything larger on this localhost endpoint is malformed or
/// hostile and is rejected rather than buffered.
const MAX_HOOK_BODY_BYTES: usize = 64 * 1024;

/// How long the hook server holds a `PermissionRequest` open waiting for the user
/// to answer the native card before giving up and letting the CLI fall back to
/// its own in-TUI prompt. Generous enough to walk back to the machine, bounded so
/// a forgotten card cannot park a waiter thread forever.
///
/// Deliberately set just under Codex's 600s command-hook ceiling (baked into the
/// hook trust hash in [`crate::codex_hooks`]) and well under Claude's 900s
/// PermissionRequest timeout, so the server always sends an explicit reply, a
/// decision or a no-decision 204 at this deadline, before either CLI abandons the
/// hook on its own. That keeps the fallback a clean "no decision -> show the TUI
/// prompt" rather than a hard hook timeout.
const APPROVAL_DECISION_TIMEOUT: Duration = Duration::from_secs(570);

fn run_request_loop(
    server: Arc<Server>,
    sequences: Arc<Mutex<HashMap<String, u64>>>,
    auth: Arc<Mutex<HashMap<(HookSource, String), SessionId>>>,
    approvals: Arc<ApprovalRegistry>,
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

        // Record activity translation for either source first; the response body
        // only matters for UserPromptSubmit (a pending-message nudge) and
        // PermissionRequest (the approval decision), but every hook event still
        // drives the activity stream.
        let translated = translate(source, reverie_session_id, &payload, &sequences);
        // A PermissionRequest produces an AwaitingPermission state carrying the id
        // the user's decision is keyed against; grab it before the update is moved
        // into the channel.
        let pending_permission = translated.as_ref().and_then(permission_request_id);
        if let Some(update) = translated {
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

        // A tool-permission ask can be answered from a native card instead of the
        // CLI's own TUI prompt. Hold this hook's HTTP connection open on its own
        // thread (so the single-threaded accept loop keeps serving every other
        // session) until the user decides or the wait times out. The reply carries
        // the decision in the shape the source CLI honors; a timeout replies with
        // no decision (204), so the CLI shows its own prompt. Deny-safe either way.
        if let Some(perm_id) = pending_permission {
            let approvals = Arc::clone(&approvals);
            let key = (reverie_session_id, perm_id);
            let spawned = thread::Builder::new()
                .name("reverie-hook-approval-wait".to_owned())
                .spawn(move || {
                    let response = match approvals.wait(key, APPROVAL_DECISION_TIMEOUT) {
                        Some(decision) => permission_decision_response(source, decision),
                        None => simple_response(204, ""),
                    };
                    let _ = request.respond(response);
                });
            // If we somehow cannot spawn the waiter, fall back to an immediate
            // no-decision reply rather than dropping the connection silently.
            if let Err(_err) = spawned {
                // The request was moved into the failed closure and dropped; the
                // socket closes with no response, which the CLI treats as "no
                // decision" and prompts in its TUI. (Spawn failure is pathological.)
            }
            continue;
        }

        let _ = request.respond(simple_response(204, ""));
    }
}

/// The permission id an update carries, if it is an AwaitingPermission state.
/// Only a `PermissionRequest` hook builds that state, so this is the single
/// signal that an inbound hook should be held open for a decision.
fn permission_request_id(update: &ActivityUpdate) -> Option<String> {
    match update {
        ActivityUpdate::State { state, .. } => {
            state.awaiting_permission.as_ref().map(|req| req.id.clone())
        }
        _ => None,
    }
}

/// The HTTP body that tells the source CLI to allow or deny, in the shape each
/// honors. Returned 200 + JSON so the CLI parses it as a hook decision. A shape a
/// CLI does not recognize is simply ignored (it falls back to its own prompt), so
/// schema drift degrades to "answer in the TUI" rather than breaking.
fn permission_decision_response(
    source: HookSource,
    decision: ApprovalDecision,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = match source {
        HookSource::ClaudeCode => claude_permission_decision_body(decision),
        HookSource::CodexCli => codex_permission_decision_body(decision),
    };
    Response::from_string(body.to_string())
        .with_status_code(StatusCode(200))
        .with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                .expect("static header"),
        )
}

/// Claude Code's `PermissionRequest` hook decision body. Claude reads the HTTP
/// response directly, so this is its exact `hookSpecificOutput` shape.
fn claude_permission_decision_body(decision: ApprovalDecision) -> Value {
    let behavior = match decision {
        ApprovalDecision::Allow => "allow",
        ApprovalDecision::Deny => "deny",
    };
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": { "behavior": behavior }
        }
    })
}

/// Codex CLI's `PermissionRequest` hook decision body. The Codex hook is a
/// command hook, so this body is relayed verbatim to the hook command's stdout by
/// the `reverie-bridge-codex-hook` forwarder, and Codex reads it from there.
fn codex_permission_decision_body(decision: ApprovalDecision) -> Value {
    let behavior = match decision {
        ApprovalDecision::Allow => "allow",
        ApprovalDecision::Deny => "deny",
    };
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": { "behavior": behavior }
        }
    })
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

mod translation;
use translation::translate;
#[cfg(test)]
use translation::{claude_notification_status, is_asking_tool};

#[cfg(test)]
mod tests;
