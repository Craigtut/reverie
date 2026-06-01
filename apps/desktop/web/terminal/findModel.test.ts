import { describe, it, expect } from 'vitest';
import {
  findMatchesInLine,
  findMatchesInFrame,
  formatMatchCount,
  cycleIndex,
  resolvedActiveMatchIndex,
} from './findModel';
import type { TerminalCell, TerminalFrame, TerminalRow } from '../terminalTypes';

function row(index: number, text: string): TerminalRow {
  const cells: TerminalCell[] = text.split('').map((ch, col) => ({ col, text: ch }));
  return { index, dirty: true, cells };
}

describe('findMatchesInLine', () => {
  it('finds non-overlapping matches, half-open columns', () => {
    expect(findMatchesInLine('abcabc', 'abc', true)).toEqual([
      { startCol: 0, endCol: 3 },
      { startCol: 3, endCol: 6 },
    ]);
  });

  it('does not overlap', () => {
    // "aa" in "aaa" matches once (0..2), not 0..2 and 1..3.
    expect(findMatchesInLine('aaa', 'aa', true)).toEqual([{ startCol: 0, endCol: 2 }]);
  });

  it('honors the case toggle', () => {
    expect(findMatchesInLine('Hello hello', 'hello', true)).toEqual([{ startCol: 6, endCol: 11 }]);
    expect(findMatchesInLine('Hello hello', 'hello', false)).toEqual([
      { startCol: 0, endCol: 5 },
      { startCol: 6, endCol: 11 },
    ]);
  });

  it('returns nothing for an empty query', () => {
    expect(findMatchesInLine('anything', '', false)).toEqual([]);
  });
});

describe('findMatchesInFrame', () => {
  const frame: TerminalFrame = {
    dirty: 'full',
    rows: [row(0, 'find me here'), row(1, 'nothing'), row(2, 'me and me')],
  };

  it('collects matches across rows in reading order with line text', () => {
    expect(findMatchesInFrame(frame, 'me', false, 20)).toEqual([
      { row: 0, startCol: 5, endCol: 7, lineText: 'find me here' },
      { row: 2, startCol: 0, endCol: 2, lineText: 'me and me' },
      { row: 2, startCol: 7, endCol: 9, lineText: 'me and me' },
    ]);
  });

  it('empty query yields nothing', () => {
    expect(findMatchesInFrame(frame, '', false, 20)).toEqual([]);
  });

  it("reports each match's absolute row index, not its array position", () => {
    // Full-history find searches a composite whose rows are absolute (a window
    // deep in the session starts well above 0), and navigation scrolls to that
    // absolute row, so the match must carry row.index, not the loop position.
    const deep: TerminalFrame = {
      dirty: 'full',
      rows: [row(900, 'no match'), row(901, 'find me'), row(902, 'me too')],
    };
    expect(findMatchesInFrame(deep, 'me', false, 20)).toEqual([
      { row: 901, startCol: 5, endCol: 7, lineText: 'find me' },
      { row: 902, startCol: 0, endCol: 2, lineText: 'me too' },
    ]);
  });

  it('maps matches after wide cells back to cell columns', () => {
    const wide: TerminalFrame = {
      dirty: 'full',
      rows: [
        {
          index: 0,
          dirty: true,
          cells: [
            { col: 0, text: 'A' },
            { col: 1, width: 2, text: '界' },
            { col: 3, text: 'B' },
          ],
        },
      ],
    };

    expect(findMatchesInFrame(wide, 'B', false, 20)).toEqual([
      { row: 0, startCol: 3, endCol: 4, lineText: 'A界B' },
    ]);
    expect(findMatchesInFrame(wide, '界B', false, 20)).toEqual([
      { row: 0, startCol: 1, endCol: 4, lineText: 'A界B' },
    ]);
  });
});

describe('formatMatchCount', () => {
  it('formats normal, capped, and empty', () => {
    expect(formatMatchCount(3, 12, false)).toBe('3 / 12');
    expect(formatMatchCount(3, 2000, true)).toBe('3 / 2000+');
    expect(formatMatchCount(0, 0, false)).toBe('0 / 0');
  });
});

describe('cycleIndex', () => {
  it('wraps forward and backward, -1 when empty', () => {
    expect(cycleIndex(0, 3, 1)).toBe(1);
    expect(cycleIndex(2, 3, 1)).toBe(0);
    expect(cycleIndex(0, 3, -1)).toBe(2);
    expect(cycleIndex(0, 0, 1)).toBe(-1);
  });
});

describe('resolvedActiveMatchIndex', () => {
  const matches = [
    { row: 5, startCol: 6, endCol: 12, lineText: 'lower needle first' },
    { row: 42, startCol: 6, endCol: 12, lineText: 'mixed Needle second' },
    { row: 60, startCol: 6, endCol: 12, lineText: 'lower needle third' },
  ];

  it('preserves the active match when a same-query replay resolves later', () => {
    expect(resolvedActiveMatchIndex(matches, matches[1])).toBe(1);
  });

  it('falls back to the first match when the previous active match is absent', () => {
    expect(
      resolvedActiveMatchIndex(matches, {
        row: 99,
        startCol: 0,
        endCol: 6,
        lineText: 'needle elsewhere',
      }),
    ).toBe(0);
  });

  it('returns -1 for an empty result set', () => {
    expect(resolvedActiveMatchIndex([], matches[0])).toBe(-1);
  });
});
