//! Folder-identity bookmarks, the seam that lets Reverie follow a project folder
//! when the user renames or moves it on disk.
//!
//! A bookmark is an opaque blob that encodes a folder's stable identity (on
//! macOS: the volume UUID plus the catalog node id), not just its path. We mint
//! one while a folder is known-good and resolve it when the stored path goes
//! missing, so the OS hands back the folder's current location even after a
//! rename or a move within the same volume. The blob lives in Reverie's database,
//! never inside the folder.
//!
//! The trait keeps `reverie-core` platform-agnostic and unit-testable: the real
//! macOS implementation (a small Foundation shim) lives in the desktop crate and
//! is injected at startup, while tests inject a fake. The default
//! [`NoopBookmarkProvider`] simply never resolves, which degrades cleanly to the
//! manual "Locate folder" repair path.

use std::path::{Path, PathBuf};

/// Mints and resolves folder-identity bookmarks. Implementations must be cheap
/// and infallible-by-`Option`: any failure returns `None` so reconciliation
/// falls back to reporting the folder as missing rather than erroring.
pub trait BookmarkProvider: Send + Sync {
    /// Mint a bookmark for an existing folder. Returns `None` if the platform
    /// cannot create one (e.g. the path does not currently exist, or on a
    /// platform without bookmark support).
    fn create(&self, path: &Path) -> Option<Vec<u8>>;

    /// Resolve a bookmark to the folder's current location. Returns `Some` even
    /// when the bookmark is stale (the OS followed the move); returns `None` when
    /// the folder cannot be located (deleted, on an unmounted/cross volume, or an
    /// unparseable blob).
    fn resolve(&self, blob: &[u8]) -> Option<PathBuf>;
}

/// The default provider: never mints, never resolves. Used in `reverie-core`
/// tests and any non-macOS context, so auto-reconnect is simply inert and the
/// product falls back to manual relocation.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopBookmarkProvider;

impl BookmarkProvider for NoopBookmarkProvider {
    fn create(&self, _path: &Path) -> Option<Vec<u8>> {
        None
    }

    fn resolve(&self, _blob: &[u8]) -> Option<PathBuf> {
        None
    }
}
