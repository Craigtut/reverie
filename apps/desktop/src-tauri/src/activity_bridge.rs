//! Drains each activity transport's channel onto the single [`correlate`] spine.
//!
//! Two engines feed agent-activity into Reverie: the session-log file watcher
//! (which serves both Codex rollouts and Cortex snapshots through one composite
//! source) and the Claude/Codex hook HTTP server. Each runs on its own thread
//! (spawned from `main`'s setup hook) and its drain does exactly one thing: pull
//! an [`ActivityUpdate`] off the channel and hand it to
//! [`crate::correlator::correlate`], which owns all the binding, native-id
//! capture, and frontend-emit logic. Keeping the drains this thin is the point:
//! a new transport is a new drain plus its engine, never a new copy of the
//! correlation logic.

use reverie_core::hook_server::HookServerHandle;
use reverie_core::session_log::SessionLogWatcher;
use tauri::AppHandle;

use crate::correlator::correlate;

/// Drain the session-log file watcher, which already emits [`ActivityUpdate`]
/// (native-keyed, tagged per file with its CLI and fidelity by the fold). One
/// watcher serves every file-transport CLI; owning the `watcher` keeps its worker
/// thread and control alive for the drain's lifetime. Returns when the app drops
/// the control senders at shutdown.
pub(crate) fn drain_file_activity(watcher: SessionLogWatcher, app: AppHandle) {
    while let Ok(update) = watcher.events.recv() {
        correlate(&app, update);
    }
}

/// Drain the hook HTTP server, which already emits [`ActivityUpdate`]. Moving
/// `handle` into this thread keeps the bound server alive for the thread's
/// lifetime; on app shutdown the thread tears down, the handle drops, and the
/// server stops cleanly.
pub(crate) fn drain_hook_activity(handle: HookServerHandle, app: AppHandle) {
    while let Ok(update) = handle.events.recv() {
        correlate(&app, update);
    }
}
