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
  // Rounded corners (╭╮╰╯) are NOT here: a curve can't be made from axis-aligned
  // rects. They are stroked as anti-aliased arc sprites instead (see boxArcPath /
  // strokeBoxArc), the way Ghostty draws them, so the corner actually rounds.
};

// Light arc corners. A single stroked path (straight stub → quarter arc → straight
// stub) keeps a faint border one even tone (no overlapping rects to double-blend)
// and anti-aliases the curve. The stubs land on the cell edge at the same center
// line and thickness as the straight light rules, so corners join their lines.
const BOX_ARC_CHARS = new Set(['╭', '╮', '╰', '╯']);

export interface BoxDrawingRect {
  /** CSS-pixel coordinates (already device-grid aligned via the dpr). */
  x: number;
  y: number;
  width: number;
  height: number;
}

// Dashed rules: [axis, dash count, weight]. Drawn as evenly spaced rects at the
// cell's center line so a run of cells reads as one even dash rhythm.
const DASHED_LINES: Readonly<Record<string, readonly ['h' | 'v', number, number]>> = {
  '╌': ['h', 2, LIGHT],
  '╍': ['h', 2, HEAVY],
  '┄': ['h', 3, LIGHT],
  '┅': ['h', 3, HEAVY],
  '┈': ['h', 4, LIGHT],
  '┉': ['h', 4, HEAVY],
  '╎': ['v', 2, LIGHT],
  '╏': ['v', 2, HEAVY],
  '┆': ['v', 3, LIGHT],
  '┇': ['v', 3, HEAVY],
  '┊': ['v', 4, LIGHT],
  '┋': ['v', 4, HEAVY],
};

export function isBoxDrawingGlyph(text: string): boolean {
  return text.length === 1 && (text in BOX_ARMS || BOX_ARC_CHARS.has(text) || text in DASHED_LINES);
}

export function isBoxArcGlyph(text: string): boolean {
  return BOX_ARC_CHARS.has(text);
}

/** Light-rule thickness in the same units the cell box is given in. */
export function boxArcThickness(dpr: number): number {
  return Math.max(1, Math.round(dpr > 0 ? dpr : 1));
}

export type BoxArcCommand =
  | ['M', number, number]
  | ['L', number, number]
  | ['A', number, number, number, number, number, boolean];

/**
 * Path for a rounded corner glyph as moveTo/lineTo/arc commands, in the caller's
 * coordinate space (device pixels for the GPU atlas sprite, CSS pixels for the 2D
 * fallback). The corner is a straight stub from one cell edge, a quarter-circle
 * arc, and a straight stub to the adjacent edge; the radius is half the cell's
 * smaller dimension. Returns null for non-arc characters.
 */
export function boxArcPath(
  text: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): BoxArcCommand[] | null {
  if (!BOX_ARC_CHARS.has(text)) return null;
  const midX = (x0 + x1) / 2;
  const midY = (y0 + y1) / 2;
  const r = Math.min((x1 - x0) / 2, (y1 - y0) / 2);
  const HALF = Math.PI / 2;
  const PI = Math.PI;
  const TAU = Math.PI * 2;
  switch (text) {
    case '╭': // arc down and right: stub to the right edge, curve, stub to bottom
      return [
        ['M', x1, midY],
        ['L', midX + r, midY],
        ['A', midX + r, midY + r, r, 1.5 * PI, PI, true],
        ['L', midX, y1],
      ];
    case '╮': // arc down and left: stub to the left edge, curve, stub to bottom
      return [
        ['M', x0, midY],
        ['L', midX - r, midY],
        ['A', midX - r, midY + r, r, 1.5 * PI, TAU, false],
        ['L', midX, y1],
      ];
    case '╰': // arc up and right: stub to the top, curve, stub to the right edge
      return [
        ['M', midX, y0],
        ['L', midX, midY - r],
        ['A', midX + r, midY - r, r, PI, HALF, true],
        ['L', x1, midY],
      ];
    case '╯': // arc up and left: stub to the top, curve, stub to the left edge
      return [
        ['M', midX, y0],
        ['L', midX, midY - r],
        ['A', midX - r, midY - r, r, 0, HALF, false],
        ['L', x0, midY],
      ];
    default:
      return null;
  }
}

interface ArcContext {
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, start: number, end: number, ccw?: boolean): void;
  stroke(): void;
}

/**
 * Stroke a rounded corner glyph onto a 2D context (strokeStyle set by the caller).
 * Returns false for non-arc characters so the caller can fall back.
 */
export function strokeBoxArc(
  ctx: ArcContext,
  text: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number,
): boolean {
  const path = boxArcPath(text, x0, y0, x1, y1);
  if (!path) return false;
  ctx.lineWidth = thickness;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const command of path) {
    if (command[0] === 'M') ctx.moveTo(command[1], command[2]);
    else if (command[0] === 'L') ctx.lineTo(command[1], command[2]);
    else ctx.arc(command[1], command[2], command[3], command[4], command[5], command[6]);
  }
  ctx.stroke();
  return true;
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
  const dashed = DASHED_LINES[text];
  if (dashed) return dashedLineRects(dashed, cellX, cellY, cellWidth, cellHeight, dpr);

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

// Even dash pattern: each of the N cells-of-the-line is split into `count` slices,
// and the dash fills the middle ~60% of each slice. The leftover at the slice ends
// makes the gaps, sized so the rhythm stays even across the cell boundary too.
function dashedLineRects(
  [axis, count, weight]: readonly ['h' | 'v', number, number],
  cellX: number,
  cellY: number,
  cellWidth: number,
  cellHeight: number,
  dpr: number,
): BoxDrawingRect[] {
  const scale = dpr > 0 ? dpr : 1;
  const toCss = (device: number) => device / scale;
  const left = Math.round(cellX * scale);
  const top = Math.round(cellY * scale);
  const right = Math.round((cellX + cellWidth) * scale);
  const bottom = Math.round((cellY + cellHeight) * scale);
  const light = Math.max(1, Math.round(scale));
  const thickness = weight === HEAVY ? Math.max(light + 1, light * 2) : light;

  const rects: BoxDrawingRect[] = [];
  if (axis === 'h') {
    const center = Math.round((top + bottom) / 2);
    const t0 = Math.round(center - thickness / 2);
    const span = right - left;
    for (let i = 0; i < count; i += 1) {
      const a = left + Math.round(((i + 0.2) / count) * span);
      const b = left + Math.round(((i + 0.8) / count) * span);
      if (b > a)
        rects.push({ x: toCss(a), y: toCss(t0), width: toCss(b - a), height: toCss(thickness) });
    }
  } else {
    const center = Math.round((left + right) / 2);
    const x0 = Math.round(center - thickness / 2);
    const span = bottom - top;
    for (let i = 0; i < count; i += 1) {
      const a = top + Math.round(((i + 0.2) / count) * span);
      const b = top + Math.round(((i + 0.8) / count) * span);
      if (b > a)
        rects.push({ x: toCss(x0), y: toCss(a), width: toCss(thickness), height: toCss(b - a) });
    }
  }
  return rects;
}

export interface BlockElementGlyph {
  /** Disjoint, device-aligned fill rects (CSS pixels). */
  rects: BoxDrawingRect[];
  /** Opacity multiplier for the foreground; < 1 only for shade blocks (░▒▓). */
  alpha: number;
}

// Block elements (U+2580-259F) are solid partial-cell fills: halves, eighth bars
// (▁..▇ ▏..▉ ▔ ▕, used for progress bars and sparklines), quadrants and their
// combinations, and shades (░▒▓). Like the line rules they must tile edge to edge,
// so we draw them as device-aligned rects instead of from the font. Shades are a
// full-cell fill at reduced opacity (a clean, seamlessly tiling stand-in for the
// font's stipple). Returns null for anything that is not a block element.
export function blockElementGlyph(
  text: string,
  cellX: number,
  cellY: number,
  cellWidth: number,
  cellHeight: number,
  dpr: number,
): BlockElementGlyph | null {
  const scale = dpr > 0 ? dpr : 1;
  const toCss = (device: number) => device / scale;
  const left = Math.round(cellX * scale);
  const top = Math.round(cellY * scale);
  const right = Math.round((cellX + cellWidth) * scale);
  const bottom = Math.round((cellY + cellHeight) * scale);
  const width = right - left;
  const height = bottom - top;
  const midX = Math.round((left + right) / 2);
  const midY = Math.round((top + bottom) / 2);

  const rect = (x0: number, y0: number, x1: number, y1: number): BoxDrawingRect => ({
    x: toCss(x0),
    y: toCss(y0),
    width: toCss(x1 - x0),
    height: toCss(y1 - y0),
  });
  // Eighth bars fill from one edge; the cut is rounded to the device grid so equal
  // bars in adjacent cells line up (e.g. a flat run in a bar chart).
  const eighth = (n: number, size: number) => Math.round((n / 8) * size);
  const lower = (n: number) => [rect(left, bottom - eighth(n, height), right, bottom)];
  const upper = (n: number) => [rect(left, top, right, top + eighth(n, height))];
  const fromLeft = (n: number) => [rect(left, top, left + eighth(n, width), bottom)];
  const fromRight = (n: number) => [rect(right - eighth(n, width), top, right, bottom)];
  const ul = rect(left, top, midX, midY);
  const ur = rect(midX, top, right, midY);
  const ll = rect(left, midY, midX, bottom);
  const lr = rect(midX, midY, right, bottom);

  switch (text) {
    case '█':
      return { rects: [rect(left, top, right, bottom)], alpha: 1 };
    // Lower eighths (▁▂▃▄▅▆▇) and upper half/eighth.
    case '▁':
      return { rects: lower(1), alpha: 1 };
    case '▂':
      return { rects: lower(2), alpha: 1 };
    case '▃':
      return { rects: lower(3), alpha: 1 };
    case '▄':
      return { rects: lower(4), alpha: 1 };
    case '▅':
      return { rects: lower(5), alpha: 1 };
    case '▆':
      return { rects: lower(6), alpha: 1 };
    case '▇':
      return { rects: lower(7), alpha: 1 };
    case '▀':
      return { rects: upper(4), alpha: 1 };
    case '▔':
      return { rects: upper(1), alpha: 1 };
    // Left eighths (▏▎▍▌▋▊▉) and right half/eighth.
    case '▏':
      return { rects: fromLeft(1), alpha: 1 };
    case '▎':
      return { rects: fromLeft(2), alpha: 1 };
    case '▍':
      return { rects: fromLeft(3), alpha: 1 };
    case '▌':
      return { rects: fromLeft(4), alpha: 1 };
    case '▋':
      return { rects: fromLeft(5), alpha: 1 };
    case '▊':
      return { rects: fromLeft(6), alpha: 1 };
    case '▉':
      return { rects: fromLeft(7), alpha: 1 };
    case '▐':
      return { rects: fromRight(4), alpha: 1 };
    case '▕':
      return { rects: fromRight(1), alpha: 1 };
    // Shades: a full-cell fill at reduced opacity.
    case '░':
      return { rects: [rect(left, top, right, bottom)], alpha: 0.25 };
    case '▒':
      return { rects: [rect(left, top, right, bottom)], alpha: 0.5 };
    case '▓':
      return { rects: [rect(left, top, right, bottom)], alpha: 0.75 };
    // Quadrants and their combinations.
    case '▖':
      return { rects: [ll], alpha: 1 };
    case '▗':
      return { rects: [lr], alpha: 1 };
    case '▘':
      return { rects: [ul], alpha: 1 };
    case '▝':
      return { rects: [ur], alpha: 1 };
    case '▙':
      return { rects: [ul, ll, lr], alpha: 1 };
    case '▚':
      return { rects: [ul, lr], alpha: 1 };
    case '▛':
      return { rects: [ul, ur, ll], alpha: 1 };
    case '▜':
      return { rects: [ul, ur, lr], alpha: 1 };
    case '▞':
      return { rects: [ur, ll], alpha: 1 };
    case '▟':
      return { rects: [ur, ll, lr], alpha: 1 };
    default:
      return null;
  }
}
