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
    time::Duration,
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

    loop {
        // Drain any pending register/unregister commands first so a newly
        // registered file is read immediately, not only on its next event.
        loop {
            match command_rx.try_recv() {
                Ok(WatchCommand::Register(path)) => {
                    register_file(&source, &mut debouncer, &mut tails, &events_tx, path);
                }
                Ok(WatchCommand::Unregister(path)) => {
                    tails.remove(&path);
                    let _ = debouncer.unwatch(&path);
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
    }

    drop(debouncer);
}

fn register_file(
    source: &Arc<dyn SessionLogSource>,
    debouncer: &mut Debouncer<RecommendedWatcher, RecommendedCache>,
    tails: &mut HashMap<PathBuf, FileTail>,
    events_tx: &Sender<ActivityUpdate>,
    path: PathBuf,
) {
    if tails.contains_key(&path) || !source.matches(&path) {
        return;
    }
    // Watch the file directly; rollout/snapshot files are written in place.
    if debouncer.watch(&path, RecursiveMode::NonRecursive).is_err() {
        return;
    }
    tails.insert(
        path.clone(),
        FileTail {
            offset: 0,
            fold: source.new_fold(&path),
        },
    );
    // Establish current state immediately (covers a session already mid-run when
    // it is registered, e.g. after a Reverie restart).
    fold_new_bytes(tails, events_tx, &path);
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
