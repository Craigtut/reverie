//! Native macOS window chrome that Reverie has to drive itself.
//!
//! Reverie draws its whole UI in the webview, but the window frame around it is
//! AppKit's, and four things there cannot be reached from CSS:
//!
//! 1. **Appearance.** A window left on the system appearance draws a LIGHT frame
//!    around Reverie's dark UI, which reads as a bright hairline along the top
//!    edge. It has to be pinned to the app's theme, not the system's.
//! 2. **The titlebar decoration.** Even with `titlebarAppearsTransparent`, AppKit
//!    keeps a visible `_NSTitlebarDecorationView` across the top of the titlebar.
//!    `NSTitlebarBackgroundView` hides itself; that one does not.
//! 3. **The corner radius.** On macOS 26 the window radius is not a constant: it
//!    is chosen from the window's toolbar style. Measured on 26.5.2, a window
//!    with no toolbar gets 16pt, `.unifiedCompact` gets 20pt, and `.unified` (what
//!    Finder and friends use) gets 26pt. Reverie had no toolbar at all, so it sat
//!    at the legacy 16pt and looked visibly squarer than every system window next
//!    to it. Attaching an empty unified toolbar is the whole fix.
//! 4. **The window buttons.** Reverie draws its own traffic lights inside the
//!    sidebar panel, so the real ones are hidden.
//!
//! On why the buttons are hidden rather than moved: AppKit re-lays out the
//! titlebar on every resize and puts its buttons back where it wants them.
//! `trafficLightPosition` in tauri.conf.json cannot help (Tauri and tao only
//! stash that offset and apply it from a `drawRect:` that never runs on a webview
//! window), and re-applying an inset from the resize event loses the race: tested
//! directly, the buttons snapped back to the system position after a few resizes
//! both with and without an `NSViewFrameDidChangeNotification` observer. tao only
//! gets away with it by re-insetting on literally every frame. Hiding them is
//! stable by construction, and verified to survive resizes.

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send};
use objc2_foundation::NSString;

/// `NSWindowToolbarStyleUnified`. The style that yields the 26pt corner radius.
const TOOLBAR_STYLE_UNIFIED: isize = 3;
/// `NSTitlebarSeparatorStyleNone`, so the toolbar draws no hairline under itself.
const TITLEBAR_SEPARATOR_NONE: isize = 1;

/// The shell's base surface per theme, matching `--bg` in `themes/appShell.ts`.
///
/// This is what the window and the webview paint when they have nothing else to
/// show. It matters during a fast live resize: AppKit stretches the window before
/// the webview has repainted, and whatever is underneath flashes. Left at the
/// default that flash is white, which is violent against the dark theme.
const DARK_BG: (f64, f64, f64) = (0.043_137_254_9, 0.039_215_686_3, 0.035_294_117_6); // #0B0A09
const LIGHT_BG: (f64, f64, f64) = (0.956_862_745_1, 0.945_098_039_2, 0.921_568_627_5); // #F4F1EB

/// Apply the full native chrome to the main window.
pub(crate) fn apply(window: &tauri::WebviewWindow, dark: bool) {
    let Ok(ptr) = window.ns_window() else { return };
    if ptr.is_null() {
        return;
    }
    guarded(|| {
        // SAFETY: AppKit calls on the main thread. Every pointer is null-checked
        // before use, and each step is independent so a failure cannot corrupt
        // the ones after it.
        unsafe {
            let ns_window = ptr.cast::<AnyObject>();
            set_appearance(ns_window, dark);
            set_background(ns_window, dark);
            adopt_unified_toolbar(ns_window);
            hide_native_window_buttons(ns_window);
            hide_titlebar_decoration(ns_window);
        }
    });
}

/// Re-apply the parts of the chrome a titlebar re-layout can undo.
///
/// The hidden buttons stay hidden across resizes (verified), and appearance,
/// background and toolbar all survive, so this only has to chase the decoration
/// view. It is kept as its own entry point so the resize path stays cheap.
pub(crate) fn reapply_frame_chrome(window: &tauri::Window) {
    let Ok(ptr) = window.ns_window() else { return };
    if ptr.is_null() {
        return;
    }
    guarded(|| {
        // SAFETY: as in `apply`; main-thread AppKit calls on a null-checked window.
        unsafe {
            let ns_window = ptr.cast::<AnyObject>();
            hide_native_window_buttons(ns_window);
            hide_titlebar_decoration(ns_window);
        }
    });
}

/// Run cosmetic chrome work so that a panic inside it can never take the app
/// down.
///
/// This is not paranoia. In debug builds objc2 verifies every message send
/// against the runtime's real signature and panics on a mismatch, and all of
/// this runs from AppKit callbacks (`applicationDidFinishLaunching`, window
/// events) which are `extern "C"`. A panic reaching one of those frames cannot
/// unwind, so the process aborts outright: a one-character encoding mistake in
/// here would otherwise mean the app fails to launch at all. Catching the panic
/// on our side of the boundary downgrades that to slightly wrong window chrome.
fn guarded(work: impl FnOnce()) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)).is_err() {
        eprintln!("[reverie] window chrome could not be applied; leaving system defaults");
    }
}

/// Pin the window to `NSAppearanceNameDarkAqua` / `NSAppearanceNameAqua` so the
/// frame AppKit draws matches the UI inside it.
unsafe fn set_appearance(ns_window: *mut AnyObject, dark: bool) {
    // These constants' values are their own names, so building the NSString
    // directly avoids having to link the AppKit symbols. Built through
    // objc2-foundation rather than `+stringWithUTF8String:` so the argument
    // encoding is the framework's problem, not ours.
    let name = NSString::from_str(if dark {
        "NSAppearanceNameDarkAqua"
    } else {
        "NSAppearanceNameAqua"
    });
    let appearance: *mut AnyObject =
        unsafe { msg_send![class!(NSAppearance), appearanceNamed: &*name] };
    if !appearance.is_null() {
        unsafe {
            let _: () = msg_send![ns_window, setAppearance: appearance];
        }
    }
}

/// Paint the window's own backdrop in the theme's base color, so a live resize
/// that outruns the webview flashes Reverie's surface instead of white.
unsafe fn set_background(ns_window: *mut AnyObject, dark: bool) {
    let (r, g, b) = if dark { DARK_BG } else { LIGHT_BG };
    let color: *mut AnyObject = unsafe {
        msg_send![
            class!(NSColor),
            colorWithCalibratedRed: r,
            green: g,
            blue: b,
            alpha: 1.0f64
        ]
    };
    if !color.is_null() {
        unsafe {
            let _: () = msg_send![ns_window, setBackgroundColor: color];
        }
    }
}

/// Give the window an empty unified toolbar, purely to opt into macOS 26's 26pt
/// window corner radius (see the module docs). Nothing is ever added to it, and
/// with a transparent titlebar and full-size content view it renders nothing:
/// the webview covers the whole frame, including the taller titlebar region.
///
/// Attached only once. Re-attaching on every theme flip would throw away the
/// toolbar AppKit is already laying out.
unsafe fn adopt_unified_toolbar(ns_window: *mut AnyObject) {
    let existing: *mut AnyObject = unsafe { msg_send![ns_window, toolbar] };
    if existing.is_null() {
        let toolbar: Retained<AnyObject> = unsafe { msg_send![class!(NSToolbar), new] };
        unsafe {
            let _: () = msg_send![ns_window, setToolbar: &*toolbar];
        }
    }
    unsafe {
        let _: () = msg_send![ns_window, setToolbarStyle: TOOLBAR_STYLE_UNIFIED];
        // Without this the unified toolbar draws a hairline along its bottom
        // edge, straight across Reverie's chrome.
        let _: () = msg_send![ns_window, setTitlebarSeparatorStyle: TITLEBAR_SEPARATOR_NONE];
    }
}

/// Hide the real traffic lights; Reverie draws its own inside the sidebar panel
/// (`components/chrome/TrafficLights.tsx`), which is the only way to keep them in
/// that position without losing a fight with AppKit's titlebar layout on resize.
unsafe fn hide_native_window_buttons(ns_window: *mut AnyObject) {
    // NSWindowButton: 0 = close, 1 = miniaturize, 2 = zoom.
    for index in 0usize..3 {
        let button: *mut AnyObject = unsafe { msg_send![ns_window, standardWindowButton: index] };
        if !button.is_null() {
            unsafe {
                let _: () = msg_send![button, setHidden: Bool::YES];
            }
        }
    }
}

/// Hide `_NSTitlebarDecorationView`, the light stroke AppKit lays across the top
/// of the titlebar. Matched by class name because the class is private; if a
/// future macOS renames or drops it, this simply finds nothing and does nothing.
unsafe fn hide_titlebar_decoration(ns_window: *mut AnyObject) {
    let Some(container) = (unsafe { titlebar_container(ns_window) }) else {
        return;
    };
    let subviews: *mut AnyObject = unsafe { msg_send![container, subviews] };
    if subviews.is_null() {
        return;
    }
    let count: usize = unsafe { msg_send![subviews, count] };
    for i in 0..count {
        let view: *mut AnyObject = unsafe { msg_send![subviews, objectAtIndex: i] };
        if view.is_null() {
            continue;
        }
        // Read the class through objc2's runtime API rather than messaging
        // `-class` / `-name`: `-class` returns a `Class` (encoded `#`, not `@`),
        // and there is no `-name` method at all (`class_getName` is a C
        // function). objc2 verifies every send against the real signature in
        // debug builds and aborts the process on a mismatch, which is exactly
        // what an earlier version of this loop did at launch.
        let class_name = unsafe { (*view).class().name() };
        if class_name.to_bytes().ends_with(b"TitlebarDecorationView") {
            unsafe {
                let _: () = msg_send![view, setHidden: Bool::YES];
            }
        }
    }
}

/// The `NSTitlebarContainerView` two levels above the close button, which owns
/// both the decoration layer and the button cluster. Reached through the button
/// even though the button is hidden: hiding a view does not unparent it.
unsafe fn titlebar_container(ns_window: *mut AnyObject) -> Option<*mut AnyObject> {
    let close: *mut AnyObject = unsafe { msg_send![ns_window, standardWindowButton: 0usize] };
    if close.is_null() {
        return None;
    }
    let titlebar: *mut AnyObject = unsafe { msg_send![close, superview] };
    if titlebar.is_null() {
        return None;
    }
    let container: *mut AnyObject = unsafe { msg_send![titlebar, superview] };
    if container.is_null() {
        return None;
    }
    Some(container)
}
