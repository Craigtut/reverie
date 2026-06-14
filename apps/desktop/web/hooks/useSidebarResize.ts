import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { useShellStore } from '../store';

// Left navigation panel width bounds (CSS px). These mirror the backend clamp in
// reverie-core (set_sidebar_width) so the live drag and the persisted value agree.
// The minimum keeps the rail's rows readable; the maximum is a generous safety
// cap so a runaway drag can never swallow the window. The default matches the
// shell's grid column (themes/appShell.ts) and is intentionally left unchanged.
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 560;
export const DEFAULT_SIDEBAR_WIDTH = 288;

export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)));
}

// The custom property the layout grid reads for its first column. The shell sets
// it from the persisted width and the drag updates it imperatively (below) so a
// pointer move never re-renders the whole tree, only repaints the grid.
const SIDEBAR_WIDTH_VAR = '--reverie-sidebar-width';

export interface SidebarResize {
  // Attach to the shell element (the grid container) whose CSS var drives the
  // first column. Seeded with the persisted width; updated live during a drag.
  shellRef: (node: HTMLElement | null) => void;
  // The committed width (CSS px), used to seed the shell's inline style and the
  // handle's aria-valuenow.
  width: number;
  // True while a drag is in progress, so the handle can show its active state
  // and the shell can suppress transitions/selection.
  resizing: boolean;
  // Start a drag from the resize handle's onPointerDown.
  beginResize: (event: ReactPointerEvent) => void;
  // Keyboard resize: shift the width by `delta` px (clamped) and persist, so the
  // splitter is operable with the arrow keys when focused.
  nudge: (delta: number) => void;
}

// Drag-to-resize for the left navigation panel, persisted to the backend.
//
// The committed width is seeded from the workspace snapshot and applied to the
// shell's grid var. While dragging we write the var directly on the shell node
// (no React state churn per pixel) and only commit to state + persist once on
// release, so the rail tracks the cursor smoothly and the backend sees one write.
export function useSidebarResize(persistWidth: (width: number) => void): SidebarResize {
  const persisted = useShellStore(s => s.shell.workspace.sidebarWidth);
  const [width, setWidth] = useState(() => clampSidebarWidth(persisted ?? DEFAULT_SIDEBAR_WIDTH));
  const [resizing, setResizing] = useState(false);

  const shellNodeRef = useRef<HTMLElement | null>(null);
  // Live drag bookkeeping; non-null only while a pointer is down on the handle.
  const dragRef = useRef<{ startX: number; startWidth: number; current: number } | null>(null);
  // Latest committed width, read by the stable ref callback so it can seed the
  // var on mount without depending on `width` (which would churn the ref).
  const widthRef = useRef(width);
  widthRef.current = width;

  const applyVar = useCallback((value: number) => {
    shellNodeRef.current?.style.setProperty(SIDEBAR_WIDTH_VAR, `${value}px`);
  }, []);

  // Stable ref callback: when the shell mounts, seed the grid var with the latest
  // committed width so the first paint already reflects the saved width. The var
  // is driven imperatively from here on (never via a declarative style prop), so
  // an unrelated re-render mid-drag can never reset it and yank the panel back.
  const shellRef = useCallback((node: HTMLElement | null) => {
    shellNodeRef.current = node;
    if (node && !dragRef.current) {
      node.style.setProperty(SIDEBAR_WIDTH_VAR, `${widthRef.current}px`);
    }
  }, []);

  // Keep the grid var in sync with the committed width whenever it changes from a
  // commit (drag end, keyboard nudge, persisted reload). This only fires when
  // `width` actually changes, so unrelated re-renders leave a live drag alone.
  useEffect(() => {
    applyVar(width);
  }, [width, applyVar]);

  // Adopt a width persisted elsewhere (e.g. the snapshot reloads). Skipped during
  // a drag so an in-flight gesture is never yanked back to the stored value; the
  // width effect above repaints the var once the new committed width lands.
  useEffect(() => {
    if (dragRef.current) return;
    if (persisted == null) return;
    setWidth(clampSidebarWidth(persisted));
  }, [persisted]);

  const beginResize = useCallback(
    (event: ReactPointerEvent) => {
      // Only a primary-button drag resizes; ignore secondary/middle.
      if (event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget as HTMLElement;
      handle.setPointerCapture(event.pointerId);
      dragRef.current = { startX: event.clientX, startWidth: width, current: width };
      setResizing(true);

      const onMove = (move: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const next = clampSidebarWidth(drag.startWidth + (move.clientX - drag.startX));
        drag.current = next;
        applyVar(next);
      };
      // Force the resize cursor everywhere for the duration of the drag, so it
      // does not flip to the terminal's cursor when the pointer crosses the stage.
      const previousCursor = document.body.style.cursor;
      document.body.style.cursor = 'col-resize';
      const onEnd = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);
        document.body.style.cursor = previousCursor;
        const drag = dragRef.current;
        dragRef.current = null;
        setResizing(false);
        if (!drag) return;
        setWidth(drag.current);
        if (drag.current !== drag.startWidth) persistWidth(drag.current);
      };
      // Listen on the handle itself: pointer capture routes all move/up events
      // here, so dragging over the terminal canvas can't steal them.
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onEnd);
      handle.addEventListener('pointercancel', onEnd);
    },
    [width, applyVar, persistWidth],
  );

  const nudge = useCallback(
    (delta: number) => {
      setWidth(prev => {
        const next = clampSidebarWidth(prev + delta);
        if (next !== prev) {
          applyVar(next);
          persistWidth(next);
        }
        return next;
      });
    },
    [applyVar, persistWidth],
  );

  return { shellRef, width, resizing, beginResize, nudge };
}
