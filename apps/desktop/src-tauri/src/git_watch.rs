//! Background git status polling for project folders.
//!
//! When a project folder is a git repository, Reverie surfaces its branch, sync
//! state, and dirty line counts. This module owns the calm poll loop that keeps
//! that snapshot fresh and pushes changes to the WebView via the
//! `git_status_changed` event.
//!
//! It is deliberately restrained: it recomputes only "watched" projects (those
//! the UI is currently showing, plus any with a running session that might be
//! changing files), on a multi-second cadence, and not at all while the app is
//! unfocused. Mutating sync (pull/push) lives elsewhere and shells out to the
//! user's own `git`; this module is read-only.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::time::Duration;

use reverie_core::{
    RepoStatus, SessionStatus, WorkspaceService, WorkspaceSnapshot, compute_repo_status,
};
use tauri::{AppHandle, Emitter, Manager, State};

/// How often the watched set is recomputed while the app is focused. Git context
/// does not need to be real-time; a few seconds keeps it fresh without burning a
/// core while agents churn the working tree.
const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// The event the WebView listens on for per-project git updates.
const GIT_STATUS_EVENT: &str = "git_status_changed";

/// Per-project git snapshot pushed to the WebView. `status` is `None` when the
/// folder is not a git repository, so the UI can drop the repo strip cleanly.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEvent {
    pub project_id: String,
    pub status: Option<RepoStatus>,
}

/// Managed state for the poll loop: the last status emitted per project (so we
/// only emit on change), whether polling is active (the window is focused), the
/// UI-declared watched set, and the channel used to wake the loop immediately.
pub struct GitWatch {
    cache: Mutex<HashMap<String, Option<RepoStatus>>>,
    declared: Mutex<HashSet<String>>,
    active: AtomicBool,
    wake: Mutex<Option<Sender<()>>>,
}

impl Default for GitWatch {
    fn default() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            declared: Mutex::new(HashSet::new()),
            active: AtomicBool::new(true),
            wake: Mutex::new(None),
        }
    }
}

impl GitWatch {
    /// Suspend or resume polling with the window's focus. Resuming wakes the loop
    /// for an immediate catch-up, since agents may have changed files while the
    /// app was in the background and we cannot trust missed ticks.
    pub fn set_active(&self, active: bool) {
        let was = self.active.swap(active, Ordering::SeqCst);
        if active && !was {
            self.signal();
        }
    }

    fn signal(&self) {
        if let Some(tx) = self.wake.lock().unwrap().as_ref() {
            let _ = tx.send(());
        }
    }
}

/// Start the poll loop: store the wake channel on the managed `GitWatch` and
/// spawn the worker thread. Call once during setup.
pub fn start(app: &AppHandle) {
    let (tx, rx) = channel::<()>();
    *app.state::<GitWatch>().wake.lock().unwrap() = Some(tx);
    let app = app.clone();
    std::thread::Builder::new()
        .name("reverie-git-watch".to_owned())
        .spawn(move || run(app, rx))
        .ok();
}

fn run(app: AppHandle, rx: Receiver<()>) {
    loop {
        match rx.recv_timeout(POLL_INTERVAL) {
            Ok(()) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        let watch = app.state::<GitWatch>();
        if !watch.active.load(Ordering::SeqCst) {
            continue;
        }
        poll_once(&app, &watch);
    }
}

/// Recompute every watched project once and emit the ones whose status changed.
fn poll_once(app: &AppHandle, watch: &GitWatch) {
    let Some(service) = app.try_state::<WorkspaceService>() else {
        return;
    };
    let Ok(snapshot) = service.snapshot() else {
        return;
    };

    let paths: HashMap<String, std::path::PathBuf> = snapshot
        .projects
        .iter()
        .map(|project| (project.id.to_string(), project.path.clone()))
        .collect();

    for project_id in watched_projects(watch, &snapshot) {
        let Some(path) = paths.get(&project_id) else {
            continue;
        };
        let status = compute_repo_status(path);
        emit_if_changed(app, watch, project_id, status);
    }
}

/// Update the cache and emit only when a project's status actually changed, so a
/// quiet repo produces no event traffic.
fn emit_if_changed(
    app: &AppHandle,
    watch: &GitWatch,
    project_id: String,
    status: Option<RepoStatus>,
) {
    {
        let mut cache = watch.cache.lock().unwrap();
        if cache.get(&project_id) == Some(&status) {
            return;
        }
        cache.insert(project_id.clone(), status.clone());
    }
    let _ = app.emit(GIT_STATUS_EVENT, GitStatusEvent { project_id, status });
}

/// The set of projects worth polling: those the UI declared visible, plus any
/// project with a running session (its agent may be changing files even while the
/// project is collapsed in the nav).
fn watched_projects(watch: &GitWatch, snapshot: &WorkspaceSnapshot) -> HashSet<String> {
    let mut watched = watch.declared.lock().unwrap().clone();

    let focus_project: HashMap<_, _> = snapshot
        .focuses
        .iter()
        .filter_map(|focus| focus.project_id.map(|pid| (focus.id, pid)))
        .collect();
    for session in &snapshot.sessions {
        if session.status == SessionStatus::Running {
            if let Some(project_id) = focus_project.get(&session.focus_id) {
                watched.insert(project_id.to_string());
            }
        }
    }
    watched
}

/// The WebView declares which projects it currently wants watched (expanded in
/// the nav, or the open dashboard). Replaces the previous set and wakes the loop
/// so newly revealed projects get status promptly.
#[tauri::command]
pub(crate) fn set_git_watch_projects(project_ids: Vec<String>, watch: State<'_, GitWatch>) {
    *watch.declared.lock().unwrap() = project_ids.into_iter().collect();
    watch.signal();
}

/// Compute one project's git status immediately and return it, also emitting the
/// usual event so every listener stays in sync. Used for instant feedback when a
/// project is opened or expanded.
#[tauri::command]
pub(crate) fn git_status(
    project_id: String,
    app: AppHandle,
    service: State<'_, WorkspaceService>,
    watch: State<'_, GitWatch>,
) -> Option<RepoStatus> {
    let path = project_path(&service, &project_id)?;
    let status = compute_repo_status(&path);
    emit_if_changed(&app, &watch, project_id, status.clone());
    status
}

/// Resolve a project id to its folder path, if the project still exists.
fn project_path(service: &WorkspaceService, project_id: &str) -> Option<PathBuf> {
    service
        .snapshot()
        .ok()?
        .projects
        .iter()
        .find(|project| project.id.to_string() == project_id)
        .map(|project| project.path.clone())
}

/// Run a git subcommand in `path` and surface stderr on failure. We deliberately
/// shell out to the user's own `git` for mutating sync so their credential
/// helper, SSH agent, and hooks behave exactly as they expect.
fn run_git(path: &Path, args: &[&str]) -> Result<(), String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|err| format!("could not run git: {err}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = stderr.trim();
    Err(if message.is_empty() {
        "git command failed".to_owned()
    } else {
        message.to_owned()
    })
}

/// Recompute a project's status now and push it to the WebView. Called after a
/// mutating sync so the strip reflects the new state without waiting for a tick.
fn refresh(app: &AppHandle, watch: &GitWatch, project_id: String, path: &Path) {
    let status = compute_repo_status(path);
    emit_if_changed(app, watch, project_id, status);
}

/// Pull the current branch fast-forward only. The UI gates this on a clean tree;
/// `--ff-only` is the extra backstop so a pull never creates a merge commit or
/// leaves the working tree half-merged.
#[tauri::command]
pub(crate) fn git_pull(
    project_id: String,
    app: AppHandle,
    service: State<'_, WorkspaceService>,
    watch: State<'_, GitWatch>,
) -> Result<(), String> {
    let path = project_path(&service, &project_id).ok_or("project not found")?;
    let result = run_git(&path, &["pull", "--ff-only"]);
    refresh(&app, &watch, project_id, &path);
    result
}

/// Push the current branch to its upstream. Only committed objects are sent, so a
/// dirty working tree is irrelevant here.
#[tauri::command]
pub(crate) fn git_push(
    project_id: String,
    app: AppHandle,
    service: State<'_, WorkspaceService>,
    watch: State<'_, GitWatch>,
) -> Result<(), String> {
    let path = project_path(&service, &project_id).ok_or("project not found")?;
    let result = run_git(&path, &["push"]);
    refresh(&app, &watch, project_id, &path);
    result
}
