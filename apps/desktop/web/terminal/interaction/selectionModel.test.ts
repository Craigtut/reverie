import { describe, it, expect } from 'vitest';
import {
  normalizeRange,
  rangesEqual,
  selectionText,
  wordRangeAt,
  lineRangeAt,
  selectAllRange,
  isCellInRange,
} from './selectionModel';
import type { TerminalCell, TerminalFrame, TerminalRow } from '../../terminalTypes';

function cell(col: number, text: string): TerminalCell {
  return { col, text };
}

function row(index: number, cells: TerminalCell[]): TerminalRow {
  return { index, dirty: true, cells };
}

// "hello world" on row 0, a sparse row with a gap on row 1, blank row 2.
function frame(): TerminalFrame {
  const hello = 'hello world'.split('').map((ch, i) => cell(i, ch));
  return {
    dirty: 'full',
    rows: [
      row(0, hello),
      // cols 0-2 = "abc", gap at 3-4, cols 5-7 = "xyz" (sparse)
      row(1, [cell(0, 'a'), cell(1, 'b'), cell(2, 'c'), cell(5, 'x'), cell(6, 'y'), cell(7, 'z')]),
      row(2, []),
    ],
  };
}

const COLS = 20;

describe('normalizeRange', () => {
  it('orders cells into reading order', () => {
    expect(normalizeRange({ row: 2, col: 3 }, { row: 1, col: 9 })).toEqual({
      start: { row: 1, col: 9 },
      end: { row: 2, col: 3 },
    });
    expect(normalizeRange({ row: 1, col: 9 }, { row: 1, col: 2 })).toEqual({
      start: { row: 1, col: 2 },
      end: { row: 1, col: 9 },
    });
  });
});

describe('rangesEqual', () => {
  it('compares by value and handles null', () => {
    expect(rangesEqual(null, null)).toBe(true);
    expect(
      rangesEqual(
        { start: { row: 0, col: 0 }, end: { row: 0, col: 1 } },
        { start: { row: 0, col: 0 }, end: { row: 0, col: 1 } },
      ),
    ).toBe(true);
    expect(rangesEqual({ start: { row: 0, col: 0 }, end: { row: 0, col: 1 } }, null)).toBe(false);
  });
});

describe('selectionText', () => {
  it('reconstructs a single-row slice (end inclusive)', () => {
    // cols 0-4 of "hello world" => "hello"
    expect(
      selectionText(frame(), { start: { row: 0, col: 0 }, end: { row: 0, col: 4 } }, COLS),
    ).toBe('hello');
  });

  it('fills sparse gaps with spaces', () => {
    // row 1 cols 0-7 => "abc  xyz" (two spaces for the gap at 3-4)
    expect(
      selectionText(frame(), { start: { row: 1, col: 0 }, end: { row: 1, col: 7 } }, COLS),
    ).toBe('abc  xyz');
  });

  it('right-trims each line and joins multi-row selections with newlines', () => {
    const text = selectionText(
      frame(),
      { start: { row: 0, col: 6 }, end: { row: 2, col: 0 } },
      COLS,
    );
    // row 0 from col 6 = "world" (trailing blanks trimmed), row 1 full = "abc  xyz", row 2 blank = ""
    expect(text).toBe('world\nabc  xyz\n');
  });
});

describe('wordRangeAt', () => {
  it('expands to the surrounding non-whitespace run', () => {
    // click inside "world" (col 8) -> cols 6..10
    expect(wordRangeAt(frame(), { row: 0, col: 8 }, COLS)).toEqual({
      start: { row: 0, col: 6 },
      end: { row: 0, col: 10 },
    });
  });

  it('selects only the cell when on whitespace', () => {
    expect(wordRangeAt(frame(), { row: 0, col: 5 }, COLS)).toEqual({
      start: { row: 0, col: 5 },
      end: { row: 0, col: 5 },
    });
  });
});

describe('lineRangeAt', () => {
  it('spans from col 0 to the last non-blank column', () => {
    expect(lineRangeAt(frame(), { row: 1, col: 0 })).toEqual({
      start: { row: 1, col: 0 },
      end: { row: 1, col: 7 },
    });
  });
});

describe('selectAllRange', () => {
  it('covers from the top to the last content row', () => {
    expect(selectAllRange(frame(), COLS)).toEqual({
      start: { row: 0, col: 0 },
      end: { row: 1, col: COLS - 1 },
    });
  });
});

describe('isCellInRange', () => {
  const range = { start: { row: 1, col: 2 }, end: { row: 3, col: 4 } };
  it('respects partial first/last rows', () => {
    expect(isCellInRange(range, { row: 1, col: 1 })).toBe(false);
    expect(isCellInRange(range, { row: 1, col: 2 })).toBe(true);
    expect(isCellInRange(range, { row: 2, col: 0 })).toBe(true);
    expect(isCellInRange(range, { row: 3, col: 4 })).toBe(true);
    expect(isCellInRange(range, { row: 3, col: 5 })).toBe(false);
  });
});
