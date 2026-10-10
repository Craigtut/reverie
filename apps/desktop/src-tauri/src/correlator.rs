//! The activity-ingestion spine on the shell side.
//!
//! Every transport (the Cortex/Codex file watchers and the Claude/Codex hook
//! HTTP server) produces the same [`ActivityUpdate`]; this is the single place
//! that consumes it. [`correlate`] binds the update to its Reverie session,
//! persists it through the [`WorkspaceService`], and emits the frontend events.
//! Adding a new transport is "emit `ActivityUpdate` and wire a drain to
//! `correlate`": the binding, native-id capture, and emit logic live here once,
//! for every CLI, instead of being re-implemented per source.

use reverie_core::WorkspaceService;
use reverie_core::activity::ActivityState;
use reverie_core::activity_reconciler::ActivityReconciler;
use reverie_core::activity_source::{ActivitySourceKind, ActivityUpdate, SessionKey};
use reverie_core::domain::SessionStateTimeline;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::codex_titles::maybe_schedule_codex_title;
use crate::reentry_summary::maybe_schedule_reentry_summary;

const SESSION_ACTIVITY_EVENT: &str = "session_activity_changed";
/// Emitted when an update captures a CLI's native session id into a session
/// record for the first time. The frontend refetches the workspace snapshot on
/// this so it can bind the (native-id-keyed) activity stream to the session and
/// show it as live; it also means the session is now resumable.
const SESSION_RECORD_CHANGED_EVENT: &str = "session_record_changed";

/// Payload emitted to the React shell whenever any source reports an
/// activity-state change. React correlates `nativeSessionId` against its
/// persisted `nativeSessionRef.sessionId` to route updates to the right Reverie
/// session. The serialized shape is a frontend contract; do not rename fields
/// or the `source` variants without updating the web layer.
#[derive(Clone, Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind",
    content = "payload"
)]
enum SessionActivityEvent {
    Updated {
        source: ActivitySourceKind,
        native_session_id: String,
        state: ActivityState,
        /// The session's state timeline as of this update, so the dashboards can
        /// reorder a status group by transition recency without waiting for a
        /// snapshot refetch. `None` when no session owns this native id yet.
        #[serde(skip_serializing_if = "Option::is_none")]
        state_timeline: Option<SessionStateTimeline>,
    },
    Removed {
        source: ActivitySourceKind,
        native_session_id: String,
    },
}

/// Serializes reduction, persistence, and publication across transport drains.
#[derive(Default)]
pub(crate) struct ActivityIngestion {
    order: std::sync::Mutex<()>,
    reconciler: ActivityReconciler,
}

pub(crate) fn correlate(app: &AppHandle, update: ActivityUpdate) {
    let (Some(service), Some(ingestion)) = (
        app.try_state::<WorkspaceService>(),
        app.try_state::<ActivityIngestion>(),
    ) else {
        return;
    };
    let _ordered = ingestion.order.lock().unwrap_or_else(|e| e.into_inner());
    match accept_update(&service, Some(&ingestion.reconciler), &update) {
        Ok(Some((event, captured))) => publish(app, event, captured),
        Ok(None) => {}
        Err(error) => eprintln!("[reverie] activity update failed: {error:#}"),
    }
}

/// Called before spawn, while old hooks are being revoked. The new baseline
/// prevents history replay and old reducer state from marking a resume active.
pub(crate) fn begin_run(app: &AppHandle, id: reverie_core::domain::SessionId) {
    let (Some(service), Some(ingestion)) = (
        app.try_state::<WorkspaceService>(),
        app.try_state::<ActivityIngestion>(),
    ) else {
        return;
    };
    let _ordered = ingestion.order.lock().unwrap_or_else(|e| e.into_inner());
    let result = (|| -> anyhow::Result<_> {
        let Some(session) = service.activity().session(&SessionKey::Reverie(id))? else {
            return Ok(None);
        };
        let source = match session.agent_kind {
            reverie_core::AgentKind::ClaudeCode => ActivitySourceKind::ClaudeCode,
            reverie_core::AgentKind::CodexCli => ActivitySourceKind::CodexCli,
            reverie_core::AgentKind::CortexCode => return Ok(None),
        };
        let Some(saved) = service.activity().begin_run(id)? else {
            return Ok(None);
        };
        if source == ActivitySourceKind::CodexCli {
            ingestion.reconciler.begin_run(&saved.state);
        }
        Ok(Some(SessionActivityEvent::Updated {
            source,
            native_session_id: saved.state.session_id.clone(),
            state: saved.state,
            state_timeline: Some(saved.timeline),
        }))
    })();
    match result {
        Ok(Some(event)) => publish(app, event, false),
        Ok(None) => {}
        Err(error) => eprintln!("[reverie] activity launch boundary failed: {error:#}"),
    }
}

fn publish(app: &AppHandle, event: SessionActivityEvent, captured: bool) {
    if let SessionActivityEvent::Updated {
        source,
        native_session_id,
        state,
        ..
    } = &event
    {
        if *source == ActivitySourceKind::CodexCli {
            crate::terminal::runtime::refresh_codex_rollout_path_after_activity(
                app,
                native_session_id,
            );
            maybe_schedule_codex_title(app, native_session_id, state);
        }
        maybe_schedule_reentry_summary(app, native_session_id, state);
    }
    emit(app, event);
    if captured {
        if let Err(error) = app.emit(SESSION_RECORD_CHANGED_EVENT, ()) {
            eprintln!("[reverie] failed to emit session record change: {error}");
        }
    }
}

/// The native CLI session id the frontend keys on. For a native-keyed update it
/// *is* the key; for a Reverie-keyed (hook) update the key is a Reverie id, so
/// the native id rides in the state.
fn native_id_for(key: &SessionKey, state: &ActivityState) -> String {
    match key {
        SessionKey::Native(native_id) => native_id.clone(),
        SessionKey::Reverie(_) => state.session_id.clone(),
    }
}

/// Returns exactly the accepted snapshot, or nothing for an unbound/stale
/// update. Event consumers never see the original, unmerged observation.
fn accept_update(
    service: &WorkspaceService,
    reconciler: Option<&ActivityReconciler>,
    update: &ActivityUpdate,
) -> anyhow::Result<Option<(SessionActivityEvent, bool)>> {
    let persistence = service.activity();
    match update {
        ActivityUpdate::State {
            source,
            key,
            state,
            fidelity,
            session_boundary,
        } => {
            let Some(owner) = persistence.session(key)? else {
                return Ok(None);
            };
            // A poll cannot update a process that exited or overwrite a hook
            // received while the snapshot command was running.
            if *source == ActivitySourceKind::ClaudeCode
                && *fidelity == reverie_core::activity_source::Fidelity::Coarse
            {
                if owner.status != reverie_core::domain::SessionStatus::Running {
                    return Ok(None);
                }
                if owner.latest_activity.as_ref().is_some_and(|old| {
                    reverie_core::time::iso8601_to_epoch_millis(&old.updated_at)
                        .zip(reverie_core::time::iso8601_to_epoch_millis(
                            &state.updated_at,
                        ))
                        .is_some_and(|(old, observed)| old >= observed)
                }) {
                    return Ok(None);
                }
            }
            let native = native_id_for(key, state);
            if persistence
                .session(&SessionKey::Native(native.clone()))?
                .is_some_and(|bound| bound.id != owner.id)
            {
                return Ok(None);
            }
            let stored_native = owner
                .native_session_ref
                .as_ref()
                .and_then(|r| r.session_id.as_deref());
            if stored_native.is_some_and(|old| old != native) && !session_boundary {
                return Ok(None);
            }
            if *source != ActivitySourceKind::CodexCli
                && !session_boundary
                && owner.latest_activity.as_ref().is_some_and(|old| {
                    reverie_core::activity_persistence::activity_is_out_of_order(old, state)
                })
            {
                return Ok(None);
            }
            let merged = if *source == ActivitySourceKind::CodexCli {
                match reconciler {
                    Some(reconciler) => {
                        if *session_boundary && state.status == reverie_core::ActivityStatus::Idle {
                            // Reject an obsolete boundary before resetting merge state.
                            if owner.latest_activity.as_ref().is_some_and(|old| {
                                reverie_core::activity_persistence::activity_is_out_of_order(
                                    old, state,
                                )
                            }) {
                                return Ok(None);
                            }
                            reconciler.begin_run(state);
                        }
                        reconciler.merge(&native, *fidelity, state)
                    }
                    None => state.clone(),
                }
            } else if *source == ActivitySourceKind::ClaudeCode {
                reverie_core::claude_activity::normalize_rest(
                    owner.latest_activity.as_ref(),
                    state.clone(),
                    *session_boundary,
                )
            } else {
                state.clone()
            };
            let Some(saved) = persistence.record(key, merged, *session_boundary)? else {
                return Ok(None);
            };
            Ok(Some((
                SessionActivityEvent::Updated {
                    source: *source,
                    native_session_id: native,
                    state: saved.state,
                    state_timeline: Some(saved.timeline),
                },
                saved.captured_native_session,
            )))
        }
        ActivityUpdate::Removed {
            source,
            key,
            native_session_id,
        } => {
            if *source == ActivitySourceKind::CodexCli {
                if let Some(reconciler) = reconciler {
                    reconciler.forget(native_session_id);
                }
            }
            if !persistence.clear(key)? {
                return Ok(None);
            }
            Ok(Some((
                SessionActivityEvent::Removed {
                    source: *source,
                    native_session_id: native_session_id.clone(),
                },
                false,
            )))
        }
    }
}

#[cfg(test)]
fn apply_update(
    service: &WorkspaceService,
    reconciler: Option<&ActivityReconciler>,
    update: &ActivityUpdate,
) -> bool {
    accept_update(service, reconciler, update)
        .unwrap()
        .is_some_and(|(_, captured)| captured)
}

fn emit(app: &AppHandle, payload: SessionActivityEvent) {
    if let Err(error) = app.emit(SESSION_ACTIVITY_EVENT, payload) {
        eprintln!("[reverie] failed to emit session activity event: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reverie_core::activity::ActivityStatus;
    use reverie_core::activity_source::Fidelity;
    use reverie_core::domain::{AgentKind, SessionId};
    use reverie_core::repository::InMemoryWorkspaceRepository;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn service_with_session() -> (WorkspaceService, SessionId) {
        let repo = Arc::new(InMemoryWorkspaceRepository::new());
        let service = WorkspaceService::new(repo);
        service.ensure_seeded().unwrap();
        let focus_snapshot = service
            .create_focus(None, "General".to_owned(), None, None)
            .unwrap();
        let focus_id = focus_snapshot.focuses[0].id;
        let snapshot = service
            .create_session(
                focus_id,
                "Test".to_owned(),
                AgentKind::ClaudeCode,
                PathBuf::from("/tmp/x"),
                None,
            )
            .unwrap();
        let session_id = snapshot
            .sessions
            .iter()
            .find(|session| session.focus_id == focus_id)
            .unwrap()
            .id;
        (service, session_id)
    }

    fn state(native: &str, sequence: u64, status: ActivityStatus) -> ActivityState {
        ActivityState {
            version: 1,
            session_id: native.to_owned(),
            status,
            updated_at: "t".to_owned(),
            sequence,
            cwd: "/tmp/x".to_owned(),
            turn: None,
            active_tools: Vec::new(),
            awaiting_permission: None,
            last_error: None,
            final_exit: None,
        }
    }

    fn reverie_state(
        session_id: SessionId,
        native: &str,
        sequence: u64,
        status: ActivityStatus,
    ) -> ActivityUpdate {
        reverie_state_boundary(session_id, native, sequence, status, false)
    }

    fn reverie_state_boundary(
        session_id: SessionId,
        native: &str,
        sequence: u64,
        status: ActivityStatus,
        session_boundary: bool,
    ) -> ActivityUpdate {
        ActivityUpdate::State {
            source: ActivitySourceKind::ClaudeCode,
            key: SessionKey::Reverie(session_id),
            fidelity: Fidelity::Definitive,
            state: state(native, sequence, status),
            session_boundary,
        }
    }

    #[test]
    fn reverie_keyed_captures_native_id_only_on_first_sight() {
        let (service, session_id) = service_with_session();

        assert!(
            apply_update(
                &service,
                None,
                &reverie_state(session_id, "native-1", 1, ActivityStatus::Working)
            ),
            "first sight captures the native id"
        );

        let snapshot = service.snapshot().unwrap();
        let session = snapshot
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .unwrap();
        assert_eq!(
            session
                .native_session_ref
                .as_ref()
                .and_then(|reference| reference.session_id.as_deref()),
            Some("native-1")
        );
        assert_eq!(
            session.latest_activity.as_ref().unwrap().status,
            ActivityStatus::Working
        );

        assert!(
            !apply_update(
                &service,
                None,
                &reverie_state(session_id, "native-1", 2, ActivityStatus::AwaitingInput)
            ),
            "the ref is already captured, so no second capture"
        );
    }

    #[test]
    fn session_start_boundary_repoints_native_id_after_in_tui_resume() {
        // Reproduces the `/resume` bug: a session launched with native id A
        // switches conversations in the TUI to an externally-started id B. The
        // SessionStart boundary for B must re-point identity (so the dashboard
        // stays bound and a later Reverie resume targets B), even though B's
        // fresh sequence is far below A's high-water mark.
        let (service, session_id) = service_with_session();

        // Launch + work under native id A; A advances to a high sequence.
        apply_update(
            &service,
            None,
            &reverie_state(session_id, "native-A", 1, ActivityStatus::Working),
        );
        apply_update(
            &service,
            None,
            &reverie_state(session_id, "native-A", 12, ActivityStatus::Working),
        );

        // `/resume` into B: a SessionStart boundary carrying the new id at seq 1.
        assert!(
            apply_update(
                &service,
                None,
                &reverie_state_boundary(session_id, "native-B", 1, ActivityStatus::Working, true,),
            ),
            "a boundary with a new native id re-points and reports a capture"
        );

        let bound_native = |service: &WorkspaceService| {
            service
                .snapshot()
                .unwrap()
                .sessions
                .into_iter()
                .find(|s| s.id == session_id)
                .unwrap()
                .native_session_ref
                .and_then(|reference| reference.session_id)
        };
        assert_eq!(bound_native(&service).as_deref(), Some("native-B"));

        // A late, non-boundary edge from the abandoned A stream must be ignored:
        // it neither overwrites state nor drags identity back to A.
        assert!(!apply_update(
            &service,
            None,
            &reverie_state(session_id, "native-A", 13, ActivityStatus::AwaitingInput),
        ));
        assert_eq!(bound_native(&service).as_deref(), Some("native-B"));

        // Subsequent B events flow normally under the re-pointed id.
        apply_update(
            &service,
            None,
            &reverie_state(session_id, "native-B", 2, ActivityStatus::AwaitingInput),
        );
        let session = service
            .snapshot()
            .unwrap()
            .sessions
            .into_iter()
            .find(|s| s.id == session_id)
            .unwrap();
        let activity = session.latest_activity.unwrap();
        assert_eq!(activity.session_id, "native-B");
        assert_eq!(activity.status, ActivityStatus::AwaitingInput);
    }

    #[test]
    fn native_keyed_binds_to_the_session_with_that_ref() {
        let (service, session_id) = service_with_session();
        let reconciler = ActivityReconciler::new();
        // Capture the native ref first (as the hook path would).
        apply_update(
            &service,
            None,
            &reverie_state(session_id, "native-2", 1, ActivityStatus::Working),
        );

        let native_update = ActivityUpdate::State {
            source: ActivitySourceKind::CodexCli,
            key: SessionKey::Native("native-2".to_owned()),
            fidelity: Fidelity::Inferred,
            state: state("native-2", 2, ActivityStatus::AwaitingPermission),
            session_boundary: false,
        };
        assert!(!apply_update(&service, Some(&reconciler), &native_update));

        let snapshot = service.snapshot().unwrap();
        let session = snapshot
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .unwrap();
        assert_eq!(
            session.latest_activity.as_ref().unwrap().status,
            ActivityStatus::AwaitingPermission
        );
    }

    #[test]
    fn removed_clears_latest_activity() {
        let (service, session_id) = service_with_session();
        apply_update(
            &service,
            None,
            &reverie_state(session_id, "native-3", 1, ActivityStatus::Working),
        );

        let removed = ActivityUpdate::Removed {
            source: ActivitySourceKind::CortexCode,
            key: SessionKey::Native("native-3".to_owned()),
            native_session_id: "native-3".to_owned(),
        };
        apply_update(&service, None, &removed);

        let snapshot = service.snapshot().unwrap();
        let session = snapshot
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .unwrap();
        assert!(session.latest_activity.is_none());
    }

    #[test]
    fn native_id_for_prefers_the_key_then_falls_back_to_state() {
        let st = state("from-state", 1, ActivityStatus::Working);
        assert_eq!(
            native_id_for(&SessionKey::Native("from-key".to_owned()), &st),
            "from-key"
        );
        assert_eq!(
            native_id_for(&SessionKey::Reverie(SessionId::from_bytes([7; 16])), &st),
            "from-state"
        );
    }

    /// The frontend depends on this exact JSON shape; lock it so a refactor of
    /// the enum cannot silently change the wire contract.
    #[test]
    fn session_activity_event_serializes_to_the_frontend_shape() {
        let updated = SessionActivityEvent::Updated {
            source: ActivitySourceKind::CodexCli,
            native_session_id: "n".to_owned(),
            state: state("n", 1, ActivityStatus::Working),
            state_timeline: Some(SessionStateTimeline {
                working_since: Some("2026-06-06T15:10:02.000Z".to_owned()),
                ..SessionStateTimeline::default()
            }),
        };
        let json = serde_json::to_value(&updated).unwrap();
        assert_eq!(json["kind"], "updated");
        assert_eq!(json["payload"]["source"], "codex_cli");
        assert_eq!(json["payload"]["nativeSessionId"], "n");
        assert_eq!(json["payload"]["state"]["sessionId"], "n");
        assert_eq!(json["payload"]["state"]["status"], "working");
        assert_eq!(
            json["payload"]["stateTimeline"]["workingSince"],
            "2026-06-06T15:10:02.000Z"
        );

        let removed = SessionActivityEvent::Removed {
            source: ActivitySourceKind::CortexCode,
            native_session_id: "n".to_owned(),
        };
        let json = serde_json::to_value(&removed).unwrap();
        assert_eq!(json["kind"], "removed");
        assert_eq!(json["payload"]["source"], "cortex_code");
        assert_eq!(json["payload"]["nativeSessionId"], "n");
    }
    fn turn_update(
        id: SessionId,
        turn: &str,
        status: ActivityStatus,
        started: u8,
        at: u8,
        fidelity: Fidelity,
    ) -> ActivityUpdate {
        let mut value = state("native-1", u64::from(at), status);
        value.updated_at = format!("2026-10-10T12:00:{at:02}.000Z");
        value.turn = Some(reverie_core::activity::ActivityTurn {
            id: turn.into(),
            status: reverie_core::activity::TurnStatus::Running,
            started_at: format!("2026-10-10T12:00:{started:02}.000Z"),
            ended_at: None,
        });
        ActivityUpdate::State {
            source: ActivitySourceKind::CodexCli,
            key: SessionKey::Reverie(id),
            state: value,
            fidelity,
            session_boundary: false,
        }
    }

    #[test]
    fn emitted_state_is_the_persisted_merge_and_stale_events_emit_nothing() {
        let (service, id) = service_with_session();
        let reducer = ActivityReconciler::new();
        for (turn, time) in [("a", 1), ("b", 2)] {
            accept_update(
                &service,
                Some(&reducer),
                &turn_update(
                    id,
                    turn,
                    ActivityStatus::Working,
                    time,
                    time,
                    Fidelity::Definitive,
                ),
            )
            .unwrap()
            .unwrap();
        }
        // A delayed start for A previously stole the reducer's current turn.
        assert!(
            accept_update(
                &service,
                Some(&reducer),
                &turn_update(id, "a", ActivityStatus::Working, 1, 3, Fidelity::Inferred)
            )
            .unwrap()
            .is_none()
        );
        let (
            SessionActivityEvent::Updated {
                state,
                state_timeline,
                ..
            },
            _,
        ) = accept_update(
            &service,
            Some(&reducer),
            &turn_update(
                id,
                "b",
                ActivityStatus::AwaitingInput,
                2,
                4,
                Fidelity::Inferred,
            ),
        )
        .unwrap()
        .unwrap()
        else {
            panic!("updated")
        };
        let persisted = service
            .activity()
            .session(&SessionKey::Reverie(id))
            .unwrap()
            .unwrap();
        assert_eq!(Some(&state), persisted.latest_activity.as_ref());
        assert_eq!(state.status, ActivityStatus::AwaitingInput);
        assert_eq!(state.turn.unwrap().started_at, "2026-10-10T12:00:02.000Z");
        assert_eq!(
            serde_json::to_value(state_timeline.unwrap()).unwrap(),
            serde_json::to_value(persisted.state_timeline).unwrap()
        );
    }

    #[test]
    fn unbound_and_stale_claude_updates_are_not_published() {
        let (service, id) = service_with_session();
        accept_update(
            &service,
            None,
            &reverie_state(id, "native-1", 2, ActivityStatus::AwaitingInput),
        )
        .unwrap()
        .unwrap();
        assert!(
            accept_update(
                &service,
                None,
                &reverie_state(id, "native-1", 1, ActivityStatus::Working)
            )
            .unwrap()
            .is_none()
        );
        assert!(
            accept_update(
                &service,
                None,
                &reverie_state(
                    SessionId::from_bytes([9; 16]),
                    "unbound",
                    3,
                    ActivityStatus::Working
                )
            )
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn launch_baseline_preserves_timeline_without_claiming_a_completed_turn() {
        let (service, id) = service_with_session();
        accept_update(
            &service,
            None,
            &reverie_state(id, "native-1", 1, ActivityStatus::Working),
        )
        .unwrap()
        .unwrap();
        let before = service
            .activity()
            .session(&SessionKey::Reverie(id))
            .unwrap()
            .unwrap();
        let launched = service.activity().begin_run(id).unwrap().unwrap();
        assert_eq!(launched.state.status, ActivityStatus::Idle);
        assert!(launched.state.turn.is_none());
        assert_eq!(
            serde_json::to_value(&launched.timeline).unwrap(),
            serde_json::to_value(before.state_timeline).unwrap()
        );
        let mut end = launched.state.clone();
        end.sequence += 1;
        end.status = ActivityStatus::Done;
        accept_update(
            &service,
            None,
            &ActivityUpdate::State {
                source: ActivitySourceKind::ClaudeCode,
                key: SessionKey::Reverie(id),
                fidelity: Fidelity::Definitive,
                state: end,
                session_boundary: false,
            },
        )
        .unwrap();
        assert_eq!(
            service
                .activity()
                .session(&SessionKey::Reverie(id))
                .unwrap()
                .unwrap()
                .latest_activity
                .unwrap()
                .status,
            ActivityStatus::Idle
        );
    }

    #[test]
    fn claude_idle_notification_preserves_a_reviewed_completion_time() {
        let (service, id) = service_with_session();
        accept_update(
            &service,
            None,
            &reverie_state(id, "native-1", 1, ActivityStatus::AwaitingInput),
        )
        .unwrap()
        .unwrap();
        assert!(
            accept_update(
                &service,
                None,
                &reverie_state(id, "native-1", 2, ActivityStatus::Idle)
            )
            .unwrap()
            .is_none()
        );
        let saved = service
            .activity()
            .session(&SessionKey::Reverie(id))
            .unwrap()
            .unwrap()
            .latest_activity
            .unwrap();
        assert_eq!(saved.status, ActivityStatus::AwaitingInput);
        assert_eq!(saved.sequence, 1);
    }

    #[test]
    fn a_hook_during_a_claude_poll_wins_over_the_snapshot() {
        let (service, id) = service_with_session();
        service.mark_session_running(id).unwrap();
        let mut hook = reverie_state(id, "native-1", 1, ActivityStatus::AwaitingPermission);
        let ActivityUpdate::State { state, .. } = &mut hook else {
            unreachable!()
        };
        state.updated_at = "2026-10-10T12:00:03.000Z".into();
        accept_update(&service, None, &hook).unwrap().unwrap();
        let mut poll = reverie_state(id, "native-1", 2, ActivityStatus::Idle);
        let ActivityUpdate::State {
            state, fidelity, ..
        } = &mut poll
        else {
            unreachable!()
        };
        *fidelity = Fidelity::Coarse;
        state.updated_at = "2026-10-10T12:00:02.000Z".into();
        assert!(accept_update(&service, None, &poll).unwrap().is_none());
    }
}
