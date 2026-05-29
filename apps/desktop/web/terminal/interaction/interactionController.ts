import type { TerminalFrame, TerminalModes } from '../../terminalTypes';
import type { TerminalSurface } from '../../terminalScrollback';
import { pointToCell } from './geometry';
import { lineRangeAt, normalizeRange, selectAllRange, wordRangeAt } from './selectionModel';
import type { BufferCell, BufferLinkSpan, SelectionMode, SelectionRange } from './types';

// The imperative input island for the terminal. It normalizes pointer events,
// hit-tests them to buffer cells, and drives the selection model on the host
// (the terminal controller). It keeps NO paint state of its own: it reads the
// painted window origin + composite frame from the port and writes selection
// ranges back. The renderer overlay and repaints are the port's job.
//
// Right-click menu wiring (Phase 2) hangs off `onContextMenu`, which receives
// the resolved cell + the live selection so the caller can build a menu without
// re-implementing hit-testing.

// The slice of the terminal controller this island needs. Declared structurally
// so it can be faked in tests/harness without a real canvas.
export interface TerminalInteractionPort {
  getCanvas(): HTMLCanvasElement | null;
  getViewport(): HTMLDivElement | null;
  getSurface(): TerminalSurface;
  getStartRow(): number;
  getComposite(): TerminalFrame | null;
  getLastFrameModes(): TerminalModes | undefined;
  getSelection(): SelectionRange | null;
  setSelection(range: SelectionRange | null): void;
  clearSelection(): void;
  setHoverLink(link: BufferLinkSpan | null): void;
  linkAt(cell: BufferCell): BufferLinkSpan | null;
  focusCanvas(): void;
}

export interface ContextMenuContext {
  event: MouseEvent;
  cell: BufferCell | null;
  selection: SelectionRange | null;
}

export interface TerminalInteractionOptions {
  port: TerminalInteractionPort;
  onContextMenu?: (context: ContextMenuContext) => void;
  // Activate a link (plain click on a URL). The host opens it externally.
  onActivateLink?: (href: string) => void;
}

// Two clicks within this window on (about) the same cell escalate the selection
// mode: 1 = char, 2 = word, 3 = line.
const MULTI_CLICK_MS = 450;
// While dragging, scroll the viewport when the pointer is within this many
// pixels of the top/bottom edge so a selection can run past the visible window.
const EDGE_AUTOSCROLL_MARGIN_PX = 24;

function sameCell(a: BufferCell | null, b: BufferCell | null): boolean {
  return Boolean(a && b && a.row === b.row && a.col === b.col);
}

// The widest extent of two ranges (used to grow word/line selections during a
// drag while keeping the original anchor word/line included).
function unionRange(a: SelectionRange, b: SelectionRange): SelectionRange {
  const start =
    a.start.row < b.start.row || (a.start.row === b.start.row && a.start.col <= b.start.col)
      ? a.start
      : b.start;
  const end =
    a.end.row > b.end.row || (a.end.row === b.end.row && a.end.col >= b.end.col) ? a.end : b.end;
  return { start: { ...start }, end: { ...end } };
}

export function createTerminalInteraction(options: TerminalInteractionOptions) {
  const { port, onContextMenu, onActivateLink } = options;

  let attachedCanvas: HTMLCanvasElement | null = null;
  let dragging = false;
  let moved = false;
  let mode: SelectionMode = 'char';
  let anchorCell: BufferCell | null = null;
  let anchorRange: SelectionRange | null = null; // for word/line modes
  let downLink: BufferLinkSpan | null = null; // link under the press, for click-to-open
  let activePointerId: number | null = null;
  let lastDownTime = 0;
  let lastDownCell: BufferCell | null = null;
  let clickCount = 0;
  let pendingEvent: PointerEvent | null = null;
  let dragRaf = 0;

  function cellAtEvent(event: { clientX: number; clientY: number }): BufferCell | null {
    const canvas = port.getCanvas();
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const composite = port.getComposite();
    const rowCount = composite?.rows.length ?? 0;
    return pointToCell(
      event.clientX - rect.left,
      event.clientY - rect.top,
      port.getSurface(),
      port.getStartRow(),
      rowCount,
    );
  }

  // Local selection is suppressed while an app has mouse tracking on (vim, htop)
  // unless Shift is held, mirroring the wheel-scroll gate and iTerm/Ghostty.
  function localSelectionAllowed(event: { shiftKey: boolean }): boolean {
    return !port.getLastFrameModes()?.mouseTracking || event.shiftKey;
  }

  function extendTo(event: { clientX: number; clientY: number }) {
    const cell = cellAtEvent(event);
    if (!cell || !anchorCell) return;
    if (!sameCell(cell, anchorCell)) moved = true;

    const composite = port.getComposite();
    const cols = port.getSurface().cols;

    if (mode === 'char') {
      if (!moved) return; // a click that never moved leaves the selection cleared
      port.setSelection(normalizeRange(anchorCell, cell));
      return;
    }
    if (!composite || !anchorRange) return;
    const headRange =
      mode === 'word' ? wordRangeAt(composite, cell, cols) : lineRangeAt(composite, cell);
    port.setSelection(unionRange(anchorRange, headRange));
  }

  function autoScroll(event: { clientY: number }) {
    const viewport = port.getViewport();
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const step = port.getSurface().cellHeight;
    if (event.clientY < rect.top + EDGE_AUTOSCROLL_MARGIN_PX) {
      viewport.scrollTop = Math.max(0, viewport.scrollTop - step);
    } else if (event.clientY > rect.bottom - EDGE_AUTOSCROLL_MARGIN_PX) {
      viewport.scrollTop = Math.min(viewport.scrollHeight, viewport.scrollTop + step);
    }
  }

  // One coalesced drag tick per frame: autoscroll at the edges, then re-extend
  // the selection to the latest pointer position (re-hit-tested against the
  // possibly-scrolled window).
  function dragTick() {
    dragRaf = 0;
    if (!dragging) return;
    if (pendingEvent) {
      autoScroll(pendingEvent);
      extendTo(pendingEvent);
    }
    dragRaf = requestAnimationFrame(dragTick);
  }

  function startDragLoop() {
    if (!dragRaf) dragRaf = requestAnimationFrame(dragTick);
  }

  function stopDragLoop() {
    if (dragRaf) cancelAnimationFrame(dragRaf);
    dragRaf = 0;
  }

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0) return; // primary button only; right-click -> contextmenu
    port.focusCanvas();
    if (!localSelectionAllowed(event)) return;

    const cell = cellAtEvent(event);
    if (!cell) return;

    const now = event.timeStamp;
    if (now - lastDownTime < MULTI_CLICK_MS && sameCell(lastDownCell, cell)) {
      clickCount += 1;
    } else {
      clickCount = 1;
    }
    lastDownTime = now;
    lastDownCell = cell;

    mode = clickCount >= 3 ? 'line' : clickCount === 2 ? 'word' : 'char';
    anchorCell = cell;
    dragging = true;
    moved = false;
    activePointerId = event.pointerId;
    const canvas = port.getCanvas();
    try {
      canvas?.setPointerCapture(event.pointerId);
    } catch {
      // setPointerCapture can throw if the pointer is already gone; ignore.
    }

    const composite = port.getComposite();
    const cols = port.getSurface().cols;
    if (mode === 'word' && composite) {
      anchorRange = wordRangeAt(composite, cell, cols);
      moved = true; // a word/line selection exists immediately, even without a drag
      downLink = null;
      port.setSelection(anchorRange);
    } else if (mode === 'line' && composite) {
      anchorRange = lineRangeAt(composite, cell);
      moved = true;
      downLink = null;
      port.setSelection(anchorRange);
    } else {
      anchorRange = null;
      // Remember a link under the press: a click that never drags opens it.
      downLink = port.linkAt(cell);
      // Fresh char drag: clear any prior selection without yanking the viewport.
      port.setSelection(null);
    }
    startDragLoop();
  }

  // Hover handling for links: outside a drag, track the link under the pointer
  // and swap the cursor to a pointer over it.
  function updateHover(event: PointerEvent) {
    const cell = cellAtEvent(event);
    const link = cell ? port.linkAt(cell) : null;
    port.setHoverLink(link);
    const canvas = port.getCanvas();
    if (canvas) canvas.style.cursor = link ? 'pointer' : '';
  }

  function clearHover() {
    port.setHoverLink(null);
    const canvas = port.getCanvas();
    if (canvas) canvas.style.cursor = '';
  }

  function onPointerMove(event: PointerEvent) {
    if (dragging) {
      pendingEvent = event;
      return;
    }
    updateHover(event);
  }

  function endDrag(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    stopDragLoop();
    // Settle the selection on the pointer's final position.
    extendTo(event);
    pendingEvent = null;
    if (activePointerId !== null) {
      try {
        port.getCanvas()?.releasePointerCapture(activePointerId);
      } catch {
        // already released
      }
      activePointerId = null;
    }
    // A plain click that never moved either opens a link under it or deselects.
    if (mode === 'char' && !moved) {
      if (downLink && onActivateLink) onActivateLink(downLink.href);
      else port.setSelection(null);
    }
    downLink = null;
  }

  function onContextMenuEvent(event: MouseEvent) {
    if (!onContextMenu) return;
    const cell = cellAtEvent(event);
    onContextMenu({ event, cell, selection: port.getSelection() });
  }

  function attach() {
    const canvas = port.getCanvas();
    if (!canvas || canvas === attachedCanvas) return;
    detach();
    attachedCanvas = canvas;
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('pointerleave', clearHover);
    canvas.addEventListener('contextmenu', onContextMenuEvent);
  }

  function detach() {
    stopDragLoop();
    const canvas = attachedCanvas;
    if (!canvas) return;
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', endDrag);
    canvas.removeEventListener('pointercancel', endDrag);
    canvas.removeEventListener('pointerleave', clearHover);
    canvas.removeEventListener('contextmenu', onContextMenuEvent);
    clearHover();
    attachedCanvas = null;
  }

  return {
    attach,
    detach,
    // Imperative helpers the hook wires to keyboard/menu actions.
    selectAll() {
      const composite = port.getComposite();
      if (!composite) return;
      const range = selectAllRange(composite, port.getSurface().cols);
      if (range) port.setSelection(range);
    },
    clearSelection() {
      port.clearSelection();
    },
  };
}

export type TerminalInteraction = ReturnType<typeof createTerminalInteraction>;
