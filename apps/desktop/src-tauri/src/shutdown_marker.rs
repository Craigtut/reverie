//! Clean-shutdown sentinel: tells the next launch whether the previous one
//! exited gracefully or died (crash, panic, force-kill, power loss).
//!
//! Reverie persists session state (`status`, `latest_activity`) that is only
//! meaningful while a process owns it. A graceful quit reconciles that state on
//! the way out (`shutdown_all` + `mark_session_finished`); an unclean exit does
//! not, leaving every live session frozen as `running` / `working` for the next
//! boot's reconciliation to repair. This marker makes that distinction
//! observable: the file is written at boot (we are now running) and removed only
//! on a graceful exit, so if it is still present at the next boot the previous
//! run did not shut down cleanly.
//!
//! The marker drives logging today; boot reconciliation (orphan reap +
//! `normalize_sessions`) already runs unconditionally, so correctness does not
//! depend on it. It exists so a stale-state report stops being a mystery and so
//! future policy (e.g. not auto-resuming a fleet of agents after a crash) has a
//! ground-truth signal to key off.

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const MARKER_FILE: &str = "runtime-active.marker";

fn marker_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(MARKER_FILE))
}

/// Whether the previous run exited uncleanly, arming the marker for this run.
/// Returns `true` when the marker was still present from last time (no graceful
/// shutdown removed it). Always (re)writes the marker so this run is covered.
pub(crate) fn detect_unclean_shutdown_and_arm(app: &AppHandle) -> bool {
    let Some(path) = marker_path(app) else {
        return false;
    };
    let was_unclean = path.exists();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(error) = fs::write(&path, b"running") {
        eprintln!("[reverie] failed to arm shutdown marker: {error:#}");
    }
    was_unclean
}

/// Record that this run is shutting down gracefully, so the next boot reads it as
/// clean. Called from the process-exit path; idempotent and best-effort (a
/// failure here just makes the next boot conservatively treat us as unclean).
pub(crate) fn note_clean_shutdown(app: &AppHandle) {
    let Some(path) = marker_path(app) else {
        return;
    };
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => eprintln!("[reverie] failed to clear shutdown marker: {error:#}"),
    }
}
