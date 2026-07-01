//! Managed Tauri state shared across the command handlers and activity bridges.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use reverie_core::WorkspaceService;
use reverie_core::domain::SessionId;
use reverie_core::hook_server::HookSource;

/// Always-managed holder for the [`WorkspaceService`], filled by `setup` only
/// after the database has been opened, migrated, and seeded.
///
/// The startup load command (`workspace_shell`) reads the service through this
/// holder instead of taking `State<WorkspaceService>` directly. That matters
/// because the webview can fire its first `workspace_shell` invoke before
/// `setup` finishes managing + seeding the service: a direct `State` extraction
/// would then fail with Tauri's hard "state not managed" error, which the
/// frontend used to swallow into a permanently empty workspace. Routing through
/// a holder that is managed from the very start lets the command return a
/// distinguishable, retryable "still starting" signal until the service is
/// ready, and guarantees that a successful read always sees a seeded database.
#[derive(Default, Clone)]
pub(crate) struct WorkspaceBoot(Arc<OnceLock<WorkspaceService>>);

impl WorkspaceBoot {
    /// Install the service once `setup` has finished opening + seeding the
    /// database. Idempotent: a second call is ignored.
    pub(crate) fn set(&self, service: WorkspaceService) {
        let _ = self.0.set(service);
    }

    /// The seeded service, or `None` while the backend is still starting up.
    pub(crate) fn get(&self) -> Option<&WorkspaceService> {
        self.0.get()
    }
}

/// Managed Tauri state holding the bound port of the hook HTTP server. The
/// session launch path reads this to write per-session Claude/Codex configs
/// that point at `http://127.0.0.1:<port>/hooks/<cli>/<token>`.
#[derive(Clone, Debug)]
pub(crate) struct HookServerInfo {
    pub(crate) port: u16,
}

/// Tracks the (cli, token) Reverie minted for each launched session so the
/// terminate / remove paths can revoke the right authorization. Without this,
/// a token issued in a previous launch would stay valid forever and let a
/// stale CLI process keep pushing state.
#[derive(Default)]
pub(crate) struct HookTokenRegistry {
    sessions: Mutex<HashMap<SessionId, (HookSource, String)>>,
}

impl HookTokenRegistry {
    /// Record the token minted for a session at launch, returning any prior
    /// entry. Used by the per-session Claude hook attach path in `start_session`
    /// (relaunch revokes the returned prior token).
    pub(crate) fn replace(
        &self,
        session_id: SessionId,
        source: HookSource,
        token: String,
    ) -> Option<(HookSource, String)> {
        let mut guard = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
        guard.insert(session_id, (source, token))
    }

    pub(crate) fn take(&self, session_id: SessionId) -> Option<(HookSource, String)> {
        let mut guard = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
        guard.remove(&session_id)
    }
}

/// Tracks whether the deliberate quit sequence has begun. The window-close and
/// app-exit handlers prevent the default the first time and route the quit
/// through the frontend (so it can confirm in-flight agent work) and then the
/// `confirm_quit` command, which gracefully stops every session and re-issues
/// the exit. This flag lets that re-issued exit pass straight through instead
/// of being deferred again.
#[derive(Default)]
pub(crate) struct ShutdownState {
    started: AtomicBool,
}

impl ShutdownState {
    /// Mark the deliberate shutdown as begun, returning the previous value.
    pub(crate) fn begin(&self) -> bool {
        self.started.swap(true, Ordering::SeqCst)
    }

    pub(crate) fn is_started(&self) -> bool {
        self.started.load(Ordering::SeqCst)
    }
}

/// Native-side liveness marker for the main WKWebView. The frontend records a
/// cheap heartbeat while it is alive; focus/resume handlers use the timestamp to
/// detect a web content process that exists from AppKit's point of view but no
/// longer runs JavaScript.
#[derive(Default)]
pub(crate) struct WebviewHealth {
    last_heartbeat_ms: AtomicI64,
    last_reload_ms: AtomicI64,
}

impl WebviewHealth {
    pub(crate) fn mark_heartbeat(&self) {
        self.last_heartbeat_ms
            .store(unix_time_millis(), Ordering::SeqCst);
    }

    pub(crate) fn last_heartbeat_ms(&self) -> i64 {
        self.last_heartbeat_ms.load(Ordering::SeqCst)
    }

    pub(crate) fn claim_reload(&self, now_ms: i64, cooldown_ms: i64) -> bool {
        let last = self.last_reload_ms.load(Ordering::SeqCst);
        if last > 0 && now_ms.saturating_sub(last) < cooldown_ms {
            return false;
        }
        self.last_reload_ms
            .compare_exchange(last, now_ms, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}

pub(crate) fn unix_time_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}
