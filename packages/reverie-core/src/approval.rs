//! In-memory rendezvous for native tool-permission approvals.
//!
//! When a CLI (Claude Code, Codex) is about to run a tool that needs the user's
//! permission, its hook POSTs to Reverie's [`crate::hook_server`] and **blocks**
//! on the HTTP response. The hook server thread parks that request here, in
//! [`ApprovalRegistry::wait`], keyed by the Reverie session and the per-session
//! permission id. When the user clicks Approve / Deny on the native card, a Tauri
//! command calls [`ApprovalRegistry::resolve`], which hands the decision back to
//! the waiting hook so the CLI proceeds without ever drawing its own in-TUI
//! prompt.
//!
//! Deny-safe by omission: if no decision arrives before the timeout,
//! [`ApprovalRegistry::wait`] returns `None` and the caller replies with no
//! decision, so the CLI falls back to its own permission prompt. We never strand
//! a blocked agent.
//!
//! This mirrors the connection bridge's `wait_for_decision` long-poll, but the
//! lifecycle is simpler: a permission decision is one-shot (no "decided state
//! persists for a later re-query"), so a oneshot channel per request is enough.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::mpsc::{self, Sender};
use std::time::Duration;

use crate::domain::SessionId;

/// The user's answer to a tool-permission request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalDecision {
    Allow,
    Deny,
}

/// What a CLI adapter can do when its agent blocks on a tool-permission request.
/// Capability-tiered per the approval-cards design: a new harness plugs in at
/// whatever tier it supports and the card degrades honestly. See
/// `docs/product/core-experience/approval-cards.md`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalCapability {
    /// The request is intercepted and Approve/Deny on the card routes a decision
    /// back that short-circuits the CLI's own prompt. The target tier.
    AnswerFromCard,
    /// We can detect "blocked on approval" and signpost it, but cannot answer
    /// externally; the user answers in the TUI.
    Signpost,
    /// No integration: the session simply shows as blocked and the user opens it.
    None,
}

/// Identifies one pending request: the Reverie session plus the per-session
/// permission id the hook server minted (`perm-<sequence>`), which also rides to
/// the frontend on `awaitingPermission.id` so the card can name it back.
pub type ApprovalKey = (SessionId, String);

/// Rendezvous between a blocked CLI hook and the user's Approve/Deny click.
#[derive(Default)]
pub struct ApprovalRegistry {
    pending: Mutex<HashMap<ApprovalKey, Sender<ApprovalDecision>>>,
}

impl ApprovalRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `key` and block up to `timeout` for the user's decision. Returns
    /// `None` on timeout so the caller can fall through to the CLI's own prompt.
    /// Each call installs a fresh channel: a re-fired request for the same key
    /// simply replaces the prior waiter (which then times out harmlessly).
    pub fn wait(&self, key: ApprovalKey, timeout: Duration) -> Option<ApprovalDecision> {
        let (tx, rx) = mpsc::channel();
        {
            let mut guard = self.pending.lock().unwrap_or_else(|err| err.into_inner());
            guard.insert(key.clone(), tx);
        }
        let outcome = rx.recv_timeout(timeout).ok();
        let mut guard = self.pending.lock().unwrap_or_else(|err| err.into_inner());
        guard.remove(&key);
        outcome
    }

    /// Hand a decision to a waiting request. Returns `true` iff a live waiter was
    /// signalled. `false` means nothing was waiting: the request already timed
    /// out, was already answered, or the session answers over a different channel
    /// (e.g. Cortex's decision file), in which case the caller routes elsewhere.
    pub fn resolve(&self, key: &ApprovalKey, decision: ApprovalDecision) -> bool {
        let guard = self.pending.lock().unwrap_or_else(|err| err.into_inner());
        match guard.get(key) {
            Some(tx) => tx.send(decision).is_ok(),
            None => false,
        }
    }

    /// Whether a request for `key` is currently parked, waiting on the user.
    pub fn is_pending(&self, key: &ApprovalKey) -> bool {
        let guard = self.pending.lock().unwrap_or_else(|err| err.into_inner());
        guard.contains_key(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    fn session() -> SessionId {
        uuid::Uuid::new_v4()
    }

    #[test]
    fn resolve_hands_the_decision_to_a_waiter() {
        let registry = Arc::new(ApprovalRegistry::new());
        let key = (session(), "perm-1".to_owned());

        let waiter = {
            let registry = Arc::clone(&registry);
            let key = key.clone();
            thread::spawn(move || registry.wait(key, Duration::from_secs(5)))
        };

        // Spin until the waiter has registered, then resolve.
        while !registry.is_pending(&key) {
            thread::yield_now();
        }
        assert!(registry.resolve(&key, ApprovalDecision::Allow));

        assert_eq!(waiter.join().unwrap(), Some(ApprovalDecision::Allow));
        // The key is cleared once the waiter returns.
        assert!(!registry.is_pending(&key));
    }

    #[test]
    fn wait_times_out_to_none_when_no_decision_arrives() {
        let registry = ApprovalRegistry::new();
        let key = (session(), "perm-1".to_owned());
        assert_eq!(registry.wait(key, Duration::from_millis(20)), None);
    }

    #[test]
    fn resolve_is_false_when_nothing_is_waiting() {
        let registry = ApprovalRegistry::new();
        let key = (session(), "perm-7".to_owned());
        assert!(!registry.resolve(&key, ApprovalDecision::Deny));
    }
}
