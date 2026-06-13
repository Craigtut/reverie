//! macOS keep-awake: hold IOKit power assertions while agent tasks are running.
//!
//! Reverie runs long agent sessions the user can walk away from. When the
//! workspace's keep-awake toggle is on and at least one session is alive, we
//! hold a `PreventUserIdleSystemSleep` assertion so the Mac does not idle-sleep
//! and the tasks keep running. The optional display sub-toggle additionally
//! holds `PreventUserIdleDisplaySleep` to keep the screen on instead of letting
//! it sleep.
//!
//! Assertions are reference-counted, need no admin rights or entitlements, and
//! auto-clear if the process exits. Inspect live ones with `pmset -g assertions`.
//! They cannot keep the Mac awake when the lid is physically shut on battery
//! (a hardware sleep event, not idle); the UI states that limit plainly. The
//! Apple-supported clamshell case (lid shut + external display + power) keeps
//! running, and these assertions hold through its idle stretches.
//!
//! This is the only place that touches platform power management, keeping the
//! terminal runtime and domain free of it. The desktop shell reconciles the
//! assertions from session-lifecycle events; see `reconcile_keep_awake` in
//! `main.rs`.

use std::sync::Mutex;

/// The two assertion types we hold, by their IOKit string names. Passed to the
/// platform layer on every reconcile; ignored off macOS.
const ASSERT_PREVENT_IDLE_SYSTEM_SLEEP: &str = "PreventUserIdleSystemSleep";
const ASSERT_PREVENT_IDLE_DISPLAY_SLEEP: &str = "PreventUserIdleDisplaySleep";

#[derive(Default)]
struct AssertionState {
    /// Live assertion ids; 0 means "no assertion currently held".
    system: u32,
    display: u32,
}

/// Tauri-managed owner of the live power assertions. Reconcile it from
/// session-lifecycle events and the settings toggle; every entry point is
/// idempotent, so duplicate or out-of-order calls are safe.
#[derive(Default)]
pub struct KeepAwakeManager {
    state: Mutex<AssertionState>,
}

impl KeepAwakeManager {
    /// Bring the held assertions in line with the desired state. `enabled` is the
    /// user's primary toggle, `keep_display` the screen-on sub-toggle, and
    /// `has_live_session` whether any agent session is currently alive. Holds the
    /// system-sleep assertion only when enabled AND a session is live; adds the
    /// display assertion only when the sub-toggle is also on. Releases otherwise.
    pub fn reconcile(&self, enabled: bool, keep_display: bool, has_live_session: bool) {
        let want_system = enabled && has_live_session;
        let want_display = want_system && keep_display;
        let mut state = self.lock();
        set_assertion(
            &mut state.system,
            want_system,
            ASSERT_PREVENT_IDLE_SYSTEM_SLEEP,
        );
        set_assertion(
            &mut state.display,
            want_display,
            ASSERT_PREVENT_IDLE_DISPLAY_SLEEP,
        );
    }

    /// Drop every held assertion (app shutdown). Safe to call repeatedly; the OS
    /// also auto-clears assertions when the process exits, so this is a tidy
    /// belt-and-suspenders for a clean quit.
    pub fn release_all(&self) {
        let mut state = self.lock();
        set_assertion(&mut state.system, false, ASSERT_PREVENT_IDLE_SYSTEM_SLEEP);
        set_assertion(&mut state.display, false, ASSERT_PREVENT_IDLE_DISPLAY_SLEEP);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, AssertionState> {
        // A poisoned lock only means a previous holder panicked; the assertion
        // ids are still valid, so recover rather than propagate the panic.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Create or release a single assertion so `current` (0 = none) matches `want`.
/// Idempotent: no-op when already in the desired state.
#[cfg(target_os = "macos")]
fn set_assertion(current: &mut u32, want: bool, assertion_type: &str) {
    match (want, *current) {
        (true, 0) => {
            if let Some(id) = macos::create_assertion(assertion_type) {
                *current = id;
            }
        }
        (false, id) if id != 0 => {
            macos::release_assertion(id);
            *current = 0;
        }
        _ => {}
    }
}

/// Off macOS there is no IOKit; keep-awake is a no-op so the workspace still
/// builds. Reverie ships macOS-only, so this path is never exercised in product.
#[cfg(not(target_os = "macos"))]
fn set_assertion(_current: &mut u32, _want: bool, _assertion_type: &str) {}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_void};

    /// Assertion name shown in `pmset -g assertions` so the source is obvious.
    const ASSERTION_NAME: &str = "Reverie keeping agent tasks running";
    /// `kIOPMAssertionLevelOn`.
    const ASSERTION_LEVEL_ON: u32 = 255;
    /// `kCFStringEncodingUTF8`.
    const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    /// `kIOReturnSuccess`.
    const IO_RETURN_SUCCESS: i32 = 0;

    type CFStringRef = *const c_void;
    type IOPMAssertionID = u32;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFRelease(cf: *const c_void);
    }

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            assertion_level: u32,
            assertion_name: CFStringRef,
            assertion_id: *mut IOPMAssertionID,
        ) -> i32;
        fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> i32;
    }

    /// Create a named assertion of `assertion_type`. Returns its id, or `None` if
    /// the OS refused (the caller then simply holds nothing).
    pub(super) fn create_assertion(assertion_type: &str) -> Option<IOPMAssertionID> {
        let type_c = CString::new(assertion_type).ok()?;
        let name_c = CString::new(ASSERTION_NAME).ok()?;
        unsafe {
            let type_str = CFStringCreateWithCString(
                std::ptr::null(),
                type_c.as_ptr(),
                CF_STRING_ENCODING_UTF8,
            );
            let name_str = CFStringCreateWithCString(
                std::ptr::null(),
                name_c.as_ptr(),
                CF_STRING_ENCODING_UTF8,
            );
            let result = if type_str.is_null() || name_str.is_null() {
                None
            } else {
                let mut id: IOPMAssertionID = 0;
                let ret =
                    IOPMAssertionCreateWithName(type_str, ASSERTION_LEVEL_ON, name_str, &mut id);
                (ret == IO_RETURN_SUCCESS && id != 0).then_some(id)
            };
            if !type_str.is_null() {
                CFRelease(type_str);
            }
            if !name_str.is_null() {
                CFRelease(name_str);
            }
            result
        }
    }

    pub(super) fn release_assertion(id: IOPMAssertionID) {
        unsafe {
            IOPMAssertionRelease(id);
        }
    }
}
