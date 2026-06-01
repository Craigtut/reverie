//! Binary frame wire encoding for the terminal Channel transport.
//!
//! This is the concrete little-endian encoding documented in
//! `docs/technical/terminal/wire-protocol.md` ("Binary frame encoding
//! (concrete)"). It serializes a [`TerminalFrame`] plus a per-session
//! `generation` marker into a compact byte buffer. Each `Channel.send` carries
//! exactly one frame message; the Channel preserves message boundaries and
//! order, so there is no inter-message length prefix.
//!
//! [`decode_frame`] is the symmetric Rust decoder. It is used by the unit tests
//! (round-trip + golden) and exists so the encoding has one authoritative
//! reference implementation on the Rust side; the TypeScript decoder in
//! `apps/desktop/web/terminal/wireDecode.ts` mirrors it and is cross-checked
//! against the same golden bytes.
//!
//! This module changes transport + serialization only. The frame semantics are
//! unchanged: rows stay viewport-relative with a scrollback offset, exactly as
//! the existing JSON path produced.

use reverie_core::terminal::{
    TerminalCell, TerminalCellStyle, TerminalColor, TerminalColors, TerminalCursor,
    TerminalCursorStyle, TerminalDirtyState, TerminalFrame, TerminalModes, TerminalPosition,
    TerminalRow, TerminalScrollback, TerminalUnderline,
};

/// Message kind discriminators. `KIND_FRAME` rides the streaming Channel;
/// `KIND_ROW_BAND` is the history-range reply (a request/reply command that
/// returns binary), per `wire-protocol.md` ("History-range request and reply").
const KIND_FRAME: u8 = 1;
const KIND_ROW_BAND: u8 = 2;

/// The decoded result of [`decode_frame`]: the frame plus the generation marker
/// it was stamped with. Used by tests to assert the full round-trip.
///
/// The decoder (`decode_frame` and its helpers, `Reader`, `WireDecodeError`,
/// and the `*_from_code` mappers) is the symmetric reference implementation the
/// round-trip and golden tests exercise. In a non-test build of the desktop
/// binary nothing calls it (the production path only encodes), so it is
/// `#[allow(dead_code)]` rather than `#[cfg(test)]`: keeping it compiled in all
/// builds guarantees the encoder and decoder stay in sync.
#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq)]
pub struct DecodedFrameMessage {
    pub generation: u32,
    pub frame: TerminalFrame,
}

/// The decoded result of [`decode_row_band`]: a contiguous run of rows starting
/// at stable id `start_id`, tagged with the generation they were read at. Used by
/// the round-trip + golden tests (the production path only encodes; the TS
/// `decodeRowBand` is the runtime consumer).
#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq)]
pub struct DecodedRowBand {
    pub generation: u32,
    pub start_id: u64,
    pub rows: Vec<TerminalRow>,
}

// --- dirty-state codes -----------------------------------------------------

const DIRTY_CLEAN: u8 = 0;
const DIRTY_PARTIAL: u8 = 1;
const DIRTY_FULL: u8 = 2;

fn dirty_code(dirty: &TerminalDirtyState) -> u8 {
    match dirty {
        TerminalDirtyState::Clean => DIRTY_CLEAN,
        TerminalDirtyState::Partial => DIRTY_PARTIAL,
        TerminalDirtyState::Full => DIRTY_FULL,
    }
}

#[allow(dead_code)] // decode-only (see DecodedFrameMessage)
fn dirty_from_code(code: u8) -> Result<TerminalDirtyState, WireDecodeError> {
    match code {
        DIRTY_CLEAN => Ok(TerminalDirtyState::Clean),
        DIRTY_PARTIAL => Ok(TerminalDirtyState::Partial),
        DIRTY_FULL => Ok(TerminalDirtyState::Full),
        other => Err(WireDecodeError::InvalidEnum {
            field: "dirty",
            value: other as u32,
        }),
    }
}

// --- cursor-style codes ----------------------------------------------------

const CURSOR_BLOCK: u8 = 0;
const CURSOR_BLOCK_HOLLOW: u8 = 1;
const CURSOR_BAR: u8 = 2;
const CURSOR_UNDERLINE: u8 = 3;

fn cursor_style_code(style: &TerminalCursorStyle) -> u8 {
    match style {
        TerminalCursorStyle::Block => CURSOR_BLOCK,
        TerminalCursorStyle::BlockHollow => CURSOR_BLOCK_HOLLOW,
        TerminalCursorStyle::Bar => CURSOR_BAR,
        TerminalCursorStyle::Underline => CURSOR_UNDERLINE,
    }
}

#[allow(dead_code)] // decode-only (see DecodedFrameMessage)
fn cursor_style_from_code(code: u8) -> Result<TerminalCursorStyle, WireDecodeError> {
    match code {
        CURSOR_BLOCK => Ok(TerminalCursorStyle::Block),
        CURSOR_BLOCK_HOLLOW => Ok(TerminalCursorStyle::BlockHollow),
        CURSOR_BAR => Ok(TerminalCursorStyle::Bar),
        CURSOR_UNDERLINE => Ok(TerminalCursorStyle::Underline),
        other => Err(WireDecodeError::InvalidEnum {
            field: "cursor.style",
            value: other as u32,
        }),
    }
}

// --- cursor flag bits ------------------------------------------------------

const CURSOR_FLAG_VISIBLE: u8 = 1 << 0;
const CURSOR_FLAG_BLINKING: u8 = 1 << 1;
const CURSOR_FLAG_HAS_POSITION: u8 = 1 << 2;

// --- modes flag bits -------------------------------------------------------

const MODE_CURSOR_KEY_APP: u16 = 1 << 0;
const MODE_KEYPAD_APP: u16 = 1 << 1;
const MODE_BRACKETED_PASTE: u16 = 1 << 2;
const MODE_SYNC_OUTPUT: u16 = 1 << 3;
const MODE_MOUSE_TRACKING: u16 = 1 << 4;
const MODE_ALTERNATE_SCREEN: u16 = 1 << 5;

// --- cell style bits -------------------------------------------------------

const STYLE_BOLD: u16 = 1 << 0;
const STYLE_ITALIC: u16 = 1 << 1;
const STYLE_FAINT: u16 = 1 << 2;
const STYLE_BLINK: u16 = 1 << 3;
const STYLE_INVISIBLE: u16 = 1 << 4;
const STYLE_INVERSE: u16 = 1 << 5;
const STYLE_STRIKETHROUGH: u16 = 1 << 6;
const STYLE_OVERLINE: u16 = 1 << 7;
/// Underline kind occupies bits 8..=10 (a 3-bit field).
const STYLE_UNDERLINE_SHIFT: u16 = 8;
#[allow(dead_code)] // decode-only (see DecodedFrameMessage)
const STYLE_UNDERLINE_MASK: u16 = 0b111 << STYLE_UNDERLINE_SHIFT;

fn underline_code(underline: &TerminalUnderline) -> u16 {
    match underline {
        TerminalUnderline::None => 0,
        TerminalUnderline::Single => 1,
        TerminalUnderline::Double => 2,
        TerminalUnderline::Curly => 3,
        TerminalUnderline::Dotted => 4,
        TerminalUnderline::Dashed => 5,
    }
}

#[allow(dead_code)] // decode-only (see DecodedFrameMessage)
fn underline_from_code(code: u16) -> Result<TerminalUnderline, WireDecodeError> {
    match code {
        0 => Ok(TerminalUnderline::None),
        1 => Ok(TerminalUnderline::Single),
        2 => Ok(TerminalUnderline::Double),
        3 => Ok(TerminalUnderline::Curly),
        4 => Ok(TerminalUnderline::Dotted),
        5 => Ok(TerminalUnderline::Dashed),
        other => Err(WireDecodeError::InvalidEnum {
            field: "cell.style.underline",
            value: other as u32,
        }),
    }
}

// --- cell color-presence bits ----------------------------------------------

const COLOR_FLAG_FG: u8 = 1 << 0;
const COLOR_FLAG_BG: u8 = 1 << 1;

/// Encode a [`TerminalFrame`] plus its per-session `generation` into the wire
/// format. The byte layout matches `wire-protocol.md` exactly.
pub fn encode_frame(frame: &TerminalFrame, generation: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(estimate_frame_bytes(frame));

    out.push(KIND_FRAME);
    out.extend_from_slice(&generation.to_le_bytes());
    out.push(dirty_code(&frame.dirty));
    out.extend_from_slice(&frame.cols.to_le_bytes());
    // Header `rows` is the viewport row count, mirrored from the scrollback
    // block (which carries the authoritative value the frontend consumes).
    out.extend_from_slice(&(frame.scrollback.viewport_rows as u16).to_le_bytes());

    encode_cursor(&mut out, &frame.cursor);
    encode_modes(&mut out, &frame.modes);
    encode_colors(&mut out, &frame.colors);
    encode_scrollback(&mut out, &frame.scrollback);

    out.extend_from_slice(&(frame.rows.len() as u32).to_le_bytes());
    for row in &frame.rows {
        encode_row(&mut out, row);
    }

    out
}

fn encode_cursor(out: &mut Vec<u8>, cursor: &TerminalCursor) {
    let mut flags = 0_u8;
    if cursor.visible {
        flags |= CURSOR_FLAG_VISIBLE;
    }
    if cursor.blinking {
        flags |= CURSOR_FLAG_BLINKING;
    }
    if cursor.position.is_some() {
        flags |= CURSOR_FLAG_HAS_POSITION;
    }
    out.push(flags);
    out.push(cursor_style_code(&cursor.style));
    if let Some(position) = &cursor.position {
        out.extend_from_slice(&position.col.to_le_bytes());
        out.extend_from_slice(&position.row.to_le_bytes());
    }
}

fn encode_modes(out: &mut Vec<u8>, modes: &TerminalModes) {
    let mut flags = 0_u16;
    if modes.cursor_key_application {
        flags |= MODE_CURSOR_KEY_APP;
    }
    if modes.keypad_key_application {
        flags |= MODE_KEYPAD_APP;
    }
    if modes.bracketed_paste {
        flags |= MODE_BRACKETED_PASTE;
    }
    if modes.sync_output {
        flags |= MODE_SYNC_OUTPUT;
    }
    if modes.mouse_tracking {
        flags |= MODE_MOUSE_TRACKING;
    }
    if modes.alternate_screen {
        flags |= MODE_ALTERNATE_SCREEN;
    }
    out.extend_from_slice(&flags.to_le_bytes());
    out.push(modes.kitty_keyboard_flags);
}

fn encode_color(out: &mut Vec<u8>, color: &TerminalColor) {
    out.push(color.r);
    out.push(color.g);
    out.push(color.b);
}

fn encode_colors(out: &mut Vec<u8>, colors: &TerminalColors) {
    encode_color(out, &colors.foreground);
    encode_color(out, &colors.background);
    match &colors.cursor {
        Some(cursor) => {
            out.push(1);
            encode_color(out, cursor);
        }
        None => out.push(0),
    }
}

fn encode_scrollback(out: &mut Vec<u8>, scrollback: &TerminalScrollback) {
    out.extend_from_slice(&(scrollback.total_rows as u32).to_le_bytes());
    out.extend_from_slice(&(scrollback.scrollback_rows as u32).to_le_bytes());
    out.extend_from_slice(&(scrollback.viewport_offset as u32).to_le_bytes());
    out.extend_from_slice(&(scrollback.viewport_rows as u32).to_le_bytes());
    out.push(u8::from(scrollback.at_bottom));
    // Stable-id floor (D8): u64 because it grows monotonically over a long
    // session, beyond what the u32 row counts can hold.
    out.extend_from_slice(&scrollback.oldest_id.to_le_bytes());
}

fn encode_row(out: &mut Vec<u8>, row: &TerminalRow) {
    out.extend_from_slice(&row.index.to_le_bytes());
    out.push(u8::from(row.dirty));
    out.extend_from_slice(&(row.cells.len() as u16).to_le_bytes());
    for cell in &row.cells {
        encode_cell(out, cell);
    }
}

fn encode_cell(out: &mut Vec<u8>, cell: &TerminalCell) {
    out.extend_from_slice(&cell.col.to_le_bytes());
    out.extend_from_slice(&cell.width.to_le_bytes());
    out.extend_from_slice(&style_bits(&cell.style).to_le_bytes());

    let mut color_flags = 0_u8;
    if cell.fg.is_some() {
        color_flags |= COLOR_FLAG_FG;
    }
    if cell.bg.is_some() {
        color_flags |= COLOR_FLAG_BG;
    }
    out.push(color_flags);
    if let Some(fg) = &cell.fg {
        encode_color(out, fg);
    }
    if let Some(bg) = &cell.bg {
        encode_color(out, bg);
    }

    // Cell text is a single grapheme cluster and never approaches 64 KiB in
    // practice. Clamp defensively so the declared length always equals the bytes
    // written: a silent u16 truncation here would desync the rest of the frame,
    // far worse than a (never-reached) clipped glyph.
    let text = cell.text.as_bytes();
    debug_assert!(
        text.len() <= u16::MAX as usize,
        "cell text exceeds u16 length"
    );
    let text_len = text.len().min(u16::MAX as usize);
    out.extend_from_slice(&(text_len as u16).to_le_bytes());
    out.extend_from_slice(&text[..text_len]);
}

fn style_bits(style: &TerminalCellStyle) -> u16 {
    let mut bits = 0_u16;
    if style.bold {
        bits |= STYLE_BOLD;
    }
    if style.italic {
        bits |= STYLE_ITALIC;
    }
    if style.faint {
        bits |= STYLE_FAINT;
    }
    if style.blink {
        bits |= STYLE_BLINK;
    }
    if style.invisible {
        bits |= STYLE_INVISIBLE;
    }
    if style.inverse {
        bits |= STYLE_INVERSE;
    }
    if style.strikethrough {
        bits |= STYLE_STRIKETHROUGH;
    }
    if style.overline {
        bits |= STYLE_OVERLINE;
    }
    bits |= underline_code(&style.underline) << STYLE_UNDERLINE_SHIFT;
    bits
}

fn estimate_frame_bytes(frame: &TerminalFrame) -> usize {
    // Fixed header + cursor + modes + colors + scrollback + row_count, plus a
    // rough per-cell budget. Just a capacity hint; correctness does not depend
    // on it.
    let mut bytes = 64;
    for row in &frame.rows {
        bytes += 5 + row.cells.len() * 16;
    }
    bytes
}

/// Encode a contiguous band of history rows (the reply to a history-range
/// request) into the wire format from `wire-protocol.md` ("Row band reply").
/// The rows are contiguous from stable id `start_id`, so unlike a frame they
/// carry no per-row index or dirty flag, only a cell count plus the cells. The
/// `Cell` encoding is identical to a frame's (the same [`encode_cell`]), so one
/// encoder and one decoder serve both messages. `start_id` is a u64 to match the
/// frame's `oldest_id` floor (D8).
pub fn encode_row_band(rows: &[TerminalRow], generation: u32, start_id: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(estimate_row_band_bytes(rows));
    out.push(KIND_ROW_BAND);
    out.extend_from_slice(&generation.to_le_bytes());
    out.extend_from_slice(&start_id.to_le_bytes());
    out.extend_from_slice(&(rows.len() as u32).to_le_bytes());
    for row in rows {
        out.extend_from_slice(&(row.cells.len() as u16).to_le_bytes());
        for cell in &row.cells {
            encode_cell(&mut out, cell);
        }
    }
    out
}

fn estimate_row_band_bytes(rows: &[TerminalRow]) -> usize {
    let mut bytes = 17; // kind(1) + generation(4) + start_id(8) + row_count(4)
    for row in rows {
        bytes += 2 + row.cells.len() * 16;
    }
    bytes
}

/// Errors that [`decode_frame`] can return on a malformed buffer.
#[allow(dead_code)] // decode-only (see DecodedFrameMessage)
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WireDecodeError {
    UnexpectedEof { field: &'static str },
    InvalidKind { value: u8 },
    InvalidEnum { field: &'static str, value: u32 },
    InvalidUtf8 { field: &'static str },
}

impl std::fmt::Display for WireDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WireDecodeError::UnexpectedEof { field } => {
                write!(f, "unexpected end of frame buffer reading {field}")
            }
            WireDecodeError::InvalidKind { value } => {
                write!(f, "invalid frame message kind {value}")
            }
            WireDecodeError::InvalidEnum { field, value } => {
                write!(f, "invalid value {value} for {field}")
            }
            WireDecodeError::InvalidUtf8 { field } => {
                write!(f, "invalid utf-8 in {field}")
            }
        }
    }
}

impl std::error::Error for WireDecodeError {}

/// A tiny little-endian cursor over a byte slice. Every read is bounds-checked
/// so a truncated or malformed buffer fails cleanly instead of panicking.
#[allow(dead_code)] // decode-only (see DecodedFrameMessage)
struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

#[allow(dead_code)] // decode-only (see DecodedFrameMessage)
impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn take(&mut self, n: usize, field: &'static str) -> Result<&'a [u8], WireDecodeError> {
        let end = self
            .pos
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len())
            .ok_or(WireDecodeError::UnexpectedEof { field })?;
        let slice = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn u8(&mut self, field: &'static str) -> Result<u8, WireDecodeError> {
        Ok(self.take(1, field)?[0])
    }

    fn u16(&mut self, field: &'static str) -> Result<u16, WireDecodeError> {
        let bytes = self.take(2, field)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn u32(&mut self, field: &'static str) -> Result<u32, WireDecodeError> {
        let bytes = self.take(4, field)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn u64(&mut self, field: &'static str) -> Result<u64, WireDecodeError> {
        let bytes = self.take(8, field)?;
        Ok(u64::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ]))
    }

    fn color(&mut self, field: &'static str) -> Result<TerminalColor, WireDecodeError> {
        let bytes = self.take(3, field)?;
        Ok(TerminalColor {
            r: bytes[0],
            g: bytes[1],
            b: bytes[2],
        })
    }
}

/// Decode a wire frame message back into a [`TerminalFrame`] and its
/// generation. Symmetric with [`encode_frame`].
#[allow(dead_code)] // decode-only reference impl (see DecodedFrameMessage)
pub fn decode_frame(bytes: &[u8]) -> Result<DecodedFrameMessage, WireDecodeError> {
    let mut reader = Reader::new(bytes);

    let kind = reader.u8("kind")?;
    if kind != KIND_FRAME {
        return Err(WireDecodeError::InvalidKind { value: kind });
    }
    let generation = reader.u32("generation")?;
    let dirty = dirty_from_code(reader.u8("dirty")?)?;
    let cols = reader.u16("cols")?;
    // Header `rows` mirrors scrollback.viewport_rows; the scrollback block below
    // carries the authoritative value, so this header copy is read and dropped.
    let _viewport_rows_header = reader.u16("rows")?;

    let cursor = decode_cursor(&mut reader)?;
    let modes = decode_modes(&mut reader)?;
    let colors = decode_colors(&mut reader)?;
    let scrollback = decode_scrollback(&mut reader)?;

    let row_count = reader.u32("row_count")? as usize;
    let mut rows = Vec::with_capacity(row_count);
    for _ in 0..row_count {
        rows.push(decode_row(&mut reader)?);
    }

    Ok(DecodedFrameMessage {
        generation,
        frame: TerminalFrame {
            dirty,
            cols,
            colors,
            cursor,
            modes,
            scrollback,
            rows,
        },
    })
}

/// Decode a row-band reply (kind 2) back into its rows and the generation +
/// start id they belong to. Symmetric with [`encode_row_band`]; the band rows
/// are contiguous from stable id `start_id`, so each decoded row's `index` is its
/// 0-based offset within the band (the caller adds `start_id` to place it).
#[allow(dead_code)] // decode-only reference impl (see DecodedRowBand)
pub fn decode_row_band(bytes: &[u8]) -> Result<DecodedRowBand, WireDecodeError> {
    let mut reader = Reader::new(bytes);

    let kind = reader.u8("kind")?;
    if kind != KIND_ROW_BAND {
        return Err(WireDecodeError::InvalidKind { value: kind });
    }
    let generation = reader.u32("generation")?;
    let start_id = reader.u64("start_id")?;
    let row_count = reader.u32("row_count")? as usize;
    let mut rows = Vec::with_capacity(row_count);
    for index in 0..row_count {
        let cell_count = reader.u16("band_row.cell_count")? as usize;
        let mut cells = Vec::with_capacity(cell_count);
        for _ in 0..cell_count {
            cells.push(decode_cell(&mut reader)?);
        }
        rows.push(TerminalRow {
            index: index as u16,
            dirty: true,
            cells,
        });
    }

    Ok(DecodedRowBand {
        generation,
        start_id,
        rows,
    })
}

#[allow(dead_code)] // decode-only (see DecodedFrameMessage)
fn decode_cursor(reader: &mut Reader<'_>) -> Result<TerminalCursor, WireDecodeError> {
    let flags = reader.u8("cursor.flags")?;
    let style = cursor_style_from_code(reader.u8("cursor.style")?)?;
    let position = if flags & CURSOR_FLAG_HAS_POSITION != 0 {
        let col = reader.u16("cursor.col")?;
        let row = reader.u16("cursor.row")?;
        Some(TerminalPosition { col, row })
    } else {
        None
    };
    Ok(TerminalCursor {
        visible: flags & CURSOR_FLAG_VISIBLE != 0,
        blinking: flags & CURSOR_FLAG_BLINKING != 0,
        style,
        position,
    })
}

#[allow(dead_code)] // decode-only (see DecodedFrameMessage)
fn decode_modes(reader: &mut Reader<'_>) -> Result<TerminalModes, WireDecodeError> {
    let flags = reader.u16("modes.flags")?;
    let kitty_keyboard_flags = reader.u8("modes.kitty")?;
    Ok(TerminalModes {
        cursor_key_application: flags & MODE_CURSOR_KEY_APP != 0,
        keypad_key_application: flags & MODE_KEYPAD_APP != 0,
        bracketed_paste: flags & MODE_BRACKETED_PASTE != 0,
        sync_output: flags & MODE_SYNC_OUTPUT != 0,
        mouse_tracking: flags & MODE_MOUSE_TRACKING != 0,
        alternate_screen: flags & MODE_ALTERNATE_SCREEN != 0,
        kitty_keyboard_flags,
    })
}

#[allow(dead_code)] // decode-only (see DecodedFrameMessage)
fn decode_colors(reader: &mut Reader<'_>) -> Result<TerminalColors, WireDecodeError> {
    let foreground = reader.color("colors.foreground")?;
    let background = reader.color("colors.background")?;
    let has_cursor = reader.u8("colors.has_cursor")?;
    let cursor = if has_cursor != 0 {
        Some(reader.color("colors.cursor")?)
    } else {
        None
    };
    Ok(TerminalColors {
        foreground,
        background,
        cursor,
    })
}

#[allow(dead_code)] // decode-only (see DecodedFrameMessage)
fn decode_scrollback(reader: &mut Reader<'_>) -> Result<TerminalScrollback, WireDecodeError> {
    let total_rows = reader.u32("scrollback.total_rows")? as usize;
    let scrollback_rows = reader.u32("scrollback.scrollback_rows")? as usize;
    let viewport_offset = reader.u32("scrollback.viewport_offset")? as usize;
    let viewport_rows = reader.u32("scrollback.viewport_rows")? as usize;
    let at_bottom = reader.u8("scrollback.at_bottom")? != 0;
    let oldest_id = reader.u64("scrollback.oldest_id")?;
    Ok(TerminalScrollback {
        total_rows,
        scrollback_rows,
        viewport_offset,
        viewport_rows,
        at_bottom,
        oldest_id,
    })
}

#[allow(dead_code)] // decode-only (see DecodedFrameMessage)
fn decode_row(reader: &mut Reader<'_>) -> Result<TerminalRow, WireDecodeError> {
    let index = reader.u16("row.index")?;
    let dirty = reader.u8("row.dirty")? != 0;
    let cell_count = reader.u16("row.cell_count")? as usize;
    let mut cells = Vec::with_capacity(cell_count);
    for _ in 0..cell_count {
        cells.push(decode_cell(reader)?);
    }
    Ok(TerminalRow {
        index,
        dirty,
        cells,
    })
}

#[allow(dead_code)] // decode-only (see DecodedFrameMessage)
fn decode_cell(reader: &mut Reader<'_>) -> Result<TerminalCell, WireDecodeError> {
    let col = reader.u16("cell.col")?;
    let width = reader.u16("cell.width")?;
    let style = decode_style(reader.u16("cell.style")?)?;
    let color_flags = reader.u8("cell.color_flags")?;
    let fg = if color_flags & COLOR_FLAG_FG != 0 {
        Some(reader.color("cell.fg")?)
    } else {
        None
    };
    let bg = if color_flags & COLOR_FLAG_BG != 0 {
        Some(reader.color("cell.bg")?)
    } else {
        None
    };
    let text_len = reader.u16("cell.text_len")? as usize;
    let text_bytes = reader.take(text_len, "cell.text")?;
    let text = std::str::from_utf8(text_bytes)
        .map_err(|_| WireDecodeError::InvalidUtf8 { field: "cell.text" })?
        .to_owned();
    Ok(TerminalCell {
        col,
        width,
        text,
        fg,
        bg,
        style,
    })
}

#[allow(dead_code)] // decode-only (see DecodedFrameMessage)
fn decode_style(bits: u16) -> Result<TerminalCellStyle, WireDecodeError> {
    let underline = underline_from_code((bits & STYLE_UNDERLINE_MASK) >> STYLE_UNDERLINE_SHIFT)?;
    Ok(TerminalCellStyle {
        bold: bits & STYLE_BOLD != 0,
        italic: bits & STYLE_ITALIC != 0,
        faint: bits & STYLE_FAINT != 0,
        blink: bits & STYLE_BLINK != 0,
        invisible: bits & STYLE_INVISIBLE != 0,
        underline,
        inverse: bits & STYLE_INVERSE != 0,
        strikethrough: bits & STYLE_STRIKETHROUGH != 0,
        overline: bits & STYLE_OVERLINE != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn color(r: u8, g: u8, b: u8) -> TerminalColor {
        TerminalColor { r, g, b }
    }

    /// A frame that exercises every encoded shape: wide cells, multi-codepoint
    /// graphemes, every style bit, each underline kind, optional fg/bg present
    /// and absent, a cursor with a position, and every mode flag set.
    fn exhaustive_frame() -> TerminalFrame {
        let underlines = [
            TerminalUnderline::None,
            TerminalUnderline::Single,
            TerminalUnderline::Double,
            TerminalUnderline::Curly,
            TerminalUnderline::Dotted,
            TerminalUnderline::Dashed,
        ];
        let underline_cells = underlines
            .iter()
            .cloned()
            .enumerate()
            .map(|(i, underline)| TerminalCell {
                col: i as u16,
                width: 1,
                text: "x".to_owned(),
                fg: Some(color(i as u8, 0x10, 0x20)),
                bg: None,
                style: TerminalCellStyle {
                    bold: false,
                    italic: false,
                    faint: false,
                    blink: false,
                    invisible: false,
                    underline,
                    inverse: false,
                    strikethrough: false,
                    overline: false,
                },
            })
            .collect::<Vec<_>>();

        let mut rows = vec![
            TerminalRow {
                index: 0,
                dirty: true,
                cells: vec![
                    // Wide CJK cell (width 2), fg+bg both present.
                    TerminalCell {
                        col: 0,
                        width: 2,
                        text: "界".to_owned(),
                        fg: Some(color(0xff, 0xee, 0xdd)),
                        bg: Some(color(0x01, 0x02, 0x03)),
                        style: TerminalCellStyle {
                            bold: true,
                            italic: true,
                            faint: true,
                            blink: true,
                            invisible: true,
                            underline: TerminalUnderline::Curly,
                            inverse: true,
                            strikethrough: true,
                            overline: true,
                        },
                    },
                    // Multi-codepoint grapheme cluster (emoji + ZWJ + emoji),
                    // no colors at all.
                    TerminalCell {
                        col: 2,
                        width: 2,
                        text: "👩\u{200d}🚀".to_owned(),
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
                    },
                    // bg-only cell (fg absent, bg present).
                    TerminalCell {
                        col: 4,
                        width: 1,
                        text: " ".to_owned(),
                        fg: None,
                        bg: Some(color(0x40, 0x50, 0x60)),
                        style: TerminalCellStyle {
                            bold: false,
                            italic: false,
                            faint: false,
                            blink: false,
                            invisible: false,
                            underline: TerminalUnderline::Single,
                            inverse: false,
                            strikethrough: false,
                            overline: false,
                        },
                    },
                ],
            },
            TerminalRow {
                index: 1,
                dirty: false,
                cells: underline_cells,
            },
        ];
        // An empty (cleared) row with no cells, to cover the zero-cell path.
        rows.push(TerminalRow {
            index: 2,
            dirty: true,
            cells: Vec::new(),
        });

        TerminalFrame {
            dirty: TerminalDirtyState::Full,
            cols: 80,
            colors: TerminalColors {
                foreground: color(0xef, 0xe9, 0xdf),
                background: color(0x0b, 0x0a, 0x09),
                cursor: Some(color(0x7a, 0x8b, 0x9c)),
            },
            cursor: TerminalCursor {
                visible: true,
                blinking: true,
                style: TerminalCursorStyle::Bar,
                position: Some(TerminalPosition { col: 12, row: 3 }),
            },
            modes: TerminalModes {
                cursor_key_application: true,
                keypad_key_application: true,
                bracketed_paste: true,
                sync_output: true,
                mouse_tracking: true,
                alternate_screen: true,
                kitty_keyboard_flags: 0b1010_1010,
            },
            scrollback: TerminalScrollback {
                total_rows: 1234,
                scrollback_rows: 1200,
                viewport_offset: 1170,
                viewport_rows: 24,
                at_bottom: false,
                oldest_id: 9_000,
            },
            rows,
        }
    }

    #[test]
    fn round_trips_an_exhaustive_frame() {
        let frame = exhaustive_frame();
        let generation = 0xDEAD_BEEF;
        let bytes = encode_frame(&frame, generation);
        let decoded = decode_frame(&bytes).expect("decode should succeed");
        assert_eq!(decoded.generation, generation);
        assert_eq!(decoded.frame, frame);
    }

    #[test]
    fn round_trips_cursor_without_position_and_no_cursor_color() {
        let mut frame = exhaustive_frame();
        frame.cursor.position = None;
        frame.cursor.visible = false;
        frame.cursor.blinking = false;
        frame.colors.cursor = None;
        frame.modes = TerminalModes::default();
        frame.scrollback.at_bottom = true;
        let bytes = encode_frame(&frame, 1);
        let decoded = decode_frame(&bytes).expect("decode should succeed");
        assert_eq!(decoded.frame, frame);
        // With no cursor position, the cursor block is exactly 2 bytes (flags +
        // style) with no trailing col/row.
        assert_eq!(decoded.frame.cursor.position, None);
    }

    #[test]
    fn rejects_a_truncated_buffer() {
        let frame = exhaustive_frame();
        let bytes = encode_frame(&frame, 1);
        let truncated = &bytes[..bytes.len() - 1];
        assert!(matches!(
            decode_frame(truncated),
            Err(WireDecodeError::UnexpectedEof { .. })
        ));
    }

    #[test]
    fn rejects_an_unknown_kind() {
        let frame = exhaustive_frame();
        let mut bytes = encode_frame(&frame, 1);
        bytes[0] = 0xFF;
        assert!(matches!(
            decode_frame(&bytes),
            Err(WireDecodeError::InvalidKind { value: 0xFF })
        ));
    }

    /// A small, fully specified frame whose exact bytes are asserted below. The
    /// TypeScript decode test embeds the same byte array (see
    /// `apps/desktop/web/terminal/wireDecode.test.ts`) so both implementations
    /// are checked against one shared reference vector.
    fn golden_frame() -> TerminalFrame {
        TerminalFrame {
            dirty: TerminalDirtyState::Full,
            cols: 3,
            colors: TerminalColors {
                foreground: color(0xEF, 0xE9, 0xDF),
                background: color(0x0B, 0x0A, 0x09),
                cursor: None,
            },
            cursor: TerminalCursor {
                visible: true,
                blinking: false,
                style: TerminalCursorStyle::Block,
                position: Some(TerminalPosition { col: 1, row: 0 }),
            },
            modes: TerminalModes::default(),
            scrollback: TerminalScrollback {
                total_rows: 1,
                scrollback_rows: 0,
                viewport_offset: 0,
                viewport_rows: 1,
                at_bottom: true,
                oldest_id: 0,
            },
            rows: vec![TerminalRow {
                index: 0,
                dirty: true,
                cells: vec![
                    TerminalCell {
                        col: 0,
                        width: 1,
                        text: "H".to_owned(),
                        fg: Some(color(0xFF, 0x00, 0x00)),
                        bg: None,
                        style: TerminalCellStyle {
                            bold: true,
                            italic: false,
                            faint: false,
                            blink: false,
                            invisible: false,
                            underline: TerminalUnderline::Single,
                            inverse: false,
                            strikethrough: false,
                            overline: false,
                        },
                    },
                    TerminalCell {
                        col: 1,
                        width: 1,
                        text: "i".to_owned(),
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
                    },
                ],
            }],
        }
    }

    /// The exact byte vector the golden frame encodes to at generation 1. This
    /// is the shared fixture cross-checked by the TypeScript decoder test. If
    /// the encoding ever changes intentionally, update both this array and the
    /// TS copy in lockstep.
    const GOLDEN_BYTES: &[u8] = &[
        // kind, generation (u32 LE = 1)
        0x01, 0x01, 0x00, 0x00, 0x00, //
        // dirty (2 = Full)
        0x02, //
        // cols (u16 = 3)
        0x03, 0x00, //
        // rows header (u16 = 1, viewport rows)
        0x01, 0x00, //
        // cursor flags (visible|has_position = 0b101 = 5), style (0 = Block)
        0x05, 0x00, //
        // cursor col (u16 = 1), row (u16 = 0)
        0x01, 0x00, 0x00, 0x00, //
        // modes flags (u16 = 0), kitty flags (u8 = 0)
        0x00, 0x00, 0x00, //
        // colors.fg (EF E9 DF), colors.bg (0B 0A 09)
        0xEF, 0xE9, 0xDF, 0x0B, 0x0A, 0x09, //
        // colors.has_cursor (0)
        0x00, //
        // scrollback: total_rows=1, scrollback_rows=0, viewport_offset=0,
        // viewport_rows=1, at_bottom=1
        0x01, 0x00, 0x00, 0x00, //
        0x00, 0x00, 0x00, 0x00, //
        0x00, 0x00, 0x00, 0x00, //
        0x01, 0x00, 0x00, 0x00, //
        0x01, //
        // scrollback.oldest_id (u64 = 0)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, //
        // row_count (u32 = 1)
        0x01, 0x00, 0x00, 0x00, //
        // row[0]: index (u16 = 0), dirty (1), cell_count (u16 = 2)
        0x00, 0x00, 0x01, 0x02, 0x00, //
        // cell[0]: col=0, width=1, style (bold|underline Single =
        // 0x0001 | (1<<8) = 0x0101), color_flags (fg only = 1)
        0x00, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, //
        // cell[0].fg (FF 00 00)
        0xFF, 0x00, 0x00, //
        // cell[0].text_len (u16 = 1), 'H'
        0x01, 0x00, 0x48, //
        // cell[1]: col=1, width=1, style=0, color_flags=0
        0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, //
        // cell[1].text_len (u16 = 1), 'i'
        0x01, 0x00, 0x69, //
    ];

    #[test]
    fn golden_frame_encodes_to_exact_bytes() {
        let frame = golden_frame();
        let bytes = encode_frame(&frame, 1);
        assert_eq!(
            bytes, GOLDEN_BYTES,
            "golden frame encoding changed; update GOLDEN_BYTES here and the TS copy in wireDecode.test.ts"
        );
    }

    #[test]
    fn golden_bytes_decode_to_the_golden_frame() {
        let decoded = decode_frame(GOLDEN_BYTES).expect("golden bytes should decode");
        assert_eq!(decoded.generation, 1);
        assert_eq!(decoded.frame, golden_frame());
    }

    // --- row band (history-range reply) -----------------------------------

    /// A band that exercises the row-band shape: a row with styled cells (one
    /// fg-only, one wide CJK with fg+bg and several style bits), then an empty
    /// row (zero cells), proving contiguous rows carry only a cell count.
    fn band_rows() -> Vec<TerminalRow> {
        vec![
            TerminalRow {
                // The band drops per-row index/dirty on the wire; the decoder
                // reconstructs index = offset within the band, dirty = true.
                index: 0,
                dirty: true,
                cells: vec![
                    TerminalCell {
                        col: 0,
                        width: 1,
                        text: "R".to_owned(),
                        fg: Some(color(0x12, 0x34, 0x56)),
                        bg: None,
                        style: TerminalCellStyle {
                            bold: false,
                            italic: true,
                            faint: false,
                            blink: false,
                            invisible: false,
                            underline: TerminalUnderline::Dotted,
                            inverse: false,
                            strikethrough: false,
                            overline: false,
                        },
                    },
                    TerminalCell {
                        col: 1,
                        width: 2,
                        text: "界".to_owned(),
                        fg: Some(color(0xaa, 0xbb, 0xcc)),
                        bg: Some(color(0x10, 0x20, 0x30)),
                        style: TerminalCellStyle {
                            bold: true,
                            italic: false,
                            faint: false,
                            blink: false,
                            invisible: false,
                            underline: TerminalUnderline::None,
                            inverse: true,
                            strikethrough: false,
                            overline: false,
                        },
                    },
                ],
            },
            TerminalRow {
                index: 1,
                dirty: true,
                cells: Vec::new(),
            },
        ]
    }

    #[test]
    fn round_trips_a_row_band() {
        let rows = band_rows();
        let generation = 0xABCD_1234;
        let start_id: u64 = 4_096;
        let bytes = encode_row_band(&rows, generation, start_id);
        let decoded = decode_row_band(&bytes).expect("row band should decode");
        assert_eq!(decoded.generation, generation);
        assert_eq!(decoded.start_id, start_id);
        assert_eq!(decoded.rows, rows);
    }

    #[test]
    fn row_band_rejects_an_unknown_kind() {
        let mut bytes = encode_row_band(&band_rows(), 1, 0);
        bytes[0] = KIND_FRAME; // a frame kind is not a row band
        assert!(matches!(
            decode_row_band(&bytes),
            Err(WireDecodeError::InvalidKind { value: 1 })
        ));
    }

    #[test]
    fn row_band_rejects_a_truncated_buffer() {
        let bytes = encode_row_band(&band_rows(), 1, 0);
        let truncated = &bytes[..bytes.len() - 1];
        assert!(matches!(
            decode_row_band(truncated),
            Err(WireDecodeError::UnexpectedEof { .. })
        ));
    }

    /// A small, fully specified row band whose exact bytes are asserted below.
    /// The TypeScript `decodeRowBand` test embeds the same byte array (see
    /// `apps/desktop/web/terminal/wireDecode.test.ts`), so both implementations
    /// are checked against one shared reference vector.
    fn golden_band_rows() -> Vec<TerminalRow> {
        vec![
            TerminalRow {
                index: 0,
                dirty: true,
                cells: vec![TerminalCell {
                    col: 0,
                    width: 1,
                    text: "H".to_owned(),
                    fg: Some(color(0xFF, 0x00, 0x00)),
                    bg: None,
                    style: TerminalCellStyle {
                        bold: true,
                        italic: false,
                        faint: false,
                        blink: false,
                        invisible: false,
                        underline: TerminalUnderline::Single,
                        inverse: false,
                        strikethrough: false,
                        overline: false,
                    },
                }],
            },
            TerminalRow {
                index: 1,
                dirty: true,
                cells: Vec::new(),
            },
        ]
    }

    /// The exact byte vector the golden band encodes to at generation 1, start
    /// row 2. Shared fixture cross-checked by the TS decoder test; if the
    /// encoding changes intentionally, update this array and the TS copy
    /// together. The single populated cell reuses the frame golden's `H` cell,
    /// so the shared `Cell` encoding is visibly identical across both messages.
    const GOLDEN_BAND_BYTES: &[u8] = &[
        // kind (2 = row band), generation (u32 LE = 1)
        0x02, 0x01, 0x00, 0x00, 0x00, //
        // start_id (u64 = 2)
        0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, //
        // row_count (u32 = 2)
        0x02, 0x00, 0x00, 0x00, //
        // band row[0]: cell_count (u16 = 1)
        0x01, 0x00, //
        // cell[0]: col=0, width=1, style (bold|underline Single = 0x0101),
        // color_flags (fg only = 1)
        0x00, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, //
        // cell[0].fg (FF 00 00)
        0xFF, 0x00, 0x00, //
        // cell[0].text_len (u16 = 1), 'H'
        0x01, 0x00, 0x48, //
        // band row[1]: cell_count (u16 = 0)
        0x00, 0x00, //
    ];

    #[test]
    fn golden_band_encodes_to_exact_bytes() {
        let bytes = encode_row_band(&golden_band_rows(), 1, 2);
        assert_eq!(
            bytes, GOLDEN_BAND_BYTES,
            "golden row band encoding changed; update GOLDEN_BAND_BYTES here and the TS copy in wireDecode.test.ts"
        );
    }

    #[test]
    fn golden_band_bytes_decode_to_the_golden_band() {
        let decoded = decode_row_band(GOLDEN_BAND_BYTES).expect("golden band should decode");
        assert_eq!(decoded.generation, 1);
        assert_eq!(decoded.start_id, 2);
        assert_eq!(decoded.rows, golden_band_rows());
    }
}
