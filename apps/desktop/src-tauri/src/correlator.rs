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
use reverie_core::activity_source::{ActivitySourceKind, ActivityUpdate, SessionKey};
use reverie_core::domain::SessionStateTimeline;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::codex_titles::maybe_schedule_codex_title;

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

/// Bind one update to its Reverie session, persist it, and emit the frontend
/// event. Persistence is best-effort: the event still fires if the service is
/// momentarily unavailable, because the frontend keys on the native id either
/// way.
pub(crate) fn correlate(app: &AppHandle, update: ActivityUpdate) {
    let service = app.try_state::<WorkspaceService>();
    let reconciler = app.try_state::<ActivityReconciler>();
    let captured = service
        .as_ref()
        .map(|service| apply_update(service, reconciler.as_deref(), &update))
        .unwrap_or(false);

    match update {
        ActivityUpdate::State {
            source, key, state, ..
        } => {
            let native_session_id = native_id_for(&key, &state);
            let status = state.status;
            // Read back the timeline the apply just stamped so it rides the live
            // event (the session is bound by now, even on a first-sight capture).
            let state_timeline = service.as_ref().and_then(|service| {
                service
                    .session_timeline_by_native_id(&native_session_id)
                    .ok()
                    .flatten()
            });
            emit(
                app,
                SessionActivityEvent::Updated {
                    source,
                    native_session_id: native_session_id.clone(),
                    state,
                    state_timeline,
                },
            );
            if source == ActivitySourceKind::CodexCli {
                maybe_schedule_codex_title(app, &native_session_id, status);
            }
            // First sight of this session's native id: the record only now
            // carries the ref the dashboard binds activity against, so prompt a
            // snapshot refetch.
            if captured {
                if let Err(error) = app.emit(SESSION_RECORD_CHANGED_EVENT, ()) {
                    eprintln!("[reverie] failed to emit session record change: {error}");
                }
            }
        }
        ActivityUpdate::Removed {
            source,
            native_session_id,
            ..
        } => {
            emit(
                app,
                SessionActivityEvent::Removed {
                    source,
                    native_session_id,
                },
            );
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

/// Persist an update by its binding key. Returns `true` only when a Reverie-keyed
/// update captured the CLI's native session id into the record for the first
/// time (which the caller turns into a `session_record_changed`). Pure of Tauri,
/// so it is unit-testable against an in-memory [`WorkspaceService`].
///
/// Multi-source fidelity merge (deferred): when a single session gains a second
/// source at a different fidelity (the planned Codex `PermissionRequest` hook
/// layered over the rollout watcher), this is where a definitive update must be
/// kept from being clobbered by a stale, lower-fidelity one. Today every session
/// has exactly one source, and `record_session_activity*` already drops
/// out-of-order updates by sequence, so no extra merge state is needed yet; the
/// `fidelity` carried on each [`ActivityUpdate`] is the hook for that rule.
fn apply_update(service: &WorkspaceService, update: &ActivityUpdate) -> bool {
    match update {
        ActivityUpdate::State {
            key: SessionKey::Reverie(reverie_id),
            state,
            ..
        } => match service.record_session_activity_by_id(
            *reverie_id,
            &state.session_id,
            state.clone(),
        ) {
            Ok(captured) => captured,
            Err(error) => {
                eprintln!("[reverie] failed to persist hook activity for {reverie_id}: {error:#}");
                false
            }
        },
        ActivityUpdate::State {
            key: SessionKey::Native(native_id),
            state,
            ..
        } => {
            if let Err(error) = service.record_session_activity(native_id, state.clone()) {
                eprintln!("[reverie] failed to persist activity for {native_id}: {error:#}");
            }
            false
        }
        ActivityUpdate::Removed {
            key: SessionKey::Reverie(reverie_id),
            ..
        } => {
            if let Err(error) = service.clear_session_activity_by_id(*reverie_id) {
                eprintln!("[reverie] failed to clear hook activity for {reverie_id}: {error:#}");
            }
            false
        }
        ActivityUpdate::Removed {
            key: SessionKey::Native(native_id),
            ..
        } => {
            if let Err(error) = service.clear_session_activity(native_id) {
                eprintln!("[reverie] failed to clear activity for {native_id}: {error:#}");
            }
            false
        }
    }
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
        ActivityUpdate::State {
            source: ActivitySourceKind::ClaudeCode,
            key: SessionKey::Reverie(session_id),
            fidelity: Fidelity::Definitive,
            state: state(native, sequence, status),
        }
    }

    #[test]
    fn reverie_keyed_captures_native_id_only_on_first_sight() {
        let (service, session_id) = service_with_session();

        assert!(
            apply_update(
                &service,
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
                &reverie_state(session_id, "native-1", 2, ActivityStatus::AwaitingInput)
            ),
            "the ref is already captured, so no second capture"
        );
    }

    #[test]
    fn native_keyed_binds_to_the_session_with_that_ref() {
        let (service, session_id) = service_with_session();
        // Capture the native ref first (as the hook path would).
        apply_update(
            &service,
            &reverie_state(session_id, "native-2", 1, ActivityStatus::Working),
        );

        let native_update = ActivityUpdate::State {
            source: ActivitySourceKind::CodexCli,
            key: SessionKey::Native("native-2".to_owned()),
            fidelity: Fidelity::Inferred,
            state: state("native-2", 2, ActivityStatus::AwaitingPermission),
        };
        assert!(!apply_update(&service, &native_update));

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
            &reverie_state(session_id, "native-3", 1, ActivityStatus::Working),
        );

        let removed = ActivityUpdate::Removed {
            source: ActivitySourceKind::CortexCode,
            key: SessionKey::Native("native-3".to_owned()),
            native_session_id: "native-3".to_owned(),
        };
        apply_update(&service, &removed);

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
}
