//! Local power-source status for battery-aware runtime policy.
//!
//! Keep-awake remains an explicit user setting. This module is for softer energy
//! choices such as how quickly to park idle background sessions and how much UI
//! animation to run while the machine is on battery.

#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PowerStatus {
    pub on_battery: bool,
}

pub(crate) fn current_power_status() -> PowerStatus {
    PowerStatus {
        on_battery: platform_on_battery().unwrap_or(false),
    }
}

#[cfg(target_os = "macos")]
fn platform_on_battery() -> Option<bool> {
    macos::on_battery()
}

#[cfg(not(target_os = "macos"))]
fn platform_on_battery() -> Option<bool> {
    None
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::CStr;
    use std::os::raw::{c_char, c_void};

    const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPSCopyPowerSourcesInfo() -> CFTypeRef;
        fn IOPSGetProvidingPowerSourceType(blob: CFTypeRef) -> CFStringRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(cf: CFTypeRef);
        fn CFStringGetCString(
            the_string: CFStringRef,
            buffer: *mut c_char,
            buffer_size: isize,
            encoding: u32,
        ) -> u8;
    }

    pub(super) fn on_battery() -> Option<bool> {
        let blob = unsafe { IOPSCopyPowerSourcesInfo() };
        if blob.is_null() {
            return None;
        }

        let source = unsafe { IOPSGetProvidingPowerSourceType(blob) };
        let source = cf_string(source);
        unsafe { CFRelease(blob) };

        match source.as_deref() {
            Some("Battery Power") => Some(true),
            Some("AC Power" | "UPS Power") => Some(false),
            _ => None,
        }
    }

    fn cf_string(value: CFStringRef) -> Option<String> {
        if value.is_null() {
            return None;
        }
        let mut buffer = [0 as c_char; 128];
        let ok = unsafe {
            CFStringGetCString(
                value,
                buffer.as_mut_ptr(),
                buffer.len() as isize,
                CF_STRING_ENCODING_UTF8,
            )
        } != 0;
        if !ok {
            return None;
        }
        Some(
            unsafe { CStr::from_ptr(buffer.as_ptr()) }
                .to_string_lossy()
                .into_owned(),
        )
    }
}
