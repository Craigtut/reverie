//! Dispatch: the global-shortcut quick-launch popup.
//!
//! Dispatch is Reverie's front door. A system-wide shortcut opens a small,
//! transparent, always-on-top capture window over whatever the user is doing;
//! they speak (or type) a task, Reverie classifies where it belongs, and on
//! confirm launches an agent into that place. See
//! `docs/product/core-experience/dispatch.md`.
//!
//! This module owns the native side of that surface: the second webview window
//! and the global shortcut that toggles it. The window is created hidden at
//! startup so its bundle stays warm and showing it on the shortcut is instant.
//! The React overlay lives behind `index.html?dispatch=1` (see `App.tsx`).

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use reverie_core::WorkspaceService;

/// Label of the dispatch webview window. Distinct from `main`; several
/// single-window assumptions in `main.rs` key off the label, so keep them in
/// sync with this constant.
pub(crate) const DISPATCH_WINDOW_LABEL: &str = "dispatch";

/// Default global shortcut. Deliberately not `Cmd+Space` (Spotlight). The user
/// can rebind it; this is the seed and the fallback when the stored value fails
/// to parse.
pub(crate) const DEFAULT_DISPATCH_SHORTCUT: &str = "CommandOrControl+Shift+Space";

/// Compact capture panel. The window is fixed-size and chromeless; the React
/// overlay paints the rim-lit panel within it.
const DISPATCH_WINDOW_WIDTH: f64 = 600.0;
const DISPATCH_WINDOW_HEIGHT: f64 = 156.0;

/// Build the global-shortcut plugin with a handler that toggles the dispatch
/// window. Registered once in the `main.rs` builder chain; the specific
/// accelerator is registered later (see [`register_dispatch_shortcut`]).
pub(crate) fn global_shortcut_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            // Fire on key-down only; key-up would re-toggle and immediately
            // hide the window we just opened.
            if event.state() == ShortcutState::Pressed {
                toggle_dispatch_window(app);
            }
        })
        .build()
}

/// Register the dispatch accelerator with the global-shortcut plugin. Safe to
/// call after the plugin is initialized (i.e. inside or after `setup`).
pub(crate) fn register_dispatch_shortcut<R: Runtime>(
    app: &AppHandle<R>,
    accelerator: &str,
) -> anyhow::Result<()> {
    let shortcut: tauri_plugin_global_shortcut::Shortcut = accelerator
        .parse()
        .map_err(|err| anyhow::anyhow!("invalid dispatch shortcut {accelerator:?}: {err}"))?;
    app.global_shortcut()
        .register(shortcut)
        .map_err(|err| anyhow::anyhow!("register dispatch shortcut {accelerator:?}: {err}"))?;
    Ok(())
}

/// Bind the dispatch shortcut, routing to the right mechanism: a `tap:` spec
/// (lone/handed modifier) goes to the macOS event tap, anything else is a
/// regular accelerator on the global-shortcut plugin. Clears any previous plugin
/// registration first, so it is safe to call on every change.
pub(crate) fn apply_dispatch_shortcut<R: Runtime>(
    app: &AppHandle<R>,
    accelerator: &str,
) -> anyhow::Result<()> {
    let _ = app.global_shortcut().unregister_all();
    #[cfg(target_os = "macos")]
    {
        // Point the modifier-tap at this spec: active for a `tap:` spec, inert
        // otherwise. A tap shortcut needs no plugin registration.
        if let Some(tap) = app.try_state::<crate::dispatch_tap::ModifierTap>() {
            tap.configure(app, accelerator);
        }
        if crate::dispatch_tap::parse_tap_spec(accelerator).is_some() {
            return Ok(());
        }
    }
    register_dispatch_shortcut(app, accelerator)
}

/// Swap the bound accelerator. Called when the user changes the dispatch
/// shortcut in settings.
pub(crate) fn reregister_dispatch_shortcut<R: Runtime>(
    app: &AppHandle<R>,
    accelerator: &str,
) -> anyhow::Result<()> {
    apply_dispatch_shortcut(app, accelerator)
}

/// Create the dispatch window hidden. Idempotent: returns the existing window if
/// it is already present. Called at startup to pre-warm the bundle.
pub(crate) fn create_dispatch_window<R: Runtime>(
    app: &AppHandle<R>,
) -> tauri::Result<WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window(DISPATCH_WINDOW_LABEL) {
        return Ok(window);
    }

    let window = WebviewWindowBuilder::new(
        app,
        DISPATCH_WINDOW_LABEL,
        WebviewUrl::App("index.html?dispatch=1".into()),
    )
    .title("Reverie Dispatch")
    .inner_size(DISPATCH_WINDOW_WIDTH, DISPATCH_WINDOW_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .center()
    .build()?;

    // Float over other apps' spaces, like Spotlight, rather than only the space
    // Reverie lives on.
    #[cfg(target_os = "macos")]
    let _ = window.set_visible_on_all_workspaces(true);

    Ok(window)
}

/// Toggle the dispatch window: hide it if visible, otherwise show + focus it and
/// signal the overlay to begin (auto-listen in voice mode). Bound to the global
/// shortcut.
pub(crate) fn toggle_dispatch_window<R: Runtime>(app: &AppHandle<R>) {
    let window = match app.get_webview_window(DISPATCH_WINDOW_LABEL) {
        Some(window) => window,
        None => match create_dispatch_window(app) {
            Ok(window) => window,
            Err(error) => {
                eprintln!("[reverie] failed to create dispatch window: {error}");
                return;
            }
        },
    };

    // Always show the window and hand the press to the overlay. The overlay owns
    // the state machine and decides what the press means (idle -> record,
    // recording -> stop, transcribing -> ignore), so we never guess open-vs-stop
    // from native visibility (which a blur-hide could flip out from under us).
    show_dispatch_window(app, &window);
}

/// Show, focus, and signal the dispatch window. The overlay listens for
/// `dispatch:trigger` and decides what the press means.
pub(crate) fn show_dispatch_window<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    // Reposition + show only on a fresh open; if it is already visible (a press
    // to stop/toggle), leave the position alone so it never jumps under the user.
    if !matches!(window.is_visible(), Ok(true)) {
        let saved = app
            .try_state::<WorkspaceService>()
            .and_then(|service| service.snapshot().ok())
            .and_then(|snapshot| {
                match (
                    snapshot.workspace.dispatch_window_x,
                    snapshot.workspace.dispatch_window_y,
                ) {
                    (Some(x), Some(y)) => Some(PhysicalPosition::new(x, y)),
                    _ => None,
                }
            });
        // Restore the saved position only if it still lands on a connected
        // display. If the user dragged the popup onto an external monitor and
        // later unplugged it, the stored coordinates point into dead space and
        // AppKit will not pull an explicitly-positioned window back on-screen,
        // so we would otherwise strand the popup with no way to recover it.
        match saved {
            Some(position) if position_on_visible_monitor(window, position) => {
                let _ = window.set_position(position);
            }
            _ => {
                let _ = window.center();
            }
        }
        let _ = window.show();
    }
    let _ = window.set_focus();
    let _ = app.emit_to(DISPATCH_WINDOW_LABEL, "dispatch:trigger", ());
}

/// Whether a saved window top-left (physical pixels) still falls on a currently
/// connected display. The window's drag strip lives at its top edge, so a
/// top-left that is on a real monitor is always recoverable by dragging. When
/// the monitor list can't be read we assume visible rather than fighting the
/// user's chosen position; when it can, a coordinate off every monitor (a
/// since-removed display) recenters instead.
fn position_on_visible_monitor<R: Runtime>(
    window: &WebviewWindow<R>,
    position: PhysicalPosition<i32>,
) -> bool {
    let monitors = match window.available_monitors() {
        Ok(monitors) if !monitors.is_empty() => monitors,
        // Can't enumerate displays: don't override the saved position.
        Ok(_) => return true,
        Err(_) => return true,
    };
    monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        let right = origin.x + size.width as i32;
        let bottom = origin.y + size.height as i32;
        position.x >= origin.x
            && position.x < right
            && position.y >= origin.y
            && position.y < bottom
    })
}
