#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activity_bridge;
mod commands;
mod state;
mod terminal;

use std::{env, fs::OpenOptions, io::Write, path::PathBuf};

use reverie_core::WorkspaceService;
use reverie_core::activity_watcher::watch_cortex_activity;
use reverie_core::hook_server::start_hook_server;
use reverie_persistence::SqliteWorkspaceRepository;
use tauri::Manager;

use crate::activity_bridge::{drain_cortex_activity, drain_hook_activity};
use crate::state::{HookServerInfo, HookTokenRegistry};
use crate::terminal::runtime::TerminalSessionRuntime;

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

fn main() {
    install_dev_panic_logger();

    tauri::Builder::default()
        .setup(|app| {
            let store_path = app
                .path()
                .app_data_dir()?
                .join("workspace-shell.v1.sqlite3");
            let repository = SqliteWorkspaceRepository::open(&store_path)
                .map_err(|err| anyhow::anyhow!("failed to open Reverie database: {err}"))?;
            let service = WorkspaceService::new(std::sync::Arc::new(repository));
            service.ensure_seeded()?;
            app.manage(service);

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
            // hook ingestion is available once we have a non-invasive attachment
            // path. We intentionally do not redirect CLAUDE_CONFIG_DIR/CODEX_HOME
            // because those env vars also move each CLI's auth/config home.
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
            commands::app_status,
            commands::ghostty_frame_sequence,
            commands::workspace_shell,
            commands::list_agent_clis,
            commands::choose_project_folder,
            commands::create_project,
            commands::create_focus,
            commands::create_session,
            commands::update_session_tab_visibility,
            commands::remove_session,
            commands::set_session_dangerous_mode,
            commands::set_workspace_default_dangerous_mode,
            commands::hook_server_port,
            commands::archive_focus,
            commands::archive_project,
            commands::capture_cortex_session,
            commands::start_session,
            commands::list_terminal_sessions,
            commands::write_terminal_input,
            commands::resize_terminal,
            commands::scroll_terminal_viewport,
            commands::scroll_terminal_viewport_to_top,
            commands::scroll_terminal_viewport_to_bottom,
            commands::terminate_session,
            commands::record_render_metrics
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Reverie desktop shell");
}
