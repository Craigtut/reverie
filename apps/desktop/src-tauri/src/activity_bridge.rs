//! Forwards agent-activity updates (Cortex filesystem watcher and the hook HTTP
//! server) to the React shell as `session_activity_changed` events, and
//! persists each update through the workspace service. These run on dedicated
//! threads spawned from `main`'s setup hook.

use reverie_core::WorkspaceService;
use reverie_core::activity::ActivityState;
use reverie_core::activity_watcher::{CortexActivityStream, CortexActivityUpdate};
use reverie_core::domain::SessionId;
use reverie_core::hook_server::{HookActivityUpdate, HookServerHandle, HookSource};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const SESSION_ACTIVITY_EVENT: &str = "session_activity_changed";

/// Payload emitted to the React shell whenever any adapter (Cortex filesystem
/// watcher today, Claude/Codex hook receiver via the localhost HTTP server)
/// reports an activity-state change. React correlates `nativeSessionId`
/// against its persisted `nativeSessionRef.sessionId` to route updates to the
/// right Reverie session.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "payload")]
enum SessionActivityEvent {
    Updated {
        source: ActivitySource,
        native_session_id: String,
        state: ActivityState,
    },
    Removed {
        source: ActivitySource,
        native_session_id: String,
    },
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum ActivitySource {
    CortexCode,
    ClaudeCode,
    CodexCli,
}

/// Drain the Cortex watcher's channel and forward every update. Returns when
/// the stream is dropped (which closes the channel), so the thread exits
/// cleanly on app shutdown.
pub(crate) fn drain_cortex_activity(stream: CortexActivityStream, app: AppHandle) {
    while let Ok(update) = stream.events.recv() {
        match update {
            CortexActivityUpdate::State { session_id, state } => {
                forward_activity_update(&app, ActivitySource::CortexCode, session_id, state);
            }
            CortexActivityUpdate::Removed { session_id } => {
                forward_activity_removed(&app, ActivitySource::CortexCode, session_id);
            }
        }
    }
}

pub(crate) fn drain_hook_activity(handle: HookServerHandle, app: AppHandle) {
    // Moving `handle` into this thread keeps the bound HTTP server alive for
    // the thread's lifetime; on app shutdown the thread tears down, the
    // handle drops, and the server stops cleanly.
    while let Ok(update) = handle.events.recv() {
        match update {
            HookActivityUpdate::State {
                source,
                reverie_session_id,
                native_session_id,
                state,
            } => forward_hook_state_update(
                &app,
                hook_source_to_activity_source(source),
                &reverie_session_id,
                native_session_id,
                state,
            ),
            HookActivityUpdate::Removed {
                source,
                reverie_session_id,
                native_session_id,
            } => forward_hook_removed_update(
                &app,
                hook_source_to_activity_source(source),
                &reverie_session_id,
                native_session_id,
            ),
        }
    }
}

fn forward_activity_update(
    app: &AppHandle,
    source: ActivitySource,
    native_session_id: String,
    state: ActivityState,
) {
    if let Some(store) = app.try_state::<WorkspaceService>() {
        if let Err(error) = store.record_session_activity(&native_session_id, state.clone()) {
            eprintln!("[reverie] failed to persist activity for {native_session_id}: {error:#}");
        }
    }
    let payload = SessionActivityEvent::Updated {
        source,
        native_session_id,
        state,
    };
    if let Err(error) = app.emit(SESSION_ACTIVITY_EVENT, payload) {
        eprintln!("[reverie] failed to emit session activity event: {error}");
    }
}

fn forward_activity_removed(app: &AppHandle, source: ActivitySource, native_session_id: String) {
    if let Some(store) = app.try_state::<WorkspaceService>() {
        if let Err(error) = store.clear_session_activity(&native_session_id) {
            eprintln!("[reverie] failed to clear activity for {native_session_id}: {error:#}");
        }
    }
    let payload = SessionActivityEvent::Removed {
        source,
        native_session_id,
    };
    if let Err(error) = app.emit(SESSION_ACTIVITY_EVENT, payload) {
        eprintln!("[reverie] failed to emit session activity removal: {error}");
    }
}

/// Hook updates carry the Reverie session id that owns the token, so we persist
/// activity (and capture the CLI's native session id) by Reverie id directly
/// instead of doing a reverse lookup by native id.
fn forward_hook_state_update(
    app: &AppHandle,
    source: ActivitySource,
    reverie_session_id: &str,
    native_session_id: String,
    state: ActivityState,
) {
    if let Some(store) = app.try_state::<WorkspaceService>() {
        if let Ok(parsed) = SessionId::parse_str(reverie_session_id) {
            if let Err(error) =
                store.record_session_activity_by_id(parsed, &native_session_id, state.clone())
            {
                eprintln!(
                    "[reverie] failed to persist hook activity for {reverie_session_id}: {error:#}"
                );
            }
        }
    }
    let payload = SessionActivityEvent::Updated {
        source,
        native_session_id,
        state,
    };
    if let Err(error) = app.emit(SESSION_ACTIVITY_EVENT, payload) {
        eprintln!("[reverie] failed to emit session activity event: {error}");
    }
}

fn forward_hook_removed_update(
    app: &AppHandle,
    source: ActivitySource,
    reverie_session_id: &str,
    native_session_id: String,
) {
    if let Some(store) = app.try_state::<WorkspaceService>() {
        if let Ok(parsed) = SessionId::parse_str(reverie_session_id) {
            if let Err(error) = store.clear_session_activity_by_id(parsed) {
                eprintln!(
                    "[reverie] failed to clear hook activity for {reverie_session_id}: {error:#}"
                );
            }
        }
    }
    let payload = SessionActivityEvent::Removed {
        source,
        native_session_id,
    };
    if let Err(error) = app.emit(SESSION_ACTIVITY_EVENT, payload) {
        eprintln!("[reverie] failed to emit session activity removal: {error}");
    }
}

fn hook_source_to_activity_source(source: HookSource) -> ActivitySource {
    match source {
        HookSource::ClaudeCode => ActivitySource::ClaudeCode,
        HookSource::CodexCli => ActivitySource::CodexCli,
    }
}
