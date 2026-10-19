//! Liveness and recovery for the main WKWebView.
//!
//! The frontend sends a cheap heartbeat while its JavaScript runs. When the
//! window regains focus or the app resumes, `recovery` checks that the page
//! answered. If it did not, `probe` asks the page which layer stopped working
//! (JavaScript, visibility, IPC, or frame production), and recovery acts on that
//! answer instead of reloading blindly. Every decision lands in the bounded
//! `log`, so a production black-window report carries its own diagnosis.

mod log;
mod probe;
mod recovery;

use std::sync::atomic::{AtomicI64, Ordering};

pub(crate) use log::record;
pub(crate) use recovery::{on_content_process_terminated, schedule_recovery_check};

use crate::state::unix_time_millis;

/// Native-side liveness marker for the main WKWebView. The frontend records a
/// cheap heartbeat while it is alive; focus/resume handlers use the timestamp to
/// detect a web content process that exists from AppKit's point of view but no
/// longer runs JavaScript.
#[derive(Default)]
pub(crate) struct WebviewHealth {
    last_heartbeat_ms: AtomicI64,
    last_recovery_ms: AtomicI64,
}

impl WebviewHealth {
    pub(crate) fn mark_heartbeat(&self) {
        self.last_heartbeat_ms
            .store(unix_time_millis(), Ordering::SeqCst);
    }

    pub(crate) fn last_heartbeat_ms(&self) -> i64 {
        self.last_heartbeat_ms.load(Ordering::SeqCst)
    }

    /// Claim the right to run a recovery action, at most once per `cooldown_ms`,
    /// so overlapping focus/resume checks never stack reloads or restarts.
    pub(crate) fn claim_recovery(&self, now_ms: i64, cooldown_ms: i64) -> bool {
        let last = self.last_recovery_ms.load(Ordering::SeqCst);
        if last > 0 && now_ms.saturating_sub(last) < cooldown_ms {
            return false;
        }
        self.last_recovery_ms
            .compare_exchange(last, now_ms, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_claims_respect_the_cooldown() {
        let health = WebviewHealth::default();
        assert!(health.claim_recovery(1_000, 30_000));
        assert!(!health.claim_recovery(20_000, 30_000));
        assert!(health.claim_recovery(31_000, 30_000));
    }
}
