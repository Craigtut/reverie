//! Reading an image off the macOS general pasteboard, backing clipboard-image
//! paste into terminals.
//!
//! Wraps the tiny C ABI in `native/reverie_clipboard.m` (AppKit `NSPasteboard`),
//! which normalizes whatever the source put on the pasteboard (PNG, TIFF, or a
//! bare `NSImage`) to PNG bytes. The commands layer writes those bytes to a
//! CLI-readable temp file and hands the CLI a path. Non-macOS builds get a stub
//! that always returns `None`, so the rest of the app compiles unchanged.

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn reverie_clipboard_read_png(out: *mut *mut u8, out_len: *mut usize) -> bool;
    fn reverie_clipboard_free(ptr: *mut u8);
}

/// Read the general pasteboard's current image as PNG bytes, or `None` when the
/// pasteboard holds no image we can turn into a PNG.
#[cfg(target_os = "macos")]
pub fn read_clipboard_png() -> Option<Vec<u8>> {
    let mut out: *mut u8 = std::ptr::null_mut();
    let mut out_len: usize = 0;
    // SAFETY: `out`/`out_len` are valid out-params. On success the shim hands
    // back a malloc'd buffer we copy and then free; on failure it leaves them
    // untouched and returns false.
    let ok = unsafe { reverie_clipboard_read_png(&mut out, &mut out_len) };
    if !ok || out.is_null() {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(out, out_len) }.to_vec();
    unsafe { reverie_clipboard_free(out) };
    if bytes.is_empty() { None } else { Some(bytes) }
}

#[cfg(not(target_os = "macos"))]
pub fn read_clipboard_png() -> Option<Vec<u8>> {
    None
}
