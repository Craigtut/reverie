import { describe, expect, it } from 'vitest';
import {
  decodeRowBand,
  decodeRowBandBase64,
  decodeTerminalFrame,
  decodeTerminalFrameBase64,
} from './wireDecode';

// The exact byte vector produced by the Rust encoder's golden test
// (terminal::wire::tests::GOLDEN_BYTES in
// apps/desktop/src-tauri/src/terminal/wire.rs) for a small fixed frame at
// generation 1. This cross-checks the two wire implementations: if either side
// changes the encoding, this array and the Rust copy must be updated together.
//
// The frame: dirty=Full, cols=3, viewportRows=1, cursor visible at (col 1,
// row 0) Block style, default modes, fg #EFE9DF / bg #0B0A09, no cursor color,
// scrollback total=1 scrollback=0 offset=0 viewport=1 atBottom=true, one row
// (index 0, dirty) with two cells: 'H' (bold + single underline, fg #FF0000)
// and 'i' (plain).
const GOLDEN_BYTES = new Uint8Array([
  // kind, generation (u32 LE = 1)
  0x01, 0x01, 0x00, 0x00, 0x00,
  // dirty (2 = Full)
  0x02,
  // cols (u16 = 3)
  0x03, 0x00,
  // rows header (u16 = 1, viewport rows)
  0x01, 0x00,
  // cursor flags (visible|has_position = 5), style (0 = Block)
  0x05, 0x00,
  // cursor col (u16 = 1), row (u16 = 0)
  0x01, 0x00, 0x00, 0x00,
  // modes flags (u16 = 0), kitty flags (u8 = 0)
  0x00, 0x00, 0x00,
  // colors.fg (EF E9 DF), colors.bg (0B 0A 09)
  0xef, 0xe9, 0xdf, 0x0b, 0x0a, 0x09,
  // colors.has_cursor (0)
  0x00,
  // scrollback: total_rows=1, scrollback_rows=0, viewport_offset=0,
  // viewport_rows=1, at_bottom=1
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
  0x01,
  // row_count (u32 = 1)
  0x01, 0x00, 0x00, 0x00,
  // row[0]: index (u16 = 0), dirty (1), cell_count (u16 = 2)
  0x00, 0x00, 0x01, 0x02, 0x00,
  // cell[0]: col=0, width=1, style (bold|underline Single = 0x0101),
  // color_flags (fg only = 1)
  0x00, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01,
  // cell[0].fg (FF 00 00)
  0xff, 0x00, 0x00,
  // cell[0].text_len (u16 = 1), 'H'
  0x01, 0x00, 0x48,
  // cell[1]: col=1, width=1, style=0, color_flags=0
  0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  // cell[1].text_len (u16 = 1), 'i'
  0x01, 0x00, 0x69,
]);

describe('decodeTerminalFrame (golden cross-check with Rust encoder)', () => {
  it('decodes the golden bytes to the expected frame and generation', () => {
    const decoded = decodeTerminalFrame(GOLDEN_BYTES.buffer);

    expect(decoded.generation).toBe(1);
    expect(decoded.dirty).toBe('full');
    expect(decoded.frame).toEqual({
      dirty: 'full',
      cols: 3,
      cursor: {
        visible: true,
        blinking: false,
        style: 'block',
        position: { row: 0, col: 1 },
      },
      modes: {
        cursorKeyApplication: false,
        keypadKeyApplication: false,
        bracketedPaste: false,
        syncOutput: false,
        mouseTracking: false,
        alternateScreen: false,
        kittyKeyboardFlags: 0,
      },
      colors: {
        foreground: { r: 0xef, g: 0xe9, b: 0xdf },
        background: { r: 0x0b, g: 0x0a, b: 0x09 },
      },
      scrollback: {
        totalRows: 1,
        scrollbackRows: 0,
        viewportOffset: 0,
        viewportRows: 1,
        atBottom: true,
      },
      rows: [
        {
          index: 0,
          dirty: true,
          cells: [
            {
              col: 0,
              width: 1,
              text: 'H',
              fg: { r: 0xff, g: 0x00, b: 0x00 },
              style: {
                bold: true,
                italic: false,
                faint: false,
                blink: false,
                invisible: false,
                underline: 'single',
                inverse: false,
                strikethrough: false,
                overline: false,
              },
            },
            {
              col: 1,
              width: 1,
              text: 'i',
              style: {
                bold: false,
                italic: false,
                faint: false,
                blink: false,
                invisible: false,
                underline: 'none',
                inverse: false,
                strikethrough: false,
                overline: false,
              },
            },
          ],
        },
      ],
    });
  });

  it('decodes the same bytes from a base64 SSE payload (harness bridge path)', () => {
    // The harness bridge base64s the identical wire bytes; decoding that string
    // must produce the same frame as decoding the raw ArrayBuffer.
    const base64 = Buffer.from(GOLDEN_BYTES).toString('base64');
    const fromBase64 = decodeTerminalFrameBase64(base64);
    const fromBuffer = decodeTerminalFrame(GOLDEN_BYTES.buffer);
    expect(fromBase64).toEqual(fromBuffer);
  });

  it('rejects a message with an unexpected kind byte', () => {
    const bad = GOLDEN_BYTES.slice();
    bad[0] = 0xff;
    expect(() => decodeTerminalFrame(bad.buffer)).toThrow(/unexpected message kind/);
  });

  it('accepts a Uint8Array and a number[] as well as an ArrayBuffer', () => {
    const fromArrayBuffer = decodeTerminalFrame(GOLDEN_BYTES.buffer);
    const fromTypedArray = decodeTerminalFrame(GOLDEN_BYTES);
    const fromNumberArray = decodeTerminalFrame(Array.from(GOLDEN_BYTES));
    expect(fromTypedArray).toEqual(fromArrayBuffer);
    expect(fromNumberArray).toEqual(fromArrayBuffer);
  });
});

// The exact byte vector produced by the Rust encoder's golden row-band test
// (terminal::wire::tests::GOLDEN_BAND_BYTES in
// apps/desktop/src-tauri/src/terminal/wire.rs) for a small fixed band at
// generation 1, start row 2. This cross-checks the two row-band implementations:
// if either side changes the encoding, this array and the Rust copy must be
// updated together. The single populated cell is the frame golden's 'H' cell, so
// the shared `Cell` encoding is visibly identical across both messages.
const GOLDEN_BAND_BYTES = new Uint8Array([
  // kind (2 = row band), generation (u32 LE = 1)
  0x02, 0x01, 0x00, 0x00, 0x00,
  // start_row (u32 = 2)
  0x02, 0x00, 0x00, 0x00,
  // row_count (u32 = 2)
  0x02, 0x00, 0x00, 0x00,
  // band row[0]: cell_count (u16 = 1)
  0x01, 0x00,
  // cell[0]: col=0, width=1, style (bold|underline Single = 0x0101),
  // color_flags (fg only = 1)
  0x00, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01,
  // cell[0].fg (FF 00 00)
  0xff, 0x00, 0x00,
  // cell[0].text_len (u16 = 1), 'H'
  0x01, 0x00, 0x48,
  // band row[1]: cell_count (u16 = 0)
  0x00, 0x00,
]);

describe('decodeRowBand (golden cross-check with Rust encoder)', () => {
  it('decodes the golden band bytes to the expected rows, generation and start row', () => {
    const decoded = decodeRowBand(GOLDEN_BAND_BYTES.buffer);

    expect(decoded.generation).toBe(1);
    expect(decoded.startRow).toBe(2);
    expect(decoded.rows).toEqual([
      {
        index: 0,
        dirty: true,
        cells: [
          {
            col: 0,
            width: 1,
            text: 'H',
            fg: { r: 0xff, g: 0x00, b: 0x00 },
            style: {
              bold: true,
              italic: false,
              faint: false,
              blink: false,
              invisible: false,
              underline: 'single',
              inverse: false,
              strikethrough: false,
              overline: false,
            },
          },
        ],
      },
      { index: 1, dirty: true, cells: [] },
    ]);
  });

  it('decodes the same band from a base64 SSE payload (harness bridge path)', () => {
    const base64 = Buffer.from(GOLDEN_BAND_BYTES).toString('base64');
    const fromBase64 = decodeRowBandBase64(base64);
    const fromBuffer = decodeRowBand(GOLDEN_BAND_BYTES.buffer);
    expect(fromBase64).toEqual(fromBuffer);
  });

  it('rejects a band with an unexpected kind byte', () => {
    const bad = GOLDEN_BAND_BYTES.slice();
    bad[0] = 0x01; // a frame kind is not a row band
    expect(() => decodeRowBand(bad.buffer)).toThrow(/unexpected message kind/);
  });
});
