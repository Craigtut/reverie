import type { TerminalSurface } from '../../terminalScrollback';
import type { BufferCell } from './types';

// Pure hit-test math for the terminal interaction layer. No DOM, no canvas, no
// React, so the gnarly pixel<->cell mapping (the part most likely to be off by a
// row under virtualization) is unit-testable in isolation.
//
// The canvas is virtualized: it paints only a window of rows and is positioned
// with `top: startRow * cellHeight`. A pointer's coordinates relative to the
// canvas element (clientXY minus the canvas bounding rect) are therefore
// window-local. We add the painted `startRow` back to land in
// composite-frame ("buffer") coordinates, which survive scrolling.

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Map a point relative to the canvas top-left to a cell in buffer coordinates.
// `startRow` is the painted window origin (terminalController.getStartRow()),
// which already includes the overscan clamp. `rowCount` is the number of rows in
// the composite frame. Coordinates are clamped into the grid so a drag that
// leaves the canvas still resolves to the nearest edge cell. Returns null only
// when the surface has no cells to hit.
export function pointToCell(
  localX: number,
  localY: number,
  surface: TerminalSurface,
  startRow: number,
  rowCount: number,
): BufferCell | null {
  if (surface.cols <= 0 || rowCount <= 0) return null;

  const col = clamp(Math.floor(localX / surface.cellWidth), 0, surface.cols - 1);
  const windowRow = Math.floor(localY / surface.cellHeight);
  const row = clamp(startRow + windowRow, 0, rowCount - 1);
  return { row, col };
}

// The window-local pixel rect for a buffer cell, or null if the cell is outside
// the painted window. Used to draw overlay decorations.
export function cellRectInWindow(
  cell: BufferCell,
  startRow: number,
  displayRows: number,
  surface: TerminalSurface,
): { x: number; y: number; width: number; height: number } | null {
  const windowRow = cell.row - startRow;
  if (windowRow < 0 || windowRow >= displayRows) return null;
  return {
    x: cell.col * surface.cellWidth,
    y: windowRow * surface.cellHeight,
    width: surface.cellWidth,
    height: surface.cellHeight,
  };
}
