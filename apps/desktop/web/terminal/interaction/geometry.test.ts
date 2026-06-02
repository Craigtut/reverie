import { describe, it, expect } from 'vitest';
import { clamp, pointToCell, cellRectInWindow } from './geometry';
import type { TerminalSurface } from '../../terminalScrollback';

const surface: TerminalSurface = {
  cols: 20,
  rows: 10,
  cellWidth: 9,
  cellHeight: 18,
  fontSize: 14,
  baseline: 14,
  fontFamily: 'monospace',
};

describe('clamp', () => {
  it('bounds a value to the range', () => {
    expect(clamp(-1, 0, 5)).toBe(0);
    expect(clamp(9, 0, 5)).toBe(5);
    expect(clamp(3, 0, 5)).toBe(3);
  });
});

describe('pointToCell', () => {
  it('maps a window-local point to a buffer cell using startRow', () => {
    // x 20 -> col floor(20/9)=2; y 40 -> windowRow floor(40/18)=2; startRow 7 -> buffer row 9.
    expect(pointToCell(20, 40, surface, 7, 100)).toEqual({ row: 9, col: 2 });
  });

  it('clamps a point past the grid to the nearest edge cell', () => {
    expect(pointToCell(10_000, 10_000, surface, 0, 30)).toEqual({ row: 29, col: 19 });
    // A point above the canvas resolves to rows above startRow (floor(-50/18) = -3),
    // so a drag leaving the top still extends selection upward: 5 + (-3) = 2.
    expect(pointToCell(-50, -50, surface, 5, 30)).toEqual({ row: 2, col: 0 });
  });

  it('returns null when there is nothing to hit', () => {
    expect(pointToCell(0, 0, surface, 0, 0)).toBeNull();
    expect(pointToCell(0, 0, { ...surface, cols: 0 }, 0, 10)).toBeNull();
  });
});

describe('cellRectInWindow', () => {
  it('returns the window-local rect for a visible cell', () => {
    expect(cellRectInWindow({ row: 9, col: 2 }, 7, 10, surface)).toEqual({
      x: 18,
      y: 36,
      width: 9,
      height: 18,
    });
  });

  it('returns null for a cell outside the painted window', () => {
    expect(cellRectInWindow({ row: 2, col: 0 }, 7, 10, surface)).toBeNull();
    expect(cellRectInWindow({ row: 99, col: 0 }, 7, 10, surface)).toBeNull();
  });
});
