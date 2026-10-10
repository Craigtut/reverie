//! Poll only Reverie-owned running Claude sessions. Snapshot queries recover
//! dropped hook edges; they never discover or attach other sessions.

use reverie_core::activity_source::{ActivitySourceKind, ActivityUpdate, Fidelity, SessionKey};
use reverie_core::agents::{AgentAdapter, ClaudeCodeAdapter};
use reverie_core::claude_activity::{read_statuses, supports_status_query};
use reverie_core::{AgentKind, WorkspaceService};
use std::{
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

pub(crate) fn spawn(app: AppHandle) {
    let _ = thread::Builder::new()
        .name("reverie-claude-status".into())
        .spawn(move || {
            let mut executable = None;
            let mut check_after = Instant::now();
            loop {
                thread::sleep(Duration::from_secs(3));
                let Some(service) = app.try_state::<WorkspaceService>() else {
                    continue;
                };
                let Ok(sessions) = service.activity().running_sessions(AgentKind::ClaudeCode)
                else {
                    continue;
                };
                if sessions.is_empty() {
                    continue;
                }
                if executable.is_none() {
                    if Instant::now() < check_after {
                        continue;
                    }
                    check_after = Instant::now() + Duration::from_secs(60);
                    let detection = ClaudeCodeAdapter.detect();
                    let Some(path) = detection.executable() else {
                        continue;
                    };
                    if !supports_status_query(path).unwrap_or(false) {
                        continue;
                    }
                    executable = Some(path.clone());
                }
                // A hook received during the command outranks this snapshot.
                let observed_at = reverie_core::time::now_iso8601();
                let Ok(statuses) = read_statuses(executable.as_ref().unwrap()) else {
                    executable = None;
                    check_after = Instant::now() + Duration::from_secs(30);
                    continue;
                };
                for session in sessions {
                    let Some(previous) = session.latest_activity.as_ref() else {
                        continue;
                    };
                    let Some(snapshot) = statuses
                        .iter()
                        .find(|s| s.session_id == previous.session_id)
                    else {
                        continue;
                    };
                    let Some(state) = snapshot.reconcile(previous, &observed_at) else {
                        continue;
                    };
                    crate::correlator::correlate(
                        &app,
                        ActivityUpdate::State {
                            source: ActivitySourceKind::ClaudeCode,
                            key: SessionKey::Reverie(session.id),
                            fidelity: Fidelity::Coarse,
                            state,
                            session_boundary: false,
                        },
                    );
                }
            }
        });
}
