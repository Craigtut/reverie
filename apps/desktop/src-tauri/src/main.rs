#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_shell;
mod terminal_backend;
mod terminal_runtime;

use std::{env, fs::OpenOptions, io::Write, path::PathBuf};

use anyhow::{Context, Result};
use app_shell::{
    AppShellStore, CaptureCortexSessionRequest, CreateFocusRequest, CreateProjectRequest,
    CreateSessionRequest, UpdateSessionTabVisibilityRequest, WorkspaceShellSnapshot,
};
use reverie_core::activity::ActivityState;
use reverie_core::activity_watcher::{
    CortexActivityStream, CortexActivityUpdate, watch_cortex_activity,
};
use reverie_core::agents::built_in_adapters;
use reverie_core::domain::{AgentKind, FocusId, ProjectId, SessionId};
use reverie_core::hook_server::{
    HookActivityUpdate, HookServerControl, HookServerHandle, HookSource, start_hook_server,
};
use reverie_core::terminal::{TerminalFrame, TerminalId};
use reverie_core::{AdapterDetection, CommandSpec, TerminalSpawnSpec};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use terminal_backend::GhosttyTerminalState;
use terminal_runtime::{TerminalSessionRecord, TerminalSessionRuntime, TerminalStreamRequest};

const PROOF_COLS: u16 = 120;
const PROOF_ROWS: u16 = 36;
const PROOF_FRAMES: usize = 180;
const STREAM_FRAMES: usize = 240;
const WINDOW_CORNER_RADIUS: f64 = 44.0;

#[cfg(target_os = "macos")]
fn apply_macos_window_corners(window: &tauri::WebviewWindow, radius: f64) {
    use objc::runtime::{Object, YES};
    use objc::{msg_send, sel, sel_impl};

    let ns_window_ptr = match window.ns_window() {
        Ok(ptr) => ptr,
        Err(_) => return,
    };
    if ns_window_ptr.is_null() {
        return;
    }

    unsafe {
        let ns_window = ns_window_ptr as *mut Object;
        let content_view: *mut Object = msg_send![ns_window, contentView];
        if content_view.is_null() {
            return;
        }
        let _: () = msg_send![content_view, setWantsLayer: YES];
        let layer: *mut Object = msg_send![content_view, layer];
        if layer.is_null() {
            return;
        }
        let _: () = msg_send![layer, setCornerRadius: radius];
        let _: () = msg_send![layer, setMasksToBounds: YES];
        let _: () = msg_send![ns_window, invalidateShadow];
    }
}

#[derive(Debug, Serialize)]
struct GhosttyFrameSequence {
    label: &'static str,
    cols: u16,
    rows: u16,
    output_bytes: usize,
    frames: Vec<TerminalFrame>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartSessionRequest {
    session_id: Option<SessionId>,
    terminal_id: Option<TerminalId>,
    spawn_spec: Option<TerminalSpawnSpec>,
    cols: Option<u16>,
    rows: Option<u16>,
    max_scrollback: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentCliDetection {
    kind: AgentKind,
    display_name: &'static str,
    executable: Option<String>,
    candidates: Vec<String>,
    available: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFolderSelection {
    name: String,
    path: String,
}

/// Payload emitted to the React shell whenever any adapter (Cortex filesystem
/// watcher today, Claude/Codex hook receiver via the localhost HTTP server)
/// reports an activity-state change. React correlates `nativeSessionId`
/// against its persisted `nativeSessionRef.sessionId` to route updates to the
/// right Reverie session.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "payload")]
enum SessionActivityEvent {
    Updated {
        source: ActivitySource,
        native_session_id: String,
        state: ActivityState,
    },
    Removed {
        source: ActivitySource,
        native_session_id: String,
    },
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum ActivitySource {
    CortexCode,
    ClaudeCode,
    CodexCli,
}

const SESSION_ACTIVITY_EVENT: &str = "session_activity_changed";

/// Managed Tauri state holding the bound port of the hook HTTP server. The
/// session launch path reads this to write per-session Claude/Codex configs
/// that point at `http://127.0.0.1:<port>/hooks/<cli>/<token>`.
#[derive(Clone, Debug)]
struct HookServerInfo {
    port: u16,
}

#[tauri::command]
fn hook_server_port(info: State<'_, HookServerInfo>) -> u16 {
    info.port
}

/// Tracks the (cli, token) Reverie minted for each launched session so the
/// terminate / remove paths can revoke the right authorization. Without this,
/// a token issued in a previous launch would stay valid forever and let a
/// stale CLI process keep pushing state.
#[derive(Default)]
struct HookTokenRegistry {
    sessions: std::sync::Mutex<std::collections::HashMap<SessionId, (HookSource, String)>>,
}

impl HookTokenRegistry {
    fn replace(&self, session_id: SessionId, source: HookSource, token: String) -> Option<(HookSource, String)> {
        let mut guard = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
        guard.insert(session_id, (source, token))
    }

    fn take(&self, session_id: SessionId) -> Option<(HookSource, String)> {
        let mut guard = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
        guard.remove(&session_id)
    }
}

#[tauri::command]
fn app_status() -> &'static str {
    "reverie-desktop-product-shell"
}

#[tauri::command]
fn ghostty_frame_sequence() -> Result<GhosttyFrameSequence, String> {
    build_ghostty_frame_sequence().map_err(|err| err.to_string())
}

#[tauri::command]
fn workspace_shell(store: State<'_, AppShellStore>) -> Result<WorkspaceShellSnapshot, String> {
    store.snapshot().map_err(|err| err.to_string())
}

#[tauri::command]
fn list_agent_clis() -> Vec<AgentCliDetection> {
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

            AgentCliDetection {
                kind: adapter.kind(),
                display_name: adapter.display_name(),
                executable,
                candidates,
                available: detection.is_available(),
            }
        })
        .collect()
}

#[tauri::command]
fn choose_project_folder() -> Result<Option<ProjectFolderSelection>, String> {
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

#[tauri::command]
fn create_project(
    store: State<'_, AppShellStore>,
    request: CreateProjectRequest,
) -> Result<WorkspaceShellSnapshot, String> {
    store.create_project(request).map_err(|err| err.to_string())
}

#[tauri::command]
fn create_focus(
    store: State<'_, AppShellStore>,
    request: CreateFocusRequest,
) -> Result<WorkspaceShellSnapshot, String> {
    store.create_focus(request).map_err(|err| err.to_string())
}

#[tauri::command]
fn create_session(
    store: State<'_, AppShellStore>,
    request: CreateSessionRequest,
) -> Result<WorkspaceShellSnapshot, String> {
    store.create_session(request).map_err(|err| err.to_string())
}

#[tauri::command]
fn update_session_tab_visibility(
    store: State<'_, AppShellStore>,
    request: UpdateSessionTabVisibilityRequest,
) -> Result<WorkspaceShellSnapshot, String> {
    store
        .update_session_tab_visibility(request)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn remove_session(
    app: AppHandle,
    store: State<'_, AppShellStore>,
    session_id: SessionId,
) -> Result<WorkspaceShellSnapshot, String> {
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
    store
        .remove_session(session_id)
        .map_err(|err| err.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetSessionDangerousModeRequest {
    session_id: SessionId,
    dangerous_mode_override: Option<bool>,
}

#[tauri::command]
fn set_session_dangerous_mode(
    store: State<'_, AppShellStore>,
    request: SetSessionDangerousModeRequest,
) -> Result<WorkspaceShellSnapshot, String> {
    store
        .set_session_dangerous_mode(request.session_id, request.dangerous_mode_override)
        .map_err(|err| err.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetWorkspaceDefaultDangerousModeRequest {
    default_dangerous_mode: bool,
}

#[tauri::command]
fn set_workspace_default_dangerous_mode(
    store: State<'_, AppShellStore>,
    request: SetWorkspaceDefaultDangerousModeRequest,
) -> Result<WorkspaceShellSnapshot, String> {
    store
        .set_workspace_default_dangerous_mode(request.default_dangerous_mode)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn archive_focus(
    store: State<'_, AppShellStore>,
    focus_id: FocusId,
) -> Result<WorkspaceShellSnapshot, String> {
    store.archive_focus(focus_id).map_err(|err| err.to_string())
}

#[tauri::command]
fn archive_project(
    store: State<'_, AppShellStore>,
    project_id: ProjectId,
) -> Result<WorkspaceShellSnapshot, String> {
    store
        .archive_project(project_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn capture_cortex_session(
    store: State<'_, AppShellStore>,
    request: CaptureCortexSessionRequest,
) -> Result<WorkspaceShellSnapshot, String> {
    let cortex_home = cortex_home_dir()?;
    store
        .capture_cortex_session(request, cortex_home)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn start_session(
    app: AppHandle,
    store: State<'_, AppShellStore>,
    runtime: State<'_, TerminalSessionRuntime>,
    request: StartSessionRequest,
) -> Result<TerminalId, String> {
    let terminal_id = request.terminal_id.unwrap_or_else(TerminalId::new_v4);
    let session_id = request.session_id;
    let mut spawn_spec = match request.spawn_spec {
        Some(spawn_spec) => spawn_spec,
        None => {
            let shell_session_id = session_id.ok_or_else(|| {
                "start_session requires sessionId when spawnSpec is omitted".to_owned()
            })?;
            store
                .build_agent_spawn_spec(
                    shell_session_id,
                    request.cols.unwrap_or(120),
                    request.rows.unwrap_or(32),
                )
                .map_err(|err| err.to_string())?
        }
    };

    // For Claude Code and Codex CLI sessions we own the hook channel: write
    // a per-session config file in a private cache dir, set the CLI's config
    // env var to point at it, and register a token with the localhost hook
    // server so the CLI's lifecycle POSTs are authorized and routed.
    if let Some(shell_session_id) = session_id {
        if let Err(error) = inject_hook_config_if_needed(&app, &store, shell_session_id, &mut spawn_spec)
        {
            // Hook injection is best-effort. The CLI still launches; the
            // dashboard just won't show live activity for this session until
            // the next launch succeeds.
            eprintln!(
                "[reverie] hook config injection failed for {shell_session_id}: {error:#}"
            );
        }
    }

    runtime
        .spawn_session_stream(
            app,
            TerminalStreamRequest {
                session_id,
                terminal_id,
                spawn_spec,
                max_scrollback: request.max_scrollback.unwrap_or(10_000),
                target_frames: None,
                legacy_proof_events: false,
            },
        )
        .map_err(|err| err.to_string())
}

fn inject_hook_config_if_needed(
    app: &AppHandle,
    store: &AppShellStore,
    shell_session_id: SessionId,
    spawn_spec: &mut TerminalSpawnSpec,
) -> Result<()> {
    let snapshot = store.snapshot()?;
    let session = snapshot
        .sessions
        .iter()
        .find(|session| session.id == shell_session_id)
        .ok_or_else(|| anyhow::anyhow!("unknown Reverie session {shell_session_id}"))?;

    let source = match session.agent_kind {
        AgentKind::ClaudeCode => HookSource::ClaudeCode,
        AgentKind::CodexCli => HookSource::CodexCli,
        AgentKind::CortexCode => return Ok(()),
    };

    let Some(control) = app.try_state::<HookServerControl>() else {
        // Hook server failed to start; quietly skip without breaking the launch.
        return Ok(());
    };
    let registry = app
        .try_state::<HookTokenRegistry>()
        .ok_or_else(|| anyhow::anyhow!("hook token registry missing from managed state"))?;

    // If this session had a previous token (from an earlier launch), revoke it
    // so a stale CLI process can't keep talking to the server.
    if let Some((prior_source, prior_token)) = registry.take(shell_session_id) {
        control.revoke_session(prior_source, &prior_token);
    }

    let token = uuid::Uuid::new_v4().to_string();
    let url = reverie_core::hook_url(source, control.port, &token);
    let config_dir = hook_config_dir_for_session(app, source, shell_session_id)?;

    let written = match source {
        HookSource::ClaudeCode => reverie_core::write_claude_settings(&config_dir, &url)?,
        HookSource::CodexCli => reverie_core::write_codex_config(&config_dir, &url)?,
    };

    control.register_session(source, token.clone(), shell_session_id.to_string());
    registry.replace(shell_session_id, source, token);

    spawn_spec
        .command
        .env
        .insert(written.env_var.to_owned(), written.config_dir.display().to_string());
    Ok(())
}

fn hook_config_dir_for_session(
    app: &AppHandle,
    source: HookSource,
    shell_session_id: SessionId,
) -> Result<PathBuf> {
    let cache_root = app
        .path()
        .app_cache_dir()
        .context("resolving Reverie app cache dir")?;
    let cli = match source {
        HookSource::ClaudeCode => "claude",
        HookSource::CodexCli => "codex",
    };
    Ok(cache_root
        .join("sessions")
        .join(shell_session_id.to_string())
        .join(cli))
}

#[tauri::command]
fn start_live_pty_stream_proof(
    app: AppHandle,
    runtime: State<'_, TerminalSessionRuntime>,
) -> Result<(), String> {
    let spec = live_stream_spawn_spec().map_err(|err| err.to_string())?;
    runtime
        .spawn_session_stream(
            app,
            TerminalStreamRequest {
                session_id: None,
                terminal_id: TerminalId::new_v4(),
                spawn_spec: spec,
                max_scrollback: STREAM_FRAMES + PROOF_ROWS as usize + 100,
                target_frames: Some(STREAM_FRAMES),
                legacy_proof_events: true,
            },
        )
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn list_terminal_sessions(
    runtime: State<'_, TerminalSessionRuntime>,
) -> Result<Vec<TerminalSessionRecord>, String> {
    runtime.list_sessions().map_err(|err| err.to_string())
}

#[tauri::command]
fn write_terminal_input(
    runtime: State<'_, TerminalSessionRuntime>,
    terminal_id: TerminalId,
    input: String,
) -> Result<(), String> {
    runtime
        .write_input(terminal_id, input.as_bytes())
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn resize_terminal(
    runtime: State<'_, TerminalSessionRuntime>,
    terminal_id: TerminalId,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    runtime
        .resize_terminal(terminal_id, cols, rows)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn scroll_terminal_viewport(
    runtime: State<'_, TerminalSessionRuntime>,
    terminal_id: TerminalId,
    delta_rows: i32,
) -> Result<(), String> {
    runtime
        .scroll_terminal(terminal_id, delta_rows as isize)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn scroll_terminal_viewport_to_top(
    runtime: State<'_, TerminalSessionRuntime>,
    terminal_id: TerminalId,
) -> Result<(), String> {
    runtime
        .scroll_terminal_to_top(terminal_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn scroll_terminal_viewport_to_bottom(
    runtime: State<'_, TerminalSessionRuntime>,
    terminal_id: TerminalId,
) -> Result<(), String> {
    runtime
        .scroll_terminal_to_bottom(terminal_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn terminate_session(
    runtime: State<'_, TerminalSessionRuntime>,
    terminal_id: TerminalId,
) -> Result<(), String> {
    runtime
        .terminate_session(terminal_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn record_render_metrics(metrics: serde_json::Value) -> Result<(), String> {
    let encoded = serde_json::to_string(&metrics).map_err(|err| err.to_string())?;
    println!("REVERIE_RENDER_METRICS {encoded}");
    Ok(())
}

#[cfg(debug_assertions)]
fn install_dev_panic_logger() {
    let log_path = env::current_dir()
        .unwrap_or_else(|_| env::temp_dir())
        .join("reverie-dev-crashes.log");
    eprintln!("[reverie] development panic log: {}", log_path.display());
    std::panic::set_hook(Box::new(move |panic_info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        let message = format!(
            "\n=== Reverie panic ===\nwhen: {}\ninfo: {panic_info}\nbacktrace:\n{backtrace}\n",
            unix_time_millis_for_log(),
        );
        eprintln!("{message}");
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log_path) {
            let _ = file.write_all(message.as_bytes());
        }
    }));
}

#[cfg(not(debug_assertions))]
fn install_dev_panic_logger() {}

fn unix_time_millis_for_log() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn main() {
    install_dev_panic_logger();

    tauri::Builder::default()
        .setup(|app| {
            let store_path = app
                .path()
                .app_data_dir()?
                .join("workspace-shell.v1.sqlite3");
            app.manage(AppShellStore::load_or_seed(store_path)?);

            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                apply_macos_window_corners(&window, WINDOW_CORNER_RADIUS);
            }

            // Start the Cortex activity-state watcher. Best-effort: if
            // ~/.cortex/sessions cannot be located (no HOME, etc.), Reverie
            // still boots; the watcher just stays off and the dashboard
            // falls back to record status.
            if let Some(sessions_root) = cortex_sessions_root() {
                match watch_cortex_activity(sessions_root) {
                    Ok(stream) => {
                        let app_handle = app.handle().clone();
                        std::thread::Builder::new()
                            .name("reverie-cortex-activity-bridge".to_owned())
                            .spawn(move || drain_cortex_activity(stream, app_handle))
                            .ok();
                    }
                    Err(error) => {
                        eprintln!("[reverie] Cortex activity watcher disabled: {error:#}");
                    }
                }
            } else {
                eprintln!("[reverie] Cortex home not located; activity watcher disabled");
            }

            // Start the localhost hook HTTP server. Claude Code and Codex CLI
            // POST lifecycle hooks here; the payloads are translated into the
            // same SessionActivityEvent stream as Cortex. The bound port is
            // managed so the launch path can read it to write per-session
            // hook configs (CLAUDE_CONFIG_DIR / CODEX_HOME).
            app.manage(HookTokenRegistry::default());
            match start_hook_server() {
                Ok(handle) => {
                    let control = handle.control.clone();
                    app.manage(HookServerInfo { port: control.port });
                    app.manage(control);
                    let app_handle = app.handle().clone();
                    std::thread::Builder::new()
                        .name("reverie-hook-activity-bridge".to_owned())
                        .spawn(move || drain_hook_activity(handle, app_handle))
                        .ok();
                }
                Err(error) => {
                    eprintln!("[reverie] hook HTTP server disabled: {error:#}");
                }
            }

            Ok(())
        })
        .manage(TerminalSessionRuntime::default())
        .invoke_handler(tauri::generate_handler![
            app_status,
            ghostty_frame_sequence,
            workspace_shell,
            list_agent_clis,
            choose_project_folder,
            create_project,
            create_focus,
            create_session,
            update_session_tab_visibility,
            remove_session,
            set_session_dangerous_mode,
            set_workspace_default_dangerous_mode,
            hook_server_port,
            archive_focus,
            archive_project,
            capture_cortex_session,
            start_session,
            start_live_pty_stream_proof,
            list_terminal_sessions,
            write_terminal_input,
            resize_terminal,
            scroll_terminal_viewport,
            scroll_terminal_viewport_to_top,
            scroll_terminal_viewport_to_bottom,
            terminate_session,
            record_render_metrics
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Reverie desktop shell");
}

fn cortex_home_dir() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("CORTEX_HOME") {
        return Ok(PathBuf::from(path));
    }

    env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".cortex"))
        .ok_or_else(|| "HOME is not set, so Reverie cannot locate ~/.cortex".to_owned())
}

/// Resolve the directory the Cortex activity watcher should attach to. Returns
/// `None` if neither `CORTEX_HOME` nor `HOME` (Unix) / `USERPROFILE` (Windows)
/// is available, in which case the watcher is silently skipped.
fn cortex_sessions_root() -> Option<PathBuf> {
    if let Some(path) = env::var_os("CORTEX_HOME") {
        return Some(PathBuf::from(path).join("sessions"));
    }
    let home = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".cortex").join("sessions"))
}

/// Drain the watcher's channel and forward every update to the React shell as
/// a `cortex_activity_changed` event. The function returns when the stream is
/// dropped (which closes the channel), so the thread exits cleanly on app
/// shutdown.
fn forward_activity_update(
    app: &AppHandle,
    source: ActivitySource,
    native_session_id: String,
    state: ActivityState,
) {
    if let Some(store) = app.try_state::<AppShellStore>() {
        if let Err(error) = store.record_session_activity(&native_session_id, state.clone()) {
            eprintln!("[reverie] failed to persist activity for {native_session_id}: {error:#}");
        }
    }
    let payload = SessionActivityEvent::Updated {
        source,
        native_session_id,
        state,
    };
    if let Err(error) = app.emit(SESSION_ACTIVITY_EVENT, payload) {
        eprintln!("[reverie] failed to emit session activity event: {error}");
    }
}

fn forward_activity_removed(app: &AppHandle, source: ActivitySource, native_session_id: String) {
    if let Some(store) = app.try_state::<AppShellStore>() {
        if let Err(error) = store.clear_session_activity(&native_session_id) {
            eprintln!("[reverie] failed to clear activity for {native_session_id}: {error:#}");
        }
    }
    let payload = SessionActivityEvent::Removed {
        source,
        native_session_id,
    };
    if let Err(error) = app.emit(SESSION_ACTIVITY_EVENT, payload) {
        eprintln!("[reverie] failed to emit session activity removal: {error}");
    }
}

fn drain_cortex_activity(stream: CortexActivityStream, app: AppHandle) {
    while let Ok(update) = stream.events.recv() {
        match update {
            CortexActivityUpdate::State { session_id, state } => {
                forward_activity_update(&app, ActivitySource::CortexCode, session_id, state);
            }
            CortexActivityUpdate::Removed { session_id } => {
                forward_activity_removed(&app, ActivitySource::CortexCode, session_id);
            }
        }
    }
}

fn drain_hook_activity(handle: HookServerHandle, app: AppHandle) {
    // Moving `handle` into this thread keeps the bound HTTP server alive for
    // the thread's lifetime; on app shutdown the thread tears down, the
    // handle drops, and the server stops cleanly.
    while let Ok(update) = handle.events.recv() {
        match update {
            HookActivityUpdate::State {
                source,
                reverie_session_id,
                native_session_id,
                state,
            } => forward_hook_state_update(
                &app,
                hook_source_to_activity_source(source),
                &reverie_session_id,
                native_session_id,
                state,
            ),
            HookActivityUpdate::Removed {
                source,
                reverie_session_id,
                native_session_id,
            } => forward_hook_removed_update(
                &app,
                hook_source_to_activity_source(source),
                &reverie_session_id,
                native_session_id,
            ),
        }
    }
}

/// Hook updates carry the Reverie session id that owns the token, so we
/// persist activity (and capture the CLI's native session id) by Reverie id
/// directly instead of doing a reverse lookup by native id.
fn forward_hook_state_update(
    app: &AppHandle,
    source: ActivitySource,
    reverie_session_id: &str,
    native_session_id: String,
    state: ActivityState,
) {
    if let Some(store) = app.try_state::<AppShellStore>() {
        if let Ok(parsed) = SessionId::parse_str(reverie_session_id) {
            if let Err(error) =
                store.record_session_activity_by_id(parsed, &native_session_id, state.clone())
            {
                eprintln!(
                    "[reverie] failed to persist hook activity for {reverie_session_id}: {error:#}"
                );
            }
        }
    }
    let payload = SessionActivityEvent::Updated {
        source,
        native_session_id,
        state,
    };
    if let Err(error) = app.emit(SESSION_ACTIVITY_EVENT, payload) {
        eprintln!("[reverie] failed to emit session activity event: {error}");
    }
}

fn forward_hook_removed_update(
    app: &AppHandle,
    source: ActivitySource,
    reverie_session_id: &str,
    native_session_id: String,
) {
    if let Some(store) = app.try_state::<AppShellStore>() {
        if let Ok(parsed) = SessionId::parse_str(reverie_session_id) {
            if let Err(error) = store.clear_session_activity_by_id(parsed) {
                eprintln!(
                    "[reverie] failed to clear hook activity for {reverie_session_id}: {error:#}"
                );
            }
        }
    }
    let payload = SessionActivityEvent::Removed {
        source,
        native_session_id,
    };
    if let Err(error) = app.emit(SESSION_ACTIVITY_EVENT, payload) {
        eprintln!("[reverie] failed to emit session activity removal: {error}");
    }
}

fn hook_source_to_activity_source(source: HookSource) -> ActivitySource {
    match source {
        HookSource::ClaudeCode => ActivitySource::ClaudeCode,
        HookSource::CodexCli => ActivitySource::CodexCli,
    }
}

fn build_ghostty_frame_sequence() -> Result<GhosttyFrameSequence> {
    let mut terminal = GhosttyTerminalState::new(
        PROOF_COLS,
        PROOF_ROWS,
        PROOF_FRAMES + PROOF_ROWS as usize + 100,
    )?;
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
            "\x1b[38;2;{red};{green};{blue}mghostty-tauri-frame-{frame_index:03}\x1b[0m {underline}payload: agent output stream, unicode café 🚀 —, dirty-row patch candidate {reset_underline}\r\n"
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

fn live_stream_spawn_spec() -> Result<TerminalSpawnSpec> {
    let script = live_stream_script();
    let cwd = env::current_dir().context("failed to resolve current directory for proof PTY")?;
    let mut command = CommandSpec::new("/bin/sh", cwd);
    command.args.push("-lc".to_owned());
    command.args.push(script);

    Ok(TerminalSpawnSpec {
        command,
        cols: PROOF_COLS,
        rows: PROOF_ROWS,
        title: Some("Live PTY stream proof".to_owned()),
    })
}

fn live_stream_script() -> String {
    format!(
        r#"printf '\033[2J\033[H\033[1;36mReverie live PTY -> Ghostty -> Tauri event stream\033[0m\r\n'
printf 'controlled shell output, dirty-row canvas rendering, bridge cadence metrics\r\n'
i=1
while [ $i -le {frames} ]; do
  r=$((96 + (i * 3) % 128))
  g=$((160 + (i * 5) % 80))
  b=$((208 + (i * 7) % 48))
  printf '\033[38;2;%s;%s;%smtauri-live-stream-%03d\033[0m payload: PTY bytes -> Ghostty state -> Tauri event -> Canvas dirty rows café 🚀\r\n' "$r" "$g" "$b" "$i"
  if [ $((i % 4)) -eq 0 ]; then sleep 0.005; fi
  i=$((i + 1))
done
printf '\033[1;32mtauri-live-stream-complete\033[0m\r\n'
"#,
        frames = STREAM_FRAMES
    )
}
