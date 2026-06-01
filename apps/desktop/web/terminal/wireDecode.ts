// Binary terminal-frame decoder. The single TypeScript implementation of the
// wire protocol documented in docs/technical/terminal/wire-protocol.md
// ("Binary frame encoding (concrete)"). It mirrors the Rust encoder in
// apps/desktop/src-tauri/src/terminal/wire.rs byte-for-byte (little-endian,
// same field order and bit positions) and is cross-checked against the same
// golden byte vector (see wireDecode.test.ts).
//
// This decoder is shared by both backend-to-frontend transports: the Tauri
// Channel (desktop, raw ArrayBuffer) and the harness SSE bridge (base64 of the
// identical bytes). Both call decodeTerminalFrame, so both exercise one format.
//
// The decoded frame is the exact shape the existing buffer/ingest/apply path
// already consumes (see terminalTypes.ts); only the transport and serialization
// changed, not the frame model.

import type {
  TerminalCell,
  TerminalColor,
  TerminalCursor,
  TerminalFrame,
  TerminalModes,
  TerminalRow,
  TerminalScrollback,
  TerminalUnderlineStyle,
} from '../terminalTypes';

export interface DecodedTerminalFrame {
  // Per-session generation marker the frame was stamped with. The frontend
  // drops frames older than the latest generation it has seen and adopts a new
  // generation from a Full frame (a resize bumps it backend-side).
  generation: number;
  // Convenience copy of frame.dirty so callers can apply the generation rules
  // ("a Full frame adopts a new generation and resets") without re-reading it.
  dirty: 'clean' | 'partial' | 'full';
  frame: TerminalFrame;
}

// The decoded history-range reply (kind 2): a contiguous run of rows starting
// at `startRow`, tagged with the generation they were read at. Mirrors the Rust
// `DecodedRowBand` in wire.rs. The frontend merges these into its mirror only
// when `generation` still matches the latest it holds (a band a resize
// invalidated is dropped and re-requested against the new generation).
export interface DecodedRowBand {
  generation: number;
  startRow: number;
  rows: TerminalRow[];
}

const KIND_FRAME = 1;
const KIND_ROW_BAND = 2;

const DIRTY_BY_CODE = ['clean', 'partial', 'full'] as const;
const CURSOR_STYLE_BY_CODE = ['block', 'block_hollow', 'bar', 'underline'] as const;
const UNDERLINE_BY_CODE: TerminalUnderlineStyle[] = [
  'none',
  'single',
  'double',
  'curly',
  'dotted',
  'dashed',
];

// Cursor flag bits.
const CURSOR_FLAG_VISIBLE = 1 << 0;
const CURSOR_FLAG_BLINKING = 1 << 1;
const CURSOR_FLAG_HAS_POSITION = 1 << 2;

// Modes flag bits.
const MODE_CURSOR_KEY_APP = 1 << 0;
const MODE_KEYPAD_APP = 1 << 1;
const MODE_BRACKETED_PASTE = 1 << 2;
const MODE_SYNC_OUTPUT = 1 << 3;
const MODE_MOUSE_TRACKING = 1 << 4;
const MODE_ALTERNATE_SCREEN = 1 << 5;

// Cell style bits 0..7, plus a 3-bit underline kind in bits 8..10.
const STYLE_BOLD = 1 << 0;
const STYLE_ITALIC = 1 << 1;
const STYLE_FAINT = 1 << 2;
const STYLE_BLINK = 1 << 3;
const STYLE_INVISIBLE = 1 << 4;
const STYLE_INVERSE = 1 << 5;
const STYLE_STRIKETHROUGH = 1 << 6;
const STYLE_OVERLINE = 1 << 7;
const STYLE_UNDERLINE_SHIFT = 8;
const STYLE_UNDERLINE_MASK = 0b111 << STYLE_UNDERLINE_SHIFT;

// Cell color-presence bits.
const COLOR_FLAG_FG = 1 << 0;
const COLOR_FLAG_BG = 1 << 1;

// A little-endian cursor over the frame bytes. Decodes the same primitives the
// Rust `Reader` reads. UTF-8 cell text is decoded once per frame via a shared
// TextDecoder.
const textDecoder = new TextDecoder('utf-8');

class FrameReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(): number {
    const value = this.view.getUint8(this.pos);
    this.pos += 1;
    return value;
  }

  u16(): number {
    const value = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return value;
  }

  u64(): number {
    // Stable ids fit comfortably in a JS number (< 2^53) for any real session;
    // a u64 wire field just future-proofs the monotonic counter.
    const value = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return Number(value);
  }

  color(): TerminalColor {
    const r = this.view.getUint8(this.pos);
    const g = this.view.getUint8(this.pos + 1);
    const b = this.view.getUint8(this.pos + 2);
    this.pos += 3;
    return { r, g, b };
  }

  utf8(length: number): string {
    if (length === 0) return '';
    const slice = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return textDecoder.decode(slice);
  }
}

// Normalize any of the shapes a Tauri Channel / SSE bridge can hand us into a
// Uint8Array view: an ArrayBuffer (the Channel raw-bytes path), a typed-array /
// DataView (defensive), or a number[] (e.g. JSON-array fallbacks).
function toBytes(input: ArrayBuffer | ArrayBufferView | number[]): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return Uint8Array.from(input);
}

/**
 * Decode one binary frame message into a {@link TerminalFrame} plus its
 * generation marker and dirty kind. Symmetric with the Rust `encode_frame`.
 */
export function decodeTerminalFrame(
  input: ArrayBuffer | ArrayBufferView | number[],
): DecodedTerminalFrame {
  const reader = new FrameReader(toBytes(input));

  const kind = reader.u8();
  if (kind !== KIND_FRAME) {
    throw new Error(`decodeTerminalFrame: unexpected message kind ${kind}`);
  }
  const generation = reader.u32();
  const dirty = DIRTY_BY_CODE[reader.u8()];
  if (!dirty) throw new Error('decodeTerminalFrame: invalid dirty code');
  const cols = reader.u16();
  // Header `rows` mirrors scrollback.viewportRows (the authoritative value is in
  // the scrollback block below), so it is read and discarded here.
  reader.u16();

  const cursor = decodeCursor(reader);
  const modes = decodeModes(reader);
  const colors = decodeColors(reader);
  const scrollback = decodeScrollback(reader);

  const rowCount = reader.u32();
  const rows: TerminalRow[] = new Array(rowCount);
  for (let i = 0; i < rowCount; i += 1) {
    rows[i] = decodeRow(reader);
  }

  const frame: TerminalFrame = {
    dirty,
    cols,
    cursor,
    modes,
    colors,
    scrollback,
    rows,
  };

  return { generation, dirty, frame };
}

function decodeCursor(reader: FrameReader): TerminalCursor {
  const flags = reader.u8();
  const style = CURSOR_STYLE_BY_CODE[reader.u8()];
  if (!style) throw new Error('decodeTerminalFrame: invalid cursor style');
  const cursor: TerminalCursor = {
    visible: (flags & CURSOR_FLAG_VISIBLE) !== 0,
    blinking: (flags & CURSOR_FLAG_BLINKING) !== 0,
    style,
  };
  if ((flags & CURSOR_FLAG_HAS_POSITION) !== 0) {
    const col = reader.u16();
    const row = reader.u16();
    // Mirror the Rust `TerminalPosition` serialization exactly: the old JSON
    // path only ever set `cursor.position`, and every reader resolves
    // `cursor.position?.row ?? cursor.row`, so `position` alone is sufficient.
    cursor.position = { row, col };
  }
  return cursor;
}

function decodeModes(reader: FrameReader): TerminalModes {
  const flags = reader.u16();
  const kittyKeyboardFlags = reader.u8();
  return {
    cursorKeyApplication: (flags & MODE_CURSOR_KEY_APP) !== 0,
    keypadKeyApplication: (flags & MODE_KEYPAD_APP) !== 0,
    bracketedPaste: (flags & MODE_BRACKETED_PASTE) !== 0,
    syncOutput: (flags & MODE_SYNC_OUTPUT) !== 0,
    mouseTracking: (flags & MODE_MOUSE_TRACKING) !== 0,
    alternateScreen: (flags & MODE_ALTERNATE_SCREEN) !== 0,
    kittyKeyboardFlags,
  };
}

function decodeColors(reader: FrameReader): TerminalFrame['colors'] {
  const foreground = reader.color();
  const background = reader.color();
  const hasCursor = reader.u8();
  const colors: NonNullable<TerminalFrame['colors']> = { foreground, background };
  if (hasCursor !== 0) colors.cursor = reader.color();
  return colors;
}

function decodeScrollback(reader: FrameReader): TerminalScrollback {
  const totalRows = reader.u32();
  const scrollbackRows = reader.u32();
  const viewportOffset = reader.u32();
  const viewportRows = reader.u32();
  const atBottom = reader.u8() !== 0;
  const oldestId = reader.u64();
  return { totalRows, scrollbackRows, viewportOffset, viewportRows, atBottom, oldestId };
}

function decodeRow(reader: FrameReader): TerminalRow {
  const index = reader.u16();
  const dirty = reader.u8() !== 0;
  const cellCount = reader.u16();
  const cells: TerminalCell[] = new Array(cellCount);
  for (let i = 0; i < cellCount; i += 1) {
    cells[i] = decodeCell(reader);
  }
  return { index, dirty, cells };
}

function decodeCell(reader: FrameReader): TerminalCell {
  const col = reader.u16();
  const width = reader.u16();
  const styleBits = reader.u16();
  const colorFlags = reader.u8();
  const fg = (colorFlags & COLOR_FLAG_FG) !== 0 ? reader.color() : undefined;
  const bg = (colorFlags & COLOR_FLAG_BG) !== 0 ? reader.color() : undefined;
  const textLen = reader.u16();
  const text = reader.utf8(textLen);

  const underline = UNDERLINE_BY_CODE[(styleBits & STYLE_UNDERLINE_MASK) >> STYLE_UNDERLINE_SHIFT];
  if (!underline) throw new Error('decodeTerminalFrame: invalid underline kind');

  return {
    col,
    width,
    text,
    ...(fg ? { fg } : {}),
    ...(bg ? { bg } : {}),
    style: {
      bold: (styleBits & STYLE_BOLD) !== 0,
      italic: (styleBits & STYLE_ITALIC) !== 0,
      faint: (styleBits & STYLE_FAINT) !== 0,
      blink: (styleBits & STYLE_BLINK) !== 0,
      invisible: (styleBits & STYLE_INVISIBLE) !== 0,
      underline,
      inverse: (styleBits & STYLE_INVERSE) !== 0,
      strikethrough: (styleBits & STYLE_STRIKETHROUGH) !== 0,
      overline: (styleBits & STYLE_OVERLINE) !== 0,
    },
  };
}

// Decode base64 (as the harness SSE bridge sends) to bytes, then decode the
// frame. Browser-only (uses atob); the desktop Channel path never calls this.
export function decodeTerminalFrameBase64(base64: string): DecodedTerminalFrame {
  return decodeTerminalFrame(base64ToBytes(base64));
}

/**
 * Decode one binary row-band reply (kind 2) into its rows plus the generation
 * and start row they belong to. Symmetric with the Rust `encode_row_band`.
 *
 * Band rows are contiguous from `startRow`, so they carry no per-row index or
 * dirty flag: each decoded row's `index` is its 0-based offset within the band
 * (the caller adds `startRow` to place it absolutely) and `dirty` is true. The
 * `Cell` decode is the SAME {@link decodeCell} the frame path uses, so one
 * decoder serves both messages.
 */
export function decodeRowBand(input: ArrayBuffer | ArrayBufferView | number[]): DecodedRowBand {
  const reader = new FrameReader(toBytes(input));

  const kind = reader.u8();
  if (kind !== KIND_ROW_BAND) {
    throw new Error(`decodeRowBand: unexpected message kind ${kind}`);
  }
  const generation = reader.u32();
  const startRow = reader.u32();
  const rowCount = reader.u32();
  const rows: TerminalRow[] = new Array(rowCount);
  for (let i = 0; i < rowCount; i += 1) {
    const cellCount = reader.u16();
    const cells: TerminalCell[] = new Array(cellCount);
    for (let c = 0; c < cellCount; c += 1) {
      cells[c] = decodeCell(reader);
    }
    rows[i] = { index: i, dirty: true, cells };
  }

  return { generation, startRow, rows };
}

// Decode a base64 row band (the harness bridge sends the SAME wire bytes the
// Tauri command returns, base64'd). Browser-only (uses atob).
export function decodeRowBandBase64(base64: string): DecodedRowBand {
  return decodeRowBand(base64ToBytes(base64));
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
