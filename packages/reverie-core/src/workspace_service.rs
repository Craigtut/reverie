//! Workspace business logic over a [`WorkspaceRepository`].
//!
//! This is the home for everything that used to live tangled inside the Tauri
//! shell's `AppShellStore`: input validation, boot-time session normalization,
//! the activity sequence-guard, and orchestration of incremental repository
//! writes. It depends only on the repository trait and the agent adapters, so
//! it is fully testable against [`InMemoryWorkspaceRepository`] without Tauri
//! or a real database, and it is `Send + Sync` for use as Tauri managed state.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Map, Value};

use crate::activity::{ActivityState, ActivityStatus, TurnStatus};
use crate::agents::{
    CortexSessionMetadata, DiscoveryContext, build_spawn_spec, built_in_adapters, require_detected,
};
use crate::bookmark::{BookmarkProvider, NoopBookmarkProvider};
use crate::codex_rollout::find_codex_rollout_by_native_id;
use crate::domain::{
    AgentKind, Focus, FocusId, LaunchMode, NativeSessionRef, Project, ProjectId, Session,
    SessionId, SessionStateTimeline, SessionStatus, ThemeMode, Workspace, WorkspaceId,
    WorkspaceSnapshot,
};
use crate::repository::WorkspaceRepository;
use crate::terminal::TerminalSpawnSpec;

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
fn activity_is_out_of_order(existing: &ActivityState, incoming: &ActivityState) -> bool {
    match (
        crate::time::iso8601_to_epoch_millis(&existing.updated_at),
        crate::time::iso8601_to_epoch_millis(&incoming.updated_at),
    ) {
        (Some(prev), Some(next)) if prev != next => next < prev,
        _ => incoming.sequence < existing.sequence,
    }
}

/// Stable id for the single local workspace, so it is identical across restarts
/// regardless of which backend seeded it.
const SEED_WORKSPACE_ID: &str = "0f70f21f-55c0-4e2a-923e-73360342db80";

/// Default terminal font size (CSS px) for a freshly seeded workspace, matching
/// the renderer's default. The frontend clamps to its supported range.
const DEFAULT_TERMINAL_FONT_SIZE: u16 = 14;

/// Bounds the persisted terminal font size to the renderer's supported range so
/// a hand-edited or out-of-range request can never store a degenerate cell.
const MIN_TERMINAL_FONT_SIZE: u16 = 9;
const MAX_TERMINAL_FONT_SIZE: u16 = 24;

/// Default left-panel width (CSS px) for a freshly seeded workspace, matching
/// the shell's default grid column.
const DEFAULT_SIDEBAR_WIDTH: u16 = 288;

/// Bounds the persisted left-panel width. The minimum keeps the rail's rows
/// readable; the maximum is a generous safety cap so a runaway drag can never
/// store a width that swallows the whole window.
const MIN_SIDEBAR_WIDTH: u16 = 220;
const MAX_SIDEBAR_WIDTH: u16 = 560;

#[derive(Clone)]
pub struct WorkspaceService {
    repo: Arc<dyn WorkspaceRepository>,
    /// Mints and resolves folder-identity bookmarks so a project can follow its
    /// folder across a rename or move. Defaults to a no-op (auto-reconnect inert,
    /// manual relocation still works); the desktop app injects the real macOS
    /// provider via [`WorkspaceService::with_bookmark_provider`].
    bookmark: Arc<dyn BookmarkProvider>,
}

/// A session's terminal spawn spec plus the context the runtime needs to derive
/// a live session title from the CLI's OSC titles.
#[derive(Clone, Debug)]
pub struct AgentLaunch {
    pub spec: TerminalSpawnSpec,
    pub agent_kind: AgentKind,
    /// The session working-directory basename, used to suppress CLIs that
    /// default their title to the folder name (e.g. Codex).
    pub folder_name: String,
    /// The native session id Reverie minted and injected for a brand-new launch
    /// (`--session-id` for Claude), or `None` on resume and for CLIs that cannot
    /// accept an injected id. The caller persists it with
    /// [`WorkspaceService::attach_native_session_id`] after a successful spawn so
    /// the pairing is recorded deterministically, without a filesystem guess.
    pub injected_native_id: Option<String>,
}

impl WorkspaceService {
    pub fn new(repo: Arc<dyn WorkspaceRepository>) -> Self {
        Self {
            repo,
            bookmark: Arc::new(NoopBookmarkProvider),
        }
    }

    /// Attach the folder-identity bookmark provider used for auto-reconnect.
    /// Builder-style so `new` stays source-compatible for the secondary
    /// constructions (the activity correlator, tests) that don't need it.
    #[must_use]
    pub fn with_bookmark_provider(mut self, bookmark: Arc<dyn BookmarkProvider>) -> Self {
        self.bookmark = bookmark;
        self
    }

    /// Seed the workspace row on first run, then reconcile any sessions left in
    /// a transient state by an unclean shutdown. Idempotent.
    pub fn ensure_seeded(&self) -> Result<()> {
        let seed = Workspace {
            id: seed_workspace_id(),
            name: "Local workspace".to_owned(),
            general_label: "General".to_owned(),
            default_dangerous_mode: false,
            disabled_agent_kinds: Vec::new(),
            theme: ThemeMode::Dark,
            // First entry in the agent priority order (Claude Code, then Codex,
            // then Cortex). The frontend re-points it if it is off or missing.
            default_agent_kind: AgentKind::ClaudeCode,
            terminal_font_size: DEFAULT_TERMINAL_FONT_SIZE,
            sidebar_width: DEFAULT_SIDEBAR_WIDTH,
            nav_state: None,
            keep_awake_enabled: false,
            keep_display_awake: false,
        };
        self.repo.ensure_seeded(&seed)?;
        self.ensure_general_focus(&seed.general_label)?;
        self.normalize_sessions()?;
        // Reconnect any project whose folder moved or was renamed while Reverie
        // was closed, before the first snapshot reaches the UI. Best-effort: a
        // failure here must not block boot.
        if let Err(error) = self.reconcile_project_folders() {
            eprintln!("[reverie] project folder reconcile at boot failed: {error:#}");
        }
        Ok(())
    }

    /// The General project (`project_id == None`) is a place to spin up sessions
    /// that are not tied to a folder. It always has exactly one focus, created
    /// here on first run; the UI keeps that focus implicit and lists General's
    /// sessions directly. Idempotent: a no-op once a non-archived general focus
    /// exists.
    fn ensure_general_focus(&self, general_label: &str) -> Result<()> {
        let snapshot = self.repo.load_snapshot()?;
        let has_general = snapshot
            .focuses
            .iter()
            .any(|focus| focus.project_id.is_none() && !focus.archived);
        if !has_general {
            self.repo.upsert_focus(&Focus::general(general_label, 0))?;
        }
        Ok(())
    }

    pub fn snapshot(&self) -> Result<WorkspaceSnapshot> {
        let mut snapshot = self.repo.load_snapshot()?;
        annotate_folder_missing(&mut snapshot.projects);
        Ok(snapshot)
    }

    pub fn create_project(&self, name: String, path: PathBuf) -> Result<WorkspaceSnapshot> {
        let name = required_text(name, "project name")?;
        if path.as_os_str().is_empty() {
            bail!("project path is required");
        }
        let snapshot = self.repo.load_snapshot()?;
        // An active project already points at this folder: surface the clash.
        if let Some(active) = snapshot
            .projects
            .iter()
            .find(|project| !project.archived && paths_equivalent(&project.path, &path))
        {
            bail!(
                "project path is already in Reverie: {}",
                active.path.display()
            );
        }
        let next_sort_order = snapshot
            .projects
            .iter()
            .filter(|project| !project.archived)
            .map(|project| project.sort_order)
            .max()
            .map_or(0, |current| current + 10);
        // Re-adding the folder of an archived project reconnects it rather than
        // spawning a duplicate: flip its own bit back (its topics and sessions
        // return by ancestry, untouched) and float it to the top of the rail. We
        // keep the existing record's name (preserving any rename the user made)
        // and only refresh its position.
        if let Some(existing) = snapshot
            .projects
            .iter()
            .find(|project| project.archived && paths_equivalent(&project.path, &path))
        {
            let mut project = existing.clone();
            project.archived = false;
            project.sort_order = next_sort_order;
            // Refresh the folder-identity bookmark to the folder we just
            // reconnected through; keep the old one if minting isn't available.
            if let Some(bookmark) = self.bookmark.create(&project.path) {
                project.bookmark = Some(bookmark);
            }
            self.repo.upsert_project(&project)?;
            return self.snapshot();
        }
        // Mint a folder-identity bookmark now, while the folder is known-good, so
        // a later rename or move can be auto-reconnected.
        let bookmark = self.bookmark.create(&path);
        let mut project = Project::new(name, path);
        project.sort_order = next_sort_order;
        project.bookmark = bookmark;
        self.repo.upsert_project(&project)?;
        self.snapshot()
    }

    /// Repoint a project at a new folder location and return the refreshed
    /// snapshot. Used by the manual "Locate folder" repair and (via
    /// [`Self::relocate_inner`]) by automatic bookmark reconnection.
    pub fn relocate_project(
        &self,
        project_id: ProjectId,
        new_path: PathBuf,
    ) -> Result<WorkspaceSnapshot> {
        self.relocate_inner(project_id, new_path, true)?;
        self.snapshot()
    }

    /// Move a project's stored folder path to `new_path`, repointing the cwds of
    /// its sessions and (when `mint_bookmark`) refreshing the folder-identity
    /// bookmark. Returns no snapshot so it can run inside [`Self::snapshot`]-free
    /// paths (boot and the poll-loop reconcile) without recursion.
    fn relocate_inner(
        &self,
        project_id: ProjectId,
        new_path: PathBuf,
        mint_bookmark: bool,
    ) -> Result<()> {
        if new_path.as_os_str().is_empty() {
            bail!("new project path is required");
        }
        if !new_path.is_dir() {
            bail!("new project path is not a folder: {}", new_path.display());
        }
        let snapshot = self.repo.load_snapshot()?;
        let project = snapshot
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .with_context(|| format!("unknown project {project_id}"))?;
        // Refuse to point this project at a folder another active project already
        // owns; that would make two records resume into one folder.
        if let Some(clash) = snapshot.projects.iter().find(|other| {
            other.id != project_id && !other.archived && paths_equivalent(&other.path, &new_path)
        }) {
            bail!(
                "another project already points at that folder: {}",
                clash.path.display()
            );
        }
        let old_path = project.path.clone();
        if paths_equivalent(&old_path, &new_path) {
            return Ok(());
        }
        let mut updated = project.clone();
        updated.path = new_path.clone();
        if mint_bookmark {
            if let Some(bookmark) = self.bookmark.create(&new_path) {
                updated.bookmark = Some(bookmark);
            }
        }
        self.repo.upsert_project(&updated)?;

        // Repoint the cwds of this project's sessions that lived under the old
        // folder, so they reopen in place after the move. Sessions reach a
        // project through their focus.
        let focus_ids: BTreeSet<FocusId> = snapshot
            .focuses
            .iter()
            .filter(|focus| focus.project_id == Some(project_id))
            .map(|focus| focus.id)
            .collect();
        for session in &snapshot.sessions {
            if !focus_ids.contains(&session.focus_id) {
                continue;
            }
            if let Some(new_cwd) = repoint_under(&session.cwd, &old_path, &new_path) {
                let mut moved = session.clone();
                moved.cwd = new_cwd;
                self.repo.upsert_session(&moved)?;
            }
        }
        Ok(())
    }

    /// Reconcile every active project's stored path against the filesystem.
    /// Backfills a folder-identity bookmark for projects whose folder still
    /// exists, and auto-reconnects any whose folder moved by resolving its
    /// bookmark to the new location. Returns whether any project was relocated,
    /// so a caller can push a refreshed snapshot to the UI. Per-project failures
    /// are logged and skipped, never propagated.
    pub fn reconcile_project_folders(&self) -> Result<bool> {
        let snapshot = self.repo.load_snapshot()?;
        let mut relocated = false;
        for project in &snapshot.projects {
            if project.archived {
                continue;
            }
            if project.path.is_dir() {
                // Folder is fine: opportunistically mint a bookmark for projects
                // created before this feature (or on a platform that had none) so
                // a future move is recoverable.
                if project.bookmark.is_none() {
                    if let Some(bookmark) = self.bookmark.create(&project.path) {
                        let mut updated = project.clone();
                        updated.bookmark = Some(bookmark);
                        if let Err(error) = self.repo.upsert_project(&updated) {
                            eprintln!(
                                "[reverie] bookmark backfill failed for {}: {error:#}",
                                project.path.display()
                            );
                        }
                    }
                }
                continue;
            }
            // Folder is missing: try to follow it via its bookmark.
            let Some(blob) = project.bookmark.as_deref() else {
                continue;
            };
            let Some(resolved) = self.bookmark.resolve(blob) else {
                continue;
            };
            if !resolved.is_dir() || paths_equivalent(&resolved, &project.path) {
                continue;
            }
            match self.relocate_inner(project.id, resolved.clone(), true) {
                Ok(()) => {
                    relocated = true;
                    eprintln!(
                        "[reverie] reconnected project {} to {}",
                        project.id,
                        resolved.display()
                    );
                }
                Err(error) => eprintln!(
                    "[reverie] could not reconnect project {}: {error:#}",
                    project.id
                ),
            }
        }
        Ok(relocated)
    }

    pub fn create_focus(
        &self,
        project_id: Option<ProjectId>,
        title: String,
        description: Option<String>,
        default_dangerous_mode: Option<bool>,
    ) -> Result<WorkspaceSnapshot> {
        let title = required_text(title, "focus title")?;
        let snapshot = self.repo.load_snapshot()?;
        if let Some(project_id) = project_id {
            let project_ok = snapshot
                .projects
                .iter()
                .any(|project| project.id == project_id && !project.archived);
            if !project_ok {
                bail!("cannot create focus for unknown or archived project {project_id}");
            }
        }
        let sort_order = snapshot
            .focuses
            .iter()
            .filter(|focus| focus.project_id == project_id && !focus.archived)
            .map(|focus| focus.sort_order)
            .max()
            .map_or(0, |current| current + 10);

        let focus = Focus {
            id: FocusId::new_v4(),
            project_id,
            title,
            description: description.and_then(optional_text),
            sort_order,
            archived: false,
            default_dangerous_mode,
        };
        self.repo.upsert_focus(&focus)?;
        self.snapshot()
    }

    pub fn create_session(
        &self,
        focus_id: FocusId,
        title: String,
        agent_kind: AgentKind,
        cwd: PathBuf,
        dangerous_mode_override: Option<bool>,
    ) -> Result<WorkspaceSnapshot> {
        let title = required_text(title, "session title")?;
        if cwd.as_os_str().is_empty() {
            bail!("session cwd is required");
        }
        let snapshot = self.repo.load_snapshot()?;
        let focus_ok = snapshot
            .focuses
            .iter()
            .any(|focus| focus.id == focus_id && !focus.archived);
        if !focus_ok {
            bail!("cannot create session for unknown or archived focus {focus_id}");
        }

        let sort_order = snapshot
            .sessions
            .iter()
            .filter(|session| session.focus_id == focus_id && !session.archived)
            .map(|session| session.sort_order)
            .max()
            .map_or(0, |current| current + 10);
        let mut session = Session::new(focus_id, title, agent_kind, cwd);
        session.dangerous_mode_override = dangerous_mode_override;
        session.sort_order = sort_order;
        self.repo.upsert_session(&session)?;
        self.snapshot()
    }

    /// Archive or restore a session by flipping its single `archived` bit.
    /// Closing a session (tab bar or sidebar) archives it; the focus's archived
    /// list is the only place it shows afterward, and restore reverses this.
    pub fn set_session_archived(
        &self,
        session_id: SessionId,
        archived: bool,
    ) -> Result<WorkspaceSnapshot> {
        self.update_session(session_id, |session| {
            session.archived = archived;
        })
    }

    pub fn set_session_dangerous_mode(
        &self,
        session_id: SessionId,
        dangerous_mode_override: Option<bool>,
    ) -> Result<WorkspaceSnapshot> {
        self.update_session(session_id, |session| {
            session.dangerous_mode_override = dangerous_mode_override;
        })
    }

    /// Record that the user viewed a session, clearing its `finished`
    /// ("Ready for you") marker. `viewed_at` is the frontend clock's ISO 8601
    /// timestamp, stored verbatim so the persisted value matches the optimistic
    /// one the renderer already applied; it is compared against the activity
    /// feed's last turn-completion time to decide whether a later turn is unseen.
    pub fn mark_session_viewed(
        &self,
        session_id: SessionId,
        viewed_at: String,
    ) -> Result<WorkspaceSnapshot> {
        self.update_session(session_id, |session| {
            session.last_viewed_at = Some(viewed_at);
        })
    }

    pub fn set_workspace_default_dangerous_mode(
        &self,
        default_dangerous_mode: bool,
    ) -> Result<WorkspaceSnapshot> {
        let mut workspace = self.repo.load_snapshot()?.workspace;
        workspace.default_dangerous_mode = default_dangerous_mode;
        self.repo.save_workspace(&workspace)?;
        self.snapshot()
    }

    /// Persist the workspace appearance (light/dark). The renderer seeds its
    /// live theme from this value on load, so it survives restarts.
    pub fn set_workspace_theme(&self, theme: ThemeMode) -> Result<WorkspaceSnapshot> {
        let mut workspace = self.repo.load_snapshot()?.workspace;
        workspace.theme = theme;
        self.repo.save_workspace(&workspace)?;
        self.snapshot()
    }

    /// Persist the "keep my Mac awake while tasks run" toggles. `enabled` is the
    /// primary opt-in (hold a system-sleep assertion while sessions are alive);
    /// `keep_display` additionally keeps the display on. The desktop app reads
    /// these back and manages the native assertion; the domain only records intent.
    pub fn set_workspace_keep_awake(
        &self,
        enabled: bool,
        keep_display: bool,
    ) -> Result<WorkspaceSnapshot> {
        let mut workspace = self.repo.load_snapshot()?.workspace;
        workspace.keep_awake_enabled = enabled;
        workspace.keep_display_awake = keep_display;
        self.repo.save_workspace(&workspace)?;
        self.snapshot()
    }

    /// Persist the default agent kind seeded into the new-session composer. This
    /// only affects the starting value of future new-session forms; it does not
    /// touch any existing session.
    pub fn set_workspace_default_agent_kind(&self, kind: AgentKind) -> Result<WorkspaceSnapshot> {
        let mut workspace = self.repo.load_snapshot()?.workspace;
        workspace.default_agent_kind = kind;
        self.repo.save_workspace(&workspace)?;
        self.snapshot()
    }

    /// Persist the terminal font size (CSS px), clamped to the renderer's
    /// supported range so an out-of-range value can never store a degenerate
    /// cell. The renderer reads it back on load and re-derives the terminal cell.
    pub fn set_terminal_font_size(&self, font_size: u16) -> Result<WorkspaceSnapshot> {
        let mut workspace = self.repo.load_snapshot()?.workspace;
        workspace.terminal_font_size =
            font_size.clamp(MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE);
        self.repo.save_workspace(&workspace)?;
        self.snapshot()
    }

    /// Persist the left navigation panel's width (CSS px), clamped to a sane
    /// range so a runaway drag or hand-edited value can never store a width that
    /// crushes the rail or swallows the window. The shell reads it back on load
    /// and seeds the layout grid's first column from it.
    pub fn set_sidebar_width(&self, width: u16) -> Result<WorkspaceSnapshot> {
        let mut workspace = self.repo.load_snapshot()?.workspace;
        workspace.sidebar_width = width.clamp(MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
        self.repo.save_workspace(&workspace)?;
        self.snapshot()
    }

    /// Persist the opaque, frontend-owned UI view state (last selected
    /// focus/session, active surface, sidebar accordion). The renderer reads it
    /// back on load so the workspace reopens where the user left it. The domain
    /// stores it verbatim and never interprets it; `None` clears it.
    pub fn set_workspace_nav_state(&self, nav_state: Option<String>) -> Result<WorkspaceSnapshot> {
        let mut workspace = self.repo.load_snapshot()?.workspace;
        workspace.nav_state = nav_state;
        self.repo.save_workspace(&workspace)?;
        self.snapshot()
    }

    /// Switch a single agent CLI on or off for the workspace. Enabling removes
    /// it from the disabled set; disabling adds it. Idempotent. A disabled CLI
    /// is never offered as a session agent and never has its config files
    /// written; the caller is responsible for the latter (removing any bridge
    /// install), since the bridge installer lives outside the core crate.
    pub fn set_agent_cli_enabled(
        &self,
        kind: AgentKind,
        enabled: bool,
    ) -> Result<WorkspaceSnapshot> {
        let mut workspace = self.repo.load_snapshot()?.workspace;
        let disabled = &mut workspace.disabled_agent_kinds;
        if enabled {
            disabled.retain(|existing| *existing != kind);
        } else if !disabled.contains(&kind) {
            disabled.push(kind);
        }
        self.repo.save_workspace(&workspace)?;
        self.snapshot()
    }

    /// The set of agent kinds the user has switched off. Read by the command
    /// layer to mark detections and to refuse bridge installs for off CLIs.
    pub fn disabled_agent_kinds(&self) -> Result<Vec<AgentKind>> {
        Ok(self.repo.load_snapshot()?.workspace.disabled_agent_kinds)
    }

    /// Whether a given CLI is enabled (the common-case query). Absent from the
    /// disabled set means enabled.
    pub fn is_agent_cli_enabled(&self, kind: AgentKind) -> Result<bool> {
        Ok(!self.disabled_agent_kinds()?.contains(&kind))
    }

    pub fn remove_session(&self, session_id: SessionId) -> Result<WorkspaceSnapshot> {
        self.repo.delete_session(session_id)?;
        self.snapshot()
    }

    /// Archive a topic: set its own `archived` bit. Its sessions stay untouched
    /// and are hidden by ancestry, so restoring the topic brings them back.
    pub fn archive_focus(&self, focus_id: FocusId) -> Result<WorkspaceSnapshot> {
        self.repo.set_focus_archived(focus_id, true)?;
        self.snapshot()
    }

    /// Restore an archived topic. Its sessions reappear exactly as they were,
    /// except any session that was individually archived (own bit still set).
    pub fn restore_focus(&self, focus_id: FocusId) -> Result<WorkspaceSnapshot> {
        self.repo.set_focus_archived(focus_id, false)?;
        self.snapshot()
    }

    /// Permanently delete a topic and its sessions. Not reversible.
    pub fn delete_focus(&self, focus_id: FocusId) -> Result<WorkspaceSnapshot> {
        self.repo.delete_focus_cascade(focus_id)?;
        self.snapshot()
    }

    /// Rename a topic (focus). A topic must always have a name, so an empty or
    /// whitespace-only title is rejected rather than stored.
    pub fn rename_focus(&self, focus_id: FocusId, title: String) -> Result<WorkspaceSnapshot> {
        let title = required_text(title, "topic name")?;
        let mut focus = self
            .repo
            .load_snapshot()?
            .focuses
            .into_iter()
            .find(|focus| focus.id == focus_id)
            .ok_or_else(|| anyhow!("unknown topic {focus_id}"))?;
        focus.title = title;
        self.repo.upsert_focus(&focus)?;
        self.snapshot()
    }

    /// Archive a project: set its own `archived` bit. Its topics and sessions are
    /// hidden by ancestry, not by writes, so re-adding the folder (which restores
    /// the project) brings the whole subtree back as it was.
    pub fn archive_project(&self, project_id: ProjectId) -> Result<WorkspaceSnapshot> {
        self.repo.set_project_archived(project_id, true)?;
        self.snapshot()
    }

    /// Permanently delete a project together with its topics and sessions. Used
    /// by the Settings purge for an archived project; not reversible.
    pub fn delete_project(&self, project_id: ProjectId) -> Result<WorkspaceSnapshot> {
        self.repo.delete_project_cascade(project_id)?;
        self.snapshot()
    }

    /// Rename a project's display name. This changes only the label Reverie shows
    /// in the nav; the folder on disk (`path`) is the source of truth and is left
    /// untouched. A project must always have a name, so empty input is rejected.
    pub fn rename_project(&self, project_id: ProjectId, name: String) -> Result<WorkspaceSnapshot> {
        let name = required_text(name, "project name")?;
        let mut project = self
            .repo
            .load_snapshot()?
            .projects
            .into_iter()
            .find(|project| project.id == project_id)
            .ok_or_else(|| anyhow!("unknown project {project_id}"))?;
        project.name = name;
        self.repo.upsert_project(&project)?;
        self.snapshot()
    }

    /// Reorder focuses to match the given id order, used by drag-and-drop in the
    /// left nav. The frontend sends the full ordered id list for a single
    /// project (or General); unknown ids are skipped. Spacing the persisted
    /// `sort_order` by 10 leaves room between neighbors for future inserts
    /// without renumbering the whole list.
    pub fn reorder_focuses(&self, ordered_ids: Vec<FocusId>) -> Result<WorkspaceSnapshot> {
        let snapshot = self.repo.load_snapshot()?;
        for (index, id) in ordered_ids.iter().enumerate() {
            if let Some(focus) = snapshot.focuses.iter().find(|focus| focus.id == *id) {
                let mut updated = focus.clone();
                updated.sort_order = (index as i64) * 10;
                self.repo.upsert_focus(&updated)?;
            }
        }
        self.snapshot()
    }

    /// Reorder top-level projects to match the given id order (drag-and-drop in
    /// the left nav). Unknown ids are skipped; `sort_order` is spaced by 10.
    pub fn reorder_projects(&self, ordered_ids: Vec<ProjectId>) -> Result<WorkspaceSnapshot> {
        let snapshot = self.repo.load_snapshot()?;
        for (index, id) in ordered_ids.iter().enumerate() {
            if let Some(project) = snapshot.projects.iter().find(|project| project.id == *id) {
                let mut updated = project.clone();
                updated.sort_order = (index as i64) * 10;
                self.repo.upsert_project(&updated)?;
            }
        }
        self.snapshot()
    }

    /// Reorder sessions within a focus (topic) to match the given id order.
    pub fn reorder_sessions(&self, ordered_ids: Vec<SessionId>) -> Result<WorkspaceSnapshot> {
        let snapshot = self.repo.load_snapshot()?;
        for (index, id) in ordered_ids.iter().enumerate() {
            if let Some(session) = snapshot.sessions.iter().find(|session| session.id == *id) {
                let mut updated = session.clone();
                updated.sort_order = (index as i64) * 10;
                self.repo.upsert_session(&updated)?;
            }
        }
        self.snapshot()
    }

    /// Move a session to a different focus (topic) and drop it at `target_index`
    /// among that focus's non-archived sessions. The session keeps its cwd,
    /// resume ref, and live process: only its parent and order change. The
    /// destination order is renumbered so the moved session and its new
    /// neighbors keep room between them.
    pub fn move_session(
        &self,
        session_id: SessionId,
        target_focus_id: FocusId,
        target_index: usize,
    ) -> Result<WorkspaceSnapshot> {
        let snapshot = self.repo.load_snapshot()?;
        let focus_ok = snapshot
            .focuses
            .iter()
            .any(|focus| focus.id == target_focus_id && !focus.archived);
        if !focus_ok {
            bail!("cannot move session to unknown or archived focus {target_focus_id}");
        }
        if !snapshot
            .sessions
            .iter()
            .any(|session| session.id == session_id)
        {
            bail!("cannot move unknown session {session_id}");
        }

        // The destination's current order (already sort_order-ordered by
        // load_snapshot), minus the moved session, with it spliced back in.
        let mut order: Vec<SessionId> = snapshot
            .sessions
            .iter()
            .filter(|session| {
                session.focus_id == target_focus_id && !session.archived && session.id != session_id
            })
            .map(|session| session.id)
            .collect();
        let index = target_index.min(order.len());
        order.insert(index, session_id);

        if let Some(session) = snapshot.sessions.iter().find(|s| s.id == session_id) {
            let mut updated = session.clone();
            updated.focus_id = target_focus_id;
            self.repo.upsert_session(&updated)?;
        }
        let refreshed = self.repo.load_snapshot()?;
        for (position, id) in order.iter().enumerate() {
            if let Some(session) = refreshed.sessions.iter().find(|s| s.id == *id) {
                let mut updated = session.clone();
                updated.sort_order = (position as i64) * 10;
                self.repo.upsert_session(&updated)?;
            }
        }
        self.snapshot()
    }

    pub fn mark_session_running(&self, session_id: SessionId) -> Result<WorkspaceSnapshot> {
        self.update_session(session_id, |session| {
            session.status = SessionStatus::Running;
            session.last_exit_code = None;
        })
    }

    pub fn mark_session_finished(
        &self,
        session_id: SessionId,
        child_success: bool,
    ) -> Result<WorkspaceSnapshot> {
        self.update_session(session_id, |session| {
            session.status = if session.native_session_ref.is_some() {
                SessionStatus::Restorable
            } else {
                SessionStatus::Exited
            };
            session.last_exit_code = Some(if child_success { 0 } else { 1 });
            // Exited/Restorable both read as idle; stamp the moment it became so.
            session.note_exited(crate::time::now_iso8601());
        })
    }

    pub fn mark_session_failed(&self, session_id: SessionId) -> Result<WorkspaceSnapshot> {
        self.update_session(session_id, |session| {
            session.status = if session.launch_mode == LaunchMode::Resume
                || session.native_session_ref.is_some()
            {
                SessionStatus::RestoreFailed
            } else {
                SessionStatus::Exited
            };
            session.last_exit_code = Some(1);
            // A failed resume reads as attention (blocked); a plain exit as idle.
            let now = crate::time::now_iso8601();
            if session.status == SessionStatus::RestoreFailed {
                session.note_blocked(now);
            } else {
                session.note_exited(now);
            }
        })
    }

    /// Persist a session's display title, derived live from the OSC terminal
    /// title its agent CLI emits. Trims and ignores empty input so a CLI's blank
    /// or whitespace title never clears a good label (the terminal runtime
    /// already suppresses defaults before calling this). Touches `title` only.
    pub fn set_session_title(
        &self,
        session_id: SessionId,
        title: String,
    ) -> Result<WorkspaceSnapshot> {
        let title = required_text(title, "session title")?;
        self.update_session(session_id, |session| {
            session.title = title;
        })
    }

    /// Set or clear a user-chosen display name for a session. A non-empty `title`
    /// pins that name: it overrides the live OSC-derived `title` everywhere the
    /// session is shown. An empty or whitespace-only `title` clears the override,
    /// so the session falls back to its automatic title (which has kept tracking
    /// the CLI underneath). Touches `custom_title` only; the automatic `title` is
    /// left alone so "use automatic name" reveals the current one.
    pub fn rename_session(
        &self,
        session_id: SessionId,
        title: String,
    ) -> Result<WorkspaceSnapshot> {
        let custom_title = optional_text(title);
        self.update_session(session_id, |session| {
            session.custom_title = custom_title;
        })
    }

    /// Persist a generated title and its adapter-specific generation metadata in
    /// one write. Generated title callers use the metadata to avoid repeating
    /// cheap completion calls for the same transcript state.
    pub fn set_generated_session_title(
        &self,
        session_id: SessionId,
        expected_kind: AgentKind,
        title: String,
        generated_title_payload: Value,
    ) -> Result<WorkspaceSnapshot> {
        let title = required_text(title, "session title")?;
        let mut session = self
            .repo
            .get_session(session_id)?
            .ok_or_else(|| anyhow!("unknown Reverie session {session_id}"))?;
        if session.agent_kind != expected_kind {
            bail!(
                "cannot set {:?} generated title on {:?} session",
                expected_kind,
                session.agent_kind
            );
        }
        session.title = title;
        let Some(native) = session.native_session_ref.as_mut() else {
            bail!("cannot set generated title without a native session ref");
        };
        let mut payload = match std::mem::take(&mut native.adapter_payload) {
            Value::Object(object) => object,
            _ => Map::new(),
        };
        payload.insert("generatedTitle".to_owned(), generated_title_payload);
        native.adapter_payload = Value::Object(payload);
        self.repo.upsert_session(&session)?;
        self.snapshot()
    }

    /// Explicit Cortex capture (FE-triggered): read the session's `meta.json`,
    /// verify it matches the Reverie session, and attach it as a resume ref.
    pub fn capture_cortex_session(
        &self,
        shell_session_id: SessionId,
        cortex_session_id: String,
        metadata_path: Option<PathBuf>,
        cortex_home: PathBuf,
    ) -> Result<WorkspaceSnapshot> {
        let cortex_session_id = required_text(cortex_session_id, "Cortex session id")?;
        let metadata_path = metadata_path.unwrap_or_else(|| {
            CortexSessionMetadata::metadata_path(&cortex_home, &cortex_session_id)
        });
        let encoded = std::fs::read_to_string(&metadata_path).with_context(|| {
            format!(
                "failed to read Cortex session metadata at {}",
                metadata_path.display()
            )
        })?;
        let metadata = CortexSessionMetadata::from_json(&encoded).with_context(|| {
            format!(
                "failed to parse Cortex session metadata at {}",
                metadata_path.display()
            )
        })?;
        if metadata.id != cortex_session_id {
            bail!(
                "Cortex metadata id {} does not match requested session id {}",
                metadata.id,
                cortex_session_id
            );
        }
        let metadata_cwd = metadata.cwd.clone();
        let native_session_ref = metadata.into_native_ref(metadata_path);
        self.attach_native_session(
            shell_session_id,
            metadata_cwd,
            native_session_ref,
            AgentKind::CortexCode,
        )?;
        self.snapshot()
    }

    /// Attach a native session ref to a session, moving it to resume /
    /// restorable. Overwrites any existing ref: the explicit Cortex capture
    /// re-attaches deliberately, and the auto-discovery path
    /// ([`Self::discover_and_attach_native_session`]) skips already-attached
    /// sessions before calling this. Guards that the kind and cwd still match so
    /// an attach can't clobber a session that changed out from under it.
    pub fn attach_native_session(
        &self,
        session_id: SessionId,
        expected_cwd: PathBuf,
        native_session_ref: NativeSessionRef,
        expected_kind: AgentKind,
    ) -> Result<()> {
        let session = self
            .repo
            .get_session(session_id)?
            .ok_or_else(|| anyhow!("unknown Reverie session {session_id}"))?;
        if session.agent_kind != expected_kind {
            bail!(
                "cannot attach {:?} native session to {:?} session",
                expected_kind,
                session.agent_kind
            );
        }
        if session.cwd != expected_cwd {
            bail!(
                "Reverie session cwd {} does not match native session cwd {}",
                session.cwd.display(),
                expected_cwd.display()
            );
        }
        if !self
            .repo
            .claim_native_session(session_id, native_session_ref)?
        {
            bail!("native session id is already attached to a different Reverie session");
        }
        Ok(())
    }

    /// Run adapter-driven native-session discovery for a just-launched session
    /// and attach the result if found. If a token-bound hook already captured
    /// the same native id, discovery may still fill in that ref's metadata path
    /// so file-transport activity can be watched. It never repoints an existing
    /// ref to a different id from filesystem evidence.
    /// No-op (`Ok(false)`) when no matching evidence is found or the adapter has
    /// no filesystem discovery.
    /// `agent_home` is the relevant CLI home (e.g. CORTEX_HOME), resolved by the
    /// caller so core stays out of environment lookups.
    pub fn discover_and_attach_native_session(
        &self,
        session_id: SessionId,
        launched_after_ms: Option<i64>,
        agent_home: Option<PathBuf>,
    ) -> Result<bool> {
        let Some(session) = self.repo.get_session(session_id)? else {
            return Ok(false);
        };
        let existing_native_ref = session.native_session_ref.clone();
        let Some(adapter) = built_in_adapters()
            .into_iter()
            .find(|adapter| adapter.kind() == session.agent_kind)
        else {
            return Ok(false);
        };
        // Native ids already owned by other sessions. Filesystem discovery picks
        // the newest cwd-matching file by mtime, which cannot distinguish several
        // same-CLI sessions sharing one folder; the exclusion stops a launching
        // session from adopting a sibling's id (the cross-session collision that
        // makes two tabs `--resume` into one conversation).
        let claimed_native_ids: BTreeSet<String> = self
            .repo
            .load_snapshot()?
            .sessions
            .into_iter()
            .filter(|other| other.id != session_id)
            .filter_map(|other| {
                other
                    .native_session_ref
                    .and_then(|reference| reference.session_id)
            })
            .collect();
        let context = DiscoveryContext {
            cwd: session.cwd.clone(),
            launched_after_ms,
            agent_home,
            claimed_native_ids,
        };
        let Some(native_session_ref) = adapter.discover_native_session(&context)? else {
            return Ok(false);
        };
        if let Some(existing) = existing_native_ref {
            let existing_id = existing.session_id.as_deref();
            let discovered_id = native_session_ref.session_id.as_deref();
            // A token-bound hook may have already captured the native id before
            // the file scanner finds the associated metadata path. In that case
            // fill in the same native ref's path so file-transport activity can
            // be watched. Never repoint an existing ref from cwd/mtime discovery.
            if existing_id.is_some() && existing_id == discovered_id {
                if existing.metadata_path == native_session_ref.metadata_path
                    && existing.adapter_payload == native_session_ref.adapter_payload
                {
                    return Ok(false);
                }
                return Ok(self
                    .repo
                    .claim_native_session(session_id, native_session_ref)?);
            }
            return Ok(false);
        }
        // Defense in depth: even past the scanner's exclusion, never attach an id
        // that already resolves to a different session.
        if let Some(discovered_id) = native_session_ref.session_id.as_deref() {
            if let Some(owner) = self.repo.find_session_by_native_id(discovered_id)? {
                if owner.id != session_id {
                    return Ok(false);
                }
            }
        }
        Ok(self
            .repo
            .claim_native_session(session_id, native_session_ref)?)
    }

    /// Bind the rollout file path onto a Codex session that captured a native id
    /// but no metadata path.
    ///
    /// The launch-time cwd scan ([`Self::discover_and_attach_native_session`])
    /// picks the newest cwd-matching rollout, so when several Codex sessions share
    /// one folder it can hand a launching session a sibling's file (then refuse to
    /// repoint) or never find this session's at all, leaving an id-only ref.
    /// Without the path the rollout cannot be activity-watched and no title is ever
    /// generated. This resolves the file by the exact native id, which is
    /// collision-proof, and fills it in. Returns whether a path was newly bound.
    /// No-op unless the session is a Codex session whose ref has a native id but no
    /// metadata path.
    pub fn backfill_codex_rollout_path(
        &self,
        session_id: SessionId,
        codex_home: impl AsRef<Path>,
    ) -> Result<bool> {
        let Some(session) = self.repo.get_session(session_id)? else {
            return Ok(false);
        };
        if session.agent_kind != AgentKind::CodexCli {
            return Ok(false);
        }
        let Some(existing) = session.native_session_ref else {
            return Ok(false);
        };
        if existing.metadata_path.is_some() {
            return Ok(false);
        }
        let Some(native_id) = existing.session_id.clone() else {
            return Ok(false);
        };
        let Some(rollout_path) = find_codex_rollout_by_native_id(codex_home, &native_id) else {
            return Ok(false);
        };
        let reference = NativeSessionRef {
            kind: existing.kind,
            session_id: Some(native_id),
            metadata_path: Some(rollout_path),
            adapter_payload: existing.adapter_payload,
        };
        Ok(self.repo.claim_native_session(session_id, reference)?)
    }

    /// Persist the latest activity for whichever session owns `native_session_id`.
    /// Drops out-of-order updates by sequence. Returns whether a session matched.
    pub fn record_session_activity(
        &self,
        native_session_id: &str,
        activity: ActivityState,
    ) -> Result<bool> {
        let Some(mut session) = self.repo.find_session_by_native_id(native_session_id)? else {
            return Ok(false);
        };
        if let Some(existing) = &session.latest_activity {
            if activity_is_out_of_order(existing, &activity) {
                return Ok(false);
            }
        }
        session.note_activity_transition(&activity);
        session.latest_activity = Some(activity);
        self.repo.upsert_session(&session)?;
        Ok(true)
    }

    pub fn clear_session_activity(&self, native_session_id: &str) -> Result<bool> {
        let Some(mut session) = self.repo.find_session_by_native_id(native_session_id)? else {
            return Ok(false);
        };
        if session.latest_activity.is_none() {
            return Ok(false);
        }
        session.latest_activity = None;
        self.repo.upsert_session(&session)?;
        Ok(true)
    }

    /// The current state timeline for whichever session owns `native_session_id`,
    /// if any. The activity correlator reads this right after persisting an
    /// update so it can ride the freshly-stamped timeline on the live event,
    /// letting the dashboards reorder a status group without a snapshot refetch.
    pub fn session_timeline_by_native_id(
        &self,
        native_session_id: &str,
    ) -> Result<Option<SessionStateTimeline>> {
        Ok(self
            .repo
            .find_session_by_native_id(native_session_id)?
            .map(|session| session.state_timeline))
    }

    /// Persist activity for a session looked up by its Reverie id, capturing the
    /// CLI's native session id into `native_session_ref` the first time it is
    /// seen so future launches use the adapter's resume path.
    ///
    /// Returns `true` only when this call captured the native session id into the
    /// record for the first time. The caller uses that to nudge the frontend to
    /// refetch the session record: until the record carries the native ref, the
    /// dashboard cannot bind the (native-id-keyed) activity to the session.
    /// A stale (out-of-order) update or an unknown session returns `false`.
    pub fn record_session_activity_by_id(
        &self,
        reverie_session_id: SessionId,
        native_session_id: &str,
        activity: ActivityState,
    ) -> Result<bool> {
        // Not a session-(re)start boundary: identity is captured on first sight
        // and never re-pointed. This is the path for ordinary turn/tool events.
        self.record_session_activity_by_id_at_boundary(
            reverie_session_id,
            native_session_id,
            activity,
            false,
        )
    }

    /// Boundary-aware variant of [`Self::record_session_activity_by_id`].
    ///
    /// `session_boundary` is true when the update is a session (re)start edge
    /// (Claude / Codex `SessionStart`). A CLI changes the active native session id
    /// inside one running process when the user switches conversations from the
    /// TUI (`/resume` an externally-started session, or `/clear`), and that switch
    /// surfaces as a boundary edge carrying the *new* native id under the same
    /// token. Because the token authenticates the owning Reverie session directly,
    /// such an edge is not a guess like a folder scan: it is the live process
    /// telling us, authenticated, which conversation it now holds. So at a boundary
    /// we **re-point** the session's `native_session_ref` to the new id, which is
    /// what keeps the dashboard bound and a later Reverie resume targeting the
    /// conversation the user actually worked in.
    ///
    /// Returns `true` when this call captured (first sight) or re-pointed the
    /// native id, so the caller refetches the record and rebinds the activity feed.
    pub fn record_session_activity_by_id_at_boundary(
        &self,
        reverie_session_id: SessionId,
        native_session_id: &str,
        activity: ActivityState,
        session_boundary: bool,
    ) -> Result<bool> {
        let Some(mut session) = self.repo.get_session(reverie_session_id)? else {
            return Ok(false);
        };

        let stored_native = session
            .native_session_ref
            .as_ref()
            .and_then(|reference| reference.session_id.as_deref());
        let native_changed = matches!(stored_native, Some(stored) if stored != native_session_id);
        // Follow the live process onto a new conversation only at a start boundary.
        let repoint = native_changed && session_boundary;

        // A differing native id outside a boundary is a stale edge from a
        // conversation this session has already moved off (e.g. a late event from
        // the pre-`/resume` stream). Ignore it so it can neither overwrite the
        // current state nor mis-bind under the wrong id.
        if native_changed && !repoint {
            return Ok(false);
        }

        // The out-of-order guard compares sequences within ONE native stream. A
        // re-point begins a fresh stream with its own counter (the hook server
        // numbers sequences per native id), so the previous stream's high-water
        // sequence must not drop the new stream's opening events. Skip the guard
        // exactly when re-pointing.
        if !repoint {
            if let Some(existing) = &session.latest_activity {
                if activity_is_out_of_order(existing, &activity) {
                    return Ok(false);
                }
            }
        }

        let captured_native_session = session.native_session_ref.is_none() || repoint;
        if captured_native_session {
            let native_session_ref = NativeSessionRef {
                kind: session.agent_kind,
                session_id: Some(native_session_id.to_owned()),
                metadata_path: None,
                adapter_payload: serde_json::Value::Null,
            };
            if !self
                .repo
                .claim_native_session(reverie_session_id, native_session_ref)?
            {
                // Another Reverie session already owns this native id (e.g. the
                // same external conversation is open in another tab). Don't steal
                // it; leave this session as it was rather than corrupt the pairing.
                if repoint {
                    eprintln!(
                        "[reverie] session {reverie_session_id} tried to re-point to native id \
                         {native_session_id}, but another session already owns it; leaving as-is"
                    );
                }
                return Ok(false);
            }
            session = match self.repo.get_session(reverie_session_id)? {
                Some(session) => session,
                None => return Ok(false),
            };
        }
        session.note_activity_transition(&activity);
        session.latest_activity = Some(activity);
        self.repo.upsert_session(&session)?;
        Ok(captured_native_session)
    }

    pub fn clear_session_activity_by_id(&self, reverie_session_id: SessionId) -> Result<bool> {
        let Some(mut session) = self.repo.get_session(reverie_session_id)? else {
            return Ok(false);
        };
        if session.latest_activity.is_none() {
            return Ok(false);
        }
        session.latest_activity = None;
        self.repo.upsert_session(&session)?;
        Ok(true)
    }

    /// Reset the activity ordering baseline for a session that is about to be
    /// (re)launched. A launch begins a fresh activity stream whose sequence
    /// numbering is independent of the previous run's:
    ///
    /// - The Claude hook server counts sequences in a per-process map that resets
    ///   to zero on every app restart, so after a restart the first hook events of
    ///   a resumed session arrive as sequence 1, 2, 3...
    /// - A resumed file-log CLI may open a fresh transcript that the fold re-counts
    ///   from the start.
    ///
    /// Either way the persisted sequence (e.g. 23) is larger than the new stream's
    /// first events, so [`record_session_activity`]'s out-of-order guard would drop
    /// them and the session would be stranded showing its pre-relaunch state (the
    /// "resumed Claude session never re-enters working" bug). Zeroing the stored
    /// sequence makes the next event win while leaving the last snapshot on screen
    /// until it arrives. No-op when there is no stored activity or it is already at
    /// zero.
    pub fn reset_session_activity_sequence(&self, reverie_session_id: SessionId) -> Result<bool> {
        let Some(mut session) = self.repo.get_session(reverie_session_id)? else {
            return Ok(false);
        };
        let Some(activity) = session.latest_activity.as_mut() else {
            return Ok(false);
        };
        if activity.sequence == 0 {
            return Ok(false);
        }
        activity.sequence = 0;
        self.repo.upsert_session(&session)?;
        Ok(true)
    }

    /// Resolve the adapter for a session and build its terminal spawn spec.
    pub fn build_agent_spawn_spec(
        &self,
        session_id: SessionId,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSpawnSpec> {
        Ok(self.build_agent_launch(session_id, cols, rows)?.spec)
    }

    /// Build the spawn spec plus the launch context the terminal runtime needs
    /// to derive a live session title: the session's agent kind (which per-CLI
    /// title rule to apply) and its working-folder basename (the default title
    /// CLIs like Codex emit, which we suppress). Loads the snapshot once.
    pub fn build_agent_launch(
        &self,
        session_id: SessionId,
        cols: u16,
        rows: u16,
    ) -> Result<AgentLaunch> {
        let mut snapshot = self.repo.load_snapshot()?;
        // If the session's folder is gone (its project moved or was renamed),
        // try a just-in-time reconcile so an auto-reconnectable move heals before
        // we spawn, instead of launching a CLI into a missing directory.
        let folder_gone = snapshot
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .map(|session| !session.cwd.is_dir())
            .unwrap_or(false);
        if folder_gone {
            let _ = self.reconcile_project_folders();
            snapshot = self.repo.load_snapshot()?;
        }
        let session = snapshot
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .with_context(|| format!("unknown Reverie session {session_id}"))?;
        // Fail loudly rather than spawning into a directory that no longer
        // exists: a CLI launched at a dead cwd misbehaves while Reverie would
        // still mark the session running.
        if !session.cwd.is_dir() {
            bail!(
                "This session's folder is missing: {}. Use \u{201c}Locate folder\u{201d} \
                 on the project to reconnect it.",
                session.cwd.display()
            );
        }
        let adapter = built_in_adapters()
            .into_iter()
            .find(|adapter| adapter.kind() == session.agent_kind)
            .with_context(|| {
                format!(
                    "no built-in adapter registered for {:?}",
                    session.agent_kind
                )
            })?;
        let executable_path = require_detected(adapter.as_ref())?;
        // Focus (topic) default falls back to the workspace default; the
        // session override (applied inside build_spawn_spec) still wins.
        let focus_or_workspace_default = snapshot
            .focuses
            .iter()
            .find(|f| f.id == session.focus_id)
            .and_then(|f| f.default_dangerous_mode)
            .unwrap_or(snapshot.workspace.default_dangerous_mode);
        let agent_kind = session.agent_kind;
        let folder_name = session
            .cwd
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        // For a brand-new launch of an adapter that accepts an injected id
        // (Claude `--session-id`), mint the native id here so Reverie owns the
        // pairing from t=0. The caller persists it after a successful spawn. On
        // resume, or for CLIs without an inject flag, this stays None and
        // identity comes from the token-bound hook (or, last, a folder scan).
        let injected_native_id =
            if !crate::agents::session_should_resume(session) && adapter.mints_new_session_id() {
                Some(uuid::Uuid::new_v4().to_string())
            } else {
                None
            };
        let spec = build_spawn_spec(
            session,
            focus_or_workspace_default,
            cols,
            rows,
            executable_path,
            adapter.as_ref(),
            injected_native_id.clone(),
        )?;
        Ok(AgentLaunch {
            spec,
            agent_kind,
            folder_name,
            injected_native_id,
        })
    }

    /// Persist a native session id Reverie injected at spawn (Claude's
    /// `--session-id <uuid>`), recording the Reverie-session <-> CLI-session
    /// pairing deterministically instead of discovering it from disk. Called
    /// after a successful launch.
    ///
    /// Returns whether the claim was applied: `false` if the session already
    /// carries a native ref (a token-bound hook captured the same id first, a
    /// benign race since both sides use the id we injected) or the id is somehow
    /// already owned by another session (impossible for a freshly minted uuid).
    /// A successful claim flips the session onto its resume path.
    pub fn attach_native_session_id(
        &self,
        session_id: SessionId,
        native_session_id: &str,
    ) -> Result<bool> {
        let Some(session) = self.repo.get_session(session_id)? else {
            return Ok(false);
        };
        if session.native_session_ref.is_some() {
            return Ok(false);
        }
        let native_session_ref = NativeSessionRef {
            kind: session.agent_kind,
            session_id: Some(native_session_id.to_owned()),
            metadata_path: None,
            adapter_payload: serde_json::Value::Null,
        };
        Ok(self
            .repo
            .claim_native_session(session_id, native_session_ref)?)
    }

    fn update_session(
        &self,
        session_id: SessionId,
        update: impl FnOnce(&mut Session),
    ) -> Result<WorkspaceSnapshot> {
        let mut session = self
            .repo
            .get_session(session_id)?
            .ok_or_else(|| anyhow!("unknown Reverie session {session_id}"))?;
        update(&mut session);
        self.repo.upsert_session(&session)?;
        self.snapshot()
    }

    fn normalize_sessions(&self) -> Result<()> {
        let snapshot = self.repo.load_snapshot()?;
        for mut session in snapshot.sessions {
            if normalize_session(&mut session) {
                self.repo.upsert_session(&session)?;
            }
        }
        Ok(())
    }
}

fn required_text(value: String, label: &'static str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        bail!("{label} is required");
    }
    Ok(trimmed.to_owned())
}

fn optional_text(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

/// Whether two project folders are the same on disk, used to dedupe a re-added
/// folder against existing (and archived) projects. Compares raw paths first,
/// then falls back to canonical (symlink- and `.`/`..`-resolved) paths so two
/// spellings of the same folder match. Canonicalization needs the folder to
/// exist; if either side cannot be resolved (e.g. a stored project whose folder
/// was since deleted) we fall back to the raw comparison, never matching by
/// accident.
fn paths_equivalent(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(canonical_a), Ok(canonical_b)) => canonical_a == canonical_b,
        _ => false,
    }
}

/// Set each non-archived project's `folder_missing` from the live filesystem.
/// Read-only: the flag is computed per snapshot and never persisted, so it always
/// reflects the current truth (and self-clears once a folder is back or healed).
fn annotate_folder_missing(projects: &mut [Project]) {
    for project in projects {
        project.folder_missing = !project.archived && !project.path.is_dir();
    }
}

/// If `cwd` is the moved folder (`old`) or lives under it, return the equivalent
/// path under `new`; otherwise `None` (the session's cwd was elsewhere and should
/// be left alone).
fn repoint_under(cwd: &Path, old: &Path, new: &Path) -> Option<PathBuf> {
    if cwd == old {
        return Some(new.to_path_buf());
    }
    cwd.strip_prefix(old).ok().map(|rest| new.join(rest))
}

fn seed_workspace_id() -> WorkspaceId {
    WorkspaceId::parse_str(SEED_WORKSPACE_ID).expect("seed workspace id is a valid uuid")
}

/// Reconcile a single session left in a transient state by an unclean shutdown.
/// Returns whether anything changed. These rules are load-bearing: dropping or
/// reordering them shows wrong session status after a restart.
fn normalize_session(session: &mut Session) -> bool {
    let mut changed = false;

    if session.launch_mode == LaunchMode::Resume && session.native_session_ref.is_none() {
        session.launch_mode = LaunchMode::New;
        changed = true;
    }

    if session.native_session_ref.is_some() && session.launch_mode != LaunchMode::Resume {
        session.launch_mode = LaunchMode::Resume;
        changed = true;
    }

    if session.status == SessionStatus::Restorable && session.native_session_ref.is_none() {
        session.status = SessionStatus::NotStarted;
        session.last_exit_code = None;
        changed = true;
    }

    if session.status == SessionStatus::Running {
        // A session left in Running on boot means its process is gone (the app
        // crashed, or quit without persisting the finish). That is not a
        // failure, so we never stamp a fake exit code. With a captured native
        // ref the conversation is resumable; without one the session never got
        // far enough to resume, so we reset it to fresh rather than strand it as
        // a dead Exited record the user can neither resume nor cleanly restart.
        if session.native_session_ref.is_some() {
            session.status = SessionStatus::Restorable;
            // It died (uncleanly) and is now resumable/idle; stamp so it orders by
            // recency. Resetting to NotStarted (fresh) instead leaves no exit mark.
            session.note_exited(crate::time::now_iso8601());
        } else {
            session.status = SessionStatus::NotStarted;
            session.last_exit_code = None;
        }
        changed = true;
    }

    if session.native_session_ref.is_some()
        && matches!(
            session.status,
            SessionStatus::NotStarted | SessionStatus::Exited
        )
    {
        session.status = SessionStatus::Restorable;
        changed = true;
    }

    // Forcing a stale live state to rest is itself a transition into the resting
    // class, but `note_activity_transition` cannot see it (it would compare the
    // activity against itself), so stamp the timeline here. Use the activity's own
    // last-update time, not boot time, so a session that crashed mid-turn days ago
    // does not float to the top of the idle/finished order on the next launch.
    let rested_at = if let Some(activity) = session.latest_activity.as_mut() {
        if normalize_stale_activity(activity) {
            Some(activity.updated_at.clone())
        } else {
            None
        }
    } else {
        None
    };
    if let Some(at) = rested_at {
        session.note_resting(at);
        changed = true;
    }

    changed
}

/// Reconcile a persisted activity snapshot left mid-flight by an unclean
/// shutdown. Quitting Reverie kills every agent process, so on the next boot no
/// session can still be `Working`, `AwaitingPermission`, or `AwaitingResponse`:
/// those are live-process states. Resuming a CLI only restores the conversation
/// history, it does not re-raise the permission prompt, re-present the pending
/// question, or pick the turn back up, so a persisted "needs your approval",
/// "needs your answer", or "working" snapshot is stale and would mislead the
/// dashboard into showing attention/active for a session that is really just
/// waiting for you. Reset those statuses to the at-rest `AwaitingInput` and
/// drop the now-meaningless pending permission, running turn, and active tools.
/// Other statuses (`AwaitingInput`, `Done`, `Error`) describe an outcome, not a
/// live process, so they are left untouched. Returns whether anything changed.
fn normalize_stale_activity(activity: &mut ActivityState) -> bool {
    if !matches!(
        activity.status,
        ActivityStatus::Working
            | ActivityStatus::AwaitingPermission
            | ActivityStatus::AwaitingResponse
    ) {
        return false;
    }
    activity.status = ActivityStatus::AwaitingInput;
    activity.awaiting_permission = None;
    activity.active_tools.clear();
    if let Some(turn) = activity.turn.as_mut() {
        if turn.status == TurnStatus::Running {
            turn.status = TurnStatus::Aborted;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::InMemoryWorkspaceRepository;

    fn service() -> (Arc<InMemoryWorkspaceRepository>, WorkspaceService) {
        let repo = Arc::new(InMemoryWorkspaceRepository::new());
        let service = WorkspaceService::new(repo.clone());
        service.ensure_seeded().unwrap();
        (repo, service)
    }

    fn make_focus(service: &WorkspaceService) -> FocusId {
        let snapshot = service
            .create_focus(None, "General".to_owned(), None, None)
            .unwrap();
        snapshot.focuses[0].id
    }

    #[test]
    fn ensure_seeded_creates_a_stable_workspace() {
        let (_repo, service) = service();
        let snapshot = service.snapshot().unwrap();
        assert_eq!(snapshot.workspace.id, seed_workspace_id());
        assert_eq!(snapshot.workspace.general_label, "General");
    }

    #[test]
    fn attach_native_session_id_records_injected_pairing_and_flips_to_resume() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let snapshot = service
            .create_session(
                focus,
                "Injected".to_owned(),
                AgentKind::ClaudeCode,
                PathBuf::from("/tmp/reverie"),
                None,
            )
            .unwrap();
        let session_id = snapshot.sessions[0].id;
        assert!(snapshot.sessions[0].native_session_ref.is_none());
        assert_eq!(snapshot.sessions[0].launch_mode, LaunchMode::New);

        // First attach records the minted id and flips onto the resume path, so
        // the next launch is `claude --resume <id>` rather than a folder guess.
        assert!(
            service
                .attach_native_session_id(session_id, "minted-uuid")
                .unwrap()
        );
        let session = service
            .snapshot()
            .unwrap()
            .sessions
            .into_iter()
            .find(|s| s.id == session_id)
            .unwrap();
        assert_eq!(
            session
                .native_session_ref
                .and_then(|r| r.session_id)
                .as_deref(),
            Some("minted-uuid")
        );
        assert_eq!(session.launch_mode, LaunchMode::Resume);

        // A later token-bound hook capturing the same injected id must be a
        // benign no-op, never a rebind or error.
        assert!(
            !service
                .attach_native_session_id(session_id, "minted-uuid")
                .unwrap()
        );
    }

    #[test]
    fn set_agent_cli_enabled_toggles_the_disabled_set_idempotently() {
        let (_repo, service) = service();
        // Everything starts enabled.
        assert!(
            service
                .snapshot()
                .unwrap()
                .workspace
                .disabled_agent_kinds
                .is_empty()
        );
        assert!(service.is_agent_cli_enabled(AgentKind::ClaudeCode).unwrap());

        // Disabling adds it; disabling again is a no-op (no duplicates).
        service
            .set_agent_cli_enabled(AgentKind::ClaudeCode, false)
            .unwrap();
        let snapshot = service
            .set_agent_cli_enabled(AgentKind::ClaudeCode, false)
            .unwrap();
        assert_eq!(
            snapshot.workspace.disabled_agent_kinds,
            vec![AgentKind::ClaudeCode]
        );
        assert!(!service.is_agent_cli_enabled(AgentKind::ClaudeCode).unwrap());

        // Other CLIs stay enabled.
        assert!(service.is_agent_cli_enabled(AgentKind::CortexCode).unwrap());

        // Re-enabling removes it.
        let snapshot = service
            .set_agent_cli_enabled(AgentKind::ClaudeCode, true)
            .unwrap();
        assert!(snapshot.workspace.disabled_agent_kinds.is_empty());
    }

    #[test]
    fn set_workspace_default_dangerous_mode_persists_and_round_trips() {
        let (_repo, service) = service();
        // Fresh workspaces default the single auto-approve default to off.
        assert!(!service.snapshot().unwrap().workspace.default_dangerous_mode);

        // Turning it on persists and a fresh load sees it.
        let snapshot = service.set_workspace_default_dangerous_mode(true).unwrap();
        assert!(snapshot.workspace.default_dangerous_mode);
        assert!(service.snapshot().unwrap().workspace.default_dangerous_mode);

        // Turning it back off round-trips too.
        let snapshot = service.set_workspace_default_dangerous_mode(false).unwrap();
        assert!(!snapshot.workspace.default_dangerous_mode);
        assert!(!service.snapshot().unwrap().workspace.default_dangerous_mode);
    }

    #[test]
    fn set_workspace_theme_and_default_agent_kind_persist_independently() {
        let (_repo, service) = service();
        // Fresh workspaces default to dark + Claude Code (top of the priority order).
        let workspace = service.snapshot().unwrap().workspace;
        assert_eq!(workspace.theme, ThemeMode::Dark);
        assert_eq!(workspace.default_agent_kind, AgentKind::ClaudeCode);

        // Theme persists and round-trips without touching the default agent.
        let snapshot = service.set_workspace_theme(ThemeMode::Light).unwrap();
        assert_eq!(snapshot.workspace.theme, ThemeMode::Light);
        assert_eq!(snapshot.workspace.default_agent_kind, AgentKind::ClaudeCode);
        assert_eq!(
            service.snapshot().unwrap().workspace.theme,
            ThemeMode::Light
        );

        // Default agent persists and is independent of the theme.
        let snapshot = service
            .set_workspace_default_agent_kind(AgentKind::CortexCode)
            .unwrap();
        assert_eq!(snapshot.workspace.default_agent_kind, AgentKind::CortexCode);
        assert_eq!(snapshot.workspace.theme, ThemeMode::Light);

        // Setting one does not flip the other.
        let snapshot = service.set_workspace_theme(ThemeMode::Dark).unwrap();
        assert_eq!(snapshot.workspace.theme, ThemeMode::Dark);
        assert_eq!(snapshot.workspace.default_agent_kind, AgentKind::CortexCode);
    }

    #[test]
    fn set_terminal_font_size_persists_and_clamps() {
        let (_repo, service) = service();
        // Fresh workspaces start at the default font size.
        assert_eq!(service.snapshot().unwrap().workspace.terminal_font_size, 14);

        // An in-range size persists and round-trips.
        let snapshot = service.set_terminal_font_size(18).unwrap();
        assert_eq!(snapshot.workspace.terminal_font_size, 18);
        assert_eq!(service.snapshot().unwrap().workspace.terminal_font_size, 18);

        // Out-of-range requests are clamped to the supported range rather than
        // stored as-is, so a bad value can never produce a degenerate cell.
        assert_eq!(
            service
                .set_terminal_font_size(2)
                .unwrap()
                .workspace
                .terminal_font_size,
            9
        );
        assert_eq!(
            service
                .set_terminal_font_size(99)
                .unwrap()
                .workspace
                .terminal_font_size,
            24
        );
    }

    #[test]
    fn set_sidebar_width_persists_and_clamps() {
        let (_repo, service) = service();
        // Fresh workspaces start at the default left-panel width.
        assert_eq!(service.snapshot().unwrap().workspace.sidebar_width, 288);

        // An in-range width persists and round-trips.
        let snapshot = service.set_sidebar_width(360).unwrap();
        assert_eq!(snapshot.workspace.sidebar_width, 360);
        assert_eq!(service.snapshot().unwrap().workspace.sidebar_width, 360);

        // Out-of-range requests are clamped to the supported range rather than
        // stored as-is, so a runaway drag can never crush or swallow the rail.
        assert_eq!(
            service
                .set_sidebar_width(40)
                .unwrap()
                .workspace
                .sidebar_width,
            220
        );
        assert_eq!(
            service
                .set_sidebar_width(9000)
                .unwrap()
                .workspace
                .sidebar_width,
            560
        );
    }

    #[test]
    fn workspace_default_does_not_change_session_overrides() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        // A session created with an explicit override keeps it.
        let id = service
            .create_session(
                focus,
                "S".to_owned(),
                AgentKind::CortexCode,
                "/tmp".into(),
                Some(true),
            )
            .unwrap()
            .sessions[0]
            .id;

        // Moving the workspace auto-approve default the other way leaves the
        // session's explicit override untouched.
        service.set_workspace_default_dangerous_mode(false).unwrap();
        let session = service
            .snapshot()
            .unwrap()
            .sessions
            .into_iter()
            .find(|s| s.id == id)
            .unwrap();
        assert_eq!(session.dangerous_mode_override, Some(true));
    }

    #[test]
    fn create_project_validates_name_and_unique_path() {
        let (_repo, service) = service();
        assert!(
            service
                .create_project("  ".to_owned(), "/repo".into())
                .is_err()
        );
        service
            .create_project("Reverie".to_owned(), "/repo".into())
            .unwrap();
        let dup = service.create_project("Other".to_owned(), "/repo".into());
        assert!(dup.is_err(), "duplicate non-archived path must be rejected");
    }

    #[test]
    fn re_adding_an_archived_project_folder_reconnects_it() {
        let (_repo, service) = service();
        let snapshot = service
            .create_project("Reverie".to_owned(), "/repo".into())
            .unwrap();
        let project_id = snapshot.projects[0].id;
        let focus_snapshot = service
            .create_focus(Some(project_id), "Terminal".to_owned(), None, None)
            .unwrap();
        let focus_id = focus_snapshot
            .focuses
            .iter()
            .find(|f| f.project_id == Some(project_id))
            .unwrap()
            .id;
        service
            .create_session(
                focus_id,
                "S".to_owned(),
                AgentKind::CortexCode,
                "/repo".into(),
                None,
            )
            .unwrap();
        service.archive_project(project_id).unwrap();

        // Re-adding the same folder reconnects the existing record instead of
        // creating a duplicate: same id, now active, with its subtree restored.
        let reconnected = service
            .create_project("Reverie".to_owned(), "/repo".into())
            .unwrap();
        assert_eq!(reconnected.projects.len(), 1, "no duplicate project row");
        assert_eq!(reconnected.projects[0].id, project_id);
        assert!(!reconnected.projects[0].archived);
        assert!(
            reconnected
                .focuses
                .iter()
                .any(|f| f.id == focus_id && !f.archived)
        );
        assert_eq!(
            reconnected
                .sessions
                .iter()
                .filter(|s| s.focus_id == focus_id)
                .count(),
            1
        );
    }

    #[test]
    fn create_focus_assigns_increasing_sort_order_and_checks_project() {
        let (_repo, service) = service();
        let unknown = service.create_focus(Some(ProjectId::new_v4()), "X".to_owned(), None, None);
        assert!(unknown.is_err());

        service
            .create_focus(None, "First".to_owned(), None, None)
            .unwrap();
        let snapshot = service
            .create_focus(None, "Second".to_owned(), None, None)
            .unwrap();
        let general: Vec<i64> = snapshot
            .focuses
            .iter()
            .filter(|f| f.project_id.is_none())
            .map(|f| f.sort_order)
            .collect();
        // Index 0 is the General focus seeded by `ensure_seeded`; the two created
        // here pick up the next sort slots.
        assert_eq!(general, vec![0, 10, 20]);
    }

    #[test]
    fn reorder_focuses_rewrites_sort_order_by_position() {
        let (_repo, service) = service();
        let after_first = service
            .create_focus(None, "First".to_owned(), None, None)
            .unwrap();
        let first_id = after_first
            .focuses
            .iter()
            .find(|f| f.title == "First")
            .unwrap()
            .id;
        let after_second = service
            .create_focus(None, "Second".to_owned(), None, None)
            .unwrap();
        let second_id = after_second
            .focuses
            .iter()
            .find(|f| f.title == "Second")
            .unwrap()
            .id;

        // Drop "Second" above "First": the new positions drive the sort order.
        let snapshot = service.reorder_focuses(vec![second_id, first_id]).unwrap();
        let order_of = |id| {
            snapshot
                .focuses
                .iter()
                .find(|f| f.id == id)
                .unwrap()
                .sort_order
        };
        assert_eq!(order_of(second_id), 0);
        assert_eq!(order_of(first_id), 10);
    }

    #[test]
    fn move_session_reparents_and_reorders_keeping_cwd() {
        let (_repo, service) = service();
        let focus_a = service.snapshot().unwrap().focuses[0].id;
        let after_topic = service
            .create_focus(None, "Topic B".to_owned(), None, None)
            .unwrap();
        let focus_b = after_topic
            .focuses
            .iter()
            .find(|f| f.title == "Topic B")
            .unwrap()
            .id;

        service
            .create_session(
                focus_a,
                "S1".to_owned(),
                AgentKind::CortexCode,
                "/work/a".into(),
                None,
            )
            .unwrap();
        let after = service
            .create_session(
                focus_a,
                "S2".to_owned(),
                AgentKind::CortexCode,
                "/work/a".into(),
                None,
            )
            .unwrap();
        let s2 = after.sessions.iter().find(|s| s.title == "S2").unwrap();
        let s2_id = s2.id;
        let s2_cwd = s2.cwd.clone();

        let snapshot = service.move_session(s2_id, focus_b, 0).unwrap();
        let moved = snapshot.sessions.iter().find(|s| s.id == s2_id).unwrap();
        assert_eq!(
            moved.focus_id, focus_b,
            "session reparents to the target topic"
        );
        assert_eq!(moved.cwd, s2_cwd, "cwd is preserved across the move");
        assert_eq!(moved.sort_order, 0, "placed at the requested index");
    }

    #[test]
    fn create_session_requires_known_focus() {
        let (_repo, service) = service();
        let bad = service.create_session(
            FocusId::new_v4(),
            "S".to_owned(),
            AgentKind::CortexCode,
            "/tmp".into(),
            None,
        );
        assert!(bad.is_err());

        let focus = make_focus(&service);
        let snapshot = service
            .create_session(
                focus,
                "S".to_owned(),
                AgentKind::CortexCode,
                "/tmp".into(),
                None,
            )
            .unwrap();
        assert_eq!(snapshot.sessions.len(), 1);
        assert!(!snapshot.sessions[0].archived);
        assert_eq!(snapshot.sessions[0].status, SessionStatus::NotStarted);
    }

    #[test]
    fn runtime_status_transitions_persist() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let snapshot = service
            .create_session(
                focus,
                "S".to_owned(),
                AgentKind::CortexCode,
                "/tmp".into(),
                None,
            )
            .unwrap();
        let id = snapshot.sessions[0].id;

        let running = service.mark_session_running(id).unwrap();
        assert_eq!(running.sessions[0].status, SessionStatus::Running);

        // No native ref attached -> finishing exits cleanly.
        let finished = service.mark_session_finished(id, true).unwrap();
        assert_eq!(finished.sessions[0].status, SessionStatus::Exited);
        assert_eq!(finished.sessions[0].last_exit_code, Some(0));
    }

    #[test]
    fn set_session_title_persists_and_only_touches_title() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let snapshot = service
            .create_session(
                focus,
                "Claude Code".to_owned(),
                AgentKind::ClaudeCode,
                "/tmp".into(),
                None,
            )
            .unwrap();
        let id = snapshot.sessions[0].id;
        let status_before = snapshot.sessions[0].status;

        let updated = service
            .set_session_title(id, "  Fixing the parser  ".to_owned())
            .unwrap();
        assert_eq!(updated.sessions[0].title, "Fixing the parser");
        // Status (and other fields) are untouched by a title update.
        assert_eq!(updated.sessions[0].status, status_before);

        // Empty/whitespace input never clears a good title.
        assert!(service.set_session_title(id, "   ".to_owned()).is_err());
        let after = service.snapshot().unwrap();
        assert_eq!(after.sessions[0].title, "Fixing the parser");
    }

    #[test]
    fn rename_session_pins_a_custom_title_and_clears_back_to_automatic() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let snapshot = service
            .create_session(
                focus,
                "Claude Code".to_owned(),
                AgentKind::ClaudeCode,
                "/tmp".into(),
                None,
            )
            .unwrap();
        let id = snapshot.sessions[0].id;

        // A non-empty rename pins a custom title (trimmed) without touching the
        // automatic one.
        let renamed = service
            .rename_session(id, "  Parser rewrite  ".to_owned())
            .unwrap();
        assert_eq!(
            renamed.sessions[0].custom_title.as_deref(),
            Some("Parser rewrite")
        );
        assert_eq!(renamed.sessions[0].title, "Claude Code");

        // A live OSC title keeps updating the automatic title underneath the pin,
        // so the user's chosen name is never clobbered.
        let osc = service
            .set_session_title(id, "running tests".to_owned())
            .unwrap();
        assert_eq!(
            osc.sessions[0].custom_title.as_deref(),
            Some("Parser rewrite")
        );
        assert_eq!(osc.sessions[0].title, "running tests");

        // An empty/whitespace rename clears the pin; the current automatic title
        // is revealed again.
        let cleared = service.rename_session(id, "   ".to_owned()).unwrap();
        assert_eq!(cleared.sessions[0].custom_title, None);
        assert_eq!(cleared.sessions[0].title, "running tests");
    }

    #[test]
    fn rename_focus_and_project_change_only_the_label() {
        let (_repo, service) = service();
        let project_id = service
            .create_project("Reverie".to_owned(), "/repo".into())
            .unwrap()
            .projects[0]
            .id;
        let focus_id = service
            .create_focus(Some(project_id), "Terminal".to_owned(), None, None)
            .unwrap()
            .focuses
            .iter()
            .find(|focus| focus.title == "Terminal")
            .unwrap()
            .id;

        let renamed = service
            .rename_focus(focus_id, "  Terminal pipeline  ".to_owned())
            .unwrap();
        assert_eq!(
            renamed
                .focuses
                .iter()
                .find(|focus| focus.id == focus_id)
                .unwrap()
                .title,
            "Terminal pipeline"
        );
        // A topic must keep a name: empty input is rejected.
        assert!(service.rename_focus(focus_id, "  ".to_owned()).is_err());

        let renamed_project = service
            .rename_project(project_id, "Reverie App".to_owned())
            .unwrap();
        let project = renamed_project
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .unwrap();
        assert_eq!(project.name, "Reverie App");
        // The folder on disk is the source of truth and stays untouched.
        assert_eq!(project.path, std::path::PathBuf::from("/repo"));
        assert!(service.rename_project(project_id, String::new()).is_err());
    }

    #[test]
    fn set_generated_session_title_merges_native_payload() {
        let (repo, service) = service();
        let focus = make_focus(&service);
        let snapshot = service
            .create_session(
                focus,
                "Codex".to_owned(),
                AgentKind::CodexCli,
                "/tmp".into(),
                None,
            )
            .unwrap();
        let mut session = snapshot.sessions[0].clone();
        session.native_session_ref = Some(NativeSessionRef {
            kind: AgentKind::CodexCli,
            session_id: Some("codex-native".to_owned()),
            metadata_path: None,
            adapter_payload: serde_json::json!({ "kept": true }),
        });
        repo.upsert_session(&session).unwrap();

        let updated = service
            .set_generated_session_title(
                session.id,
                AgentKind::CodexCli,
                "Fix parser tests".to_owned(),
                serde_json::json!({
                    "source": "codex_completion",
                    "title": "Fix parser tests",
                    "userMessageCount": 2,
                }),
            )
            .unwrap();
        let session = updated
            .sessions
            .iter()
            .find(|candidate| candidate.id == session.id)
            .unwrap();
        assert_eq!(session.title, "Fix parser tests");
        let payload = &session.native_session_ref.as_ref().unwrap().adapter_payload;
        assert_eq!(payload["kept"], true);
        assert_eq!(
            payload["generatedTitle"]["userMessageCount"],
            serde_json::json!(2)
        );
    }

    #[test]
    fn boot_normalization_demotes_stale_running_and_fixes_resume() {
        let (repo, service) = service();
        let focus = Focus::general("General", 0);
        repo.upsert_focus(&focus).unwrap();

        // Stale Running with no native ref: died too young to resume, so it
        // resets to fresh (NotStarted) rather than a dead Exited record, and is
        // never stamped with a failure exit code (the app just quit).
        let mut stale_running =
            Session::new(focus.id, "Running", AgentKind::CortexCode, "/a".into());
        stale_running.status = SessionStatus::Running;
        stale_running.last_exit_code = None;
        repo.upsert_session(&stale_running).unwrap();

        // Stale Running WITH a native ref: the conversation is resumable.
        let mut stale_running_resumable =
            Session::new(focus.id, "Running2", AgentKind::CortexCode, "/c".into());
        stale_running_resumable.status = SessionStatus::Running;
        stale_running_resumable.native_session_ref =
            Some(NativeSessionRef::cortex("native-7", None));
        repo.upsert_session(&stale_running_resumable).unwrap();

        let mut resume_without_ref =
            Session::new(focus.id, "Resume", AgentKind::CortexCode, "/b".into());
        resume_without_ref.launch_mode = LaunchMode::Resume;
        repo.upsert_session(&resume_without_ref).unwrap();

        // Re-running ensure_seeded re-normalizes existing sessions.
        service.ensure_seeded().unwrap();
        let snapshot = service.snapshot().unwrap();

        let running = snapshot
            .sessions
            .iter()
            .find(|s| s.id == stale_running.id)
            .unwrap();
        assert_eq!(running.status, SessionStatus::NotStarted);
        assert_eq!(running.last_exit_code, None);

        let resumable = snapshot
            .sessions
            .iter()
            .find(|s| s.id == stale_running_resumable.id)
            .unwrap();
        assert_eq!(resumable.status, SessionStatus::Restorable);
        assert_eq!(resumable.last_exit_code, None);

        let resume = snapshot
            .sessions
            .iter()
            .find(|s| s.id == resume_without_ref.id)
            .unwrap();
        assert_eq!(resume.launch_mode, LaunchMode::New);
    }

    #[test]
    fn boot_normalization_resets_stale_working_and_permission_activity() {
        let (repo, service) = service();
        let focus = Focus::general("General", 0);
        repo.upsert_focus(&focus).unwrap();

        // A session quit while the agent was awaiting a permission prompt. On
        // resume the CLI only restores history, so the pending prompt is gone;
        // the snapshot must read as at-rest, not "needs your approval".
        let mut awaiting = Session::new(focus.id, "Perm", AgentKind::CortexCode, "/a".into());
        awaiting.native_session_ref = Some(NativeSessionRef::cortex("native-perm", None));
        awaiting.latest_activity = Some(
            crate::activity::parse_state(
                r#"{"version":1,"sessionId":"native-perm","status":"awaiting_permission","updatedAt":"t","sequence":4,"cwd":"/a","turn":{"id":"turn-1","status":"running","startedAt":"t"},"activeTools":[{"toolCallId":"tc","toolName":"Bash","startedAt":"t"}],"awaitingPermission":{"id":"p","toolName":"Bash","displaySummary":"rm","requestedAt":"t"}}"#,
            )
            .unwrap(),
        );
        repo.upsert_session(&awaiting).unwrap();

        // A session quit mid-turn (working). Its process is dead on boot, so it
        // is no longer working.
        let mut working = Session::new(focus.id, "Work", AgentKind::CortexCode, "/b".into());
        working.native_session_ref = Some(NativeSessionRef::cortex("native-work", None));
        working.latest_activity = Some(
            crate::activity::parse_state(
                r#"{"version":1,"sessionId":"native-work","status":"working","updatedAt":"t","sequence":2,"cwd":"/b","turn":{"id":"turn-9","status":"running","startedAt":"t"},"activeTools":[{"toolCallId":"tc","toolName":"Edit","startedAt":"t"}]}"#,
            )
            .unwrap(),
        );
        repo.upsert_session(&working).unwrap();

        // A done session is a real outcome, not a live-process state: untouched.
        let mut done = Session::new(focus.id, "Done", AgentKind::CortexCode, "/c".into());
        done.native_session_ref = Some(NativeSessionRef::cortex("native-done", None));
        done.latest_activity = Some(
            crate::activity::parse_state(
                r#"{"version":1,"sessionId":"native-done","status":"done","updatedAt":"t","sequence":7,"cwd":"/c"}"#,
            )
            .unwrap(),
        );
        repo.upsert_session(&done).unwrap();

        service.ensure_seeded().unwrap();
        let snapshot = service.snapshot().unwrap();

        let perm = snapshot
            .sessions
            .iter()
            .find(|s| s.id == awaiting.id)
            .unwrap()
            .latest_activity
            .as_ref()
            .unwrap();
        assert_eq!(perm.status, ActivityStatus::AwaitingInput);
        assert!(perm.awaiting_permission.is_none());
        assert!(perm.active_tools.is_empty());
        assert_eq!(perm.turn.as_ref().unwrap().status, TurnStatus::Aborted);

        let work = snapshot
            .sessions
            .iter()
            .find(|s| s.id == working.id)
            .unwrap()
            .latest_activity
            .as_ref()
            .unwrap();
        assert_eq!(work.status, ActivityStatus::AwaitingInput);
        assert!(work.active_tools.is_empty());
        assert_eq!(work.turn.as_ref().unwrap().status, TurnStatus::Aborted);

        // The forced rest advances the timeline's resting marker to the activity's
        // own last-update time (here "t"), so the dashboard orders it by recency.
        let work_session = snapshot
            .sessions
            .iter()
            .find(|s| s.id == working.id)
            .unwrap();
        assert_eq!(
            work_session.state_timeline.resting_since.as_deref(),
            Some("t")
        );

        let rest_record = snapshot.sessions.iter().find(|s| s.id == done.id).unwrap();
        let rest = rest_record.latest_activity.as_ref().unwrap();
        assert_eq!(rest.status, ActivityStatus::Done);
        // A `done` activity is a real outcome, not a stale live state, so
        // normalization leaves it (and the timeline) untouched.
        assert!(rest_record.state_timeline.resting_since.is_none());
    }

    #[test]
    fn attach_native_session_moves_session_to_restorable() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let snapshot = service
            .create_session(
                focus,
                "Cortex".to_owned(),
                AgentKind::CortexCode,
                "/tmp/reverie".into(),
                None,
            )
            .unwrap();
        let id = snapshot.sessions[0].id;

        service
            .attach_native_session(
                id,
                PathBuf::from("/tmp/reverie"),
                NativeSessionRef::cortex("native-1", None),
                AgentKind::CortexCode,
            )
            .unwrap();

        let session = service.snapshot().unwrap().sessions[0].clone();
        assert_eq!(session.launch_mode, LaunchMode::Resume);
        assert_eq!(session.status, SessionStatus::Restorable);
        assert_eq!(
            session.native_session_ref.and_then(|r| r.session_id),
            Some("native-1".to_owned())
        );
    }

    #[test]
    fn record_activity_matches_native_id_and_drops_stale_sequence() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let id = service
            .create_session(
                focus,
                "Cortex".to_owned(),
                AgentKind::CortexCode,
                "/tmp/reverie".into(),
                None,
            )
            .unwrap()
            .sessions[0]
            .id;
        service
            .attach_native_session(
                id,
                PathBuf::from("/tmp/reverie"),
                NativeSessionRef::cortex("native-9", None),
                AgentKind::CortexCode,
            )
            .unwrap();

        let state = |seq: u64| {
            crate::activity::parse_state(&format!(
                r#"{{"version":1,"sessionId":"native-9","status":"working","updatedAt":"t","sequence":{seq},"cwd":"/tmp/reverie"}}"#
            ))
            .unwrap()
        };

        assert!(
            service
                .record_session_activity("native-9", state(5))
                .unwrap()
        );
        // Older sequence is dropped.
        assert!(
            !service
                .record_session_activity("native-9", state(3))
                .unwrap()
        );
        // Unknown native id matches nothing.
        assert!(!service.record_session_activity("nope", state(7)).unwrap());

        let session = service.snapshot().unwrap().sessions[0].clone();
        assert_eq!(session.latest_activity.unwrap().sequence, 5);
    }

    #[test]
    fn record_activity_accepts_a_process_restart_by_newer_timestamp_over_lower_sequence() {
        // The Cortex "running session shows idle" bug: a CLI restarts its own
        // process mid-session (here, after an error) and its per-run sequence
        // resets to 1 while Reverie keeps running, so `reset_session_activity_
        // sequence` (only fired on a Reverie-initiated launch) never runs. The
        // pre-restart high-water sequence must not strand the restarted stream,
        // which is genuinely newer by wall-clock.
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let id = service
            .create_session(
                focus,
                "Cortex".to_owned(),
                AgentKind::CortexCode,
                "/tmp/reverie".into(),
                None,
            )
            .unwrap()
            .sessions[0]
            .id;
        service
            .attach_native_session(
                id,
                PathBuf::from("/tmp/reverie"),
                NativeSessionRef::cortex("native-9", None),
                AgentKind::CortexCode,
            )
            .unwrap();

        let state = |seq: u64, status: &str, updated_at: &str| {
            crate::activity::parse_state(&format!(
                r#"{{"version":1,"sessionId":"native-9","status":"{status}","updatedAt":"{updated_at}","sequence":{seq},"cwd":"/tmp/reverie"}}"#
            ))
            .unwrap()
        };

        // Pre-restart stream comes to rest at a high sequence.
        assert!(
            service
                .record_session_activity(
                    "native-9",
                    state(115, "awaiting_input", "2026-06-14T18:04:20.000Z"),
                )
                .unwrap()
        );
        // A genuine straggler from that run (older wall-clock, lower sequence) is
        // still dropped, so a late read can't roll the dashboard backwards.
        assert!(
            !service
                .record_session_activity(
                    "native-9",
                    state(40, "working", "2026-06-14T18:00:00.000Z"),
                )
                .unwrap()
        );
        // The restarted stream's first working event has a lower sequence (1) but
        // a newer wall-clock time: it must win, not be dropped as stale.
        assert!(
            service
                .record_session_activity(
                    "native-9",
                    state(1, "working", "2026-06-14T18:25:27.631Z"),
                )
                .unwrap()
        );
        let activity = service.snapshot().unwrap().sessions[0]
            .clone()
            .latest_activity
            .unwrap();
        assert_eq!(activity.status, ActivityStatus::Working);
        assert_eq!(activity.sequence, 1);
    }

    #[test]
    fn relaunch_reset_lets_a_restarted_streams_low_sequence_through() {
        // Models the "resumed Claude session never re-enters working" bug: before
        // an app restart the hook stream reached a high sequence; after the restart
        // the hook server's counter is back at 1. Without resetting the baseline the
        // out-of-order guard drops every post-restart event; with it the new stream
        // is accepted.
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let id = service
            .create_session(
                focus,
                "Claude".to_owned(),
                AgentKind::ClaudeCode,
                "/tmp/reverie".into(),
                None,
            )
            .unwrap()
            .sessions[0]
            .id;

        let state = |seq: u64, status: &str| {
            crate::activity::parse_state(&format!(
                r#"{{"version":1,"sessionId":"claude-native","status":"{status}","updatedAt":"t","sequence":{seq},"cwd":"/tmp/reverie"}}"#
            ))
            .unwrap()
        };

        // Pre-restart stream climbs to a high sequence and comes to rest.
        service
            .record_session_activity_by_id(id, "claude-native", state(23, "awaiting_input"))
            .unwrap();

        // A post-restart event arrives at sequence 1: dropped while the stale
        // baseline (23) is in place.
        assert!(
            !service
                .record_session_activity_by_id(id, "claude-native", state(1, "working"))
                .unwrap()
        );
        assert_eq!(
            service.snapshot().unwrap().sessions[0]
                .latest_activity
                .as_ref()
                .unwrap()
                .status,
            ActivityStatus::AwaitingInput,
            "without a reset the session is stranded in its pre-restart state"
        );

        // Relaunch resets the ordering baseline (23 -> 0); resetting again while
        // already at the baseline is a no-op.
        assert!(service.reset_session_activity_sequence(id).unwrap());
        assert!(!service.reset_session_activity_sequence(id).unwrap());

        // Now the restarted stream's first event wins and the session re-enters
        // working.
        service
            .record_session_activity_by_id(id, "claude-native", state(1, "working"))
            .unwrap();
        let session = service.snapshot().unwrap().sessions[0].clone();
        let activity = session.latest_activity.unwrap();
        assert_eq!(activity.status, ActivityStatus::Working);
        assert_eq!(activity.sequence, 1);
    }

    #[test]
    fn record_activity_by_id_captures_native_ref_first_time() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let id = service
            .create_session(
                focus,
                "Claude".to_owned(),
                AgentKind::ClaudeCode,
                "/tmp".into(),
                None,
            )
            .unwrap()
            .sessions[0]
            .id;

        let state = crate::activity::parse_state(
            r#"{"version":1,"sessionId":"claude-native","status":"working","updatedAt":"t","sequence":1,"cwd":"/tmp"}"#,
        )
        .unwrap();
        assert!(
            service
                .record_session_activity_by_id(id, "claude-native", state)
                .unwrap()
        );

        let session = service.snapshot().unwrap().sessions[0].clone();
        assert_eq!(
            session.native_session_ref.and_then(|r| r.session_id),
            Some("claude-native".to_owned())
        );
    }

    #[test]
    fn boundary_repoints_native_id_but_same_id_still_respects_the_sequence_guard() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let id = service
            .create_session(
                focus,
                "Claude".to_owned(),
                AgentKind::ClaudeCode,
                "/tmp".into(),
                None,
            )
            .unwrap()
            .sessions[0]
            .id;

        let state = |native: &str, seq: u64, status: &str| {
            crate::activity::parse_state(&format!(
                r#"{{"version":1,"sessionId":"{native}","status":"{status}","updatedAt":"t","sequence":{seq},"cwd":"/tmp"}}"#
            ))
            .unwrap()
        };
        let bound = |service: &WorkspaceService| {
            service.snapshot().unwrap().sessions[0]
                .native_session_ref
                .clone()
                .and_then(|r| r.session_id)
        };

        // Capture A, then climb to a high sequence.
        assert!(
            service
                .record_session_activity_by_id(id, "A", state("A", 1, "working"))
                .unwrap()
        );
        service
            .record_session_activity_by_id(id, "A", state("A", 12, "working"))
            .unwrap();

        // A boundary carrying the SAME id is not a re-point and still obeys the
        // out-of-order guard: a stale low sequence is dropped.
        assert!(
            !service
                .record_session_activity_by_id_at_boundary(id, "A", state("A", 2, "working"), true)
                .unwrap()
        );
        assert_eq!(bound(&service).as_deref(), Some("A"));

        // A boundary carrying a NEW id re-points despite the low sequence.
        assert!(
            service
                .record_session_activity_by_id_at_boundary(id, "B", state("B", 1, "working"), true)
                .unwrap()
        );
        assert_eq!(bound(&service).as_deref(), Some("B"));

        // A non-boundary edge for the now-stale A id is ignored, not re-pointed.
        assert!(
            !service
                .record_session_activity_by_id(id, "A", state("A", 99, "awaiting_input"))
                .unwrap()
        );
        assert_eq!(bound(&service).as_deref(), Some("B"));
    }

    #[test]
    fn activity_transitions_stamp_state_timeline_markers() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let id = service
            .create_session(
                focus,
                "Claude".to_owned(),
                AgentKind::ClaudeCode,
                "/tmp".into(),
                None,
            )
            .unwrap()
            .sessions[0]
            .id;
        // created_at is stamped at construction.
        assert!(
            service.snapshot().unwrap().sessions[0]
                .state_timeline
                .created_at
                .is_some()
        );

        let state = |seq: u64, status: &str, at: &str| {
            crate::activity::parse_state(&format!(
                r#"{{"version":1,"sessionId":"claude-native","status":"{status}","updatedAt":"{at}","sequence":{seq},"cwd":"/tmp"}}"#
            ))
            .unwrap()
        };
        let timeline = |service: &WorkspaceService| {
            service.snapshot().unwrap().sessions[0]
                .state_timeline
                .clone()
        };

        // Enter working -> working_since stamped with the event's updatedAt.
        service
            .record_session_activity_by_id(id, "claude-native", state(1, "working", "T1"))
            .unwrap();
        assert_eq!(timeline(&service).working_since.as_deref(), Some("T1"));
        assert_eq!(timeline(&service).resting_since, None);

        // Still working (new updatedAt) is not a transition: working_since holds.
        service
            .record_session_activity_by_id(id, "claude-native", state(2, "working", "T2"))
            .unwrap();
        assert_eq!(
            timeline(&service).working_since.as_deref(),
            Some("T1"),
            "the same class must not restamp"
        );

        // Come to rest -> resting_since stamped.
        service
            .record_session_activity_by_id(id, "claude-native", state(3, "awaiting_input", "T3"))
            .unwrap();
        assert_eq!(timeline(&service).resting_since.as_deref(), Some("T3"));

        // awaiting_input -> done share the resting class, so no restamp.
        service
            .record_session_activity_by_id(id, "claude-native", state(4, "done", "T4"))
            .unwrap();
        assert_eq!(
            timeline(&service).resting_since.as_deref(),
            Some("T3"),
            "done and awaiting_input are both at rest"
        );

        // Block on a question -> blocked_since stamped (the attention key).
        service
            .record_session_activity_by_id(id, "claude-native", state(5, "awaiting_response", "T5"))
            .unwrap();
        assert_eq!(timeline(&service).blocked_since.as_deref(), Some("T5"));

        // Relaunch idempotency: reset the ordering baseline, then a re-read of the
        // same (blocked) class at a fresh updatedAt must NOT restamp, so ordering
        // survives a restart.
        assert!(service.reset_session_activity_sequence(id).unwrap());
        service
            .record_session_activity_by_id(id, "claude-native", state(1, "awaiting_response", "T9"))
            .unwrap();
        assert_eq!(
            timeline(&service).blocked_since.as_deref(),
            Some("T5"),
            "a relaunch re-read of the same class must not restamp"
        );
    }

    #[test]
    fn mark_session_finished_stamps_exited_at() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let id = service
            .create_session(
                focus,
                "S".to_owned(),
                AgentKind::CortexCode,
                "/tmp".into(),
                None,
            )
            .unwrap()
            .sessions[0]
            .id;
        assert!(
            service.snapshot().unwrap().sessions[0]
                .state_timeline
                .exited_at
                .is_none()
        );

        service.mark_session_finished(id, true).unwrap();
        assert!(
            service.snapshot().unwrap().sessions[0]
                .state_timeline
                .exited_at
                .is_some()
        );
    }

    #[test]
    fn archive_project_sets_only_its_own_bit_and_restores_clean() {
        let (_repo, service) = service();
        let snapshot = service
            .create_project("Reverie".to_owned(), "/repo".into())
            .unwrap();
        let project_id = snapshot.projects[0].id;
        let focus_snapshot = service
            .create_focus(Some(project_id), "Terminal".to_owned(), None, None)
            .unwrap();
        let focus_id = focus_snapshot
            .focuses
            .iter()
            .find(|f| f.project_id == Some(project_id))
            .unwrap()
            .id;
        let session_id = service
            .create_session(
                focus_id,
                "S".to_owned(),
                AgentKind::CortexCode,
                "/repo".into(),
                None,
            )
            .unwrap()
            .sessions[0]
            .id;

        let snapshot = service.archive_project(project_id).unwrap();
        let project = snapshot
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .unwrap();
        let focus = snapshot.focuses.iter().find(|f| f.id == focus_id).unwrap();
        let session = snapshot
            .sessions
            .iter()
            .find(|s| s.id == session_id)
            .unwrap();
        // Only the project's own bit moves; the topic and session are hidden by
        // ancestry (computed on the frontend), so their own bits stay false.
        assert!(project.archived);
        assert!(!focus.archived);
        assert!(!session.archived);

        // Deleting the archived project purges its whole subtree (the General
        // focus seeded by `service()` is untouched: it is not under the project).
        let purged = service.delete_project(project_id).unwrap();
        assert!(!purged.projects.iter().any(|p| p.id == project_id));
        assert!(!purged.focuses.iter().any(|f| f.id == focus_id));
        assert!(!purged.sessions.iter().any(|s| s.id == session_id));
    }

    #[test]
    fn discover_and_attach_is_noop_without_agent_home() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let id = service
            .create_session(
                focus,
                "Cortex".to_owned(),
                AgentKind::CortexCode,
                "/tmp".into(),
                None,
            )
            .unwrap()
            .sessions[0]
            .id;
        // The Cortex adapter discovers nothing without a home to scan.
        assert!(
            !service
                .discover_and_attach_native_session(id, Some(0), None)
                .unwrap()
        );
        assert!(
            service.snapshot().unwrap().sessions[0]
                .native_session_ref
                .is_none()
        );
    }

    #[test]
    fn discover_and_attach_skips_session_with_existing_ref() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let id = service
            .create_session(
                focus,
                "Cortex".to_owned(),
                AgentKind::CortexCode,
                "/tmp/reverie".into(),
                None,
            )
            .unwrap()
            .sessions[0]
            .id;
        service
            .attach_native_session(
                id,
                "/tmp/reverie".into(),
                NativeSessionRef::cortex("n", None),
                AgentKind::CortexCode,
            )
            .unwrap();
        // A session that already has a ref is skipped even with a home set.
        assert!(
            !service
                .discover_and_attach_native_session(id, Some(0), Some("/nonexistent".into()))
                .unwrap()
        );
    }

    #[test]
    fn discover_refreshes_missing_metadata_path_for_existing_codex_ref() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let codex_home = tempfile::TempDir::new().unwrap();
        let cwd = tempfile::TempDir::new().unwrap();
        let rollout_dir = codex_home.path().join("sessions/2026/06/16");
        std::fs::create_dir_all(&rollout_dir).unwrap();
        let rollout_path = rollout_dir.join("rollout-same.jsonl");
        std::fs::write(
            &rollout_path,
            format!(
                r#"{{"type":"session_meta","payload":{{"id":"codex-native","cwd":{}}}}}"#,
                serde_json::to_string(&cwd.path().display().to_string()).unwrap()
            ),
        )
        .unwrap();

        let id = service
            .create_session(
                focus,
                "Codex".to_owned(),
                AgentKind::CodexCli,
                cwd.path().into(),
                None,
            )
            .unwrap()
            .sessions[0]
            .id;
        service
            .attach_native_session(
                id,
                cwd.path().into(),
                NativeSessionRef::codex("codex-native", None),
                AgentKind::CodexCli,
            )
            .unwrap();

        let refreshed = service
            .discover_and_attach_native_session(id, Some(0), Some(codex_home.path().into()))
            .unwrap();
        assert!(refreshed, "same native id should fill in the rollout path");
        let native = service
            .snapshot()
            .unwrap()
            .sessions
            .into_iter()
            .find(|session| session.id == id)
            .unwrap()
            .native_session_ref
            .expect("native ref");
        assert_eq!(native.session_id.as_deref(), Some("codex-native"));
        assert_eq!(
            native.metadata_path.as_deref(),
            Some(rollout_path.as_path())
        );
    }

    #[test]
    fn backfill_binds_codex_rollout_by_native_id_across_siblings() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let codex_home = tempfile::TempDir::new().unwrap();
        let cwd = tempfile::TempDir::new().unwrap();
        let rollout_dir = codex_home.path().join("sessions/2026/06/16");
        std::fs::create_dir_all(&rollout_dir).unwrap();
        let cwd_json = serde_json::to_string(&cwd.path().display().to_string()).unwrap();
        // Two sessions in the SAME cwd. The sibling's rollout is the newest, so the
        // cwd scan would hand this session the wrong file; the id lookup must not.
        let own_path = rollout_dir.join("rollout-2026-06-16T10-00-00-codex-self.jsonl");
        std::fs::write(
            &own_path,
            format!(
                r#"{{"type":"session_meta","payload":{{"id":"codex-self","cwd":{cwd_json}}}}}"#
            ),
        )
        .unwrap();
        std::fs::write(
            rollout_dir.join("rollout-2026-06-16T11-00-00-codex-sibling.jsonl"),
            format!(
                r#"{{"type":"session_meta","payload":{{"id":"codex-sibling","cwd":{cwd_json}}}}}"#
            ),
        )
        .unwrap();

        let id = service
            .create_session(
                focus,
                "Codex".to_owned(),
                AgentKind::CodexCli,
                cwd.path().into(),
                None,
            )
            .unwrap()
            .sessions[0]
            .id;
        // An id-only ref, the exact state the launch-time cwd scan leaves behind.
        service
            .attach_native_session(
                id,
                cwd.path().into(),
                NativeSessionRef::codex("codex-self", None),
                AgentKind::CodexCli,
            )
            .unwrap();

        let bound = service
            .backfill_codex_rollout_path(id, codex_home.path())
            .unwrap();
        assert!(bound, "an id-only Codex ref should bind its rollout by id");
        let native = service
            .snapshot()
            .unwrap()
            .sessions
            .into_iter()
            .find(|session| session.id == id)
            .unwrap()
            .native_session_ref
            .expect("native ref");
        assert_eq!(native.session_id.as_deref(), Some("codex-self"));
        assert_eq!(native.metadata_path.as_deref(), Some(own_path.as_path()));

        // Idempotent: a ref that already has a path is left alone.
        assert!(
            !service
                .backfill_codex_rollout_path(id, codex_home.path())
                .unwrap()
        );
    }

    #[test]
    fn discover_does_not_repoint_existing_codex_ref_to_different_id() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let codex_home = tempfile::TempDir::new().unwrap();
        let cwd = tempfile::TempDir::new().unwrap();
        let rollout_dir = codex_home.path().join("sessions/2026/06/16");
        std::fs::create_dir_all(&rollout_dir).unwrap();
        std::fs::write(
            rollout_dir.join("rollout-other.jsonl"),
            format!(
                r#"{{"type":"session_meta","payload":{{"id":"other-native","cwd":{}}}}}"#,
                serde_json::to_string(&cwd.path().display().to_string()).unwrap()
            ),
        )
        .unwrap();

        let id = service
            .create_session(
                focus,
                "Codex".to_owned(),
                AgentKind::CodexCli,
                cwd.path().into(),
                None,
            )
            .unwrap()
            .sessions[0]
            .id;
        service
            .attach_native_session(
                id,
                cwd.path().into(),
                NativeSessionRef::codex("codex-native", None),
                AgentKind::CodexCli,
            )
            .unwrap();

        let refreshed = service
            .discover_and_attach_native_session(id, Some(0), Some(codex_home.path().into()))
            .unwrap();
        assert!(
            !refreshed,
            "cwd discovery must not repoint an existing native ref"
        );
        let native = service
            .snapshot()
            .unwrap()
            .sessions
            .into_iter()
            .find(|session| session.id == id)
            .unwrap()
            .native_session_ref
            .expect("native ref");
        assert_eq!(native.session_id.as_deref(), Some("codex-native"));
        assert!(native.metadata_path.is_none());
    }

    /// Two same-CLI sessions sharing one folder must not adopt the same native
    /// id. The mtime heuristic alone would hand a launching session whichever
    /// sibling wrote most recently; the exclusion guard makes it skip claimed
    /// ids and bind to its own (here older) file instead, so the two sessions
    /// never `--resume` into one conversation.
    #[test]
    fn discover_skips_a_native_id_a_sibling_already_owns_in_the_same_folder() {
        use std::collections::BTreeMap;
        let (_repo, service) = service();
        let focus = make_focus(&service);

        let cortex_home = tempfile::TempDir::new().unwrap();
        let shared = tempfile::TempDir::new().unwrap();
        let cwd: PathBuf = shared.path().into();

        let write_meta = |id: &str, updated_at: i64| {
            let dir = cortex_home.path().join("sessions").join(id);
            std::fs::create_dir_all(&dir).unwrap();
            let metadata = CortexSessionMetadata {
                id: id.to_owned(),
                mode: Some("build".to_owned()),
                provider: Some("openai-codex".to_owned()),
                model: None,
                cwd: cwd.clone(),
                created_at: Some(updated_at - 100),
                updated_at: Some(updated_at),
                adapter_payload: BTreeMap::new(),
            };
            std::fs::write(
                dir.join("meta.json"),
                serde_json::to_string(&metadata).unwrap(),
            )
            .unwrap();
        };
        // Sibling A's file is the NEWEST on disk (it is actively writing); the
        // new session B's own file is older.
        write_meta("sess-shared", 2_000);
        write_meta("sess-bee", 1_000);

        let a = service
            .create_session(
                focus,
                "A".to_owned(),
                AgentKind::CortexCode,
                cwd.clone(),
                None,
            )
            .unwrap()
            .sessions
            .into_iter()
            .find(|session| session.title == "A")
            .unwrap()
            .id;
        let b = service
            .create_session(
                focus,
                "B".to_owned(),
                AgentKind::CortexCode,
                cwd.clone(),
                None,
            )
            .unwrap()
            .sessions
            .into_iter()
            .find(|session| session.title == "B")
            .unwrap()
            .id;

        // A owns the newest file's id.
        service
            .attach_native_session(
                a,
                cwd.clone(),
                NativeSessionRef::cortex("sess-shared", None),
                AgentKind::CortexCode,
            )
            .unwrap();

        // B discovers: it must skip A's claimed id and bind its own older file.
        let captured = service
            .discover_and_attach_native_session(b, Some(0), Some(cortex_home.path().into()))
            .unwrap();
        assert!(captured, "B should still capture its own session");
        let b_ref = service
            .snapshot()
            .unwrap()
            .sessions
            .into_iter()
            .find(|session| session.id == b)
            .unwrap()
            .native_session_ref
            .expect("B captured a native ref");
        assert_eq!(
            b_ref.session_id.as_deref(),
            Some("sess-bee"),
            "B must not adopt the sibling's claimed id"
        );
    }

    /// When the only cwd-matching file on disk is one a sibling already owns
    /// (the new session has not written its own yet), discovery must capture
    /// nothing rather than collide. The token-bound hook (Claude) or a later
    /// poll iteration is then free to bind the correct id.
    #[test]
    fn discover_captures_nothing_when_only_a_claimed_sibling_file_matches() {
        use std::collections::BTreeMap;
        let (_repo, service) = service();
        let focus = make_focus(&service);

        let cortex_home = tempfile::TempDir::new().unwrap();
        let shared = tempfile::TempDir::new().unwrap();
        let cwd: PathBuf = shared.path().into();

        let dir = cortex_home.path().join("sessions").join("sess-shared");
        std::fs::create_dir_all(&dir).unwrap();
        let metadata = CortexSessionMetadata {
            id: "sess-shared".to_owned(),
            mode: Some("build".to_owned()),
            provider: Some("openai-codex".to_owned()),
            model: None,
            cwd: cwd.clone(),
            created_at: Some(900),
            updated_at: Some(1_000),
            adapter_payload: BTreeMap::new(),
        };
        std::fs::write(
            dir.join("meta.json"),
            serde_json::to_string(&metadata).unwrap(),
        )
        .unwrap();

        let a = service
            .create_session(
                focus,
                "A".to_owned(),
                AgentKind::CortexCode,
                cwd.clone(),
                None,
            )
            .unwrap()
            .sessions
            .into_iter()
            .find(|session| session.title == "A")
            .unwrap()
            .id;
        let b = service
            .create_session(
                focus,
                "B".to_owned(),
                AgentKind::CortexCode,
                cwd.clone(),
                None,
            )
            .unwrap()
            .sessions
            .into_iter()
            .find(|session| session.title == "B")
            .unwrap()
            .id;
        service
            .attach_native_session(
                a,
                cwd.clone(),
                NativeSessionRef::cortex("sess-shared", None),
                AgentKind::CortexCode,
            )
            .unwrap();

        let captured = service
            .discover_and_attach_native_session(b, Some(0), Some(cortex_home.path().into()))
            .unwrap();
        assert!(
            !captured,
            "B must not adopt the sibling's only matching file"
        );
        assert!(
            service
                .snapshot()
                .unwrap()
                .sessions
                .into_iter()
                .find(|session| session.id == b)
                .unwrap()
                .native_session_ref
                .is_none()
        );
    }

    #[test]
    fn attach_native_session_overwrites_an_existing_ref() {
        let (_repo, service) = service();
        let focus = make_focus(&service);
        let id = service
            .create_session(
                focus,
                "Cortex".to_owned(),
                AgentKind::CortexCode,
                "/tmp/reverie".into(),
                None,
            )
            .unwrap()
            .sessions[0]
            .id;
        service
            .attach_native_session(
                id,
                "/tmp/reverie".into(),
                NativeSessionRef::cortex("first", None),
                AgentKind::CortexCode,
            )
            .unwrap();
        // The explicit Cortex capture re-attaches deliberately; a second attach
        // must replace the existing ref rather than silently no-op.
        service
            .attach_native_session(
                id,
                "/tmp/reverie".into(),
                NativeSessionRef::cortex("second", None),
                AgentKind::CortexCode,
            )
            .unwrap();
        let session = service.snapshot().unwrap().sessions[0].clone();
        assert_eq!(
            session.native_session_ref.and_then(|r| r.session_id),
            Some("second".to_owned())
        );
    }

    // --- folder-missing detection, relocation, and bookmark reconnection ---

    use std::collections::HashMap as TestMap;
    use std::sync::Mutex as TestMutex;

    /// Test double for the macOS bookmark provider: mints a blob that encodes the
    /// minted path, and resolves it back through an optional redirect table the
    /// test controls (to simulate a folder that moved).
    #[derive(Default)]
    struct FakeBookmarks {
        redirects: TestMutex<TestMap<PathBuf, PathBuf>>,
    }

    impl FakeBookmarks {
        fn redirect(&self, from: &Path, to: &Path) {
            self.redirects
                .lock()
                .unwrap()
                .insert(from.to_path_buf(), to.to_path_buf());
        }
    }

    impl BookmarkProvider for FakeBookmarks {
        fn create(&self, path: &Path) -> Option<Vec<u8>> {
            Some(path.to_string_lossy().into_owned().into_bytes())
        }
        fn resolve(&self, blob: &[u8]) -> Option<PathBuf> {
            let minted = PathBuf::from(String::from_utf8_lossy(blob).into_owned());
            Some(
                self.redirects
                    .lock()
                    .unwrap()
                    .get(&minted)
                    .cloned()
                    .unwrap_or(minted),
            )
        }
    }

    fn service_with_bookmarks() -> (
        Arc<InMemoryWorkspaceRepository>,
        WorkspaceService,
        Arc<FakeBookmarks>,
    ) {
        let repo = Arc::new(InMemoryWorkspaceRepository::new());
        let fake = Arc::new(FakeBookmarks::default());
        let service = WorkspaceService::new(repo.clone()).with_bookmark_provider(fake.clone());
        service.ensure_seeded().unwrap();
        (repo, service, fake)
    }

    /// Create a project with a focus and one session whose cwd is the project
    /// folder. Returns `(project_id, session_id)`.
    fn project_with_session(service: &WorkspaceService, path: &Path) -> (ProjectId, SessionId) {
        let snapshot = service
            .create_project("P".to_owned(), path.to_path_buf())
            .unwrap();
        let project_id = snapshot.projects.iter().find(|p| !p.archived).unwrap().id;
        let focus_snapshot = service
            .create_focus(Some(project_id), "T".to_owned(), None, None)
            .unwrap();
        let focus_id = focus_snapshot
            .focuses
            .iter()
            .find(|f| f.project_id == Some(project_id))
            .unwrap()
            .id;
        let session_snapshot = service
            .create_session(
                focus_id,
                "S".to_owned(),
                AgentKind::CortexCode,
                path.to_path_buf(),
                None,
            )
            .unwrap();
        let session_id = session_snapshot
            .sessions
            .iter()
            .find(|s| s.focus_id == focus_id)
            .unwrap()
            .id;
        (project_id, session_id)
    }

    fn project_in(snapshot: &WorkspaceSnapshot, id: ProjectId) -> &Project {
        snapshot.projects.iter().find(|p| p.id == id).unwrap()
    }

    fn session_cwd_in(snapshot: &WorkspaceSnapshot, id: SessionId) -> PathBuf {
        snapshot
            .sessions
            .iter()
            .find(|s| s.id == id)
            .unwrap()
            .cwd
            .clone()
    }

    #[test]
    fn snapshot_flags_folder_missing_when_path_is_gone() {
        let (_repo, service, _fake) = service_with_bookmarks();
        let root = tempfile::TempDir::new().unwrap();
        let folder = root.path().join("proj");
        std::fs::create_dir(&folder).unwrap();
        let (project_id, _session) = project_with_session(&service, &folder);

        let snap = service.snapshot().unwrap();
        assert!(!project_in(&snap, project_id).folder_missing);

        std::fs::remove_dir_all(&folder).unwrap();
        let snap = service.snapshot().unwrap();
        assert!(project_in(&snap, project_id).folder_missing);
    }

    #[test]
    fn archived_projects_are_never_flagged_missing() {
        let (_repo, service, _fake) = service_with_bookmarks();
        let root = tempfile::TempDir::new().unwrap();
        let folder = root.path().join("proj");
        std::fs::create_dir(&folder).unwrap();
        let (project_id, _session) = project_with_session(&service, &folder);
        service.archive_project(project_id).unwrap();
        std::fs::remove_dir_all(&folder).unwrap();
        let snap = service.snapshot().unwrap();
        assert!(!project_in(&snap, project_id).folder_missing);
    }

    #[test]
    fn build_agent_launch_errors_when_folder_missing() {
        let (_repo, service, _fake) = service_with_bookmarks();
        let root = tempfile::TempDir::new().unwrap();
        let folder = root.path().join("proj");
        std::fs::create_dir(&folder).unwrap();
        let (_project_id, session_id) = project_with_session(&service, &folder);
        std::fs::remove_dir_all(&folder).unwrap();
        let err = service.build_agent_launch(session_id, 80, 24).unwrap_err();
        assert!(err.to_string().contains("folder is missing"), "got: {err}");
    }

    #[test]
    fn relocate_project_repoints_path_and_session_cwds() {
        let (_repo, service, _fake) = service_with_bookmarks();
        let root = tempfile::TempDir::new().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        std::fs::create_dir(&old).unwrap();
        std::fs::create_dir(&new).unwrap();
        let (project_id, session_id) = project_with_session(&service, &old);

        let snap = service.relocate_project(project_id, new.clone()).unwrap();
        assert_eq!(project_in(&snap, project_id).path, new);
        assert_eq!(session_cwd_in(&snap, session_id), new);
        assert!(!project_in(&snap, project_id).folder_missing);
    }

    #[test]
    fn relocate_rejects_a_folder_owned_by_another_project() {
        let (_repo, service, _fake) = service_with_bookmarks();
        let root = tempfile::TempDir::new().unwrap();
        let a = root.path().join("a");
        let b = root.path().join("b");
        std::fs::create_dir(&a).unwrap();
        std::fs::create_dir(&b).unwrap();
        let (project_a, _s) = project_with_session(&service, &a);
        service.create_project("B".to_owned(), b.clone()).unwrap();
        assert!(service.relocate_project(project_a, b).is_err());
    }

    #[test]
    fn reconcile_backfills_bookmark_for_existing_folder() {
        let (repo, service, _fake) = service_with_bookmarks();
        let root = tempfile::TempDir::new().unwrap();
        let folder = root.path().join("proj");
        std::fs::create_dir(&folder).unwrap();
        // A project whose folder exists but which has no bookmark yet, as if it
        // were created before this feature shipped.
        let mut p = Project::new("P", folder.clone());
        p.bookmark = None;
        let project_id = p.id;
        repo.upsert_project(&p).unwrap();

        service.reconcile_project_folders().unwrap();
        let stored = repo.load_snapshot().unwrap();
        assert!(project_in(&stored, project_id).bookmark.is_some());
    }

    #[test]
    fn reconcile_auto_heals_a_moved_folder() {
        let (_repo, service, fake) = service_with_bookmarks();
        let root = tempfile::TempDir::new().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        std::fs::create_dir(&old).unwrap();
        std::fs::create_dir(&new).unwrap();
        let (project_id, session_id) = project_with_session(&service, &old);

        // Simulate a move: the folder is now at `new`, and the bookmark minted at
        // `old` resolves to `new`.
        fake.redirect(&old, &new);
        std::fs::remove_dir_all(&old).unwrap();

        let changed = service.reconcile_project_folders().unwrap();
        assert!(changed, "a resolvable move should heal");
        let snap = service.snapshot().unwrap();
        assert_eq!(project_in(&snap, project_id).path, new);
        assert_eq!(session_cwd_in(&snap, session_id), new);
        assert!(!project_in(&snap, project_id).folder_missing);
    }

    #[test]
    fn reconcile_flags_missing_when_bookmark_cannot_resolve() {
        let (_repo, service, _fake) = service_with_bookmarks();
        let root = tempfile::TempDir::new().unwrap();
        let folder = root.path().join("proj");
        std::fs::create_dir(&folder).unwrap();
        let (project_id, _session) = project_with_session(&service, &folder);

        // Move with no redirect: the bookmark resolves back to the now-missing
        // original path, so it can't heal and the project stays flagged.
        std::fs::remove_dir_all(&folder).unwrap();
        let changed = service.reconcile_project_folders().unwrap();
        assert!(!changed);
        let snap = service.snapshot().unwrap();
        assert!(project_in(&snap, project_id).folder_missing);
    }
}
