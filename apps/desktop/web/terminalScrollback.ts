import type { TerminalFrame, TerminalRow } from './terminalTypes';
import {
  terminalCellEndCol,
  terminalCellWidth,
  terminalRowTextLayout,
} from './terminal/cellGeometry';
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  measureTerminalCell,
} from './terminal/terminalMetrics';

// Frontend scrollback is a rendered-history foothold, not the final source of terminal truth.
// The backend/Ghostty snapshot still owns authoritative terminal state; this module only keeps
// enough bounded history above the live viewport to make wheel/trackpad navigation feel coherent.
// Invariants:
// - Runtime frames describe the current visible surface, never the whole historical transcript.
// - History grows only from trustworthy viewport overlap between consecutive frames.
// - The scrollback model stays bounded; App virtualizes the Canvas viewport so the backing surface
//   does not grow with every historical row.
// - Live-follow remains sticky until deliberate user scrolling moves the viewport away from the tail.
export const MAX_RENDERED_SCROLLBACK_ROWS = 2_000;
export const MAX_SCROLLBACK_SPACER_HEIGHT_PX = 64_000;
export const SCROLL_FOLLOW_EPSILON_PX = 4;

// Blank scroll inset (in rows) injected above/below the terminal content. Like a
// web page's top padding: when scrolled to the very top there is breathing room
// above the first line, and the content never butts against the chrome. The
// inset is virtual scroll space (it grows the spacer + offsets the canvas); it
// does NOT change the measured grid, so cols/rows are unaffected.
export const TERMINAL_TOP_INSET_ROWS = 1;
export const TERMINAL_BOTTOM_INSET_ROWS = 0;

export function terminalInsetPx(surface: TerminalSurface) {
  return {
    top: TERMINAL_TOP_INSET_ROWS * surface.cellHeight,
    bottom: TERMINAL_BOTTOM_INSET_ROWS * surface.cellHeight,
  };
}

// Cap the live terminal grid width so it keeps a calm, readable measure and a
// centered inset on wide windows instead of stretching edge to edge. The scroll
// /hover target stays full width; only the painted grid is clamped + centered.
export const MAX_CONTENT_WIDTH_PX = 1_180;

export interface TerminalSurface {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  // The configured terminal font size (CSS px) the cell was measured from. The
  // renderers rasterize glyphs at this size; `cellWidth`/`cellHeight` are the
  // device-aligned cell derived from it (see terminalMetrics).
  fontSize: number;
  // Device-px baseline offset from the cell top, so the renderers place glyphs
  // centered in the cell rather than at a fixed top inset.
  baseline: number;
  // The monospace font stack the cell + glyphs use. Kept on the surface so a
  // single source of truth flows to both renderers and the measurement.
  fontFamily: string;
}

// Derive the base surface (cell + metrics) for a font size at a given DPR,
// keeping the default 120x36 grid. The grid is then re-fit to the live viewport
// by `terminalSurfaceForBounds`. Re-deriving on a font-size OR dpr change keeps
// the cell crisp and the grid honest. `dpr` defaults to the current device
// pixel ratio so callers in the app can omit it; tests pass it explicitly.
export function terminalSurfaceForFontSize(
  fontSize: number,
  fallback: TerminalSurface,
  dpr: number = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
): TerminalSurface {
  const fontFamily = fallback.fontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY;
  const cell = measureTerminalCell(fontSize, fontFamily, dpr);
  return {
    ...fallback,
    cellWidth: cell.cellWidth,
    cellHeight: cell.cellHeight,
    baseline: cell.baseline,
    fontSize: cell.fontSize,
    fontFamily,
  };
}

// The default surface: a 120x36 grid measured from the default font size at the
// current DPR. Used to seed the store/controller before the live viewport is
// measured.
export function defaultTerminalSurface(
  dpr: number = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
): TerminalSurface {
  const cell = measureTerminalCell(DEFAULT_TERMINAL_FONT_SIZE, DEFAULT_TERMINAL_FONT_FAMILY, dpr);
  return {
    cols: 120,
    rows: 36,
    cellWidth: cell.cellWidth,
    cellHeight: cell.cellHeight,
    baseline: cell.baseline,
    fontSize: cell.fontSize,
    fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  };
}

// What the custom overlay scrollbar needs to draw + drive itself, derived once
// per paint by the controller (from the DOM in the full-history view, from the
// backend's scrollback metadata while live). Kept renderer-agnostic so the React
// scrollbar never reaches into terminal internals.
export interface TerminalScrollMetrics {
  mode: 'live' | 'history';
  scrollable: boolean;
  atBottom: boolean;
  totalRows: number;
  viewportRows: number;
  offsetRows: number;
  thumbFraction: number;
  startFraction: number;
}

export interface TerminalScrollbackContract {
  /** Runtime frames only describe the visible terminal surface. History is appended above it. */
  viewportRows: number;
  /** The Canvas is deliberately bounded so native surfaces do not grow without limit. */
  maxRenderedHistoryRows: number;
  /** Tail-follow remains active while the viewport is effectively pinned to the bottom. */
  tailFollowEpsilonPx: number;
}

export function terminalScrollbackContract(surface: TerminalSurface): TerminalScrollbackContract {
  return {
    viewportRows: surface.rows,
    maxRenderedHistoryRows: maxRenderedScrollbackRows(surface),
    tailFollowEpsilonPx: SCROLL_FOLLOW_EPSILON_PX,
  };
}

export function terminalSurfaceForBounds(
  width: number,
  height: number,
  fallback: TerminalSurface,
): TerminalSurface {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return fallback;
  }

  // Clamp the grid to a max readable width; the viewport (scroll/hover target)
  // stays full width and the grid is centered within it.
  const gridWidth = Math.min(width, MAX_CONTENT_WIDTH_PX);
  return {
    ...fallback,
    cols: Math.max(40, Math.floor(gridWidth / fallback.cellWidth)),
    rows: Math.max(12, Math.floor(height / fallback.cellHeight)),
  };
}

export function frameForSurface(frame: TerminalFrame, surface: TerminalSurface): TerminalFrame {
  const rows = Array.from({ length: surface.rows }, (_, index) => {
    const source = frame.rows.find(row => row.index === index);

    return {
      index,
      dirty: source?.dirty ?? true,
      cells:
        source?.cells
          .filter(cell => cell.col < surface.cols)
          .map(cell => ({ ...cell, width: terminalCellWidth(cell, surface.cols) })) ?? [],
    };
  });

  const cursorRow = frame.cursor?.position?.row ?? frame.cursor?.row;
  const cursorCol = frame.cursor?.position?.col ?? frame.cursor?.col;
  const cursor =
    Number.isFinite(cursorRow) && Number.isFinite(cursorCol)
      ? {
          ...frame.cursor,
          row: Math.min(surface.rows - 1, Math.max(0, cursorRow as number)),
          col: Math.min(surface.cols - 1, Math.max(0, cursorCol as number)),
          position: {
            row: Math.min(surface.rows - 1, Math.max(0, cursorRow as number)),
            col: Math.min(surface.cols - 1, Math.max(0, cursorCol as number)),
          },
        }
      : frame.cursor;

  return {
    ...frame,
    dirty: frame.dirty ?? 'full',
    cols: surface.cols,
    rows,
    cursor,
  };
}

export function boundedRenderedScrollback(scrollbackRows: TerminalRow[], surface: TerminalSurface) {
  return scrollbackRows.slice(-maxRenderedScrollbackRows(surface));
}

export function maxRenderedScrollbackRows(surface: TerminalSurface) {
  const maxSpacerRows = Math.max(
    surface.rows,
    Math.floor(MAX_SCROLLBACK_SPACER_HEIGHT_PX / surface.cellHeight),
  );
  return Math.max(0, Math.min(MAX_RENDERED_SCROLLBACK_ROWS, maxSpacerRows - surface.rows));
}

export function frameWithScrollback(
  scrollbackRows: TerminalRow[],
  viewportFrame: TerminalFrame,
): TerminalFrame {
  const historyRows = scrollbackRows.map((row, index) => ({
    ...cloneTerminalRow(row),
    index,
    dirty: true,
  }));
  const viewportRows = viewportFrame.rows.map(row => ({
    ...cloneTerminalRow(row),
    index: historyRows.length + row.index,
    dirty: true,
  }));
  const cursorRow = viewportFrame.cursor?.position?.row ?? viewportFrame.cursor?.row;
  const cursorCol = viewportFrame.cursor?.position?.col ?? viewportFrame.cursor?.col;
  const cursor =
    Number.isFinite(cursorRow) && Number.isFinite(cursorCol)
      ? {
          ...viewportFrame.cursor,
          row: historyRows.length + (cursorRow as number),
          col: cursorCol as number,
          position: {
            row: historyRows.length + (cursorRow as number),
            col: cursorCol as number,
          },
        }
      : viewportFrame.cursor;

  return {
    ...viewportFrame,
    dirty: 'full',
    cols: viewportFrame.cols,
    rows: [...historyRows, ...viewportRows],
    cursor,
  };
}

export function scrolledOffRows(
  previousRows: TerminalRow[],
  nextRows: TerminalRow[],
): TerminalRow[] {
  if (previousRows.length === 0 || nextRows.length === 0) return [];

  const maxOverlap = Math.min(previousRows.length, nextRows.length);
  const previousSignatures = previousRows.map(rowSignature);
  const nextSignatures = nextRows.map(rowSignature);
  let overlap = 0;

  for (let candidate = maxOverlap; candidate >= 1; candidate -= 1) {
    const previousStart = previousRows.length - candidate;
    if (rowsShareSignatures(previousSignatures, nextSignatures, previousStart, 0, candidate)) {
      overlap = candidate;
      break;
    }
  }

  const scrolledCount = previousRows.length - overlap;
  if (scrolledCount <= 0) {
    return [];
  }

  const minimumTrustworthyOverlap = Math.max(2, Math.floor(previousRows.length * 0.25));
  if (overlap < minimumTrustworthyOverlap || scrolledCount >= previousRows.length) {
    return [];
  }

  const maxTrustworthyScroll = Math.max(8, Math.ceil(previousRows.length / 3));
  if (scrolledCount > maxTrustworthyScroll) {
    return [];
  }

  const overlapSignatures = nextSignatures.slice(0, overlap);
  const scrolledSignatures = previousSignatures.slice(0, scrolledCount);
  if (!hasMeaningfulRows(overlapSignatures) || !hasMeaningfulRows(scrolledSignatures)) {
    return [];
  }

  return previousRows.slice(0, scrolledCount);
}

function rowsShareSignatures(
  previousSignatures: string[],
  nextSignatures: string[],
  previousStart: number,
  nextStart: number,
  count: number,
) {
  for (let index = 0; index < count; index += 1) {
    if (previousSignatures[previousStart + index] !== nextSignatures[nextStart + index]) {
      return false;
    }
  }

  return true;
}

function rowSignature(row: TerminalRow) {
  return rowPlainText(row).trimEnd();
}

function hasMeaningfulRows(signatures: string[]) {
  return signatures.filter(signature => signature.trim().length > 0).length >= 1;
}

function rowPlainText(row: TerminalRow) {
  const cols = row.cells.reduce((max, cell) => Math.max(max, terminalCellEndCol(cell)), 1);
  return terminalRowTextLayout(row, cols).text;
}

export function cloneTerminalRow(row: TerminalRow): TerminalRow {
  return {
    ...row,
    cells: row.cells.map(cell => ({
      ...cell,
      style: cell.style ? { ...cell.style } : undefined,
    })),
  };
}
