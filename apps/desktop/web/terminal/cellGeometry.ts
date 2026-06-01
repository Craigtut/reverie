import type { TerminalCell, TerminalRow } from '../terminalTypes';

export function terminalCellWidth(cell: Pick<TerminalCell, 'col' | 'width'>, cols?: number) {
  const requested =
    typeof cell.width === 'number' && Number.isFinite(cell.width) && cell.width > 0
      ? Math.floor(cell.width)
      : 1;
  if (cols === undefined || !Number.isFinite(cols)) return requested;
  const remaining = Math.max(1, Math.floor(cols) - Math.max(0, Math.floor(cell.col)));
  return Math.max(1, Math.min(requested, remaining));
}

export function terminalCellEndCol(cell: Pick<TerminalCell, 'col' | 'width'>, cols?: number) {
  return Math.max(0, Math.floor(cell.col)) + terminalCellWidth(cell, cols);
}

export interface TerminalRowTextLayout {
  text: string;
  boundaries: number[];
}

export function terminalRowTextLayout(
  row: TerminalRow | undefined,
  cols: number,
): TerminalRowTextLayout {
  const maxCols = positiveCols(cols);
  let text = '';
  const boundaries = [0];
  let col = 0;

  for (const cell of sortedCells(row)) {
    const start = Math.max(0, Math.floor(cell.col));
    const end = terminalCellEndCol(cell, maxCols);
    if (start >= maxCols || end <= col) continue;
    while (col < start) {
      appendSegment(' ', col, col + 1);
      col += 1;
    }
    appendSegment(cell.text, start, end);
    col = end;
  }

  while (col < maxCols) {
    appendSegment(' ', col, col + 1);
    col += 1;
  }

  return { text, boundaries };

  function appendSegment(segment: string, startCol: number, endCol: number) {
    if (segment.length === 0) return;
    const startIndex = text.length;
    text += segment;
    for (let offset = 1; offset <= segment.length; offset += 1) {
      boundaries[startIndex + offset] = offset === segment.length ? endCol : startCol;
    }
  }
}

export function terminalTextRangeToCellSpan(
  layout: TerminalRowTextLayout,
  startIndex: number,
  endIndex: number,
) {
  const maxBoundary = Math.max(0, layout.boundaries.length - 1);
  const start = clampInteger(startIndex, 0, maxBoundary);
  const end = clampInteger(endIndex, start, maxBoundary);
  return {
    startCol: layout.boundaries[start] ?? 0,
    endCol: layout.boundaries[end] ?? layout.boundaries.at(-1) ?? 0,
  };
}

export function terminalRowTextSlice(
  row: TerminalRow | undefined,
  fromCol: number,
  toInclusive: number,
  cols: number,
  trimRight = false,
) {
  const maxCols = positiveCols(cols);
  let col = clampInteger(fromCol, 0, Math.max(0, maxCols - 1));
  const limit = clampInteger(toInclusive, col, Math.max(0, maxCols - 1));
  let out = '';

  for (const cell of sortedCells(row)) {
    const start = Math.max(0, Math.floor(cell.col));
    const end = terminalCellEndCol(cell, maxCols);
    if (end <= col) continue;
    if (start > limit) break;

    while (col < Math.min(start, limit + 1)) {
      out += ' ';
      col += 1;
    }
    if (end <= col || start > limit) continue;
    out += cell.text;
    col = Math.max(col, end);
  }

  while (col <= limit) {
    out += ' ';
    col += 1;
  }

  return trimRight ? out.replace(/\s+$/u, '') : out;
}

export function terminalCellAtColumn(
  row: TerminalRow | undefined,
  col: number,
  cols: number,
): TerminalCell | undefined {
  const target = Math.floor(col);
  for (const cell of sortedCells(row)) {
    const start = Math.max(0, Math.floor(cell.col));
    const end = terminalCellEndCol(cell, cols);
    if (target >= start && target < end) return cell;
  }
  return undefined;
}

function sortedCells(row: TerminalRow | undefined) {
  return (row?.cells ?? []).slice().sort((left, right) => left.col - right.col);
}

function positiveCols(cols: number) {
  return Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 1;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(Number.isFinite(value) ? value : min)));
}
