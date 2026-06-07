//! Per-session merge of Codex's two activity sources into one coherent state.
//!
//! Codex is the only CLI Reverie observes through **two** sources at once: the
//! lifecycle hooks (Definitive: instant native-id capture, turn start/stop, the
//! approval gate) and the rollout-JSONL watcher (Inferred: rich tool detail, and
//! the `turn_aborted` edge the `Stop` hook misses on Esc/interrupt). Their
//! sequence counters are independent and incomparable, so writing both straight
//! into `latest_activity` (each guarded only by its own sequence) makes them
//! clobber each other. This reconciler is the single writer that resolves them.
//!
//! The merge is a small per-session **turn state machine** keyed by the native
//! session id (both sources carry it). Codex `turn_id`s are time-ordered
//! UUIDv7, so a lexicographic compare tells which turn is newer. Either source
//! may supply the start or end edge of a turn:
//!
//! - a turn is **running** once any source reports a start for it (and not yet an
//!   end), so a long silent turn never reads as idle (the cull-safety guarantee);
//! - a turn **ends** only when an end edge names *that* turn, so a late
//!   `task_complete` for turn N can't flip a newer `UserPromptSubmit` for N+1
//!   back to idle;
//! - the `turn_aborted` end edge from the rollout covers the Esc/interrupt case
//!   the `Stop` hook never fires for.
//!
//! Single-source CLIs (Claude hooks, Cortex snapshots) do not go through here:
//! they have no second source to fight, and the correlator keeps them on the
//! direct path.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::activity::{
    ActiveTool, ActivityError, ActivityState, ActivityStatus, ActivityTurn, PermissionRequest,
    TurnStatus,
};
use crate::activity_source::Fidelity;

const ACTIVITY_VERSION: u32 = 1;

/// Shared, in-memory merge state for every live Codex session, keyed by native
/// session id. Cheap: one small struct per session, dropped on removal.
#[derive(Default)]
pub struct ActivityReconciler {
    sessions: Mutex<HashMap<String, SessionMerge>>,
}

impl ActivityReconciler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold one source update into the session's merged state and return the
    /// reconciled snapshot to persist. The caller writes it through the workspace
    /// service; because this reconciler is the sole writer for a Codex session,
    /// its monotonic `sequence` makes the service's out-of-order guard a simple
    /// dedup again.
    pub fn merge(
        &self,
        native_session_id: &str,
        fidelity: Fidelity,
        incoming: &ActivityState,
    ) -> ActivityState {
        let mut guard = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
        let merge = guard.entry(native_session_id.to_owned()).or_default();
        merge.apply(native_session_id, fidelity, incoming);
        merge.snapshot()
    }

    /// Drop a session's merge state (its source was removed). Idempotent.
    pub fn forget(&self, native_session_id: &str) {
        self.sessions
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(native_session_id);
    }
}

/// The merge machine for one session.
#[derive(Default)]
struct SessionMerge {
    /// Newest turn we've seen a start for. `None` before the first turn (a fresh
    /// or just-resumed session sitting at the prompt).
    current_turn: Option<String>,
    /// Whether `current_turn` has ended. Meaningless when `current_turn` is None.
    turn_ended: bool,
    /// Whether the agent is blocked on an approval for the current turn. Sticky
    /// until forward progress (a later working edge) or the turn ends.
    permission_pending: bool,
    /// The approval detail, when a source provided one (the hook does; the
    /// rollout heuristic may not).
    permission: Option<PermissionRequest>,
    /// Whether the session is in an error state.
    errored: bool,
    last_error: Option<ActivityError>,
    /// Latest tool detail (enrichment), kept across sources, cleared on turn end.
    active_tools: Vec<ActiveTool>,
    native_id: String,
    cwd: String,
    updated_at: String,
    /// Reconciler-owned monotonic output sequence.
    sequence: u64,
}

impl SessionMerge {
    fn apply(&mut self, native_session_id: &str, _fidelity: Fidelity, incoming: &ActivityState) {
        self.native_id = native_session_id.to_owned();
        if !incoming.cwd.is_empty() {
            self.cwd = incoming.cwd.clone();
        }
        if !incoming.updated_at.is_empty() {
            self.updated_at = incoming.updated_at.clone();
        }
        // Tool detail is enrichment: keep the latest non-empty list, and let an
        // end edge clear it below.
        if !incoming.active_tools.is_empty() {
            self.active_tools = incoming.active_tools.clone();
        }

        let turn_id = incoming.turn.as_ref().map(|turn| turn.id.as_str());

        match incoming.status {
            ActivityStatus::Working => {
                self.errored = false;
                match turn_id {
                    // A start/continuation of the current or a newer turn.
                    Some(id) if self.is_current_or_newer(id) => {
                        self.start_turn(id);
                    }
                    // A stale working edge for an older turn: ignore it.
                    Some(_) => {}
                    // A turn-less working pulse: keep whatever turn we have live.
                    None => {
                        self.turn_ended = false;
                        // Forward progress clears a resolved approval gate.
                        self.clear_permission();
                    }
                }
            }
            // Codex never emits `Done` for an in-flight session, but treat it as
            // a clean end defensively.
            ActivityStatus::AwaitingInput | ActivityStatus::Done => match turn_id {
                // An end edge for the current/newer turn: the turn is over.
                Some(id) if self.is_current_or_newer(id) => {
                    self.current_turn = Some(id.to_owned());
                    self.end_turn();
                }
                // A stale end for an already-superseded turn: ignore.
                Some(_) => {}
                // Turn-less idle (e.g. SessionStart): a baseline only. Never end
                // a turn we already know is running on a turn-less idle.
                None => {
                    if self.current_turn.is_none() {
                        self.end_turn();
                    }
                }
            },
            ActivityStatus::AwaitingPermission | ActivityStatus::AwaitingResponse => {
                self.errored = false;
                match turn_id {
                    Some(id) if self.is_current_or_newer(id) => self.start_turn(id),
                    Some(_) => {}
                    None => self.turn_ended = false,
                }
                self.permission_pending = true;
                // Keep an existing detail if this edge didn't carry one.
                if incoming.awaiting_permission.is_some() {
                    self.permission = incoming.awaiting_permission.clone();
                }
            }
            ActivityStatus::Error => {
                self.errored = true;
                self.last_error = incoming.last_error.clone();
            }
        }

        self.sequence += 1;
    }

    /// Begin (or continue) turn `id` as the live turn.
    fn start_turn(&mut self, id: &str) {
        self.current_turn = Some(id.to_owned());
        self.turn_ended = false;
        // A working edge for the current/newer turn is forward progress, which
        // resolves any approval gate that was pending.
        self.clear_permission();
    }

    fn end_turn(&mut self) {
        self.turn_ended = true;
        self.clear_permission();
        self.active_tools.clear();
    }

    fn clear_permission(&mut self) {
        self.permission_pending = false;
        self.permission = None;
    }

    /// Whether `id` names the current turn or a newer one. turn_ids are
    /// time-ordered UUIDv7, so a lexicographic compare is a recency compare.
    fn is_current_or_newer(&self, id: &str) -> bool {
        match &self.current_turn {
            Some(current) => id >= current.as_str(),
            None => true,
        }
    }

    fn snapshot(&self) -> ActivityState {
        let status = if self.errored {
            ActivityStatus::Error
        } else if self.permission_pending {
            ActivityStatus::AwaitingPermission
        } else if self.current_turn.is_some() && !self.turn_ended {
            ActivityStatus::Working
        } else {
            ActivityStatus::AwaitingInput
        };

        let turn = self.current_turn.as_ref().map(|id| ActivityTurn {
            id: id.clone(),
            status: if self.turn_ended {
                TurnStatus::Completed
            } else {
                TurnStatus::Running
            },
            started_at: self.updated_at.clone(),
            ended_at: None,
        });

        ActivityState {
            version: ACTIVITY_VERSION,
            session_id: self.native_id.clone(),
            status,
            updated_at: self.updated_at.clone(),
            sequence: self.sequence,
            cwd: self.cwd.clone(),
            turn,
            active_tools: self.active_tools.clone(),
            awaiting_permission: self.permission.clone(),
            last_error: self.last_error.clone(),
            final_exit: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(status: ActivityStatus, turn_id: Option<&str>) -> ActivityState {
        ActivityState {
            version: 1,
            session_id: "native-1".to_owned(),
            status,
            updated_at: "t".to_owned(),
            sequence: 0,
            cwd: "/w".to_owned(),
            turn: turn_id.map(|id| ActivityTurn {
                id: id.to_owned(),
                status: TurnStatus::Running,
                started_at: "t".to_owned(),
                ended_at: None,
            }),
            active_tools: Vec::new(),
            awaiting_permission: None,
            last_error: None,
            final_exit: None,
        }
    }

    /// turn_ids in UUIDv7 lexicographic order (older < newer).
    const TURN_A: &str = "019ea000-0000-7000-8000-000000000001";
    const TURN_B: &str = "019ea001-0000-7000-8000-000000000002";

    #[test]
    fn working_then_idle_for_same_turn_goes_idle() {
        let r = ActivityReconciler::new();
        let s = r.merge(
            "native-1",
            Fidelity::Definitive,
            &state(ActivityStatus::Working, Some(TURN_A)),
        );
        assert_eq!(s.status, ActivityStatus::Working);
        let s = r.merge(
            "native-1",
            Fidelity::Definitive,
            &state(ActivityStatus::AwaitingInput, Some(TURN_A)),
        );
        assert_eq!(s.status, ActivityStatus::AwaitingInput);
    }

    #[test]
    fn stale_idle_for_older_turn_does_not_end_a_newer_working_turn() {
        // The exact cross-source race: the rollout's late `task_complete` for
        // turn A must not flip a newer hook `UserPromptSubmit` (turn B) to idle.
        let r = ActivityReconciler::new();
        r.merge(
            "native-1",
            Fidelity::Inferred,
            &state(ActivityStatus::Working, Some(TURN_A)),
        );
        // Newer turn B starts (hook).
        let s = r.merge(
            "native-1",
            Fidelity::Definitive,
            &state(ActivityStatus::Working, Some(TURN_B)),
        );
        assert_eq!(s.status, ActivityStatus::Working);
        // Stale end edge for the OLD turn A arrives late (rollout): ignored.
        let s = r.merge(
            "native-1",
            Fidelity::Inferred,
            &state(ActivityStatus::AwaitingInput, Some(TURN_A)),
        );
        assert_eq!(
            s.status,
            ActivityStatus::Working,
            "stale end of turn A must not idle turn B"
        );
        // The real end of turn B does end it.
        let s = r.merge(
            "native-1",
            Fidelity::Definitive,
            &state(ActivityStatus::AwaitingInput, Some(TURN_B)),
        );
        assert_eq!(s.status, ActivityStatus::AwaitingInput);
    }

    #[test]
    fn rollout_abort_backstops_the_stop_hook_miss() {
        // Hook reports the turn started but (Esc) never sends Stop; the rollout's
        // turn_aborted (same turn) must still end it.
        let r = ActivityReconciler::new();
        r.merge(
            "native-1",
            Fidelity::Definitive,
            &state(ActivityStatus::Working, Some(TURN_A)),
        );
        let s = r.merge(
            "native-1",
            Fidelity::Inferred,
            &state(ActivityStatus::AwaitingInput, Some(TURN_A)),
        );
        assert_eq!(s.status, ActivityStatus::AwaitingInput);
    }

    #[test]
    fn permission_is_sticky_then_cleared_by_forward_progress() {
        let r = ActivityReconciler::new();
        r.merge(
            "native-1",
            Fidelity::Definitive,
            &state(ActivityStatus::Working, Some(TURN_A)),
        );
        let mut perm = state(ActivityStatus::AwaitingPermission, Some(TURN_A));
        perm.awaiting_permission = Some(PermissionRequest {
            id: "c1".to_owned(),
            tool_name: "shell".to_owned(),
            display_summary: "Run shell: npm i".to_owned(),
            args: None,
            requested_at: "t".to_owned(),
        });
        let s = r.merge("native-1", Fidelity::Inferred, &perm);
        assert_eq!(s.status, ActivityStatus::AwaitingPermission);
        assert!(s.awaiting_permission.is_some());
        // The tool runs (forward progress on the same turn) -> back to working.
        let s = r.merge(
            "native-1",
            Fidelity::Inferred,
            &state(ActivityStatus::Working, Some(TURN_A)),
        );
        assert_eq!(s.status, ActivityStatus::Working);
        assert!(s.awaiting_permission.is_none());
    }

    #[test]
    fn session_start_idle_baseline_then_first_turn() {
        let r = ActivityReconciler::new();
        // SessionStart: idle, no turn.
        let s = r.merge(
            "native-1",
            Fidelity::Definitive,
            &state(ActivityStatus::AwaitingInput, None),
        );
        assert_eq!(s.status, ActivityStatus::AwaitingInput);
        assert!(s.turn.is_none());
        // First prompt starts a turn.
        let s = r.merge(
            "native-1",
            Fidelity::Definitive,
            &state(ActivityStatus::Working, Some(TURN_A)),
        );
        assert_eq!(s.status, ActivityStatus::Working);
        assert_eq!(s.turn.unwrap().id, TURN_A);
    }

    #[test]
    fn output_sequence_is_monotonic() {
        let r = ActivityReconciler::new();
        let a = r.merge(
            "native-1",
            Fidelity::Definitive,
            &state(ActivityStatus::Working, Some(TURN_A)),
        );
        let b = r.merge(
            "native-1",
            Fidelity::Inferred,
            &state(ActivityStatus::Working, Some(TURN_A)),
        );
        let c = r.merge(
            "native-1",
            Fidelity::Definitive,
            &state(ActivityStatus::AwaitingInput, Some(TURN_A)),
        );
        assert!(b.sequence > a.sequence && c.sequence > b.sequence);
    }

    #[test]
    fn forget_resets_a_session() {
        let r = ActivityReconciler::new();
        r.merge(
            "native-1",
            Fidelity::Definitive,
            &state(ActivityStatus::Working, Some(TURN_A)),
        );
        r.forget("native-1");
        // Fresh start after forget: a turn-less idle reads idle, not a stale working.
        let s = r.merge(
            "native-1",
            Fidelity::Definitive,
            &state(ActivityStatus::AwaitingInput, None),
        );
        assert_eq!(s.status, ActivityStatus::AwaitingInput);
        assert_eq!(s.sequence, 1, "sequence restarts after forget");
    }
}
