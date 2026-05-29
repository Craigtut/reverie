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
    /// Start a writer for `session_id`, continuing the transcript where any
    /// prior run left off (so a resumed session appends rather than overwrites).
    pub fn spawn(store: Arc<dyn TranscriptStore>, session_id: SessionId) -> Result<Self> {
        let mut byte_offset = store.transcript_len(session_id)?;
        let mut seq = store.transcript_chunk_count(session_id)?;
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let handle = thread::Builder::new()
            .name("reverie-transcript-writer".to_owned())
            .spawn(move || {
                let mut buffer: Vec<u8> = Vec::with_capacity(FLUSH_BYTES);
                loop {
                    match rx.recv_timeout(FLUSH_INTERVAL) {
                        Ok(chunk) => {
                            buffer.extend_from_slice(&chunk);
                            if buffer.len() >= FLUSH_BYTES {
                                flush(&store, session_id, &mut buffer, &mut seq, &mut byte_offset);
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            flush(&store, session_id, &mut buffer, &mut seq, &mut byte_offset);
                        }
                        Err(RecvTimeoutError::Disconnected) => {
                            flush(&store, session_id, &mut buffer, &mut seq, &mut byte_offset);
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
    buffer: &mut Vec<u8>,
    seq: &mut u64,
    byte_offset: &mut u64,
) {
    if buffer.is_empty() {
        return;
    }
    match store.append_transcript_chunk(session_id, *seq, *byte_offset, buffer) {
        Ok(()) => {
            *byte_offset += buffer.len() as u64;
            *seq += 1;
        }
        Err(err) => eprintln!("[reverie] transcript append failed: {err}"),
    }
    buffer.clear();
}
