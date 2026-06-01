import { cloneTerminalRow } from '../terminalScrollback';
import type {
  TerminalCursor,
  TerminalFrame,
  TerminalModes,
  TerminalRow,
  TerminalScrollback,
} from '../terminalTypes';
import {
  terminalCellAtColumn,
  terminalCellEndCol,
  terminalCellWidth,
  terminalRowTextLayout,
  terminalRowTextSlice,
  terminalTextRangeToCellSpan,
} from './cellGeometry';

export const DEFAULT_TERMINAL_BUFFER_ROW_LIMIT = 100_000;

export interface TerminalBufferState {
  cols: number;
  viewportRows: number;
  viewportOffset: number;
  totalRows: number;
  atBottom: boolean;
  rowLimit: number;
  generation: number;
  rowsById: ReadonlyMap<number, TerminalRow>;
  cachedRanges: readonly TerminalBufferRowRange[];
  cursor?: TerminalCursor;
  modes?: TerminalModes;
  colors?: TerminalFrame['colors'];
}

export interface TerminalBufferRowRange {
  start: number;
  end: number;
}

export interface TerminalBufferRange {
  start: { row: number; col: number };
  end: { row: number; col: number };
}

export function createTerminalBuffer(
  surface: { cols: number; rows: number },
  options: { rowLimit?: number } = {},
): TerminalBufferState {
  return {
    cols: surface.cols,
    viewportRows: surface.rows,
    viewportOffset: 0,
    totalRows: surface.rows,
    atBottom: true,
    rowLimit: options.rowLimit ?? DEFAULT_TERMINAL_BUFFER_ROW_LIMIT,
    generation: 0,
    rowsById: new Map(),
    cachedRanges: [],
  };
}

export function applyViewportFrameToBuffer(
  previous: TerminalBufferState,
  frame: TerminalFrame,
  surface: { cols: number; rows: number },
  options: {
    preserveBlankRows?: boolean;
    preserveShapeRows?: boolean;
    anchorPreservedRowsToViewport?: boolean;
  } = {},
): TerminalBufferState {
  const scrollback = frame.scrollback ?? {};
  const explicitTotalRows = finiteNumber(scrollback.totalRows);
  const hasScrollbackMetadata = frame.scrollback !== undefined;
  const viewportOffset = finiteNumber(scrollback.viewportOffset) ?? 0;
  const viewportRows = finiteNumber(scrollback.viewportRows) ?? surface.rows;
  const fallbackTotalRows =
    hasScrollbackMetadata || frame.dirty === 'partial'
      ? Math.max(previous.totalRows, viewportOffset + viewportRows, surface.rows)
      : Math.max(viewportOffset + viewportRows, surface.rows);
  const totalRows = explicitTotalRows ?? fallbackTotalRows;
  const resetForShapeChange = previous.cols !== surface.cols;
  const preserveRowsForShapeChange =
    resetForShapeChange &&
    (options.preserveBlankRows === true || options.preserveShapeRows === true);
  const resetForTimelineReset =
    (!preserveRowsForShapeChange &&
      explicitTotalRows !== undefined &&
      explicitTotalRows < previous.totalRows) ||
    (!hasScrollbackMetadata && frame.dirty !== 'partial' && totalRows < previous.totalRows);
  const normalizedRows = normalizeViewportRows(frame, surface);
  const skipResizeBlankRows =
    !resetForTimelineReset && options.preserveBlankRows === true && previous.rowsById.size > 0;
  const preserveRowsThroughBlankFrame =
    !resetForTimelineReset &&
    (resetForShapeChange || options.preserveBlankRows === true) &&
    previous.rowsById.size > 0 &&
    normalizedRows.length > 0 &&
    normalizedRows.every(rowIsBlank);
  const preserveRowsDuringResizeReflow = !resetForTimelineReset && preserveRowsForShapeChange;
  const preserveRowsAsFallbackOnly =
    preserveRowsDuringResizeReflow &&
    options.preserveShapeRows === true &&
    options.anchorPreservedRowsToViewport !== true;
  const cacheOnlyRowsWithCells =
    hasScrollbackMetadata && totalRows > viewportRows && !preserveRowsDuringResizeReflow;
  const resetCache =
    (resetForShapeChange && !preserveRowsThroughBlankFrame && !preserveRowsDuringResizeReflow) ||
    resetForTimelineReset;
  let rowsById = new Map(resetCache ? [] : previous.rowsById);
  let cachedRanges = resetCache || preserveRowsAsFallbackOnly ? [] : [...previous.cachedRanges];
  if (
    preserveRowsDuringResizeReflow &&
    options.anchorPreservedRowsToViewport === true &&
    previous.viewportOffset !== viewportOffset
  ) {
    rowsById = anchorPreviousViewportRows(previous, surface, viewportOffset);
    cachedRanges = addCachedRange([], viewportOffset, viewportOffset + previous.viewportRows);
  }
  const cachedRowIds: number[] = [];
  let removedResizeBlankRows = false;

  for (const row of normalizedRows) {
    const rowId = viewportOffset + row.index;
    if (preserveRowsThroughBlankFrame && rowIsBlank(row)) continue;
    if (skipResizeBlankRows && rowIsBlank(row)) {
      if (!resetForShapeChange && rowsById.delete(rowId)) removedResizeBlankRows = true;
      continue;
    }
    const existing = rowsById.get(rowId);
    if (shouldStoreRow(frame, row, existing)) {
      rowsById.set(rowId, rowWithId(row, rowId));
      if (!cacheOnlyRowsWithCells || rowHasCells(row)) cachedRowIds.push(rowId);
    }
  }

  cachedRanges = addCachedRows(cachedRanges, cachedRowIds);
  if (removedResizeBlankRows && !preserveRowsAsFallbackOnly) {
    cachedRanges = rangesFromRowIds(rowsById.keys());
  }
  if (pruneRows(rowsById, previous.rowLimit, viewportOffset, viewportOffset + viewportRows)) {
    if (cacheOnlyRowsWithCells) {
      cachedRanges = rangesFromCachedRowsWithCells(rowsById, cachedRanges);
    } else if (!preserveRowsAsFallbackOnly) {
      cachedRanges = rangesFromRowIds(rowsById.keys());
    }
  }
  if (cacheOnlyRowsWithCells) {
    cachedRanges = rangesFromCachedRowsWithCells(rowsById, cachedRanges);
  }

  return {
    cols: surface.cols,
    viewportRows,
    viewportOffset,
    totalRows,
    atBottom: scrollback.atBottom ?? viewportOffset + viewportRows >= totalRows,
    rowLimit: previous.rowLimit,
    generation: previous.generation + 1,
    rowsById,
    cachedRanges,
    cursor: cursorWithAbsoluteRow(frame.cursor, viewportOffset),
    modes: frame.modes,
    colors: frame.colors,
  };
}

export function mergeHistoryWindowIntoBuffer(
  previous: TerminalBufferState,
  frame: TerminalFrame,
  surface: { cols: number; rows: number },
  startRow: number,
  totalRows = Math.max(surface.rows, startRow + frame.rows.length),
  replace = false,
): TerminalBufferState {
  const nextTotalRows = Math.max(surface.rows, totalRows);
  const resetForShapeChange = previous.cols !== surface.cols;
  const resetForTimelineReset = nextTotalRows < previous.totalRows;
  const preservePrevious = !replace && !resetForShapeChange && !resetForTimelineReset;
  const rowsById = new Map<number, TerminalRow>();
  let cachedRanges: TerminalBufferRowRange[] = [];
  if (preservePrevious) {
    for (const [rowId, row] of previous.rowsById) rowsById.set(rowId, row);
    cachedRanges = [...previous.cachedRanges];
  }

  for (const row of frame.rows) {
    const rowId = startRow + row.index;
    rowsById.set(rowId, rowWithId(filterRowToCols(row, surface.cols), rowId));
  }
  cachedRanges = addCachedRange(cachedRanges, startRow, startRow + frame.rows.length);

  const viewportRows = surface.rows;
  const viewportOffset = Math.max(0, nextTotalRows - viewportRows);
  if (pruneRows(rowsById, previous.rowLimit, viewportOffset, viewportOffset + viewportRows)) {
    cachedRanges = rangesFromRowIds(rowsById.keys());
  }

  return {
    cols: surface.cols,
    viewportRows,
    viewportOffset,
    totalRows: nextTotalRows,
    atBottom: frame.scrollback?.atBottom ?? false,
    rowLimit: previous.rowLimit,
    generation: previous.generation + 1,
    rowsById,
    cachedRanges,
    cursor: cursorWithAbsoluteRow(frame.cursor, startRow),
    modes: frame.modes,
    colors: frame.colors,
  };
}

export function frameFromBufferWindow(
  state: TerminalBufferState,
  startRow: number,
  rowCount: number,
): TerminalFrame {
  const clampedStart = Math.max(0, Math.min(startRow, Math.max(0, state.totalRows - 1)));
  const count = Math.max(1, rowCount);
  const rows: TerminalRow[] = [];

  for (let index = 0; index < count; index += 1) {
    const rowId = clampedStart + index;
    const cached = state.rowsById.get(rowId);
    rows.push(
      cached
        ? { ...cloneTerminalRow(cached), index, dirty: true }
        : { index, dirty: true, cells: [] },
    );
  }

  const cursor = cursorForWindow(state.cursor, clampedStart, count);

  return {
    dirty: 'full',
    cols: state.cols,
    colors: state.colors,
    modes: state.modes,
    scrollback: scrollbackForState(state),
    cursor,
    rows,
  };
}

export function frameFromBufferSnapshot(state: TerminalBufferState): TerminalFrame {
  const rows = [...state.rowsById.entries()]
    .sort(([left], [right]) => left - right)
    .map(([rowId, row]) => ({ ...cloneTerminalRow(row), index: rowId, dirty: true }));

  return {
    dirty: 'full',
    cols: state.cols,
    colors: state.colors,
    modes: state.modes,
    scrollback: scrollbackForState(state),
    cursor: state.cursor,
    rows,
  };
}

export function frameFromBufferAbsoluteWindow(
  state: TerminalBufferState,
  startRow: number,
  rowCount: number,
): TerminalFrame {
  const maxStart = Math.max(0, state.totalRows - 1);
  const clampedStart = Math.max(0, Math.min(Math.floor(startRow), maxStart));
  const remainingRows = Math.max(1, state.totalRows - clampedStart);
  const count = Math.max(1, Math.min(Math.floor(rowCount), remainingRows));
  const rows: TerminalRow[] = [];

  for (let index = 0; index < count; index += 1) {
    const rowId = clampedStart + index;
    const cached = state.rowsById.get(rowId);
    rows.push(
      cached ? { ...cloneTerminalRow(cached), index: rowId, dirty: true } : blankRow(rowId),
    );
  }

  return {
    dirty: 'full',
    cols: state.cols,
    colors: state.colors,
    modes: state.modes,
    scrollback: scrollbackForState(state),
    cursor: state.cursor,
    rows,
  };
}

export function terminalBufferHasRows(
  state: TerminalBufferState,
  startRow: number,
  rowCount: number,
): boolean {
  return terminalBufferCachedRangeForRows(state, startRow, rowCount) !== null;
}

export function terminalBufferCachedRangeForRows(
  state: TerminalBufferState,
  startRow: number,
  rowCount: number,
): TerminalBufferRowRange | null {
  const start = Math.max(0, startRow);
  const requestedEnd = start + Math.max(0, rowCount);
  if (requestedEnd > state.totalRows) return null;
  const end = Math.min(state.totalRows, requestedEnd);
  if (end <= start) return { start, end };

  for (const range of rowRanges(state)) {
    if (range.end <= start) continue;
    if (range.start > start) return null;
    if (range.end >= end) return range;
  }
  return null;
}

export function terminalBufferFullyCached(state: TerminalBufferState): boolean {
  return terminalBufferHasRows(state, 0, state.totalRows);
}

export function terminalBufferRowText(
  state: TerminalBufferState,
  rowId: number,
  trimRight = false,
): string {
  const row = state.rowsById.get(rowId);
  const text = terminalRowTextLayout(row, state.cols).text;
  return trimRight ? text.replace(/\s+$/u, '') : text;
}

export function terminalBufferSelectionText(
  state: TerminalBufferState,
  range: TerminalBufferRange,
  cols = state.cols,
): string {
  const lines: string[] = [];
  for (let rowId = range.start.row; rowId <= range.end.row; rowId += 1) {
    const from = rowId === range.start.row ? range.start.col : 0;
    const toInclusive = rowId === range.end.row ? range.end.col : cols - 1;
    lines.push(terminalRowTextSlice(state.rowsById.get(rowId), from, toInclusive, cols, true));
  }
  return lines.join('\n');
}

export function expandTerminalBufferRangeToCellBounds(
  state: TerminalBufferState,
  range: TerminalBufferRange,
  cols = state.cols,
): TerminalBufferRange {
  if (cols <= 0) return normalizeBufferRange(range.start, range.end);
  const normalized = normalizeBufferRange(range.start, range.end);
  const maxCol = Math.max(0, Math.floor(cols) - 1);

  const start = expandBufferRangeStart(state, normalized.start, maxCol, cols);
  const end = expandBufferRangeEnd(state, normalized.end, maxCol, cols);
  return normalizeBufferRange(start, end);
}

export function selectAllTerminalBufferRange(
  state: TerminalBufferState,
  cols = state.cols,
): TerminalBufferRange | null {
  if (state.rowsById.size === 0 || cols <= 0) return null;
  let firstRow: number | null = null;
  let lastRow: number | null = null;
  for (const [rowId, row] of [...state.rowsById.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    if (firstRow === null) firstRow = rowId;
    if (row.cells.some(cell => cell.text.trim().length > 0)) lastRow = rowId;
  }
  if (firstRow === null) return null;
  return {
    start: { row: firstRow, col: 0 },
    end: { row: lastRow ?? firstRow, col: Math.max(0, cols - 1) },
  };
}

function normalizeViewportRows(
  frame: TerminalFrame,
  surface: { cols: number; rows: number },
): TerminalRow[] {
  if (frame.dirty === 'clean') return [];
  if (frame.dirty === 'partial') {
    return frame.rows
      .filter(row => row.index >= 0 && row.index < surface.rows)
      .map(row => ({ ...filterRowToCols(row, surface.cols), index: row.index }));
  }

  const byIndex = new Map(frame.rows.map(row => [row.index, row]));
  return Array.from({ length: surface.rows }, (_, index) => {
    const source = byIndex.get(index);
    return source
      ? { ...filterRowToCols(source, surface.cols), index }
      : { index, dirty: true, cells: [] };
  });
}

function filterRowToCols(row: TerminalRow, cols: number): TerminalRow {
  return {
    ...cloneTerminalRow(row),
    cells: row.cells
      .filter(cell => cell.col < cols)
      .map(cell => ({ ...cell, width: terminalCellWidth(cell, cols) })),
  };
}

function rowWithId(row: TerminalRow, rowId: number): TerminalRow {
  return { ...cloneTerminalRow(row), index: rowId };
}

function anchorPreviousViewportRows(
  previous: TerminalBufferState,
  surface: { cols: number; rows: number },
  nextViewportOffset: number,
) {
  const rowsById = new Map<number, TerminalRow>();
  const previousStart = previous.viewportOffset;
  const previousEnd = previous.viewportOffset + previous.viewportRows;
  for (const [rowId, row] of previous.rowsById) {
    if (rowId >= previousStart && rowId < previousEnd) {
      const nextRowId = nextViewportOffset + (rowId - previousStart);
      rowsById.set(nextRowId, rowWithId(filterRowToCols(row, surface.cols), nextRowId));
      continue;
    }
    rowsById.set(rowId, row);
  }
  return rowsById;
}

function shouldStoreRow(
  frame: TerminalFrame,
  row: TerminalRow,
  existing: TerminalRow | undefined,
): boolean {
  if (frame.dirty === 'partial' && row.dirty === false) return false;
  if (!existing) return true;
  if (frame.dirty !== 'partial') return true;
  return true;
}

function rowIsBlank(row: TerminalRow): boolean {
  return row.cells.every(cell => cell.text.trim().length === 0);
}

function rowHasCells(row: TerminalRow): boolean {
  return row.cells.length > 0;
}

function rangesFromCachedRowsWithCells(
  rowsById: ReadonlyMap<number, TerminalRow>,
  cachedRanges: readonly TerminalBufferRowRange[],
) {
  const cachedRowIds: number[] = [];
  for (const range of cachedRanges) {
    for (let rowId = range.start; rowId < range.end; rowId += 1) {
      const row = rowsById.get(rowId);
      if (row && rowHasCells(row)) cachedRowIds.push(rowId);
    }
  }
  return rangesFromRowIds(cachedRowIds);
}

function cursorWithAbsoluteRow(
  cursor: TerminalCursor | undefined,
  rowOffset: number,
): TerminalCursor | undefined {
  const row = cursor?.position?.row ?? cursor?.row;
  const col = cursor?.position?.col ?? cursor?.col;
  if (!Number.isFinite(row) || !Number.isFinite(col)) return cursor;
  const absoluteRow = rowOffset + (row as number);
  return {
    ...cursor,
    row: absoluteRow,
    col: col as number,
    position: { row: absoluteRow, col: col as number },
  };
}

function cursorForWindow(
  cursor: TerminalCursor | undefined,
  startRow: number,
  rowCount: number,
): TerminalCursor | undefined {
  const row = cursor?.position?.row ?? cursor?.row;
  const col = cursor?.position?.col ?? cursor?.col;
  if (!Number.isFinite(row) || !Number.isFinite(col)) return cursor;
  const windowRow = (row as number) - startRow;
  if (windowRow < 0 || windowRow >= rowCount) {
    return { ...cursor, visible: false };
  }
  return {
    ...cursor,
    row: windowRow,
    col: col as number,
    position: { row: windowRow, col: col as number },
  };
}

function blankRow(index: number): TerminalRow {
  return {
    index,
    dirty: true,
    cells: [],
  };
}

function normalizeBufferRange(
  a: TerminalBufferRange['start'],
  b: TerminalBufferRange['end'],
): TerminalBufferRange {
  if (a.row < b.row || (a.row === b.row && a.col <= b.col)) {
    return { start: { ...a }, end: { ...b } };
  }
  return { start: { ...b }, end: { ...a } };
}

function expandBufferRangeStart(
  state: TerminalBufferState,
  cell: TerminalBufferRange['start'],
  maxCol: number,
  cols: number,
): TerminalBufferRange['start'] {
  const col = clampCol(cell.col, maxCol);
  const renderedCell = terminalCellAtColumn(state.rowsById.get(cell.row), col, cols);
  return { row: cell.row, col: renderedCell ? clampCol(renderedCell.col, maxCol) : col };
}

function expandBufferRangeEnd(
  state: TerminalBufferState,
  cell: TerminalBufferRange['end'],
  maxCol: number,
  cols: number,
): TerminalBufferRange['end'] {
  const col = clampCol(cell.col, maxCol);
  const renderedCell = terminalCellAtColumn(state.rowsById.get(cell.row), col, cols);
  return {
    row: cell.row,
    col: renderedCell ? clampCol(terminalCellEndCol(renderedCell, cols) - 1, maxCol) : col,
  };
}

function clampCol(col: number, maxCol: number) {
  return Math.max(0, Math.min(maxCol, Math.floor(Number.isFinite(col) ? col : 0)));
}

function scrollbackForState(state: TerminalBufferState): TerminalScrollback {
  return {
    totalRows: state.totalRows,
    scrollbackRows: Math.max(0, state.totalRows - state.viewportRows),
    viewportOffset: state.viewportOffset,
    viewportRows: state.viewportRows,
    atBottom: state.atBottom,
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pruneRows(
  rowsById: Map<number, TerminalRow>,
  rowLimit: number,
  keepStart: number,
  keepEnd: number,
) {
  if (rowsById.size <= rowLimit) return false;
  let pruned = false;
  const ids = [...rowsById.keys()].sort((left, right) => left - right);
  for (const id of ids) {
    if (rowsById.size <= rowLimit) return pruned;
    if (id >= keepStart && id < keepEnd) continue;
    rowsById.delete(id);
    pruned = true;
  }
  return pruned;
}

function rowRanges(state: TerminalBufferState): readonly TerminalBufferRowRange[] {
  return state.cachedRanges.length > 0
    ? state.cachedRanges
    : rangesFromRowIds(state.rowsById.keys());
}

function addCachedRange(
  ranges: readonly TerminalBufferRowRange[],
  startRow: number,
  endRow: number,
): TerminalBufferRowRange[] {
  const start = Math.max(0, Math.floor(startRow));
  const end = Math.max(start, Math.floor(endRow));
  if (end <= start) return [...ranges];

  const next: TerminalBufferRowRange[] = [];
  let pending: TerminalBufferRowRange = { start, end };
  let inserted = false;

  for (const range of ranges) {
    if (range.end < pending.start) {
      next.push(range);
      continue;
    }
    if (range.start > pending.end) {
      if (!inserted) {
        next.push(pending);
        inserted = true;
      }
      next.push(range);
      continue;
    }
    pending = {
      start: Math.min(pending.start, range.start),
      end: Math.max(pending.end, range.end),
    };
  }

  if (!inserted) next.push(pending);
  return next;
}

function addCachedRows(
  ranges: readonly TerminalBufferRowRange[],
  rowIds: readonly number[],
): TerminalBufferRowRange[] {
  let next = [...ranges];
  for (const rowId of rowIds) {
    next = addCachedRange(next, rowId, rowId + 1);
  }
  return next;
}

function rangesFromRowIds(rowIds: Iterable<number>): TerminalBufferRowRange[] {
  const ids = [...rowIds].sort((left, right) => left - right);
  const ranges: TerminalBufferRowRange[] = [];
  for (const id of ids) {
    if (!Number.isFinite(id)) continue;
    const rowId = Math.max(0, Math.floor(id));
    const last = ranges.at(-1);
    if (last && last.end >= rowId) {
      last.end = Math.max(last.end, rowId + 1);
    } else {
      ranges.push({ start: rowId, end: rowId + 1 });
    }
  }
  return ranges;
}
