#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_shell;
mod terminal_backend;
mod terminal_runtime;

use std::{env, path::PathBuf};

use anyhow::{Context, Result};
use reverie_core::agents::built_in_adapters;
use reverie_core::domain::{AgentKind, FocusId, ProjectId, SessionId};
use reverie_core::terminal::{TerminalFrame, TerminalId};
use reverie_core::{AdapterDetection, CommandSpec, TerminalSpawnSpec};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use app_shell::{
    AppShellStore, CaptureCortexSessionRequest, CreateFocusRequest, CreateProjectRequest,
    CreateSessionRequest, UpdateSessionTabVisibilityRequest, WorkspaceShellSnapshot,
};
use terminal_backend::GhosttyTerminalState;
use terminal_runtime::{TerminalSessionRecord, TerminalSessionRuntime, TerminalStreamRequest};

const PROOF_COLS: u16 = 120;
const PROOF_ROWS: u16 = 36;
const PROOF_FRAMES: usize = 180;
const STREAM_FRAMES: usize = 240;

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
            let executable = detection.executable().map(|path| path.display().to_string());
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
    store: State<'_, AppShellStore>,
    session_id: SessionId,
) -> Result<WorkspaceShellSnapshot, String> {
    store.remove_session(session_id).map_err(|err| err.to_string())
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
    store.archive_project(project_id).map_err(|err| err.to_string())
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
    let spawn_spec = match request.spawn_spec {
        Some(spawn_spec) => spawn_spec,
        None => {
            let shell_session_id = session_id
                .ok_or_else(|| "start_session requires sessionId when spawnSpec is omitted".to_owned())?;
            store
                .build_agent_spawn_spec(
                    shell_session_id,
                    request.cols.unwrap_or(120),
                    request.rows.unwrap_or(32),
                )
                .map_err(|err| err.to_string())?
        }
    };

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

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let store_path = app.path().app_data_dir()?.join("workspace-shell.v1.sqlite3");
            app.manage(AppShellStore::load_or_seed(store_path)?);
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
            archive_focus,
            archive_project,
            capture_cortex_session,
            start_session,
            start_live_pty_stream_proof,
            list_terminal_sessions,
            write_terminal_input,
            resize_terminal,
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
