//! Lone / handed modifier "tap" trigger for dispatch (macOS only).
//!
//! `tauri-plugin-global-shortcut` (via `global-hotkey`) cannot register a bare
//! modifier or distinguish left from right: its scancode table has no entry for
//! modifier keys, so a shortcut like "tap right-Control" is impossible there.
//!
//! This installs a passive (listen-only) `CGEventTap` that watches modifier
//! flag changes and fires when the configured modifier is *tapped* alone:
//! pressed and released within a short window with no other key, modifier, or
//! mouse button in between (so holding Control for Control+C never triggers).
//! Requires the macOS "Input Monitoring" permission; until it is granted,
//! `CGEventTapCreate` returns null and we report the tap unavailable.
//!
//! The shortcut string distinguishes the two trigger kinds: a tap spec is
//! `"tap:<Modifier>[Left|Right]"` (e.g. `"tap:ControlRight"`, `"tap:Command"`),
//! anything else is a regular accelerator handled by the plugin.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

use core_foundation::runloop::{CFRunLoop, kCFRunLoopCommonModes, kCFRunLoopDefaultMode};
use core_graphics::event::{
    CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventType, CallbackResult, EventField,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

/// A tap must complete (press → release) within this window to count, so a held
/// modifier (the start of a chord, or just resting on the key) never fires.
const TAP_MAX: Duration = Duration::from_millis(450);

// Input Monitoring (TCC kTCCServiceListenEvent) gating for the event tap.
// `CGPreflightListenEventAccess` checks the current grant; `CGRequestListenEventAccess`
// shows the system permission prompt the first time and returns the status.
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
}

fn has_listen_access() -> bool {
    unsafe { CGPreflightListenEventAccess() }
}

/// Trigger the macOS Input Monitoring prompt (first time only); returns the
/// current grant. The grant typically only takes effect after a relaunch.
pub(crate) fn request_listen_access() -> bool {
    unsafe { CGRequestListenEventAccess() }
}

/// Which physical modifier to watch and the device-independent flag that marks
/// it pressed. Up to two keycodes cover the "either side" case.
#[derive(Clone, Copy)]
pub(crate) struct TapConfig {
    flag: CGEventFlags,
    keycodes: [i64; 2],
    keycode_count: usize,
}

impl TapConfig {
    fn matches(&self, keycode: i64) -> bool {
        self.keycodes[..self.keycode_count].contains(&keycode)
    }
}

/// Parse a stored dispatch shortcut into a tap config, or `None` if it is a
/// regular accelerator. Format: `tap:Control`, `tap:ControlRight`,
/// `tap:CommandLeft`, `tap:Fn`, ...
pub(crate) fn parse_tap_spec(spec: &str) -> Option<TapConfig> {
    let rest = spec.strip_prefix("tap:")?;
    let (base, side) = if let Some(base) = rest.strip_suffix("Right") {
        (base, Some(Side::Right))
    } else if let Some(base) = rest.strip_suffix("Left") {
        (base, Some(Side::Left))
    } else {
        (rest, None)
    };
    // (flag, left keycode, right keycode)
    let (flag, left, right) = match base {
        "Control" => (CGEventFlags::CGEventFlagControl, 0x3B, 0x3E),
        "Shift" => (CGEventFlags::CGEventFlagShift, 0x38, 0x3C),
        "Alt" | "Option" => (CGEventFlags::CGEventFlagAlternate, 0x3A, 0x3D),
        "Command" | "Super" => (CGEventFlags::CGEventFlagCommand, 0x37, 0x36),
        "Fn" => (CGEventFlags::CGEventFlagSecondaryFn, 0x3F, 0x3F),
        _ => return None,
    };
    let (keycodes, keycode_count) = match (base, side) {
        ("Fn", _) => ([0x3F, 0], 1),
        (_, Some(Side::Right)) => ([right, 0], 1),
        (_, Some(Side::Left)) => ([left, 0], 1),
        (_, None) => ([left, right], 2),
    };
    Some(TapConfig {
        flag,
        keycodes,
        keycode_count,
    })
}

enum Side {
    Left,
    Right,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TapStatus {
    available: bool,
}

#[derive(Default)]
struct Detect {
    armed_at: Option<Instant>,
    interrupted: bool,
}

struct Shared {
    config: Mutex<Option<TapConfig>>,
    detect: Mutex<Detect>,
    running: AtomicBool,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            config: Mutex::new(None),
            detect: Mutex::new(Detect::default()),
            running: AtomicBool::new(false),
        }
    }
}

/// Managed state for the modifier-tap trigger. The run-loop thread is spawned
/// lazily on the first tap shortcut (so users who never use one are never asked
/// for Input Monitoring) and then lives for the process; switching to a regular
/// shortcut just clears the config and the callback goes inert.
#[derive(Default)]
pub(crate) struct ModifierTap {
    shared: Arc<Shared>,
}

impl ModifierTap {
    /// Point the tap at the modifier in `spec` (a `tap:` spec), or make it inert
    /// (`spec` is a regular accelerator). Spawns the listener thread on first use.
    pub(crate) fn configure<R: Runtime>(&self, app: &AppHandle<R>, spec: &str) {
        let config = parse_tap_spec(spec);
        *self.shared.config.lock().unwrap() = config;
        *self.shared.detect.lock().unwrap() = Detect::default();
        if config.is_some() && !self.shared.running.swap(true, Ordering::SeqCst) {
            self.spawn(app.clone());
        }
    }

    fn spawn<R: Runtime>(&self, app: AppHandle<R>) {
        let shared = self.shared.clone();
        if let Err(error) = thread::Builder::new()
            .name("reverie-dispatch-tap".to_owned())
            .spawn(move || run_tap_loop(shared, app))
        {
            eprintln!("[reverie] failed to spawn dispatch modifier-tap thread: {error}");
        }
    }
}

fn run_tap_loop<R: Runtime>(shared: Arc<Shared>, app: AppHandle<R>) {
    // Without Input Monitoring, CGEventTapCreate returns null. Trigger the system
    // prompt up front (so setting a tap shortcut asks for permission) and report
    // unavailable; the settings UI links to System Settings.
    if !has_listen_access() {
        request_listen_access();
        shared.running.store(false, Ordering::SeqCst);
        let _ = app.emit("dispatch_tap_status", TapStatus { available: false });
        eprintln!(
            "[reverie] dispatch modifier-tap needs \u{201c}Input Monitoring\u{201d}; prompting (grant, then relaunch Reverie)"
        );
        return;
    }

    let cb_shared = shared.clone();
    let cb_app = app.clone();
    let tap = CGEventTap::new(
        CGEventTapLocation::Session,
        CGEventTapPlacement::HeadInsertEventTap,
        CGEventTapOptions::ListenOnly,
        vec![
            CGEventType::FlagsChanged,
            CGEventType::KeyDown,
            CGEventType::LeftMouseDown,
            CGEventType::RightMouseDown,
            CGEventType::OtherMouseDown,
        ],
        move |_proxy, etype, event| {
            handle_event(&cb_shared, &cb_app, etype, event);
            CallbackResult::Keep
        },
    );

    let tap = match tap {
        Ok(tap) => tap,
        Err(()) => {
            shared.running.store(false, Ordering::SeqCst);
            let _ = app.emit("dispatch_tap_status", TapStatus { available: false });
            eprintln!(
                "[reverie] dispatch modifier-tap unavailable: grant Reverie \u{201c}Input Monitoring\u{201d} in System Settings \u{2192} Privacy & Security."
            );
            return;
        }
    };

    let source = match tap.mach_port().create_runloop_source(0) {
        Ok(source) => source,
        Err(()) => {
            shared.running.store(false, Ordering::SeqCst);
            eprintln!("[reverie] dispatch modifier-tap: run loop source creation failed");
            return;
        }
    };
    CFRunLoop::get_current().add_source(&source, unsafe { kCFRunLoopCommonModes });
    tap.enable();
    let _ = app.emit("dispatch_tap_status", TapStatus { available: true });

    // The tap lives for the process; the callback goes inert when no tap
    // shortcut is configured. Run the loop in slices so the thread stays
    // responsive (and the tap drop on process exit is the only teardown).
    loop {
        let _ = CFRunLoop::run_in_mode(
            unsafe { kCFRunLoopDefaultMode },
            Duration::from_millis(500),
            false,
        );
    }
}

fn handle_event<R: Runtime>(
    shared: &Arc<Shared>,
    app: &AppHandle<R>,
    etype: CGEventType,
    event: &core_graphics::event::CGEvent,
) {
    let Some(config) = *shared.config.lock().unwrap() else {
        return;
    };
    let mut fire = false;
    {
        let mut detect = shared.detect.lock().unwrap();
        match etype {
            CGEventType::FlagsChanged => {
                let keycode = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                if config.matches(keycode) {
                    let down = event.get_flags().contains(config.flag);
                    if down {
                        // A fresh press arms a tap; a second target-down means a
                        // double-modifier, not a clean tap.
                        if detect.armed_at.is_some() {
                            detect.interrupted = true;
                        } else {
                            detect.armed_at = Some(Instant::now());
                            detect.interrupted = false;
                        }
                    } else if let Some(armed_at) = detect.armed_at.take() {
                        fire = !detect.interrupted && armed_at.elapsed() <= TAP_MAX;
                        detect.interrupted = false;
                    }
                } else if detect.armed_at.is_some() {
                    // Another modifier moved while ours was held: that's a chord.
                    detect.interrupted = true;
                }
            }
            // Any key or mouse press during the hold means it was not a lone tap.
            CGEventType::KeyDown
            | CGEventType::LeftMouseDown
            | CGEventType::RightMouseDown
            | CGEventType::OtherMouseDown => {
                if detect.armed_at.is_some() {
                    detect.interrupted = true;
                }
            }
            _ => {}
        }
    }
    if fire {
        trigger(app);
    }
}

fn trigger<R: Runtime>(app: &AppHandle<R>) {
    let app_for_main = app.clone();
    // Window show/hide must run on the main thread; the tap callback is on its
    // own run-loop thread.
    let _ = app.run_on_main_thread(move || {
        crate::dispatch::toggle_dispatch_window(&app_for_main);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_handed_and_either_side_specs() {
        assert!(parse_tap_spec("CommandOrControl+Shift+Space").is_none());
        let right = parse_tap_spec("tap:ControlRight").unwrap();
        assert_eq!(right.keycode_count, 1);
        assert!(right.matches(0x3E));
        assert!(!right.matches(0x3B));

        let either = parse_tap_spec("tap:Control").unwrap();
        assert_eq!(either.keycode_count, 2);
        assert!(either.matches(0x3B) && either.matches(0x3E));

        let fnkey = parse_tap_spec("tap:Fn").unwrap();
        assert!(fnkey.matches(0x3F));
    }
}
