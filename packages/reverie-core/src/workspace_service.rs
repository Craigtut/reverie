//! Workspace business logic over a [`WorkspaceRepository`].
//!
//! This is the home for everything that used to live tangled inside the Tauri
//! shell's `AppShellStore`: input validation, boot-time session normalization,
//! the activity sequence-guard, and orchestration of incremental repository
//! writes. It depends only on the repository trait and the agent adapters, so
//! it is fully testable against [`InMemoryWorkspaceRepository`] without Tauri
//! or a real database, and it is `Send + Sync` for use as Tauri managed state.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};

use crate::activity::{ActivityState, ActivityStatus, TurnStatus};
use crate::agents::{
    CortexSessionMetadata, DiscoveryContext, build_spawn_spec, built_in_adapters, require_detected,
};
use crate::domain::{
    AgentKind, Focus, FocusId, LaunchMode, NativeSessionRef, Project, ProjectId, Session,
    SessionId, SessionStatus, ThemeMode, Workspace, WorkspaceId, WorkspaceSnapshot,
};
use crate::repository::WorkspaceRepository;
use crate::terminal::TerminalSpawnSpec;

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

#[derive(Clone)]
pub struct WorkspaceService {
    repo: Arc<dyn WorkspaceRepository>,
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
}

impl WorkspaceService {
    pub fn new(repo: Arc<dyn WorkspaceRepository>) -> Self {
        Self { repo }
    }

    /// Seed the workspace row on first run, then reconcile any sessions left in
    /// a transient state by an unclean shutdown. Idempotent.
    pub fn ensure_seeded(&self) -> Result<()> {
        let seed = Workspace {
            id: seed_workspace_id(),
            name: "Local workspace".to_owned(),
            general_label: "General".to_owned(),
            default_dangerous_mode: false,
            default_new_session_dangerous: false,
            disabled_agent_kinds: Vec::new(),
            theme: ThemeMode::Dark,
            default_agent_kind: AgentKind::CortexCode,
            terminal_font_size: DEFAULT_TERMINAL_FONT_SIZE,
            nav_state: None,
        };
        self.repo.ensure_seeded(&seed)?;
        self.ensure_general_focus(&seed.general_label)?;
        self.normalize_sessions()?;
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
        Ok(self.repo.load_snapshot()?)
    }

    pub fn create_project(&self, name: String, path: PathBuf) -> Result<WorkspaceSnapshot> {
        let name = required_text(name, "project name")?;
        if path.as_os_str().is_empty() {
            bail!("project path is required");
        }
        let snapshot = self.repo.load_snapshot()?;
        if snapshot
            .projects
            .iter()
            .any(|project| !project.archived && project.path == path)
        {
            bail!("project path is already in Reverie: {}", path.display());
        }
        let sort_order = snapshot
            .projects
            .iter()
            .filter(|project| !project.archived)
            .map(|project| project.sort_order)
            .max()
            .map_or(0, |current| current + 10);
        let mut project = Project::new(name, path);
        project.sort_order = sort_order;
        self.repo.upsert_project(&project)?;
        Ok(self.repo.load_snapshot()?)
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
        Ok(self.repo.load_snapshot()?)
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
        Ok(self.repo.load_snapshot()?)
    }

    pub fn set_session_tab_visibility(
        &self,
        session_id: SessionId,
        tab_visible: bool,
    ) -> Result<WorkspaceSnapshot> {
        self.update_session(session_id, |session| session.tab_visible = tab_visible)
    }

    /// Archive or restore a session. Archiving also drops its tab; restoring
    /// brings the tab back so reopening lands the user on the live surface.
    /// Closing a session (tab bar or sidebar) archives it; the focus's archived
    /// list is the only place it shows afterward, and restore reverses this.
    pub fn set_session_archived(
        &self,
        session_id: SessionId,
        archived: bool,
    ) -> Result<WorkspaceSnapshot> {
        self.update_session(session_id, |session| {
            session.archived = archived;
            session.tab_visible = !archived;
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

    pub fn set_workspace_default_dangerous_mode(
        &self,
        default_dangerous_mode: bool,
    ) -> Result<WorkspaceSnapshot> {
        let mut workspace = self.repo.load_snapshot()?.workspace;
        workspace.default_dangerous_mode = default_dangerous_mode;
        self.repo.save_workspace(&workspace)?;
        Ok(self.repo.load_snapshot()?)
    }

    /// Persist the default YOLO state seeded into the new-session composer. This
    /// only affects the starting value of future new-session forms; it does not
    /// touch any existing session and is independent of the workspace
    /// `default_dangerous_mode` fallback.
    pub fn set_workspace_default_new_session_dangerous(
        &self,
        default_new_session_dangerous: bool,
    ) -> Result<WorkspaceSnapshot> {
        let mut workspace = self.repo.load_snapshot()?.workspace;
        workspace.default_new_session_dangerous = default_new_session_dangerous;
        self.repo.save_workspace(&workspace)?;
        Ok(self.repo.load_snapshot()?)
    }

    /// Persist the workspace appearance (light/dark). The renderer seeds its
    /// live theme from this value on load, so it survives restarts.
    pub fn set_workspace_theme(&self, theme: ThemeMode) -> Result<WorkspaceSnapshot> {
        let mut workspace = self.repo.load_snapshot()?.workspace;
        workspace.theme = theme;
        self.repo.save_workspace(&workspace)?;
        Ok(self.repo.load_snapshot()?)
    }

    /// Persist the default agent kind seeded into the new-session composer. This
    /// only affects the starting value of future new-session forms; it does not
    /// touch any existing session.
    pub fn set_workspace_default_agent_kind(&self, kind: AgentKind) -> Result<WorkspaceSnapshot> {
        let mut workspace = self.repo.load_snapshot()?.workspace;
        workspace.default_agent_kind = kind;
        self.repo.save_workspace(&workspace)?;
        Ok(self.repo.load_snapshot()?)
    }

    /// Persist the terminal font size (CSS px), clamped to the renderer's
    /// supported range so an out-of-range value can never store a degenerate
    /// cell. The renderer reads it back on load and re-derives the terminal cell.
    pub fn set_terminal_font_size(&self, font_size: u16) -> Result<WorkspaceSnapshot> {
        let mut workspace = self.repo.load_snapshot()?.workspace;
        workspace.terminal_font_size =
            font_size.clamp(MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE);
        self.repo.save_workspace(&workspace)?;
        Ok(self.repo.load_snapshot()?)
    }

    /// Persist the opaque, frontend-owned UI view state (last selected
    /// focus/session, active surface, sidebar accordion). The renderer reads it
    /// back on load so the workspace reopens where the user left it. The domain
    /// stores it verbatim and never interprets it; `None` clears it.
    pub fn set_workspace_nav_state(&self, nav_state: Option<String>) -> Result<WorkspaceSnapshot> {
        let mut workspace = self.repo.load_snapshot()?.workspace;
        workspace.nav_state = nav_state;
        self.repo.save_workspace(&workspace)?;
        Ok(self.repo.load_snapshot()?)
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
        Ok(self.repo.load_snapshot()?)
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
        Ok(self.repo.load_snapshot()?)
    }

    pub fn archive_focus(&self, focus_id: FocusId) -> Result<WorkspaceSnapshot> {
        self.repo.archive_focus_cascade(focus_id)?;
        Ok(self.repo.load_snapshot()?)
    }

    pub fn archive_project(&self, project_id: ProjectId) -> Result<WorkspaceSnapshot> {
        self.repo.archive_project_cascade(project_id)?;
        Ok(self.repo.load_snapshot()?)
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
        Ok(self.repo.load_snapshot()?)
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
        Ok(self.repo.load_snapshot()?)
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
        Ok(self.repo.load_snapshot()?)
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
        Ok(self.repo.load_snapshot()?)
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
        Ok(self.repo.load_snapshot()?)
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
        let mut session = self
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
        session.native_session_ref = Some(native_session_ref);
        session.launch_mode = LaunchMode::Resume;
        if session.status != SessionStatus::Running {
            session.status = SessionStatus::Restorable;
        }
        self.repo.upsert_session(&session)?;
        Ok(())
    }

    /// Run adapter-driven native-session discovery for a just-launched session
    /// and attach the result if found. No-op (`Ok(false)`) when the session
    /// already has a native ref or its adapter has no filesystem discovery.
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
        if session.native_session_ref.is_some() {
            return Ok(false);
        }
        let Some(adapter) = built_in_adapters()
            .into_iter()
            .find(|adapter| adapter.kind() == session.agent_kind)
        else {
            return Ok(false);
        };
        let context = DiscoveryContext {
            cwd: session.cwd.clone(),
            launched_after_ms,
            agent_home,
        };
        let Some(native_session_ref) = adapter.discover_native_session(&context)? else {
            return Ok(false);
        };
        self.attach_native_session(
            session_id,
            session.cwd.clone(),
            native_session_ref,
            session.agent_kind,
        )?;
        Ok(true)
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
            if existing.sequence > activity.sequence {
                return Ok(false);
            }
        }
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
        let Some(mut session) = self.repo.get_session(reverie_session_id)? else {
            return Ok(false);
        };
        if let Some(existing) = &session.latest_activity {
            if existing.sequence > activity.sequence {
                return Ok(false);
            }
        }
        let captured_native_session = session.native_session_ref.is_none();
        if captured_native_session {
            session.native_session_ref = Some(NativeSessionRef {
                kind: session.agent_kind,
                session_id: Some(native_session_id.to_owned()),
                metadata_path: None,
                adapter_payload: serde_json::Value::Null,
            });
        }
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
        let snapshot = self.repo.load_snapshot()?;
        let session = snapshot
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .with_context(|| format!("unknown Reverie session {session_id}"))?;
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
        let spec = build_spawn_spec(
            session,
            focus_or_workspace_default,
            cols,
            rows,
            executable_path,
            adapter.as_ref(),
        )?;
        Ok(AgentLaunch {
            spec,
            agent_kind,
            folder_name,
        })
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
        Ok(self.repo.load_snapshot()?)
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

    if let Some(activity) = session.latest_activity.as_mut() {
        if normalize_stale_activity(activity) {
            changed = true;
        }
    }

    changed
}

/// Reconcile a persisted activity snapshot left mid-flight by an unclean
/// shutdown. Quitting Reverie kills every agent process, so on the next boot no
/// session can still be `Working` or `AwaitingPermission`: those are live-process
/// states. Resuming a CLI only restores the conversation history, it does not
/// re-raise the permission prompt or pick the turn back up, so a persisted
/// "needs your approval" or "working" snapshot is stale and would mislead the
/// dashboard into showing attention/active for a session that is really just
/// waiting for you. Reset those two statuses to the at-rest `AwaitingInput` and
/// drop the now-meaningless pending permission, running turn, and active tools.
/// Other statuses (`AwaitingInput`, `Done`, `Error`) describe an outcome, not a
/// live process, so they are left untouched. Returns whether anything changed.
fn normalize_stale_activity(activity: &mut ActivityState) -> bool {
    if !matches!(
        activity.status,
        ActivityStatus::Working | ActivityStatus::AwaitingPermission
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
    fn set_workspace_default_new_session_dangerous_persists_and_is_independent() {
        let (_repo, service) = service();
        // Defaults to off and starts independent of the dangerous-mode fallback.
        let workspace = service.snapshot().unwrap().workspace;
        assert!(!workspace.default_new_session_dangerous);
        assert!(!workspace.default_dangerous_mode);

        // Turning it on persists and round-trips.
        let snapshot = service
            .set_workspace_default_new_session_dangerous(true)
            .unwrap();
        assert!(snapshot.workspace.default_new_session_dangerous);
        // It must not flip the dangerous-mode fallback.
        assert!(!snapshot.workspace.default_dangerous_mode);
        // A fresh load sees the persisted value.
        assert!(
            service
                .snapshot()
                .unwrap()
                .workspace
                .default_new_session_dangerous
        );

        // Setting the dangerous-mode fallback does not touch the new-session
        // default, and vice versa.
        let snapshot = service.set_workspace_default_dangerous_mode(true).unwrap();
        assert!(snapshot.workspace.default_dangerous_mode);
        assert!(snapshot.workspace.default_new_session_dangerous);

        let snapshot = service
            .set_workspace_default_new_session_dangerous(false)
            .unwrap();
        assert!(!snapshot.workspace.default_new_session_dangerous);
        assert!(snapshot.workspace.default_dangerous_mode);
    }

    #[test]
    fn set_workspace_theme_and_default_agent_kind_persist_independently() {
        let (_repo, service) = service();
        // Fresh workspaces default to dark + Cortex.
        let workspace = service.snapshot().unwrap().workspace;
        assert_eq!(workspace.theme, ThemeMode::Dark);
        assert_eq!(workspace.default_agent_kind, AgentKind::CortexCode);

        // Theme persists and round-trips without touching the default agent.
        let snapshot = service.set_workspace_theme(ThemeMode::Light).unwrap();
        assert_eq!(snapshot.workspace.theme, ThemeMode::Light);
        assert_eq!(snapshot.workspace.default_agent_kind, AgentKind::CortexCode);
        assert_eq!(
            service.snapshot().unwrap().workspace.theme,
            ThemeMode::Light
        );

        // Default agent persists and is independent of the theme.
        let snapshot = service
            .set_workspace_default_agent_kind(AgentKind::ClaudeCode)
            .unwrap();
        assert_eq!(snapshot.workspace.default_agent_kind, AgentKind::ClaudeCode);
        assert_eq!(snapshot.workspace.theme, ThemeMode::Light);

        // Setting one does not flip the other.
        let snapshot = service.set_workspace_theme(ThemeMode::Dark).unwrap();
        assert_eq!(snapshot.workspace.theme, ThemeMode::Dark);
        assert_eq!(snapshot.workspace.default_agent_kind, AgentKind::ClaudeCode);
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
    fn new_session_default_does_not_change_session_overrides() {
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

        service
            .set_workspace_default_new_session_dangerous(true)
            .unwrap();
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
        assert!(snapshot.sessions[0].tab_visible);
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

        let rest = snapshot
            .sessions
            .iter()
            .find(|s| s.id == done.id)
            .unwrap()
            .latest_activity
            .as_ref()
            .unwrap();
        assert_eq!(rest.status, ActivityStatus::Done);
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
    fn archive_project_cascade_hides_sessions() {
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
        assert!(
            snapshot
                .projects
                .iter()
                .find(|p| p.id == project_id)
                .unwrap()
                .archived
        );
        assert!(
            snapshot
                .focuses
                .iter()
                .find(|f| f.id == focus_id)
                .unwrap()
                .archived
        );
        assert!(
            !snapshot
                .sessions
                .iter()
                .find(|s| s.id == session_id)
                .unwrap()
                .tab_visible
        );
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
}
