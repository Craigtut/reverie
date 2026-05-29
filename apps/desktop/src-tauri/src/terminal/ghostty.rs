use anyhow::Result;
use libghostty_vt::render::{CellIterator, CursorVisualStyle, Dirty, RowIterator};
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

/// Ghostty-backed terminal state for converting VT byte streams into Reverie frames.
///
/// This module intentionally has no Tauri command/event knowledge and no product
/// session semantics. App services can feed it bytes from any PTY/runtime source
/// and receive the stable `TerminalFrame` shape used by the frontend renderer.
pub struct GhosttyTerminalState<'alloc, 'cb> {
    terminal: Terminal<'alloc, 'cb>,
    render_state: RenderState<'alloc>,
    force_next_full_frame: bool,
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
        })
    }

    pub fn write(&mut self, bytes: &[u8]) {
        self.terminal.vt_write(bytes);
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
        self.terminal.scroll_viewport(ScrollViewport::Bottom);
        self.force_next_full_frame = true;
    }

    pub fn is_viewport_at_bottom(&self) -> Result<bool> {
        let scrollbar = self.terminal.scrollbar()?;
        Ok(scrollbar.offset.saturating_add(scrollbar.len) >= scrollbar.total)
    }

    pub fn frame(&mut self) -> Result<TerminalFrame> {
        let mut frame = extract_frame(&mut self.render_state, &self.terminal)?;
        if std::mem::take(&mut self.force_next_full_frame) {
            frame.dirty = TerminalDirtyState::Full;
            for row in &mut frame.rows {
                row.dirty = true;
            }
        }
        Ok(frame)
    }
}

fn extract_frame<'alloc, 'cb>(
    render_state: &mut RenderState<'alloc>,
    terminal: &Terminal<'alloc, 'cb>,
) -> Result<TerminalFrame> {
    let snapshot = render_state.update(terminal)?;
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
            let text = cell_text(cell)?;
            let style = cell.style()?;

            cells.push(TerminalCell {
                col,
                text,
                fg: cell.fg_color()?.map(map_color),
                bg: cell.bg_color()?.map(map_color),
                style: map_cell_style(style),
            });

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
        dirty: map_dirty(snapshot.dirty()?),
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
        underline: map_underline(style.underline),
        inverse: style.inverse,
    }
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
    fn ghostty_terminal_state_preserves_truecolor_cells() {
        let mut terminal = GhosttyTerminalState::new(24, 4, 100).unwrap();
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
        terminal.write(b"\x1b[?1h\x1b[?66h\x1b[?2004h\x1b[?2026h");
        let frame = terminal.frame().unwrap();

        assert!(frame.modes.cursor_key_application);
        assert!(frame.modes.keypad_key_application);
        assert!(frame.modes.bracketed_paste);
        assert!(frame.modes.sync_output);

        terminal.write(b"\x1b[?1l\x1b[?66l\x1b[?2004l\x1b[?2026l");
        let frame = terminal.frame().unwrap();

        assert!(!frame.modes.cursor_key_application);
        assert!(!frame.modes.keypad_key_application);
        assert!(!frame.modes.bracketed_paste);
        assert!(!frame.modes.sync_output);
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
}
