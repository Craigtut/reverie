//! Deep-history rendering by replaying the durable transcript.
//!
//! Ghostty's in-memory scrollback is bounded and lost on restart, and
//! libghostty-vt cannot serialize/restore VT state. So to render rows older than
//! the live buffer (or any rows after a restart), we replay the durable raw-byte
//! transcript (captured in `transcript.rs`) through a fresh, headless
//! `GhosttyTerminalState` sized to the real terminal surface, then extract the
//! requested window. That surface height is part of VT correctness: Ink-style
//! TUIs use cursor movement, scroll regions, and wrapping that change if replay
//! runs in a taller cache window. Larger frontend history windows are stitched
//! from multiple exact-height viewport snapshots after replay, so deep rows keep
//! live-terminal semantics.
//!
//! Cache misses still replay the whole transcript, which is correct and simple.
//! Callers can request wider prefetch windows so smooth scroll does not force a
//! replay every few rows. Checkpoint-anchored partial replay is the planned
//! optimization for very large transcripts.

use anyhow::Result;
use std::collections::BTreeMap;

use reverie_core::terminal::{
    TerminalCursor, TerminalCursorStyle, TerminalFrame, TerminalPosition, TerminalRow,
};

use crate::terminal::ghostty::GhosttyTerminalState;
use crate::terminal::runtime::TerminalThemeColors;

// Headroom for the replay buffer. Ghostty's `max_scrollback` is a byte budget,
// not a row budget. It allocates pages on demand, so this caps one replay at a
// few hundred MB rather than reserving it up front. Sessions longer than this
// still need checkpointed replay to expose the very oldest rows.
const HISTORY_MAX_SCROLLBACK_BYTES: usize = 256 * 1024 * 1024;
const CLAUDE_FRESH_LAUNCH_MARKER: &[u8] = b"\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?25l\x1b[?2004h\x1b[?1004h\x1b[?2031h\x1b[>0q\x1b[c\x1b[?2026$p\x1b[c\x1b]0;";

/// The full rendered height of the transcript at the given width. Colors do not
/// affect row count, so this path needs no theme.
pub fn history_total_rows(transcript: &[u8], cols: u16, rows: u16) -> Result<usize> {
    let mut state = GhosttyTerminalState::new(cols, rows.max(1), HISTORY_MAX_SCROLLBACK_BYTES)?;
    if !transcript.is_empty() {
        state.write(transcript);
    }
    state.total_rows()
}

/// The full rendered height of transcript segments, where each segment is one
/// fresh PTY launch. This prevents resumed sessions from carrying VT state from
/// an older launch into the replay of a later launch.
pub fn history_total_rows_segments(transcripts: &[Vec<u8>], cols: u16, rows: u16) -> Result<usize> {
    Ok(history_segment_row_counts(transcripts, cols, rows)?
        .into_iter()
        .fold(0_usize, |total, rows| total.saturating_add(rows.max(1)))
        .max(1))
}

pub fn history_segment_row_counts(
    transcripts: &[Vec<u8>],
    cols: u16,
    rows: u16,
) -> Result<Vec<usize>> {
    let transcripts = replay_segments(transcripts);
    if transcripts.is_empty() {
        return Ok(vec![history_total_rows(&[], cols, rows)?.max(1)]);
    }

    transcripts
        .iter()
        .map(|transcript| history_total_rows(transcript, cols, rows).map(|rows| rows.max(1)))
        .collect()
}

/// Render a window starting at absolute `start_row`, by replaying the transcript
/// at the real surface size and scrolling the headless viewport through enough
/// exact-height snapshots to collect `row_count` rows. The returned frame's rows
/// are viewport-local (0..row_count); the caller offsets them by `start_row` to
/// place them in the composite.
pub fn history_window(
    transcript: &[u8],
    cols: u16,
    surface_rows: u16,
    start_row: usize,
    row_count: u16,
    colors: TerminalThemeColors,
) -> Result<TerminalFrame> {
    history_window_prefetched(
        transcript,
        cols,
        surface_rows,
        start_row,
        row_count,
        row_count,
        colors,
    )
}

/// Render a history window with additional surrounding rows. Replay still uses
/// the real terminal surface height; only the extracted scroll window grows.
pub fn history_window_prefetched(
    transcript: &[u8],
    cols: u16,
    surface_rows: u16,
    start_row: usize,
    row_count: u16,
    min_row_count: u16,
    colors: TerminalThemeColors,
) -> Result<TerminalFrame> {
    let mut state =
        GhosttyTerminalState::new(cols, surface_rows.max(1), HISTORY_MAX_SCROLLBACK_BYTES)?;
    // Seed the theme's default colors before replay so deep-history rows render
    // with the same fg/bg as the live terminal (a transcript that set its own
    // OSC 10/11 still wins, replayed after).
    state.set_default_colors(colors.foreground, colors.background);
    if !transcript.is_empty() {
        state.write(transcript);
    }
    let total_rows = state.total_rows()?.max(1);
    let (window_start, window_rows) =
        plan_prefetch_window(start_row, row_count, min_row_count, total_rows);
    collect_history_window(&mut state, window_start, window_rows)
}

/// Render a history window across fresh-PTY transcript segments. Each segment is
/// replayed in a new Ghostty state, then rows are stitched into one absolute
/// history coordinate space for the frontend cache.
pub fn history_window_segments(
    transcripts: &[Vec<u8>],
    cols: u16,
    surface_rows: u16,
    start_row: usize,
    row_count: u16,
    colors: TerminalThemeColors,
) -> Result<TerminalFrame> {
    history_window_segments_prefetched(
        transcripts,
        cols,
        surface_rows,
        start_row,
        row_count,
        row_count,
        colors,
    )
}

/// Render a prefetch history window across fresh-PTY transcript segments.
pub fn history_window_segments_prefetched(
    transcripts: &[Vec<u8>],
    cols: u16,
    surface_rows: u16,
    start_row: usize,
    row_count: u16,
    min_row_count: u16,
    colors: TerminalThemeColors,
) -> Result<TerminalFrame> {
    let segment_rows = history_segment_row_counts(transcripts, cols, surface_rows)?;
    history_window_segments_prefetched_with_counts(
        transcripts,
        &segment_rows,
        cols,
        surface_rows,
        start_row,
        row_count,
        min_row_count,
        colors,
    )
}

pub fn history_window_segments_prefetched_with_counts(
    transcripts: &[Vec<u8>],
    segment_rows: &[usize],
    cols: u16,
    surface_rows: u16,
    start_row: usize,
    row_count: u16,
    min_row_count: u16,
    colors: TerminalThemeColors,
) -> Result<TerminalFrame> {
    let transcripts = replay_segments(transcripts);
    if transcripts.is_empty() {
        return history_window_prefetched(
            &[],
            cols,
            surface_rows,
            start_row,
            row_count,
            min_row_count,
            colors,
        );
    }
    if transcripts.len() == 1 {
        let total_rows = segment_rows
            .first()
            .copied()
            .unwrap_or_else(|| usize::from(surface_rows.max(1)))
            .max(1);
        return history_window_prefetched(
            transcripts[0],
            cols,
            surface_rows,
            start_row,
            row_count,
            min_row_count,
            colors,
        )
        .map(|mut frame| {
            frame.scrollback.total_rows = total_rows;
            frame.scrollback.scrollback_rows =
                total_rows.saturating_sub(usize::from(surface_rows.max(1)));
            frame
        });
    }

    let mut segment_spans = Vec::with_capacity(transcripts.len());
    let mut total_rows = 0_usize;
    for (index, _transcript) in transcripts.iter().enumerate() {
        let rows = segment_rows
            .get(index)
            .copied()
            .unwrap_or_else(|| usize::from(surface_rows.max(1)))
            .max(1);
        segment_spans.push((total_rows, rows));
        total_rows = total_rows.saturating_add(rows);
    }
    let total_rows = total_rows.max(1);
    let (window_start, window_rows) =
        plan_prefetch_window(start_row, row_count, min_row_count, total_rows);
    let window_count = usize::from(window_rows);
    let window_end = window_start.saturating_add(window_count);
    let mut rows_by_absolute_id: BTreeMap<usize, TerminalRow> = BTreeMap::new();
    let mut base_frame: Option<TerminalFrame> = None;

    for (index, transcript) in transcripts.iter().enumerate() {
        let (segment_start, segment_rows) = segment_spans[index];
        let segment_end = segment_start.saturating_add(segment_rows);
        let overlap_start = window_start.max(segment_start);
        let overlap_end = window_end.min(segment_end);
        if overlap_end <= overlap_start {
            continue;
        }

        let local_start = overlap_start - segment_start;
        let local_count = u16::try_from(overlap_end - overlap_start).unwrap_or(u16::MAX);
        let frame = history_window(
            transcript,
            cols,
            surface_rows,
            local_start,
            local_count,
            colors,
        )?;
        if base_frame.is_none() {
            base_frame = Some(frame.clone());
        }
        let local_offset = frame.scrollback.viewport_offset;
        for row in &frame.rows {
            let absolute_id = segment_start
                .saturating_add(local_offset)
                .saturating_add(usize::from(row.index));
            if absolute_id < window_start || absolute_id >= window_end {
                continue;
            }
            let mut rebased = row.clone();
            rebased.index = u16::try_from(absolute_id - window_start).unwrap_or(u16::MAX);
            rebased.dirty = true;
            rows_by_absolute_id.insert(absolute_id, rebased);
        }
    }

    let mut frame = base_frame.unwrap_or_else(blank_history_frame);
    let rows = (window_start..window_end)
        .map(|absolute_id| {
            rows_by_absolute_id
                .remove(&absolute_id)
                .unwrap_or_else(|| blank_history_row(absolute_id - window_start))
        })
        .collect::<Vec<_>>();
    frame.rows = rows;
    frame.scrollback.total_rows = total_rows;
    frame.scrollback.scrollback_rows = total_rows.saturating_sub(usize::from(surface_rows.max(1)));
    frame.scrollback.viewport_offset = window_start;
    frame.scrollback.viewport_rows = window_count;
    frame.scrollback.at_bottom = window_end >= total_rows;
    frame.cursor.visible = false;
    frame.cursor.position = None;
    Ok(frame)
}

fn collect_history_window(
    state: &mut GhosttyTerminalState<'_, '_>,
    start_row: usize,
    row_count: u16,
) -> Result<TerminalFrame> {
    let total_rows = state.total_rows()?.max(1);
    let requested_count = usize::from(row_count.max(1)).min(total_rows);
    let requested_start = start_row.min(total_rows.saturating_sub(requested_count));
    let requested_end = requested_start.saturating_add(requested_count);
    let mut rows_by_absolute_id: BTreeMap<usize, TerminalRow> = BTreeMap::new();
    let mut next_start = requested_start;
    let mut base_frame: Option<TerminalFrame> = None;

    while next_start < requested_end {
        state.scroll_to_row_start(next_start)?;
        let frame = state.frame()?;
        let viewport_offset = frame.scrollback.viewport_offset;
        let mut highest_seen = None;

        for row in &frame.rows {
            let absolute_id = viewport_offset.saturating_add(usize::from(row.index));
            if absolute_id < requested_start || absolute_id >= requested_end {
                continue;
            }
            let mut rebased = row.clone();
            rebased.index = u16::try_from(absolute_id - requested_start).unwrap_or(u16::MAX);
            rebased.dirty = true;
            rows_by_absolute_id.insert(absolute_id, rebased);
            highest_seen =
                Some(highest_seen.map_or(absolute_id, |seen: usize| seen.max(absolute_id)));
        }

        if base_frame.is_none() {
            base_frame = Some(frame);
        }

        match highest_seen {
            Some(row) if row + 1 > next_start => next_start = row + 1,
            _ => break,
        }
    }

    let mut frame = base_frame.unwrap_or_else(blank_history_frame);
    let surface_rows = frame.scrollback.viewport_rows;
    let rows = (requested_start..requested_end)
        .map(|absolute_id| {
            rows_by_absolute_id
                .remove(&absolute_id)
                .unwrap_or_else(|| blank_history_row(absolute_id - requested_start))
        })
        .collect::<Vec<_>>();
    frame.rows = rows;
    frame.scrollback.total_rows = total_rows;
    frame.scrollback.scrollback_rows = total_rows.saturating_sub(surface_rows);
    frame.scrollback.viewport_offset = requested_start;
    frame.scrollback.viewport_rows = requested_count;
    frame.scrollback.at_bottom = requested_end >= total_rows;
    frame.cursor.visible = false;
    frame.cursor.position = None;
    Ok(frame)
}

fn blank_history_frame() -> TerminalFrame {
    TerminalFrame {
        dirty: reverie_core::terminal::TerminalDirtyState::Full,
        cols: 0,
        colors: reverie_core::terminal::TerminalColors {
            foreground: reverie_core::terminal::TerminalColor {
                r: 0xff,
                g: 0xff,
                b: 0xff,
            },
            background: reverie_core::terminal::TerminalColor { r: 0, g: 0, b: 0 },
            cursor: None,
        },
        cursor: TerminalCursor {
            visible: false,
            blinking: false,
            style: TerminalCursorStyle::Block,
            position: Some(TerminalPosition { col: 0, row: 0 }),
        },
        modes: Default::default(),
        scrollback: Default::default(),
        rows: Vec::new(),
    }
}

fn blank_history_row(index: usize) -> TerminalRow {
    TerminalRow {
        index: u16::try_from(index).unwrap_or(u16::MAX),
        dirty: true,
        cells: Vec::new(),
    }
}

fn history_window_rows(surface_rows: u16, total_rows: usize) -> u16 {
    let visible_rows = usize::from(surface_rows.max(1));
    let max_rows = total_rows.max(1);
    let rows = visible_rows
        .saturating_mul(3)
        .max(visible_rows)
        .min(max_rows)
        .min(usize::from(u16::MAX));
    u16::try_from(rows).unwrap_or(u16::MAX).max(1)
}

fn plan_history_window_start(
    target_row: usize,
    surface_rows: u16,
    window_rows: u16,
    total_rows: usize,
) -> usize {
    let total_rows = total_rows.max(1);
    let visible_rows = usize::from(surface_rows.max(1)).min(total_rows);
    let window_rows = usize::from(window_rows.max(1)).min(total_rows);
    let max_target = total_rows.saturating_sub(visible_rows);
    let clamped_target = target_row.min(max_target);
    let context_rows = window_rows.saturating_sub(visible_rows) / 2;
    let max_start = total_rows.saturating_sub(window_rows);
    clamped_target.saturating_sub(context_rows).min(max_start)
}

fn plan_prefetch_window(
    start_row: usize,
    row_count: u16,
    min_row_count: u16,
    total_rows: usize,
) -> (usize, u16) {
    let total_rows = total_rows.max(1);
    let requested_count = usize::from(row_count.max(1)).min(total_rows);
    let requested_start = start_row.min(total_rows.saturating_sub(requested_count));
    let requested_end = requested_start.saturating_add(requested_count);
    let window_count = usize::from(min_row_count.max(row_count).max(1)).min(total_rows);
    let context_rows = window_count.saturating_sub(requested_count) / 2;
    let mut window_start = requested_start.saturating_sub(context_rows);
    if window_start.saturating_add(window_count) < requested_end {
        window_start = requested_end.saturating_sub(window_count);
    }
    window_start = window_start.min(total_rows.saturating_sub(window_count));
    (
        window_start,
        u16::try_from(window_count).unwrap_or(u16::MAX).max(1),
    )
}

fn replay_segments(transcripts: &[Vec<u8>]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    for (index, transcript) in transcripts.iter().enumerate() {
        if index > 0 {
            out.push(transcript.as_slice());
            continue;
        }

        let mut start = 0_usize;
        for offset in inferred_fresh_launch_offsets(transcript) {
            if offset > start {
                out.push(&transcript[start..offset]);
            }
            start = offset;
        }
        if start < transcript.len() || transcript.is_empty() {
            out.push(&transcript[start..]);
        }
    }
    out
}

fn inferred_fresh_launch_offsets(bytes: &[u8]) -> Vec<usize> {
    let marker = CLAUDE_FRESH_LAUNCH_MARKER;
    if marker.is_empty() || bytes.len() <= marker.len() {
        return Vec::new();
    }

    let mut offsets = Vec::new();
    let mut search_start = 0_usize;
    while search_start + marker.len() <= bytes.len() {
        let Some(relative) = bytes[search_start..]
            .windows(marker.len())
            .position(|window| window == marker)
        else {
            break;
        };
        let offset = search_start + relative;
        if offset > 0 {
            offsets.push(offset);
        }
        search_start = offset + marker.len();
    }
    offsets
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
        let frame =
            history_window(&transcript, 80, 24, 0, 24, TerminalThemeColors::default()).unwrap();
        assert!(
            row_text(&frame, 0).starts_with("line0"),
            "row 0 was {:?}",
            row_text(&frame, 0)
        );
    }

    #[test]
    fn replays_large_transcript_from_the_first_row() {
        let transcript = numbered_lines(12_000);
        let total = history_total_rows(&transcript, 80, 24).unwrap();
        assert!(
            total >= 12_000,
            "expected at least 12,000 rendered rows, got {total}"
        );

        let top =
            history_window(&transcript, 80, 24, 0, 24, TerminalThemeColors::default()).unwrap();
        assert!(
            row_text(&top, 0).starts_with("line0"),
            "top row was {:?}",
            row_text(&top, 0)
        );

        let tail_start = total.saturating_sub(24);
        let tail = history_window(
            &transcript,
            80,
            24,
            tail_start,
            24,
            TerminalThemeColors::default(),
        )
        .unwrap();
        assert!(
            tail.rows
                .iter()
                .any(|row| row_text(&tail, row.index).starts_with("line11999")),
            "tail rows did not include line11999"
        );
    }

    #[test]
    fn empty_transcript_reports_viewport_rows() {
        assert!(history_total_rows(&[], 80, 24).unwrap() >= 1);
        let frame = history_window(&[], 80, 24, 0, 24, TerminalThemeColors::default()).unwrap();
        assert!(row_text(&frame, 0).trim().is_empty());
    }

    #[test]
    fn extracts_exact_window_start() {
        let transcript = numbered_lines(80);
        let frame =
            history_window(&transcript, 80, 6, 30, 6, TerminalThemeColors::default()).unwrap();

        assert!(
            row_text(&frame, 0).starts_with("line30"),
            "row 0 was {:?}",
            row_text(&frame, 0)
        );
        assert_eq!(frame.scrollback.viewport_offset, 30);
    }

    #[test]
    fn prefetched_window_includes_requested_rows() {
        let transcript = numbered_lines(120);
        let frame = history_window_prefetched(
            &transcript,
            80,
            6,
            30,
            6,
            30,
            TerminalThemeColors::default(),
        )
        .unwrap();

        assert_eq!(frame.rows.len(), 30);
        assert!(frame.scrollback.viewport_offset <= 30);
        assert!(frame.scrollback.viewport_offset + frame.rows.len() >= 36);
        let local_index = u16::try_from(30 - frame.scrollback.viewport_offset).unwrap();
        assert!(
            row_text(&frame, local_index).starts_with("line30"),
            "requested row was {:?}",
            row_text(&frame, local_index)
        );
    }

    #[test]
    fn extracts_large_windows_without_changing_replay_viewport_height() {
        // Cursor-to-bottom output is viewport-height sensitive, matching the
        // class of redraws used by Ink-style TUIs during resume.
        let transcript = b"before\r\n\x1b[999;1Hbottom\r\n".to_vec();
        let total_rows = history_total_rows(&transcript, 20, 6).unwrap();
        let frame =
            history_window(&transcript, 20, 6, 0, 18, TerminalThemeColors::default()).unwrap();

        assert_eq!(frame.scrollback.total_rows, total_rows);
        assert_eq!(frame.scrollback.viewport_offset, 0);
        assert_eq!(frame.scrollback.viewport_rows, total_rows);
        assert_eq!(frame.rows.len(), total_rows);
        assert!(
            row_text(&frame, 5).starts_with("bottom"),
            "row 5 was {:?}",
            row_text(&frame, 5)
        );
        assert!(
            row_text(&frame, 17).trim().is_empty(),
            "cache-window height leaked into replay: {:?}",
            row_text(&frame, 17)
        );
    }

    #[test]
    fn segmented_replay_starts_resumed_tui_output_from_a_clean_terminal() {
        let transcripts = vec![b"old-top\r\nold-second".to_vec(), b"\x1b[Hnew-top".to_vec()];
        let total_rows = history_total_rows_segments(&transcripts, 20, 4).unwrap();
        let frame = history_window_segments(
            &transcripts,
            20,
            4,
            total_rows.saturating_sub(4),
            4,
            TerminalThemeColors::default(),
        )
        .unwrap();

        assert_eq!(
            frame.scrollback.viewport_offset,
            total_rows.saturating_sub(4)
        );
        assert!(
            row_text(&frame, 0).starts_with("new-top"),
            "row 0 was {:?}",
            row_text(&frame, 0)
        );
        assert!(
            row_text(&frame, 1).trim().is_empty(),
            "resumed launch inherited old row: {:?}",
            row_text(&frame, 1)
        );
    }

    #[test]
    fn segmented_replay_splits_legacy_claude_launch_markers() {
        let mut transcript = b"old-top\r\nold-second".to_vec();
        transcript.extend_from_slice(CLAUDE_FRESH_LAUNCH_MARKER);
        transcript.extend_from_slice(b"Claude\x07\x1b[Hnew-top");
        let transcripts = vec![transcript];
        let total_rows = history_total_rows_segments(&transcripts, 20, 4).unwrap();
        let frame = history_window_segments(
            &transcripts,
            20,
            4,
            total_rows.saturating_sub(4),
            4,
            TerminalThemeColors::default(),
        )
        .unwrap();

        assert_eq!(
            frame.scrollback.viewport_offset,
            total_rows.saturating_sub(4)
        );
        assert!(
            row_text(&frame, 0).starts_with("new-top"),
            "row 0 was {:?}",
            row_text(&frame, 0)
        );
        assert!(
            row_text(&frame, 1).trim().is_empty(),
            "legacy replay carried old row across inferred launch: {:?}",
            row_text(&frame, 1)
        );
    }

    #[test]
    fn segmented_replay_does_not_split_markers_inside_explicit_runs() {
        let mut second_run = b"second-before\r\n".to_vec();
        second_run.extend_from_slice(CLAUDE_FRESH_LAUNCH_MARKER);
        second_run.extend_from_slice(b"Claude\x07\x1b[Hsecond-after");
        let transcripts = vec![b"first-run\r\n".to_vec(), second_run.clone()];
        let replay = replay_segments(&transcripts);

        assert_eq!(replay.len(), 2);
        assert_eq!(replay[0], transcripts[0].as_slice());
        assert_eq!(replay[1], second_run.as_slice());
    }

    #[test]
    fn segmented_replay_still_splits_legacy_markers_in_first_run() {
        let mut first_run = b"old-before\r\n".to_vec();
        first_run.extend_from_slice(CLAUDE_FRESH_LAUNCH_MARKER);
        first_run.extend_from_slice(b"Claude\x07\x1b[Hold-after");
        let transcripts = vec![first_run, b"explicit-second\r\n".to_vec()];
        let replay = replay_segments(&transcripts);

        assert_eq!(replay.len(), 3);
        assert_eq!(replay[0], b"old-before\r\n");
        assert!(replay[1].starts_with(CLAUDE_FRESH_LAUNCH_MARKER));
        assert_eq!(replay[2], transcripts[1].as_slice());
    }
}
