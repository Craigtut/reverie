#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activity_bridge;
mod agent_trust;
#[cfg(unix)]
mod bridge;
#[cfg(unix)]
mod bridge_installer;
mod codex_titles;
mod commands;
#[cfg(unix)]
mod connection_commands;
mod correlator;
mod path_env;
mod state;
mod terminal;

#[cfg(debug_assertions)]
use std::{env, fs::OpenOptions, io::Write};

use reverie_core::WorkspaceService;
use reverie_core::hook_server::{HookPushSource, start_hook_server, start_hook_server_with};
use reverie_core::session_log::start_session_log_watcher;
use reverie_core::{CodexLogSource, CompositeLogSource, CortexStateSource};
use reverie_persistence::SqliteWorkspaceRepository;
use tauri::{Emitter, Manager, Url};

use crate::activity_bridge::{drain_file_activity, drain_hook_activity};
use crate::state::{HookServerInfo, HookTokenRegistry, ShutdownState, WorkspaceBoot};
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

/// The dev channel's badged icon, embedded so a non-bundled `cargo run` (which
/// has no app bundle to carry an icon) can still show a distinct Dock icon.
#[cfg(target_os = "macos")]
const DEV_DOCK_ICON_PNG: &[u8] = include_bytes!("../icons-dev/source.png");

/// Set the macOS Dock icon at runtime from PNG bytes. Production builds get their
/// icon from the app bundle; the dev channel runs as a bare `cargo run` binary
/// with no bundle, so we set it here to keep the dev app visibly distinct from a
/// real install.
#[cfg(target_os = "macos")]
fn set_macos_dock_icon(png_bytes: &[u8]) {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    // SAFETY: standard AppKit calls on the main thread during Tauri setup. NSData
    // borrows the buffer only for the call; NSImage copies what it retains.
    unsafe {
        let data: *mut Object = msg_send![
            class!(NSData),
            dataWithBytes: png_bytes.as_ptr() as *const std::ffi::c_void
            length: png_bytes.len()
        ];
        if data.is_null() {
            return;
        }
        let image: *mut Object = msg_send![class!(NSImage), alloc];
        let image: *mut Object = msg_send![image, initWithData: data];
        if image.is_null() {
            return;
        }
        let ns_app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![ns_app, setApplicationIconImage: image];
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

#[cfg(debug_assertions)]
fn unix_time_millis_for_log() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn main() {
    // Must run before anything spawns a thread: a GUI launch (Finder/Dock) only
    // carries launchd's minimal PATH, so without this neither agent detection
    // nor the node-shebang CLIs can find their binaries. Rehydrates the process
    // PATH from the user's login shell. See `path_env` for the full rationale.
    path_env::hydrate_path_from_login_shell();

    install_dev_panic_logger();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            // Closing the window (red traffic-light button) is a quit for this
            // single-window app. Defer it the first time so the frontend can
            // confirm any in-flight agent work, then it calls `confirm_quit`,
            // which stops every session and re-issues the exit.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if !app.state::<ShutdownState>().is_started() {
                    api.prevent_close();
                    let _ = app.emit("app_quit_requested", ());
                }
            }
        })
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
            crate::terminal::orphans::reap_stale_spawns(app.handle());
            // Reap scratch workspaces left by General sessions that no longer
            // exist (e.g. if a crash interrupted delete-time cleanup).
            commands::sweep_orphan_general_sessions(app.handle(), &service);
            // Publish the service only after the database is opened, migrated,
            // and seeded. `WorkspaceBoot` is managed on the builder below, so it
            // is available the instant the webview fires its first
            // `workspace_shell` invoke; until this `set` runs, that command
            // returns a retryable "still starting" signal instead of failing
            // hard, and once it returns a service the read is guaranteed seeded.
            app.state::<WorkspaceBoot>().set(service.clone());
            app.manage(service);
            // Stash the repository for the bridge to share. We keep it as
            // managed state so background threads can still hold an Arc to
            // it without going through a Tauri command boundary.
            app.manage(repository.clone());

            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                apply_macos_window_corners(&window, WINDOW_CORNER_RADIUS);
                if std::env::var_os("REVERIE_TERMINAL_STRESS").is_some() {
                    let target = window
                        .url()
                        .map(|mut url| {
                            url.set_query(Some("tauriTerminalStress=1"));
                            url
                        })
                        .or_else(|_| Url::parse("http://127.0.0.1:1420/?tauriTerminalStress=1"));
                    if let Ok(url) = target {
                        let _ = window.navigate(url);
                    }
                }
            }

            // Dev channel adornment: the dev build runs from a separate bundle
            // identifier (com.animus.reverie.dev) so its data never co-mingles
            // with a real install. Make it visibly distinct too, so the two are
            // never confused on screen.
            if commands::is_dev_channel(app.handle()) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title("Reverie Dev");
                }
                #[cfg(target_os = "macos")]
                set_macos_dock_icon(DEV_DOCK_ICON_PNG);
            }

            // Activity file watcher: one active-file, incremental-tail engine that
            // serves every file-transport CLI through a composite source. Codex
            // rollouts (append-log) and Cortex snapshots both flow through it. It
            // watches only the live-state files the launch path registers (via the
            // managed `SessionLogControl`), so cost scales with active sessions and
            // new output, not with the whole sessions tree or accumulated history.
            let file_source = std::sync::Arc::new(CompositeLogSource::new(vec![
                std::sync::Arc::new(CodexLogSource),
                std::sync::Arc::new(CortexStateSource),
            ]));
            match start_session_log_watcher(file_source) {
                Ok(watcher) => {
                    let control = watcher.control.clone();
                    app.manage(control.clone());
                    // Boot-time registration: re-watch the live-state file of every
                    // persisted session that already carries a file-transport native
                    // ref, so a session still running when Reverie starts shows live
                    // state immediately. This is the old Cortex startup scan, now
                    // scoped to the sessions Reverie actually owns.
                    if let Ok(snapshot) = app.state::<WorkspaceService>().snapshot() {
                        for session in &snapshot.sessions {
                            if let Some(reference) = &session.native_session_ref {
                                if let Some(path) =
                                    crate::terminal::runtime::watch_path_for_ref(reference)
                                {
                                    control.register(path);
                                    if reference.kind == reverie_core::AgentKind::CodexCli {
                                        crate::codex_titles::maybe_schedule_codex_title_after_capture(
                                            app.handle(),
                                            session.id,
                                        );
                                    }
                                }
                            }
                        }
                    }
                    let app_handle = app.handle().clone();
                    std::thread::Builder::new()
                        .name("reverie-activity-file-bridge".to_owned())
                        .spawn(move || drain_file_activity(watcher, app_handle))
                        .ok();
                }
                Err(error) => {
                    eprintln!("[reverie] activity file watcher disabled: {error:#}");
                }
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

            // Start the idle-session reaper. It keeps every session alive until
            // macOS itself reports memory pressure, then sheds only the coldest
            // off-screen, non-working, long-idle sessions. Best-effort: if it
            // cannot start, sessions simply stay alive.
            crate::terminal::reaper::spawn_reaper(
                app.state::<TerminalSessionRuntime>().inner().clone(),
                app.state::<WorkspaceService>().inner().clone(),
            );

            Ok(())
        })
        .manage(TerminalSessionRuntime::default())
        .manage(WorkspaceBoot::default())
        .manage(ShutdownState::default())
        .invoke_handler(tauri::generate_handler![
            commands::app_status,
            commands::ghostty_frame_sequence,
            commands::workspace_shell,
            commands::list_agent_clis,
            commands::set_agent_cli_enabled,
            commands::choose_project_folder,
            commands::resolve_project_folder,
            commands::create_project,
            commands::create_project_from_folder,
            commands::create_focus,
            commands::create_session,
            commands::update_session_tab_visibility,
            commands::set_session_archived,
            commands::remove_session,
            commands::set_session_dangerous_mode,
            commands::mark_session_viewed,
            commands::set_workspace_default_dangerous_mode,
            commands::set_workspace_theme,
            commands::set_workspace_default_agent_kind,
            commands::set_terminal_font_size,
            commands::set_workspace_nav_state,
            commands::hook_server_port,
            commands::archive_focus,
            commands::archive_project,
            commands::reorder_focuses,
            commands::reorder_projects,
            commands::reorder_sessions,
            commands::move_session,
            commands::capture_cortex_session,
            commands::start_session,
            commands::list_terminal_sessions,
            commands::write_terminal_input,
            commands::resize_terminal,
            commands::read_terminal_rows,
            commands::set_terminal_frontend_active,
            commands::set_terminal_theme,
            commands::terminate_session,
            commands::confirm_quit,
            commands::record_render_metrics,
            commands::record_terminal_diagnostics,
            commands::open_url,
            commands::system_home_dir,
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
        .build(tauri::generate_context!())
        .expect("failed to build Reverie desktop shell")
        .run(|app_handle, event| match event {
            // Cmd-Q / Quit menu. Defer the first time and route through the
            // frontend confirm + `confirm_quit`, which sets the shutdown flag
            // and re-exits so this pass falls through.
            tauri::RunEvent::ExitRequested { api, .. } => {
                if !app_handle.state::<ShutdownState>().is_started() {
                    api.prevent_exit();
                    let _ = app_handle.emit("app_quit_requested", ());
                }
            }
            // Final backstop: once the app is actually terminating, make sure no
            // agent process tree outlives it, even if the graceful path never
            // ran (e.g. a wedged or closed webview).
            tauri::RunEvent::Exit => {
                app_handle.state::<TerminalSessionRuntime>().kill_all_now();
            }
            _ => {}
        });
}
