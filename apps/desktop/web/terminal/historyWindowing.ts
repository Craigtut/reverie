export const DEFAULT_HISTORY_WINDOW_MULTIPLIER = 12;

export interface HistoryWindowPlan {
  startRow: number;
  rowCount: number;
  targetRow: number;
}

export function resolveHistoryTotalRows(
  reportedTotalRows: unknown,
  fallbackTotalRows: number,
  surfaceRows: number,
) {
  const surface = positiveInteger(surfaceRows, 1);
  const reported =
    typeof reportedTotalRows === 'number' && Number.isFinite(reportedTotalRows)
      ? Math.floor(reportedTotalRows)
      : null;
  if (reported !== null && reported > 0) return Math.max(surface, reported);
  return Math.max(surface, positiveInteger(fallbackTotalRows, surface));
}

export function historyWindowRows(
  surfaceRows: number,
  totalRows: number,
  multiplier = DEFAULT_HISTORY_WINDOW_MULTIPLIER,
) {
  const total = positiveInteger(totalRows, 1);
  const rows = positiveInteger(surfaceRows, 1);
  const factor = positiveInteger(multiplier, DEFAULT_HISTORY_WINDOW_MULTIPLIER);
  return Math.max(1, Math.min(total, Math.max(rows, rows * factor)));
}

export function planHistoryWindowForTargetRow(
  targetRow: number,
  surfaceRows: number,
  totalRows: number,
  multiplier = DEFAULT_HISTORY_WINDOW_MULTIPLIER,
): HistoryWindowPlan {
  const total = positiveInteger(totalRows, 1);
  const visibleRows = Math.max(1, Math.min(total, positiveInteger(surfaceRows, 1)));
  const rowCount = historyWindowRows(visibleRows, total, multiplier);
  const clampedTarget = clampInteger(targetRow, 0, Math.max(0, total - visibleRows));
  const contextRows = Math.max(0, Math.floor((rowCount - visibleRows) / 2));
  const startRow = clampInteger(clampedTarget - contextRows, 0, Math.max(0, total - rowCount));

  return { startRow, rowCount, targetRow: clampedTarget };
}

export function planHistoryWindowForMissingRows(
  startRow: number,
  rowCount: number,
  surfaceRows: number,
  totalRows: number,
  multiplier = DEFAULT_HISTORY_WINDOW_MULTIPLIER,
): HistoryWindowPlan {
  const total = positiveInteger(totalRows, 1);
  const requestedStart = clampInteger(startRow, 0, Math.max(0, total - 1));
  const requestedRows = Math.max(1, Math.min(total - requestedStart, positiveInteger(rowCount, 1)));
  const targetTopRow = clampInteger(
    requestedStart + Math.floor(Math.max(0, requestedRows - surfaceRows) / 2),
    0,
    Math.max(0, total - Math.max(1, Math.min(total, surfaceRows))),
  );

  return planHistoryWindowForTargetRow(targetTopRow, surfaceRows, total, multiplier);
}

function positiveInteger(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(Number.isFinite(value) ? value : min)));
}
