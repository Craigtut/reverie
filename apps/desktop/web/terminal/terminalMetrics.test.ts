import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  clampTerminalFontSize,
  measureTerminalCell,
  type FaceMeasure,
} from './terminalMetrics';

// A deterministic face that scales linearly with the font size, modelling a
// roughly SF-Mono-like monospace: ~0.6em advance, ~0.95em ascent, ~0.25em
// descent, ~0.05em gap. Lets the tests assert the pure cell math without a DOM.
function linearFace(ratios = { advance: 0.6, ascent: 0.95, descent: 0.25, lineGap: 0.05 }): {
  measure: FaceMeasure;
  fontSizeOf: (font: string) => number;
} {
  const fontSizeOf = (font: string) => {
    const match = /(\d+(?:\.\d+)?)px/.exec(font);
    return match ? Number(match[1]) : DEFAULT_TERMINAL_FONT_SIZE;
  };
  const measure: FaceMeasure = font => {
    const size = fontSizeOf(font);
    return {
      advance: size * ratios.advance,
      ascent: size * ratios.ascent,
      descent: size * ratios.descent,
      lineGap: size * ratios.lineGap,
    };
  };
  return { measure, fontSizeOf };
}

describe('clampTerminalFontSize', () => {
  it('clamps to the supported range and rounds to integer px', () => {
    expect(clampTerminalFontSize(5)).toBe(MIN_TERMINAL_FONT_SIZE);
    expect(clampTerminalFontSize(40)).toBe(MAX_TERMINAL_FONT_SIZE);
    expect(clampTerminalFontSize(13.6)).toBe(14);
    expect(clampTerminalFontSize(Number.NaN)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });
});

describe('measureTerminalCell', () => {
  const { measure } = linearFace();

  it('rounds the advance to an integer device px width', () => {
    // advance = 14 * 0.6 = 8.4 CSS px. At dpr 2 that is 16.8 device px ->
    // round -> 17, and the CSS width is 17 / 2 = 8.5 (fractional, as expected).
    const cell = measureTerminalCell(14, 'mono', 2, measure);
    expect(Math.round(cell.cellWidth * 2)).toBe(17);
    expect(cell.cellWidth).toBeCloseTo(8.5, 6);
  });

  it('keeps the cell device-aligned: cell * dpr is an integer at any dpr', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      for (const size of [9, 11, 14, 18, 24]) {
        const cell = measureTerminalCell(size, 'mono', dpr, measure);
        expect(Number.isInteger(Math.round(cell.cellWidth * dpr))).toBe(true);
        expect(cell.cellWidth * dpr).toBeCloseTo(Math.round(cell.cellWidth * dpr), 6);
        expect(cell.cellHeight * dpr).toBeCloseTo(Math.round(cell.cellHeight * dpr), 6);
      }
    }
  });

  it('uses round (not ceil/floor) for the height', () => {
    // height ratio = 0.95 + 0.25 + 0.05 = 1.25em. At 14px that is 17.5 CSS px;
    // at dpr 1, round(17.5) = 18 (round-half-up), not 17 (floor) or 18 (ceil
    // would also give 18, so pick a size where ceil and round diverge).
    // height at 10px = 12.5 device px (dpr 1) -> round -> 13, floor -> 12.
    const cell = measureTerminalCell(10, 'mono', 1, measure);
    expect(cell.cellHeight).toBe(13);
  });

  it('is monotonic non-decreasing in font size', () => {
    let lastWidth = 0;
    let lastHeight = 0;
    for (let size = MIN_TERMINAL_FONT_SIZE; size <= MAX_TERMINAL_FONT_SIZE; size += 1) {
      const cell = measureTerminalCell(size, 'mono', 2, measure);
      expect(cell.cellWidth).toBeGreaterThanOrEqual(lastWidth);
      expect(cell.cellHeight).toBeGreaterThanOrEqual(lastHeight);
      lastWidth = cell.cellWidth;
      lastHeight = cell.cellHeight;
    }
  });

  it('places the baseline inside the cell, near the ascent', () => {
    const cell = measureTerminalCell(14, 'mono', 2, measure);
    // The baseline is a device-px offset from the cell top; it must land inside
    // the cell and sit below the vertical midpoint (ascent dominates the face).
    expect(cell.baseline).toBeGreaterThan(0);
    expect(cell.baseline).toBeLessThan(cell.cellHeight * 2);
    expect(cell.baseline).toBeGreaterThan((cell.cellHeight * 2) / 2);
  });

  it('clamps the font size before measuring', () => {
    const cell = measureTerminalCell(100, 'mono', 1, measure);
    expect(cell.fontSize).toBe(MAX_TERMINAL_FONT_SIZE);
  });

  it('falls back to the em ratio when the face cannot be measured', () => {
    const cell = measureTerminalCell(14, 'mono', 1, () => null);
    // Fallback advance ratio is 0.6 -> 8.4 -> round -> 8 device px at dpr 1.
    expect(cell.cellWidth).toBe(8);
    expect(cell.cellHeight).toBeGreaterThan(0);
    expect(cell.baseline).toBeGreaterThan(0);
  });

  it('falls back when fontBoundingBox is unavailable but actualBoundingBox is', () => {
    // Simulate an engine that only reports the per-glyph ink box: the caller's
    // canvas measure would translate that into a FaceMetrics, which we model by
    // a face with smaller-but-valid extents. The cell must still be sane.
    const inkFace: FaceMeasure = () => ({ advance: 8.2, ascent: 9, descent: 2, lineGap: 0 });
    const cell = measureTerminalCell(14, 'mono', 2, inkFace);
    expect(cell.cellWidth).toBeGreaterThan(0);
    expect(cell.cellHeight).toBeGreaterThan(0);
    expect(Math.round(cell.cellWidth * 2)).toBe(Math.round(8.2 * 2));
  });

  it('never returns a zero-size cell even for a degenerate face', () => {
    const tinyFace: FaceMeasure = () => ({ advance: 0.01, ascent: 0.01, descent: 0, lineGap: 0 });
    const cell = measureTerminalCell(14, 'mono', 1, tinyFace);
    expect(cell.cellWidth).toBeGreaterThanOrEqual(1);
    expect(cell.cellHeight).toBeGreaterThanOrEqual(1);
  });
});
