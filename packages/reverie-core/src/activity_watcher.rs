//! Cortex Code activity-state filesystem watcher.
//!
//! Watches `~/.cortex/sessions/*/activity/state.json` for atomic-rename writes
//! produced by Cortex Code per `docs/technical/cortex-activity-contract.md`,
//! and pushes parsed `ActivityState` updates over a channel. On startup it
//! scans for already-existing `state.json` files so a Reverie process that
//! launches *after* a Cortex session is already running learns current state
//! immediately, not only on the next transition.
//!
//! Backends: FSEvents (macOS) and ReadDirectoryChangesW (Windows), both
//! delivered by `notify::RecommendedWatcher`. No polling fallback — Reverie
//! ships on macOS + Windows only, both of which support real kernel events.
//!
//! This module is Cortex-specific. Claude Code and Codex CLI use HTTP hooks,
//! not filesystem state, so they get a separate adapter. The unified output
//! type is `crate::activity::ActivityState`, so the dashboard does not need to
//! know which CLI a state update came from.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, Sender},
    thread::{self, JoinHandle},
    time::Duration,
};

use anyhow::{Context, Result};
use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};

use crate::activity::{ActivityState, parse_state};

/// How long the debouncer coalesces filesystem events for a given path before
/// firing. Atomic temp-file + rename writes produce up to two events; this
/// window collapses them so we parse the destination file exactly once.
const DEBOUNCE_MS: u64 = 150;
const STATE_FILENAME: &str = "state.json";
const ACTIVITY_DIRNAME: &str = "activity";

/// One update from the watcher. `Removed` fires when a session directory or
/// its `activity/state.json` disappears so the consumer can drop the row from
/// its dashboard.
#[derive(Clone, Debug)]
pub enum CortexActivityUpdate {
    State {
        session_id: String,
        state: ActivityState,
    },
    Removed {
        session_id: String,
    },
}

/// Handle returned by [`watch_cortex_activity`]. Drain `events` for updates.
/// Drop the stream to stop the watcher: the worker thread sees the channel
/// disconnect and exits cleanly, and the debouncer is dropped with it.
pub struct CortexActivityStream {
    pub events: Receiver<CortexActivityUpdate>,
    _worker: JoinHandle<()>,
    _shutdown: Sender<()>,
}

/// Start watching `sessions_root` (typically `~/.cortex/sessions`). If the
/// directory does not yet exist it is created so the watcher can attach.
/// Returns a stream that fires one [`CortexActivityUpdate::State`] per
/// existing session directory it finds during the initial scan, then live
/// updates as `state.json` files change.
pub fn watch_cortex_activity(sessions_root: PathBuf) -> Result<CortexActivityStream> {
    fs::create_dir_all(&sessions_root).with_context(|| {
        format!(
            "ensuring sessions root exists at {}",
            sessions_root.display()
        )
    })?;

    let (out_tx, out_rx) = mpsc::channel::<CortexActivityUpdate>();
    let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();

    // Initial scan: emit one State update per already-existing state.json so a
    // late-starting Reverie process learns current state immediately.
    scan_existing(&sessions_root, &out_tx);

    let worker_root = sessions_root.clone();
    let worker = thread::Builder::new()
        .name("reverie-cortex-activity-watcher".to_string())
        .spawn(move || {
            run_watch_loop(worker_root, out_tx, shutdown_rx);
        })
        .context("spawning Cortex activity watcher thread")?;

    Ok(CortexActivityStream {
        events: out_rx,
        _worker: worker,
        _shutdown: shutdown_tx,
    })
}

fn run_watch_loop(root: PathBuf, out_tx: Sender<CortexActivityUpdate>, shutdown_rx: Receiver<()>) {
    let (debounce_tx, debounce_rx) = mpsc::channel::<DebounceEventResult>();
    let mut debouncer: Debouncer<RecommendedWatcher, RecommendedCache> =
        match new_debouncer(Duration::from_millis(DEBOUNCE_MS), None, debounce_tx) {
            Ok(d) => d,
            Err(_) => return,
        };
    if debouncer.watch(&root, RecursiveMode::Recursive).is_err() {
        return;
    }

    loop {
        // recv_timeout lets us notice a dropped shutdown sender even when no
        // filesystem events are arriving.
        match debounce_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(result) => handle_events(result, &out_tx),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        // Stream dropped on the consumer side → exit promptly.
        match shutdown_rx.try_recv() {
            Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }
    }

    // Explicit drop so the watcher stops before the channel sender does.
    drop(debouncer);
}

fn scan_existing(root: &Path, tx: &Sender<CortexActivityUpdate>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let session_dir = entry.path();
        if !session_dir.is_dir() {
            continue;
        }
        let state_path = session_dir.join(ACTIVITY_DIRNAME).join(STATE_FILENAME);
        if state_path.exists() {
            if let Some(update) = try_read_state(&state_path) {
                let _ = tx.send(update);
            }
        }
    }
}

fn handle_events(result: DebounceEventResult, out_tx: &Sender<CortexActivityUpdate>) {
    let events = match result {
        Ok(events) => events,
        Err(_errors) => return,
    };

    // A single debounce batch can carry multiple events for the same path
    // (the atomic temp + rename pattern produces at least two). Coalesce per
    // path so we parse the file once per batch.
    let mut seen = HashSet::new();
    for batched in events {
        let event = &batched.event;
        for path in &event.paths {
            if !is_state_file(path) {
                continue;
            }
            if !seen.insert(path.clone()) {
                continue;
            }
            match &event.kind {
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Other => {
                    if let Some(update) = try_read_state(path) {
                        let _ = out_tx.send(update);
                    }
                }
                EventKind::Remove(_) => {
                    if let Some(session_id) = session_id_from_state_path(path) {
                        let _ = out_tx.send(CortexActivityUpdate::Removed { session_id });
                    }
                }
                _ => {}
            }
        }
    }
}

fn is_state_file(path: &Path) -> bool {
    let Some(name) = path.file_name() else {
        return false;
    };
    if name != STATE_FILENAME {
        return false;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    parent.file_name().is_some_and(|n| n == ACTIVITY_DIRNAME)
}

fn session_id_from_state_path(path: &Path) -> Option<String> {
    // Layout: .../{session_id}/activity/state.json
    path.parent()?
        .parent()?
        .file_name()?
        .to_str()
        .map(str::to_owned)
}

fn try_read_state(path: &Path) -> Option<CortexActivityUpdate> {
    let content = fs::read_to_string(path).ok()?;
    let state = parse_state(&content).ok()?;
    let session_id = session_id_from_state_path(path).unwrap_or_else(|| state.session_id.clone());
    Some(CortexActivityUpdate::State { session_id, state })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use tempfile::TempDir;

    /// Generous timeout. FSEvents on macOS has its own latency before our
    /// debouncer even sees an event; tests should not flake under load.
    const TEST_TIMEOUT: Duration = Duration::from_secs(5);

    fn write_state_atomically(state_path: &Path, body: &str) {
        let activity_dir = state_path.parent().expect("state path has parent");
        fs::create_dir_all(activity_dir).expect("create activity dir");
        let tmp = activity_dir.join("state.json.tmp");
        fs::write(&tmp, body).expect("write temp state");
        fs::rename(&tmp, state_path).expect("rename temp over state");
    }

    fn make_state_json(session_id: &str, status: &str, sequence: u64) -> String {
        format!(
            r#"{{
                "version": 1,
                "sessionId": "{session_id}",
                "status": "{status}",
                "updatedAt": "2026-05-28T12:00:00.000Z",
                "sequence": {sequence},
                "cwd": "/repo"
            }}"#
        )
    }

    fn wait_for<F: FnMut() -> bool>(mut predicate: F) -> bool {
        let start = Instant::now();
        while start.elapsed() < TEST_TIMEOUT {
            if predicate() {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        predicate()
    }

    fn collect_for(stream: &CortexActivityStream, ms: u64) -> Vec<CortexActivityUpdate> {
        let deadline = Instant::now() + Duration::from_millis(ms);
        let mut out = Vec::new();
        while Instant::now() < deadline {
            match stream.events.recv_timeout(Duration::from_millis(50)) {
                Ok(update) => out.push(update),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        out
    }

    #[test]
    fn initial_scan_emits_existing_sessions() {
        let root = TempDir::new().unwrap();
        let session_id = "0193abcd-ef01-7000-8000-existing";
        let state_path = root
            .path()
            .join(session_id)
            .join(ACTIVITY_DIRNAME)
            .join(STATE_FILENAME);
        write_state_atomically(
            &state_path,
            &make_state_json(session_id, "awaiting_input", 1),
        );

        let stream = watch_cortex_activity(root.path().to_path_buf()).expect("watcher starts");

        let update = stream
            .events
            .recv_timeout(TEST_TIMEOUT)
            .expect("startup scan emits existing session");
        match update {
            CortexActivityUpdate::State {
                session_id: id,
                state,
            } => {
                assert_eq!(id, session_id);
                assert_eq!(state.session_id, session_id);
                assert_eq!(state.sequence, 1);
            }
            CortexActivityUpdate::Removed { .. } => panic!("expected State update"),
        }
    }

    #[test]
    fn live_atomic_write_produces_update() {
        let root = TempDir::new().unwrap();
        let stream = watch_cortex_activity(root.path().to_path_buf()).expect("watcher starts");

        // Drain any initial scan output (there is none here, but stay safe).
        let _ = collect_for(&stream, 50);

        let session_id = "0193abcd-ef01-7000-8000-live-write";
        let state_path = root
            .path()
            .join(session_id)
            .join(ACTIVITY_DIRNAME)
            .join(STATE_FILENAME);
        write_state_atomically(&state_path, &make_state_json(session_id, "working", 7));

        let mut received: Option<ActivityState> = None;
        let _ = wait_for(|| {
            while let Ok(update) = stream.events.try_recv() {
                if let CortexActivityUpdate::State { state, .. } = update {
                    if state.sequence == 7 {
                        received = Some(state);
                        return true;
                    }
                }
            }
            false
        });

        let state = received.expect("live update arrived");
        assert_eq!(state.session_id, session_id);
        assert_eq!(state.sequence, 7);
    }

    #[test]
    fn ignores_non_state_files_in_session_dir() {
        let root = TempDir::new().unwrap();
        let session_id = "0193abcd-ef01-7000-8000-noise";
        let session_dir = root.path().join(session_id);
        fs::create_dir_all(session_dir.join(ACTIVITY_DIRNAME)).unwrap();

        let stream = watch_cortex_activity(root.path().to_path_buf()).expect("watcher starts");

        // Touch unrelated files and confirm no updates fire.
        fs::write(session_dir.join("meta.json"), r#"{"id":"noise"}"#).unwrap();
        fs::write(
            session_dir.join(ACTIVITY_DIRNAME).join("events.jsonl"),
            "{}\n",
        )
        .unwrap();

        let updates = collect_for(&stream, 400);
        assert!(
            updates.is_empty(),
            "expected no updates from non-state files, got {updates:?}"
        );
    }

    #[test]
    fn malformed_state_json_does_not_crash_watcher() {
        let root = TempDir::new().unwrap();
        let session_id = "0193abcd-ef01-7000-8000-malformed";
        let state_path = root
            .path()
            .join(session_id)
            .join(ACTIVITY_DIRNAME)
            .join(STATE_FILENAME);
        // Write garbage first; watcher should silently skip it.
        write_state_atomically(&state_path, "this is not json");

        let stream = watch_cortex_activity(root.path().to_path_buf()).expect("watcher starts");
        let _ = collect_for(&stream, 100);

        // Then a well-formed write should still come through.
        write_state_atomically(
            &state_path,
            &make_state_json(session_id, "awaiting_input", 99),
        );

        let mut found = false;
        let _ = wait_for(|| {
            while let Ok(update) = stream.events.try_recv() {
                if let CortexActivityUpdate::State { state, .. } = update {
                    if state.sequence == 99 {
                        found = true;
                        return true;
                    }
                }
            }
            false
        });
        assert!(
            found,
            "watcher survived malformed write and emitted next valid one"
        );
    }
}
