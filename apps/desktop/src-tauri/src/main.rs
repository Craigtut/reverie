#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activity_bridge;
#[cfg(unix)]
mod bridge;
#[cfg(unix)]
mod bridge_installer;
mod commands;
#[cfg(unix)]
mod connection_commands;
mod state;
mod terminal;

use std::{env, fs::OpenOptions, io::Write, path::PathBuf};

use reverie_core::TranscriptStore;
use reverie_core::WorkspaceService;
use reverie_core::activity_watcher::watch_cortex_activity;
use reverie_core::hook_server::{HookPushSource, start_hook_server, start_hook_server_with};
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
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let store_path = app
                .path()
                .app_data_dir()?
                .join("workspace-shell.v1.sqlite3");
            let repository = std::sync::Arc::new(
                SqliteWorkspaceRepository::open(&store_path)
                    .map_err(|err| anyhow::anyhow!("failed to open Reverie database: {err}"))?,
            );
            let service = WorkspaceService::new(repository.clone());
            service.ensure_seeded()?;
            app.manage(service);
            // Stash the repository for the bridge to share. We keep it as
            // managed state so background threads can still hold an Arc to
            // it without going through a Tauri command boundary.
            app.manage(repository.clone());

            // Wire the durable transcript sink into the terminal runtime so each
            // product session's raw PTY output is persisted for full-history
            // scrollback + search.
            app.state::<TerminalSessionRuntime>()
                .set_transcript_store(repository.clone() as std::sync::Arc<dyn TranscriptStore>);

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

            // Start the inter-agent connection bridge FIRST so we can hand
            // its ConnectionService into the hook server below as the
            // pre-turn push source. The Unix-socket listener spawned here
            // is what the `reverie-bridge` helper (run as a stdio MCP
            // child by each agent CLI) connects back to.
            // See docs/technical/inter-agent-connections.md.
            #[cfg(unix)]
            let connection_service_for_push: Option<
                std::sync::Arc<dyn HookPushSource>,
            > = {
                let socket_path = bridge::default_socket_path();
                let repo_for_bridge: std::sync::Arc<dyn reverie_core::ConnectionRepository> =
                    repository.clone();
                match bridge::start_bridge(socket_path, repo_for_bridge) {
                    Ok((service, info)) => {
                        let push = service.clone() as std::sync::Arc<dyn HookPushSource>;
                        app.manage(service);
                        app.manage(info);
                        Some(push)
                    }
                    Err(error) => {
                        eprintln!("[reverie] inter-agent bridge disabled: {error:#}");
                        None
                    }
                }
            };
            #[cfg(not(unix))]
            let connection_service_for_push: Option<
                std::sync::Arc<dyn HookPushSource>,
            > = None;

            // Start the localhost hook HTTP server. Claude Code and Codex CLI
            // hook ingestion is available once we have a non-invasive attachment
            // path. We intentionally do not redirect CLAUDE_CONFIG_DIR/CODEX_HOME
            // because those env vars also move each CLI's auth/config home.
            // When the connection bridge is up, the hook server uses it to
            // respond to UserPromptSubmit hooks with `additionalContext`
            // carrying pending inter-agent messages.
            app.manage(HookTokenRegistry::default());
            let hook_server_result = if connection_service_for_push.is_some() {
                start_hook_server_with(connection_service_for_push.clone())
            } else {
                start_hook_server()
            };
            match hook_server_result {
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
            commands::set_agent_cli_enabled,
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
            commands::scroll_terminal_viewport_to_row,
            commands::search_terminal,
            commands::terminal_history_info,
            commands::terminal_history_window,
            commands::terminate_session,
            commands::record_render_metrics,
            commands::open_url,
            #[cfg(unix)]
            connection_commands::bridge_installation_status,
            #[cfg(unix)]
            connection_commands::install_cortex_bridge_command,
            #[cfg(unix)]
            connection_commands::uninstall_cortex_bridge_command,
            #[cfg(unix)]
            connection_commands::install_codex_bridge_command,
            #[cfg(unix)]
            connection_commands::uninstall_codex_bridge_command,
            #[cfg(unix)]
            connection_commands::install_claude_bridge_command,
            #[cfg(unix)]
            connection_commands::uninstall_claude_bridge_command,
            #[cfg(unix)]
            connection_commands::list_pending_connection_requests,
            #[cfg(unix)]
            connection_commands::accept_connection_request,
            #[cfg(unix)]
            connection_commands::deny_connection_request,
            #[cfg(unix)]
            connection_commands::list_session_connections,
            #[cfg(unix)]
            connection_commands::close_connection_command,
            #[cfg(unix)]
            connection_commands::user_open_connection,
            #[cfg(unix)]
            connection_commands::connection_transcript,
            #[cfg(unix)]
            connection_commands::connection_policy,
            #[cfg(unix)]
            connection_commands::set_connection_policy,
            #[cfg(unix)]
            connection_commands::set_focus_policy_override,
            #[cfg(unix)]
            connection_commands::focus_policy_override,
            #[cfg(unix)]
            connection_commands::pair_recently_denied,
            #[cfg(unix)]
            connection_commands::block_session_pair,
            #[cfg(unix)]
            connection_commands::clear_session_pair_block,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Reverie desktop shell");
}
