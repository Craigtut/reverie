//! Orders Codex hook and rollout observations before any consumer sees them.
//! Turn ids are opaque. Retired turns, source cursors, and the launch boundary
//! prevent delayed history from replacing current work. A completed turn cannot
//! be reopened by a later snapshot of that same turn.

use crate::activity::{ActivityState, ActivityStatus, TurnStatus};
use crate::activity_source::Fidelity;
use crate::time::iso8601_to_epoch_millis;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

#[derive(Default)]
pub struct ActivityReconciler {
    sessions: Mutex<HashMap<String, SessionMerge>>,
}

impl ActivityReconciler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn merge(
        &self,
        native: &str,
        fidelity: Fidelity,
        incoming: &ActivityState,
    ) -> ActivityState {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let merge = sessions.entry(native.to_owned()).or_default();
        merge.apply(fidelity, incoming);
        merge
            .state
            .clone()
            .expect("first observation establishes state")
    }

    /// A new process starts at its prompt. History before this boundary can
    /// enrich neither the current turn nor the completion timestamp.
    pub fn begin_run(&self, state: &ActivityState) {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                state.session_id.clone(),
                SessionMerge {
                    state: Some(state.clone()),
                    launched_at: iso8601_to_epoch_millis(&state.updated_at),
                    ..SessionMerge::default()
                },
            );
    }

    pub fn forget(&self, native: &str) {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(native);
    }
}

#[derive(Default)]
struct SessionMerge {
    state: Option<ActivityState>,
    launched_at: Option<i64>,
    cursors: [Option<(i64, u64)>; 3],
    retired: HashSet<String>,
    retirement_order: VecDeque<String>,
    goal_active: bool,
    permission_fidelity: Option<Fidelity>,
}

fn at_rest(state: &ActivityState) -> bool {
    matches!(
        state.status,
        ActivityStatus::Idle | ActivityStatus::AwaitingInput | ActivityStatus::Done
    )
}

impl SessionMerge {
    fn retire(&mut self, id: &str) {
        if self.retired.insert(id.to_owned()) {
            self.retirement_order.push_back(id.to_owned());
        }
        // Older history is also excluded by source cursors and turn start time.
        while self.retirement_order.len() > 128 {
            if let Some(old) = self.retirement_order.pop_front() {
                self.retired.remove(&old);
            }
        }
    }

    fn apply(&mut self, fidelity: Fidelity, incoming: &ActivityState) {
        let timestamp = iso8601_to_epoch_millis(&incoming.updated_at);
        if let Some(at) = timestamp {
            if self.launched_at.is_some_and(|start| at < start) {
                return;
            }
            let cursor = &mut self.cursors[fidelity as usize];
            if cursor
                .is_some_and(|(time, seq)| at < time || (at == time && incoming.sequence < seq))
            {
                return;
            }
        }
        let Some(previous) = self.state.clone() else {
            let mut first = incoming.clone();
            first.sequence = 1;
            self.permission_fidelity = first.awaiting_permission.as_ref().map(|_| fidelity);
            self.goal_active = fidelity == Fidelity::Inferred
                && first.status == ActivityStatus::Working
                && first
                    .turn
                    .as_ref()
                    .is_some_and(|t| t.status == TurnStatus::Completed);
            if let Some(at) = timestamp {
                self.cursors[fidelity as usize] = Some((at, incoming.sequence));
            }
            self.state = Some(first);
            return;
        };
        // A folded completed task that is still working represents an active
        // goal between automatic turns. Its liveness is independent of notify.
        let goal_continuation = fidelity == Fidelity::Inferred
            && incoming.status == ActivityStatus::Working
            && incoming
                .turn
                .as_ref()
                .is_some_and(|turn| turn.status == TurnStatus::Completed);
        let old_turn = previous.turn.as_ref();
        let new_turn = incoming.turn.as_ref();
        let same_turn = old_turn.zip(new_turn).is_some_and(|(a, b)| a.id == b.id);
        if let Some(turn) = new_turn {
            if self.retired.contains(&turn.id) {
                return;
            }
            if same_turn && at_rest(&previous) && !at_rest(incoming) && !goal_continuation {
                return;
            }
            if !same_turn {
                if let Some(old) = old_turn {
                    let newer = iso8601_to_epoch_millis(&turn.started_at)
                        .zip(iso8601_to_epoch_millis(&old.started_at))
                        .map(|(new, old)| new > old);
                    if newer == Some(false) && turn.started_at != old.started_at {
                        return;
                    }
                    // An end for another turn cannot end known live work unless
                    // its start time proves that it is a later turn.
                    if at_rest(incoming)
                        && !at_rest(&previous)
                        && (newer != Some(true) || fidelity == Fidelity::Definitive)
                    {
                        return;
                    }
                }
            }
        } else if at_rest(incoming) && !at_rest(&previous) {
            // SessionStart has no turn. Explicit begin_run owns process resets.
            return;
        }
        if same_turn && at_rest(&previous) && at_rest(incoming) {
            // Duplicate completion, including notify after the log: keep the
            // original completion time so a viewed result never becomes unseen.
            return;
        }
        if fidelity == Fidelity::Inferred
            && (same_turn || new_turn.is_none())
            && matches!(
                previous.status,
                ActivityStatus::AwaitingPermission | ActivityStatus::AwaitingResponse
            )
            && incoming.status == ActivityStatus::Working
            && timestamp
                .zip(iso8601_to_epoch_millis(&previous.updated_at))
                .is_some_and(|(a, b)| a <= b)
        {
            return;
        }

        if !same_turn && new_turn.is_some() {
            if let Some(old) = old_turn {
                self.retire(&old.id);
            }
        }
        if fidelity == Fidelity::Inferred && at_rest(incoming) {
            self.goal_active = false;
        }
        if goal_continuation {
            self.goal_active = true;
        }
        if let Some(at) = timestamp {
            self.cursors[fidelity as usize] = Some((at, incoming.sequence));
        }
        let mut next = incoming.clone();
        if self.goal_active
            && fidelity == Fidelity::Definitive
            && next.status == ActivityStatus::AwaitingInput
        {
            next.status = ActivityStatus::Working;
        }
        if new_turn.is_none() && !at_rest(&next) {
            next.turn = previous.turn.clone();
        }
        next.sequence = previous.sequence + 1;
        if next.cwd.is_empty() {
            next.cwd = previous.cwd.clone();
        }
        if next.status == ActivityStatus::AwaitingPermission {
            // Inferred escalation detail must not replace the hook request id
            // used by the live Approve/Deny card.
            let keep_detail = same_turn
                && previous.status == ActivityStatus::AwaitingPermission
                && (next.awaiting_permission.is_none()
                    || self
                        .permission_fidelity
                        .is_some_and(|known| known > fidelity));
            if keep_detail {
                next.awaiting_permission = previous.awaiting_permission.clone();
            } else {
                self.permission_fidelity = next.awaiting_permission.as_ref().map(|_| fidelity);
            }
        } else {
            self.permission_fidelity = None;
        }
        // The accepted sequence is global; its publication clock cannot move
        // backwards when a valid completion was flushed late by a file source.
        if timestamp
            .zip(iso8601_to_epoch_millis(&previous.updated_at))
            .is_some_and(|(a, b)| a < b)
        {
            next.updated_at = previous.updated_at.clone();
        }
        if same_turn {
            if let (Some(turn), Some(old)) = (&mut next.turn, old_turn) {
                turn.started_at = old.started_at.clone();
            }
        }
        if at_rest(&next) {
            next.active_tools.clear();
            next.awaiting_permission = None;
            if let Some(turn) = &mut next.turn {
                if turn.status == TurnStatus::Running {
                    turn.status = TurnStatus::Completed;
                }
                turn.ended_at
                    .get_or_insert_with(|| incoming.updated_at.clone());
            }
        } else if fidelity == Fidelity::Definitive && same_turn && next.active_tools.is_empty() {
            // Hooks provide edges; the rollout owns the full active-tool set,
            // including an empty set when a tool finishes.
            next.active_tools = previous.active_tools;
        }
        self.state = Some(next);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::{ActivityTurn, PermissionRequest};

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

    /// Representative UUIDv7 turn ids used by most fixtures.
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
    fn mixed_uuid_versions_do_not_strand_a_new_turn_as_idle() {
        // Goal continuations can use an opaque UUIDv4 id followed by a UUIDv7
        // id that sorts lower. Arrival plus exact-id end matching, not lexical
        // ordering, determines the live turn.
        let random_v4 = "f7d9725a-4714-4b10-8518-cacf4b39252e";
        let later_v7 = "019ea001-0000-7000-8000-000000000002";
        let r = ActivityReconciler::new();
        r.merge(
            "native-1",
            Fidelity::Inferred,
            &state(ActivityStatus::AwaitingInput, Some(random_v4)),
        );
        let s = r.merge(
            "native-1",
            Fidelity::Definitive,
            &state(ActivityStatus::Working, Some(later_v7)),
        );
        assert_eq!(s.status, ActivityStatus::Working);
        assert_eq!(s.turn.as_ref().map(|turn| turn.id.as_str()), Some(later_v7));
    }

    #[test]
    fn inferred_tail_cannot_reopen_a_definitively_completed_turn() {
        let r = ActivityReconciler::new();
        r.merge(
            "native-1",
            Fidelity::Definitive,
            &state(ActivityStatus::Working, Some(TURN_A)),
        );
        let s = r.merge(
            "native-1",
            Fidelity::Definitive,
            &state(ActivityStatus::AwaitingInput, Some(TURN_A)),
        );
        assert_eq!(s.status, ActivityStatus::AwaitingInput);

        let s = r.merge(
            "native-1",
            Fidelity::Inferred,
            &state(ActivityStatus::Working, Some(TURN_A)),
        );
        assert_eq!(s.status, ActivityStatus::AwaitingInput);
    }

    #[test]
    fn rollout_abort_ends_the_interrupted_turn() {
        // The clean completion notifier may not fire after Esc. The rollout's
        // explicit turn_aborted edge for the same turn still ends it.
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
    fn timed(status: ActivityStatus, id: Option<&str>, started: u8, updated: u8) -> ActivityState {
        let mut s = state(status, id);
        s.updated_at = format!("2026-10-10T12:00:{updated:02}.000Z");
        if let Some(turn) = &mut s.turn {
            turn.started_at = format!("2026-10-10T12:00:{started:02}.000Z");
        }
        s
    }

    #[test]
    fn delayed_start_for_retired_turn_cannot_steal_current_turn() {
        let r = ActivityReconciler::new();
        r.merge(
            "native-1",
            Fidelity::Inferred,
            &timed(ActivityStatus::Working, Some(TURN_A), 1, 1),
        );
        r.merge(
            "native-1",
            Fidelity::Definitive,
            &timed(ActivityStatus::Working, Some(TURN_B), 2, 2),
        );
        let late = r.merge(
            "native-1",
            Fidelity::Inferred,
            &timed(ActivityStatus::Working, Some(TURN_A), 1, 3),
        );
        assert_eq!(late.turn.unwrap().id, TURN_B);
        let done = r.merge(
            "native-1",
            Fidelity::Inferred,
            &timed(ActivityStatus::AwaitingInput, Some(TURN_B), 2, 4),
        );
        assert_eq!(done.status, ActivityStatus::AwaitingInput);
        assert_eq!(
            done.turn.unwrap().ended_at.as_deref(),
            Some("2026-10-10T12:00:04.000Z")
        );
    }

    #[test]
    fn resume_discards_old_activity_and_allows_the_first_new_prompt() {
        let r = ActivityReconciler::new();
        r.merge(
            "native-1",
            Fidelity::Definitive,
            &timed(ActivityStatus::Working, Some(TURN_A), 1, 1),
        );
        r.begin_run(&timed(ActivityStatus::Idle, None, 3, 3));
        let replay = r.merge(
            "native-1",
            Fidelity::Inferred,
            &timed(ActivityStatus::Working, Some(TURN_A), 1, 2),
        );
        assert_eq!(replay.status, ActivityStatus::Idle);
        let working = r.merge(
            "native-1",
            Fidelity::Definitive,
            &timed(ActivityStatus::Working, Some(TURN_B), 4, 4),
        );
        assert_eq!(working.status, ActivityStatus::Working);
    }

    #[test]
    fn user_question_remains_distinct_from_tool_permission() {
        let r = ActivityReconciler::new();
        r.merge(
            "native-1",
            Fidelity::Definitive,
            &timed(ActivityStatus::Working, Some(TURN_A), 1, 1),
        );
        let question = r.merge(
            "native-1",
            Fidelity::Inferred,
            &timed(ActivityStatus::AwaitingResponse, Some(TURN_A), 1, 2),
        );
        assert_eq!(question.status, ActivityStatus::AwaitingResponse);
        assert!(question.awaiting_permission.is_none());
    }

    #[test]
    fn duplicate_notify_preserves_completion_time_and_sequence() {
        let r = ActivityReconciler::new();
        r.merge(
            "native-1",
            Fidelity::Definitive,
            &timed(ActivityStatus::Working, Some(TURN_A), 1, 1),
        );
        let first = r.merge(
            "native-1",
            Fidelity::Inferred,
            &timed(ActivityStatus::AwaitingInput, Some(TURN_A), 1, 2),
        );
        let duplicate = r.merge(
            "native-1",
            Fidelity::Definitive,
            &timed(ActivityStatus::AwaitingInput, Some(TURN_A), 3, 3),
        );
        assert_eq!(duplicate, first);
    }

    #[test]
    fn turnless_compaction_keeps_turn_identity_for_its_completion() {
        let r = ActivityReconciler::new();
        r.merge(
            "native-1",
            Fidelity::Definitive,
            &timed(ActivityStatus::Working, Some(TURN_A), 1, 1),
        );
        let compact = r.merge(
            "native-1",
            Fidelity::Definitive,
            &timed(ActivityStatus::Working, None, 2, 2),
        );
        assert_eq!(compact.turn.as_ref().unwrap().id, TURN_A);
        let done = r.merge(
            "native-1",
            Fidelity::Inferred,
            &timed(ActivityStatus::AwaitingInput, Some(TURN_A), 1, 3),
        );
        assert_eq!(done.status, ActivityStatus::AwaitingInput);
    }

    #[test]
    fn active_goal_continuation_survives_notify_until_terminal_goal_update() {
        let r = ActivityReconciler::new();
        r.merge(
            "native-1",
            Fidelity::Definitive,
            &timed(ActivityStatus::Working, Some(TURN_A), 1, 1),
        );
        let mut continuation = timed(ActivityStatus::Working, Some(TURN_A), 1, 2);
        continuation.turn.as_mut().unwrap().status = TurnStatus::Completed;
        r.merge("native-1", Fidelity::Inferred, &continuation);
        let notify = r.merge(
            "native-1",
            Fidelity::Definitive,
            &timed(ActivityStatus::AwaitingInput, Some(TURN_A), 3, 3),
        );
        assert_eq!(notify.status, ActivityStatus::Working);
        let done = r.merge(
            "native-1",
            Fidelity::Inferred,
            &timed(ActivityStatus::AwaitingInput, Some(TURN_A), 1, 4),
        );
        assert_eq!(done.status, ActivityStatus::AwaitingInput);
    }
    #[test]
    fn inferred_permission_detail_cannot_replace_a_live_hook_approval_id() {
        let r = ActivityReconciler::new();
        let mut hook = timed(ActivityStatus::AwaitingPermission, Some(TURN_A), 1, 2);
        hook.awaiting_permission = Some(PermissionRequest {
            id: "hook-request".into(),
            tool_name: "shell".into(),
            display_summary: "Run tests".into(),
            args: None,
            requested_at: hook.updated_at.clone(),
        });
        r.merge("native-1", Fidelity::Definitive, &hook);
        let mut inferred = hook.clone();
        inferred.updated_at = "2026-10-10T12:00:03.000Z".into();
        inferred.awaiting_permission.as_mut().unwrap().id = "rollout-call".into();
        let merged = r.merge("native-1", Fidelity::Inferred, &inferred);
        assert_eq!(merged.awaiting_permission.unwrap().id, "hook-request");
    }
}
