#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activity_bridge;
#[cfg(all(debug_assertions, feature = "agent-automation"))]
mod agent_automation;
mod agent_trust;
#[cfg(target_os = "macos")]
mod bookmark;
#[cfg(unix)]
mod bridge;
#[cfg(unix)]
mod bridge_installer;
mod clipboard;
mod codex_titles;
mod commands;
#[cfg(unix)]
mod connection_commands;
mod correlator;
mod dispatch;
#[cfg(target_os = "macos")]
mod dispatch_tap;
mod git_watch;
mod keep_awake;
mod path_env;
mod reentry_summary;
mod shutdown_marker;
mod speech_commands;
mod state;
mod terminal;

#[cfg(debug_assertions)]
use std::{env, fs::OpenOptions, io::Write};

use reverie_core::WorkspaceService;
use reverie_core::activity_reconciler::ActivityReconciler;
use reverie_core::hook_server::{HookPushSource, start_hook_server, start_hook_server_with};
use reverie_core::session_log::start_session_log_watcher;
use reverie_core::{CodexLogSource, CompositeLogSource, CortexStateSource};
use reverie_persistence::SqliteWorkspaceRepository;
use tauri::{Emitter, Listener, Manager, Url};

use crate::activity_bridge::{drain_file_activity, drain_hook_activity};
use crate::git_watch::GitWatch;
use crate::keep_awake::KeepAwakeManager;
use crate::state::{
    HookServerInfo, HookTokenRegistry, ShutdownState, WebviewHealth, WorkspaceBoot,
    unix_time_millis,
};
use crate::terminal::runtime::{TerminalRuntimeStatus, TerminalSessionRuntime};

const WINDOW_CORNER_RADIUS: f64 = 28.0;
const WEBVIEW_HEALTH_CHECK_DELAY_MS: u64 = 1_500;
const WEBVIEW_HEARTBEAT_STALE_MS: i64 = 5_000;
const WEBVIEW_RELOAD_COOLDOWN_MS: i64 = 30_000;

/// Bring the macOS keep-awake assertion in line with the current setting and
/// live-session count. Cheap and idempotent: call it whenever a session starts
/// or ends, and when the toggle changes. A session is "alive" while its process
/// is `Starting` or `Running`; we deliberately do not look at the finer
/// working/idle micro-state, because a long task often sits quietly between
/// turns and must not let the Mac sleep in that gap.
pub(crate) fn reconcile_keep_awake(app: &tauri::AppHandle) {
    let (Some(service), Some(runtime), Some(manager)) = (
        app.try_state::<WorkspaceService>(),
        app.try_state::<TerminalSessionRuntime>(),
        app.try_state::<KeepAwakeManager>(),
    ) else {
        // Called before state is managed (very early boot). Nothing to do yet;
        // the next lifecycle event reconciles once everything is up.
        return;
    };
    let Ok(snapshot) = service.snapshot() else {
        return;
    };
    let has_live_session = runtime.list_sessions().is_ok_and(|records| {
        records.iter().any(|record| {
            matches!(
                record.status,
                TerminalRuntimeStatus::Starting | TerminalRuntimeStatus::Running
            )
        })
    });
    manager.reconcile(
        snapshot.workspace.keep_awake_enabled,
        snapshot.workspace.keep_display_awake,
        has_live_session,
    );
}

fn record_webview_health_diagnostic(
    app: &tauri::AppHandle,
    kind: &'static str,
    payload: serde_json::Value,
) {
    let _ = commands::record_terminal_diagnostics(
        app.clone(),
        serde_json::json!({
            "kind": kind,
            "wallTimeMs": unix_time_millis(),
            "payload": payload,
        }),
    );
}

fn reload_main_webview(app: &tauri::AppHandle, reason: &'static str, payload: serde_json::Value) {
    record_webview_health_diagnostic(
        app,
        "webview.reload",
        serde_json::json!({
            "reason": reason,
            "payload": payload,
        }),
    );
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[reverie] main webview reload skipped after {reason}: window missing");
        record_webview_health_diagnostic(
            app,
            "webview.reload_missing",
            serde_json::json!({
                "reason": reason,
            }),
        );
        return;
    };
    eprintln!("[reverie] reloading main webview after {reason}");
    if let Err(error) = window.reload() {
        eprintln!("[reverie] failed to reload main webview after {reason}: {error}");
        record_webview_health_diagnostic(
            app,
            "webview.reload_failed",
            serde_json::json!({
                "reason": reason,
                "error": error.to_string(),
            }),
        );
    }
}

fn schedule_webview_recovery_check(app: tauri::AppHandle, reason: &'static str) {
    std::thread::Builder::new()
        .name("reverie-webview-health".to_owned())
        .spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(
                WEBVIEW_HEALTH_CHECK_DELAY_MS,
            ));
            let Some(health) = app.try_state::<WebviewHealth>() else {
                return;
            };
            let now = unix_time_millis();
            let last_heartbeat = health.last_heartbeat_ms();
            let stale_for = now.saturating_sub(last_heartbeat);
            if last_heartbeat > 0 && stale_for < WEBVIEW_HEARTBEAT_STALE_MS {
                return;
            }
            if !health.claim_reload(now, WEBVIEW_RELOAD_COOLDOWN_MS) {
                return;
            }
            reload_main_webview(
                &app,
                reason,
                serde_json::json!({
                    "lastHeartbeatMs": last_heartbeat,
                    "staleForMs": stale_for,
                }),
            );
        })
        .ok();
}

#[cfg(target_os = "macos")]
fn apply_macos_window_corners(window: &tauri::WebviewWindow, radius: f64) {
    use objc::runtime::{Object, YES};
    use objc::{class, msg_send, sel, sel_impl};

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
        // Keep the native window transparent for rounded corners, but give the
        // masked content view an opaque fallback so a dead WKWebView never leaves
        // a see-through rectangle. The layer mask below clips this fill to the
        // same rounded shape as the app shell.
        let background: *mut Object = msg_send![
            class!(NSColor),
            colorWithCalibratedRed: 0.043137254901960784f64
            green: 0.0392156862745098f64
            blue: 0.03529411764705882f64
            alpha: 1.0f64
        ];
        if !background.is_null() {
            let cg_color: *mut Object = msg_send![background, CGColor];
            if !cg_color.is_null() {
                let _: () = msg_send![layer, setBackgroundColor: cg_color];
            }
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
        // Auto-updates (production channel only; the frontend gates the actual
        // check on `updater_status` so the dev channel never reaches out). The
        // process plugin backs the post-install relaunch.
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Global shortcut that toggles the dispatch capture window. The window
        // itself is created hidden in `setup`; the accelerator is registered
        // there too. See `dispatch.rs`.
        .plugin(dispatch::global_shortcut_plugin())
        .on_web_content_process_terminate(|webview| {
            let app = webview.app_handle().clone();
            let label = webview.label().to_owned();
            if let Some(health) = app.try_state::<WebviewHealth>() {
                let _ = health.claim_reload(unix_time_millis(), 0);
            }
            record_webview_health_diagnostic(
                &app,
                "webview.content_terminated",
                serde_json::json!({ "label": label.clone() }),
            );
            eprintln!("[reverie] web content process terminated for webview {label}; reloading");
            if let Err(error) = webview.reload() {
                eprintln!("[reverie] failed to reload terminated webview {label}: {error}");
                record_webview_health_diagnostic(
                    &app,
                    "webview.content_terminate_reload_failed",
                    serde_json::json!({
                        "label": label.clone(),
                        "error": error.to_string(),
                    }),
                );
            }
            schedule_webview_recovery_check(app, "web_content_terminated");
        })
        .on_window_event(|window, event| {
            // The dispatch popup is a secondary window. Closing it must not quit
            // the app, and its focus changes must not drive the main window's
            // git-watch / webview-recovery logic. Dismiss-not-destroy keeps the
            // pre-warmed bundle alive; blur hides it, Spotlight-style.
            if window.label() != "main" {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    tauri::WindowEvent::Focused(false) => {
                        let _ = window.hide();
                    }
                    _ => {}
                }
                return;
            }
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
            // Suspend git status polling while the app is in the background and
            // resume (with an immediate catch-up) when it returns to focus.
            if let tauri::WindowEvent::Focused(focused) = event {
                if let Some(watch) = window.app_handle().try_state::<GitWatch>() {
                    watch.set_active(*focused);
                }
                if *focused {
                    schedule_webview_recovery_check(
                        window.app_handle().clone(),
                        "window_focused",
                    );
                }
            }
        })
        .setup(|app| {
            app.state::<WebviewHealth>().mark_heartbeat();
            let store_path = app
                .path()
                .app_data_dir()?
                .join("workspace-shell.v1.sqlite3");
            let repository = std::sync::Arc::new(
                SqliteWorkspaceRepository::open(&store_path)
                    .map_err(|err| anyhow::anyhow!("failed to open Reverie database: {err}"))?,
            );
            let service = WorkspaceService::new(repository.clone());
            // Attach the macOS folder-identity bookmark provider so a project can
            // follow its folder across a rename or move (auto-reconnect).
            #[cfg(target_os = "macos")]
            let service =
                service.with_bookmark_provider(std::sync::Arc::new(bookmark::MacBookmarkProvider));
            // Did the previous run die without a graceful shutdown (crash, panic,
            // force-kill, power loss)? If so, any session still marked `running` is
            // stale: its process is gone (and the orphan reaper below SIGKILLs any
            // that somehow survived). `ensure_seeded` reconciles those records; we
            // surface the count first so an unclean exit is observable in the log
            // instead of resurfacing later as a phantom "still running" session.
            let unclean_shutdown =
                crate::shutdown_marker::detect_unclean_shutdown_and_arm(app.handle());
            if unclean_shutdown {
                let stale = service
                    .snapshot()
                    .map(|snapshot| {
                        snapshot
                            .sessions
                            .iter()
                            .filter(|session| {
                                session.status == reverie_core::SessionStatus::Running
                            })
                            .count()
                    })
                    .unwrap_or(0);
                eprintln!(
                    "[reverie] previous run exited uncleanly; reconciling {stale} session(s) left marked running"
                );
            }
            service.ensure_seeded()?;
            crate::terminal::orphans::reap_stale_spawns(app.handle());
            // Reap scratch workspaces left by General sessions that no longer
            // exist (e.g. if a crash interrupted delete-time cleanup).
            commands::sweep_orphan_general_sessions(app.handle(), &service);
            // Reap stale clipboard-image temp files from earlier runs.
            commands::sweep_pasted_images(app.handle());
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
            // identifier (com.muselab.reverie.dev) so its data never co-mingles
            // with a real install. Make it visibly distinct too, so the two are
            // never confused on screen.
            if commands::is_dev_channel(app.handle()) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title("Reverie Dev");
                }
                #[cfg(target_os = "macos")]
                set_macos_dock_icon(DEV_DOCK_ICON_PNG);
            }

            #[cfg(all(debug_assertions, feature = "agent-automation"))]
            if let Err(error) = agent_automation::maybe_start(app.handle()) {
                eprintln!("[reverie-agent] automation bridge disabled: {error:#}");
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
                    // We deliberately do NOT blanket-register persisted sessions'
                    // state files at boot. On a fresh launch this instance owns no
                    // live agent process: a graceful quit stopped them all, and the
                    // orphan reaper above SIGKILLs any process that survived a crash.
                    // Registering a dead session's file makes the engine immediately
                    // fold its last on-disk record and emit it (`register_file` reads
                    // from offset 0), and a crash leaves that record mid-turn, i.e.
                    // `working`. Because boot reconciliation reset the persisted
                    // activity's status to rest WITHOUT moving its `updated_at`, that
                    // re-folded `working` is not "older" than the reset state, so the
                    // out-of-order guard lets it win and the session falsely lights up
                    // as actively running again. The launch path registers the watch
                    // when a session is actually (re)started (`spawn_launch_capture_poll`),
                    // which is the only moment live state can legitimately flow.
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

            // Repair Codex sessions that captured a native id but never bound their
            // rollout path (a sibling session in the same folder won the launch-time
            // cwd scan, or the id was captured first). Without the path they can be
            // neither activity-watched nor titled. This only fixes the persisted ref
            // by exact native id; the launch path still owns watch registration, so
            // it cannot resurrect a dead session as "working". Off-thread (file scan).
            {
                let app_handle = app.handle().clone();
                std::thread::Builder::new()
                    .name("reverie-codex-rollout-backfill".to_owned())
                    .spawn(move || {
                        crate::terminal::runtime::backfill_codex_rollout_paths(&app_handle)
                    })
                    .ok();
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
                // Forward every connection state change to the WebView so the
                // accept/deny banner and connection panels stay live without
                // polling. A new agent request reaches the banner through this.
                let emit_handle = app.handle().clone();
                let observer: reverie_core::ConnectionObserver =
                    std::sync::Arc::new(move |event| {
                        connection_commands::forward_connection_event(&emit_handle, event);
                    });
                match bridge::start_bridge(socket_path, repo_for_bridge, Some(observer)) {
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

            // Keep-awake: hold a macOS power assertion while agent tasks run, so
            // a user who walked away comes back to still-running sessions. Driven
            // off session-lifecycle events (start and exit both emit
            // `session_status_changed`; failures emit `terminal_failed`) plus the
            // settings toggle. Reconcile recomputes from the live session set, so
            // it is self-correcting regardless of which event fired. Listening
            // here keeps power management out of the terminal runtime.
            for event in ["session_status_changed", "terminal_failed"] {
                let handle = app.handle().clone();
                app.listen_any(event, move |_| reconcile_keep_awake(&handle));
            }
            // Boot reconcile: a session resumed at startup, or the toggle left on
            // from a prior run, should take effect without waiting for the next
            // lifecycle event.
            reconcile_keep_awake(app.handle());

            // Git status poll loop: keeps each watched project's repo context
            // (branch, sync state, dirty line counts) fresh and pushes changes
            // to the WebView. Read-only and calm; see `git_watch`.
            git_watch::start(app.handle());

            // On-device speech engine. The worker emits lifecycle/error events
            // here, which we relay to the WebView. Provisioning is kicked eagerly
            // on first launch (a one-time background model download); it never
            // blocks boot and is a no-op when the model is already cached.
            {
                let speech_app = app.handle().clone();
                let speech_events: reverie_speech::EventSink =
                    std::sync::Arc::new(move |event| match event {
                        reverie_speech::SpeechEvent::State(state) => {
                            let _ = speech_app.emit("speech_engine_state", state);
                        }
                        reverie_speech::SpeechEvent::Error {
                            message,
                            capture_id,
                        } => {
                            let _ = speech_app.emit(
                                "speech_error",
                                speech_commands::SpeechErrorPayload {
                                    message,
                                    capture_id,
                                },
                            );
                        }
                    });
                let speech_engine = reverie_speech::SpeechEngine::new(speech_events);
                speech_engine.provision();
                app.manage(speech_engine);
            }

            // Dispatch: create the capture window hidden (pre-warm the bundle so
            // the shortcut shows it instantly) and bind the global shortcut.
            // Both failures are non-fatal: the rest of the app runs fine without
            // dispatch.
            if let Err(error) = dispatch::create_dispatch_window(app.handle()) {
                eprintln!("[reverie] failed to create dispatch window: {error}");
            }
            // The modifier-tap trigger (lone/handed modifier shortcuts) is macOS
            // only; manage it before applying the shortcut so the tap path can
            // resolve it.
            #[cfg(target_os = "macos")]
            app.manage(dispatch_tap::ModifierTap::default());
            // Bind the persisted accelerator (falling back to the default if the
            // workspace row is somehow unavailable this early). `apply` routes a
            // `tap:` spec to the event tap and a regular accelerator to the plugin.
            let dispatch_shortcut = app
                .try_state::<WorkspaceService>()
                .and_then(|service| service.snapshot().ok())
                .map(|snapshot| snapshot.workspace.dispatch_shortcut)
                .unwrap_or_else(|| dispatch::DEFAULT_DISPATCH_SHORTCUT.to_owned());
            if let Err(error) = dispatch::apply_dispatch_shortcut(app.handle(), &dispatch_shortcut) {
                eprintln!("[reverie] failed to register dispatch shortcut: {error}");
            }

            Ok(())
        })
        .manage(TerminalSessionRuntime::default())
        .manage(WorkspaceBoot::default())
        .manage(ShutdownState::default())
        .manage(WebviewHealth::default())
        .manage(KeepAwakeManager::default())
        .manage(GitWatch::default())
        // Shared cross-source merge for Codex (hooks + rollout), read by the
        // correlator on every Codex activity update.
        .manage(ActivityReconciler::new())
        .invoke_handler(tauri::generate_handler![
            commands::app_status,
            commands::updater_status,
            commands::ghostty_frame_sequence,
            commands::workspace_shell,
            commands::list_agent_clis,
            commands::set_agent_cli_enabled,
            commands::choose_project_folder,
            commands::resolve_project_folder,
            commands::create_project,
            commands::create_project_from_folder,
            commands::relocate_project,
            commands::create_focus,
            commands::create_session,
            commands::set_session_archived,
            commands::remove_session,
            commands::set_session_dangerous_mode,
            commands::mark_session_viewed,
            commands::set_session_flagged_at,
            commands::dismiss_session_reentry,
            commands::resolve_permission,
            commands::rename_session,
            commands::rename_focus,
            commands::rename_project,
            commands::reveal_path,
            commands::set_workspace_default_dangerous_mode,
            commands::set_workspace_theme,
            commands::set_workspace_keep_awake,
            commands::set_workspace_default_agent_kind,
            commands::set_terminal_font_size,
            commands::set_crt_enabled,
            commands::set_dispatch_settings,
            commands::classify_dispatch,
            speech_commands::speech_engine_status,
            speech_commands::speech_provision,
            speech_commands::speech_mic_permission_status,
            speech_commands::speech_start_capture,
            speech_commands::speech_stop_capture,
            speech_commands::speech_cancel_capture,
            commands::set_sidebar_width,
            commands::set_workspace_nav_state,
            commands::hook_server_port,
            commands::archive_focus,
            commands::restore_focus,
            commands::delete_focus,
            commands::archive_project,
            commands::delete_project,
            commands::reorder_focuses,
            commands::reorder_projects,
            commands::reorder_sessions,
            commands::move_session,
            commands::capture_cortex_session,
            commands::start_session,
            commands::list_terminal_sessions,
            commands::write_terminal_input,
            commands::paste_terminal_text,
            commands::resize_terminal,
            commands::read_terminal_rows,
            commands::set_terminal_frontend_active,
            commands::set_terminal_theme,
            commands::terminate_session,
            commands::confirm_quit,
            commands::prepare_update_relaunch,
            commands::record_render_metrics,
            commands::record_terminal_diagnostics,
            commands::webview_heartbeat,
            commands::open_url,
            commands::system_home_dir,
            commands::read_clipboard_image,
            commands::save_pasted_image,
            git_watch::set_git_watch_projects,
            git_watch::git_status,
            git_watch::git_pull,
            git_watch::git_push,
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
                app_handle.state::<KeepAwakeManager>().release_all();
                // We reached the runtime's exit event, so this is a graceful stop
                // (Cmd-Q / window close / app.exit), not a crash. Clear the marker
                // so the next boot reads a clean shutdown. A crash or SIGKILL never
                // runs this, leaving the marker for the next boot to detect.
                crate::shutdown_marker::note_clean_shutdown(&app_handle);
            }
            tauri::RunEvent::Resumed => {
                schedule_webview_recovery_check(app_handle.clone(), "app_resumed");
            }
            _ => {}
        });
}
