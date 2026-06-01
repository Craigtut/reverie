import type { TerminalFrame, TerminalRow } from '../../terminalTypes';
import {
  terminalCellAtColumn,
  terminalCellEndCol,
  terminalRowTextLayout,
  terminalRowTextSlice,
} from '../cellGeometry';
import type { BufferCell, SelectionRange } from './types';

// Pure selection model: range normalization, word/line expansion, and text
// reconstruction from the cell grid. No DOM, no state. A SelectionRange holds
// INCLUSIVE start/end cells in buffer (composite-frame) coordinates; the
// interaction controller owns the live anchor/head and turns it into ranges.
//
function findRow(frame: TerminalFrame, index: number): TerminalRow | undefined {
  return frame.rows.find(row => row.index === index);
}

// A row's plain text over [0, cols), absent columns filled with a space. Wide
// cells emit their glyph once and skip their covered spacer cell.
export function rowPlainText(row: TerminalRow | undefined, cols: number): string {
  return terminalRowTextLayout(row, cols).text;
}

export function rowAt(frame: TerminalFrame, index: number): TerminalRow | undefined {
  return findRow(frame, index);
}

function isWordChar(ch: string): boolean {
  return ch.length > 0 && ch.trim().length > 0;
}

// Order two cells into a normalized range (start before end in reading order).
export function normalizeRange(a: BufferCell, b: BufferCell): SelectionRange {
  if (a.row < b.row || (a.row === b.row && a.col <= b.col)) {
    return { start: { ...a }, end: { ...b } };
  }
  return { start: { ...b }, end: { ...a } };
}

// Expand range endpoints to whole rendered cells. This keeps visual selection
// aligned with copy/search behavior when a pointer lands on the covered tail
// column of a wide glyph.
export function expandRangeToCellBounds(
  frame: TerminalFrame,
  range: SelectionRange,
  cols: number,
): SelectionRange {
  if (cols <= 0) return normalizeRange(range.start, range.end);
  const normalized = normalizeRange(range.start, range.end);
  const maxCol = Math.max(0, Math.floor(cols) - 1);

  const start = expandStart(frame, normalized.start, maxCol, cols);
  const end = expandEnd(frame, normalized.end, maxCol, cols);
  return normalizeRange(start, end);
}

function expandStart(
  frame: TerminalFrame,
  cell: BufferCell,
  maxCol: number,
  cols: number,
): BufferCell {
  const col = clampCol(cell.col, maxCol);
  const renderedCell = terminalCellAtColumn(findRow(frame, cell.row), col, cols);
  return { row: cell.row, col: renderedCell ? clampCol(renderedCell.col, maxCol) : col };
}

function expandEnd(
  frame: TerminalFrame,
  cell: BufferCell,
  maxCol: number,
  cols: number,
): BufferCell {
  const col = clampCol(cell.col, maxCol);
  const renderedCell = terminalCellAtColumn(findRow(frame, cell.row), col, cols);
  return {
    row: cell.row,
    col: renderedCell ? clampCol(terminalCellEndCol(renderedCell, cols) - 1, maxCol) : col,
  };
}

function clampCol(col: number, maxCol: number) {
  return Math.max(0, Math.min(maxCol, Math.floor(Number.isFinite(col) ? col : 0)));
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
    const from = r === range.start.row ? range.start.col : 0;
    const toInclusive = r === range.end.row ? range.end.col : cols - 1;
    lines.push(terminalRowTextSlice(findRow(frame, r), from, toInclusive, cols, true));
  }
  return lines.join('\n');
}

// Expand a cell to the surrounding run of non-whitespace characters (the unit a
// double-click selects). A whitespace cell selects just itself.
export function wordRangeAt(frame: TerminalFrame, cell: BufferCell, cols: number): SelectionRange {
  const row = findRow(frame, cell.row);
  const charAt = (col: number) => terminalCellAtColumn(row, col, cols)?.text ?? ' ';
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
      if (c.text.trim().length > 0) lastCol = Math.max(lastCol, terminalCellEndCol(c) - 1);
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
