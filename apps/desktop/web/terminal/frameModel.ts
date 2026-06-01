import { cloneTerminalRow, frameForSurface, type TerminalSurface } from '../terminalScrollback';
import type { SessionTerminalView } from '../domain';
import type { TerminalFrame } from '../terminalTypes';

// Pure frame/view transforms + the windowed-paint math for the terminal island.
// No DOM, no renderer, no React — data in, data out — so the gnarly windowing /
// cursor / scroll logic is unit-testable in isolation. The imperative controller
// (terminalController.ts) calls these and owns the side effects.

// Extra rows rendered above/below the visible viewport so fast scrolls don't
// flash blank rows before the next paint catches up.
export const OVERSCAN_ROWS = 3;

// History prefetch sizing. When the view is scrolled back, the frontend keeps an
// aligned band of older rows resident AHEAD of the viewport (mostly above it, the
// scroll-up direction) so scrolling into history hits warm cache instead of
// stalling on a per-screen fetch. The whole band is pulled in one round-trip and
// cached; snapping the band bounds to a fixed grid keeps the request key stable
// across small scrolls so it dedupes instead of refetching. This mirrors how
// remote terminal clients (WezTerm's mux client) keep scroll smooth over an IPC
// boundary: a large warm cache + fetch-ahead, not a thin reactive overscan.
export const HISTORY_PREFETCH_LEAD_ROWS = 128;
export const HISTORY_PREFETCH_ALIGN_ROWS = 128;

export function blankTerminalFrame(surface: TerminalSurface): TerminalFrame {
  return {
    dirty: 'full',
    cols: surface.cols,
    rows: Array.from({ length: surface.rows }, (_, index) => ({
      index,
      dirty: true,
      cells: [],
    })),
    cursor: { visible: false, row: 0, col: 0, position: { row: 0, col: 0 } },
  };
}

export function emptyTerminalView(surface: TerminalSurface): SessionTerminalView {
  return {
    lastFrame: null,
    compositeFrame: blankTerminalFrame(surface),
    scrollbackRows: [],
    rowCount: 0,
    liveFollow: true,
  };
}

// Map a raw backend frame onto the active surface and derive the view a session
// should display. Live-follow sticks to the backend's atBottom when present,
// else inherits the previous view, else defaults on.
export function buildSessionTerminalView(
  previousView: SessionTerminalView | undefined,
  frame: TerminalFrame,
  surface: TerminalSurface,
): SessionTerminalView {
  const surfaceFrame =
    frame.dirty === 'partial'
      ? mergePartialFrameForSurface(previousView?.lastFrame ?? null, frame, surface)
      : frameForSurface(frame, surface);
  return {
    lastFrame: surfaceFrame,
    compositeFrame: surfaceFrame,
    scrollbackRows: [],
    rowCount: surfaceFrame.scrollback?.scrollbackRows ?? 0,
    liveFollow: surfaceFrame.scrollback?.atBottom ?? previousView?.liveFollow ?? true,
  };
}

function mergePartialFrameForSurface(
  previousFrame: TerminalFrame | null,
  frame: TerminalFrame,
  surface: TerminalSurface,
): TerminalFrame {
  const current = frameForSurface({ ...frame, dirty: 'full' }, surface);
  const previousRows =
    previousFrame && previousFrame.modes?.alternateScreen === frame.modes?.alternateScreen
      ? new Map(previousFrame.rows.map(row => [row.index, row]))
      : new Map<number, TerminalFrame['rows'][number]>();
  const currentRows = new Map(current.rows.map(row => [row.index, row]));
  const dirtyRows = new Set(
    frame.rows
      .filter(row => row.index >= 0 && row.index < surface.rows && row.dirty !== false)
      .map(row => row.index),
  );
  const rows = Array.from({ length: surface.rows }, (_, index) => {
    const row = dirtyRows.has(index) ? currentRows.get(index) : previousRows.get(index);
    return row
      ? { ...cloneTerminalRow(row), index, dirty: dirtyRows.has(index) }
      : { index, dirty: dirtyRows.has(index), cells: [] };
  });

  return {
    ...current,
    dirty: 'partial',
    rows,
  };
}

export interface PaintWindow {
  startRow: number;
  displayRows: number;
  forceFullPaint: boolean;
  windowFrame: TerminalFrame;
}

// Given a composite frame, the surface, and the current scroll/viewport state,
// compute the slice of rows to actually paint (windowed virtualization), with
// row indices rebased to the window and the cursor remapped or hidden. Pure:
// the caller supplies scrollTop/viewportHeight and the prior paint state
// (needsFullPaint, lastStartRow) and applies the returned window to the canvas.
export function computePaintWindow(args: {
  frame: TerminalFrame;
  surface: TerminalSurface;
  scrollTop: number;
  viewportHeight: number;
  needsFullPaint: boolean;
  lastStartRow: number | null;
  // Blank scroll space (px) injected above the first row; subtracted from
  // scrollTop so the window tracks the content, not the inset. Defaults to 0.
  topInsetPx?: number;
}): PaintWindow {
  const { frame, surface, scrollTop, viewportHeight, needsFullPaint, lastStartRow } = args;
  const topInsetPx = args.topInsetPx ?? 0;

  const targetDisplayRows = Math.max(
    surface.rows,
    Math.ceil(viewportHeight / surface.cellHeight) + OVERSCAN_ROWS * 2,
  );
  const displayRows = Math.max(1, Math.min(frame.rows.length, targetDisplayRows));
  const maxStartRow = Math.max(0, frame.rows.length - displayRows);
  const startRow = Math.min(
    maxStartRow,
    Math.max(0, Math.floor((scrollTop - topInsetPx) / surface.cellHeight) - OVERSCAN_ROWS),
  );
  const endRow = startRow + displayRows;
  const forceFullPaint = needsFullPaint || lastStartRow !== startRow || frame.dirty !== 'partial';

  const rows = frame.rows
    .filter(row => row.index >= startRow && row.index < endRow && (forceFullPaint || row.dirty))
    .map(row => ({
      ...cloneTerminalRow(row),
      index: row.index - startRow,
      dirty: forceFullPaint || row.dirty,
    }));

  const cursorRow = frame.cursor?.position?.row ?? frame.cursor?.row;
  const cursorCol = frame.cursor?.position?.col ?? frame.cursor?.col;
  const cursorVisible =
    Number.isFinite(cursorRow) &&
    Number.isFinite(cursorCol) &&
    (cursorRow as number) >= startRow &&
    (cursorRow as number) < endRow;

  const windowFrame: TerminalFrame = {
    ...frame,
    dirty: forceFullPaint ? 'full' : frame.dirty,
    rows,
    cursor: cursorVisible
      ? {
          ...frame.cursor,
          row: (cursorRow as number) - startRow,
          col: cursorCol as number,
          position: {
            row: (cursorRow as number) - startRow,
            col: cursorCol as number,
          },
        }
      : { ...frame.cursor, visible: false },
  };

  return { startRow, displayRows, forceFullPaint, windowFrame };
}
