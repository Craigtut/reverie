//! Per-session transcript writer.
//!
//! Captures the raw PTY byte stream into the durable [`TranscriptStore`] without
//! slowing the hot terminal worker loop: the loop only `send`s chunks to a
//! dedicated writer thread, which batches them (by size or a short interval)
//! into one SQLite append per flush. Dropping the writer flushes any buffered
//! tail and joins the thread, so an exiting/erroring session still persists its
//! last bytes.

use std::sync::Arc;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use anyhow::Result;
use reverie_core::domain::SessionId;
use reverie_core::transcript::TranscriptStore;

// Flush when the buffer reaches this size...
const FLUSH_BYTES: usize = 64 * 1024;
// ...or after this long with anything buffered, so a quiet session still
// persists promptly without fsync-per-chunk on the hot path.
const FLUSH_INTERVAL: Duration = Duration::from_millis(250);

pub struct TranscriptWriter {
    tx: Option<Sender<Vec<u8>>>,
    handle: Option<JoinHandle<()>>,
}

impl TranscriptWriter {
    /// Start a writer for `session_id`, appending a new fresh-PTY run when any
    /// prior transcript exists. Deep-history replay stitches runs as separate
    /// terminal instances, so resumed sessions do not inherit stale VT state.
    pub fn spawn(store: Arc<dyn TranscriptStore>, session_id: SessionId) -> Result<Self> {
        let mut byte_offset = store.transcript_len(session_id)?;
        let mut seq = store.transcript_chunk_count(session_id)?;
        let run_index = if byte_offset == 0 {
            0
        } else {
            store.transcript_run_count(session_id)?
        };
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let handle = thread::Builder::new()
            .name("reverie-transcript-writer".to_owned())
            .spawn(move || {
                let mut buffer: Vec<u8> = Vec::with_capacity(FLUSH_BYTES);
                let mut failures: u32 = 0;
                loop {
                    match rx.recv_timeout(FLUSH_INTERVAL) {
                        Ok(chunk) => {
                            buffer.extend_from_slice(&chunk);
                            if buffer.len() >= FLUSH_BYTES {
                                flush(
                                    &store,
                                    session_id,
                                    run_index,
                                    &mut buffer,
                                    &mut seq,
                                    &mut byte_offset,
                                    &mut failures,
                                );
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            flush(
                                &store,
                                session_id,
                                run_index,
                                &mut buffer,
                                &mut seq,
                                &mut byte_offset,
                                &mut failures,
                            );
                        }
                        Err(RecvTimeoutError::Disconnected) => {
                            flush(
                                &store,
                                session_id,
                                run_index,
                                &mut buffer,
                                &mut seq,
                                &mut byte_offset,
                                &mut failures,
                            );
                            break;
                        }
                    }
                }
            })?;
        Ok(Self {
            tx: Some(tx),
            handle: Some(handle),
        })
    }

    /// Hand a chunk of raw PTY bytes to the writer thread. Non-blocking.
    pub fn append(&self, bytes: Vec<u8>) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(bytes);
        }
    }
}

impl Drop for TranscriptWriter {
    fn drop(&mut self) {
        // Close the channel so the thread flushes its tail and exits, then join.
        self.tx.take();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn flush(
    store: &Arc<dyn TranscriptStore>,
    session_id: SessionId,
    run_index: u64,
    buffer: &mut Vec<u8>,
    seq: &mut u64,
    byte_offset: &mut u64,
    consecutive_failures: &mut u32,
) {
    if buffer.is_empty() {
        return;
    }
    match store.append_transcript_chunk(session_id, run_index, *seq, *byte_offset, buffer) {
        Ok(()) => {
            *byte_offset += buffer.len() as u64;
            *seq += 1;
            *consecutive_failures = 0;
        }
        Err(err) => {
            // An append can fail because our cached `seq`/`byte_offset` drifted
            // from what is actually stored (e.g. a second writer briefly raced
            // this session and claimed the same `seq`). Retrying the same key
            // would just collide forever, so re-derive the next slot from the
            // store, which is authoritative, and let the next flush continue.
            // Log only the first failure in a run so a persistent error can
            // never flood the console the way an un-resynced collision did.
            if *consecutive_failures == 0 {
                eprintln!("[reverie] transcript append failed; resyncing from store: {err}");
            }
            *consecutive_failures = consecutive_failures.saturating_add(1);
            if let (Ok(len), Ok(count)) = (
                store.transcript_len(session_id),
                store.transcript_chunk_count(session_id),
            ) {
                *byte_offset = len;
                *seq = count;
            }
        }
    }
    buffer.clear();
}
