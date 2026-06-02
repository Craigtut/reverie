import { describe, expect, it } from 'vitest';

import {
  blockElementGlyph,
  boxArcPath,
  boxDrawingRects,
  isBoxArcGlyph,
  isBoxDrawingGlyph,
} from './boxDrawing';

const CELL_W = 9;
const CELL_H = 18;

function rectsFor(text: string, col: number, dpr = 2) {
  const rects = boxDrawingRects(text, col * CELL_W, 0, CELL_W, CELL_H, dpr);
  if (!rects) throw new Error(`expected box-drawing rects for ${JSON.stringify(text)}`);
  return rects;
}

function bounds(rects: { x: number; y: number; width: number; height: number }[]) {
  return {
    left: Math.min(...rects.map(r => r.x)),
    right: Math.max(...rects.map(r => r.x + r.width)),
    top: Math.min(...rects.map(r => r.y)),
    bottom: Math.max(...rects.map(r => r.y + r.height)),
  };
}

function maxPairwiseOverlap(rects: { x: number; y: number; width: number; height: number }[]) {
  let worst = 0;
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (ox > 0 && oy > 0) worst = Math.max(worst, ox * oy);
    }
  }
  return worst;
}

describe('boxDrawingRects', () => {
  it('returns null for non-box characters so they fall back to the font atlas', () => {
    expect(boxDrawingRects('a', 0, 0, CELL_W, CELL_H, 2)).toBeNull();
    expect(boxDrawingRects(' ', 0, 0, CELL_W, CELL_H, 2)).toBeNull();
    expect(boxDrawingRects('█', 0, 0, CELL_W, CELL_H, 2)).toBeNull();
    expect(isBoxDrawingGlyph('a')).toBe(false);
    expect(isBoxDrawingGlyph('─')).toBe(true);
  });

  it('routes rounded corners to the arc path, not the rect path', () => {
    for (const corner of ['╭', '╮', '╰', '╯']) {
      // Curves can't be rects, so the rect decomposition declines them...
      expect(boxDrawingRects(corner, 0, 0, CELL_W, CELL_H, 2)).toBeNull();
      // ...but they're still box-drawing glyphs, handled as arc sprites.
      expect(isBoxDrawingGlyph(corner)).toBe(true);
      expect(isBoxArcGlyph(corner)).toBe(true);
      const path = boxArcPath(corner, 0, 0, CELL_W, CELL_H);
      expect(path).not.toBeNull();
      // A corner is: straight stub, a single quarter arc, straight stub.
      const arcs = path?.filter(cmd => cmd[0] === 'A') ?? [];
      expect(arcs).toHaveLength(1);
    }
    expect(isBoxArcGlyph('─')).toBe(false);
    expect(boxArcPath('a', 0, 0, CELL_W, CELL_H)).toBeNull();
  });

  it('lands the ╭ arc stubs on the cell edges so it joins its neighbours', () => {
    // ╭ joins a `─` to its right (cell edge, vertical center) and a `│` below it
    // (bottom edge, horizontal center).
    const path = boxArcPath('╭', 0, 0, CELL_W, CELL_H);
    if (!path) throw new Error('expected arc path');
    expect(path[0]).toEqual(['M', CELL_W, CELL_H / 2]); // start at right edge, mid height
    const last = path[path.length - 1];
    expect(last).toEqual(['L', CELL_W / 2, CELL_H]); // end at bottom edge, mid width
  });

  it('draws a straight line as a single rect (no center overlap to double-blend)', () => {
    // A faint border double-blends wherever rects overlap, which shows as a bright
    // dot. Straight runs must be one rect; junctions must stay disjoint.
    expect(rectsFor('─', 0)).toHaveLength(1);
    expect(rectsFor('│', 0)).toHaveLength(1);
    for (const glyph of ['─', '│', '┼', '┌', '┐', '└', '┘', '├', '┬', '═', '║', '╬']) {
      for (const dpr of [1, 1.5, 2, 3]) {
        const rects = boxDrawingRects(glyph, 0, 0, CELL_W, CELL_H, dpr);
        if (!rects) throw new Error(`expected rects for ${glyph}`);
        // Effectively zero; allow sub-pixel float residue from the CSS conversion.
        expect(maxPairwiseOverlap(rects)).toBeLessThan(1e-6);
      }
    }
  });

  it('draws a light horizontal rule that spans the full cell width', () => {
    const box = bounds(rectsFor('─', 0));
    expect(box.left).toBe(0);
    expect(box.right).toBe(CELL_W);
    // Centered vertically and thin.
    expect(box.top).toBeGreaterThan(CELL_H / 2 - 2);
    expect(box.bottom).toBeLessThan(CELL_H / 2 + 2);
  });

  it('never leaves a gap between adjacent horizontal cells (the dotted-line bug)', () => {
    for (const dpr of [1, 1.5, 2, 2.5, 3]) {
      const left = rectsFor('─', 0, dpr);
      const right = rectsFor('─', 1, dpr);
      const leftEnd = Math.max(...left.map(r => r.x + r.width));
      const rightStart = Math.min(...right.map(r => r.x));
      // Adjacent line segments must touch or overlap; they must never gap.
      expect(rightStart).toBeLessThanOrEqual(leftEnd + 1e-6);
    }
  });

  it('draws a vertical rule that spans the full cell height', () => {
    const box = bounds(rectsFor('│', 0));
    expect(box.top).toBe(0);
    expect(box.bottom).toBe(CELL_H);
    expect(box.left).toBeGreaterThan(CELL_W / 2 - 2);
    expect(box.right).toBeLessThan(CELL_W / 2 + 2);
  });

  it('draws a cross that fills both axes edge to edge', () => {
    const box = bounds(rectsFor('┼', 0));
    expect(box.left).toBe(0);
    expect(box.right).toBe(CELL_W);
    expect(box.top).toBe(0);
    expect(box.bottom).toBe(CELL_H);
  });

  it('draws a top-left corner that only reaches the right and bottom edges', () => {
    const box = bounds(rectsFor('┌', 0));
    // Arms go right and down from center: reaches right/bottom, not left/top.
    expect(box.right).toBe(CELL_W);
    expect(box.bottom).toBe(CELL_H);
    expect(box.left).toBeGreaterThan(0);
    expect(box.top).toBeGreaterThan(0);
  });

  it('makes heavy lines thicker than light ones', () => {
    const lightH = rectsFor('─', 0)[0].height;
    const heavyH = rectsFor('━', 0)[0].height;
    expect(heavyH).toBeGreaterThan(lightH);
  });

  it('renders a double horizontal line as two separated rails', () => {
    const rects = rectsFor('═', 0);
    const centers = [...new Set(rects.map(r => r.y + r.height / 2))].sort((a, b) => a - b);
    expect(centers.length).toBe(2);
    expect(centers[1] - centers[0]).toBeGreaterThan(0);
    // Both rails still span the full cell width.
    expect(bounds(rects).left).toBe(0);
    expect(bounds(rects).right).toBe(CELL_W);
  });

  it('renders dashed lines as the right number of evenly spaced dashes', () => {
    // Triple / quadruple / double dashes, horizontal and vertical.
    expect(rectsFor('┄', 0)).toHaveLength(3);
    expect(rectsFor('┈', 0)).toHaveLength(4);
    expect(rectsFor('╌', 0)).toHaveLength(2);
    expect(rectsFor('┆', 0)).toHaveLength(3);
    // Horizontal dashes sit on the vertical center; gaps separate them.
    const dashes = rectsFor('┄', 0).sort((a, b) => a.x - b.x);
    for (let i = 1; i < dashes.length; i += 1) {
      const gap = dashes[i].x - (dashes[i - 1].x + dashes[i - 1].width);
      expect(gap).toBeGreaterThan(0); // a real gap between dashes
    }
    expect(maxPairwiseOverlap(rectsFor('┄', 0))).toBeLessThan(1e-6);
    expect(isBoxDrawingGlyph('┄')).toBe(true);
  });
});

describe('blockElementGlyph', () => {
  function blockFor(text: string, col: number, dpr = 2) {
    const block = blockElementGlyph(text, col * CELL_W, 0, CELL_W, CELL_H, dpr);
    if (!block) throw new Error(`expected block glyph for ${JSON.stringify(text)}`);
    return block;
  }

  it('returns null for non-block characters', () => {
    expect(blockElementGlyph('a', 0, 0, CELL_W, CELL_H, 2)).toBeNull();
    expect(blockElementGlyph('─', 0, 0, CELL_W, CELL_H, 2)).toBeNull();
  });

  it('fills the whole cell for the full block', () => {
    const box = bounds(blockFor('█', 0).rects);
    expect(box).toEqual({ left: 0, right: CELL_W, top: 0, bottom: CELL_H });
  });

  it('grows lower eighth bars monotonically from the bottom edge', () => {
    let previousHeight = -1;
    for (const glyph of ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']) {
      const box = bounds(blockFor(glyph, 0).rects);
      expect(box.bottom).toBe(CELL_H); // anchored to the bottom
      expect(box.right).toBe(CELL_W); // full width
      const filled = box.bottom - box.top;
      expect(filled).toBeGreaterThan(previousHeight); // each is taller
      previousHeight = filled;
    }
  });

  it('grows left eighth bars monotonically from the left edge', () => {
    let previousWidth = -1;
    for (const glyph of ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']) {
      const box = bounds(blockFor(glyph, 0).rects);
      expect(box.left).toBe(0); // anchored to the left
      expect(box.bottom).toBe(CELL_H); // full height
      const filled = box.right - box.left;
      expect(filled).toBeGreaterThan(previousWidth);
      previousWidth = filled;
    }
  });

  it('renders shades as a full-cell fill at reduced opacity', () => {
    expect(blockFor('░', 0).alpha).toBeCloseTo(0.25);
    expect(blockFor('▒', 0).alpha).toBeCloseTo(0.5);
    expect(blockFor('▓', 0).alpha).toBeCloseTo(0.75);
    expect(bounds(blockFor('▒', 0).rects)).toEqual({
      left: 0,
      right: CELL_W,
      top: 0,
      bottom: CELL_H,
    });
    expect(blockFor('█', 0).alpha).toBe(1);
  });

  it('keeps quadrant combinations disjoint (no double-blend for faint cells)', () => {
    for (const glyph of ['▖', '▗', '▘', '▝', '▙', '▚', '▛', '▜', '▞', '▟']) {
      expect(maxPairwiseOverlap(blockFor(glyph, 0).rects)).toBeLessThan(1e-6);
    }
  });

  it('tiles eighth bars seamlessly across adjacent equal cells', () => {
    for (const dpr of [1, 1.5, 2, 3]) {
      const a = blockElementGlyph('▆', 0, 0, CELL_W, CELL_H, dpr);
      const b = blockElementGlyph('▆', CELL_W, 0, CELL_W, CELL_H, dpr);
      if (!a || !b) throw new Error('expected block rects');
      const aRight = Math.max(...a.rects.map(r => r.x + r.width));
      const bLeft = Math.min(...b.rects.map(r => r.x));
      expect(Math.abs(bLeft - aRight)).toBeLessThan(1e-6); // share an exact edge
      // Same fill height in both cells.
      expect(bounds(a.rects).top).toBeCloseTo(bounds(b.rects).top);
    }
  });
});
