//! Reader for Cortex Code activity-state snapshot files.
//!
//! Cortex writes a small `state.json` per session at
//! `$CORTEX_HOME/sessions/<id>/activity/state.json`, rewriting it whole (atomic
//! temp + rename) on every transition. Unlike Codex's append-only rollout, this
//! is a *snapshot*: the current file is the current state. Reverie folds it into
//! the same [`ActivityState`] every other source produces.
//!
//! This is the `Snapshot` half of the file transport: a thin [`SessionLogFold`]
//! that parses the whole (small) file on each change, driven by the shared
//! [`crate::session_log`] engine. It replaces the bespoke recursive tree watcher
//! that used to live in `activity_watcher`; the engine watches only the active
//! `state.json` files the launch path registers, so the cost scales with active
//! sessions rather than with the whole `~/.cortex/sessions` tree.

use std::path::Path;

use crate::activity::{ActivityState, parse_state};
use crate::activity_source::{ActivitySourceKind, Fidelity};
use crate::session_log::{LogReadMode, SessionLogFold, SessionLogSource};

const STATE_FILENAME: &str = "state.json";
const ACTIVITY_DIRNAME: &str = "activity";

/// The Cortex source: recognizes `.../activity/state.json` snapshot files. The
/// thin per-CLI wrapper the [`crate::session_log`] engine drives, composed with
/// the Codex source so one watcher serves both.
pub struct CortexStateSource;

impl SessionLogSource for CortexStateSource {
    fn matches(&self, path: &Path) -> bool {
        is_state_path(path)
    }

    fn new_fold(&self, _path: &Path) -> Box<dyn SessionLogFold> {
        Box::new(CortexStateFold)
    }
}

/// Whether `path` is a Cortex activity snapshot (`.../activity/state.json`).
pub fn is_state_path(path: &Path) -> bool {
    let named_state = path.file_name().is_some_and(|name| name == STATE_FILENAME);
    let in_activity_dir = path
        .parent()
        .and_then(|parent| parent.file_name())
        .is_some_and(|name| name == ACTIVITY_DIRNAME);
    named_state && in_activity_dir
}

/// Folds a Cortex `state.json` snapshot into the current [`ActivityState`]. The
/// snapshot is authoritative and self-contained, so each `push` simply parses the
/// whole file; the engine resets the fold before every snapshot read, so the fold
/// keeps no state of its own.
pub struct CortexStateFold;

impl SessionLogFold for CortexStateFold {
    fn read_mode(&self) -> LogReadMode {
        LogReadMode::Snapshot
    }

    fn source_kind(&self) -> ActivitySourceKind {
        ActivitySourceKind::CortexCode
    }

    fn fidelity(&self) -> Fidelity {
        // The CLI rewrites this snapshot authoritatively on every transition.
        Fidelity::Definitive
    }

    fn push(&mut self, chunk: &str) -> Option<ActivityState> {
        // The whole file is the state. A mid-write read can catch a partial or
        // empty file; returning None means the engine emits nothing this round
        // and retries on the next event.
        parse_state(chunk).ok()
    }

    fn reset(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::ActivityStatus;

    fn state_json(session_id: &str, status: &str, sequence: u64) -> String {
        format!(
            r#"{{"version":1,"sessionId":"{session_id}","status":"{status}","updatedAt":"t","sequence":{sequence},"cwd":"/repo"}}"#
        )
    }

    #[test]
    fn matches_only_activity_state_json() {
        assert!(is_state_path(Path::new(
            "/x/sessions/abc/activity/state.json"
        )));
        assert!(!is_state_path(Path::new("/x/sessions/abc/meta.json")));
        assert!(!is_state_path(Path::new("/x/sessions/abc/state.json")));
        assert!(!is_state_path(Path::new(
            "/x/sessions/abc/activity/events.jsonl"
        )));
    }

    #[test]
    fn folds_each_snapshot_fresh_and_skips_garbage() {
        let mut fold = CortexStateFold;
        assert_eq!(fold.read_mode(), LogReadMode::Snapshot);
        assert_eq!(fold.source_kind(), ActivitySourceKind::CortexCode);
        assert_eq!(fold.fidelity(), Fidelity::Definitive);

        let state = fold
            .push(&state_json("cortex-1", "working", 3))
            .expect("parsed snapshot");
        assert_eq!(state.session_id, "cortex-1");
        assert_eq!(state.status, ActivityStatus::Working);
        assert_eq!(state.sequence, 3);

        // A mid-write/garbage read emits nothing rather than crashing.
        assert!(fold.push("not json").is_none());

        // The next good snapshot parses fresh (the engine resets between reads).
        let state = fold
            .push(&state_json("cortex-1", "awaiting_input", 4))
            .expect("parsed snapshot");
        assert_eq!(state.status, ActivityStatus::AwaitingInput);
        assert_eq!(state.sequence, 4);
    }
}
