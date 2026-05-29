//! Deep-history rendering by replaying the durable transcript.
//!
//! Ghostty's in-memory scrollback is bounded and lost on restart, and
//! libghostty-vt cannot serialize/restore VT state. So to render rows older than
//! the live buffer (or any rows after a restart), we replay the durable raw-byte
//! transcript (captured in `transcript.rs`) through a fresh, headless
//! `GhosttyTerminalState` sized to hold the whole session, then extract the
//! requested window. Replaying the exact bytes reproduces clears and reflow for
//! free, and reuses the same frame extraction as the live terminal, so deep rows
//! render identically to live ones.
//!
//! v1 replays the whole transcript per request. That is correct and simple;
//! checkpoint-anchored partial replay is the planned optimization for very large
//! transcripts.

use anyhow::Result;
use reverie_core::terminal::TerminalFrame;

use crate::terminal::ghostty::GhosttyTerminalState;

// Headroom for the replay buffer. Ghostty allocates rows on demand, so this
// caps memory at a few million rows rather than reserving them. Sessions longer
// than this lose their oldest rows from deep scroll (still in the raw log).
const HISTORY_MAX_SCROLLBACK: usize = 5_000_000;

/// The full rendered height of the transcript at the given width.
pub fn history_total_rows(transcript: &[u8], cols: u16, rows: u16) -> Result<usize> {
    let mut state = GhosttyTerminalState::new(cols, rows.max(1), HISTORY_MAX_SCROLLBACK)?;
    if !transcript.is_empty() {
        state.write(transcript);
    }
    state.total_rows()
}

/// Render the window of `rows` rows starting at absolute `start_row`, by
/// replaying the transcript at `cols` width and scrolling the headless viewport
/// to `start_row`. The returned frame's rows are viewport-local (0..rows); the
/// caller offsets them by `start_row` to place them in the composite.
pub fn history_window(
    transcript: &[u8],
    cols: u16,
    rows: u16,
    start_row: usize,
) -> Result<TerminalFrame> {
    let mut state = GhosttyTerminalState::new(cols, rows.max(1), HISTORY_MAX_SCROLLBACK)?;
    if !transcript.is_empty() {
        state.write(transcript);
    }
    state.scroll_to_row(start_row)?;
    state.frame()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row_text(frame: &TerminalFrame, index: u16) -> String {
        frame
            .rows
            .iter()
            .find(|row| row.index == index)
            .map(|row| {
                let mut cells = row.cells.clone();
                cells.sort_by_key(|cell| cell.col);
                cells
                    .iter()
                    .map(|cell| cell.text.as_str())
                    .collect::<String>()
            })
            .unwrap_or_default()
    }

    fn numbered_lines(count: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        for index in 0..count {
            bytes.extend_from_slice(format!("line{index}\r\n").as_bytes());
        }
        bytes
    }

    #[test]
    fn replays_transcript_and_extracts_the_first_window() {
        let transcript = numbered_lines(60);
        let total = history_total_rows(&transcript, 80, 24).unwrap();
        assert!(
            total >= 60,
            "expected at least 60 rendered rows, got {total}"
        );

        // The window at the very beginning starts with the first line.
        let frame = history_window(&transcript, 80, 24, 0).unwrap();
        assert!(
            row_text(&frame, 0).starts_with("line0"),
            "row 0 was {:?}",
            row_text(&frame, 0)
        );
    }

    #[test]
    fn empty_transcript_reports_viewport_rows() {
        assert!(history_total_rows(&[], 80, 24).unwrap() >= 1);
        let frame = history_window(&[], 80, 24, 0).unwrap();
        assert!(row_text(&frame, 0).trim().is_empty());
    }
}
