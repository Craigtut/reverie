//! Durable session activity: identity binding, stale-update rejection, and
//! the exact accepted snapshot shared by persistence and event consumers.

use crate::activity::{ActivityState, ActivityStatus};
use crate::activity_source::SessionKey;
use crate::domain::{NativeSessionRef, Session, SessionId, SessionStateTimeline};
use crate::repository::WorkspaceRepository;
use anyhow::Result;
use std::sync::Arc;

/// Whether `incoming` is an out-of-order (stale) activity update relative to the
/// `existing` one and must be dropped to keep the dashboard from rolling
/// backwards.
///
/// Ordering is by wall-clock `updated_at` first. A CLI process can restart
/// mid-session (a crash-resume, a post-error continuation, an external
/// `/resume`) while Reverie keeps running, and on restart its per-run `sequence`
/// counter resets to 1. A sequence-only guard would then drop every post-restart
/// event as "older" and strand a genuinely working session showing its
/// pre-restart state. Real wall-clock time only moves forward across that
/// restart, so the timestamp distinguishes a restarted stream (newer time, lower
/// sequence: kept) from a true straggler (older time: dropped). `sequence` is
/// the tiebreaker within one run, where it is authoritative and the timestamps
/// match or are unparseable (e.g. a source that does not stamp one, or a
/// hand-built fixture). Equal sequence is kept, matching the prior guard.
pub fn activity_is_out_of_order(existing: &ActivityState, incoming: &ActivityState) -> bool {
    match (
        crate::time::iso8601_to_epoch_millis(&existing.updated_at),
        crate::time::iso8601_to_epoch_millis(&incoming.updated_at),
    ) {
        (Some(prev), Some(next)) if prev != next => next < prev,
        _ => incoming.sequence < existing.sequence,
    }
}

#[derive(Clone, Debug)]
pub struct RecordedActivity {
    pub state: ActivityState,
    pub timeline: SessionStateTimeline,
    pub captured_native_session: bool,
}

pub struct ActivityPersistence {
    repo: Arc<dyn WorkspaceRepository>,
}

impl ActivityPersistence {
    pub(crate) fn new(repo: Arc<dyn WorkspaceRepository>) -> Self {
        Self { repo }
    }

    pub fn running_sessions(&self, kind: crate::AgentKind) -> Result<Vec<Session>> {
        Ok(self
            .repo
            .load_snapshot()?
            .sessions
            .into_iter()
            .filter(|s| s.agent_kind == kind && s.status == crate::domain::SessionStatus::Running)
            .collect())
    }

    pub fn session(&self, key: &SessionKey) -> Result<Option<Session>> {
        Ok(match key {
            SessionKey::Reverie(id) => self.repo.get_session(*id)?,
            SessionKey::Native(id) => self.repo.find_session_by_native_id(id)?,
        })
    }

    pub fn record(
        &self,
        key: &SessionKey,
        state: ActivityState,
        boundary: bool,
    ) -> Result<Option<RecordedActivity>> {
        let Some(mut session) = self.session(key)? else {
            return Ok(None);
        };
        let stored_native = session
            .native_session_ref
            .as_ref()
            .and_then(|r| r.session_id.as_deref());
        let changed = stored_native.is_some_and(|native| native != state.session_id);
        let repoint = changed && boundary && matches!(key, SessionKey::Reverie(_));
        if changed && !repoint {
            return Ok(None);
        }
        if !repoint
            && session
                .latest_activity
                .as_ref()
                .is_some_and(|old| activity_is_out_of_order(old, &state))
        {
            return Ok(None);
        }
        if session.latest_activity.as_ref() == Some(&state) {
            return Ok(None);
        }
        let captured = stored_native.is_none() || repoint;
        if captured {
            if !self.repo.claim_native_session(
                session.id,
                NativeSessionRef {
                    kind: session.agent_kind,
                    session_id: Some(state.session_id.clone()),
                    metadata_path: None,
                    adapter_payload: serde_json::Value::Null,
                },
            )? {
                return Ok(None);
            }
            let Some(refreshed) = self.repo.get_session(session.id)? else {
                return Ok(None);
            };
            session = refreshed;
        }
        session.note_activity_transition(&state);
        session.latest_activity = Some(state.clone());
        self.repo.upsert_session(&session)?;
        Ok(Some(RecordedActivity {
            state,
            timeline: session.state_timeline,
            captured_native_session: captured,
        }))
    }

    pub fn clear(&self, key: &SessionKey) -> Result<bool> {
        let Some(mut session) = self.session(key)? else {
            return Ok(false);
        };
        if session.latest_activity.take().is_none() {
            return Ok(false);
        }
        self.repo.upsert_session(&session)?;
        Ok(true)
    }

    /// Publish an idle launch boundary before spawning the CLI. Preserve the
    /// existing timeline: opening a conversation is not a completed turn.
    pub fn begin_run(&self, id: SessionId) -> Result<Option<RecordedActivity>> {
        let Some(mut session) = self.repo.get_session(id)? else {
            return Ok(None);
        };
        let Some(native) = session
            .native_session_ref
            .as_ref()
            .and_then(|r| r.session_id.clone())
        else {
            return Ok(None);
        };
        let state = ActivityState {
            version: 1,
            session_id: native,
            status: ActivityStatus::Idle,
            updated_at: crate::time::now_iso8601(),
            sequence: session
                .latest_activity
                .as_ref()
                .map_or(1, |a| a.sequence + 1),
            cwd: session.cwd.to_string_lossy().into_owned(),
            turn: None,
            active_tools: Vec::new(),
            awaiting_permission: None,
            last_error: None,
            final_exit: None,
        };
        session.latest_activity = Some(state.clone());
        self.repo.upsert_session(&session)?;
        Ok(Some(RecordedActivity {
            state,
            timeline: session.state_timeline,
            captured_native_session: false,
        }))
    }

    pub fn reset_sequence(&self, id: SessionId) -> Result<bool> {
        let Some(mut session) = self.repo.get_session(id)? else {
            return Ok(false);
        };
        let Some(state) = session.latest_activity.as_mut() else {
            return Ok(false);
        };
        if state.sequence == 0 {
            return Ok(false);
        }
        state.sequence = 0;
        self.repo.upsert_session(&session)?;
        Ok(true)
    }
}
