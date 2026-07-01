use anyhow::Result;
use std::cell::Cell;
use std::rc::Rc;

use libghostty_vt::error::Error as GhosttyError;
use libghostty_vt::paste;
use libghostty_vt::render::{CellIterator, CursorVisualStyle, Dirty, RowIterator};
use libghostty_vt::screen::{CellWide, Screen, TrackedGridRef};
use libghostty_vt::style::{RgbColor, Style, Underline as GhosttyUnderline};
use libghostty_vt::terminal::{
    ColorScheme, CursorStyle, Mode, Point, PointCoordinate, PointSpace, ScrollViewport,
};
use libghostty_vt::{RenderState, Terminal, TerminalOptions};
use reverie_core::terminal::{
    TerminalCell, TerminalCellStyle, TerminalColor, TerminalColors, TerminalCursor,
    TerminalCursorStyle, TerminalDirtyState, TerminalFrame, TerminalModes, TerminalPosition,
    TerminalRow, TerminalScrollback, TerminalUnderline,
};

const DEFAULT_CELL_WIDTH_PX: u32 = 9;
const DEFAULT_CELL_HEIGHT_PX: u32 = 18;

/// Upper bound on the rows one `read_rows` serve will gather, so a pathological
/// history-range request can never make the worker walk the whole page list in
/// one call. A prefetch band is a viewport plus overscan (tens of rows); this
/// cap is far above any real band while still bounding the excursion.
const MAX_READ_ROWS: usize = 4_096;

/// libghostty's scrollback budget per session, in bytes (the `max_scrollback`
/// option is a byte cap, not a row count; see `libghostty-history-limits.md`).
/// libghostty's own default is 10 MB; Reverie sets the dial to 100 MB per
/// session (decisions.md D7). Allocation is lazy, so a budget this large only
/// costs what a session actually produces, and background buffers are shed under
/// memory pressure. This is the sole source of scroll-back reach (D6/D7): the
/// backend serves rows only from this live buffer and persists nothing.
pub const SCROLLBACK_LIMIT_BYTES: usize = 100 * 1024 * 1024;

/// A frontend-owned viewport anchor resolved by libghostty during resize.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalResizeAnchor {
    pub stable_id: u64,
    pub col: u16,
}

/// Ghostty-backed terminal state for converting VT byte streams into Reverie frames.
///
/// This module intentionally has no Tauri command/event knowledge and no product
/// session semantics. App services can feed it bytes from any PTY/runtime source
/// and receive the stable `TerminalFrame` shape used by the frontend renderer.
pub struct GhosttyTerminalState<'alloc, 'cb> {
    terminal: Terminal<'alloc, 'cb>,
    render_state: RenderState<'alloc>,
    color_scheme: Rc<Cell<ColorScheme>>,
    force_next_full_frame: bool,
    last_frame: Option<TerminalFrame>,
    /// Monotonic count of rows evicted off the top of libghostty's buffer, i.e.
    /// the stable id of the oldest row still buffered (the WezTerm StableRowIndex
    /// `first_id`; see decisions.md D8). A buffered row at `buffer_position` has
    /// stable id `buffer_position + lines_evicted`. Below the scrollback cap
    /// nothing evicts and this stays 0, so id == position. At the cap it is
    /// best-effort: libghostty emits no eviction signal, so [`Self::observe_eviction`]
    /// infers evictions from drops in `total_rows`, which can under-count under
    /// bursty output; the frontend's reconciliation heals the resulting transient
    /// drift (D8, the one accepted residual).
    lines_evicted: u64,
    /// The `total_rows` seen at the last observation, to detect a drop (eviction)
    /// since then. Rebaselined on resize so reflow's row-count change is never
    /// miscounted as eviction.
    last_observed_total: usize,
}

impl<'alloc, 'cb> GhosttyTerminalState<'alloc, 'cb> {
    /// Construct a terminal sized `cols`x`rows`. The scrollback budget is always
    /// the fixed [`SCROLLBACK_LIMIT_BYTES`] dial (100 MB, lazily allocated;
    /// decisions.md D7): `max_scrollback` is libghostty's byte cap, and the
    /// frontend, not a per-session row count, decides reach by scrolling, so the
    /// budget is a single constant applied here at construction.
    pub fn new(cols: u16, rows: u16) -> Result<Self> {
        Self::new_with_scrollback_limit(cols, rows, SCROLLBACK_LIMIT_BYTES)
    }

    /// Construct with an explicit scrollback byte cap. Production goes through
    /// [`Self::new`] (the fixed [`SCROLLBACK_LIMIT_BYTES`] dial); tests pass a
    /// small cap to exercise eviction without producing 100 MB of output.
    pub fn new_with_scrollback_limit(cols: u16, rows: u16, max_scrollback: usize) -> Result<Self> {
        let color_scheme = Rc::new(Cell::new(ColorScheme::Dark));
        let scheme_for_query = color_scheme.clone();
        let mut terminal = Terminal::new(TerminalOptions {
            cols,
            rows,
            max_scrollback,
        })?;
        terminal
            .on_color_scheme(move |_terminal| Some(scheme_for_query.get()))?
            .set_default_cursor_style(Some(CursorStyle::Block))?
            .set_default_cursor_blink(Some(false))?;
        Ok(Self {
            terminal,
            render_state: RenderState::new()?,
            color_scheme,
            force_next_full_frame: true,
            last_frame: None,
            lines_evicted: 0,
            last_observed_total: 0,
        })
    }

    pub fn write(&mut self, bytes: &[u8]) {
        self.terminal.vt_write(bytes);
        self.observe_eviction();
    }

    /// Advance `lines_evicted` by any drop in `total_rows` since the last
    /// observation, the best-effort eviction signal libghostty leaves us (D8): a
    /// page pruned off the top shrinks `total_rows`, and at the cap that is by far
    /// the dominant cause. It is best-effort, not exact: a write batch that both
    /// appends and prunes inside one `vt_write` masks part of the count (an
    /// under-count), and a scrollback-clearing sequence (ED 3) or an alt-screen
    /// toggle inside a batch can shrink `total_rows` for a non-eviction reason (an
    /// over-count). Both resolve to transient drift the frontend's reconciliation
    /// heals (D8); never silent wrong content. Called after every [`Self::write`],
    /// where eviction physically happens (inside `vt_write`). Below the cap
    /// `total_rows` only grows, so this is a no-op and `lines_evicted` stays 0
    /// (id == position). Resize rebaselines instead of counting, since reflow
    /// changes the row count for non-eviction reasons.
    fn observe_eviction(&mut self) {
        let total = self.total_rows().unwrap_or(self.last_observed_total);
        if total < self.last_observed_total {
            self.lines_evicted += (self.last_observed_total - total) as u64;
        }
        self.last_observed_total = total;
    }

    /// The stable id of the oldest row currently buffered (the WezTerm-style
    /// `first_id`; see decisions.md D8). A buffered row at `buffer_position` has
    /// stable id `buffer_position + oldest_id()`. Reported to the frontend so its
    /// cache and viewport anchor survive trim; below the cap it is always 0.
    // Used by tests today; the runtime's read_rows id->position conversion
    // consumes it in Phase B (the id cutover). Allowed dead until that lands.
    #[allow(dead_code)]
    pub fn oldest_id(&self) -> u64 {
        self.lines_evicted
    }

    pub fn sync_output_mode(&self) -> Result<bool> {
        Ok(self.terminal.mode(Mode::SYNC_OUTPUT)?)
    }

    /// The terminal title most recently set by the program via OSC 0/1/2, or
    /// `None` when none has been set. Copied to an owned `String` immediately:
    /// libghostty borrows the title only until the next `vt_write`/`reset`, so
    /// callers must not hold the borrow across a write.
    pub fn title(&self) -> Option<String> {
        match self.terminal.title() {
            Ok(title) if !title.is_empty() => Some(title.to_owned()),
            _ => None,
        }
    }

    /// Seed the terminal's default foreground/background using libghostty's
    /// embedder color APIs. This replaces the old synthetic OSC 10/11 input path.
    ///
    /// NOTE: this is NOT the paint path. The frontend Canvas renderer is the
    /// authoritative source for the painted default colors: it draws from the
    /// shell theme and ignores `frame.colors`, because the theme is tied to the
    /// shell's CSS and must re-theme live, exited, and cached sessions instantly
    /// on a light/dark toggle (a VT-side default can't re-theme an exited session
    /// without replaying it). This call keeps the VT model honest, gives color
    /// queries the active defaults, and reports the matching light/dark scheme.
    /// Forces a full frame so the change repaints everywhere.
    pub fn set_default_colors(
        &mut self,
        foreground: TerminalColor,
        background: TerminalColor,
    ) -> Result<()> {
        self.terminal
            .set_default_fg_color(Some(to_rgb_color(foreground)))?
            .set_default_bg_color(Some(to_rgb_color(background)))?
            .set_default_cursor_color(Some(to_rgb_color(foreground)))?;
        self.color_scheme
            .set(color_scheme_for_background(background));
        self.force_next_full_frame = true;
        Ok(())
    }

    /// Encode paste text through libghostty's sanitizer using the live terminal
    /// bracketed-paste mode. Normal typed input deliberately bypasses this.
    pub fn encode_paste(&self, text: &str) -> Result<Vec<u8>> {
        if text.is_empty() {
            return Ok(Vec::new());
        }

        let bracketed = self.terminal.mode(Mode::BRACKETED_PASTE)?;
        let mut data = text.as_bytes().to_vec();
        let mut encoded = vec![0_u8; data.len().saturating_add(32).max(32)];

        loop {
            match paste::encode(&mut data, bracketed, &mut encoded) {
                Ok(len) => {
                    encoded.truncate(len);
                    return Ok(encoded);
                }
                Err(GhosttyError::OutOfSpace { required }) => {
                    let next_len = required.max(encoded.len().saturating_mul(2)).max(32);
                    encoded.resize(next_len, 0);
                }
                Err(error) => return Err(error.into()),
            }
        }
    }

    pub fn on_pty_write(
        &mut self,
        mut callback: impl for<'data> FnMut(&'data [u8]) + 'cb,
    ) -> Result<()> {
        self.terminal
            .on_pty_write(move |_terminal, data| callback(data))?;
        Ok(())
    }

    #[cfg(test)]
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.resize_with_anchor(cols, rows, None)
    }

    pub fn resize_with_anchor(
        &mut self,
        cols: u16,
        rows: u16,
        anchor: Option<TerminalResizeAnchor>,
    ) -> Result<()> {
        let tracked_anchor = match anchor {
            Some(anchor) => match self.track_resize_anchor(anchor) {
                Ok(tracked_anchor) => Some(tracked_anchor),
                Err(error) => {
                    eprintln!(
                        "[reverie-terminal] resize anchor unavailable \
                         (stable_id={}, col={}): {error}",
                        anchor.stable_id, anchor.col
                    );
                    None
                }
            },
            None => None,
        };
        self.terminal
            .resize(cols, rows, DEFAULT_CELL_WIDTH_PX, DEFAULT_CELL_HEIGHT_PX)?;
        self.force_next_full_frame = true;
        // Reflow recomputes total_rows for non-eviction reasons (rewrapping can
        // shrink the row count), so rebaseline the eviction observer rather than
        // let the next write miscount that change as eviction. The frontend
        // re-seeds on the generation bump that accompanies a resize, so stable
        // ids are re-derived against the new geometry anyway (D8). On the rare
        // total_rows() error here, rebaseline to 0 rather than keep the stale
        // pre-resize value: the next observe then sees growth (no phantom drop)
        // instead of miscounting the reflow shrink as eviction.
        self.last_observed_total = self.total_rows().unwrap_or(0);
        if let Some(tracked_anchor) = tracked_anchor {
            if let Some(point) = tracked_anchor.point(PointSpace::Screen)? {
                self.scroll_to_row_start(point.y as usize)?;
            }
        }
        Ok(())
    }

    fn track_resize_anchor(&self, anchor: TerminalResizeAnchor) -> Result<TrackedGridRef> {
        let total_rows = self.total_rows()?;
        let Some(max_row) = total_rows.checked_sub(1) else {
            anyhow::bail!("cannot anchor an empty terminal buffer");
        };
        let row = anchor
            .stable_id
            .saturating_sub(self.lines_evicted)
            .min(max_row as u64);
        let y = u32::try_from(row)?;
        let cols = self.terminal.cols()?;
        let x = anchor.col.min(cols.saturating_sub(1));
        self.terminal
            .track_grid_ref(Point::Screen(PointCoordinate { x, y }))
            .map_err(Into::into)
    }

    /// Whether the viewport currently shows the active area (the tail). Used by
    /// `scroll_bottom` to skip a redundant re-pin, and indirectly by the worker
    /// which keeps the tail pinned before each live extract.
    pub fn is_viewport_at_bottom(&self) -> Result<bool> {
        let scrollbar = self.terminal.scrollbar()?;
        Ok(scrollbar.offset.saturating_add(scrollbar.len) >= scrollbar.total)
    }

    /// Pin the viewport to the active area (the tail), forcing a full next frame
    /// when it actually moved. The worker calls this before each live extract so
    /// the live stream always emits the tail; the frontend, not the backend,
    /// decides whether the tail is on screen. The early return keeps a steady
    /// tail-follow from re-pinning every frame. `read_rows` uses
    /// [`Self::scroll_bottom_unconditional`] instead, because after a serve
    /// excursion the pin is in scrollback and the at-bottom check would be stale.
    pub fn scroll_bottom(&mut self) {
        if matches!(self.is_viewport_at_bottom(), Ok(true)) {
            return;
        }
        self.scroll_bottom_unconditional();
    }

    /// Total rows currently held in libghostty's live buffer (scrollback +
    /// viewport). The frontend uses this (via the frame's scrollback block) to
    /// size its scroll-back and address history-range requests; `read_rows`
    /// clamps its band to it.
    pub fn total_rows(&self) -> Result<usize> {
        Ok(self.terminal.total_rows()?)
    }

    /// Scroll the viewport so `row` is the first rendered row, clamped to the
    /// last valid viewport start. This is the exact move `read_rows` uses to
    /// position the pin over a requested history band before extracting it.
    pub fn scroll_to_row_start(&mut self, row: usize) -> Result<()> {
        let scrollbar = self.terminal.scrollbar()?;
        let total = scrollbar.total as usize;
        let len = scrollbar.len as usize;
        let offset = scrollbar.offset as usize;
        let max_offset = total.saturating_sub(len);
        let target = row.min(max_offset);
        let delta = target as isize - offset as isize;
        if delta != 0 {
            self.terminal.scroll_viewport(ScrollViewport::Delta(delta));
            self.force_next_full_frame = true;
        }
        Ok(())
    }

    pub fn frame(&mut self) -> Result<TerminalFrame> {
        let force_full_frame = std::mem::take(&mut self.force_next_full_frame);
        let mut frame = extract_frame(&mut self.render_state, &self.terminal)?;
        // Stamp the stable-id floor onto the frame so the frontend can derive a
        // stable id for every row (`oldest_id + absolute_position`) and keep its
        // cache coherent across trim (D8). `extract_frame` has no `self`, so it
        // leaves `oldest_id` at 0 and we set the live value here.
        frame.scrollback.oldest_id = self.lines_evicted;
        Ok(self.diff_frame(frame, force_full_frame))
    }

    /// Serve a contiguous band of history rows for the frontend's scroll-back
    /// prefetch (decisions.md D6/D7). Returns up to `count` rows starting at
    /// absolute row `start_row`, each indexed 0-based within the band.
    ///
    /// Mechanism (shaped by the binding, see `libghostty-history-limits.md`):
    /// the `libghostty` binding can only read cells through `RenderState`, which
    /// always reflects the current viewport, so a by-position read of arbitrary
    /// scrollback rows is done by *moving the viewport pin*. We momentarily move
    /// the pin to `start_row` (via the exact `scroll_to_row_start`), extract the
    /// visible rows, and step the pin down by a viewport height at a time until
    /// `count` rows are gathered or the buffer is exhausted, then RESTORE the pin
    /// to the active area (`scroll_bottom`) before returning, so the next live
    /// extract still shows the tail. This runs only on the worker thread that
    /// solely owns the terminal, so a serve is never interleaved with a live
    /// extract and the user never sees the excursion.
    ///
    /// Returns an empty band when `start_row` is at or past the end of the
    /// buffer. `count` is clamped to a sane maximum.
    pub fn read_rows(&mut self, start_row: usize, count: usize) -> Result<Vec<TerminalRow>> {
        // Run the serve, then ALWAYS restore the pin to the tail, even if an
        // extract or scroll errored mid-serve. Otherwise an error would leave the
        // pin parked in scrollback and the next live extract would paint a stale
        // history excursion instead of the tail. The restore happens before we
        // surface the error to the caller.
        let result = self.read_rows_inner(start_row, count);
        self.scroll_bottom_unconditional();
        result
    }

    /// The serve loop for [`Self::read_rows`]. Kept separate so the caller can
    /// restore the viewport pin unconditionally afterward, regardless of whether
    /// this returned `Ok` or `Err`.
    fn read_rows_inner(&mut self, start_row: usize, count: usize) -> Result<Vec<TerminalRow>> {
        let count = count.min(MAX_READ_ROWS);
        let total_rows = self.total_rows()?;
        if count == 0 || start_row >= total_rows {
            return Ok(Vec::new());
        }

        let end_row = start_row.saturating_add(count).min(total_rows);
        let mut rows: Vec<TerminalRow> = Vec::with_capacity(end_row - start_row);
        let mut next_row = start_row;

        // Step the pin down a viewport at a time, copying the rows that fall in
        // [start_row, end_row). `scroll_to_row_start` clamps to the last valid
        // viewport start, so near the bottom the landed offset can be < the
        // requested row; we read the real offset back and skip rows before
        // `next_row`, and we always advance by at least one row to terminate.
        while next_row < end_row {
            self.scroll_to_row_start(next_row)?;
            let offset = self.viewport_offset()?;
            let window = extract_frame(&mut self.render_state, &self.terminal)?;
            let window_len = window.rows.len();
            if window_len == 0 {
                break;
            }

            for row in window.rows {
                let absolute = offset.saturating_add(row.index as usize);
                if absolute < next_row || absolute >= end_row {
                    continue;
                }
                let band_index = absolute - start_row;
                rows.push(TerminalRow {
                    index: band_index as u16,
                    dirty: true,
                    cells: row.cells,
                });
            }

            // Guarantee forward progress even if the window contributed no rows
            // in range (e.g. a clamp landed entirely below `next_row`). A zero-row
            // window already broke above, so `advanced_to > offset` always holds
            // here; the `max` only matters when the band is shorter than the
            // viewport and the clamp lands the offset before `next_row`.
            next_row = offset.saturating_add(window_len).max(next_row + 1);
        }

        // Rows are gathered top-down in viewport-height steps but a clamp can
        // surface them out of order at the boundary; sort + dedup by band index
        // so the band is strictly contiguous and ascending.
        rows.sort_by_key(|row| row.index);
        rows.dedup_by_key(|row| row.index);
        Ok(rows)
    }

    /// The current viewport's top absolute row (the scrollbar offset).
    fn viewport_offset(&self) -> Result<usize> {
        let scrollbar = self.terminal.scrollbar()?;
        Ok(usize::try_from(scrollbar.offset).unwrap_or(usize::MAX))
    }

    /// Move the viewport pin to the active area (tail) unconditionally, forcing a
    /// full next frame. Used by `read_rows` to restore the pin after a serve and
    /// by the worker before each live extract; unlike `scroll_bottom` it does not
    /// early-return when already at the bottom, because after a serve excursion
    /// the pin is in scrollback and must be reset.
    pub fn scroll_bottom_unconditional(&mut self) {
        self.terminal.scroll_viewport(ScrollViewport::Bottom);
        self.force_next_full_frame = true;
    }

    fn diff_frame(&mut self, mut frame: TerminalFrame, force_full_frame: bool) -> TerminalFrame {
        let previous = self.last_frame.replace(canonical_frame(&frame));
        let Some(previous) = previous else {
            mark_full_frame(&mut frame);
            return frame;
        };

        if force_full_frame || needs_full_frame(&previous, &frame) {
            mark_full_frame(&mut frame);
            return frame;
        }

        let changed_rows = changed_rows(
            &previous.rows,
            previous.scrollback.viewport_offset,
            &frame.rows,
            frame.scrollback.viewport_offset,
        );
        let cursor_changed = previous.cursor != frame.cursor;
        frame.rows = changed_rows;
        if frame.rows.is_empty() && !cursor_changed {
            frame.dirty = TerminalDirtyState::Clean;
        } else {
            frame.dirty = TerminalDirtyState::Partial;
        }
        frame
    }
}

fn canonical_frame(frame: &TerminalFrame) -> TerminalFrame {
    let mut canonical = frame.clone();
    canonical.dirty = TerminalDirtyState::Clean;
    for row in &mut canonical.rows {
        row.dirty = false;
    }
    canonical
}

fn mark_full_frame(frame: &mut TerminalFrame) {
    frame.dirty = TerminalDirtyState::Full;
    for row in &mut frame.rows {
        row.dirty = true;
    }
}

fn needs_full_frame(previous: &TerminalFrame, frame: &TerminalFrame) -> bool {
    previous.colors != frame.colors
        || previous.cols != frame.cols
        || previous.modes != frame.modes
        || previous.rows.len() != frame.rows.len()
        || previous.scrollback.viewport_rows != frame.scrollback.viewport_rows
        || frame.scrollback.total_rows < previous.scrollback.total_rows
}

fn changed_rows(
    previous: &[TerminalRow],
    previous_offset: usize,
    current: &[TerminalRow],
    current_offset: usize,
) -> Vec<TerminalRow> {
    current
        .iter()
        .filter_map(|row| {
            let absolute = current_offset.saturating_add(row.index as usize);
            let changed = absolute
                .checked_sub(previous_offset)
                .and_then(|index| previous.get(index))
                .is_none_or(|previous| row_cells_changed(previous, row));
            changed.then(|| {
                let mut row = row.clone();
                row.dirty = true;
                row
            })
        })
        .collect()
}

fn row_cells_changed(previous: &TerminalRow, current: &TerminalRow) -> bool {
    previous.cells != current.cells
}

fn extract_frame<'alloc, 'cb>(
    render_state: &mut RenderState<'alloc>,
    terminal: &Terminal<'alloc, 'cb>,
) -> Result<TerminalFrame> {
    let snapshot = render_state.update(terminal)?;
    let dirty_state = map_dirty(snapshot.dirty()?);
    let colors = snapshot.colors()?;
    let cursor_viewport = snapshot.cursor_viewport()?;
    let scrollbar = terminal.scrollbar()?;
    let scrollbar_offset = usize::try_from(scrollbar.offset).unwrap_or(usize::MAX);
    let scrollbar_len = usize::try_from(scrollbar.len).unwrap_or(usize::MAX);

    let cursor = TerminalCursor {
        visible: snapshot.cursor_visible()?,
        blinking: snapshot.cursor_blinking()?,
        style: map_cursor_style(snapshot.cursor_visual_style()?),
        position: cursor_viewport
            .filter(|cursor| !cursor.at_wide_tail)
            .map(|cursor| TerminalPosition {
                col: cursor.x,
                row: cursor.y,
            }),
    };

    let mut row_iter = RowIterator::new()?;
    let mut cell_iter = CellIterator::new()?;
    let mut row_iteration = row_iter.update(&snapshot)?;
    let mut rows = Vec::new();
    let mut row_index = 0_u16;

    while let Some(row) = row_iteration.next() {
        let dirty = row.dirty()?;
        let mut cell_iteration = cell_iter.update(row)?;
        let mut cells = Vec::new();
        let mut col = 0_u16;

        while let Some(cell) = cell_iteration.next() {
            let raw = cell.raw_cell()?;
            let width = match raw.wide()? {
                CellWide::Narrow => 1,
                CellWide::Wide => 2,
                CellWide::SpacerTail | CellWide::SpacerHead => {
                    col = col.saturating_add(1);
                    continue;
                }
            };
            let has_text = raw.has_text()?;
            if !has_text && !raw.has_styling()? {
                col = col.saturating_add(1);
                continue;
            }
            let text = if has_text {
                cell_text(cell)?
            } else {
                " ".to_string()
            };
            let fg = cell.fg_color()?.map(map_color);
            let bg = cell.bg_color()?.map(map_color);
            let style = map_cell_style(cell.style()?);

            if !is_default_blank_cell(width, &text, fg, bg, &style) {
                cells.push(TerminalCell {
                    col,
                    width,
                    text,
                    fg,
                    bg,
                    style,
                });
            }

            col = col.saturating_add(1);
        }

        rows.push(TerminalRow {
            index: row_index,
            dirty,
            cells,
        });
        row_index = row_index.saturating_add(1);
    }

    Ok(TerminalFrame {
        dirty: dirty_state,
        cols: terminal.cols()?,
        colors: TerminalColors {
            foreground: map_color(colors.foreground),
            background: map_color(colors.background),
            cursor: colors.cursor.map(map_color),
        },
        cursor,
        modes: TerminalModes {
            cursor_key_application: terminal.mode(Mode::DECCKM)?,
            keypad_key_application: terminal.mode(Mode::KEYPAD_KEYS)?,
            bracketed_paste: terminal.mode(Mode::BRACKETED_PASTE)?,
            sync_output: terminal.mode(Mode::SYNC_OUTPUT)?,
            mouse_tracking: terminal.is_mouse_tracking()?,
            alternate_screen: terminal.active_screen()? == Screen::Alternate,
            kitty_keyboard_flags: terminal.kitty_keyboard_flags()?.bits(),
        },
        scrollback: TerminalScrollback {
            total_rows: terminal.total_rows()?,
            scrollback_rows: terminal.scrollback_rows()?,
            viewport_offset: scrollbar_offset,
            viewport_rows: scrollbar_len,
            at_bottom: scrollbar.offset.saturating_add(scrollbar.len) >= scrollbar.total,
            // Set by `frame()`, which has the `lines_evicted` count; this free
            // function cannot see it, so it leaves the floor at 0.
            oldest_id: 0,
        },
        rows,
    })
}

fn cell_text(cell: &libghostty_vt::render::CellIteration<'_, '_>) -> Result<String> {
    if cell.graphemes_len()? == 0 {
        return Ok(" ".to_string());
    }

    let mut text = String::new();
    cell.graphemes_utf8(&mut text)?;
    Ok(text)
}

fn map_dirty(dirty: Dirty) -> TerminalDirtyState {
    match dirty {
        Dirty::Clean => TerminalDirtyState::Clean,
        Dirty::Partial => TerminalDirtyState::Partial,
        Dirty::Full => TerminalDirtyState::Full,
    }
}

fn map_color(color: RgbColor) -> TerminalColor {
    TerminalColor {
        r: color.r,
        g: color.g,
        b: color.b,
    }
}

fn to_rgb_color(color: TerminalColor) -> RgbColor {
    RgbColor {
        r: color.r,
        g: color.g,
        b: color.b,
    }
}

fn color_scheme_for_background(background: TerminalColor) -> ColorScheme {
    let luminance = 0.2126 * f64::from(background.r)
        + 0.7152 * f64::from(background.g)
        + 0.0722 * f64::from(background.b);
    if luminance >= 128.0 {
        ColorScheme::Light
    } else {
        ColorScheme::Dark
    }
}

fn map_cursor_style(style: CursorVisualStyle) -> TerminalCursorStyle {
    match style {
        CursorVisualStyle::Block => TerminalCursorStyle::Block,
        CursorVisualStyle::BlockHollow => TerminalCursorStyle::BlockHollow,
        CursorVisualStyle::Bar => TerminalCursorStyle::Bar,
        CursorVisualStyle::Underline => TerminalCursorStyle::Underline,
        _ => TerminalCursorStyle::Block,
    }
}

fn map_cell_style(style: Style) -> TerminalCellStyle {
    TerminalCellStyle {
        bold: style.bold,
        italic: style.italic,
        faint: style.faint,
        blink: style.blink,
        invisible: style.invisible,
        underline: map_underline(style.underline),
        inverse: style.inverse,
        strikethrough: style.strikethrough,
        overline: style.overline,
    }
}

fn is_default_blank_cell(
    width: u16,
    text: &str,
    fg: Option<TerminalColor>,
    bg: Option<TerminalColor>,
    style: &TerminalCellStyle,
) -> bool {
    width == 1
        && text == " "
        && fg.is_none()
        && bg.is_none()
        && !style.bold
        && !style.italic
        && !style.faint
        && !style.blink
        && !style.invisible
        && style.underline == TerminalUnderline::None
        && !style.inverse
        && !style.strikethrough
        && !style.overline
}

fn map_underline(underline: GhosttyUnderline) -> TerminalUnderline {
    match underline {
        GhosttyUnderline::None => TerminalUnderline::None,
        GhosttyUnderline::Single => TerminalUnderline::Single,
        GhosttyUnderline::Double => TerminalUnderline::Double,
        GhosttyUnderline::Curly => TerminalUnderline::Curly,
        GhosttyUnderline::Dotted => TerminalUnderline::Dotted,
        GhosttyUnderline::Dashed => TerminalUnderline::Dashed,
        _ => TerminalUnderline::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ghostty_terminal_state_renders_reverie_frame() {
        let mut terminal = GhosttyTerminalState::new(40, 8).unwrap();
        terminal.write(b"\x1b[1;36mReverie\x1b[0m terminal backend\r\n");
        let frame = terminal.frame().unwrap();

        let rendered = frame
            .rows
            .iter()
            .map(TerminalRow::plain_text)
            .collect::<Vec<_>>()
            .join("\n");

        assert!(rendered.contains("Reverie terminal backend"));
        assert_eq!(frame.rows.len(), 8);
    }

    #[test]
    fn ghostty_terminal_state_tracks_kitty_keyboard_flags() {
        // The frontend key encoder switches to the kitty keyboard protocol only
        // when the frame reports non-zero flags. This proves libghostty parses
        // the enable/disable stack sequences and surfaces the active flags, so a
        // CLI that turns the protocol on (Codex via crossterm sends exactly
        // `CSI > flags u`) gets kitty-encoded keys instead of legacy bytes.
        let mut terminal = GhosttyTerminalState::new(20, 4).unwrap();
        assert_eq!(
            terminal.frame().unwrap().modes.kitty_keyboard_flags,
            0,
            "no protocol is active before any app enables it"
        );

        // Push "disambiguate escape codes" + "report alternate keys" (bits 1|4).
        terminal.write(b"\x1b[>5u");
        assert_eq!(terminal.frame().unwrap().modes.kitty_keyboard_flags, 5);

        // Popping the stack entry restores the inactive state.
        terminal.write(b"\x1b[<1u");
        assert_eq!(terminal.frame().unwrap().modes.kitty_keyboard_flags, 0);
    }

    #[test]
    fn ghostty_terminal_state_answers_the_kitty_support_query() {
        use std::cell::RefCell;
        use std::rc::Rc;

        // A CLI probes kitty support by sending `CSI ? u` and enables the
        // protocol only if the terminal replies `CSI ? flags u`. crossterm's
        // `supports_keyboard_enhancement` (used by Codex) does exactly this, so
        // this reply is what makes Shift+Enter reach our kitty encoder at all.
        let mut terminal = GhosttyTerminalState::new(20, 4).unwrap();
        let responses = Rc::new(RefCell::new(Vec::<u8>::new()));
        let sink = responses.clone();
        terminal
            .on_pty_write(move |data| sink.borrow_mut().extend_from_slice(data))
            .unwrap();

        terminal.write(b"\x1b[?u");
        let reply = responses.borrow().clone();
        assert_eq!(
            reply, b"\x1b[?0u",
            "kitty support query must be answered (got {reply:?})"
        );
    }

    #[test]
    fn ghostty_terminal_state_answers_kitty_query_before_primary_da() {
        use std::cell::RefCell;
        use std::rc::Rc;

        // crossterm (used by Codex and Cortex) detects kitty support by writing
        // the kitty query `CSI ? u` immediately followed by a Primary DA `CSI c`,
        // then reading replies until the DA answer arrives: if it sees the kitty
        // reply first it concludes support and enables the protocol. So both
        // replies must be emitted AND the kitty one must come first. (Confirmed
        // against the real CLIs: each sends `CSI ? u` then pushes `CSI > 7 u`.)
        let mut terminal = GhosttyTerminalState::new(20, 4).unwrap();
        let responses = Rc::new(RefCell::new(Vec::<u8>::new()));
        let sink = responses.clone();
        terminal
            .on_pty_write(move |data| sink.borrow_mut().extend_from_slice(data))
            .unwrap();

        terminal.write(b"\x1b[?u\x1b[c");
        let reply = responses.borrow().clone();

        let kitty_at = reply
            .windows(2)
            .position(|w| w == b"?0")
            .expect("kitty support reply (CSI ? 0 u) must be present");
        let da_at = reply
            .windows(2)
            .position(|w| w == b"?6")
            .expect("primary DA reply (CSI ? 62..c) must be present");
        assert!(
            kitty_at < da_at,
            "kitty reply must precede the DA reply or crossterm gives up: {reply:?}"
        );
    }

    #[test]
    fn ghostty_terminal_state_preserves_wide_cell_widths() {
        let mut terminal = GhosttyTerminalState::new(20, 4).unwrap();
        terminal.write("A界B\r\n".as_bytes());
        let frame = terminal.frame().unwrap();
        let row = frame.rows.iter().find(|row| row.index == 0).unwrap();

        let cells = row
            .cells
            .iter()
            .filter(|cell| {
                cell.text.trim().is_empty() || ["A", "界", "B"].contains(&cell.text.as_str())
            })
            .collect::<Vec<_>>();

        let a = cells.iter().find(|cell| cell.text == "A").unwrap();
        let wide = cells.iter().find(|cell| cell.text == "界").unwrap();
        let b = cells.iter().find(|cell| cell.text == "B").unwrap();

        assert_eq!((a.col, a.width), (0, 1));
        assert_eq!((wide.col, wide.width), (1, 2));
        assert_eq!((b.col, b.width), (3, 1));
        assert!(
            !row.cells
                .iter()
                .any(|cell| cell.col == 2 && cell.text == " ")
        );
    }

    #[test]
    fn ghostty_terminal_state_reports_default_colors() {
        let mut terminal = GhosttyTerminalState::new(20, 4).unwrap();
        // Default (no OSC) is Ghostty's hardwired white-on-black.
        let default = terminal.frame().unwrap();
        assert_eq!(
            default.colors.background,
            TerminalColor { r: 0, g: 0, b: 0 }
        );
        assert_eq!(
            default.colors.foreground,
            TerminalColor {
                r: 255,
                g: 255,
                b: 255
            }
        );

        // Light-theme values: cream background, near-black foreground.
        terminal
            .set_default_colors(
                TerminalColor {
                    r: 0x1b,
                    g: 0x18,
                    b: 0x14,
                },
                TerminalColor {
                    r: 0xf4,
                    g: 0xf1,
                    b: 0xeb,
                },
            )
            .unwrap();
        let themed = terminal.frame().unwrap();
        assert_eq!(
            themed.colors.background,
            TerminalColor {
                r: 0xf4,
                g: 0xf1,
                b: 0xeb
            }
        );
        assert_eq!(
            themed.colors.foreground,
            TerminalColor {
                r: 0x1b,
                g: 0x18,
                b: 0x14
            }
        );
        assert_eq!(themed.dirty, TerminalDirtyState::Full);
    }

    #[test]
    fn ghostty_terminal_state_encodes_plain_paste_safely() {
        let terminal = GhosttyTerminalState::new(20, 4).unwrap();
        let encoded = terminal.encode_paste("a\nb\x1b[201~c").unwrap();

        assert_eq!(String::from_utf8(encoded).unwrap(), "a\rb [201~c");
    }

    #[test]
    fn ghostty_terminal_state_encodes_bracketed_paste_safely() {
        let mut terminal = GhosttyTerminalState::new(20, 4).unwrap();
        terminal.write(b"\x1b[?2004h");
        let encoded = terminal.encode_paste("hello\nworld").unwrap();

        assert!(encoded.starts_with(b"\x1b[200~"));
        assert!(encoded.ends_with(b"\x1b[201~"));
        assert!(String::from_utf8(encoded).unwrap().contains("hello\nworld"));
    }

    #[test]
    fn ghostty_terminal_state_anchors_resize_to_tracked_row() {
        let mut terminal = GhosttyTerminalState::new(12, 4).unwrap();
        for index in 0..12 {
            terminal.write(format!("line {index:02}\r\n").as_bytes());
        }
        terminal.scroll_bottom();
        let tail = terminal.frame().unwrap();
        assert!(tail.scrollback.viewport_offset > 2);

        terminal
            .resize_with_anchor(
                12,
                5,
                Some(TerminalResizeAnchor {
                    stable_id: 2,
                    col: 0,
                }),
            )
            .unwrap();
        let anchored = terminal.frame().unwrap();

        assert_eq!(anchored.scrollback.viewport_offset, 2);
        assert_eq!(anchored.dirty, TerminalDirtyState::Full);
    }

    #[test]
    fn ghostty_terminal_state_preserves_truecolor_cells() {
        let mut terminal = GhosttyTerminalState::new(40, 4).unwrap();
        terminal.write(b"\x1b[38;2;1;2;3mfg\x1b[48;2;4;5;6mbg\x1b[0m\r\n");
        let frame = terminal.frame().unwrap();
        let styled_cell = frame.rows[0]
            .cells
            .iter()
            .find(|cell| cell.text == "f")
            .expect("styled foreground cell should render");
        let background_cell = frame.rows[0]
            .cells
            .iter()
            .find(|cell| cell.text == "b")
            .expect("styled background cell should render");

        assert_eq!(styled_cell.fg, Some(TerminalColor { r: 1, g: 2, b: 3 }));
        assert_eq!(background_cell.fg, Some(TerminalColor { r: 1, g: 2, b: 3 }));
        assert_eq!(background_cell.bg, Some(TerminalColor { r: 4, g: 5, b: 6 }));
    }

    #[test]
    fn ghostty_terminal_state_preserves_inverse_video_style() {
        let mut terminal = GhosttyTerminalState::new(24, 4).unwrap();
        terminal.write(b"normal \x1b[7minverse\x1b[0m\r\n");
        let frame = terminal.frame().unwrap();
        let inverse_cell = frame.rows[0]
            .cells
            .iter()
            .find(|cell| cell.text == "i")
            .expect("inverse video cell should render");

        assert!(inverse_cell.style.inverse);
    }

    #[test]
    fn ghostty_terminal_state_preserves_text_decoration_styles() {
        let mut terminal = GhosttyTerminalState::new(40, 4).unwrap();
        terminal.write(
            b"\x1b[2mfaint\x1b[0m \x1b[5mblink\x1b[0m \x1b[8minvis\x1b[0m \x1b[9mstrike\x1b[0m \x1b[53mover\x1b[0m\r\n",
        );
        let frame = terminal.frame().unwrap();
        let faint_cell = frame.rows[0]
            .cells
            .iter()
            .find(|cell| cell.text == "f")
            .expect("faint cell should render");
        let blink_cell = frame.rows[0]
            .cells
            .iter()
            .find(|cell| cell.text == "b")
            .expect("blink cell should render");
        let invisible_cell = frame.rows[0]
            .cells
            .iter()
            .find(|cell| cell.text == "v")
            .expect("invisible cell should render");
        let strike_cell = frame.rows[0]
            .cells
            .iter()
            .find(|cell| cell.text == "r")
            .expect("strikethrough cell should render");
        let overline_cell = frame.rows[0]
            .cells
            .iter()
            .find(|cell| cell.text == "o")
            .expect("overline cell should render");

        assert!(faint_cell.style.faint);
        assert!(blink_cell.style.blink);
        assert!(invisible_cell.style.invisible);
        assert!(strike_cell.style.strikethrough);
        assert!(overline_cell.style.overline);
    }

    #[test]
    fn ghostty_terminal_state_preserves_cortex_startup_truecolor() {
        let mut terminal = GhosttyTerminalState::new(96, 16).unwrap();
        terminal.write(
            b"\x1b[?2004h\x1b[?u\x1b[?25l\x1b[?2026h\x1b[0m\x1b]8;;\x07\r\r\n\
              \x1b[38;2;0;229;204mCORETEXT\x1b[39m\x1b[0m\x1b]8;;\x07\r\r\n\
              \x1b[38;2;107;114;128m  v0.2.4\x1b[39m\x1b[0m\x1b]8;;\x07\r\r\n\
              \x1b[38;2;0;133;119m----------\x1b[39m\x1b[0m\r\n",
        );
        let frame = terminal.frame().unwrap();
        let cells = frame
            .rows
            .iter()
            .flat_map(|row| row.cells.iter())
            .collect::<Vec<_>>();
        let logo_cell = cells
            .iter()
            .find(|cell| cell.text == "C")
            .expect("Cortex logo cell should render");
        let version_cell = cells
            .iter()
            .find(|cell| cell.text == "v")
            .expect("Cortex version cell should render");
        let divider_cell = cells
            .iter()
            .find(|cell| cell.text == "-")
            .expect("Cortex divider cell should render");

        assert_eq!(
            logo_cell.fg,
            Some(TerminalColor {
                r: 0,
                g: 229,
                b: 204
            })
        );
        assert_eq!(
            version_cell.fg,
            Some(TerminalColor {
                r: 107,
                g: 114,
                b: 128
            })
        );
        assert_eq!(
            divider_cell.fg,
            Some(TerminalColor {
                r: 0,
                g: 133,
                b: 119
            })
        );
    }

    #[test]
    fn ghostty_terminal_state_exposes_input_modes_to_frontend() {
        let mut terminal = GhosttyTerminalState::new(40, 8).unwrap();
        terminal.write(b"\x1b[?1h\x1b[?66h\x1b[?2004h\x1b[?2026h\x1b[?1049h");
        let frame = terminal.frame().unwrap();

        assert!(frame.modes.cursor_key_application);
        assert!(frame.modes.keypad_key_application);
        assert!(frame.modes.bracketed_paste);
        assert!(frame.modes.sync_output);
        assert!(frame.modes.alternate_screen);

        terminal.write(b"\x1b[?1l\x1b[?66l\x1b[?2004l\x1b[?2026l\x1b[?1049l");
        let frame = terminal.frame().unwrap();

        assert!(!frame.modes.cursor_key_application);
        assert!(!frame.modes.keypad_key_application);
        assert!(!frame.modes.bracketed_paste);
        assert!(!frame.modes.sync_output);
        assert!(!frame.modes.alternate_screen);
    }

    #[test]
    fn ghostty_terminal_state_preserves_alternate_screen_redraw_rows() {
        let mut terminal = GhosttyTerminalState::new(40, 6).unwrap();
        terminal.write(b"\x1b[?1049h\x1b[Hstatus-one\r\nstable-line");
        let first = terminal.frame().unwrap();

        assert!(first.modes.alternate_screen);
        assert_eq!(first.rows[0].plain_text().trim_end(), "status-one");
        assert_eq!(first.rows[1].plain_text().trim_end(), "stable-line");

        terminal.write(b"\x1b[Hstatus-two");
        let second = terminal.frame().unwrap();

        assert!(second.modes.alternate_screen);
        assert_eq!(second.dirty, TerminalDirtyState::Partial);
        assert!(
            second
                .rows
                .iter()
                .any(|row| row.index == 0 && row.plain_text().trim_end() == "status-two")
        );
        assert!(second.rows.iter().all(|row| row.dirty));
        assert!(second.rows.iter().any(|row| row.index == 0 && row.dirty));
        assert!(!second.rows.iter().any(|row| row.index == 1));
    }

    #[test]
    fn changed_rows_ignores_stale_dirty_flags() {
        let mut previous = test_frame(TerminalDirtyState::Full, 3);
        let mut current = test_frame(TerminalDirtyState::Full, 3);
        previous.rows[1].cells.push(test_cell("old"));
        current.rows[1].cells.push(test_cell("new"));
        current.rows[2].dirty = true;

        let rows = changed_rows(&previous.rows, 0, &current.rows, 0);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].index, 1);
        assert!(rows[0].dirty);
        assert_eq!(rows[0].plain_text(), "new");
    }

    #[test]
    fn changed_rows_matches_scrolled_rows_by_absolute_position() {
        let mut previous = test_frame(TerminalDirtyState::Full, 3);
        previous.scrollback.viewport_offset = 10;
        previous.rows[0].cells.push(test_cell("ten"));
        previous.rows[1].cells.push(test_cell("eleven"));
        previous.rows[2].cells.push(test_cell("twelve"));

        let mut current = test_frame(TerminalDirtyState::Full, 3);
        current.scrollback.viewport_offset = 11;
        current.rows[0].cells.push(test_cell("eleven"));
        current.rows[1].cells.push(test_cell("twelve"));
        current.rows[2].cells.push(test_cell("thirteen"));

        let rows = changed_rows(
            &previous.rows,
            previous.scrollback.viewport_offset,
            &current.rows,
            current.scrollback.viewport_offset,
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].index, 2);
        assert_eq!(rows[0].plain_text(), "thirteen");
    }

    #[test]
    fn ghostty_terminal_state_resize_reflows_primary_screen() {
        let mut terminal = GhosttyTerminalState::new(24, 8).unwrap();
        terminal.write(b"reverie resize proof keeps wrapped text intact across shape change\r\n");
        let initial = terminal.frame().unwrap();

        terminal.resize(48, 8).unwrap();
        let resized = terminal.frame().unwrap();

        let initial_non_empty_rows = count_non_empty_rows(&initial);
        let resized_non_empty_rows = count_non_empty_rows(&resized);
        let resized_text = compact_frame_text(&resized);

        assert!(resized_text.contains("reverieresizeproofkeepswrappedtextintactacrossshapechange"));
        assert!(initial_non_empty_rows > resized_non_empty_rows);
        assert_eq!(resized.rows.len(), 8);
    }

    #[test]
    fn ghostty_terminal_state_forces_full_frame_after_resize() {
        let mut terminal = GhosttyTerminalState::new(24, 4).unwrap();
        terminal.write(b"resize dirty proof\r\n");
        let _ = terminal.frame().unwrap();

        terminal.resize(32, 4).unwrap();
        let resized = terminal.frame().unwrap();

        assert_eq!(resized.dirty, TerminalDirtyState::Full);
        assert!(resized.rows.iter().all(|row| row.dirty));
    }

    #[test]
    fn scroll_bottom_does_not_force_clean_tail_frame_full() {
        let mut terminal = GhosttyTerminalState::new(24, 4).unwrap();
        terminal.write(b"status-one\r\nstable-line");
        let _ = terminal.frame().unwrap();

        terminal.scroll_bottom();
        let _ = terminal.frame().unwrap();
        terminal.scroll_bottom();
        let frame = terminal.frame().unwrap();

        assert_eq!(frame.dirty, TerminalDirtyState::Clean);
        assert!(frame.rows.is_empty());
    }

    #[test]
    fn ghostty_terminal_state_sends_partial_rows_when_viewport_offset_changes() {
        let mut terminal = GhosttyTerminalState::new(24, 3).unwrap();
        for _ in 0..4 {
            terminal.write(b"repeat\r\n");
        }
        let before = terminal.frame().unwrap();

        terminal.write(b"repeat\r\n");
        let after = terminal.frame().unwrap();

        assert!(
            after.scrollback.viewport_offset > before.scrollback.viewport_offset,
            "test setup must advance the viewport offset"
        );
        assert_eq!(after.dirty, TerminalDirtyState::Partial);
        assert!(after.rows.len() < 3);
        assert!(after.rows.iter().any(|row| row.index == 2));
        assert!(after.rows.iter().all(|row| row.dirty));
    }

    #[test]
    fn read_rows_serves_a_history_band_from_the_top() {
        // 30 lines into a 3-row viewport leaves a deep scrollback to serve from.
        let mut terminal = GhosttyTerminalState::new(10, 3).unwrap();
        for index in 1..=30 {
            terminal.write(format!("L{index:02}\r\n").as_bytes());
        }
        terminal.scroll_bottom();
        let _ = terminal.frame().unwrap();

        // Serve the first five rows of history (taller than the 3-row viewport,
        // so read_rows must step the pin down to gather them all).
        let band = terminal.read_rows(0, 5).unwrap();
        let text = band
            .iter()
            .map(TerminalRow::plain_text)
            .map(|line| line.trim_end().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(text, vec!["L01", "L02", "L03", "L04", "L05"]);
        // Band rows are contiguous and 0-based within the band.
        assert_eq!(
            band.iter().map(|row| row.index).collect::<Vec<_>>(),
            vec![0, 1, 2, 3, 4]
        );
    }

    #[test]
    fn read_rows_serves_a_band_from_the_middle() {
        let mut terminal = GhosttyTerminalState::new(10, 3).unwrap();
        for index in 1..=30 {
            terminal.write(format!("L{index:02}\r\n").as_bytes());
        }
        terminal.scroll_bottom();
        let _ = terminal.frame().unwrap();

        // Rows 9..13 (0-based absolute) correspond to L10..L14.
        let band = terminal.read_rows(9, 4).unwrap();
        let text = band
            .iter()
            .map(TerminalRow::plain_text)
            .map(|line| line.trim_end().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(text, vec!["L10", "L11", "L12", "L13"]);
    }

    #[test]
    fn read_rows_restores_the_pin_so_the_next_live_extract_shows_the_tail() {
        let mut terminal = GhosttyTerminalState::new(10, 3).unwrap();
        for index in 1..=30 {
            terminal.write(format!("L{index:02}\r\n").as_bytes());
        }
        terminal.scroll_bottom();
        // Drain the seed frame; the viewport is now at the tail.
        let tail_before = terminal.frame().unwrap();
        assert!(tail_before.scrollback.at_bottom);

        // Serve a history band from the top: this moves the pin deep into
        // scrollback to extract those rows.
        let band = terminal.read_rows(0, 5).unwrap();
        assert_eq!(band.len(), 5);

        // The very next live extract must still show the active tail, proving the
        // serve restored the pin (scroll_bottom) before returning. After the
        // empty trailing line the last printed line L30 sits one row up.
        let after = terminal.frame().unwrap();
        assert!(
            after.scrollback.at_bottom,
            "pin must be back at the active area after a serve"
        );
        // A serve forces the next frame Full (the pin moved), so the tail repaints
        // cleanly rather than diffing against a stale scrolled baseline.
        assert_eq!(after.dirty, TerminalDirtyState::Full);
        let tail_text = after
            .rows
            .iter()
            .map(TerminalRow::plain_text)
            .map(|line| line.trim_end().to_owned())
            .collect::<Vec<_>>();
        assert!(
            tail_text.iter().any(|line| line == "L30"),
            "tail should show the latest output after the serve, got {tail_text:?}"
        );
    }

    #[test]
    fn read_rows_returns_empty_past_the_buffer_and_still_restores_the_pin() {
        let mut terminal = GhosttyTerminalState::new(10, 3).unwrap();
        for index in 1..=12 {
            terminal.write(format!("L{index:02}\r\n").as_bytes());
        }
        terminal.scroll_bottom();
        let _ = terminal.frame().unwrap();

        let total = terminal.total_rows().unwrap();
        let band = terminal.read_rows(total + 5, 4).unwrap();
        assert!(band.is_empty(), "a request past the buffer returns no rows");

        // Even the empty path restores the pin to the tail.
        let after = terminal.frame().unwrap();
        assert!(after.scrollback.at_bottom);
    }

    #[test]
    fn read_rows_clamps_count_to_the_available_buffer() {
        let mut terminal = GhosttyTerminalState::new(10, 3).unwrap();
        for index in 1..=8 {
            terminal.write(format!("L{index:02}\r\n").as_bytes());
        }
        terminal.scroll_bottom();
        let _ = terminal.frame().unwrap();

        let total = terminal.total_rows().unwrap();
        // Ask for far more rows than exist: the band is bounded by the buffer.
        let band = terminal.read_rows(0, total + 1_000).unwrap();
        assert_eq!(band.len(), total);
        assert_eq!(
            band.iter().map(|row| row.index).collect::<Vec<_>>(),
            (0..total as u16).collect::<Vec<_>>()
        );
    }

    #[test]
    fn read_rows_restores_the_pin_even_when_the_inner_serve_takes_an_early_exit() {
        // `read_rows` splits into `read_rows_inner` (the serve loop, which can
        // `?`-return early or error) plus an UNCONDITIONAL pin restore in the
        // outer wrapper. This guards the early-exit path: even when the inner
        // serve does no work (here `count == 0`, an early `Ok` return before the
        // loop), and even after the pin was already parked in scrollback by a
        // prior serve, the outer restore must put it back on the tail. The same
        // wrapper restores the pin if the inner serve errors mid-loop, so a failed
        // read can never leave the next live extract painting a history excursion.
        let mut terminal = GhosttyTerminalState::new(10, 3).unwrap();
        for index in 1..=20 {
            terminal.write(format!("L{index:02}\r\n").as_bytes());
        }
        terminal.scroll_bottom();
        let _ = terminal.frame().unwrap();

        // Park the pin deep in scrollback via a normal serve...
        let _ = terminal.read_rows(0, 5).unwrap();
        // ...then a no-op serve (count == 0) takes the inner early exit. The outer
        // wrapper still restores the pin.
        let band = terminal.read_rows(0, 0).unwrap();
        assert!(band.is_empty());

        let after = terminal.frame().unwrap();
        assert!(
            after.scrollback.at_bottom,
            "the unconditional restore must put the pin back on the tail on any exit path"
        );
    }

    #[test]
    fn oldest_id_is_zero_below_the_scrollback_cap() {
        // A generous cap (the production dial) never evicts for a short session,
        // so the stable-id floor stays 0 and id == buffer position (D8).
        let mut terminal = GhosttyTerminalState::new(40, 8).unwrap();
        for index in 1..=200 {
            terminal.write(format!("line {index:04}\r\n").as_bytes());
        }
        assert_eq!(
            terminal.oldest_id(),
            0,
            "no eviction below the cap, so the id floor stays 0"
        );
    }

    #[test]
    fn oldest_id_advances_when_the_buffer_evicts() {
        // A small byte cap so eviction triggers after about a page instead of
        // 100 MB. Writing far more rows than the cap can hold forces libghostty
        // to prune the oldest pages, which `observe_eviction` infers from the
        // resulting drops in `total_rows`.
        let mut terminal =
            GhosttyTerminalState::new_with_scrollback_limit(40, 10, 512 * 1024).unwrap();
        assert_eq!(terminal.oldest_id(), 0);

        let written = 30_000_u64;
        for index in 1..=written {
            terminal.write(format!("line {index:05}\r\n").as_bytes());
        }

        let total = terminal.total_rows().unwrap() as u64;
        assert!(
            total < written,
            "the byte cap should have evicted rows (total={total}, written={written})"
        );
        let oldest_id = terminal.oldest_id();
        assert!(
            oldest_id > 0,
            "eviction must advance the stable-id floor (oldest_id={oldest_id})"
        );
        // The floor plus what remains should closely track everything written:
        // every row is either still buffered or counted as evicted. The count is
        // best-effort (D8) and can under-count, but under line-by-line writes
        // (where `observe_eviction` runs after every line and catches each page
        // prune) the gap is tiny, never a wild divergence. NOTE: production
        // coalesces PTY chunks (`drain_pty_read_batch`), so batched writes drift
        // far more by design; Phase B's anchor reconciliation is what closes that,
        // and its tests should exercise the batched/giant-write path.
        let accounted = oldest_id + total;
        assert!(
            written.abs_diff(accounted) < 512,
            "evicted + remaining should closely track what was written \
             (oldest_id={oldest_id}, total={total}, written={written}, accounted={accounted})"
        );
    }

    #[test]
    fn resize_does_not_miscount_reflow_as_eviction() {
        // Wrapped content at 24 cols occupies several rows; widening unwraps it
        // to fewer rows, so `total_rows` DROPS for a non-eviction reason. Without
        // the resize rebaseline, the next write would miscount that drop as
        // eviction; with it, the id floor stays 0 (nothing actually evicted).
        let mut terminal = GhosttyTerminalState::new(24, 4).unwrap();
        terminal.write(b"reverie resize proof keeps wrapped text intact across a shape change\r\n");
        assert_eq!(terminal.oldest_id(), 0);

        terminal.resize(80, 4).unwrap();
        // A write after the resize is what triggers `observe_eviction`; the
        // rebaseline must have absorbed the reflow row-count drop.
        terminal.write(b"after resize\r\n");
        assert_eq!(
            terminal.oldest_id(),
            0,
            "reflow shrinking total_rows must not be miscounted as eviction"
        );
    }

    #[test]
    fn oldest_id_absorbs_a_scrollback_clear_consistently() {
        // Accumulate scrollback well below the cap (no real eviction), then send
        // ED 3 (erase saved lines / clear scrollback). It shrinks total_rows, which
        // the best-effort observer folds into oldest_id as if it were eviction.
        // That over-count is harmless because it is SYMMETRIC: the floor advances
        // by exactly the rows that left, so the frontend (which realigns by the
        // same reported oldest_id) stays internally consistent (D8, scenario C).
        let mut terminal = GhosttyTerminalState::new(20, 4).unwrap();
        for index in 1..=200 {
            terminal.write(format!("L{index:03}\r\n").as_bytes());
        }
        let total_before = terminal.total_rows().unwrap();
        assert!(total_before > 4, "scrollback should have accumulated");
        assert_eq!(terminal.oldest_id(), 0, "no real eviction below the cap");

        terminal.write(b"\x1b[3J");
        let total_after = terminal.total_rows().unwrap();
        let oldest_after = terminal.oldest_id();

        // total_rows never grows from ED 3, and whatever rows it removed are folded
        // into oldest_id one-for-one (floor + remaining stays conserved).
        assert!(total_after <= total_before);
        assert_eq!(
            oldest_after,
            (total_before - total_after) as u64,
            "the scrollback-clear drop is absorbed into oldest_id symmetrically"
        );
    }

    fn count_non_empty_rows(frame: &TerminalFrame) -> usize {
        frame
            .rows
            .iter()
            .map(TerminalRow::plain_text)
            .filter(|row| !row.trim().is_empty())
            .count()
    }

    fn compact_frame_text(frame: &TerminalFrame) -> String {
        frame
            .rows
            .iter()
            .map(TerminalRow::plain_text)
            .collect::<Vec<_>>()
            .join("")
            .chars()
            .filter(|ch| !ch.is_whitespace())
            .collect::<String>()
    }

    fn test_frame(dirty: TerminalDirtyState, rows: u16) -> TerminalFrame {
        TerminalFrame {
            dirty,
            cols: 0,
            colors: TerminalColors {
                foreground: TerminalColor {
                    r: 255,
                    g: 255,
                    b: 255,
                },
                background: TerminalColor { r: 0, g: 0, b: 0 },
                cursor: None,
            },
            cursor: TerminalCursor {
                visible: false,
                blinking: false,
                style: TerminalCursorStyle::Block,
                position: None,
            },
            modes: TerminalModes::default(),
            scrollback: TerminalScrollback::default(),
            rows: (0..rows)
                .map(|index| TerminalRow {
                    index,
                    dirty: true,
                    cells: Vec::new(),
                })
                .collect(),
        }
    }

    fn test_cell(text: &str) -> TerminalCell {
        TerminalCell {
            col: 0,
            width: 1,
            text: text.to_owned(),
            fg: None,
            bg: None,
            style: TerminalCellStyle {
                bold: false,
                italic: false,
                faint: false,
                blink: false,
                invisible: false,
                underline: TerminalUnderline::None,
                inverse: false,
                strikethrough: false,
                overline: false,
            },
        }
    }
}
