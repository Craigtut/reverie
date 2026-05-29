import type { TerminalFrame, TerminalRow } from '../../terminalTypes';
import type { BufferCell, SelectionRange } from './types';

// Pure selection model: range normalization, word/line expansion, and text
// reconstruction from the cell grid. No DOM, no state. A SelectionRange holds
// INCLUSIVE start/end cells in buffer (composite-frame) coordinates; the
// interaction controller owns the live anchor/head and turns it into ranges.
//
// Cells are sparse and carry no width metadata, so we index a row by column into
// a map and fill absent columns with a space. Wide/CJK glyphs occupy their left
// column only; we accept a possible trailing space after such a glyph rather
// than guess widths we do not have.

function rowByColumn(row: TerminalRow | undefined): Map<number, string> {
  const byCol = new Map<number, string>();
  if (!row) return byCol;
  for (const cell of row.cells) byCol.set(cell.col, cell.text);
  return byCol;
}

function findRow(frame: TerminalFrame, index: number): TerminalRow | undefined {
  return frame.rows.find(row => row.index === index);
}

// A row's plain text over [0, cols), absent columns filled with a space. Used
// for link detection (which scans a row's text). Trailing blanks are harmless to
// the URL regex, so the row is not trimmed here.
export function rowPlainText(row: TerminalRow | undefined, cols: number): string {
  const byCol = rowByColumn(row);
  let out = '';
  for (let col = 0; col < cols; col += 1) out += byCol.get(col) ?? ' ';
  return out;
}

export function rowAt(frame: TerminalFrame, index: number): TerminalRow | undefined {
  return findRow(frame, index);
}

function isWordChar(ch: string): boolean {
  return ch.length > 0 && ch.trim().length > 0;
}

function rtrim(value: string): string {
  return value.replace(/\s+$/u, '');
}

// Order two cells into a normalized range (start before end in reading order).
export function normalizeRange(a: BufferCell, b: BufferCell): SelectionRange {
  if (a.row < b.row || (a.row === b.row && a.col <= b.col)) {
    return { start: { ...a }, end: { ...b } };
  }
  return { start: { ...b }, end: { ...a } };
}

export function rangesEqual(a: SelectionRange | null, b: SelectionRange | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.start.row === b.start.row &&
    a.start.col === b.start.col &&
    a.end.row === b.end.row &&
    a.end.col === b.end.col
  );
}

// Reconstruct the selected text. Each line is right-trimmed; lines are joined
// with newlines. The end column is inclusive.
export function selectionText(frame: TerminalFrame, range: SelectionRange, cols: number): string {
  const lines: string[] = [];
  for (let r = range.start.row; r <= range.end.row; r += 1) {
    const byCol = rowByColumn(findRow(frame, r));
    const from = r === range.start.row ? range.start.col : 0;
    const toInclusive = r === range.end.row ? range.end.col : cols - 1;
    let line = '';
    for (let c = from; c <= toInclusive; c += 1) {
      line += byCol.get(c) ?? ' ';
    }
    lines.push(rtrim(line));
  }
  return lines.join('\n');
}

// Expand a cell to the surrounding run of non-whitespace characters (the unit a
// double-click selects). A whitespace cell selects just itself.
export function wordRangeAt(frame: TerminalFrame, cell: BufferCell, cols: number): SelectionRange {
  const byCol = rowByColumn(findRow(frame, cell.row));
  const charAt = (col: number) => byCol.get(col) ?? ' ';
  if (!isWordChar(charAt(cell.col))) {
    return { start: { ...cell }, end: { ...cell } };
  }
  let start = cell.col;
  while (start > 0 && isWordChar(charAt(start - 1))) start -= 1;
  let end = cell.col;
  while (end < cols - 1 && isWordChar(charAt(end + 1))) end += 1;
  return { start: { row: cell.row, col: start }, end: { row: cell.row, col: end } };
}

// Expand a cell to its whole line, ending at the last non-blank column (the unit
// a triple-click selects).
export function lineRangeAt(frame: TerminalFrame, cell: BufferCell): SelectionRange {
  const row = findRow(frame, cell.row);
  let lastCol = 0;
  if (row) {
    for (const c of row.cells) {
      if (c.text.trim().length > 0) lastCol = Math.max(lastCol, c.col);
    }
  }
  return { start: { row: cell.row, col: 0 }, end: { row: cell.row, col: lastCol } };
}

// Select the whole composite frame, ending at the last row that has content.
export function selectAllRange(frame: TerminalFrame, cols: number): SelectionRange | null {
  if (frame.rows.length === 0 || cols <= 0) return null;
  let lastRow = 0;
  for (const row of frame.rows) {
    if (row.cells.some(cell => cell.text.trim().length > 0)) lastRow = Math.max(lastRow, row.index);
  }
  return { start: { row: 0, col: 0 }, end: { row: lastRow, col: cols - 1 } };
}

// Whether a buffer cell falls inside a selection range (inclusive).
export function isCellInRange(range: SelectionRange, cell: BufferCell): boolean {
  if (cell.row < range.start.row || cell.row > range.end.row) return false;
  if (cell.row === range.start.row && cell.col < range.start.col) return false;
  if (cell.row === range.end.row && cell.col > range.end.col) return false;
  return true;
}
