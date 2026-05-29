import type { RowSpan, SelectionRange } from './types';

// Translate a buffer-coordinate selection range into window-local row spans the
// renderer can fill. The painted window covers buffer rows
// [startRow, startRow + displayRows); rows outside it are dropped (they are not
// painted), so a selection made far up in scrollback simply isn't drawn until
// scrolled into view. End columns are inclusive in the range and emitted as
// exclusive spans, clamped to the surface width. Pure: no DOM, no canvas.
export function selectionWindowSpans(
  range: SelectionRange | null,
  startRow: number,
  displayRows: number,
  cols: number,
): RowSpan[] {
  if (!range || cols <= 0 || displayRows <= 0) return [];

  const spans: RowSpan[] = [];
  const firstRow = Math.max(range.start.row, startRow);
  const lastRow = Math.min(range.end.row, startRow + displayRows - 1);

  for (let r = firstRow; r <= lastRow; r += 1) {
    const startCol = r === range.start.row ? range.start.col : 0;
    const endColInclusive = r === range.end.row ? range.end.col : cols - 1;
    const clampedStart = Math.max(0, Math.min(startCol, cols - 1));
    const clampedEnd = Math.max(clampedStart, Math.min(endColInclusive, cols - 1));
    spans.push({ row: r - startRow, startCol: clampedStart, endCol: clampedEnd + 1 });
  }

  return spans;
}

// Translate a single buffer-coordinate span (a detected link on one row) into a
// window-local span, or null if that row is outside the painted window.
export function rowSpanInWindow(
  bufferRow: number,
  startCol: number,
  endColExclusive: number,
  startRow: number,
  displayRows: number,
  cols: number,
): RowSpan | null {
  const windowRow = bufferRow - startRow;
  if (windowRow < 0 || windowRow >= displayRows || cols <= 0) return null;
  const clampedStart = Math.max(0, Math.min(startCol, cols));
  const clampedEnd = Math.max(clampedStart, Math.min(endColExclusive, cols));
  if (clampedEnd <= clampedStart) return null;
  return { row: windowRow, startCol: clampedStart, endCol: clampedEnd };
}
