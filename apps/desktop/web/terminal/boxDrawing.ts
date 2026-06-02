// Box-drawing line and junction glyphs are the one class of character that must
// span the cell edge to edge so neighbours tile into a continuous line. Reverie's
// cell (9px wide) is wider than the monospace advance the font rasterizes a glyph
// into (~8.43px at 14px), so a `─` painted from the font atlas leaves a sub-pixel
// gap on the right of every cell, which reads as evenly spaced notches/dots along
// an otherwise straight rule. Block elements (█ ▀ ▄ …) already dodge this by being
// drawn procedurally as rects; the line/junction set does not, so we decompose it
// here into device-aligned rects that abut (or harmlessly overlap) at cell seams.
//
// Each glyph is modelled as four arms (up, right, down, left), each with a weight:
// none, light, heavy, or double. A straight line is two opposite arms; a corner is
// two adjacent arms; a junction is three or four. Rounded corners are approximated
// as light corners (square join), which removes the artifact without a curve pass.

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

/**
 * Decompose a box-drawing glyph into solid rects that fill the cell to its edges.
 * Returns null for any character we do not draw procedurally (the caller should
 * fall back to the font atlas). Coordinates are CSS pixels snapped to the device
 * grid so the rects stay crisp; abutting cells share an exact edge (or overlap by
 * at most a pixel under fractional DPR), so a run of line glyphs never gaps.
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

  const leftPx = Math.round(cellX * scale);
  const topPx = Math.round(cellY * scale);
  const widthPx = Math.max(1, Math.round(cellWidth * scale));
  const heightPx = Math.max(1, Math.round(cellHeight * scale));
  const rightPx = leftPx + widthPx;
  const bottomPx = topPx + heightPx;
  const midX = Math.round(leftPx + widthPx / 2);
  const midY = Math.round(topPx + heightPx / 2);

  const lightThickness = Math.max(1, Math.round(scale));
  const heavyThickness = Math.max(lightThickness + 1, lightThickness * 2);
  const doubleOffset = lightThickness; // center-to-rail distance for double lines

  const rects: BoxDrawingRect[] = [];
  const emit = (x0: number, y0: number, x1: number, y1: number) => {
    if (x1 <= x0 || y1 <= y0) return;
    rects.push({ x: toCss(x0), y: toCss(y0), width: toCss(x1 - x0), height: toCss(y1 - y0) });
  };
  const horizontalRail = (centerY: number, thickness: number, x0: number, x1: number) => {
    const top = Math.round(centerY - thickness / 2);
    emit(x0, top, x1, top + thickness);
  };
  const verticalRail = (centerX: number, thickness: number, y0: number, y1: number) => {
    const left0 = Math.round(centerX - thickness / 2);
    emit(left0, y0, left0 + thickness, y1);
  };

  const horizontalArm = (weight: number, toRight: boolean) => {
    if (weight === NONE) return;
    if (weight === DOUBLE) {
      const x0 = toRight ? midX - doubleOffset : leftPx;
      const x1 = toRight ? rightPx : midX + doubleOffset;
      horizontalRail(midY - doubleOffset, lightThickness, x0, x1);
      horizontalRail(midY + doubleOffset, lightThickness, x0, x1);
      return;
    }
    const thickness = weight === HEAVY ? heavyThickness : lightThickness;
    const x0 = toRight ? midX - Math.floor(thickness / 2) : leftPx;
    const x1 = toRight ? rightPx : midX + Math.ceil(thickness / 2);
    horizontalRail(midY, thickness, x0, x1);
  };

  const verticalArm = (weight: number, toDown: boolean) => {
    if (weight === NONE) return;
    if (weight === DOUBLE) {
      const y0 = toDown ? midY - doubleOffset : topPx;
      const y1 = toDown ? bottomPx : midY + doubleOffset;
      verticalRail(midX - doubleOffset, lightThickness, y0, y1);
      verticalRail(midX + doubleOffset, lightThickness, y0, y1);
      return;
    }
    const thickness = weight === HEAVY ? heavyThickness : lightThickness;
    const y0 = toDown ? midY - Math.floor(thickness / 2) : topPx;
    const y1 = toDown ? bottomPx : midY + Math.ceil(thickness / 2);
    verticalRail(midX, thickness, y0, y1);
  };

  horizontalArm(right, true);
  horizontalArm(left, false);
  verticalArm(down, true);
  verticalArm(up, false);

  return rects;
}
