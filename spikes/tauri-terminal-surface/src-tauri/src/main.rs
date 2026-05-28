use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use anyhow::Result;
use libghostty_vt::render::{CellIterator, CursorVisualStyle, Dirty, RowIterator};
use libghostty_vt::style::{RgbColor, Style, Underline as GhosttyUnderline};
use libghostty_vt::{RenderState, Terminal, TerminalOptions};
use reverie_core::terminal::{
    TerminalCell, TerminalCellStyle, TerminalColor, TerminalColors, TerminalCursor,
    TerminalCursorStyle, TerminalDirtyState, TerminalFrame, TerminalPosition, TerminalRow,
    TerminalUnderline,
};
use serde::Serialize;

const COLS: u16 = 96;
const ROWS: u16 = 24;

#[derive(Debug, Serialize)]
struct TerminalSurfaceFixture {
    cols: u16,
    rows: u16,
    line_count: usize,
    batch_size: usize,
    frames: Vec<TerminalSurfaceFrame>,
    vt_bytes: usize,
    ghostty_extract_ms: f64,
}

#[derive(Debug, Serialize)]
struct TerminalSurfaceFrame {
    dirty: TerminalDirtyState,
    colors: TerminalColors,
    cursor: TerminalCursor,
    rows: Vec<TerminalSurfaceRow>,
}

#[derive(Debug, Serialize)]
struct TerminalSurfaceRow {
    index: u16,
    dirty: bool,
    text: String,
}

#[tauri::command]
fn terminal_surface_fixture(
    line_count: usize,
    batch_size: usize,
) -> Result<TerminalSurfaceFixture, String> {
    build_terminal_surface_fixture(line_count, batch_size).map_err(|err| err.to_string())
}

#[tauri::command]
fn record_terminal_surface_result(
    app: tauri::AppHandle,
    result_json: String,
) -> Result<(), String> {
    let spike_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "failed to locate spike root".to_string())?
        .to_path_buf();
    let results_dir = spike_root.join("results");
    fs::create_dir_all(&results_dir).map_err(|err| err.to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_str(&result_json).map_err(|err| err.to_string())?;
    fs::write(
        results_dir.join("latest.json"),
        serde_json::to_vec_pretty(&parsed).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;
    eprintln!("recorded terminal surface result");
    app.exit(0);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            terminal_surface_fixture,
            record_terminal_surface_result
        ])
        .run(tauri::generate_context!())
        .expect("error while running Reverie terminal surface spike");
}

fn build_terminal_surface_fixture(
    line_count: usize,
    batch_size: usize,
) -> Result<TerminalSurfaceFixture> {
    let line_count = line_count.clamp(250, 5_000);
    let batch_size = batch_size.clamp(1, 100);
    let mut terminal = Terminal::new(TerminalOptions {
        cols: COLS,
        rows: ROWS,
        max_scrollback: line_count + ROWS as usize + 100,
    })?;
    let mut render_state = RenderState::new()?;
    let started = Instant::now();
    let mut frames = Vec::new();
    let mut vt_bytes = 0_usize;

    terminal.vt_write(b"\x1b[1;36mReverie Ghostty -> Tauri render surface proof\x1b[0m\r\n");
    vt_bytes += 58;

    for line in 1..=line_count {
        let fg_r = (line * 31 % 255) as u8;
        let fg_g = (line * 67 % 255) as u8;
        let fg_b = (line * 97 % 255) as u8;
        let payload = format!(
            "\x1b[38;2;{fg_r};{fg_g};{fg_b}mreverie-surface-line-{line:04} payload abcdefghijklmnopqrstuvwxyz 0123456789\x1b[0m\r\n"
        );
        vt_bytes += payload.len();
        terminal.vt_write(payload.as_bytes());

        if line % batch_size == 0 {
            frames.push(extract_surface_frame(&mut render_state, &terminal)?);
        }
    }

    terminal.vt_write(b"\x1b[4msurface-render-complete\x1b[0m\r\n");
    vt_bytes += 37;
    frames.push(extract_surface_frame(&mut render_state, &terminal)?);

    Ok(TerminalSurfaceFixture {
        cols: COLS,
        rows: ROWS,
        line_count,
        batch_size,
        frames,
        vt_bytes,
        ghostty_extract_ms: started.elapsed().as_secs_f64() * 1_000.0,
    })
}

fn extract_surface_frame<'alloc, 'cb>(
    render_state: &mut RenderState<'alloc>,
    terminal: &Terminal<'alloc, 'cb>,
) -> Result<TerminalSurfaceFrame> {
    let frame = extract_frame(render_state, terminal)?;
    Ok(TerminalSurfaceFrame {
        dirty: frame.dirty,
        colors: frame.colors,
        cursor: frame.cursor,
        rows: frame
            .rows
            .into_iter()
            .map(|row| TerminalSurfaceRow {
                index: row.index,
                dirty: row.dirty,
                text: row.plain_text(),
            })
            .collect(),
    })
}

fn extract_frame<'alloc, 'cb>(
    render_state: &mut RenderState<'alloc>,
    terminal: &Terminal<'alloc, 'cb>,
) -> Result<TerminalFrame> {
    let snapshot = render_state.update(terminal)?;
    let colors = snapshot.colors()?;
    let cursor_viewport = snapshot.cursor_viewport()?;
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
