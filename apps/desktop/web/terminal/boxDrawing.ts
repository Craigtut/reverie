// Box-drawing line and junction glyphs are the one class of character that must
// span the cell edge to edge so neighbours tile into a continuous line. Reverie's
// cell (9px wide) is wider than the monospace advance the font rasterizes a glyph
// into (~8.43px at 14px), so a `─` painted from the font atlas leaves a sub-pixel
// gap on the right of every cell, which reads as evenly spaced notches/dots along
// an otherwise straight rule. Block elements (█ ▀ ▄ …) already dodge this by being
// drawn procedurally as rects; the line/junction set does not, so we decompose it
// here into device-aligned rects that abut at cell seams.
//
// Each glyph is modelled as four arms (up, right, down, left), each with a weight:
// none, light, heavy, or double. We collapse the arms into at most one horizontal
// bar and one vertical bar, then emit the vertical bar with the horizontal band
// punched out so NO pixel is ever covered twice. That disjointness matters: box
// borders are often drawn faint (translucent), and overlapping rects of the same
// translucent colour double-blend into a brighter dot. Disjoint rects keep a faint
// line a single, even tone. Rounded corners are approximated as light square
// corners, which removes the artifact without a curve pass.

const NONE = 0;
const LIGHT = 1;
const HEAVY = 2;
const DOUBLE = 3;

// [up, right, down, left]
type Arms = readonly [number, number, number, number];

const BOX_ARMS: Readonly<Record<string, Arms>> = {
  // Light
  '─': [NONE, LIGHT, NONE, LIGHT],
  '│': [LIGHT, NONE, LIGHT, NONE],
  '┌': [NONE, LIGHT, LIGHT, NONE],
  '┐': [NONE, NONE, LIGHT, LIGHT],
  '└': [LIGHT, LIGHT, NONE, NONE],
  '┘': [LIGHT, NONE, NONE, LIGHT],
  '├': [LIGHT, LIGHT, LIGHT, NONE],
  '┤': [LIGHT, NONE, LIGHT, LIGHT],
  '┬': [NONE, LIGHT, LIGHT, LIGHT],
  '┴': [LIGHT, LIGHT, NONE, LIGHT],
  '┼': [LIGHT, LIGHT, LIGHT, LIGHT],
  // Heavy
  '━': [NONE, HEAVY, NONE, HEAVY],
  '┃': [HEAVY, NONE, HEAVY, NONE],
  '┏': [NONE, HEAVY, HEAVY, NONE],
  '┓': [NONE, NONE, HEAVY, HEAVY],
  '┗': [HEAVY, HEAVY, NONE, NONE],
  '┛': [HEAVY, NONE, NONE, HEAVY],
  '┣': [HEAVY, HEAVY, HEAVY, NONE],
  '┫': [HEAVY, NONE, HEAVY, HEAVY],
  '┳': [NONE, HEAVY, HEAVY, HEAVY],
  '┻': [HEAVY, HEAVY, NONE, HEAVY],
  '╋': [HEAVY, HEAVY, HEAVY, HEAVY],
  // Double
  '═': [NONE, DOUBLE, NONE, DOUBLE],
  '║': [DOUBLE, NONE, DOUBLE, NONE],
  '╔': [NONE, DOUBLE, DOUBLE, NONE],
  '╗': [NONE, NONE, DOUBLE, DOUBLE],
  '╚': [DOUBLE, DOUBLE, NONE, NONE],
  '╝': [DOUBLE, NONE, NONE, DOUBLE],
  '╠': [DOUBLE, DOUBLE, DOUBLE, NONE],
  '╣': [DOUBLE, NONE, DOUBLE, DOUBLE],
  '╦': [NONE, DOUBLE, DOUBLE, DOUBLE],
  '╩': [DOUBLE, DOUBLE, NONE, DOUBLE],
  '╬': [DOUBLE, DOUBLE, DOUBLE, DOUBLE],
  // Rounded corners (approximated as light square corners)
  '╭': [NONE, LIGHT, LIGHT, NONE],
  '╮': [NONE, NONE, LIGHT, LIGHT],
  '╰': [LIGHT, LIGHT, NONE, NONE],
  '╯': [LIGHT, NONE, NONE, LIGHT],
};

export interface BoxDrawingRect {
  /** CSS-pixel coordinates (already device-grid aligned via the dpr). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isBoxDrawingGlyph(text: string): boolean {
  return text.length === 1 && text in BOX_ARMS;
}

interface Rail {
  /** Center line, in device pixels (Y for horizontal rails, X for vertical). */
  center: number;
  /** Thickness in device pixels. */
  thickness: number;
}

// Punch the band [b0, b1) out of each [s0, s1) segment, returning the remainder.
// Used so a vertical rail never overlaps a horizontal one (no double-blend).
function subtractBand(segments: Array<[number, number]>, b0: number, b1: number) {
  const out: Array<[number, number]> = [];
  for (const [s0, s1] of segments) {
    if (b1 <= s0 || b0 >= s1) {
      out.push([s0, s1]);
      continue;
    }
    if (b0 > s0) out.push([s0, b0]);
    if (b1 < s1) out.push([b1, s1]);
  }
  return out;
}

/**
 * Decompose a box-drawing glyph into solid, mutually disjoint rects that fill the
 * cell to its edges. Returns null for any character we do not draw procedurally
 * (the caller should fall back to the font atlas). Coordinates are CSS pixels
 * snapped to the device grid so the rects stay crisp; adjacent cells share an exact
 * device edge, so a run of line glyphs never gaps and never overlaps.
 */
export function boxDrawingRects(
  text: string,
  cellX: number,
  cellY: number,
  cellWidth: number,
  cellHeight: number,
  dpr: number,
): BoxDrawingRect[] | null {
  const arms = BOX_ARMS[text];
  if (!arms) return null;
  const [up, right, down, left] = arms;

  const scale = dpr > 0 ? dpr : 1;
  const toCss = (device: number) => device / scale;

  // Round absolute cell edges (not width) so neighbouring cells share an exact
  // device-pixel boundary at any DPR: cell N's right edge == cell N+1's left edge.
  const leftPx = Math.round(cellX * scale);
  const topPx = Math.round(cellY * scale);
  const rightPx = Math.round((cellX + cellWidth) * scale);
  const bottomPx = Math.round((cellY + cellHeight) * scale);
  const midX = Math.round((leftPx + rightPx) / 2);
  const midY = Math.round((topPx + bottomPx) / 2);

  const lightThickness = Math.max(1, Math.round(scale));
  const heavyThickness = Math.max(lightThickness + 1, lightThickness * 2);
  const doubleOffset = lightThickness; // center-to-rail distance for double lines

  const thicknessFor = (weight: number) => (weight === HEAVY ? heavyThickness : lightThickness);

  // Collapse opposite arms into one bar per axis. Every glyph in the table is a
  // single weight, so the present arms on an axis always agree; max() picks it.
  const horizontalWeight = Math.max(left, right);
  const verticalWeight = Math.max(up, down);

  const horizontalRails: Rail[] = [];
  if (horizontalWeight === DOUBLE) {
    horizontalRails.push(
      { center: midY - doubleOffset, thickness: lightThickness },
      { center: midY + doubleOffset, thickness: lightThickness },
    );
  } else if (horizontalWeight !== NONE) {
    horizontalRails.push({ center: midY, thickness: thicknessFor(horizontalWeight) });
  }

  const verticalRails: Rail[] = [];
  if (verticalWeight === DOUBLE) {
    verticalRails.push(
      { center: midX - doubleOffset, thickness: lightThickness },
      { center: midX + doubleOffset, thickness: lightThickness },
    );
  } else if (verticalWeight !== NONE) {
    verticalRails.push({ center: midX, thickness: thicknessFor(verticalWeight) });
  }

  const bandOf = (rail: Rail): [number, number] => {
    const start = Math.round(rail.center - rail.thickness / 2);
    return [start, start + rail.thickness];
  };

  // The extent of each bar: a present arm reaches the cell edge; an absent arm
  // stops at the far edge of the perpendicular bar so corners/tees still join.
  const verticalBand = verticalRails.length
    ? [
        Math.min(...verticalRails.map(rail => bandOf(rail)[0])),
        Math.max(...verticalRails.map(rail => bandOf(rail)[1])),
      ]
    : [midX, midX];
  const horizontalBand = horizontalRails.length
    ? [
        Math.min(...horizontalRails.map(rail => bandOf(rail)[0])),
        Math.max(...horizontalRails.map(rail => bandOf(rail)[1])),
      ]
    : [midY, midY];

  const horizontalStart = left ? leftPx : verticalBand[0];
  const horizontalEnd = right ? rightPx : verticalBand[1];
  const verticalStart = up ? topPx : horizontalBand[0];
  const verticalEnd = down ? bottomPx : horizontalBand[1];

  const rects: BoxDrawingRect[] = [];
  const emit = (x0: number, y0: number, x1: number, y1: number) => {
    if (x1 <= x0 || y1 <= y0) return;
    rects.push({ x: toCss(x0), y: toCss(y0), width: toCss(x1 - x0), height: toCss(y1 - y0) });
  };

  // Horizontal bar(s) first, full span.
  const bands: Array<[number, number]> = [];
  for (const rail of horizontalRails) {
    const [y0, y1] = bandOf(rail);
    emit(horizontalStart, y0, horizontalEnd, y1);
    bands.push([y0, y1]);
  }
  // Vertical bar(s) with the horizontal band(s) punched out, so nothing overlaps.
  for (const rail of verticalRails) {
    const [x0, x1] = bandOf(rail);
    let segments: Array<[number, number]> = [[verticalStart, verticalEnd]];
    for (const band of bands) {
      segments = subtractBand(segments, band[0], band[1]);
    }
    for (const [y0, y1] of segments) {
      emit(x0, y0, x1, y1);
    }
  }

  return rects;
}
