//! Extensible engine for deriving live session [`ActivityState`] from a CLI's
//! on-disk session file, and watching those files efficiently.
//!
//! Reverie observes agent lifecycle through three transport families. Adding a
//! new CLI means slotting it into one with a thin wrapper, never re-plumbing:
//!
//! - **Push** (Claude Code): the CLI POSTs lifecycle events to Reverie's hook
//!   server. Thin wrapper = the event→`ActivityState` translation in
//!   `crate::hook_server`. No file watching.
//! - **Snapshot file** (Cortex Code): the CLI rewrites a small current-state
//!   file each transition. Thin wrapper = a [`SessionLogFold`] in [`LogReadMode::Snapshot`]
//!   that parses the whole (small) file.
//! - **Append-log file** (Codex CLI): the CLI appends to a growing transcript.
//!   Thin wrapper = a [`SessionLogFold`] in [`LogReadMode::Append`] that folds
//!   only newly appended records.
//!
//! This module owns the file-family engine: a [`SessionLogWatcher`] that watches
//! only the *active* session files it is told to (register/unregister), tracks a
//! byte offset per file, and on change feeds the per-file fold only the bytes
//! since the last read. That keeps the cost proportional to *new output*, not to
//! accumulated history — the difference between O(new bytes) and re-folding a
//! 100 MB+ log on every append.

use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        Arc,
        mpsc::{self, Receiver, Sender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};

use crate::activity::ActivityState;
use crate::activity_source::{ActivitySourceKind, ActivityUpdate, Fidelity, SessionKey};

/// How a CLI's session file relates to its current state, which tells the engine
/// how to read it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogReadMode {
    /// The file is append-only (a growing transcript). The engine feeds the fold
    /// only the bytes appended since the last read.
    Append,
    /// The file is rewritten whole each transition (a compacted snapshot). The
    /// engine feeds the fold the whole file each change; it is small by design.
    Snapshot,
}

/// Per-file stateful folder: the engine feeds it newly-available text and gets
/// back the current [`ActivityState`]. This is the thin per-CLI piece, and it
/// carries the CLI's identity (`source_kind` + `fidelity`) so one watcher can
/// serve files from several CLIs at once. An `Append` fold accumulates across
/// `push` calls (keeping a partial-line buffer); a `Snapshot` fold parses the
/// whole content each call.
pub trait SessionLogFold: Send {
    fn read_mode(&self) -> LogReadMode;

    /// Which CLI this fold's file belongs to; tags every emitted [`ActivityUpdate`].
    fn source_kind(&self) -> ActivitySourceKind;

    /// How complete this fold's signal is, for multi-source merge precedence. A
    /// snapshot file the CLI rewrites authoritatively is `Definitive`; a folded
    /// transcript whose records are not first-class transitions is `Inferred`.
    fn fidelity(&self) -> Fidelity;

    /// Consume newly-available text and return the current state once the native
    /// session id is known (before that, there is nothing to bind to). For
    /// `Append`, `chunk` is the tail since the last call; for `Snapshot`, the
    /// whole file.
    fn push(&mut self, chunk: &str) -> Option<ActivityState>;

    /// Clear all accumulated state back to a fresh fold. The engine calls this
    /// before re-reading from the start: every time for a `Snapshot` file, and
    /// when an `Append` file shrank (truncated/rotated).
    fn reset(&mut self);
}

/// Recognizes a CLI's session files and makes a fresh per-file fold. Adding a
/// file-based CLI is implementing this plus its [`SessionLogFold`]. Composing
/// several of these (see [`CompositeLogSource`]) lets one watcher serve every
/// file-transport CLI.
pub trait SessionLogSource: Send + Sync {
    /// Whether `path` is one of this CLI's session files (e.g. `rollout-*.jsonl`).
    fn matches(&self, path: &Path) -> bool;
    /// A fresh fold for `path` (which `matches` has already accepted). The path is
    /// passed so a source can pick a per-file fold variant.
    fn new_fold(&self, path: &Path) -> Box<dyn SessionLogFold>;
}

/// A [`SessionLogSource`] composed of several others: it matches a path if any
/// sub-source does, and builds the fold from the first sub-source that matches.
/// This is how one watcher serves multiple file-transport CLIs (Codex rollouts
/// and Cortex snapshots) on a single thread and control.
pub struct CompositeLogSource {
    sources: Vec<Arc<dyn SessionLogSource>>,
}

impl CompositeLogSource {
    pub fn new(sources: Vec<Arc<dyn SessionLogSource>>) -> Self {
        Self { sources }
    }
}

impl SessionLogSource for CompositeLogSource {
    fn matches(&self, path: &Path) -> bool {
        self.sources.iter().any(|source| source.matches(path))
    }

    fn new_fold(&self, path: &Path) -> Box<dyn SessionLogFold> {
        self.sources
            .iter()
            .find(|source| source.matches(path))
            .expect("new_fold is only called after matches accepted the path")
            .new_fold(path)
    }
}

enum WatchCommand {
    Register(PathBuf),
    Unregister(PathBuf),
}

/// Cheaply-cloned control surface: register/unregister the active files to watch.
/// The launch path registers a session's file once its path is known; teardown
/// unregisters it, which drops its watch and bounded fold state.
#[derive(Clone)]
pub struct SessionLogControl {
    commands: Sender<WatchCommand>,
}

impl SessionLogControl {
    pub fn register(&self, path: PathBuf) {
        let _ = self.commands.send(WatchCommand::Register(path));
    }

    pub fn unregister(&self, path: PathBuf) {
        let _ = self.commands.send(WatchCommand::Unregister(path));
    }
}

/// Handle to a running watcher. Drain `events`; clone `control` to register
/// files. Dropping it stops the worker.
pub struct SessionLogWatcher {
    pub events: Receiver<ActivityUpdate>,
    pub control: SessionLogControl,
    _worker: JoinHandle<()>,
}

/// Coalesce window for appends; a burst of writes folds at most once per window.
const DEBOUNCE_MS: u64 = 120;

/// How often the watch loop reconciles each registered file's on-disk length
/// against what it last folded, as a safety net for change notifications the OS
/// dropped (see [`poll_changed_tails`]). Short enough that a missed transition
/// surfaces promptly, long enough to be effectively free for a handful of files.
const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// Start a watcher for `source`. It watches nothing until files are registered
/// via the returned control, so an idle app pays nothing and a busy one watches
/// exactly its active sessions.
pub fn start_session_log_watcher(source: Arc<dyn SessionLogSource>) -> Result<SessionLogWatcher> {
    let (events_tx, events_rx) = mpsc::channel::<ActivityUpdate>();
    let (command_tx, command_rx) = mpsc::channel::<WatchCommand>();

    let worker = thread::Builder::new()
        .name("reverie-session-log-watcher".to_owned())
        .spawn(move || run_watch_loop(source, events_tx, command_rx))
        .context("spawning session-log watcher thread")?;

    Ok(SessionLogWatcher {
        events: events_rx,
        control: SessionLogControl {
            commands: command_tx,
        },
        _worker: worker,
    })
}

/// Per-file watch state: where we last read to, and its running fold.
struct FileTail {
    offset: u64,
    fold: Box<dyn SessionLogFold>,
}

fn run_watch_loop(
    source: Arc<dyn SessionLogSource>,
    events_tx: Sender<ActivityUpdate>,
    command_rx: Receiver<WatchCommand>,
) {
    let (debounce_tx, debounce_rx) = mpsc::channel::<DebounceEventResult>();
    let mut debouncer: Debouncer<RecommendedWatcher, RecommendedCache> =
        match new_debouncer(Duration::from_millis(DEBOUNCE_MS), None, debounce_tx) {
            Ok(debouncer) => debouncer,
            Err(_) => return,
        };

    let mut tails: HashMap<PathBuf, FileTail> = HashMap::new();
    // Reference count of directories we hold a watch on. We watch the *parent
    // directory* of each registered file, not the file itself (see `register_file`),
    // and several session files can share one directory (e.g. two Codex rollouts
    // written on the same day), so a dir's watch is dropped only when its last
    // registered file is unregistered.
    let mut watched_dirs: HashMap<PathBuf, usize> = HashMap::new();
    let mut last_poll = Instant::now();

    loop {
        // Drain any pending register/unregister commands first so a newly
        // registered file is read immediately, not only on its next event.
        loop {
            match command_rx.try_recv() {
                Ok(WatchCommand::Register(path)) => {
                    register_file(
                        &source,
                        &mut debouncer,
                        &mut tails,
                        &mut watched_dirs,
                        &events_tx,
                        path,
                    );
                }
                Ok(WatchCommand::Unregister(path)) => {
                    unregister_file(&mut debouncer, &mut tails, &mut watched_dirs, &path);
                }
                Err(mpsc::TryRecvError::Empty) => break,
                // Control dropped on the shell side -> shut the worker down.
                Err(mpsc::TryRecvError::Disconnected) => return,
            }
        }

        match debounce_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Ok(events)) => {
                let mut touched: Vec<PathBuf> = Vec::new();
                for batched in events {
                    if !matches!(
                        batched.event.kind,
                        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Other
                    ) {
                        continue;
                    }
                    for path in &batched.event.paths {
                        if tails.contains_key(path) && !touched.contains(path) {
                            touched.push(path.clone());
                        }
                    }
                }
                for path in touched {
                    fold_new_bytes(&mut tails, &events_tx, &path);
                }
            }
            Ok(Err(_)) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }

        // Safety-net poll: reconcile any file whose length drifted from what we
        // last folded but for which no change event arrived. The recv_timeout
        // above bounds the loop, so this runs about once per `POLL_INTERVAL`.
        if last_poll.elapsed() >= POLL_INTERVAL {
            poll_changed_tails(&mut tails, &events_tx);
            last_poll = Instant::now();
        }
    }

    drop(debouncer);
}

/// Resolve a registered file path to the (directory, full-path) pair the watcher
/// keys on, with the directory portion canonicalized.
///
/// macOS's FSEvents reports the *resolved* path of a changed file (symlinks
/// followed, e.g. `/tmp` -> `/private/tmp`), so an event path will not string-
/// match a registered path that still contains a symlink. We canonicalize the
/// parent directory (stable: it outlives the file and survives the file being
/// rotated away) and rejoin the file name, so the key we store equals the path
/// FSEvents will deliver. The directory is also what we watch.
fn canonical_dir_and_key(path: &Path) -> Option<(PathBuf, PathBuf)> {
    let parent = path.parent()?;
    let name = path.file_name()?;
    let dir = std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    let key = dir.join(name);
    Some((dir, key))
}

fn register_file(
    source: &Arc<dyn SessionLogSource>,
    debouncer: &mut Debouncer<RecommendedWatcher, RecommendedCache>,
    tails: &mut HashMap<PathBuf, FileTail>,
    watched_dirs: &mut HashMap<PathBuf, usize>,
    events_tx: &Sender<ActivityUpdate>,
    path: PathBuf,
) {
    if !source.matches(&path) {
        return;
    }
    let Some((dir, key)) = canonical_dir_and_key(&path) else {
        return;
    };
    if tails.contains_key(&key) {
        return;
    }
    // Watch the file's parent directory, not the file itself. On macOS the
    // FSEvents backend does not reliably report plain appends to a file watched
    // by its exact path, so a Codex rollout's turn-end record (`task_complete`)
    // could be written without ever waking the watcher, stranding the session in
    // "working". Watching the directory non-recursively catches every write to
    // its children; the event loop filters back down to the files in `tails`.
    let already_watched = watched_dirs.contains_key(&dir);
    if !already_watched && debouncer.watch(&dir, RecursiveMode::NonRecursive).is_err() {
        return;
    }
    *watched_dirs.entry(dir).or_insert(0) += 1;
    tails.insert(
        key.clone(),
        FileTail {
            offset: 0,
            fold: source.new_fold(&key),
        },
    );
    // Establish current state immediately (covers a session already mid-run when
    // it is registered, e.g. after a Reverie restart).
    fold_new_bytes(tails, events_tx, &key);
}

/// Stop tailing a file: drop its fold and, when it was the last file registered
/// under its directory, release that directory's watch.
fn unregister_file(
    debouncer: &mut Debouncer<RecommendedWatcher, RecommendedCache>,
    tails: &mut HashMap<PathBuf, FileTail>,
    watched_dirs: &mut HashMap<PathBuf, usize>,
    path: &Path,
) {
    let Some((dir, key)) = canonical_dir_and_key(path) else {
        return;
    };
    if tails.remove(&key).is_none() {
        return;
    }
    if let Some(count) = watched_dirs.get_mut(&dir) {
        *count -= 1;
        if *count == 0 {
            watched_dirs.remove(&dir);
            let _ = debouncer.unwatch(&dir);
        }
    }
}

/// Read the bytes a file has gained since we last looked, feed them to its fold,
/// and emit the resulting state. Append mode reads from the saved offset;
/// Snapshot mode (and a truncated/rotated file) reads from the start with a
/// fresh fold.
fn fold_new_bytes(
    tails: &mut HashMap<PathBuf, FileTail>,
    events_tx: &Sender<ActivityUpdate>,
    path: &Path,
) {
    let Some(tail) = tails.get_mut(path) else {
        return;
    };

    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return,
    };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);

    // Snapshot files are rewritten whole; an Append file that shrank was
    // truncated/rotated. Either way, rewind the fold and re-read from the start.
    if tail.fold.read_mode() == LogReadMode::Snapshot || len < tail.offset {
        tail.offset = 0;
        tail.fold.reset();
    }

    if file.seek(SeekFrom::Start(tail.offset)).is_err() {
        return;
    }
    let mut chunk = String::new();
    if file.read_to_string(&mut chunk).is_err() {
        // Non-UTF-8 / mid-write boundary: skip this round, retry on next event.
        return;
    }
    tail.offset = len;

    if let Some(state) = tail.fold.push(&chunk) {
        // File sources only ever learn the CLI's own session id; the shell binds
        // it to a Reverie session via the launch-captured native ref. The fold
        // carries its own CLI identity so one watcher can serve several CLIs.
        let _ = events_tx.send(ActivityUpdate::State {
            source: tail.fold.source_kind(),
            key: SessionKey::Native(state.session_id.clone()),
            fidelity: tail.fold.fidelity(),
            state,
        });
    }
}

/// Reconcile registered files whose on-disk length no longer matches what we last
/// folded, as a safety net for change notifications the OS dropped.
///
/// macOS FSEvents is best-effort: under load, or for a file that existed before
/// the watch began and is appended to much later, a modify event can simply never
/// arrive. That stranded a resumed Codex rollout once: its post-resume
/// `task_started` was written but no event woke the watcher, so the session sat
/// in its pre-resume "idle" state while the agent was really working. Comparing
/// each tail's current length to its folded offset and catching up the difference
/// guarantees the dashboard converges to the file's true state within a poll.
///
/// The normal FSEvents path keeps every tail's offset current, so for all but a
/// genuinely-missed file `len == offset` and this does nothing beyond a `stat`.
fn poll_changed_tails(tails: &mut HashMap<PathBuf, FileTail>, events_tx: &Sender<ActivityUpdate>) {
    let stale: Vec<PathBuf> = tails
        .iter()
        .filter(|(path, tail)| {
            std::fs::metadata(path)
                .map(|meta| meta.len() != tail.offset)
                .unwrap_or(false)
        })
        .map(|(path, _)| path.clone())
        .collect();
    for path in stale {
        fold_new_bytes(tails, events_tx, &path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::ActivityStatus;
    use crate::codex_rollout::CodexLogSource;
    use std::fs;
    use std::io::Write;
    use tempfile::TempDir;

    const META: &str = r#"{"type":"session_meta","payload":{"id":"poll-codex","cwd":"/p"}}"#;

    // The poll fallback must recover the true state even when no change event ever
    // arrives for an append (the dropped-FSEvents case that stranded a resumed
    // Codex session in "idle"). We fold a file once to set the offset, append the
    // turn-end record WITHOUT notifying the watcher, then poll and assert it folds
    // the missed bytes through to AwaitingInput.
    #[test]
    fn poll_recovers_an_append_with_no_change_event() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("rollout-poll.jsonl");
        {
            let mut f = fs::File::create(&path).unwrap();
            writeln!(f, "{META}").unwrap();
            writeln!(
                f,
                r#"{{"type":"event_msg","payload":{{"type":"task_started"}}}}"#
            )
            .unwrap();
            f.flush().unwrap();
        }

        let (tx, rx) = mpsc::channel::<ActivityUpdate>();
        let mut tails: HashMap<PathBuf, FileTail> = HashMap::new();
        tails.insert(
            path.clone(),
            FileTail {
                offset: 0,
                fold: CodexLogSource.new_fold(&path),
            },
        );

        // Initial fold: working, offset advanced to EOF.
        fold_new_bytes(&mut tails, &tx, &path);
        match rx.recv().unwrap() {
            ActivityUpdate::State { state, .. } => {
                assert_eq!(state.status, ActivityStatus::Working)
            }
            other => panic!("unexpected: {other:?}"),
        }

        // The turn ends, but pretend the OS dropped the notification: append and
        // do NOT call fold_new_bytes. The poll alone must catch it.
        {
            let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
            writeln!(
                f,
                r#"{{"type":"event_msg","payload":{{"type":"task_complete"}}}}"#
            )
            .unwrap();
            f.flush().unwrap();
        }

        poll_changed_tails(&mut tails, &tx);
        match rx.recv().unwrap() {
            ActivityUpdate::State { state, .. } => {
                assert_eq!(state.status, ActivityStatus::AwaitingInput)
            }
            other => panic!("unexpected: {other:?}"),
        }

        // Nothing new since the last fold: the poll is now a no-op (no emit).
        poll_changed_tails(&mut tails, &tx);
        assert!(
            rx.try_recv().is_err(),
            "poll re-emitted with no file change"
        );
    }
}
