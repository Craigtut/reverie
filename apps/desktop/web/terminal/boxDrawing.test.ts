import { describe, expect, it } from 'vitest';

import { boxDrawingRects, isBoxDrawingGlyph } from './boxDrawing';

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

  it('draws a straight line as a single rect (no center overlap to double-blend)', () => {
    // A faint border double-blends wherever rects overlap, which shows as a bright
    // dot. Straight runs must be one rect; junctions must stay disjoint.
    expect(rectsFor('─', 0)).toHaveLength(1);
    expect(rectsFor('│', 0)).toHaveLength(1);
    for (const glyph of ['─', '│', '┼', '┌', '┐', '└', '┘', '├', '┬', '╭', '╰', '═', '║', '╬']) {
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
});
