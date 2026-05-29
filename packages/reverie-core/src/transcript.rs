//! Durable per-session terminal transcript store.
//!
//! The terminal's in-memory scrollback (Ghostty) is bounded and lost on
//! restart. To let users scroll back to the very beginning of a session and
//! search the whole thread, Reverie persists the raw PTY byte stream here as the
//! durable source of truth. Deep history is rendered later by replaying these
//! bytes through a headless terminal (so clears + reflow reproduce exactly).
//!
//! This is an append-only log. A single per-session writer owns the monotonic
//! `seq` and cumulative `byte_offset`, so the store itself stays a thin sink.

use crate::domain::SessionId;
use crate::repository::RepoResult;

pub trait TranscriptStore: Send + Sync {
    /// Append one batch of raw bytes. `seq` is the monotonic chunk index for the
    /// session and `byte_offset` the cumulative byte position at the start of
    /// this batch; the caller (the per-session writer) tracks both.
    fn append_transcript_chunk(
        &self,
        session_id: SessionId,
        seq: u64,
        byte_offset: u64,
        bytes: &[u8],
    ) -> RepoResult<()>;

    /// Total bytes stored for a session (0 if none). Lets a resumed session
    /// continue its transcript where it left off.
    fn transcript_len(&self, session_id: SessionId) -> RepoResult<u64>;

    /// Number of chunks stored for a session (0 if none). Lets a resumed
    /// session continue the monotonic `seq`.
    fn transcript_chunk_count(&self, session_id: SessionId) -> RepoResult<u64>;

    /// Read `len` bytes starting at absolute `start`, spanning chunk boundaries.
    /// Returns fewer bytes only at end-of-transcript. Used by the deep-scroll
    /// replay engine.
    fn read_transcript_range(
        &self,
        session_id: SessionId,
        start: u64,
        len: u64,
    ) -> RepoResult<Vec<u8>>;
}
