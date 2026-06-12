//! Inter-agent connection business logic over a
//! [`ConnectionRepository`](crate::connection_repository::ConnectionRepository).
//!
//! Mirrors [`crate::workspace_service::WorkspaceService`] in shape: a concrete
//! struct over an `Arc<dyn ConnectionRepository>`, fully testable against
//! [`crate::connection_repository::InMemoryConnectionRepository`].
//!
//! The service owns three things on top of the persistent record store:
//!
//! 1. The in-memory registry of currently-running registered sessions (their
//!    secrets and addresses) so peer lookups and authentication work without
//!    a round-trip to persistence. A desktop restart wipes this registry,
//!    matching the lifecycle of the underlying CLI processes.
//! 2. The configured workspace-level [`ConnectionPolicy`], evaluated at
//!    request time. Per-focus overrides should be applied by the caller
//!    before invoking [`ConnectionService::request_connection`]; the service
//!    only sees the effective policy for this call.
//! 3. Coordination state for the long-poll accept/deny flow. Bridge calls
//!    block in [`ConnectionService::wait_for_decision`] on a [`Condvar`] that
//!    is signalled when the UI accepts or denies a request. The Condvar is
//!    paired with the `pending` mutex so waiters atomically release and
//!    re-acquire as required by `Condvar::wait_timeout`.
//!
//! The full design lives in `docs/technical/inter-agent-connections.md`.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::activity::ActivityStatus;
use crate::connection::{
    Connection, ConnectionClosedBy, ConnectionId, ConnectionInitiator, ConnectionMessage,
    ConnectionPolicy, ConnectionStatus, MessageId, RequestId,
};
use crate::connection_repository::ConnectionRepository;
use crate::domain::{AgentKind, FocusId, ProjectId, SessionId};
use crate::hook_server::HookPushSource;
use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Serialize};

/// Display address for a session, computed once at registration and held by
/// the service. The participant references in the persisted
/// [`Connection`] are by `SessionId` only; the address is the projection used
/// by banners, chips, panels, and activity-log entries.
///
/// Held in the in-memory registry rather than the persistent store because it
/// is derived from the live workspace snapshot. If the user renames a focus
/// or session, the desktop re-registers with the updated address.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAddress {
    pub agent_kind: AgentKind,
    pub project_id: Option<ProjectId>,
    pub project_name: Option<String>,
    pub focus_id: FocusId,
    pub focus_title: String,
    pub session_title: String,
}

/// Identity record for a session known to be live. Registered at spawn,
/// removed at terminate. The `secret` field is the per-session token the
/// helper binary presents on the local socket; see the bridge protocol.
#[derive(Clone, Debug)]
pub struct RegisteredSession {
    pub session_id: SessionId,
    pub secret: String,
    pub address: SessionAddress,
}

/// View of a peer returned by [`ConnectionService::list_peers`] and
/// [`ConnectionService::peer_status`]. Computed live, never persisted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerView {
    pub session_id: SessionId,
    pub address: SessionAddress,
    /// The peer's currently reported activity status, if any. Populated from
    /// the activity stream by the caller before passing to the bridge.
    #[serde(default)]
    pub current_activity: Option<ActivityStatus>,
    /// Optional short human-readable summary of what the peer is doing.
    #[serde(default)]
    pub current_summary: Option<String>,
    /// If the caller already has an open connection to this peer, its id.
    /// Useful for the bridge to detect duplicate `request_connection` calls.
    #[serde(default)]
    pub open_connection_id: Option<ConnectionId>,
}

/// Scope filter for peer enumeration. Defaults to `Focus` per the design
/// guardrail that agents see only their own focus's peers unless explicitly
/// widened.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerScope {
    Focus,
    Project,
    Workspace,
}

/// Decision the configured policy makes for a particular (caller, target)
/// pair. The caller is responsible for translating this into either an
/// immediate auto-allow or a user-facing request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyDecision {
    Allow,
    RequireDecision,
}

/// Outcome of [`ConnectionService::request_connection`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RequestOutcome {
    /// Policy auto-allowed the request; the connection is already `Open`.
    Allowed { connection_id: ConnectionId },
    /// The user must decide. Bridge callers should
    /// [`ConnectionService::wait_for_decision`] on `request_id`.
    Pending {
        connection_id: ConnectionId,
        request_id: RequestId,
    },
    /// The two sessions already have an open connection. No new record was
    /// created; the existing one is returned for reuse.
    AlreadyOpen { connection_id: ConnectionId },
    /// The user explicitly blocked this initiator-target pair for a
    /// duration. The agent should not re-issue requests until the window
    /// elapses. `blockedUntilSecs` is a soft hint; the agent SHOULD wait at
    /// least that long.
    BlockedByPair {
        blocked_until_secs: u64,
        reason: String,
    },
}

/// Outcome of [`ConnectionService::wait_for_decision`]. `Timeout` means the
/// configured wall-clock window elapsed without a decision; the bridge may
/// return `pending(request_id)` to its caller and the agent may re-query via
/// [`ConnectionService::poll_decision`] on a later turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WaitOutcome {
    Allowed { connection_id: ConnectionId },
    Denied,
    Timeout,
    Unknown,
}

/// Who or what made an accept/deny decision. The user case is the common
/// banner-click; `Policy` is used by auto-allow paths and by request expiry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DecisionBy {
    User,
    Policy { reason: String },
}

/// Identity of the actor closing a connection. Distinct from
/// [`ConnectionClosedBy`] in `connection.rs` only at the API boundary:
/// callers describe their identity, the service maps to the persisted enum.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConnectionCaller {
    Session(SessionId),
    User,
    SessionEnded(SessionId),
    Policy(String),
}

impl ConnectionCaller {
    fn into_closed_by(self) -> ConnectionClosedBy {
        match self {
            ConnectionCaller::Session(session_id) => ConnectionClosedBy::Agent { session_id },
            ConnectionCaller::User => ConnectionClosedBy::User,
            ConnectionCaller::SessionEnded(session_id) => {
                ConnectionClosedBy::SessionEnded { session_id }
            }
            ConnectionCaller::Policy(reason) => ConnectionClosedBy::Policy { reason },
        }
    }
}

#[derive(Clone, Debug)]
enum PendingState {
    Waiting { connection_id: ConnectionId },
    Decided { decision: DecisionResult },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DecisionResult {
    Allowed(ConnectionId),
    Denied,
}

/// Default rate-limit window for the "recent denial" detection used by the
/// UI to surface the "block further requests for N min" affordance.
pub const RECENT_DENIAL_WINDOW: Duration = Duration::from_secs(60 * 10);
/// Default block duration applied when the user opts into "block further
/// requests" on a repeated denial.
pub const DEFAULT_PAIR_BLOCK_DURATION: Duration = Duration::from_secs(60 * 10);

/// Per-(initiator, target) repeat-denial tracking. Held in-memory only:
/// rate-limit nudges do not need to survive a desktop restart, and a fresh
/// boot is a reasonable signal that the user wants a clean slate.
#[derive(Clone, Copy, Debug)]
struct PairDenialRecord {
    last_denied_at: Instant,
    block_until: Option<Instant>,
}

/// A change to [`ConnectionService`] state worth surfacing to the UI. The
/// desktop registers an observer (via [`ConnectionService::set_observer`]) that
/// translates these into Tauri events so the React banner and connection panels
/// stay live. Headless and test builds leave the observer unset; the
/// notifications are then dropped.
///
/// Every state transition the service performs emits one of these, which is
/// what lets the frontend stay purely event-driven with no polling: there is no
/// silent, time-based transition (requests do not auto-expire, and
/// `unregister_session` leaves pending requests intact), so an observer that
/// fires on each mutation sees the complete picture.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConnectionEvent {
    /// The set of pending (awaiting-user-decision) requests changed: a request
    /// was created, accepted, or denied. Listeners re-read
    /// [`ConnectionService::list_pending_requests`].
    RequestsChanged,
    /// One connection's lifecycle state changed (opened or closed). Carries the
    /// affected id so a listener can refresh just that connection's panel.
    StateChanged { connection_id: ConnectionId },
}

/// Observer invoked synchronously on the thread performing a state change.
/// Implementations must be cheap and non-blocking (the desktop's just enqueues
/// a Tauri event) and must not call back into [`ConnectionService`].
pub type ConnectionObserver = Arc<dyn Fn(ConnectionEvent) + Send + Sync>;

pub struct ConnectionService {
    repo: Arc<dyn ConnectionRepository>,
    sessions: Mutex<HashMap<SessionId, RegisteredSession>>,
    policy: Mutex<ConnectionPolicy>,
    focus_overrides: Mutex<HashMap<FocusId, ConnectionPolicy>>,
    pending: Mutex<HashMap<RequestId, PendingState>>,
    pair_denials: Mutex<HashMap<(SessionId, SessionId), PairDenialRecord>>,
    decisions: Condvar,
    observer: Mutex<Option<ConnectionObserver>>,
}

/// Compare two byte strings without short-circuiting on the first mismatch, so
/// the time taken does not leak how many leading bytes of a presented bridge
/// secret were correct. Length is allowed to short-circuit: the secret length
/// is fixed, so it carries no useful signal.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

impl ConnectionService {
    pub fn new(repo: Arc<dyn ConnectionRepository>) -> Self {
        Self {
            repo,
            sessions: Mutex::new(HashMap::new()),
            policy: Mutex::new(ConnectionPolicy::AlwaysAsk),
            focus_overrides: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            pair_denials: Mutex::new(HashMap::new()),
            decisions: Condvar::new(),
            observer: Mutex::new(None),
        }
    }

    /// Register the observer that receives every [`ConnectionEvent`]. Replaces
    /// any prior observer. The desktop wires this once at startup (before the
    /// bridge accept loop goes live, so no request can race it); tests and
    /// headless builds leave it unset.
    pub fn set_observer(&self, observer: ConnectionObserver) {
        *self.observer.lock().expect("observer mutex") = Some(observer);
    }

    /// Fire the observer, if one is registered. Always called *after* the
    /// service's inner locks (`pending`, `sessions`, ...) have been released, so
    /// the observer can never deadlock against the mutation that triggered it.
    fn notify(&self, event: ConnectionEvent) {
        let observer = self.observer.lock().expect("observer mutex").clone();
        if let Some(observer) = observer {
            observer(event);
        }
    }

    // ---------------------------------------------------------------
    // Session registry
    // ---------------------------------------------------------------

    /// Register a live session. Called by the desktop at spawn and on any
    /// metadata refresh (title, focus, project rename). Replaces any prior
    /// registration for the same `session_id`, including the secret, so a
    /// re-launched session cannot reuse an old secret.
    pub fn register_session(&self, session: RegisteredSession) {
        let mut guard = self.sessions.lock().expect("sessions mutex");
        guard.insert(session.session_id, session);
    }

    /// Remove a session from the registry. Called by the desktop at terminate
    /// or when a session ends unexpectedly. Any open connections involving
    /// this session should be closed separately via [`Self::close`] with
    /// [`ConnectionCaller::SessionEnded`] so the activity log is correct.
    pub fn unregister_session(&self, session_id: SessionId) {
        let mut guard = self.sessions.lock().expect("sessions mutex");
        guard.remove(&session_id);
    }

    /// Authenticate a (session_id, presented_secret) tuple. Returns
    /// `Ok(address)` if the registration matches; errors otherwise. The
    /// bridge calls this on every helper handshake.
    pub fn authenticate(&self, session_id: SessionId, secret: &str) -> Result<SessionAddress> {
        let guard = self.sessions.lock().expect("sessions mutex");
        let session = guard
            .get(&session_id)
            .ok_or_else(|| anyhow!("session {session_id} is not registered with the bridge"))?;
        if !constant_time_eq(session.secret.as_bytes(), secret.as_bytes()) {
            bail!("session {session_id} presented an invalid bridge secret");
        }
        Ok(session.address.clone())
    }

    /// Currently registered sessions, in arbitrary order. For diagnostics.
    pub fn registered_session_count(&self) -> usize {
        let guard = self.sessions.lock().expect("sessions mutex");
        guard.len()
    }

    // ---------------------------------------------------------------
    // Policy
    // ---------------------------------------------------------------

    pub fn set_policy(&self, policy: ConnectionPolicy) {
        let mut guard = self.policy.lock().expect("policy mutex");
        *guard = policy;
    }

    pub fn current_policy(&self) -> ConnectionPolicy {
        *self.policy.lock().expect("policy mutex")
    }

    /// Set or clear a focus-level policy override. When set, requests
    /// originating from sessions in that focus use the override instead of
    /// the workspace default. `None` clears the override.
    ///
    /// In-memory only: a desktop restart loses overrides. The desktop is
    /// expected to re-seed these from persistent storage on startup.
    pub fn set_focus_policy_override(&self, focus: FocusId, policy: Option<ConnectionPolicy>) {
        let mut overrides = self.focus_overrides.lock().expect("focus overrides mutex");
        match policy {
            Some(p) => {
                overrides.insert(focus, p);
            }
            None => {
                overrides.remove(&focus);
            }
        }
    }

    /// Inspect the override registered for one focus, if any.
    pub fn focus_policy_override(&self, focus: FocusId) -> Option<ConnectionPolicy> {
        let overrides = self.focus_overrides.lock().expect("focus overrides mutex");
        overrides.get(&focus).copied()
    }

    /// The effective policy for a session given any focus override on its
    /// home focus. Falls back to the workspace default.
    pub fn effective_policy_for(&self, address: &SessionAddress) -> ConnectionPolicy {
        let overrides = self.focus_overrides.lock().expect("focus overrides mutex");
        overrides
            .get(&address.focus_id)
            .copied()
            .unwrap_or_else(|| *self.policy.lock().expect("policy mutex"))
    }

    /// Evaluate the configured policy against the relationship between two
    /// session addresses.
    ///
    /// The current rules:
    ///
    /// - [`ConnectionPolicy::AlwaysAsk`]: always `RequireDecision`.
    /// - [`ConnectionPolicy::AutoAllowFocus`]: `Allow` if same focus, else
    ///   `RequireDecision`.
    /// - [`ConnectionPolicy::AutoAllowProject`]: `Allow` if same project
    ///   (which includes same focus), else `RequireDecision`.
    /// - [`ConnectionPolicy::AutoAllowWorkspace`]: `Allow` for any two
    ///   sessions in the workspace.
    ///
    /// **Cross-project hard rule**: two sessions in different projects always
    /// require a user decision, regardless of any auto-allow policy. The
    /// general workspace (`project_id == None`) is treated as its own
    /// project for this purpose: a focus in General and a focus inside a
    /// real project are cross-project.
    pub fn evaluate_policy(
        &self,
        caller: &SessionAddress,
        target: &SessionAddress,
    ) -> PolicyDecision {
        self.evaluate_policy_with(self.current_policy(), caller, target)
    }

    /// Same as [`evaluate_policy`] but lets the caller supply an effective
    /// policy (e.g. a focus-level override resolved from the workspace
    /// snapshot). The cross-project hard rule still applies.
    pub fn evaluate_policy_with(
        &self,
        policy: ConnectionPolicy,
        caller: &SessionAddress,
        target: &SessionAddress,
    ) -> PolicyDecision {
        // Cross-project hard rule, applied before every auto-allow check.
        if caller.project_id != target.project_id {
            return PolicyDecision::RequireDecision;
        }
        match policy {
            ConnectionPolicy::AlwaysAsk => PolicyDecision::RequireDecision,
            ConnectionPolicy::AutoAllowFocus => {
                if caller.focus_id == target.focus_id {
                    PolicyDecision::Allow
                } else {
                    PolicyDecision::RequireDecision
                }
            }
            // AutoAllowProject and AutoAllowWorkspace differ only in the
            // hard rule above: once we know caller and target are in the
            // same project, they behave the same way.
            ConnectionPolicy::AutoAllowProject | ConnectionPolicy::AutoAllowWorkspace => {
                PolicyDecision::Allow
            }
        }
    }

    // ---------------------------------------------------------------
    // Peer queries
    // ---------------------------------------------------------------

    pub fn list_peers(&self, caller: SessionId, scope: PeerScope) -> Result<Vec<PeerView>> {
        let sessions = self.sessions.lock().expect("sessions mutex");
        let caller_session = sessions
            .get(&caller)
            .ok_or_else(|| anyhow!("session {caller} is not registered with the bridge"))?
            .clone();

        let mut peers: Vec<PeerView> = Vec::new();
        for session in sessions.values() {
            if session.session_id == caller {
                continue;
            }
            if !scope_matches(scope, &caller_session.address, &session.address) {
                continue;
            }
            peers.push(PeerView {
                session_id: session.session_id,
                address: session.address.clone(),
                current_activity: None,
                current_summary: None,
                open_connection_id: None,
            });
        }
        drop(sessions);

        // Annotate with open-connection ids so the bridge can short-circuit
        // duplicate request_connection calls.
        let caller_connections = self.repo.list_connections_for(caller)?;
        for peer in &mut peers {
            if let Some(open) = caller_connections.iter().find(|c| {
                c.status == ConnectionStatus::Open
                    && c.involves(peer.session_id)
                    && c.involves(caller)
            }) {
                peer.open_connection_id = Some(open.id);
            }
        }

        // Stable ordering for tests and UI: by focus title, then session title.
        peers.sort_by(|a, b| {
            a.address
                .focus_title
                .to_lowercase()
                .cmp(&b.address.focus_title.to_lowercase())
                .then_with(|| {
                    a.address
                        .session_title
                        .to_lowercase()
                        .cmp(&b.address.session_title.to_lowercase())
                })
        });
        Ok(peers)
    }

    pub fn peer_status(&self, caller: SessionId, peer: SessionId) -> Result<Option<PeerView>> {
        let peers = self.list_peers(caller, PeerScope::Workspace)?;
        Ok(peers.into_iter().find(|view| view.session_id == peer))
    }

    // ---------------------------------------------------------------
    // Connection lifecycle
    // ---------------------------------------------------------------

    /// Open a connection on behalf of an agent. The configured policy
    /// determines whether this returns `Allowed` immediately or `Pending`
    /// requiring a user decision. If the pair already has an open
    /// connection, returns `AlreadyOpen` without modifying state.
    pub fn request_connection(
        &self,
        initiator: SessionId,
        target: SessionId,
        reason: impl Into<String>,
        now: impl Into<String>,
        expires_at: impl Into<String>,
    ) -> Result<RequestOutcome> {
        if initiator == target {
            bail!("cannot request a connection to your own session");
        }
        let (caller_addr, target_addr) = {
            let sessions = self.sessions.lock().expect("sessions mutex");
            let caller = sessions
                .get(&initiator)
                .ok_or_else(|| anyhow!("session {initiator} is not registered"))?
                .clone();
            let target = sessions
                .get(&target)
                .ok_or_else(|| anyhow!("target session {target} is not registered"))?
                .clone();
            (caller.address, target.address)
        };

        let now: String = now.into();

        // Deduplicate against any existing open or in-flight connection
        // between the pair. A concurrent second agent (or a slow one re-
        // issuing) must not stack a duplicate request.
        let existing = self.repo.list_connections_for(initiator)?;
        if let Some(open) = existing.iter().find(|c| {
            c.status == ConnectionStatus::Open && c.involves(initiator) && c.involves(target)
        }) {
            return Ok(RequestOutcome::AlreadyOpen {
                connection_id: open.id,
            });
        }

        // A `Requested` connection that is still `Waiting` in the in-memory map
        // is a genuine in-flight duplicate: return it so we don't stack a
        // second request. Any other `Requested` record for this pair is an
        // orphan from a previous app session, because the in-memory waiter
        // state and the requesting process are both gone. Left in place, an
        // orphan poisons everything downstream: dedup returns it (masking the
        // current policy, so auto-allow never applies and the TTL never
        // refreshes), the banner never shows it (the banner reads the in-memory
        // map), and `wait_for_decision` answers `Unknown`. So retire every
        // orphan and only dedup onto a live one.
        let mut live_pending: Option<(ConnectionId, RequestId)> = None;
        for conn in existing.iter().filter(|c| {
            c.status == ConnectionStatus::Requested && c.involves(initiator) && c.involves(target)
        }) {
            let Some(pending) = conn.pending_request.as_ref() else {
                continue;
            };
            let is_live = {
                let map = self.pending.lock().expect("pending mutex");
                matches!(
                    map.get(&pending.request_id),
                    Some(PendingState::Waiting { .. })
                )
            };
            if is_live {
                live_pending = Some((conn.id, pending.request_id));
            } else {
                self.retire_orphaned_request(conn, &now)?;
            }
        }
        if let Some((connection_id, request_id)) = live_pending {
            return Ok(RequestOutcome::Pending {
                connection_id,
                request_id,
            });
        }

        // Pair-level block: if the user previously chose "block further
        // requests" on a repeat denial, requests against this pair are
        // auto-denied until the block window expires. The agent gets a
        // structured `BlockedByPair` outcome so it can back off cleanly.
        if let Some(until) = self.pair_block_until(initiator, target) {
            let block_label = format!(
                "blocked by user; rate-limit until +{}s",
                until.saturating_duration_since(Instant::now()).as_secs(),
            );
            return Ok(RequestOutcome::BlockedByPair {
                blocked_until_secs: until.saturating_duration_since(Instant::now()).as_secs(),
                reason: block_label,
            });
        }

        // The effective policy honours any focus-level override the user
        // set for the caller's focus; the cross-project hard rule still
        // wraps it.
        let policy = self.effective_policy_for(&caller_addr);
        let decision = self.evaluate_policy_with(policy, &caller_addr, &target_addr);
        let expires_at: String = expires_at.into();
        let reason: String = reason.into();

        match decision {
            PolicyDecision::Allow => {
                let conn = Connection::user_opened(
                    initiator,
                    target,
                    format!("policy auto-allow: {reason}"),
                    policy,
                    now,
                );
                let conn_id = conn.id;
                self.repo.upsert_connection(&conn)?;
                self.notify(ConnectionEvent::StateChanged {
                    connection_id: conn_id,
                });
                Ok(RequestOutcome::Allowed {
                    connection_id: conn_id,
                })
            }
            PolicyDecision::RequireDecision => {
                let request_id = RequestId::new_v4();
                let conn = Connection::agent_requested(
                    initiator, target, reason, policy, request_id, now, expires_at,
                );
                let conn_id = conn.id;
                self.repo.upsert_connection(&conn)?;

                {
                    let mut pending = self.pending.lock().expect("pending mutex");
                    pending.insert(
                        request_id,
                        PendingState::Waiting {
                            connection_id: conn_id,
                        },
                    );
                }
                // The decision-required path is the one that drives the
                // accept/deny banner; this notify is what makes the banner
                // appear the moment an agent issues a `request_connection`.
                self.notify(ConnectionEvent::RequestsChanged);
                Ok(RequestOutcome::Pending {
                    connection_id: conn_id,
                    request_id,
                })
            }
        }
    }

    /// Retire a `Requested` connection left behind by a previous app session.
    /// Its in-memory waiter and the requesting process are gone, so it can
    /// never resolve on its own. Moving it to `Denied` (by policy) frees the
    /// pair for a fresh request under the current policy and clears it from the
    /// pending-request listing. Idempotent in effect: a connection that is no
    /// longer `Requested` (a concurrent decision raced us) is left untouched.
    fn retire_orphaned_request(&self, conn: &Connection, now: &str) -> Result<()> {
        let mut conn = conn.clone();
        if conn.status != ConnectionStatus::Requested {
            return Ok(());
        }
        let connection_id = conn.id;
        conn.deny(
            now.to_owned(),
            ConnectionClosedBy::Policy {
                reason: "request retired: left over from a previous app session".to_owned(),
            },
            Some("retired stale request".to_owned()),
        )?;
        self.repo.upsert_connection(&conn)?;
        self.notify(ConnectionEvent::StateChanged { connection_id });
        Ok(())
    }

    /// Block until the named request is decided or `timeout` elapses.
    /// Designed for the bridge's long-poll handler. Safe to call multiple
    /// times for the same `request_id`: subsequent calls observe the same
    /// `Decided` state and return immediately.
    pub fn wait_for_decision(&self, request_id: RequestId, timeout: Duration) -> WaitOutcome {
        let deadline = Instant::now() + timeout;
        let mut pending = self.pending.lock().expect("pending mutex");
        loop {
            match pending.get(&request_id) {
                Some(PendingState::Decided { decision }) => {
                    return match decision {
                        DecisionResult::Allowed(id) => WaitOutcome::Allowed { connection_id: *id },
                        DecisionResult::Denied => WaitOutcome::Denied,
                    };
                }
                Some(PendingState::Waiting { .. }) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return WaitOutcome::Timeout;
                    }
                    let (next_pending, wait_result) = self
                        .decisions
                        .wait_timeout(pending, remaining)
                        .expect("condvar wait");
                    pending = next_pending;
                    if wait_result.timed_out() {
                        // Recheck once more in case the signal raced the timeout.
                        return match pending.get(&request_id) {
                            Some(PendingState::Decided {
                                decision: DecisionResult::Allowed(id),
                            }) => WaitOutcome::Allowed { connection_id: *id },
                            Some(PendingState::Decided {
                                decision: DecisionResult::Denied,
                            }) => WaitOutcome::Denied,
                            _ => WaitOutcome::Timeout,
                        };
                    }
                    // Spurious wake or signal arrived: loop and recheck.
                }
                None => return WaitOutcome::Unknown,
            }
        }
    }

    /// Non-blocking equivalent for use from agent re-query turns. Returns
    /// `None` if the request is still waiting on a user decision.
    pub fn poll_decision(&self, request_id: RequestId) -> Option<WaitOutcome> {
        let pending = self.pending.lock().expect("pending mutex");
        match pending.get(&request_id) {
            Some(PendingState::Decided { decision }) => Some(match decision {
                DecisionResult::Allowed(id) => WaitOutcome::Allowed { connection_id: *id },
                DecisionResult::Denied => WaitOutcome::Denied,
            }),
            Some(PendingState::Waiting { .. }) => None,
            None => Some(WaitOutcome::Unknown),
        }
    }

    /// Accept a pending request. Promotes the underlying connection to
    /// `Open` and signals any long-poll waiter. Errors if the request is
    /// unknown or already resolved.
    pub fn accept_request(
        &self,
        request_id: RequestId,
        _by: DecisionBy,
        now: impl Into<String>,
    ) -> Result<ConnectionId> {
        let now: String = now.into();

        // Phase 1: lookup + lock the request as Claiming so a concurrent
        // accept/deny is rejected, then drop the pending lock during repo I/O
        // so other waiters (including wait_for_decision waiters using the
        // condvar) are not blocked behind the repo round-trip.
        let connection_id = {
            let pending = self.pending.lock().expect("pending mutex");
            match pending.get(&request_id) {
                Some(PendingState::Waiting { connection_id }) => *connection_id,
                Some(PendingState::Decided { .. }) => {
                    bail!("request {request_id} has already been decided")
                }
                None => bail!("no such pending request: {request_id}"),
            }
        };

        let mut conn = self
            .repo
            .get_connection(connection_id)?
            .ok_or_else(|| anyhow!("connection {connection_id} disappeared from storage"))?;
        conn.accept(now)?;
        self.repo.upsert_connection(&conn)?;

        {
            let mut pending = self.pending.lock().expect("pending mutex");
            // Defensive: if a concurrent caller raced us, prefer the existing
            // Decided state over overwriting. Only commit when still Waiting.
            if matches!(
                pending.get(&request_id),
                Some(PendingState::Waiting { .. }) | None
            ) {
                pending.insert(
                    request_id,
                    PendingState::Decided {
                        decision: DecisionResult::Allowed(connection_id),
                    },
                );
            }
            self.decisions.notify_all();
        }
        // Both the banner (one fewer pending request) and any open-connection
        // panel (the connection just went Open) need to refresh.
        self.notify(ConnectionEvent::StateChanged { connection_id });
        self.notify(ConnectionEvent::RequestsChanged);
        Ok(connection_id)
    }

    /// Deny a pending request. Moves the underlying connection to `Denied`
    /// and signals any long-poll waiter.
    pub fn deny_request(
        &self,
        request_id: RequestId,
        by: DecisionBy,
        now: impl Into<String>,
        reason: Option<String>,
    ) -> Result<()> {
        let now: String = now.into();

        let connection_id = {
            let pending = self.pending.lock().expect("pending mutex");
            match pending.get(&request_id) {
                Some(PendingState::Waiting { connection_id }) => *connection_id,
                Some(PendingState::Decided { .. }) => {
                    bail!("request {request_id} has already been decided")
                }
                None => bail!("no such pending request: {request_id}"),
            }
        };

        let mut conn = self
            .repo
            .get_connection(connection_id)?
            .ok_or_else(|| anyhow!("connection {connection_id} disappeared from storage"))?;
        let closed_by = match by {
            DecisionBy::User => ConnectionClosedBy::User,
            DecisionBy::Policy { reason: r } => ConnectionClosedBy::Policy { reason: r },
        };
        conn.deny(now, closed_by, reason)?;
        let initiator = match &conn.initiator {
            ConnectionInitiator::Agent { session_id } => Some(*session_id),
            ConnectionInitiator::User => None,
        };
        let other = initiator.and_then(|s| conn.other_participant(s));
        self.repo.upsert_connection(&conn)?;

        {
            let mut pending = self.pending.lock().expect("pending mutex");
            if matches!(
                pending.get(&request_id),
                Some(PendingState::Waiting { .. }) | None
            ) {
                pending.insert(
                    request_id,
                    PendingState::Decided {
                        decision: DecisionResult::Denied,
                    },
                );
            }
            self.decisions.notify_all();
        }

        // Track the (initiator, target) denial for the UI's repeat-denial
        // rate-limit affordance. Skip if the connection had no agent
        // initiator (which shouldn't happen for Requested connections, but
        // is defensive).
        if let (Some(source), Some(target)) = (initiator, other) {
            let mut pair_denials = self.pair_denials.lock().expect("pair_denials mutex");
            let entry = pair_denials
                .entry((source, target))
                .or_insert(PairDenialRecord {
                    last_denied_at: Instant::now(),
                    block_until: None,
                });
            entry.last_denied_at = Instant::now();
        }

        // Clear the banner card and refresh any panel showing this connection,
        // which just moved to Denied.
        self.notify(ConnectionEvent::StateChanged { connection_id });
        self.notify(ConnectionEvent::RequestsChanged);
        Ok(())
    }

    /// User-initiated open: skip the request flow and create the connection
    /// directly in `Open` state. Errors if the pair already has an open
    /// connection.
    pub fn user_open(
        &self,
        a: SessionId,
        b: SessionId,
        reason: impl Into<String>,
        now: impl Into<String>,
    ) -> Result<ConnectionId> {
        if a == b {
            bail!("cannot open a connection to your own session");
        }
        {
            let sessions = self.sessions.lock().expect("sessions mutex");
            if !sessions.contains_key(&a) {
                bail!("session {a} is not registered");
            }
            if !sessions.contains_key(&b) {
                bail!("session {b} is not registered");
            }
        }
        let existing = self.repo.list_connections_for(a)?;
        if existing
            .iter()
            .any(|c| c.status == ConnectionStatus::Open && c.involves(a) && c.involves(b))
        {
            bail!("an open connection between these sessions already exists");
        }
        let conn = Connection::user_opened(a, b, reason, self.current_policy(), now);
        let id = conn.id;
        self.repo.upsert_connection(&conn)?;
        self.notify(ConnectionEvent::StateChanged { connection_id: id });
        Ok(id)
    }

    // ---------------------------------------------------------------
    // Messaging
    // ---------------------------------------------------------------

    /// Send a message from `caller` through an open connection.
    pub fn send_message(
        &self,
        caller: SessionId,
        connection_id: ConnectionId,
        body: impl Into<String>,
        now: impl Into<String>,
    ) -> Result<MessageId> {
        let connection = self
            .repo
            .get_connection(connection_id)?
            .ok_or_else(|| anyhow!("no such connection: {connection_id}"))?;
        if !connection.is_open() {
            bail!(
                "cannot send through connection {connection_id}: status is {:?}",
                connection.status
            );
        }
        let peer = connection
            .other_participant(caller)
            .ok_or_else(|| anyhow!("session {caller} is not a participant of {connection_id}"))?;

        let existing = self.repo.messages_after(connection_id, 0)?;
        let next_sequence = existing.iter().map(|m| m.sequence).max().unwrap_or(0) + 1;
        let message = ConnectionMessage::new(connection_id, caller, peer, body, now, next_sequence);
        let id = message.id;
        self.repo.append_message(&message)?;
        Ok(id)
    }

    /// Read-only transcript fetch for a connection: every message regardless
    /// of direction or delivery state, in sequence order. Does **not** stamp
    /// `delivered_at`. Use this for UI panels and audit views; agents that
    /// want to claim delivery should call [`Self::pending_messages`].
    pub fn list_messages(
        &self,
        caller: SessionId,
        connection_id: ConnectionId,
        since_sequence: u64,
    ) -> Result<Vec<ConnectionMessage>> {
        let connection = self
            .repo
            .get_connection(connection_id)?
            .ok_or_else(|| anyhow!("no such connection: {connection_id}"))?;
        if !connection.involves(caller) {
            bail!("session {caller} is not a participant of {connection_id}");
        }
        Ok(self.repo.messages_after(connection_id, since_sequence)?)
    }

    /// Fetch messages addressed to `caller` on `connection_id` with sequence
    /// strictly greater than `since_sequence`. Marks each returned message
    /// delivered if it was not already.
    pub fn pending_messages(
        &self,
        caller: SessionId,
        connection_id: ConnectionId,
        since_sequence: u64,
        now: impl Into<String>,
    ) -> Result<Vec<ConnectionMessage>> {
        let connection = self
            .repo
            .get_connection(connection_id)?
            .ok_or_else(|| anyhow!("no such connection: {connection_id}"))?;
        if !connection.involves(caller) {
            bail!("session {caller} is not a participant of {connection_id}");
        }
        let now: String = now.into();
        let messages = self.repo.messages_after(connection_id, since_sequence)?;
        let mut inbound = Vec::with_capacity(messages.len());
        for message in messages {
            if message.to_session != caller {
                continue;
            }
            let mut stamped = message.clone();
            if stamped.delivered_at.is_none() {
                self.repo.mark_message_delivered(message.id, &now)?;
                stamped.delivered_at = Some(now.clone());
            }
            inbound.push(stamped);
        }
        Ok(inbound)
    }

    // ---------------------------------------------------------------
    // Closure
    // ---------------------------------------------------------------

    /// Close an `Open` connection. Errors if the connection is not currently
    /// open. Callers that want to clean up a session-end automatically should
    /// pass [`ConnectionCaller::SessionEnded`].
    pub fn close(
        &self,
        caller: ConnectionCaller,
        connection_id: ConnectionId,
        now: impl Into<String>,
        reason: Option<String>,
    ) -> Result<()> {
        let mut connection = self
            .repo
            .get_connection(connection_id)?
            .ok_or_else(|| anyhow!("no such connection: {connection_id}"))?;
        // Authorization: only a participant, the user, or the system may close.
        if let ConnectionCaller::Session(session_id) = caller {
            if !connection.involves(session_id) {
                bail!("session {session_id} is not a participant of {connection_id}");
            }
        }
        connection.close(now, caller.into_closed_by(), reason)?;
        self.repo.upsert_connection(&connection)?;
        self.notify(ConnectionEvent::StateChanged { connection_id });
        Ok(())
    }

    // ---------------------------------------------------------------
    // Lookups
    // ---------------------------------------------------------------

    pub fn get_connection(&self, id: ConnectionId) -> Result<Option<Connection>> {
        Ok(self.repo.get_connection(id)?)
    }

    pub fn list_connections_for(&self, session: SessionId) -> Result<Vec<Connection>> {
        Ok(self.repo.list_connections_for(session)?)
    }

    // ---------------------------------------------------------------
    // Pair-level rate-limit (Phase 7)
    // ---------------------------------------------------------------

    /// True if `(source, target)` was denied within [`RECENT_DENIAL_WINDOW`].
    /// The UI calls this when rendering a connection-request banner: a true
    /// return surfaces the extra "block further requests" affordance.
    pub fn pair_recently_denied(&self, source: SessionId, target: SessionId) -> bool {
        let guard = self.pair_denials.lock().expect("pair_denials mutex");
        guard
            .get(&(source, target))
            .map(|record| record.last_denied_at.elapsed() < RECENT_DENIAL_WINDOW)
            .unwrap_or(false)
    }

    /// Block this pair from issuing new requests for `duration`. Used by the
    /// UI when the user clicks "block further requests" on a repeat-denial
    /// banner. Any in-flight request is unaffected.
    pub fn block_pair_for(&self, source: SessionId, target: SessionId, duration: Duration) {
        let mut guard = self.pair_denials.lock().expect("pair_denials mutex");
        let entry = guard.entry((source, target)).or_insert(PairDenialRecord {
            last_denied_at: Instant::now(),
            block_until: None,
        });
        entry.block_until = Some(Instant::now() + duration);
    }

    /// Clear any active block (and recent-denial memory) for a pair. The UI
    /// uses this from a "forget rate-limit" admin gesture; not exposed by
    /// default.
    pub fn clear_pair_block(&self, source: SessionId, target: SessionId) {
        let mut guard = self.pair_denials.lock().expect("pair_denials mutex");
        guard.remove(&(source, target));
    }

    fn pair_block_until(&self, source: SessionId, target: SessionId) -> Option<Instant> {
        let guard = self.pair_denials.lock().expect("pair_denials mutex");
        guard
            .get(&(source, target))
            .and_then(|record| record.block_until)
            .filter(|&until| until > Instant::now())
    }

    /// Every connection currently in `Requested` status. The UI uses this to
    /// render outstanding accept/deny banners; the pending request id can be
    /// extracted from `connection.pending_request`.
    pub fn list_pending_requests(&self) -> Result<Vec<Connection>> {
        let pending_ids: Vec<ConnectionId> = {
            let pending = self.pending.lock().expect("pending mutex");
            pending
                .values()
                .filter_map(|state| match state {
                    PendingState::Waiting { connection_id } => Some(*connection_id),
                    PendingState::Decided { .. } => None,
                })
                .collect()
        };
        let mut out = Vec::with_capacity(pending_ids.len());
        for id in pending_ids {
            if let Some(connection) = self.repo.get_connection(id)? {
                if connection.status == ConnectionStatus::Requested {
                    out.push(connection);
                }
            }
        }
        Ok(out)
    }
}

fn scope_matches(scope: PeerScope, caller: &SessionAddress, peer: &SessionAddress) -> bool {
    match scope {
        PeerScope::Focus => caller.focus_id == peer.focus_id,
        PeerScope::Project => caller.project_id == peer.project_id,
        PeerScope::Workspace => true,
    }
}

impl HookPushSource for ConnectionService {
    fn pre_turn_nudge_for(&self, reverie_session_id: SessionId) -> String {
        // For every open connection this session is in, pull the
        // undelivered inbound messages. Build a short prose note the
        // receiving CLI prepends to its next user prompt as additional
        // context.
        let connections = match self.list_connections_for(reverie_session_id) {
            Ok(list) => list,
            Err(_) => return String::new(),
        };
        let mut notices: Vec<String> = Vec::new();
        for connection in connections {
            if connection.status != ConnectionStatus::Open {
                continue;
            }
            let messages = match self.repo.messages_after(connection.id, 0) {
                Ok(list) => list,
                Err(_) => continue,
            };
            let undelivered: Vec<&ConnectionMessage> = messages
                .iter()
                .filter(|message| {
                    message.to_session == reverie_session_id && message.delivered_at.is_none()
                })
                .collect();
            if undelivered.is_empty() {
                continue;
            }
            let label = connection
                .topic
                .clone()
                .unwrap_or_else(|| connection.reason_opened.clone());
            notices.push(format!(
                "You have {n} unread message{plural} on connection \"{label}\" (id {id}). \
Call `reverie.pending_messages` with that connection id to read them.",
                n = undelivered.len(),
                plural = if undelivered.len() == 1 { "" } else { "s" },
                label = label,
                id = connection.id,
            ));
        }
        notices.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection_repository::InMemoryConnectionRepository;
    use uuid::Uuid;

    fn session_id(byte: u8) -> SessionId {
        Uuid::from_bytes([byte; 16])
    }

    fn focus_id(byte: u8) -> FocusId {
        Uuid::from_bytes([byte; 16])
    }

    fn project_id(byte: u8) -> ProjectId {
        Uuid::from_bytes([byte; 16])
    }

    fn address(
        kind: AgentKind,
        project: Option<(ProjectId, &str)>,
        focus: (FocusId, &str),
        title: &str,
    ) -> SessionAddress {
        SessionAddress {
            agent_kind: kind,
            project_id: project.map(|(id, _)| id),
            project_name: project.map(|(_, name)| name.to_owned()),
            focus_id: focus.0,
            focus_title: focus.1.to_owned(),
            session_title: title.to_owned(),
        }
    }

    fn service() -> Arc<ConnectionService> {
        Arc::new(ConnectionService::new(Arc::new(
            InMemoryConnectionRepository::new(),
        )))
    }

    fn register(svc: &ConnectionService, id: SessionId, address: SessionAddress) {
        svc.register_session(RegisteredSession {
            session_id: id,
            secret: format!("secret-for-{id}"),
            address,
        });
    }

    #[test]
    fn register_and_authenticate_round_trip() {
        let svc = service();
        let addr = address(
            AgentKind::ClaudeCode,
            None,
            (focus_id(0x10), "General"),
            "Claude",
        );
        register(&svc, session_id(0x01), addr.clone());

        let got = svc
            .authenticate(
                session_id(0x01),
                "secret-for-01010101-0101-0101-0101-010101010101",
            )
            .expect("authenticates with the registered secret");
        assert_eq!(got, addr);
    }

    #[test]
    fn authenticate_rejects_wrong_secret_and_unknown_session() {
        let svc = service();
        register(
            &svc,
            session_id(0x01),
            address(
                AgentKind::ClaudeCode,
                None,
                (focus_id(0x10), "General"),
                "C",
            ),
        );
        assert!(svc.authenticate(session_id(0x01), "wrong").is_err());
        assert!(svc.authenticate(session_id(0x02), "anything").is_err());
    }

    #[test]
    fn list_peers_excludes_caller_and_respects_scope() {
        let svc = service();
        let project = project_id(0xA0);
        let focus_a = focus_id(0x10);
        let focus_b = focus_id(0x11);

        register(
            &svc,
            session_id(0x01),
            address(
                AgentKind::ClaudeCode,
                Some((project, "Reverie")),
                (focus_a, "Design"),
                "Claude",
            ),
        );
        register(
            &svc,
            session_id(0x02),
            address(
                AgentKind::CortexCode,
                Some((project, "Reverie")),
                (focus_a, "Design"),
                "Cortex",
            ),
        );
        register(
            &svc,
            session_id(0x03),
            address(
                AgentKind::CodexCli,
                Some((project, "Reverie")),
                (focus_b, "Backend"),
                "Codex",
            ),
        );
        register(
            &svc,
            session_id(0x04),
            address(
                AgentKind::ClaudeCode,
                None,
                (focus_id(0x20), "Sketchpad"),
                "Claude scratch",
            ),
        );

        // Focus scope: only same-focus peer (Cortex in focus_a).
        let focus_peers = svc.list_peers(session_id(0x01), PeerScope::Focus).unwrap();
        let ids: Vec<_> = focus_peers.iter().map(|p| p.session_id).collect();
        assert_eq!(ids, vec![session_id(0x02)]);

        // Project scope: same project peers (Cortex, Codex).
        let project_peers = svc
            .list_peers(session_id(0x01), PeerScope::Project)
            .unwrap();
        let mut ids: Vec<_> = project_peers.iter().map(|p| p.session_id).collect();
        ids.sort();
        let mut expected = vec![session_id(0x02), session_id(0x03)];
        expected.sort();
        assert_eq!(ids, expected);

        // Workspace scope: everyone except caller.
        let workspace = svc
            .list_peers(session_id(0x01), PeerScope::Workspace)
            .unwrap();
        assert_eq!(workspace.len(), 3);
    }

    #[test]
    fn list_peers_annotates_open_connections() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "Claude"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "Cortex"),
        );

        let conn_id = svc
            .user_open(session_id(0x01), session_id(0x02), "test", "t0")
            .unwrap();

        let peers = svc.list_peers(session_id(0x01), PeerScope::Focus).unwrap();
        assert_eq!(peers[0].open_connection_id, Some(conn_id));
    }

    #[test]
    fn evaluate_policy_for_each_level() {
        let svc = service();
        let a = address(
            AgentKind::ClaudeCode,
            Some((project_id(0xA0), "P")),
            (focus_id(0x10), "F"),
            "A",
        );
        let same_focus = address(
            AgentKind::CortexCode,
            Some((project_id(0xA0), "P")),
            (focus_id(0x10), "F"),
            "B",
        );
        let cross_focus_same_project = address(
            AgentKind::CortexCode,
            Some((project_id(0xA0), "P")),
            (focus_id(0x11), "G"),
            "B",
        );
        let cross_project = address(
            AgentKind::CortexCode,
            Some((project_id(0xB0), "Q")),
            (focus_id(0x12), "H"),
            "B",
        );

        svc.set_policy(ConnectionPolicy::AlwaysAsk);
        assert_eq!(
            svc.evaluate_policy(&a, &same_focus),
            PolicyDecision::RequireDecision
        );

        svc.set_policy(ConnectionPolicy::AutoAllowFocus);
        assert_eq!(svc.evaluate_policy(&a, &same_focus), PolicyDecision::Allow);
        assert_eq!(
            svc.evaluate_policy(&a, &cross_focus_same_project),
            PolicyDecision::RequireDecision
        );
        assert_eq!(
            svc.evaluate_policy(&a, &cross_project),
            PolicyDecision::RequireDecision
        );

        svc.set_policy(ConnectionPolicy::AutoAllowProject);
        assert_eq!(svc.evaluate_policy(&a, &same_focus), PolicyDecision::Allow);
        assert_eq!(
            svc.evaluate_policy(&a, &cross_focus_same_project),
            PolicyDecision::Allow
        );
        assert_eq!(
            svc.evaluate_policy(&a, &cross_project),
            PolicyDecision::RequireDecision
        );

        svc.set_policy(ConnectionPolicy::AutoAllowWorkspace);
        assert_eq!(svc.evaluate_policy(&a, &same_focus), PolicyDecision::Allow);
        assert_eq!(
            svc.evaluate_policy(&a, &cross_focus_same_project),
            PolicyDecision::Allow
        );
        // Cross-project hard rule overrides AutoAllowWorkspace: the user
        // still has to opt in for cross-project requests even with the
        // broadest policy. See docs/technical/inter-agent-connections.md.
        assert_eq!(
            svc.evaluate_policy(&a, &cross_project),
            PolicyDecision::RequireDecision
        );
    }

    #[test]
    fn cross_project_hard_rule_treats_general_workspace_as_its_own_project() {
        let svc = service();
        // One session in a real project, one in General workspace
        // (project_id = None). They are cross-project for the hard rule's
        // purposes.
        let in_project = address(
            AgentKind::ClaudeCode,
            Some((project_id(0xA0), "P")),
            (focus_id(0x10), "F"),
            "A",
        );
        let in_general = address(AgentKind::CortexCode, None, (focus_id(0x20), "G"), "B");
        for policy in [
            ConnectionPolicy::AutoAllowFocus,
            ConnectionPolicy::AutoAllowProject,
            ConnectionPolicy::AutoAllowWorkspace,
        ] {
            svc.set_policy(policy);
            assert_eq!(
                svc.evaluate_policy(&in_project, &in_general),
                PolicyDecision::RequireDecision,
                "policy {policy:?} must still require decision across project boundary"
            );
        }

        // Two sessions both in General are NOT cross-project: project_id
        // equals project_id (None == None).
        let other_general = address(AgentKind::CortexCode, None, (focus_id(0x21), "G2"), "C");
        svc.set_policy(ConnectionPolicy::AutoAllowProject);
        assert_eq!(
            svc.evaluate_policy(&in_general, &other_general),
            PolicyDecision::Allow,
        );
    }

    #[test]
    fn evaluate_policy_with_lets_caller_supply_focus_level_override() {
        let svc = service();
        let a = address(
            AgentKind::ClaudeCode,
            Some((project_id(0xA0), "P")),
            (focus_id(0x10), "F"),
            "A",
        );
        let cross_focus_same_project = address(
            AgentKind::CortexCode,
            Some((project_id(0xA0), "P")),
            (focus_id(0x11), "G"),
            "B",
        );

        // Workspace default: AlwaysAsk
        svc.set_policy(ConnectionPolicy::AlwaysAsk);
        assert_eq!(
            svc.evaluate_policy(&a, &cross_focus_same_project),
            PolicyDecision::RequireDecision,
        );
        // But the caller can supply an effective policy from a focus-level
        // override, which still respects the cross-project hard rule.
        assert_eq!(
            svc.evaluate_policy_with(
                ConnectionPolicy::AutoAllowProject,
                &a,
                &cross_focus_same_project,
            ),
            PolicyDecision::Allow,
        );
    }

    #[test]
    fn request_connection_pends_under_always_ask() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "Claude"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "Cortex"),
        );

        let outcome = svc
            .request_connection(session_id(0x01), session_id(0x02), "r", "t0", "t10")
            .unwrap();
        match outcome {
            RequestOutcome::Pending {
                connection_id,
                request_id,
            } => {
                let conn = svc.get_connection(connection_id).unwrap().unwrap();
                assert_eq!(conn.status, ConnectionStatus::Requested);
                let poll = svc.poll_decision(request_id);
                assert!(poll.is_none(), "still waiting");
            }
            other => panic!("expected Pending, got {other:?}"),
        }
    }

    #[test]
    fn observer_is_notified_on_request_then_accept() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "Claude"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "Cortex"),
        );

        let events: Arc<Mutex<Vec<ConnectionEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        svc.set_observer(Arc::new(move |event| {
            sink.lock().expect("sink").push(event)
        }));

        // A new agent request fires RequestsChanged. This is the emit that was
        // missing: without it the accept/deny banner never appeared.
        let request_id = match svc
            .request_connection(session_id(0x01), session_id(0x02), "r", "t0", "t10")
            .unwrap()
        {
            RequestOutcome::Pending { request_id, .. } => request_id,
            other => panic!("expected Pending, got {other:?}"),
        };
        assert_eq!(
            events.lock().unwrap().as_slice(),
            &[ConnectionEvent::RequestsChanged],
        );

        // Accepting opens the connection (StateChanged) and clears the banner
        // (RequestsChanged).
        svc.accept_request(request_id, DecisionBy::User, "t1")
            .unwrap();
        let seen = events.lock().unwrap().clone();
        assert_eq!(seen.len(), 3, "request + accept = three events: {seen:?}");
        assert!(matches!(seen[1], ConnectionEvent::StateChanged { .. }));
        assert_eq!(seen[2], ConnectionEvent::RequestsChanged);
    }

    #[test]
    fn observer_is_notified_on_deny() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "Claude"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "Cortex"),
        );

        let request_id = match svc
            .request_connection(session_id(0x01), session_id(0x02), "r", "t0", "t10")
            .unwrap()
        {
            RequestOutcome::Pending { request_id, .. } => request_id,
            other => panic!("expected Pending, got {other:?}"),
        };

        let events: Arc<Mutex<Vec<ConnectionEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        svc.set_observer(Arc::new(move |event| {
            sink.lock().expect("sink").push(event)
        }));

        svc.deny_request(request_id, DecisionBy::User, "t1", None)
            .unwrap();
        let seen = events.lock().unwrap().clone();
        assert!(matches!(seen[0], ConnectionEvent::StateChanged { .. }));
        assert_eq!(seen[1], ConnectionEvent::RequestsChanged);
        assert_eq!(seen.len(), 2, "deny = two events: {seen:?}");
    }

    #[test]
    fn observer_is_notified_on_auto_allow() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "Claude"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "Cortex"),
        );
        svc.set_policy(ConnectionPolicy::AutoAllowFocus);

        let events: Arc<Mutex<Vec<ConnectionEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        svc.set_observer(Arc::new(move |event| {
            sink.lock().expect("sink").push(event)
        }));

        // Auto-allow opens the connection directly: no banner, but a state
        // change so the dashboard chip/panel updates live.
        svc.request_connection(session_id(0x01), session_id(0x02), "r", "t0", "t10")
            .unwrap();
        let seen = events.lock().unwrap().clone();
        assert_eq!(seen.len(), 1, "auto-allow = one event: {seen:?}");
        assert!(matches!(seen[0], ConnectionEvent::StateChanged { .. }));
    }

    // Simulate an app restart: a fresh service over the same durable repo, so
    // it starts with an empty in-memory pending map but inherits the persisted
    // connections. `register` re-registers the (stable) sessions, as the desktop
    // does on relaunch.
    fn restart_over(repo: &Arc<dyn ConnectionRepository>, focus: FocusId) -> ConnectionService {
        let svc = ConnectionService::new(repo.clone());
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "Claude"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "Cortex"),
        );
        svc
    }

    #[test]
    fn request_connection_retires_orphan_so_auto_allow_applies_after_restart() {
        let repo: Arc<dyn ConnectionRepository> = Arc::new(InMemoryConnectionRepository::new());
        let focus = focus_id(0x10);

        // Process 1, AlwaysAsk: the request pends and persists.
        let svc1 = restart_over(&repo, focus);
        let orphan_id = match svc1
            .request_connection(session_id(0x01), session_id(0x02), "r", "t0", "t10")
            .unwrap()
        {
            RequestOutcome::Pending { connection_id, .. } => connection_id,
            other => panic!("expected Pending, got {other:?}"),
        };

        // Process 2 (fresh in-memory map), now with auto-allow on. The orphan
        // from process 1 must not mask the policy.
        let svc2 = restart_over(&repo, focus);
        svc2.set_policy(ConnectionPolicy::AutoAllowFocus);
        let outcome = svc2
            .request_connection(session_id(0x01), session_id(0x02), "r2", "t1", "t11")
            .unwrap();
        assert!(
            matches!(outcome, RequestOutcome::Allowed { .. }),
            "auto-allow should apply once the orphan is retired, got {outcome:?}",
        );

        // The orphan was retired, not left dangling as Requested.
        let orphan = repo.get_connection(orphan_id).unwrap().unwrap();
        assert_eq!(orphan.status, ConnectionStatus::Denied);
    }

    #[test]
    fn request_connection_after_restart_creates_a_fresh_live_request() {
        let repo: Arc<dyn ConnectionRepository> = Arc::new(InMemoryConnectionRepository::new());
        let focus = focus_id(0x10);

        let svc1 = restart_over(&repo, focus);
        let orphan_request_id = match svc1
            .request_connection(session_id(0x01), session_id(0x02), "r", "t0", "t10")
            .unwrap()
        {
            RequestOutcome::Pending { request_id, .. } => request_id,
            other => panic!("expected Pending, got {other:?}"),
        };

        // Re-request under AlwaysAsk after "restart": a fresh, live request,
        // not the dead orphan id. This is what fixes the agent-visible bug where
        // wait_for_decision answered Unknown on a re-issued request.
        let svc2 = restart_over(&repo, focus);
        let request_id = match svc2
            .request_connection(session_id(0x01), session_id(0x02), "r2", "t1", "t11")
            .unwrap()
        {
            RequestOutcome::Pending { request_id, .. } => request_id,
            other => panic!("expected Pending, got {other:?}"),
        };
        assert_ne!(
            request_id, orphan_request_id,
            "re-request must mint a fresh request id, not reuse the orphan",
        );
        // The fresh request is live: pollable and listed for the banner.
        assert!(
            svc2.poll_decision(request_id).is_none(),
            "fresh request waits"
        );
        assert_eq!(svc2.list_pending_requests().unwrap().len(), 1);
    }

    #[test]
    fn request_connection_auto_allows_under_matching_policy() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "Claude"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "Cortex"),
        );
        svc.set_policy(ConnectionPolicy::AutoAllowFocus);

        let outcome = svc
            .request_connection(session_id(0x01), session_id(0x02), "r", "t0", "t10")
            .unwrap();
        let conn_id = match outcome {
            RequestOutcome::Allowed { connection_id } => connection_id,
            other => panic!("expected Allowed, got {other:?}"),
        };
        let conn = svc.get_connection(conn_id).unwrap().unwrap();
        assert!(conn.is_open());
    }

    #[test]
    fn request_connection_deduplicates_against_open_pair() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "Claude"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "Cortex"),
        );
        let first = svc
            .user_open(session_id(0x01), session_id(0x02), "r", "t0")
            .unwrap();

        let outcome = svc
            .request_connection(session_id(0x01), session_id(0x02), "r2", "t1", "t11")
            .unwrap();
        assert_eq!(
            outcome,
            RequestOutcome::AlreadyOpen {
                connection_id: first
            }
        );
    }

    #[test]
    fn request_connection_returns_existing_pending_for_same_pair() {
        // Phase-7 review fix: a second request_connection call before the
        // first decides must return the existing Pending rather than stack
        // a duplicate request.
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "C"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "X"),
        );

        let first = svc
            .request_connection(session_id(0x01), session_id(0x02), "r", "t0", "t10")
            .unwrap();
        let (conn_id, request_id) = match first {
            RequestOutcome::Pending {
                connection_id,
                request_id,
            } => (connection_id, request_id),
            other => panic!("expected Pending, got {other:?}"),
        };

        let second = svc
            .request_connection(session_id(0x01), session_id(0x02), "r-again", "t1", "t11")
            .unwrap();
        match second {
            RequestOutcome::Pending {
                connection_id,
                request_id: second_request_id,
            } => {
                assert_eq!(connection_id, conn_id, "same connection record returned");
                assert_eq!(
                    second_request_id, request_id,
                    "same request id returned, no duplicate registered"
                );
            }
            other => panic!("expected Pending dedupe, got {other:?}"),
        }
        assert_eq!(svc.list_pending_requests().unwrap().len(), 1);
    }

    #[test]
    fn list_messages_does_not_stamp_delivery() {
        // Phase-7 review fix: a UI panel reading the transcript must not
        // consume the agent-facing delivery signal.
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "C"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "X"),
        );
        let conn = svc
            .user_open(session_id(0x01), session_id(0x02), "r", "t0")
            .unwrap();
        svc.send_message(session_id(0x01), conn, "hello", "t1")
            .unwrap();
        let transcript = svc.list_messages(session_id(0x01), conn, 0).unwrap();
        assert_eq!(transcript.len(), 1);
        assert!(
            transcript[0].delivered_at.is_none(),
            "list_messages must not stamp delivered_at"
        );
        let inbound = svc
            .pending_messages(session_id(0x02), conn, 0, "t2")
            .unwrap();
        assert_eq!(inbound.len(), 1);
        assert_eq!(inbound[0].delivered_at.as_deref(), Some("t2"));
    }

    #[test]
    fn request_connection_rejects_self_request() {
        let svc = service();
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus_id(0x10), "F"), "C"),
        );
        let err = svc
            .request_connection(session_id(0x01), session_id(0x01), "r", "t0", "t10")
            .unwrap_err();
        assert!(err.to_string().contains("own session"));
    }

    #[test]
    fn accept_then_wait_unblocks_immediately() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "C"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "X"),
        );

        let RequestOutcome::Pending {
            request_id,
            connection_id,
        } = svc
            .request_connection(session_id(0x01), session_id(0x02), "r", "t0", "t10")
            .unwrap()
        else {
            panic!("expected pending");
        };

        svc.accept_request(request_id, DecisionBy::User, "t1")
            .unwrap();

        let outcome = svc.wait_for_decision(request_id, Duration::from_millis(50));
        assert_eq!(outcome, WaitOutcome::Allowed { connection_id });
    }

    #[test]
    fn waiter_unblocks_when_decision_arrives_concurrently() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "C"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "X"),
        );

        let RequestOutcome::Pending {
            request_id,
            connection_id,
        } = svc
            .request_connection(session_id(0x01), session_id(0x02), "r", "t0", "t10")
            .unwrap()
        else {
            panic!("expected pending");
        };

        let waiter = {
            let svc = Arc::clone(&svc);
            std::thread::spawn(move || svc.wait_for_decision(request_id, Duration::from_secs(2)))
        };
        // Give the waiter a moment to settle into wait_timeout.
        std::thread::sleep(Duration::from_millis(50));
        svc.accept_request(request_id, DecisionBy::User, "t1")
            .unwrap();

        let outcome = waiter.join().expect("waiter thread");
        assert_eq!(outcome, WaitOutcome::Allowed { connection_id });
    }

    #[test]
    fn waiter_times_out_when_no_decision_arrives() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "C"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "X"),
        );

        let RequestOutcome::Pending { request_id, .. } = svc
            .request_connection(session_id(0x01), session_id(0x02), "r", "t0", "t10")
            .unwrap()
        else {
            panic!("expected pending");
        };

        let outcome = svc.wait_for_decision(request_id, Duration::from_millis(50));
        assert_eq!(outcome, WaitOutcome::Timeout);

        // Poll afterwards still shows pending; not yet decided.
        assert!(svc.poll_decision(request_id).is_none());
    }

    #[test]
    fn deny_marks_connection_denied_and_unblocks_waiters() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "C"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "X"),
        );

        let RequestOutcome::Pending {
            request_id,
            connection_id,
        } = svc
            .request_connection(session_id(0x01), session_id(0x02), "r", "t0", "t10")
            .unwrap()
        else {
            panic!("expected pending");
        };

        svc.deny_request(request_id, DecisionBy::User, "t1", Some("not now".into()))
            .unwrap();

        let conn = svc.get_connection(connection_id).unwrap().unwrap();
        assert_eq!(conn.status, ConnectionStatus::Denied);
        assert_eq!(conn.reason_closed.as_deref(), Some("not now"));

        let outcome = svc.wait_for_decision(request_id, Duration::from_millis(10));
        assert_eq!(outcome, WaitOutcome::Denied);
    }

    #[test]
    fn double_accept_is_rejected() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "C"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "X"),
        );

        let RequestOutcome::Pending { request_id, .. } = svc
            .request_connection(session_id(0x01), session_id(0x02), "r", "t0", "t10")
            .unwrap()
        else {
            panic!("expected pending");
        };

        svc.accept_request(request_id, DecisionBy::User, "t1")
            .unwrap();
        let err = svc
            .accept_request(request_id, DecisionBy::User, "t2")
            .unwrap_err();
        assert!(err.to_string().contains("already been decided"));
    }

    #[test]
    fn send_and_receive_message_round_trip() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "C"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "X"),
        );
        let conn = svc
            .user_open(session_id(0x01), session_id(0x02), "r", "t0")
            .unwrap();

        let m1 = svc
            .send_message(session_id(0x01), conn, "hello", "t1")
            .unwrap();
        let m2 = svc
            .send_message(session_id(0x02), conn, "hi back", "t2")
            .unwrap();
        assert_ne!(m1, m2);

        // 0x02 receives only the message addressed to 0x02.
        let inbound_to_two = svc
            .pending_messages(session_id(0x02), conn, 0, "t3")
            .unwrap();
        assert_eq!(inbound_to_two.len(), 1);
        assert_eq!(inbound_to_two[0].body, "hello");
        assert_eq!(inbound_to_two[0].delivered_at.as_deref(), Some("t3"));

        // 0x01 receives the reply.
        let inbound_to_one = svc
            .pending_messages(session_id(0x01), conn, 0, "t4")
            .unwrap();
        assert_eq!(inbound_to_one.len(), 1);
        assert_eq!(inbound_to_one[0].body, "hi back");
    }

    #[test]
    fn pending_messages_with_since_skips_already_seen() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "C"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "X"),
        );
        let conn = svc
            .user_open(session_id(0x01), session_id(0x02), "r", "t0")
            .unwrap();
        svc.send_message(session_id(0x01), conn, "one", "t1")
            .unwrap();
        svc.send_message(session_id(0x01), conn, "two", "t2")
            .unwrap();

        let first_batch = svc
            .pending_messages(session_id(0x02), conn, 0, "t3")
            .unwrap();
        assert_eq!(first_batch.len(), 2);
        let last_seen = first_batch.last().unwrap().sequence;

        let second_batch = svc
            .pending_messages(session_id(0x02), conn, last_seen, "t4")
            .unwrap();
        assert!(second_batch.is_empty());

        svc.send_message(session_id(0x01), conn, "three", "t5")
            .unwrap();
        let third_batch = svc
            .pending_messages(session_id(0x02), conn, last_seen, "t6")
            .unwrap();
        assert_eq!(third_batch.len(), 1);
        assert_eq!(third_batch[0].body, "three");
    }

    #[test]
    fn send_message_rejects_non_participant() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "C"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "X"),
        );
        register(
            &svc,
            session_id(0x03),
            address(AgentKind::CodexCli, None, (focus, "F"), "Y"),
        );
        let conn = svc
            .user_open(session_id(0x01), session_id(0x02), "r", "t0")
            .unwrap();
        let err = svc
            .send_message(session_id(0x03), conn, "intrude", "t1")
            .unwrap_err();
        assert!(err.to_string().contains("not a participant"));
    }

    #[test]
    fn send_message_rejects_closed_connection() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "C"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "X"),
        );
        let conn = svc
            .user_open(session_id(0x01), session_id(0x02), "r", "t0")
            .unwrap();
        svc.close(ConnectionCaller::User, conn, "t1", None).unwrap();

        let err = svc
            .send_message(session_id(0x01), conn, "hi", "t2")
            .unwrap_err();
        assert!(err.to_string().contains("Closed"));
    }

    #[test]
    fn close_records_session_ended_for_participant_termination() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "C"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "X"),
        );
        let conn = svc
            .user_open(session_id(0x01), session_id(0x02), "r", "t0")
            .unwrap();

        svc.close(
            ConnectionCaller::SessionEnded(session_id(0x02)),
            conn,
            "t1",
            None,
        )
        .unwrap();

        let record = svc.get_connection(conn).unwrap().unwrap();
        assert_eq!(record.status, ConnectionStatus::Closed);
        assert!(matches!(
            record.closed_by,
            Some(ConnectionClosedBy::SessionEnded { .. })
        ));
    }

    #[test]
    fn close_by_non_participant_session_is_refused() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "C"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "X"),
        );
        let conn = svc
            .user_open(session_id(0x01), session_id(0x02), "r", "t0")
            .unwrap();
        let err = svc
            .close(
                ConnectionCaller::Session(session_id(0x03)),
                conn,
                "t1",
                None,
            )
            .unwrap_err();
        assert!(err.to_string().contains("not a participant"));
    }

    #[test]
    fn unregister_session_removes_from_peer_lookups() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "C"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "X"),
        );

        let before = svc.list_peers(session_id(0x01), PeerScope::Focus).unwrap();
        assert_eq!(before.len(), 1);

        svc.unregister_session(session_id(0x02));
        let after = svc.list_peers(session_id(0x01), PeerScope::Focus).unwrap();
        assert!(after.is_empty());
    }

    #[test]
    fn deny_marks_pair_as_recently_denied() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "C"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "X"),
        );
        let RequestOutcome::Pending { request_id, .. } = svc
            .request_connection(session_id(0x01), session_id(0x02), "r", "t0", "t10")
            .unwrap()
        else {
            panic!("expected pending");
        };
        // Before denial, the pair is not "recently denied".
        assert!(!svc.pair_recently_denied(session_id(0x01), session_id(0x02)));
        svc.deny_request(request_id, DecisionBy::User, "t1", None)
            .unwrap();
        // After denial, it is.
        assert!(svc.pair_recently_denied(session_id(0x01), session_id(0x02)));
        // And the reverse direction is independent.
        assert!(!svc.pair_recently_denied(session_id(0x02), session_id(0x01)));
    }

    #[test]
    fn focus_override_short_circuits_workspace_default_for_requests_in_that_focus() {
        let svc = service();
        // Workspace default is AlwaysAsk (set in ConnectionService::new).
        // But focus 0x10 has been overridden to AutoAllowFocus.
        let focus = focus_id(0x10);
        svc.set_focus_policy_override(focus, Some(ConnectionPolicy::AutoAllowFocus));

        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "A"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "B"),
        );

        // A request within the overridden focus auto-allows even though the
        // workspace default would have asked.
        let outcome = svc
            .request_connection(session_id(0x01), session_id(0x02), "r", "t0", "t10")
            .unwrap();
        assert!(matches!(outcome, RequestOutcome::Allowed { .. }));

        // Clearing the override restores the workspace default behaviour.
        svc.set_focus_policy_override(focus, None);
        register(
            &svc,
            session_id(0x03),
            address(AgentKind::CodexCli, None, (focus, "F"), "C"),
        );
        let outcome = svc
            .request_connection(session_id(0x01), session_id(0x03), "r2", "t2", "t12")
            .unwrap();
        assert!(matches!(outcome, RequestOutcome::Pending { .. }));
    }

    #[test]
    fn block_pair_short_circuits_request_connection() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "C"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "X"),
        );

        svc.block_pair_for(session_id(0x01), session_id(0x02), Duration::from_secs(600));

        let outcome = svc
            .request_connection(session_id(0x01), session_id(0x02), "r", "t0", "t10")
            .unwrap();
        match outcome {
            RequestOutcome::BlockedByPair {
                blocked_until_secs,
                reason,
            } => {
                assert!(blocked_until_secs <= 600);
                assert!(reason.contains("blocked by user"));
            }
            other => panic!("expected BlockedByPair, got {other:?}"),
        }

        // Clearing the block restores normal behaviour.
        svc.clear_pair_block(session_id(0x01), session_id(0x02));
        let outcome = svc
            .request_connection(session_id(0x01), session_id(0x02), "r", "t2", "t12")
            .unwrap();
        assert!(matches!(outcome, RequestOutcome::Pending { .. }));
    }

    #[test]
    fn user_open_refuses_duplicate_open_pair() {
        let svc = service();
        let focus = focus_id(0x10);
        register(
            &svc,
            session_id(0x01),
            address(AgentKind::ClaudeCode, None, (focus, "F"), "C"),
        );
        register(
            &svc,
            session_id(0x02),
            address(AgentKind::CortexCode, None, (focus, "F"), "X"),
        );
        svc.user_open(session_id(0x01), session_id(0x02), "r", "t0")
            .unwrap();
        let err = svc
            .user_open(session_id(0x01), session_id(0x02), "r", "t1")
            .unwrap_err();
        assert!(err.to_string().contains("already exists"));
    }
}
