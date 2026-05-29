import type { TerminalFrame, TerminalRow } from './terminalTypes';

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

export interface TerminalSurface {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
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

  return {
    ...fallback,
    cols: Math.max(40, Math.floor(width / fallback.cellWidth)),
    rows: Math.max(12, Math.floor(height / fallback.cellHeight)),
  };
}

export function frameForSurface(frame: TerminalFrame, surface: TerminalSurface): TerminalFrame {
  const rows = Array.from({ length: surface.rows }, (_, index) => {
    const source = frame.rows.find(row => row.index === index);

    return {
      index,
      dirty: source?.dirty ?? true,
      cells: source?.cells.filter(cell => cell.col < surface.cols) ?? [],
    };
  });

  const cursorRow = frame.cursor?.position?.row ?? frame.cursor?.row;
  const cursorCol = frame.cursor?.position?.col ?? frame.cursor?.col;
  const cursor = Number.isFinite(cursorRow) && Number.isFinite(cursorCol)
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
    rows,
    cursor,
  };
}

export function boundedRenderedScrollback(scrollbackRows: TerminalRow[], surface: TerminalSurface) {
  return scrollbackRows.slice(-maxRenderedScrollbackRows(surface));
}

export function maxRenderedScrollbackRows(surface: TerminalSurface) {
  const maxSpacerRows = Math.max(surface.rows, Math.floor(MAX_SCROLLBACK_SPACER_HEIGHT_PX / surface.cellHeight));
  return Math.max(0, Math.min(MAX_RENDERED_SCROLLBACK_ROWS, maxSpacerRows - surface.rows));
}

export function frameWithScrollback(scrollbackRows: TerminalRow[], viewportFrame: TerminalFrame): TerminalFrame {
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
  const cursor = Number.isFinite(cursorRow) && Number.isFinite(cursorCol)
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
    rows: [...historyRows, ...viewportRows],
    cursor,
  };
}

export function scrolledOffRows(previousRows: TerminalRow[], nextRows: TerminalRow[]): TerminalRow[] {
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
  return row.cells
    .slice()
    .sort((left, right) => left.col - right.col)
    .map(cell => cell.text)
    .join('');
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
