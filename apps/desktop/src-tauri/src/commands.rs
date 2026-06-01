//! Tauri command surface: every `#[tauri::command]` the React shell invokes,
//! the request/response DTOs they deserialize, and the helpers scoped to them.
//! Handlers are thin wrappers over `WorkspaceService` and the terminal runtime.

use std::env;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;
use reverie_core::agents::{AgentAdapter, ClaudeCodeAdapter, built_in_adapters};
use reverie_core::domain::{AgentKind, FocusId, ProjectId, SessionId, ThemeMode};
use reverie_core::hook_config::{hook_url, write_claude_settings};
use reverie_core::hook_server::{HookServerControl, HookSource};
use reverie_core::terminal::{TerminalFrame, TerminalId};
use reverie_core::{
    AdapterDetection, ConnectionService, RegisteredSession, SessionAddress, TerminalSpawnSpec,
    WorkspaceService, WorkspaceSnapshot,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

#[cfg(unix)]
use crate::bridge::{BridgeInfo, mint_session_secret};
use crate::state::{HookServerInfo, HookTokenRegistry, ShutdownState, WorkspaceBoot};
use crate::terminal::ghostty::GhosttyTerminalState;
use crate::terminal::runtime::{
    TerminalSessionRecord, TerminalSessionRuntime, TerminalStreamRequest,
};

const PROOF_COLS: u16 = 120;
const PROOF_ROWS: u16 = 36;
const PROOF_FRAMES: usize = 180;

#[derive(Debug, Serialize)]
pub(crate) struct GhosttyFrameSequence {
    label: &'static str,
    cols: u16,
    rows: u16,
    output_bytes: usize,
    frames: Vec<TerminalFrame>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartSessionRequest {
    session_id: Option<SessionId>,
    terminal_id: Option<TerminalId>,
    spawn_spec: Option<TerminalSpawnSpec>,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCliDetection {
    kind: AgentKind,
    display_name: &'static str,
    executable: Option<String>,
    candidates: Vec<String>,
    /// Detected on this machine (installed and on PATH / at a known location).
    available: bool,
    /// User has this CLI switched on. Enabled by default; only an explicit
    /// toggle-off in settings sets this false. A CLI must be both `available`
    /// and `enabled` to be offered as a session agent.
    enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectFolderSelection {
    name: String,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateProjectRequest {
    name: String,
    path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateFocusRequest {
    project_id: Option<ProjectId>,
    title: String,
    description: Option<String>,
    default_dangerous_mode: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateSessionRequest {
    focus_id: FocusId,
    title: String,
    agent_kind: AgentKind,
    cwd: PathBuf,
    dangerous_mode_override: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateSessionTabVisibilityRequest {
    shell_session_id: SessionId,
    tab_visible: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetSessionArchivedRequest {
    shell_session_id: SessionId,
    archived: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureCortexSessionRequest {
    shell_session_id: SessionId,
    cortex_session_id: String,
    metadata_path: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetSessionDangerousModeRequest {
    session_id: SessionId,
    dangerous_mode_override: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetWorkspaceDefaultDangerousModeRequest {
    default_dangerous_mode: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetWorkspaceDefaultNewSessionDangerousRequest {
    default_new_session_dangerous: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetWorkspaceThemeRequest {
    theme: ThemeMode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetWorkspaceDefaultAgentKindRequest {
    default_agent_kind: AgentKind,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetWorkspaceNavStateRequest {
    /// Opaque, frontend-owned JSON describing the last view (selection, surface,
    /// sidebar accordion). `None` clears it. The backend stores it verbatim.
    nav_state: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetAgentCliEnabledRequest {
    kind: AgentKind,
    enabled: bool,
}

#[tauri::command]
pub(crate) fn app_status() -> &'static str {
    "reverie-desktop-product-shell"
}

/// Sentinel returned while the backend is still opening + seeding the database.
/// The frontend treats this as a transient, retryable condition (it re-invokes
/// with backoff) rather than a real load failure, so a cold-start race never
/// leaves the user on a phantom-empty workspace.
pub(crate) const WORKSPACE_STARTING_UP: &str = "reverie:workspace-starting-up";

#[tauri::command]
pub(crate) fn workspace_shell(boot: State<'_, WorkspaceBoot>) -> Result<WorkspaceSnapshot, String> {
    // `boot` is managed from the very start, so this never hits Tauri's hard
    // "state not managed" error; until `setup` has finished seeding, it simply
    // has no service yet and we report a retryable starting-up signal.
    match boot.get() {
        Some(service) => service.snapshot().map_err(|err| err.to_string()),
        None => Err(WORKSPACE_STARTING_UP.to_owned()),
    }
}

#[tauri::command]
pub(crate) fn list_agent_clis(service: State<'_, WorkspaceService>) -> Vec<AgentCliDetection> {
    // A failed read defaults to "nothing disabled" so detection still works if
    // the workspace row is somehow unreadable; the toggle just appears on.
    let disabled = service.disabled_agent_kinds().unwrap_or_default();
    detect_agent_clis(&disabled)
}

/// Run detection across the built-in adapters and fold in the user's per-CLI
/// enablement (a CLI is enabled unless it is in `disabled`). Shared by
/// `list_agent_clis` and `set_agent_cli_enabled` so both return the same shape.
fn detect_agent_clis(disabled: &[AgentKind]) -> Vec<AgentCliDetection> {
    built_in_adapters()
        .into_iter()
        .map(|adapter| {
            let detection = adapter.detect();
            let executable = detection
                .executable()
                .map(|path| path.display().to_string());
            let candidates = match &detection {
                AdapterDetection::Available { .. } => adapter
                    .executable_candidates()
                    .iter()
                    .map(|candidate| (*candidate).to_owned())
                    .collect(),
                AdapterDetection::Missing { candidates } => candidates.clone(),
            };
            let kind = adapter.kind();

            AgentCliDetection {
                kind,
                display_name: adapter.display_name(),
                executable,
                candidates,
                available: detection.is_available(),
                enabled: !disabled.contains(&kind),
            }
        })
        .collect()
}

/// Switch a single agent CLI on or off. Returns the refreshed detection list
/// (so the shell store updates in one round-trip). Reverie tools (currently
/// the inter-agent bridge MCP entry and pre-turn hook) are managed in
/// lockstep with this toggle: enabling auto-installs them; disabling tears
/// them down. Both directions are best-effort and never block the toggle.
#[tauri::command]
pub(crate) fn set_agent_cli_enabled(
    app: AppHandle,
    service: State<'_, WorkspaceService>,
    request: SetAgentCliEnabledRequest,
) -> Result<Vec<AgentCliDetection>, String> {
    let snapshot = service
        .set_agent_cli_enabled(request.kind, request.enabled)
        .map_err(|err| err.to_string())?;

    if request.enabled {
        // Auto-install so a freshly-enabled CLI gets its Reverie integration
        // without a separate user action. Failure (read-only file, malformed
        // existing config, etc.) is logged and surfaced via the bridge
        // status, which the UI consults to render a retry affordance.
        if let Err(err) = install_bridge_for(&app, request.kind) {
            eprintln!("[reverie] could not install bridge for enabled CLI: {err:#}");
        }
    } else {
        // Tear down so a disabled CLI keeps nothing Reverie-managed in its
        // config. Best-effort: a failure here must not block the toggle.
        if let Err(err) = remove_bridge_for(&app, request.kind) {
            eprintln!("[reverie] could not remove bridge for disabled CLI: {err:#}");
        }
    }

    Ok(detect_agent_clis(&snapshot.workspace.disabled_agent_kinds))
}

/// Install the inter-agent bridge entries for one CLI. Unix-only.
#[cfg(unix)]
fn install_bridge_for(app: &AppHandle, kind: AgentKind) -> Result<()> {
    use crate::bridge_installer::{
        install_claude_bridge, install_codex_bridge, install_cortex_bridge,
    };
    use crate::connection_commands::resolve_bridge_binaries;
    let binaries = resolve_bridge_binaries(app)?;
    match kind {
        AgentKind::CortexCode => {
            install_cortex_bridge(&binaries)?;
        }
        AgentKind::CodexCli => {
            install_codex_bridge(&binaries)?;
        }
        AgentKind::ClaudeCode => {
            install_claude_bridge(&binaries)?;
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn install_bridge_for(_app: &AppHandle, _kind: AgentKind) -> Result<()> {
    Ok(())
}

/// Remove the inter-agent bridge entries for one CLI. Unix-only (the installer
/// is too); a no-op elsewhere.
#[cfg(unix)]
fn remove_bridge_for(_app: &AppHandle, kind: AgentKind) -> Result<()> {
    use crate::bridge_installer::{
        uninstall_claude_bridge, uninstall_codex_bridge, uninstall_cortex_bridge,
    };
    match kind {
        AgentKind::CortexCode => uninstall_cortex_bridge(),
        AgentKind::CodexCli => uninstall_codex_bridge(),
        AgentKind::ClaudeCode => uninstall_claude_bridge(),
    }
}

#[cfg(not(unix))]
fn remove_bridge_for(_app: &AppHandle, _kind: AgentKind) -> Result<()> {
    Ok(())
}

#[tauri::command]
pub(crate) fn choose_project_folder() -> Result<Option<ProjectFolderSelection>, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_title("Choose a project folder")
        .pick_folder()
    else {
        return Ok(None);
    };

    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("New project")
        .to_owned();

    Ok(Some(ProjectFolderSelection {
        name,
        path: path.display().to_string(),
    }))
}

/// Validate and normalize a path the user dropped onto the new-project surface
/// into a real project folder. Drag-drop (unlike the folder picker) hands us file
/// paths and folder paths alike, so we verify here: a dropped folder is used
/// as-is; a dropped file resolves to its containing folder; a path that does not
/// exist is rejected with a message the composer shows inline. This guarantees a
/// project is always backed by an existing directory.
#[tauri::command]
pub(crate) fn resolve_project_folder(path: String) -> Result<ProjectFolderSelection, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("No path was provided.".to_owned());
    }
    let candidate = PathBuf::from(trimmed);
    let metadata = std::fs::metadata(&candidate)
        .map_err(|_| format!("That path could not be found: {trimmed}"))?;

    let folder = if metadata.is_dir() {
        candidate
    } else {
        candidate
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .ok_or_else(|| "That file has no containing folder to use.".to_owned())?
    };

    let name = folder
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("New project")
        .to_owned();

    Ok(ProjectFolderSelection {
        name,
        path: folder.display().to_string(),
    })
}

#[tauri::command]
pub(crate) fn create_project(
    service: State<'_, WorkspaceService>,
    request: CreateProjectRequest,
) -> Result<WorkspaceSnapshot, String> {
    // Defense in depth: a project must point at a real directory. The picker and
    // the drag-drop resolver both guarantee this already, but reject here too so
    // a stale or hand-edited path can never create a file-backed project.
    if !request.path.as_os_str().is_empty() && !request.path.is_dir() {
        return Err(format!(
            "Project path is not a folder: {}",
            request.path.display()
        ));
    }
    service
        .create_project(request.name, request.path)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn create_focus(
    service: State<'_, WorkspaceService>,
    request: CreateFocusRequest,
) -> Result<WorkspaceSnapshot, String> {
    service
        .create_focus(
            request.project_id,
            request.title,
            request.description,
            request.default_dangerous_mode,
        )
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn create_session(
    app: AppHandle,
    service: State<'_, WorkspaceService>,
    request: CreateSessionRequest,
) -> Result<WorkspaceSnapshot, String> {
    // A General (project-less) session is not tied to a folder, so Reverie
    // provisions a fresh, isolated scratch workspace for it and launches the CLI
    // there instead of whatever cwd the frontend sent. Sessions in a
    // project-backed focus keep using the project's folder.
    let snapshot = service.snapshot().map_err(|err| err.to_string())?;
    let project_less = snapshot
        .focuses
        .iter()
        .find(|focus| focus.id == request.focus_id)
        .map(|focus| focus.project_id.is_none())
        .ok_or_else(|| format!("unknown focus {}", request.focus_id))?;
    let cwd = if project_less {
        provision_general_workspace(&app)?
    } else {
        request.cwd
    };
    service
        .create_session(
            request.focus_id,
            request.title,
            request.agent_kind,
            cwd,
            request.dangerous_mode_override,
        )
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn update_session_tab_visibility(
    service: State<'_, WorkspaceService>,
    request: UpdateSessionTabVisibilityRequest,
) -> Result<WorkspaceSnapshot, String> {
    service
        .set_session_tab_visibility(request.shell_session_id, request.tab_visible)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn set_session_archived(
    service: State<'_, WorkspaceService>,
    request: SetSessionArchivedRequest,
) -> Result<WorkspaceSnapshot, String> {
    service
        .set_session_archived(request.shell_session_id, request.archived)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn remove_session(
    app: AppHandle,
    service: State<'_, WorkspaceService>,
    session_id: SessionId,
) -> Result<WorkspaceSnapshot, String> {
    // Revoke any hook token tied to this session before deleting the record
    // so a still-running CLI can't keep authorizing against a now-orphaned id.
    if let (Some(control), Some(registry)) = (
        app.try_state::<HookServerControl>(),
        app.try_state::<HookTokenRegistry>(),
    ) {
        if let Some((source, token)) = registry.take(session_id) {
            control.revoke_session(source, &token);
        }
    }
    cleanup_session_hook_config(&app, session_id);
    unregister_session_from_bridge(&app, session_id);
    // Capture the session's cwd before the record is gone so we can remove its
    // scratch workspace afterward (General sessions only; see
    // `cleanup_general_workspace`).
    let scratch_cwd = service.snapshot().ok().and_then(|snapshot| {
        snapshot
            .sessions
            .into_iter()
            .find(|session| session.id == session_id)
            .map(|session| session.cwd)
    });
    let snapshot = service
        .remove_session(session_id)
        .map_err(|err| err.to_string())?;
    if let Some(cwd) = scratch_cwd {
        cleanup_general_workspace(&app, &cwd);
    }
    Ok(snapshot)
}

/// Delete the per-session hook config directory written under the app cache at
/// launch (`<cache>/sessions/<id>`). Best-effort: a leftover dir is harmless and
/// is rewritten on the next launch, so any failure only logs. The token itself
/// is revoked separately; a terminated-but-resumable session deliberately keeps
/// its token until removal or the next launch replaces it.
fn cleanup_session_hook_config(app: &AppHandle, session_id: SessionId) {
    let Ok(base) = app.path().app_cache_dir() else {
        return;
    };
    let dir = base.join("sessions").join(session_id.to_string());
    if dir.exists() {
        if let Err(err) = std::fs::remove_dir_all(&dir) {
            eprintln!(
                "[reverie-hooks] failed removing session hook dir {}: {err}",
                dir.display()
            );
        }
    }
}

/// Orientation written into every General session's scratch workspace.
const GENERAL_WORKSPACE_GUIDE: &str = "# Reverie general workspace

This is a temporary scratch workspace for a Reverie \"General\" session. It is not
tied to any project. Files you create here are ephemeral and may be removed when
this session is deleted.

If the user wants to keep this work, help them move it into a real project folder
(a folder on their computer that they choose) rather than leaving it here.
";

/// Root that holds the per-session scratch workspaces for General (project-less)
/// sessions, kept under the app data dir next to the database.
fn general_sessions_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|base| base.join("general-sessions"))
        .map_err(|err| format!("failed to resolve app data dir: {err}"))
}

/// Create a fresh, isolated scratch workspace for a General session and return
/// its path. The folder token is independent of the session id (which does not
/// exist yet at create time); the session's stored cwd is the only link back. The
/// directory is seeded with a CLAUDE.md plus a relative AGENTS.md symlink so any
/// CLI launched here gets the same orientation.
fn provision_general_workspace(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = general_sessions_root(app)?.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir).map_err(|err| {
        format!(
            "failed to create general workspace {}: {err}",
            dir.display()
        )
    })?;
    scaffold_general_workspace(&dir).map_err(|err| {
        format!(
            "failed to scaffold general workspace {}: {err}",
            dir.display()
        )
    })?;
    Ok(dir)
}

/// Write the CLAUDE.md guide and a relative AGENTS.md symlink into a scratch
/// workspace. Idempotent: an already-present symlink is fine.
fn scaffold_general_workspace(dir: &Path) -> std::io::Result<()> {
    std::fs::write(dir.join("CLAUDE.md"), GENERAL_WORKSPACE_GUIDE)?;
    #[cfg(unix)]
    {
        let agents = dir.join("AGENTS.md");
        match std::os::unix::fs::symlink("CLAUDE.md", &agents) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

/// Remove a General session's scratch workspace once its record is deleted.
/// Scoped to the managed general-sessions root, so a project folder (or any path
/// outside that root) is never touched. Best-effort: a leftover dir is harmless.
fn cleanup_general_workspace(app: &AppHandle, cwd: &Path) {
    let Ok(root) = general_sessions_root(app) else {
        return;
    };
    if !cwd.starts_with(&root) || !cwd.exists() {
        return;
    }
    if let Err(err) = std::fs::remove_dir_all(cwd) {
        eprintln!(
            "[reverie-general] failed removing scratch workspace {}: {err}",
            cwd.display()
        );
    }
}

/// On boot, remove scratch workspaces under the general-sessions root that no
/// longer belong to any session (e.g. left behind if a crash interrupted
/// delete-time cleanup). Best-effort and quiet: never blocks startup.
pub(crate) fn sweep_orphan_general_sessions(app: &AppHandle, service: &WorkspaceService) {
    let Ok(root) = general_sessions_root(app) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    let Ok(snapshot) = service.snapshot() else {
        return;
    };
    let live: std::collections::HashSet<PathBuf> = snapshot
        .sessions
        .into_iter()
        .map(|session| session.cwd)
        .collect();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && !live.contains(&path) {
            if let Err(err) = std::fs::remove_dir_all(&path) {
                eprintln!(
                    "[reverie-general] failed sweeping orphan workspace {}: {err}",
                    path.display()
                );
            }
        }
    }
}

#[tauri::command]
pub(crate) fn set_session_dangerous_mode(
    service: State<'_, WorkspaceService>,
    request: SetSessionDangerousModeRequest,
) -> Result<WorkspaceSnapshot, String> {
    service
        .set_session_dangerous_mode(request.session_id, request.dangerous_mode_override)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn set_workspace_default_dangerous_mode(
    service: State<'_, WorkspaceService>,
    request: SetWorkspaceDefaultDangerousModeRequest,
) -> Result<WorkspaceSnapshot, String> {
    service
        .set_workspace_default_dangerous_mode(request.default_dangerous_mode)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn set_workspace_default_new_session_dangerous(
    service: State<'_, WorkspaceService>,
    request: SetWorkspaceDefaultNewSessionDangerousRequest,
) -> Result<WorkspaceSnapshot, String> {
    service
        .set_workspace_default_new_session_dangerous(request.default_new_session_dangerous)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn set_workspace_theme(
    service: State<'_, WorkspaceService>,
    request: SetWorkspaceThemeRequest,
) -> Result<WorkspaceSnapshot, String> {
    service
        .set_workspace_theme(request.theme)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn set_workspace_default_agent_kind(
    service: State<'_, WorkspaceService>,
    request: SetWorkspaceDefaultAgentKindRequest,
) -> Result<WorkspaceSnapshot, String> {
    service
        .set_workspace_default_agent_kind(request.default_agent_kind)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn set_workspace_nav_state(
    service: State<'_, WorkspaceService>,
    request: SetWorkspaceNavStateRequest,
) -> Result<WorkspaceSnapshot, String> {
    service
        .set_workspace_nav_state(request.nav_state)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn archive_focus(
    service: State<'_, WorkspaceService>,
    focus_id: FocusId,
) -> Result<WorkspaceSnapshot, String> {
    service
        .archive_focus(focus_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn archive_project(
    service: State<'_, WorkspaceService>,
    project_id: ProjectId,
) -> Result<WorkspaceSnapshot, String> {
    service
        .archive_project(project_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn reorder_focuses(
    service: State<'_, WorkspaceService>,
    ordered_focus_ids: Vec<FocusId>,
) -> Result<WorkspaceSnapshot, String> {
    service
        .reorder_focuses(ordered_focus_ids)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn reorder_projects(
    service: State<'_, WorkspaceService>,
    ordered_project_ids: Vec<ProjectId>,
) -> Result<WorkspaceSnapshot, String> {
    service
        .reorder_projects(ordered_project_ids)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn reorder_sessions(
    service: State<'_, WorkspaceService>,
    ordered_session_ids: Vec<SessionId>,
) -> Result<WorkspaceSnapshot, String> {
    service
        .reorder_sessions(ordered_session_ids)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn move_session(
    service: State<'_, WorkspaceService>,
    session_id: SessionId,
    target_focus_id: FocusId,
    target_index: usize,
) -> Result<WorkspaceSnapshot, String> {
    service
        .move_session(session_id, target_focus_id, target_index)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn capture_cortex_session(
    service: State<'_, WorkspaceService>,
    request: CaptureCortexSessionRequest,
) -> Result<WorkspaceSnapshot, String> {
    let cortex_home = cortex_home_dir()?;
    service
        .capture_cortex_session(
            request.shell_session_id,
            request.cortex_session_id,
            request.metadata_path,
            cortex_home,
        )
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn start_session(
    app: AppHandle,
    service: State<'_, WorkspaceService>,
    runtime: State<'_, TerminalSessionRuntime>,
    request: StartSessionRequest,
    // Per-session binary frame transport. The JS side passes a `Channel`
    // (`new Channel<ArrayBuffer>()`) as `onFrame`; Tauri delivers each
    // `InvokeResponseBody::Raw(bytes)` we send as an `ArrayBuffer`. Lifecycle
    // and control events stay JSON `app.emit` (terminal_stream_started, exit,
    // failed, title, bell). See docs/technical/terminal/wire-protocol.md.
    on_frame: Channel<InvokeResponseBody>,
) -> Result<TerminalId, String> {
    let terminal_id = request.terminal_id.unwrap_or_else(TerminalId::new_v4);
    let session_id = request.session_id;
    // `agent_kind` + `folder_name` give the OSC-title worker what it needs to
    // apply this CLI's title rule and suppress folder-name defaults. The
    // caller-supplied-spec path (bench/proof) has no session, so both stay
    // `None` and the worker skips title derivation. One snapshot load builds all.
    let (mut spawn_spec, agent_kind, folder_name) = match request.spawn_spec {
        Some(spawn_spec) => (spawn_spec, None, None),
        None => {
            let shell_session_id = session_id.ok_or_else(|| {
                "start_session requires sessionId when spawnSpec is omitted".to_owned()
            })?;
            let launch = service
                .build_agent_launch(
                    shell_session_id,
                    request.cols.unwrap_or(120),
                    request.rows.unwrap_or(32),
                )
                .map_err(|err| err.to_string())?;
            (
                launch.spec,
                Some(launch.agent_kind),
                Some(launch.folder_name),
            )
        }
    };

    // Claude Code and Codex must keep their normal credential/config homes:
    // redirecting CLAUDE_CONFIG_DIR / CODEX_HOME makes them behave like a fresh
    // install and re-prompt for sign-in. We attach Reverie's lifecycle hooks a
    // different way that does not touch those homes (Claude: a per-session
    // `--settings` file Claude merges over the user's settings), then assert no
    // credential-home env var slipped onto the spawn.
    if let Some(shell_session_id) = session_id {
        keep_cli_auth_env_unmodified(&service, shell_session_id, &spawn_spec)
            .map_err(|err| err.to_string())?;
        if agent_kind == Some(AgentKind::ClaudeCode) {
            attach_claude_hooks(&app, shell_session_id, &mut spawn_spec);
        }
    }

    // Inter-agent bridge wiring. If the connection service is managed (it
    // only is on Unix and only when `start_bridge` succeeded at startup), we
    // register this session with it and inject the three `REVERIE_*` env
    // vars so the `reverie-bridge` helper subprocess can authenticate.
    // Failures here log and continue: the session still starts, just
    // without inter-agent connection capability.
    if let Some(shell_session_id) = session_id {
        register_session_with_bridge(&app, &service, shell_session_id, &mut spawn_spec);
    }

    // The scrollback budget is a fixed 100 MB dial applied at terminal
    // construction (see ghostty::SCROLLBACK_LIMIT_BYTES, decisions.md D7), so the
    // request carries no per-session row count.
    runtime
        .spawn_session_stream(
            app,
            TerminalStreamRequest {
                session_id,
                terminal_id,
                spawn_spec,
                target_frames: None,
                agent_kind,
                folder_name,
                frame_channel: Some(on_frame),
            },
        )
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn hook_server_port(info: State<'_, HookServerInfo>) -> u16 {
    info.port
}

#[tauri::command]
pub(crate) fn list_terminal_sessions(
    runtime: State<'_, TerminalSessionRuntime>,
) -> Result<Vec<TerminalSessionRecord>, String> {
    runtime.list_sessions().map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn write_terminal_input(
    runtime: State<'_, TerminalSessionRuntime>,
    terminal_id: TerminalId,
    input: String,
) -> Result<(), String> {
    runtime
        .write_input(terminal_id, input.as_bytes())
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn resize_terminal(
    runtime: State<'_, TerminalSessionRuntime>,
    terminal_id: TerminalId,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    runtime
        .resize_terminal(terminal_id, cols, rows)
        .map_err(|err| err.to_string())
}

/// Serve a contiguous band of history rows for the frontend's scroll-back
/// prefetch (decisions.md D6/D7). Returns the binary row band from
/// `wire-protocol.md`, which the frontend decodes with `decodeRowBand` and
/// merges into its mirror (only when the generation still matches). This is the
/// one place the frontend pulls rows from the backend; scrolling itself is fully
/// frontend-local with no round-trip. The bytes are returned to the WebView as
/// an `ArrayBuffer` (a Tauri `Vec<u8>` response).
#[tauri::command]
pub(crate) fn read_terminal_rows(
    runtime: State<'_, TerminalSessionRuntime>,
    terminal_id: TerminalId,
    start_id: u64,
    count: usize,
    generation: u32,
) -> Result<Vec<u8>, String> {
    runtime
        .read_terminal_rows(terminal_id, start_id, count, generation)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn set_terminal_frontend_active(
    runtime: State<'_, TerminalSessionRuntime>,
    terminal_id: TerminalId,
    active: bool,
) -> Result<(), String> {
    runtime
        .set_frontend_active(terminal_id, active)
        .map_err(|err| err.to_string())
}

/// Push the active shell theme's default terminal colors into the runtime.
/// Applied to future spawns + history replay, and broadcast to every live
/// terminal so a light/dark switch repaints without respawning. `foreground`
/// and `background` are `#rrggbb` hex strings.
#[tauri::command]
pub(crate) fn set_terminal_theme(
    runtime: State<'_, TerminalSessionRuntime>,
    foreground: String,
    background: String,
) -> Result<(), String> {
    let foreground = parse_hex_color(&foreground)?;
    let background = parse_hex_color(&background)?;
    runtime.set_theme_colors(foreground, background);
    Ok(())
}

/// Parse a `#rrggbb` (or `rrggbb`) hex color into a `TerminalColor`.
fn parse_hex_color(value: &str) -> Result<reverie_core::terminal::TerminalColor, String> {
    let hex = value.strip_prefix('#').unwrap_or(value);
    if hex.len() != 6 {
        return Err(format!("expected a #rrggbb hex color, got {value:?}"));
    }
    let channel = |start: usize| {
        u8::from_str_radix(&hex[start..start + 2], 16)
            .map_err(|_| format!("invalid hex color {value:?}"))
    };
    Ok(reverie_core::terminal::TerminalColor {
        r: channel(0)?,
        g: channel(2)?,
        b: channel(4)?,
    })
}

#[tauri::command]
pub(crate) fn terminate_session(
    runtime: State<'_, TerminalSessionRuntime>,
    terminal_id: TerminalId,
) -> Result<(), String> {
    runtime
        .terminate_session(terminal_id)
        .map_err(|err| err.to_string())
}

/// Finalize a deliberate quit. The window-close / app-exit handlers defer the
/// quit and let the frontend confirm any in-flight agent work; once the user
/// confirms (or there is nothing to confirm), the frontend calls this. We mark
/// shutdown as begun (so the re-issued exit is not deferred again), gracefully
/// stop every live session's whole process tree, persist each session as
/// finished/restorable, then exit the app.
#[tauri::command]
pub(crate) fn confirm_quit(
    app: AppHandle,
    service: State<'_, WorkspaceService>,
    runtime: State<'_, TerminalSessionRuntime>,
    shutdown: State<'_, ShutdownState>,
) -> Result<(), String> {
    shutdown.begin();
    let live_sessions = runtime.shutdown_all();
    for session_id in live_sessions {
        // child_success = true: a deliberate quit is not a failure. The status
        // becomes Restorable when a native ref exists, else Exited.
        let _ = service.mark_session_finished(session_id, true);
    }
    app.exit(0);
    Ok(())
}

// Benchmark-only commands the React perf harness still calls. They should move
// behind a dev feature and out of the default surface once the frontend drops
// `fetchGhosttyFrameSequence` / `recordRenderMetrics`.
#[tauri::command]
pub(crate) fn ghostty_frame_sequence() -> Result<GhosttyFrameSequence, String> {
    build_ghostty_frame_sequence().map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn record_render_metrics(metrics: serde_json::Value) -> Result<(), String> {
    let encoded = serde_json::to_string(&metrics).map_err(|err| err.to_string())?;
    println!("REVERIE_RENDER_METRICS {encoded}");
    Ok(())
}

#[tauri::command]
pub(crate) fn record_terminal_diagnostics(
    app: AppHandle,
    events: serde_json::Value,
) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let path = dir.join("terminal-diagnostics.jsonl");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| err.to_string())?;

    match events {
        serde_json::Value::Array(items) => {
            for item in items {
                let encoded = serde_json::to_string(&item).map_err(|err| err.to_string())?;
                writeln!(file, "{encoded}").map_err(|err| err.to_string())?;
            }
        }
        item => {
            let encoded = serde_json::to_string(&item).map_err(|err| err.to_string())?;
            writeln!(file, "{encoded}").map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

/// Open a URL in the user's default browser. Outward-facing, so the scheme is
/// allowlisted to http/https here (the renderer only ever detects those, but we
/// enforce it on the trusted side too).
#[tauri::command]
pub(crate) fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    let scheme = url.to_ascii_lowercase();
    if !(scheme.starts_with("http://") || scheme.starts_with("https://")) {
        return Err(format!("Refusing to open non-http(s) URL: {url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| err.to_string())
}

/// The current user's real OS home directory, reported to the web layer at
/// startup. Resolving it here (rather than hardcoding a path in the frontend)
/// is what keeps cwd display and the default working directory correct on any
/// machine. Returns an empty string when `HOME` is unset; the frontend treats
/// that as "home unknown" and falls back safely.
#[tauri::command]
pub(crate) fn system_home_dir() -> String {
    env::var_os("HOME")
        .map(|home| home.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn cortex_home_dir() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("CORTEX_HOME") {
        return Ok(PathBuf::from(path));
    }

    env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".cortex"))
        .ok_or_else(|| "HOME is not set, so Reverie cannot locate ~/.cortex".to_owned())
}

fn keep_cli_auth_env_unmodified(
    service: &WorkspaceService,
    shell_session_id: SessionId,
    spawn_spec: &TerminalSpawnSpec,
) -> Result<()> {
    let snapshot = service.snapshot()?;
    let session = snapshot
        .sessions
        .iter()
        .find(|session| session.id == shell_session_id)
        .ok_or_else(|| anyhow::anyhow!("unknown Reverie session {shell_session_id}"))?;

    assert_safe_cli_env(session.agent_kind, &spawn_spec.command.env)
}

/// Attach Reverie's per-session Claude Code lifecycle hooks to the spawn.
///
/// Mints a token, registers it with the hook server, writes a private
/// `settings.json` under the app cache, and appends `--settings <file>` to the
/// launch via the adapter so Claude POSTs its lifecycle hooks to Reverie's
/// localhost server. Best-effort: if the hook server is not managed or the
/// cache dir cannot be resolved, the session still launches and the transcript
/// scanner remains the capture fallback. We never set `CLAUDE_CONFIG_DIR`, so
/// `~/.claude` credentials are untouched and `assert_safe_cli_env` keeps passing
/// (the attach adds a CLI arg, not an env var).
fn attach_claude_hooks(
    app: &AppHandle,
    shell_session_id: SessionId,
    spawn_spec: &mut TerminalSpawnSpec,
) {
    let (control, registry) = match (
        app.try_state::<HookServerControl>(),
        app.try_state::<HookTokenRegistry>(),
    ) {
        (Some(control), Some(registry)) => (control, registry),
        _ => return,
    };

    let config_dir = match app.path().app_cache_dir() {
        Ok(base) => base
            .join("sessions")
            .join(shell_session_id.to_string())
            .join("claude"),
        Err(err) => {
            eprintln!("[reverie-hooks] cannot resolve app cache dir: {err}");
            return;
        }
    };

    // Write the settings file BEFORE touching the registry. If the write fails
    // we return having mutated nothing: a relaunch then keeps its prior token
    // (and a still-running prior CLI's hook coverage) instead of being left with
    // no hook integration at all.
    let token = uuid::Uuid::new_v4().to_string();
    let url = hook_url(HookSource::ClaudeCode, control.port, &token);
    let written = match write_claude_settings(&config_dir, &url) {
        Ok(written) => written,
        Err(err) => {
            eprintln!("[reverie-hooks] failed writing Claude settings.json: {err}");
            return;
        }
    };

    // The write succeeded, so commit the token: revoke any token left from a
    // previous launch of this session (so a stale CLI can't keep pushing state),
    // then authorize the new one.
    if let Some((prev_source, prev_token)) =
        registry.replace(shell_session_id, HookSource::ClaudeCode, token.clone())
    {
        control.revoke_session(prev_source, &prev_token);
    }
    control.register_session(HookSource::ClaudeCode, token, shell_session_id);

    // The adapter owns the `--settings` flag; the shell owns the file + token.
    spawn_spec
        .command
        .args
        .extend(ClaudeCodeAdapter.hook_config_args(&written.config_file));
}

/// Refuse launches that would redirect a CLI's credential or config home.
///
/// The check is a **denylist**: every other env key is allowed through. In
/// particular, the inter-agent connection bridge relies on Reverie injecting
/// `REVERIE_SESSION_ID`, `REVERIE_SESSION_SECRET`, and `REVERIE_BRIDGE_SOCK`
/// at spawn time, and those must continue to pass cleanly through this guard.
/// If credential-home keys are ever broadened, keep that contract intact: the
/// design is documented in `docs/technical/inter-agent-connections.md`.
fn assert_safe_cli_env(
    agent_kind: AgentKind,
    env: &std::collections::BTreeMap<String, String>,
) -> Result<()> {
    let forbidden_env_keys: &[&str] = match agent_kind {
        AgentKind::ClaudeCode => &["CLAUDE_CONFIG_DIR", "HOME", "XDG_CONFIG_HOME"],
        AgentKind::CodexCli => &["CODEX_HOME", "HOME", "XDG_CONFIG_HOME"],
        AgentKind::CortexCode => return Ok(()),
    };

    for key in forbidden_env_keys {
        if env.contains_key(*key) {
            return Err(anyhow::anyhow!(
                "refusing to launch {} with overridden {key}; Reverie must not redirect CLI credential homes",
                agent_kind.as_str()
            ));
        }
    }

    Ok(())
}

/// Resolve a [`SessionAddress`] from the workspace snapshot. Returns `None`
/// if the session does not exist or its focus has been dropped concurrently;
/// callers treat that the same as bridge-disabled and skip injection.
fn resolve_session_address(
    snapshot: &WorkspaceSnapshot,
    session_id: SessionId,
) -> Option<SessionAddress> {
    let session = snapshot
        .sessions
        .iter()
        .find(|session| session.id == session_id)?;
    let focus = snapshot
        .focuses
        .iter()
        .find(|focus| focus.id == session.focus_id)?;
    let project = focus
        .project_id
        .and_then(|pid| snapshot.projects.iter().find(|project| project.id == pid));
    Some(SessionAddress {
        agent_kind: session.agent_kind,
        project_id: focus.project_id,
        project_name: project.map(|p| p.name.clone()),
        focus_id: focus.id,
        focus_title: focus.title.clone(),
        session_title: session.title.clone(),
    })
}

/// Register a session with the inter-agent connection bridge and inject the
/// three `REVERIE_*` environment variables the helper needs to authenticate.
///
/// No-op when the bridge is not managed (non-Unix, or `start_bridge` failed
/// at boot). No-op when the session record cannot be resolved (transient
/// inconsistency); the session still launches, just without bridge support.
#[cfg(unix)]
fn register_session_with_bridge(
    app: &AppHandle,
    service: &WorkspaceService,
    shell_session_id: SessionId,
    spawn_spec: &mut TerminalSpawnSpec,
) {
    let Some(connection_service) = app.try_state::<Arc<ConnectionService>>() else {
        return;
    };
    let Some(bridge_info) = app.try_state::<BridgeInfo>() else {
        return;
    };
    let snapshot = match service.snapshot() {
        Ok(snapshot) => snapshot,
        Err(err) => {
            eprintln!("[reverie-bridge] snapshot for bridge wiring failed: {err}");
            return;
        }
    };
    let Some(address) = resolve_session_address(&snapshot, shell_session_id) else {
        eprintln!("[reverie-bridge] session {shell_session_id} not found in snapshot");
        return;
    };

    let secret = mint_session_secret();
    connection_service.register_session(RegisteredSession {
        session_id: shell_session_id,
        secret: secret.clone(),
        address,
    });
    spawn_spec.command.env.insert(
        "REVERIE_SESSION_ID".to_owned(),
        shell_session_id.to_string(),
    );
    spawn_spec
        .command
        .env
        .insert("REVERIE_SESSION_SECRET".to_owned(), secret);
    spawn_spec.command.env.insert(
        "REVERIE_BRIDGE_SOCK".to_owned(),
        bridge_info.socket_path.to_string_lossy().into_owned(),
    );
}

#[cfg(not(unix))]
fn register_session_with_bridge(
    _app: &AppHandle,
    _service: &WorkspaceService,
    _shell_session_id: SessionId,
    _spawn_spec: &mut TerminalSpawnSpec,
) {
}

/// Remove a session from the bridge registry. Safe to call when the bridge
/// is not enabled (no-op) or when the session was never registered
/// (`unregister_session` is idempotent in `ConnectionService`).
#[cfg(unix)]
fn unregister_session_from_bridge(app: &AppHandle, session_id: SessionId) {
    if let Some(connection_service) = app.try_state::<Arc<ConnectionService>>() {
        connection_service.unregister_session(session_id);
    }
}

#[cfg(not(unix))]
fn unregister_session_from_bridge(_app: &AppHandle, _session_id: SessionId) {}

fn build_ghostty_frame_sequence() -> Result<GhosttyFrameSequence> {
    let mut terminal = GhosttyTerminalState::new(PROOF_COLS, PROOF_ROWS)?;
    let mut frames = Vec::with_capacity((PROOF_FRAMES / 2) + 2);
    let mut output_bytes = 0_usize;

    let intro = b"\x1b[2J\x1b[H\x1b[1;36mReverie Ghostty -> Tauri frame bridge\x1b[0m\r\nreal libghostty-vt render state crossing the desktop command boundary\r\n\x1b[4mstyled text, unicode, dirty rows, cursor state\x1b[0m\r\n";
    terminal.write(intro);
    output_bytes += intro.len();
    frames.push(terminal.frame()?);

    for frame_index in 0..PROOF_FRAMES {
        let red = 96 + ((frame_index * 3) % 128) as u8;
        let green = 160 + ((frame_index * 5) % 80) as u8;
        let blue = 208 + ((frame_index * 7) % 48) as u8;
        let underline = if frame_index % 11 == 0 { "\x1b[4m" } else { "" };
        let reset_underline = if frame_index % 11 == 0 { "\x1b[0m" } else { "" };
        let line = format!(
            "\x1b[38;2;{red};{green};{blue}mghostty-tauri-frame-{frame_index:03}\x1b[0m {underline}payload: agent output stream, unicode café 🚀, dirty-row patch candidate {reset_underline}\r\n"
        );

        terminal.write(line.as_bytes());
        output_bytes += line.len();

        if frame_index % 2 == 0 {
            frames.push(terminal.frame()?);
        }
    }

    let outro = b"\x1b[5 q\r\n\x1b[1;32mghostty-tauri-frame-sequence-complete\x1b[0m\r\n";
    terminal.write(outro);
    output_bytes += outro.len();
    frames.push(terminal.frame()?);

    Ok(GhosttyFrameSequence {
        label: "libghostty-vt generated TerminalFrame sequence",
        cols: PROOF_COLS,
        rows: PROOF_ROWS,
        output_bytes,
        frames,
    })
}

#[cfg(test)]
mod address_resolution_tests {
    //! Pin the workspace-snapshot to `SessionAddress` mapping. This is the
    //! projection bridge clients see in `list_peers` and the connection
    //! banner, so a regression here would silently mislabel sessions.

    use super::*;
    use reverie_core::domain::{Focus, Project, Session, Workspace};
    use std::path::PathBuf;
    use uuid::Uuid;

    fn empty_snapshot() -> WorkspaceSnapshot {
        WorkspaceSnapshot {
            workspace: Workspace::new("Test workspace", "General"),
            projects: vec![],
            focuses: vec![],
            sessions: vec![],
        }
    }

    #[test]
    fn resolves_session_with_focus_and_project() {
        let mut snapshot = empty_snapshot();
        let project = Project::new("Reverie", PathBuf::from("/repo"));
        let focus = Focus::for_project(project.id, "Inter-agent handoff design", 10);
        let session = Session::new(
            focus.id,
            "Claude orchestrator",
            AgentKind::ClaudeCode,
            PathBuf::from("/repo"),
        );
        let session_id = session.id;
        snapshot.projects.push(project.clone());
        snapshot.focuses.push(focus.clone());
        snapshot.sessions.push(session);

        let address = resolve_session_address(&snapshot, session_id).expect("address resolves");
        assert_eq!(address.agent_kind, AgentKind::ClaudeCode);
        assert_eq!(address.project_id, Some(project.id));
        assert_eq!(address.project_name.as_deref(), Some("Reverie"));
        assert_eq!(address.focus_id, focus.id);
        assert_eq!(address.focus_title, "Inter-agent handoff design");
        assert_eq!(address.session_title, "Claude orchestrator");
    }

    #[test]
    fn resolves_general_workspace_session_with_no_project() {
        let mut snapshot = empty_snapshot();
        let focus = Focus::general("Sketchpad", 0);
        let session = Session::new(
            focus.id,
            "Scratch",
            AgentKind::CortexCode,
            PathBuf::from("/tmp"),
        );
        let session_id = session.id;
        snapshot.focuses.push(focus.clone());
        snapshot.sessions.push(session);

        let address = resolve_session_address(&snapshot, session_id).expect("address resolves");
        assert!(address.project_id.is_none());
        assert!(address.project_name.is_none());
        assert_eq!(address.focus_id, focus.id);
    }

    #[test]
    fn returns_none_for_unknown_session() {
        let snapshot = empty_snapshot();
        assert!(resolve_session_address(&snapshot, Uuid::new_v4()).is_none());
    }

    #[test]
    fn returns_none_when_focus_is_missing() {
        // Pathological: a session referring to a focus the snapshot lacks.
        // Resolution must fail closed, not panic.
        let mut snapshot = empty_snapshot();
        let dangling_focus_id = Uuid::new_v4();
        let session = Session::new(
            dangling_focus_id,
            "S",
            AgentKind::ClaudeCode,
            PathBuf::from("/repo"),
        );
        let session_id = session.id;
        snapshot.sessions.push(session);
        assert!(resolve_session_address(&snapshot, session_id).is_none());
    }
}

#[cfg(test)]
mod env_guard_tests {
    //! Behavioral pinning for `assert_safe_cli_env`.
    //!
    //! Two things must hold for inter-agent connections to work safely:
    //!
    //! 1. Credential-home overrides for Claude Code and Codex CLI remain
    //!    refused. The product reason is in the implementation-queue's
    //!    "Claude / Codex hook integration paused for auth safety" note;
    //!    redirecting `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `HOME` /
    //!    `XDG_CONFIG_HOME` would make each CLI behave like a fresh install
    //!    and prompt for sign-in.
    //!
    //! 2. Reverie-scoped env variables (`REVERIE_SESSION_ID`,
    //!    `REVERIE_SESSION_SECRET`, `REVERIE_BRIDGE_SOCK`) pass through for
    //!    every CLI. These are the vehicle for the bridge's per-session
    //!    identity. See `docs/technical/inter-agent-connections.md`.

    use super::*;
    use std::collections::BTreeMap;

    fn env<const N: usize>(pairs: [(&str, &str); N]) -> BTreeMap<String, String> {
        pairs
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect()
    }

    #[test]
    fn claude_refuses_each_credential_home_key() {
        for key in ["CLAUDE_CONFIG_DIR", "HOME", "XDG_CONFIG_HOME"] {
            let env = env([(key, "/tmp/anywhere")]);
            let err = assert_safe_cli_env(AgentKind::ClaudeCode, &env)
                .expect_err(&format!("Claude should refuse {key}"));
            assert!(
                err.to_string().contains(key),
                "error mentions the refused key, got {err}"
            );
        }
    }

    #[test]
    fn codex_refuses_each_credential_home_key() {
        for key in ["CODEX_HOME", "HOME", "XDG_CONFIG_HOME"] {
            let env = env([(key, "/tmp/anywhere")]);
            let err = assert_safe_cli_env(AgentKind::CodexCli, &env)
                .expect_err(&format!("Codex should refuse {key}"));
            assert!(
                err.to_string().contains(key),
                "error mentions the refused key, got {err}"
            );
        }
    }

    #[test]
    fn cortex_is_unrestricted_because_reverie_owns_its_config_home_separately() {
        // Cortex Code is the in-house adapter; Reverie can manage
        // `~/.cortex` directly without sign-in fallout. The guard is a
        // pass-through for Cortex.
        let env = env([
            ("HOME", "/tmp/anywhere"),
            ("CLAUDE_CONFIG_DIR", "/tmp/elsewhere"),
            ("CODEX_HOME", "/tmp/elsewhere"),
            ("XDG_CONFIG_HOME", "/tmp/elsewhere"),
        ]);
        assert_safe_cli_env(AgentKind::CortexCode, &env)
            .expect("Cortex guard never refuses credential-home keys");
    }

    #[test]
    fn reverie_session_id_passes_through_for_every_cli() {
        let env = env([("REVERIE_SESSION_ID", "0193abcd-ef01-7000-8000-0123456789ab")]);
        for kind in [
            AgentKind::ClaudeCode,
            AgentKind::CodexCli,
            AgentKind::CortexCode,
        ] {
            assert_safe_cli_env(kind, &env)
                .unwrap_or_else(|err| panic!("{kind:?} must permit REVERIE_SESSION_ID: {err}"));
        }
    }

    #[test]
    fn reverie_session_secret_passes_through_for_every_cli() {
        let env = env([("REVERIE_SESSION_SECRET", "deadbeefcafef00d")]);
        for kind in [
            AgentKind::ClaudeCode,
            AgentKind::CodexCli,
            AgentKind::CortexCode,
        ] {
            assert_safe_cli_env(kind, &env)
                .unwrap_or_else(|err| panic!("{kind:?} must permit REVERIE_SESSION_SECRET: {err}"));
        }
    }

    #[test]
    fn reverie_bridge_sock_passes_through_for_every_cli() {
        let env = env([("REVERIE_BRIDGE_SOCK", "/tmp/reverie/bridge.sock")]);
        for kind in [
            AgentKind::ClaudeCode,
            AgentKind::CodexCli,
            AgentKind::CortexCode,
        ] {
            assert_safe_cli_env(kind, &env)
                .unwrap_or_else(|err| panic!("{kind:?} must permit REVERIE_BRIDGE_SOCK: {err}"));
        }
    }

    #[test]
    fn all_three_reverie_env_vars_together_pass_through_for_every_cli() {
        let env = env([
            ("REVERIE_SESSION_ID", "0193abcd-ef01-7000-8000-0123456789ab"),
            ("REVERIE_SESSION_SECRET", "deadbeefcafef00d"),
            ("REVERIE_BRIDGE_SOCK", "/tmp/reverie/bridge.sock"),
        ]);
        for kind in [
            AgentKind::ClaudeCode,
            AgentKind::CodexCli,
            AgentKind::CortexCode,
        ] {
            assert_safe_cli_env(kind, &env).unwrap_or_else(|err| {
                panic!("{kind:?} must permit the full REVERIE_* trio: {err}")
            });
        }
    }

    #[test]
    fn unrelated_env_keys_pass_through_for_every_cli() {
        let env = env([("PATH", "/usr/bin"), ("LANG", "en_US.UTF-8")]);
        for kind in [
            AgentKind::ClaudeCode,
            AgentKind::CodexCli,
            AgentKind::CortexCode,
        ] {
            assert_safe_cli_env(kind, &env)
                .unwrap_or_else(|err| panic!("{kind:?} must permit unrelated vars: {err}"));
        }
    }

    #[test]
    fn empty_env_passes_for_every_cli() {
        let env = BTreeMap::new();
        for kind in [
            AgentKind::ClaudeCode,
            AgentKind::CodexCli,
            AgentKind::CortexCode,
        ] {
            assert_safe_cli_env(kind, &env)
                .unwrap_or_else(|err| panic!("{kind:?} must permit empty env: {err}"));
        }
    }

    #[test]
    fn reverie_env_vars_alongside_a_forbidden_key_still_refused() {
        // Defensive: even if a REVERIE_* var is present, a forbidden key
        // still trips the guard. This rules out a future bug where someone
        // assumes "REVERIE_* set means safe."
        let env = env([
            ("REVERIE_SESSION_ID", "abc"),
            ("CLAUDE_CONFIG_DIR", "/tmp/elsewhere"),
        ]);
        let err = assert_safe_cli_env(AgentKind::ClaudeCode, &env)
            .expect_err("forbidden key still trips guard even with REVERIE_* present");
        assert!(err.to_string().contains("CLAUDE_CONFIG_DIR"));
    }
}
