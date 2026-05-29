import { createTerminalCanvasRenderer } from '../terminal-canvas-renderer';
import { SCROLL_FOLLOW_EPSILON_PX, frameForSurface, type TerminalSurface } from '../terminalScrollback';
import type { SessionTerminalView } from '../domain';
import type { TerminalFrame, TerminalModes, TerminalRenderer } from '../terminalTypes';
import { buildSessionTerminalView, computePaintWindow, emptyTerminalView } from './frameModel';

// Opacity of the terminal's default background. 0 lets the shell gradient + dot
// field show through so the session feels painted onto the surface.
const TERMINAL_BACKGROUND_OPACITY = 0;

export interface TerminalDomRefs {
  canvas: HTMLCanvasElement | null;
  viewport: HTMLDivElement | null;
  spacer: HTMLDivElement | null;
}

export interface TerminalControllerOptions {
  surface: TerminalSurface;
  // React-state sync callbacks (the controller stays framework-agnostic).
  onScrollbackRowCount: (count: number) => void;
  onLiveFollow: (live: boolean) => void;
  // Injectable for tests; defaults to the real Canvas renderer.
  createRenderer?: (canvas: HTMLCanvasElement, surface: TerminalSurface, displayRows: number) => TerminalRenderer;
}

// The imperative terminal island: owns the Canvas renderer, the DOM elements,
// the live frame buffers, scroll/follow state, and the per-session view caches.
// Knows nothing about stores, services, sessions-as-domain, or React — it just
// paints. The hook (useTerminalSession) wires it to React + the stores and
// drives the session lifecycle.
export function createTerminalController(options: TerminalControllerOptions) {
  const { onScrollbackRowCount, onLiveFollow } = options;
  const createRenderer = options.createRenderer
    ?? ((canvas, surface, displayRows) => createTerminalCanvasRenderer(canvas, { ...surface, rows: displayRows, backgroundOpacity: TERMINAL_BACKGROUND_OPACITY }));

  let els: TerminalDomRefs = { canvas: null, viewport: null, spacer: null };
  let surface: TerminalSurface = options.surface;
  let renderer: TerminalRenderer | null = null;
  let lastFrame: TerminalFrame | null = null;
  let lastComposite: TerminalFrame | null = null;
  let needsFullPaint = true;
  let lastStartRow: number | null = null;
  let liveFollow = true;
  let autoScrolling = false;
  const sessionViews: Record<string, SessionTerminalView> = {};
  const latestFrames: Record<string, TerminalFrame> = {};

  function mountRenderer(displayRows = surface.rows): TerminalRenderer | null {
    if (!els.canvas) return null;
    renderer = createRenderer(els.canvas, surface, displayRows);
    return renderer;
  }

  function ensureRenderer(forSurface: TerminalSurface, displayRows: number): TerminalRenderer | null {
    if (!renderer || renderer.cols !== forSurface.cols || renderer.rows !== displayRows) {
      needsFullPaint = true;
      lastStartRow = null;
      return mountRenderer(displayRows);
    }
    return renderer;
  }

  function updateSpacer(totalRows: number, forSurface: TerminalSurface) {
    const spacer = els.spacer;
    if (!spacer) return;
    spacer.style.height = `${Math.max(totalRows, forSurface.rows) * forSurface.cellHeight}px`;
    spacer.style.width = `${forSurface.cols * forSurface.cellWidth}px`;
  }

  function paintWindow(frame: TerminalFrame | null = lastComposite, forSurface: TerminalSurface = surface) {
    if (!frame) return;
    const viewport = els.viewport;
    const viewportHeight = Math.max(forSurface.cellHeight, viewport?.clientHeight ?? forSurface.rows * forSurface.cellHeight);
    const scrollTop = viewport?.scrollTop ?? 0;

    const { startRow, displayRows, forceFullPaint, windowFrame } = computePaintWindow({
      frame, surface: forSurface, scrollTop, viewportHeight, needsFullPaint, lastStartRow,
    });
    const activeRenderer = ensureRenderer(forSurface, displayRows);

    if (els.canvas) {
      els.canvas.style.transform = `translateY(${startRow * forSurface.cellHeight}px)`;
    }
    if (forceFullPaint) {
      activeRenderer?.clear(windowFrame.colors?.background);
    }
    activeRenderer?.paintFrame(windowFrame);
    needsFullPaint = false;
    lastStartRow = startRow;
  }

  function scrollToTail() {
    const viewport = els.viewport;
    if (!viewport) return;
    autoScrolling = true;
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    paintWindow();
    requestAnimationFrame(() => {
      paintWindow();
      const stillFollowing = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - SCROLL_FOLLOW_EPSILON_PX;
      autoScrolling = false;
      setLiveFollow(stillFollowing);
    });
  }

  function applyView(view: SessionTerminalView, forSurface: TerminalSurface = surface) {
    lastFrame = view.lastFrame;
    lastComposite = view.compositeFrame;
    liveFollow = view.liveFollow;
    onScrollbackRowCount(view.rowCount);
    onLiveFollow(view.liveFollow);
    updateSpacer(view.compositeFrame.rows.length, forSurface);
    paintWindow(view.compositeFrame, forSurface);
    requestAnimationFrame(() => {
      if (liveFollow) scrollToTail();
      else paintWindow();
    });
  }

  function clear(forSurface: TerminalSurface = surface) {
    renderer = null;
    needsFullPaint = true;
    lastStartRow = null;
    const view = emptyTerminalView(forSurface);
    lastFrame = null;
    lastComposite = view.compositeFrame;
    setLiveFollow(true);
    onScrollbackRowCount(0);
    updateSpacer(forSurface.rows, forSurface);
    paintWindow(view.compositeFrame, forSurface);
  }

  function resetScrollback() {
    lastComposite = null;
    needsFullPaint = true;
    lastStartRow = null;
    setLiveFollow(true);
    onScrollbackRowCount(0);
    updateSpacer(surface.rows, surface);
  }

  function paintFrame(rawFrame: TerminalFrame) {
    const surfaceFrame = frameForSurface(rawFrame, surface);
    lastFrame = surfaceFrame;
    onScrollbackRowCount(surfaceFrame.scrollback?.scrollbackRows ?? 0);
    lastComposite = surfaceFrame;
    updateSpacer(surfaceFrame.rows.length, surface);
    paintWindow(surfaceFrame, surface);
    requestAnimationFrame(() => {
      if (liveFollow) scrollToTail();
      else paintWindow();
    });
  }

  function ensureSessionView(sessionId: string, forSurface: TerminalSurface = surface): SessionTerminalView | undefined {
    const frame = latestFrames[sessionId];
    if (frame) {
      const view = buildSessionTerminalView(sessionViews[sessionId], frame, forSurface);
      sessionViews[sessionId] = view;
      return view;
    }
    return sessionViews[sessionId];
  }

  function paintCurrent(selectedSessionId: string | null, forSurface: TerminalSurface = surface) {
    if (selectedSessionId) {
      const view = ensureSessionView(selectedSessionId, forSurface);
      if (view) {
        applyView(view, forSurface);
        return;
      }
    }
    if (lastFrame) {
      paintFrame(lastFrame);
      return;
    }
    clear(forSurface);
  }

  // Per-frame ingestion from the backend stream. Active sessions build + apply a
  // fresh view; backgrounded sessions keep only the raw frame and drop any stale
  // built view, so off-screen output costs nothing on the main thread.
  function ingestFrame(sessionId: string, frame: TerminalFrame, isActive: boolean) {
    latestFrames[sessionId] = frame;
    if (isActive) {
      const next = buildSessionTerminalView(sessionViews[sessionId], frame, surface);
      sessionViews[sessionId] = next;
      applyView(next);
    } else {
      delete sessionViews[sessionId];
    }
  }

  function setLiveFollow(live: boolean) {
    liveFollow = live;
    onLiveFollow(live);
  }

  return {
    attach(next: TerminalDomRefs) { els = next; },
    setSurface(next: TerminalSurface) { surface = next; },
    getSurface() { return surface; },
    resetRenderer() { renderer = null; },
    requireRenderer(): TerminalRenderer {
      const active = renderer ?? mountRenderer();
      if (!active) throw new Error('Terminal renderer is not mounted yet');
      return active;
    },
    seedEmptyView(sessionId: string) {
      const view = emptyTerminalView(surface);
      sessionViews[sessionId] = view;
      return view;
    },
    paintWindow,
    applyView,
    paintFrame,
    paintCurrent,
    clear,
    resetScrollback,
    scrollToTail,
    ensureSessionView,
    ingestFrame,
    dropSession(sessionId: string) {
      delete sessionViews[sessionId];
      delete latestFrames[sessionId];
    },
    focusCanvas() { els.canvas?.focus(); },
    getLastFrameModes(): TerminalModes | undefined { return lastFrame?.modes; },
    isLiveFollow() { return liveFollow; },
    setLiveFollow,
    isAutoScrolling() { return autoScrolling; },
  };
}

export type TerminalController = ReturnType<typeof createTerminalController>;
