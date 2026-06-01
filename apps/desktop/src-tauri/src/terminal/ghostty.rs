use anyhow::Result;
use std::collections::HashMap;

use libghostty_vt::ffi;
use libghostty_vt::render::{CellIterator, CursorVisualStyle, Dirty, RowIterator};
use libghostty_vt::screen::CellWide;
use libghostty_vt::style::{RgbColor, Style, Underline as GhosttyUnderline};
use libghostty_vt::terminal::{Mode, ScrollViewport};
use libghostty_vt::{RenderState, Terminal, TerminalOptions};
use reverie_core::terminal::{
    TerminalCell, TerminalCellStyle, TerminalColor, TerminalColors, TerminalCursor,
    TerminalCursorStyle, TerminalDirtyState, TerminalFrame, TerminalModes, TerminalPosition,
    TerminalRow, TerminalScrollback, TerminalUnderline,
};

const DEFAULT_CELL_WIDTH_PX: u32 = 9;
const DEFAULT_CELL_HEIGHT_PX: u32 = 18;
const SCROLLBACK_BYTES_PER_CELL: usize = 16;
const MIN_SCROLLBACK_BYTES: usize = 1024 * 1024;

/// Ghostty-backed terminal state for converting VT byte streams into Reverie frames.
///
/// This module intentionally has no Tauri command/event knowledge and no product
/// session semantics. App services can feed it bytes from any PTY/runtime source
/// and receive the stable `TerminalFrame` shape used by the frontend renderer.
pub struct GhosttyTerminalState<'alloc, 'cb> {
    terminal: Terminal<'alloc, 'cb>,
    render_state: RenderState<'alloc>,
    force_next_full_frame: bool,
    last_frame: Option<TerminalFrame>,
}

impl<'alloc, 'cb> GhosttyTerminalState<'alloc, 'cb> {
    pub fn new(cols: u16, rows: u16, max_scrollback: usize) -> Result<Self> {
        Ok(Self {
            terminal: Terminal::new(TerminalOptions {
                cols,
                rows,
                max_scrollback,
            })?,
            render_state: RenderState::new()?,
            force_next_full_frame: true,
            last_frame: None,
        })
    }

    pub fn write(&mut self, bytes: &[u8]) {
        self.terminal.vt_write(bytes);
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

    /// Seed the terminal's default foreground/background by feeding Ghostty OSC 10
    /// (foreground) and OSC 11 (background). libghostty-vt has no color config on
    /// `TerminalOptions`, so without this the render state reports its hardwired
    /// white-on-black default; after this, `colors()` reflects the active theme.
    ///
    /// NOTE: this is NOT the paint path. The frontend Canvas renderer is the
    /// authoritative source for the painted default colors: it draws from the
    /// shell theme and ignores `frame.colors`, because the theme is tied to the
    /// shell's CSS and must re-theme live, exited, and cached sessions instantly
    /// on a light/dark toggle (a VT-side default can't re-theme an exited session
    /// without replaying it). So this call is currently a forward-looking mirror
    /// that keeps the VT model honest. It becomes load-bearing only if/when
    /// libghostty-vt can answer OSC 10/11 color *queries* (letting a CLI auto-pick
    /// a matching theme); 0.1.1 cannot, so nothing consumes these values yet.
    /// Forces a full frame so the change repaints everywhere.
    pub fn set_default_colors(&mut self, foreground: TerminalColor, background: TerminalColor) {
        self.write(&osc_set_color(10, foreground));
        self.write(&osc_set_color(11, background));
        self.force_next_full_frame = true;
    }

    pub fn on_pty_write(
        &mut self,
        mut callback: impl for<'data> FnMut(&'data [u8]) + 'cb,
    ) -> Result<()> {
        self.terminal
            .on_pty_write(move |_terminal, data| callback(data))?;
        Ok(())
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.terminal
            .resize(cols, rows, DEFAULT_CELL_WIDTH_PX, DEFAULT_CELL_HEIGHT_PX)?;
        self.force_next_full_frame = true;
        Ok(())
    }

    pub fn scroll_delta(&mut self, rows: isize) {
        self.terminal.scroll_viewport(ScrollViewport::Delta(rows));
        self.force_next_full_frame = true;
    }

    pub fn scroll_top(&mut self) {
        self.terminal.scroll_viewport(ScrollViewport::Top);
        self.force_next_full_frame = true;
    }

    pub fn scroll_bottom(&mut self) {
        if matches!(self.is_viewport_at_bottom(), Ok(true)) {
            return;
        }
        self.terminal.scroll_viewport(ScrollViewport::Bottom);
        self.force_next_full_frame = true;
    }

    pub fn is_viewport_at_bottom(&self) -> Result<bool> {
        let scrollbar = self.terminal.scrollbar()?;
        Ok(scrollbar.offset.saturating_add(scrollbar.len) >= scrollbar.total)
    }

    /// Total rows currently held in libghostty's live buffer (scrollback +
    /// viewport). Retained for the live-buffer scroll-back work that serves
    /// history ranges straight from libghostty (see decisions.md D6/D7).
    #[allow(dead_code)]
    pub fn total_rows(&self) -> Result<usize> {
        Ok(self.terminal.total_rows()?)
    }

    /// Scroll the viewport so screen row `row` is visible, aimed about a third
    /// down from the top for context. Implemented as a delta because
    /// libghostty-vt exposes only relative/top/bottom scrolling.
    pub fn scroll_to_row(&mut self, row: usize) -> Result<()> {
        let scrollbar = self.terminal.scrollbar()?;
        let total = scrollbar.total as usize;
        let len = scrollbar.len as usize;
        let offset = scrollbar.offset as usize;
        let max_offset = total.saturating_sub(len);
        let target = row.saturating_sub(len / 3).min(max_offset);
        let delta = target as isize - offset as isize;
        if delta != 0 {
            self.terminal.scroll_viewport(ScrollViewport::Delta(delta));
            self.force_next_full_frame = true;
        }
        Ok(())
    }

    /// Scroll the viewport so `row` is the first rendered row, clamped to the
    /// last valid viewport start. Unlike `scroll_to_row`, this is exact.
    /// Retained for the live-buffer scroll-back work (decisions.md D6/D7).
    #[allow(dead_code)]
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
        let frame = extract_frame(&mut self.render_state, &self.terminal)?;
        Ok(self.diff_frame(frame, force_full_frame))
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

        let changed_rows = changed_rows(&previous.rows, &frame.rows);
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

/// Convert Reverie's user-facing scrollback row budget to Ghostty's byte budget.
///
/// libghostty-vt names this option `max_scrollback`, but Ghostty's screen
/// implementation treats it as bytes. Keep the app contract in rows and give
/// Ghostty enough backing storage for typical styled terminal cells.
pub fn ghostty_scrollback_bytes_for_rows(rows: usize, cols: u16) -> usize {
    if rows == 0 {
        return 0;
    }
    let cols = usize::from(cols.max(1));
    rows.saturating_mul(cols)
        .saturating_mul(SCROLLBACK_BYTES_PER_CELL)
        .max(MIN_SCROLLBACK_BYTES)
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
        || previous.scrollback.viewport_offset != frame.scrollback.viewport_offset
        || previous.scrollback.viewport_rows != frame.scrollback.viewport_rows
        || frame.scrollback.total_rows < previous.scrollback.total_rows
}

fn changed_rows(previous: &[TerminalRow], current: &[TerminalRow]) -> Vec<TerminalRow> {
    let previous_by_index = previous
        .iter()
        .map(|row| (row.index, row))
        .collect::<HashMap<_, _>>();
    current
        .iter()
        .filter_map(|row| {
            let changed = previous_by_index
                .get(&row.index)
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
            let width = match cell.raw_cell()?.wide()? {
                CellWide::Narrow => 1,
                CellWide::Wide => 2,
                CellWide::SpacerTail | CellWide::SpacerHead => {
                    col = col.saturating_add(1);
                    continue;
                }
            };
            let text = cell_text(cell)?;
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
            alternate_screen: terminal.active_screen()?
                == ffi::GhosttyTerminalScreen_GHOSTTY_TERMINAL_SCREEN_ALTERNATE,
            kitty_keyboard_flags: terminal.kitty_keyboard_flags()?.bits(),
        },
        scrollback: TerminalScrollback {
            total_rows: terminal.total_rows()?,
            scrollback_rows: terminal.scrollback_rows()?,
            viewport_offset: scrollbar_offset,
            viewport_rows: scrollbar_len,
            at_bottom: scrollbar.offset.saturating_add(scrollbar.len) >= scrollbar.total,
        },
        rows,
    })
}

/// Build an `OSC <code>;rgb:rr/gg/bb` (BEL-terminated) sequence. Code 10 sets
/// the default foreground, code 11 the default background.
fn osc_set_color(code: u8, color: TerminalColor) -> Vec<u8> {
    format!(
        "\x1b]{code};rgb:{:02x}/{:02x}/{:02x}\x07",
        color.r, color.g, color.b
    )
    .into_bytes()
}

fn cell_text(cell: &libghostty_vt::render::CellIteration<'_, '_>) -> Result<String> {
    if cell.graphemes_len()? == 0 {
        return Ok(" ".to_string());
    }

    Ok(cell.graphemes()?.into_iter().collect())
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
        let mut terminal = GhosttyTerminalState::new(40, 8, 100).unwrap();
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
    fn ghostty_terminal_state_preserves_wide_cell_widths() {
        let mut terminal = GhosttyTerminalState::new(20, 4, 100).unwrap();
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
    fn ghostty_terminal_state_reports_injected_default_colors() {
        let mut terminal = GhosttyTerminalState::new(20, 4, 50).unwrap();
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
        terminal.set_default_colors(
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
        );
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
    fn ghostty_terminal_state_preserves_truecolor_cells() {
        let mut terminal = GhosttyTerminalState::new(40, 4, 100).unwrap();
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
        let mut terminal = GhosttyTerminalState::new(24, 4, 100).unwrap();
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
        let mut terminal = GhosttyTerminalState::new(40, 4, 100).unwrap();
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
        let mut terminal = GhosttyTerminalState::new(96, 16, 200).unwrap();
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
        let mut terminal = GhosttyTerminalState::new(40, 8, 100).unwrap();
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
        let mut terminal = GhosttyTerminalState::new(40, 6, 100).unwrap();
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

        let rows = changed_rows(&previous.rows, &current.rows);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].index, 1);
        assert!(rows[0].dirty);
        assert_eq!(rows[0].plain_text(), "new");
    }

    #[test]
    fn ghostty_terminal_state_resize_reflows_primary_screen() {
        let mut terminal = GhosttyTerminalState::new(24, 8, 100).unwrap();
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
        let mut terminal = GhosttyTerminalState::new(24, 4, 100).unwrap();
        terminal.write(b"resize dirty proof\r\n");
        let _ = terminal.frame().unwrap();

        terminal.resize(32, 4).unwrap();
        let resized = terminal.frame().unwrap();

        assert_eq!(resized.dirty, TerminalDirtyState::Full);
        assert!(resized.rows.iter().all(|row| row.dirty));
    }

    #[test]
    fn ghostty_terminal_state_forces_full_frame_after_viewport_scroll() {
        let mut terminal = GhosttyTerminalState::new(10, 3, 100).unwrap();
        for index in 1..=10 {
            terminal.write(format!("L{index:02}\r\n").as_bytes());
        }
        terminal.scroll_bottom();
        let _ = terminal.frame().unwrap();

        terminal.scroll_top();
        let top = terminal.frame().unwrap();

        assert_eq!(top.dirty, TerminalDirtyState::Full);
        assert!(top.rows.iter().all(|row| row.dirty));
        assert_eq!(top.rows[0].plain_text().trim_end(), "L01");
    }

    #[test]
    fn scroll_bottom_does_not_force_clean_tail_frame_full() {
        let mut terminal = GhosttyTerminalState::new(24, 4, 100).unwrap();
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
    fn ghostty_terminal_state_forces_full_frame_when_viewport_offset_changes() {
        let mut terminal = GhosttyTerminalState::new(24, 3, 100).unwrap();
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
        assert_eq!(after.dirty, TerminalDirtyState::Full);
        assert_eq!(after.rows.len(), 3);
        assert!(after.rows.iter().all(|row| row.dirty));
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
