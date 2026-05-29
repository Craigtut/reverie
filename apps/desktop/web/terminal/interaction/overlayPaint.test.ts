import { describe, it, expect } from 'vitest';
import { selectionWindowSpans, rowSpanInWindow } from './overlayPaint';

const COLS = 20;

describe('selectionWindowSpans', () => {
  it('emits one full-width-aware span per row, end exclusive', () => {
    // rows 2..4, startRow 0, displayRows 10. First row from col 5, last row to col 3.
    const spans = selectionWindowSpans(
      { start: { row: 2, col: 5 }, end: { row: 4, col: 3 } },
      0,
      10,
      COLS,
    );
    expect(spans).toEqual([
      { row: 2, startCol: 5, endCol: COLS }, // first row: from start col to row end
      { row: 3, startCol: 0, endCol: COLS }, // middle row: full width
      { row: 4, startCol: 0, endCol: 4 }, // last row: through end col inclusive -> exclusive 4
    ]);
  });

  it('translates buffer rows to window-local rows and clips outside the window', () => {
    // selection rows 7..9, painted window startRow 7 displayRows 2 -> only rows 7,8 visible.
    const spans = selectionWindowSpans(
      { start: { row: 7, col: 0 }, end: { row: 9, col: 2 } },
      7,
      2,
      COLS,
    );
    expect(spans).toEqual([
      { row: 0, startCol: 0, endCol: COLS },
      { row: 1, startCol: 0, endCol: COLS },
    ]);
  });

  it('returns nothing for a null range', () => {
    expect(selectionWindowSpans(null, 0, 10, COLS)).toEqual([]);
  });
});

describe('rowSpanInWindow', () => {
  it('translates a one-row span into the window', () => {
    expect(rowSpanInWindow(9, 3, 8, 7, 10, COLS)).toEqual({ row: 2, startCol: 3, endCol: 8 });
  });

  it('returns null when the row is outside the window or the span is empty', () => {
    expect(rowSpanInWindow(2, 0, 5, 7, 10, COLS)).toBeNull();
    expect(rowSpanInWindow(7, 5, 5, 7, 10, COLS)).toBeNull();
  });
});
