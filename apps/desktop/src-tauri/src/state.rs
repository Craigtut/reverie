//! Managed Tauri state shared across the command handlers and activity bridges.

use std::collections::HashMap;
use std::sync::Mutex;

use reverie_core::domain::SessionId;
use reverie_core::hook_server::HookSource;

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
    /// entry. Used by the per-session hook-config injection path.
    #[allow(dead_code)] // wired by the in-flight per-session hook-config work
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
