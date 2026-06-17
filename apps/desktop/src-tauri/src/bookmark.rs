//! macOS folder-identity bookmarks backing project auto-reconnect.
//!
//! Wraps the tiny C ABI in `native/reverie_bookmark.m` (Foundation `NSURL`
//! bookmarks) as a [`BookmarkProvider`], which the workspace service uses to mint
//! a bookmark when a project folder is known-good and to relocate it after a
//! rename or move. The blob is opaque and lives only in Reverie's database.

use std::ffi::{CString, OsString, c_char};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

use reverie_core::BookmarkProvider;

unsafe extern "C" {
    fn reverie_bookmark_create(path: *const c_char, out: *mut *mut u8, out_len: *mut usize)
    -> bool;
    fn reverie_bookmark_resolve(
        data: *const u8,
        len: usize,
        out_path: *mut c_char,
        out_cap: usize,
        is_stale: *mut bool,
    ) -> bool;
    fn reverie_bookmark_free(ptr: *mut u8);
}

/// The real provider, over Foundation `NSURL` bookmarks. Plain (non
/// -security-scoped): Reverie is not sandboxed, so no entitlement is needed.
pub struct MacBookmarkProvider;

impl BookmarkProvider for MacBookmarkProvider {
    fn create(&self, path: &Path) -> Option<Vec<u8>> {
        let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut out: *mut u8 = std::ptr::null_mut();
        let mut out_len: usize = 0;
        // SAFETY: `c_path` is a valid NUL-terminated string; `out`/`out_len` are
        // valid out-params. On success the shim hands back a malloc'd buffer we
        // copy and then free; on failure it leaves them untouched.
        let ok = unsafe { reverie_bookmark_create(c_path.as_ptr(), &mut out, &mut out_len) };
        if !ok || out.is_null() {
            return None;
        }
        let bytes = unsafe { std::slice::from_raw_parts(out, out_len) }.to_vec();
        unsafe { reverie_bookmark_free(out) };
        Some(bytes)
    }

    fn resolve(&self, blob: &[u8]) -> Option<PathBuf> {
        if blob.is_empty() {
            return None;
        }
        // Generous fixed buffer: macOS paths are bounded well under this.
        let mut buf = vec![0u8; 8192];
        let mut is_stale = false;
        // SAFETY: `blob` is a valid slice; `buf` is a valid, sufficiently sized
        // output buffer; the shim writes a NUL-terminated path within `out_cap`.
        let ok = unsafe {
            reverie_bookmark_resolve(
                blob.as_ptr(),
                blob.len(),
                buf.as_mut_ptr() as *mut c_char,
                buf.len(),
                &mut is_stale,
            )
        };
        if !ok {
            return None;
        }
        let nul = buf.iter().position(|&b| b == 0)?;
        buf.truncate(nul);
        Some(PathBuf::from(OsString::from_vec(buf)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_then_resolve_follows_a_rename() {
        let root = tempfile::TempDir::new().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        std::fs::create_dir(&old).unwrap();

        let provider = MacBookmarkProvider;
        let blob = provider
            .create(&old)
            .expect("mint a bookmark for an existing dir");

        // Rename the folder on disk; the bookmark should still resolve to it.
        std::fs::rename(&old, &new).unwrap();
        let resolved = provider.resolve(&blob).expect("resolve after rename");

        // Compare canonically: NSURL may hand back a /private-prefixed temp path.
        assert_eq!(
            std::fs::canonicalize(&resolved).unwrap(),
            std::fs::canonicalize(&new).unwrap(),
        );
    }

    #[test]
    fn resolve_rejects_garbage() {
        let provider = MacBookmarkProvider;
        assert!(provider.resolve(&[]).is_none());
        assert!(provider.resolve(&[0xde, 0xad, 0xbe, 0xef]).is_none());
    }
}
