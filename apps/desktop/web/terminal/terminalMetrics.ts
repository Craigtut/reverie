// Font-derived terminal cell sizing, adopting Ghostty's recipe (verified against
// src/font/Metrics.zig). Replaces the old hardcoded 9x18px cell: the cell is
// measured from the configured monospace font so it tracks the font-size setting
// and stays crisp on any DPI.
//
// The shape of the recipe:
// - cell width  = round(max glyph advance over printable ASCII), in device px.
// - cell height = round(ascent + descent + line gap), in device px, via the
//   canvas TextMetrics fontBoundingBox metrics (round, never ceil/floor: it
//   stays within 0.5px of the true height and is stable across DPI; Ghostty
//   switched ceil->round in 1.3.0).
// - Cells snap to integer DEVICE pixels, then the CSS size is device/dpr. So the
//   CSS cell may be fractional (e.g. 8.5px) while cell*dpr is always an integer,
//   which is exactly what keeps the grid device-aligned and crisp.
// - The baseline centers the face in the rounded cell, splitting the rounding
//   slack evenly, so glyphs sit centered instead of jammed to the reported
//   descent.
//
// The DOM measurement (an offscreen canvas measureText) is injected so the pure
// math is unit-testable under Node, and so a future caller could measure once
// and reuse.

export interface TerminalCellMetrics {
  /** CSS px width of one cell. May be fractional; `cellWidth * dpr` is integer. */
  cellWidth: number;
  /** CSS px height of one cell. May be fractional; `cellHeight * dpr` is integer. */
  cellHeight: number;
  /**
   * Device-px offset from the top of the cell to the text baseline. Glyph
   * rasterization draws with `textBaseline: 'alphabetic'` at this y so the face
   * sits centered in the rounded cell.
   */
  baseline: number;
  /** The font size (CSS px) the cell was measured at, echoed for the renderer. */
  fontSize: number;
}

// The advance (max width) and vertical extents of a font face at a given size,
// all in CSS px. `lineGap` is the font's recommended extra leading.
export interface FaceMetrics {
  advance: number;
  ascent: number;
  descent: number;
  lineGap: number;
}

// Pluggable measurement so the math is testable without a DOM. Given a CSS
// `font` string it returns the face metrics in CSS px, or null if it cannot
// measure (no canvas), which sends `measureTerminalCell` to its em-ratio
// fallback.
export type FaceMeasure = (font: string, fontSize: number) => FaceMetrics | null;

export const MIN_TERMINAL_FONT_SIZE = 9;
export const MAX_TERMINAL_FONT_SIZE = 24;
export const DEFAULT_TERMINAL_FONT_SIZE = 14;
export const DEFAULT_TERMINAL_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

// Printable ASCII (0x20..0x7e). cell_width is the max advance over this set; for
// a monospace face every printable glyph shares the advance, but measuring the
// max is robust to a face that is not perfectly fixed-pitch.
const PRINTABLE_ASCII = (() => {
  let out = '';
  for (let code = 0x20; code <= 0x7e; code += 1) out += String.fromCharCode(code);
  return out;
})();

// Em-ratio fallback when fontBoundingBox metrics are unavailable (no canvas, or
// an engine that does not report them). These ratios approximate a typical
// monospace face: ~0.6em advance, ~1.2em line box split into ~0.8/0.2/0.05
// ascent/descent/gap. Only used as a last resort; modern WebKit/Chromium report
// fontBoundingBox so the real path is taken in the app and harness.
const FALLBACK_ADVANCE_RATIO = 0.6;
const FALLBACK_ASCENT_RATIO = 0.8;
const FALLBACK_DESCENT_RATIO = 0.2;
const FALLBACK_LINE_GAP_RATIO = 0.05;

export function clampTerminalFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(value)));
}

function fontString(fontSize: number, fontFamily: string): string {
  return `400 ${fontSize}px ${fontFamily}`;
}

// Lazily-created offscreen canvas for measurement, reused across calls. Returns
// null in a non-DOM environment (the unit tests) so the caller falls back.
let scratchContext: CanvasRenderingContext2D | null | undefined;
function defaultScratchContext(): CanvasRenderingContext2D | null {
  if (scratchContext !== undefined) return scratchContext;
  if (typeof document === 'undefined') {
    scratchContext = null;
    return null;
  }
  const canvas = document.createElement('canvas');
  scratchContext = canvas.getContext('2d');
  return scratchContext;
}

// Measure the face via an offscreen canvas. Prefers fontBoundingBox (the font's
// own line box, what Ghostty uses), then falls back to the per-glyph
// actualBoundingBox extents, then to null so the caller uses the em ratio.
export const canvasFaceMeasure: FaceMeasure = (font, fontSize) => {
  const ctx = defaultScratchContext();
  if (!ctx) return null;
  ctx.font = font;
  // Advance: the widest printable ASCII glyph. measureText().width is the pen
  // advance, which for a monospace face is the cell advance.
  let advance = 0;
  for (const ch of PRINTABLE_ASCII) {
    const width = ctx.measureText(ch).width;
    if (width > advance) advance = width;
  }
  // Vertical extents: a representative metrics sample. fontBoundingBox* is the
  // font's declared line box (independent of the sampled glyphs) and is the
  // value to prefer; actualBoundingBox* is per-glyph ink and is the fallback.
  const sample = ctx.measureText(PRINTABLE_ASCII);
  const ascent =
    finiteOrNull(sample.fontBoundingBoxAscent) ?? finiteOrNull(sample.actualBoundingBoxAscent);
  const descent =
    finiteOrNull(sample.fontBoundingBoxDescent) ?? finiteOrNull(sample.actualBoundingBoxDescent);
  if (advance <= 0 || ascent === null || descent === null) return null;
  // Canvas TextMetrics does not expose the font's line gap, so derive a small
  // leading from the size (Ghostty folds line_gap into cell height; without a
  // reported gap a touch of leading keeps rows from butting together).
  const lineGap = Math.max(0, fontSize * FALLBACK_LINE_GAP_RATIO);
  return { advance, ascent, descent, lineGap };
};

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function emRatioFace(fontSize: number): FaceMetrics {
  return {
    advance: fontSize * FALLBACK_ADVANCE_RATIO,
    ascent: fontSize * FALLBACK_ASCENT_RATIO,
    descent: fontSize * FALLBACK_DESCENT_RATIO,
    lineGap: fontSize * FALLBACK_LINE_GAP_RATIO,
  };
}

// Derive the device-aligned terminal cell for a font size + family at a DPR.
// `measure` is injectable for tests; production passes `canvasFaceMeasure`.
export function measureTerminalCell(
  fontSizePx: number,
  fontFamily: string = DEFAULT_TERMINAL_FONT_FAMILY,
  dpr = 1,
  measure: FaceMeasure = canvasFaceMeasure,
): TerminalCellMetrics {
  const fontSize = clampTerminalFontSize(fontSizePx);
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const face = measure(fontString(fontSize, fontFamily), fontSize) ?? emRatioFace(fontSize);

  const faceAdvance = face.advance > 0 ? face.advance : emRatioFace(fontSize).advance;
  const faceAscent = face.ascent;
  const faceDescent = Math.max(0, face.descent);
  const faceLineGap = Math.max(0, face.lineGap);
  const faceHeight = faceAscent + faceDescent + faceLineGap;

  // Snap the cell to integer DEVICE px (round, never ceil/floor), then expose
  // the CSS size as device/dpr. Clamp to a 1-device-px minimum so a pathological
  // measurement never yields a zero-size cell (which would divide by zero in the
  // grid math).
  const cellWidthDevice = Math.max(1, Math.round(faceAdvance * safeDpr));
  const cellHeightDevice = Math.max(1, Math.round(faceHeight * safeDpr));
  const cellWidth = cellWidthDevice / safeDpr;
  const cellHeight = cellHeightDevice / safeDpr;

  // Center the face in the rounded cell, splitting the rounding slack evenly
  // (Ghostty's face_baseline + cell_baseline). face_baseline is measured from
  // the cell top: ascent + half the leading, shifted up by half the difference
  // between the rounded cell and the true face height. Returned in DEVICE px so
  // the rasterizer can use it directly with `textBaseline: 'alphabetic'`.
  const faceBaseline = faceAscent + faceLineGap / 2;
  const cellBaselineCss = faceBaseline - (cellHeight - faceHeight) / 2;
  const baseline = Math.round(cellBaselineCss * safeDpr);

  return { cellWidth, cellHeight, baseline, fontSize };
}
