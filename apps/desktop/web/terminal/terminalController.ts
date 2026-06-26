import { createTerminalGpuRenderer } from '../terminal-gpu-renderer';
import type { CrtParams } from '../terminalCrt';
import {
  SCROLL_FOLLOW_EPSILON_PX,
  cloneTerminalRow,
  frameForSurface,
  terminalInsetPx,
  type TerminalScrollMetrics,
  type TerminalSurface,
} from '../terminalScrollback';
import type { SessionTerminalView } from '../domain';
import type {
  TerminalCursor,
  TerminalFrame,
  TerminalModes,
  TerminalPaintCursorSample,
  TerminalOverlay,
  TerminalPaintReason,
  TerminalPaintSample,
  TerminalRenderer,
  TerminalRendererBackend,
  TerminalRow,
} from '../terminalTypes';
import {
  HISTORY_PREFETCH_ALIGN_ROWS,
  HISTORY_PREFETCH_LEAD_ROWS,
  OVERSCAN_ROWS,
  buildSessionTerminalView,
  computePaintWindow,
  emptyTerminalView,
} from './frameModel';
import {
  applyViewportFrameToBuffer,
  createTerminalBuffer,
  expandTerminalBufferRangeToCellBounds,
  frameFromBufferAbsoluteWindow,
  frameFromBufferWindow,
  mergeHistoryWindowIntoBuffer,
  selectAllTerminalBufferRange,
  terminalBufferCachedRangeForRows,
  terminalBufferHasRows,
  terminalBufferSelectionText,
  type TerminalBufferState,
} from './bufferModel';
import {
  expandRangeToCellBounds,
  selectAllRange,
  selectionText,
} from './interaction/selectionModel';
import { rowSpanInWindow, selectionWindowSpans } from './interaction/overlayPaint';
import { detectLinks } from './interaction/linkProvider';
import type { BufferCell, BufferLinkSpan, RowSpan, SelectionRange } from './interaction/types';
import { TERMINAL_THEME, type TerminalThemeColors } from '../themes/terminalTheme';
import {
  terminalCellHasVisiblePaint,
  terminalRowTextLayout,
  terminalTextRangeToCellSpan,
} from './cellGeometry';

// The terminal's default background is left transparent at the renderer so the
// CSS-painted panel behind the canvas shows through for default cells. That CSS
// background is `.terminal-canvas`'s own --terminal-bg (themes/terminalTheme.ts),
// the same token the surrounding shell paints, so the default background renders
// on one paint path. Painting it on the canvas instead exposed a WebGL/CSS
// color-management gap on wide-gamut displays: the GPU-composited canvas landed a
// hair darker than the identical CSS color around it, leaving a faint seam at the
// canvas edge. Cells with an explicit background, glyphs, the cursor, and the
// selection still paint on the canvas; only the default fill defers to CSS. The
// theme color is still handed to the renderer (for inverse/cursor glyphs) and to
// Ghostty's embedder defaults, so any CLI that queries its background sees the
// surface.
const TERMINAL_BACKGROUND_OPACITY = 0;
// Overscan rows when the CRT effect is on. A couple of rows (vs ~a full screen)
// keeps the painted canvas at ~the viewport so the screen-space barrel warp
// stays anchored to the viewport instead of sliding with a tall scrolled canvas.
const CRT_OVERSCAN_ROWS = 2;
const LIVE_TAIL_ALLOWED_TOP_GAP_ROWS = 2;
// Backend resize redraws can arrive as sparse full or partial frames for several
// animation frames, especially in the canvas fallback under resize churn. Keep
// the guard long enough to bridge that redraw window without letting a transient
// sparse frame clear stable rows.
const RESIZE_REFLOW_BLANK_FRAME_GUARD_MS = 1_500;

type CursorCoordinateSpace = 'buffer' | 'frame';

interface SessionCursorFallback {
  space: CursorCoordinateSpace;
  cursor: TerminalCursor;
}

export interface TerminalDomRefs {
  canvas: HTMLCanvasElement | null;
  viewport: HTMLDivElement | null;
  spacer: HTMLDivElement | null;
  input?: HTMLTextAreaElement | null;
}

export interface TerminalControllerOptions {
  surface: TerminalSurface;
  // React-state sync callbacks (the controller stays framework-agnostic).
  onScrollbackRowCount: (count: number) => void;
  onLiveFollow: (live: boolean) => void;
  // Fired after a new composite frame is applied + painted. The find feature
  // uses it to re-map match spans to the (possibly scrolled) viewport.
  onComposite?: () => void;
  // Fired (deduped) when the scroll position/extent changes, so the custom
  // overlay scrollbar can reflect it as the user scrolls back through the live
  // buffer.
  onScrollMetrics?: (metrics: TerminalScrollMetrics) => void;
  // Fired when live scroll lands on rows the frontend cache does not have yet.
  // The hook fetches that range from libghostty's live buffer and merges it.
  onMissingLiveRows?: (request: TerminalHistoryRowsRequest) => boolean | undefined;
  // Lightweight paint-loop instrumentation. The hook aggregates this into the
  // runtime metrics payload, so renderer tuning has real scroll/frame evidence.
  onPaintSample?: (sample: TerminalPaintSample) => void;
  // Structured debug trace for renderer lifecycle, resize, paint, and live
  // scroll-back windowing. Kept optional so tests and local diagnostics can
  // inspect churn without coupling production rendering to a visible debug
  // surface.
  onTrace?: (event: TimedTerminalControllerTraceEvent) => void;
  // Injectable for tests; defaults to the WebGL2 renderer with Canvas fallback.
  createRenderer?: (
    canvas: HTMLCanvasElement,
    surface: TerminalSurface,
    displayRows: number,
  ) => TerminalRenderer | Promise<TerminalRenderer>;
  // Initial CRT post-process params (null/omitted = flat). Live changes go
  // through the controller's setCrt; this just avoids a flat→warp flash when the
  // setting is already on at mount.
  crt?: CrtParams | null;
  // Fixed scroll inset (px) override. Production omits this and uses the themed
  // chrome inset (terminalInsetPx), which reserves room under the floating tab
  // band and above the bottom fade. Tests pin a known inset so the scroll/paint
  // geometry is asserted in the same non-degenerate regime production runs in
  // (real viewport height is far larger than the inset).
  insetPx?: { top: number; bottom: number };
}

export interface TerminalHistoryRowsRequest {
  startRow: number;
  rowCount: number;
  totalRows: number;
  generation: number;
}

export type TerminalControllerTraceEvent =
  | {
      kind: 'renderer_mount';
      phase: 'start' | 'sync' | 'async_resolved' | 'async_discarded' | 'async_failed';
      key: string;
      cols: number;
      requestedRows: number;
      rendererRows: number;
      cellWidth: number;
      cellHeight: number;
      devicePixelRatio: number;
      previousRenderer: boolean;
    }
  | {
      kind: 'renderer_dispose';
      reason: string;
      hadRenderer: boolean;
      pendingRenderer: boolean;
    }
  | {
      kind: 'surface_change';
      previous: TerminalSurface;
      next: TerminalSurface;
      columnsChanged: boolean;
      rowsChanged: boolean;
    }
  | {
      kind: 'paint';
      reason: TerminalPaintReason;
      backend?: TerminalRenderer['capabilities']['backend'];
      startRow: number;
      displayRows: number;
      fullPaint: boolean;
      bufferBacked: boolean;
      frameDirty?: TerminalFrame['dirty'];
      frameRows: number;
      rowsPainted: number;
      cellsPainted: number;
      cursor?: TerminalPaintCursorSample;
    }
  | {
      kind: 'history_rows_request';
      source: 'miss' | 'prefetch_after' | 'prefetch_before';
      startRow: number;
      rowCount: number;
      totalRows: number;
      generation: number;
    }
  | {
      kind: 'buffer_cache_miss';
      mode: 'live';
      startRow: number;
      rowCount: number;
      displayRows: number;
      totalRows: number;
      generation: number;
      cachedRange?: { start: number; end: number } | null;
    }
  | {
      // Diagnostic: what libghostty reports per frame (logged on change), to tell
      // whether scroll-back collapse is an alt-screen toggle, a shrinking
      // total_rows, or scrollback_rows being large while total_rows reads small.
      kind: 'frame_scrollback';
      alternateScreen: boolean;
      dirty: TerminalFrame['dirty'];
      totalRows: number | null;
      scrollbackRows: number | null;
      viewportRows: number | null;
      viewportOffset: number | null;
      atBottom: boolean | null;
    }
  | {
      kind: 'shape_stale_fallback_paint';
      startRow: number;
      sourceStartRow: number | null;
      rowCount: number;
      displayRows: number;
      totalRows: number;
      generation: number;
      cachedRange: { start: number; end: number } | null;
      requested: boolean;
    };

export type TimedTerminalControllerTraceEvent = TerminalControllerTraceEvent & {
  timestampMs: number;
  // Optional build marker, stamped by `trace` only when TERMINAL_TRACE_FRESH_PROBE
  // is set. Lets the diagnostics log prove a fresh WebView bundle is loaded.
  freshProbe?: string;
};

// Diagnostic flag, off by default. Set this to a unique per-build string to stamp
// every emitted trace event with that marker, so terminal-diagnostics.jsonl can
// prove the running WebView is the fresh bundle and not stale cached JS (the
// stale-bundle gotcha that masks whether a fix actually loaded). Flip it and
// rebuild only while chasing "is this stale JS?"; leave it null in normal use.
const TERMINAL_TRACE_FRESH_PROBE: string | null = null;

// The imperative terminal island: owns the renderer, the DOM elements,
// the live frame buffers, scroll/follow state, and the per-session view caches.
// Knows nothing about stores, services, sessions-as-domain, or React; it just
// paints. The hook (useTerminalSession) wires it to React + the stores and
// drives the session lifecycle.
export function createTerminalController(options: TerminalControllerOptions) {
  const {
    onScrollbackRowCount,
    onLiveFollow,
    onComposite,
    onScrollMetrics,
    onMissingLiveRows,
    onPaintSample,
    onTrace,
  } = options;
  // The active theme's terminal colors. Seeded to dark (the app boots dark); the
  // hook pushes the live theme via setThemeColors on mount and on every switch.
  let themeColors: TerminalThemeColors = TERMINAL_THEME.dark;
  // Active CRT post-process params (null = flat). Read by the renderer factory on
  // every (re)mount and reported to the interaction layer for pointer unwarp.
  let crtParams: CrtParams | null = options.crt ?? null;
  // Resolve the scroll inset for a surface: a fixed test override when provided,
  // otherwise the themed chrome inset. Single source so every paint/scroll/anchor
  // call site agrees within a frame.
  const insetOverride = options.insetPx ?? null;
  const insetFor = (forSurface: TerminalSurface) => insetOverride ?? terminalInsetPx(forSurface);
  const createRenderer =
    options.createRenderer ??
    ((canvas, surface, displayRows) =>
      createTerminalGpuRenderer(canvas, {
        ...surface,
        rows: displayRows,
        preferredBackends: defaultTerminalRendererBackends(),
        backgroundOpacity: TERMINAL_BACKGROUND_OPACITY,
        background: themeColors.background,
        foreground: themeColors.foreground,
        crt: crtParams,
      }));

  let els: TerminalDomRefs = { canvas: null, viewport: null, spacer: null };
  let surface: TerminalSurface = options.surface;
  let renderer: TerminalRenderer | null = null;
  let rendererCanvas: HTMLCanvasElement | null = null;
  let rendererContextLost = false;
  let rendererDevicePixelRatio = 1;
  let rendererMountGeneration = 0;
  let pendingRendererKey: string | null = null;
  let lastFrame: TerminalFrame | null = null;
  let lastComposite: TerminalFrame | null = null;
  let activeBuffer: TerminalBufferState | null = null;
  let needsFullPaint = true;
  let lastStartRow: number | null = null;
  let lastDisplayRows: number | null = null;
  let lastOverlayRows = new Set<number>();
  let lastPaintedCursorAbsoluteRow: number | null = null;
  let scheduledPaint: number | null = null;
  let scheduledPostRemountPaint: number | null = null;
  let lastBufferCacheMissTraceKey = '';
  let lastHistoryRowsRequestTraceKey = '';
  let lastFrameScrollbackTraceKey = '';
  let activeSessionId: string | null = null;
  // The session whose scroll position paintCurrent has already restored for the
  // current activation. Tracked separately from activeSessionId because a streamed
  // frame for the newly-selected session reaches ingestFrames (and sets
  // activeSessionId) before paintCurrent's activation rAF runs; keying the switch
  // off activeSessionId would then read "same session" and skip the restore.
  let scrollRestoredSessionId: string | null = null;
  let liveFollow = true;
  const sessionFollowIntents: Record<string, boolean> = {};
  // Per-session scrolled-back position, remembered across session switches (RAM
  // only; terminal history never persists across a restart). Keyed by session id,
  // the value is the STABLE ROW ID of the top visible row (oldestId + position),
  // not a pixel/position offset: stable ids survive eviction and background output
  // (the same id model the live-buffer fetch uses, decisions.md D8), so converting
  // the id back through the current oldestId on return re-anchors to the same
  // content even though rows shifted while the session was off-screen. A session at
  // the live tail has no entry here; its anchor is "the tail", encoded by
  // sessionFollowIntents being true (so scrollToTail re-pins to the newest output).
  const sessionScrollAnchors: Record<string, number> = {};
  let autoScrolling = false;
  // Interaction overlay state, all in buffer (composite-frame) coordinates so it
  // survives scrolling. The interaction controller drives these; paintWindow
  // translates them into window-local spans for the renderer.
  let selection: SelectionRange | null = null;
  let links: BufferLinkSpan[] = [];
  let hoverLink: BufferLinkSpan | null = null;
  // The backend-adopted per-session generation, synced from the frame stream via
  // `setLiveGeneration` (the hook calls it whenever it accepts/adopts a frame's
  // generation). The backend starts at 1 and bumps on every resize, re-seeding
  // with a Full frame; history-range requests are stamped with this value and a
  // band whose generation no longer matches is dropped, so a stale fetch can
  // never merge rows addressed against an old (pre-resize, renumbered) buffer.
  // This must be the backend's generation, not a frontend-only token, or the
  // serve gate never matches and every range request comes back empty.
  let liveGeneration = 0;
  const sessionGenerations: Record<string, number> = {};
  const sessionViews: Record<string, SessionTerminalView> = {};
  const latestFrames: Record<string, TerminalFrame> = {};
  const sessionBuffers: Record<string, TerminalBufferState> = {};
  const sessionCursorFallbacks: Record<string, SessionCursorFallback> = {};
  const resizeReflowPendingSessions: Record<string, boolean> = {};
  const resizeReflowGuardTimers: Record<string, number> = {};

  function trace(event: TerminalControllerTraceEvent) {
    const timed: TimedTerminalControllerTraceEvent = { ...event, timestampMs: nowMs() };
    if (TERMINAL_TRACE_FRESH_PROBE !== null) timed.freshProbe = TERMINAL_TRACE_FRESH_PROBE;
    onTrace?.(timed);
  }

  function rememberSessionCursor(
    sessionId: string,
    space: CursorCoordinateSpace,
    cursor: TerminalCursor | undefined,
  ) {
    const position = cursorPosition(cursor);
    if (!position) return;
    if (cursor?.visible === false) return;
    sessionCursorFallbacks[sessionId] = {
      space,
      cursor: visibleCursorAt(cursor, position.row, position.col),
    };
  }

  function rememberSessionFrameCursor(
    sessionId: string,
    space: CursorCoordinateSpace,
    frame: TerminalFrame,
  ) {
    if (terminalFrameSelfRenderedCursorPosition(frame)) {
      delete sessionCursorFallbacks[sessionId];
      return;
    }
    rememberSessionCursor(sessionId, space, frame.cursor);
  }

  function rememberSessionBufferCursor(sessionId: string, buffer: TerminalBufferState) {
    if (terminalBufferSelfRenderedCursorPosition(buffer)) {
      delete sessionCursorFallbacks[sessionId];
      return;
    }
    rememberSessionCursor(sessionId, 'buffer', buffer.cursor);
  }

  function rememberActiveViewCursor(view: SessionTerminalView, buffer: TerminalBufferState | null) {
    if (!activeSessionId) return;
    if (buffer) {
      rememberSessionBufferCursor(activeSessionId, buffer);
      return;
    }
    rememberSessionFrameCursor(activeSessionId, 'frame', view.compositeFrame);
  }

  function frameWithActiveCursorFallback(
    frame: TerminalFrame,
    startRow: number,
    displayRows: number,
    space: CursorCoordinateSpace,
  ) {
    if (!activeSessionId) return frameWithSelfRenderedCursorPreference(frame);
    if (terminalFrameSelfRenderedCursorPosition(frame)) {
      delete sessionCursorFallbacks[activeSessionId];
    }
    return frameWithSessionCursorFallback(
      frame,
      sessionCursorFallbacks[activeSessionId],
      startRow,
      displayRows,
      space,
    );
  }

  const handleRendererContextLost = (event: Event) => {
    event.preventDefault();
    rendererContextLost = true;
    disposeRenderer('context_lost');
    needsFullPaint = true;
    lastStartRow = null;
    lastDisplayRows = null;
  };

  const handleRendererContextRestored = () => {
    rendererContextLost = false;
    disposeRenderer('context_restored');
    needsFullPaint = true;
    lastStartRow = null;
    lastDisplayRows = null;
    paintWindow(lastComposite, surface, 'frame');
  };

  function attachRendererCanvas(canvas: HTMLCanvasElement | null) {
    if (rendererCanvas === canvas) return;
    rendererCanvas?.removeEventListener?.('webglcontextlost', handleRendererContextLost);
    rendererCanvas?.removeEventListener?.('webglcontextrestored', handleRendererContextRestored);
    disposeRenderer('canvas_change');
    rendererCanvas = canvas;
    rendererContextLost = false;
    rendererCanvas?.addEventListener?.('webglcontextlost', handleRendererContextLost);
    rendererCanvas?.addEventListener?.('webglcontextrestored', handleRendererContextRestored);
  }

  function focusElement(element: HTMLElement | null | undefined) {
    if (!element) return false;
    element.focus({ preventScroll: true });
    return true;
  }

  function updateInputPosition(
    windowFrame: TerminalFrame,
    startRow: number,
    forSurface: TerminalSurface,
    topInsetPx: number,
  ) {
    const input = els.input;
    if (!input) return;
    const cursor = windowFrame.cursor;
    const cursorRow = cursor?.position?.row ?? cursor?.row;
    const cursorCol = cursor?.position?.col ?? cursor?.col;
    const visible =
      cursor?.visible !== false && Number.isFinite(cursorRow) && Number.isFinite(cursorCol);
    const row = visible ? Math.max(0, cursorRow as number) : 0;
    const col = visible ? Math.max(0, Math.min(forSurface.cols - 1, cursorCol as number)) : 0;
    input.style.left = `${col * forSurface.cellWidth}px`;
    input.style.top = `${(startRow + row) * forSurface.cellHeight + topInsetPx}px`;
    input.style.width = `${forSurface.cellWidth}px`;
    input.style.height = `${forSurface.cellHeight}px`;
  }

  function currentDevicePixelRatio() {
    return typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  }

  function mountRenderer(
    forSurface: TerminalSurface = surface,
    requestedRows = forSurface.rows,
  ): TerminalRenderer | null {
    if (!els.canvas || rendererContextLost) return null;
    const previous = renderer;
    const canvas = els.canvas;
    const mountDevicePixelRatio = currentDevicePixelRatio();
    const rendererRows = Math.max(1, Math.ceil(requestedRows));
    const rendererSurface = forSurface;
    const key = rendererMountKey(rendererSurface, rendererRows, mountDevicePixelRatio);
    if (pendingRendererKey === key) return null;
    trace({
      kind: 'renderer_mount',
      phase: 'start',
      key,
      cols: rendererSurface.cols,
      requestedRows,
      rendererRows,
      cellWidth: rendererSurface.cellWidth,
      cellHeight: rendererSurface.cellHeight,
      devicePixelRatio: mountDevicePixelRatio,
      previousRenderer: previous !== null,
    });
    if (previous) {
      trace({
        kind: 'renderer_dispose',
        reason: 'remount_before_create',
        hadRenderer: true,
        pendingRenderer: false,
      });
      previous.dispose?.();
      renderer = null;
      rendererDevicePixelRatio = 1;
    }
    const created = createRenderer(canvas, rendererSurface, rendererRows);
    if (isPromiseLike(created)) {
      const generation = rendererMountGeneration + 1;
      rendererMountGeneration = generation;
      pendingRendererKey = key;
      created
        .then(next => {
          if (
            rendererMountGeneration !== generation ||
            rendererContextLost ||
            els.canvas !== canvas ||
            pendingRendererKey !== key ||
            currentDevicePixelRatio() !== mountDevicePixelRatio
          ) {
            trace({
              kind: 'renderer_mount',
              phase: 'async_discarded',
              key,
              cols: rendererSurface.cols,
              requestedRows,
              rendererRows,
              cellWidth: rendererSurface.cellWidth,
              cellHeight: rendererSurface.cellHeight,
              devicePixelRatio: mountDevicePixelRatio,
              previousRenderer: previous !== null,
            });
            next.dispose?.();
            if (rendererMountGeneration === generation && pendingRendererKey === key) {
              pendingRendererKey = null;
            }
            return;
          }
          pendingRendererKey = null;
          if (renderer && renderer !== next) {
            trace({
              kind: 'renderer_dispose',
              reason: 'async_resolved_replace',
              hadRenderer: true,
              pendingRenderer: false,
            });
            renderer.dispose?.();
          }
          renderer = next;
          rendererDevicePixelRatio = currentDevicePixelRatio();
          trace({
            kind: 'renderer_mount',
            phase: 'async_resolved',
            key,
            cols: rendererSurface.cols,
            requestedRows,
            rendererRows,
            cellWidth: rendererSurface.cellWidth,
            cellHeight: rendererSurface.cellHeight,
            devicePixelRatio: rendererDevicePixelRatio,
            previousRenderer: previous !== null,
          });
          needsFullPaint = true;
          paintWindow(lastComposite, surface, 'frame');
        })
        .catch(() => {
          if (rendererMountGeneration === generation && pendingRendererKey === key) {
            pendingRendererKey = null;
          }
          trace({
            kind: 'renderer_mount',
            phase: 'async_failed',
            key,
            cols: rendererSurface.cols,
            requestedRows,
            rendererRows,
            cellWidth: rendererSurface.cellWidth,
            cellHeight: rendererSurface.cellHeight,
            devicePixelRatio: mountDevicePixelRatio,
            previousRenderer: previous !== null,
          });
        });
      return null;
    }

    rendererMountGeneration += 1;
    pendingRendererKey = null;
    const next = created;
    renderer = next;
    rendererDevicePixelRatio = currentDevicePixelRatio();
    trace({
      kind: 'renderer_mount',
      phase: 'sync',
      key,
      cols: rendererSurface.cols,
      requestedRows,
      rendererRows,
      cellWidth: rendererSurface.cellWidth,
      cellHeight: rendererSurface.cellHeight,
      devicePixelRatio: rendererDevicePixelRatio,
      previousRenderer: previous !== null,
    });
    if (previous) {
      schedulePostRemountPaint();
    }
    return next;
  }

  function disposeRenderer(reason = 'explicit') {
    if (scheduledPostRemountPaint !== null) {
      if (typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(scheduledPostRemountPaint);
      }
      scheduledPostRemountPaint = null;
    }
    trace({
      kind: 'renderer_dispose',
      reason,
      hadRenderer: renderer !== null,
      pendingRenderer: pendingRendererKey !== null,
    });
    rendererMountGeneration += 1;
    pendingRendererKey = null;
    renderer?.dispose?.();
    renderer = null;
    rendererDevicePixelRatio = 1;
  }

  function invalidatePendingRendererMount() {
    if (!pendingRendererKey) return;
    rendererMountGeneration += 1;
    pendingRendererKey = null;
  }

  function ensureRenderer(
    forSurface: TerminalSurface,
    displayRows: number,
  ): TerminalRenderer | null {
    if (
      !renderer ||
      renderer.cols !== forSurface.cols ||
      renderer.rows < displayRows ||
      renderer.cellWidth !== forSurface.cellWidth ||
      renderer.cellHeight !== forSurface.cellHeight ||
      rendererDevicePixelRatio !== currentDevicePixelRatio()
    ) {
      needsFullPaint = true;
      return mountRenderer(forSurface, displayRows);
    }
    return renderer;
  }

  function updateSpacer(totalRows: number, forSurface: TerminalSurface) {
    const spacer = els.spacer;
    if (!spacer) return;
    const inset = insetFor(forSurface);
    const contentHeight = Math.max(totalRows, forSurface.rows) * forSurface.cellHeight;
    spacer.style.height = `${contentHeight + inset.top + inset.bottom}px`;
    spacer.style.width = `${forSurface.cols * forSurface.cellWidth}px`;
  }

  function bufferedViewportScrollMetrics(
    buffer: TerminalBufferState,
    forSurface: TerminalSurface,
    mode: TerminalScrollMetrics['mode'],
  ): TerminalScrollMetrics {
    const viewport = els.viewport;
    const cellHeight = forSurface.cellHeight;
    const inset = insetFor(forSurface);
    const totalRows = Math.max(buffer.totalRows, forSurface.rows);
    const viewPx = Math.max(cellHeight, viewport?.clientHeight ?? forSurface.rows * cellHeight);
    const totalPx = Math.max(
      viewPx,
      viewport?.scrollHeight ?? totalRows * cellHeight + inset.top + inset.bottom,
    );
    const top = viewport?.scrollTop ?? 0;
    const viewportRows = Math.max(1, Math.min(totalRows, Math.ceil(viewPx / cellHeight)));
    const offsetRows = Math.max(
      0,
      Math.min(Math.max(0, totalRows - viewportRows), Math.floor((top - inset.top) / cellHeight)),
    );
    const scrollable = totalPx > viewPx + 1 && totalRows > viewportRows;

    return {
      mode,
      scrollable,
      atBottom: top + viewPx >= totalPx - SCROLL_FOLLOW_EPSILON_PX,
      totalRows,
      viewportRows,
      offsetRows,
      thumbFraction: scrollable ? Math.min(1, viewPx / totalPx) : 1,
      startFraction: totalPx > 0 ? Math.min(1, top / totalPx) : 0,
    };
  }

  function recomputeBufferedLinks(
    buffer: TerminalBufferState,
    startRow: number,
    displayRows: number,
  ) {
    const next: BufferLinkSpan[] = [];
    const endRow = Math.min(buffer.totalRows, startRow + displayRows);
    for (let rowId = startRow; rowId < endRow; rowId += 1) {
      if (!buffer.rowsById.has(rowId)) continue;
      const layout = terminalRowTextLayout(buffer.rowsById.get(rowId), buffer.cols);
      for (const link of detectLinks(layout.text)) {
        const span = terminalTextRangeToCellSpan(layout, link.start, link.end);
        next.push({ row: rowId, startCol: span.startCol, endCol: span.endCol, href: link.href });
      }
    }
    links = next;
  }

  function bufferPaintWindow(
    buffer: TerminalBufferState,
    forSurface: TerminalSurface = surface,
    reason: TerminalPaintReason = 'frame',
    dirtyAbsoluteRows?: ReadonlySet<number>,
  ) {
    const viewport = els.viewport;
    const viewportHeight = Math.max(
      forSurface.cellHeight,
      viewport?.clientHeight ?? forSurface.rows * forSurface.cellHeight,
    );
    const scrollTop = viewport?.scrollTop ?? 0;
    const inset = insetFor(forSurface);
    // Overscan ~one viewport above and below the visible area (not a fixed handful
    // of rows), so a fast scroll paints into already-warm rows instead of flashing
    // placeholders before the next frame catches up. The painted window is the
    // visible rows plus an overscan screen on each side (~3 screens total), which
    // the GPU renderer handles comfortably and which keeps scroll-back smooth.
    //
    // The CRT post-process is a SCREEN-space warp, so the painted canvas must be
    // ~the viewport (not 3 screens) or the barrel bulge centers on the tall
    // canvas and slides as you scroll. With CRT on we drop to a couple of
    // overscan rows so the canvas tracks the viewport and the warp stays
    // anchored; scroll re-windows + repaints each frame instead of riding a tall
    // CSS-scrolled canvas.
    const visibleRowsForWindow = Math.ceil(viewportHeight / forSurface.cellHeight);
    const overscanRows = crtParams
      ? CRT_OVERSCAN_ROWS
      : Math.max(OVERSCAN_ROWS, visibleRowsForWindow);
    const targetDisplayRows = Math.max(
      forSurface.rows,
      visibleRowsForWindow + overscanRows * 2,
      renderer?.rows ?? 0,
    );
    let displayRows = Math.max(1, targetDisplayRows);
    const maxStartRow = Math.max(0, buffer.totalRows - displayRows);
    let startRow = Math.min(
      maxStartRow,
      Math.max(0, Math.floor((scrollTop - inset.top) / forSurface.cellHeight) - overscanRows),
    );
    const visibleStart = Math.max(
      0,
      Math.min(
        Math.max(0, buffer.totalRows - 1),
        Math.floor((scrollTop - inset.top) / forSurface.cellHeight),
      ),
    );
    const visibleHeight = Math.max(
      forSurface.cellHeight,
      viewportHeight - inset.top - inset.bottom,
    );
    const visibleRows = Math.max(
      1,
      Math.min(
        Math.max(1, buffer.totalRows - visibleStart),
        Math.ceil(visibleHeight / forSurface.cellHeight),
      ),
    );
    const cacheStatus = requestLiveRowsForPaintWindow(
      buffer,
      startRow,
      displayRows,
      forSurface,
      visibleStart,
      visibleRows,
    );
    if (!cacheStatus.cached) {
      if (cacheStatus.shapeStale) {
        const fallbackDisplayRows = Math.max(1, displayRows);
        const canPaintPartialLiveTail = (liveFollow || buffer.atBottom) && buffer.rowsById.size > 0;
        if (canPaintPartialLiveTail) {
          const tailWindow =
            cachedLiveTailPaintWindow(
              buffer,
              visibleStart,
              visibleRows,
              fallbackDisplayRows,
              true,
            ) ?? cursorLiveTailPaintWindow(buffer, visibleStart, visibleRows, fallbackDisplayRows);
          if (!tailWindow) {
            emitScrollMetrics(forSurface);
            return;
          }
          trace({
            kind: 'shape_stale_fallback_paint',
            startRow,
            sourceStartRow: tailWindow.startRow,
            rowCount: tailWindow.displayRows,
            displayRows: tailWindow.displayRows,
            totalRows: buffer.totalRows,
            generation: liveGeneration,
            cachedRange: cacheStatus.cachedRange,
            requested: cacheStatus.requested,
          });
          const windowFrame = frameWithActiveCursorFallback(
            frameFromBufferWindow(buffer, tailWindow.startRow, tailWindow.displayRows),
            tailWindow.startRow,
            tailWindow.displayRows,
            'buffer',
          );
          const activeRenderer = ensureRenderer(forSurface, tailWindow.displayRows);
          if (!activeRenderer) {
            emitScrollMetrics(forSurface);
            return;
          }
          const fallbackInset = positionCanvasForStartRow(tailWindow.startRow, forSurface);
          updateInputPosition(windowFrame, tailWindow.startRow, forSurface, fallbackInset.top);
          recomputeBufferedLinks(buffer, tailWindow.startRow, tailWindow.displayRows);
          paintFrameWithMetrics({
            renderer: activeRenderer,
            frame: windowFrame,
            forSurface,
            startRow: tailWindow.startRow,
            displayRows: tailWindow.displayRows,
            forceFullPaint: true,
            bufferBacked: true,
            reason,
          });
          lastStartRow = tailWindow.startRow;
          lastDisplayRows = tailWindow.displayRows;
          emitScrollMetrics(forSurface);
          return;
        }
        const fallbackWindow = cacheStatus.cachedRange
          ? { startRow, displayRows: fallbackDisplayRows }
          : cachedPaintWindowForMissingRows(buffer, startRow, fallbackDisplayRows);
        if (!fallbackWindow) {
          positionCanvasForStartRow(startRow, forSurface);
          trace({
            kind: 'shape_stale_fallback_paint',
            startRow,
            sourceStartRow: null,
            rowCount: 0,
            displayRows: fallbackDisplayRows,
            totalRows: buffer.totalRows,
            generation: liveGeneration,
            cachedRange: null,
            requested: cacheStatus.requested,
          });
          emitScrollMetrics(forSurface);
          return;
        }
        const sourceStartRow = Math.max(
          0,
          Math.min(fallbackWindow.startRow, buffer.totalRows - fallbackDisplayRows),
        );
        trace({
          kind: 'shape_stale_fallback_paint',
          startRow,
          sourceStartRow,
          rowCount: Math.max(1, Math.min(buffer.totalRows - sourceStartRow, fallbackDisplayRows)),
          displayRows: fallbackDisplayRows,
          totalRows: buffer.totalRows,
          generation: liveGeneration,
          cachedRange: cacheStatus.cachedRange,
          requested: cacheStatus.requested,
        });
        const windowFrame = frameWithActiveCursorFallback(
          frameFromBufferWindow(buffer, sourceStartRow, fallbackDisplayRows),
          sourceStartRow,
          fallbackDisplayRows,
          'buffer',
        );
        if (
          liveFollow &&
          terminalBufferHasRenderableRows(buffer) &&
          !terminalFrameHasRenderableCells(windowFrame) &&
          !terminalFrameHasVisibleCursor(windowFrame)
        ) {
          emitScrollMetrics(forSurface);
          return;
        }
        const activeRenderer = ensureRenderer(forSurface, fallbackDisplayRows);
        if (!activeRenderer) {
          emitScrollMetrics(forSurface);
          return;
        }
        const fallbackInset = positionCanvasForStartRow(startRow, forSurface);
        updateInputPosition(windowFrame, startRow, forSurface, fallbackInset.top);
        recomputeBufferedLinks(buffer, sourceStartRow, fallbackDisplayRows);
        paintFrameWithMetrics({
          renderer: activeRenderer,
          frame: windowFrame,
          forSurface,
          startRow,
          displayRows: fallbackDisplayRows,
          forceFullPaint: true,
          bufferBacked: true,
          reason,
        });
        lastStartRow = startRow;
        lastDisplayRows = fallbackDisplayRows;
        emitScrollMetrics(forSurface);
        return;
      } else {
        const canPaintPartialLiveTail = (liveFollow || buffer.atBottom) && buffer.rowsById.size > 0;
        if (cacheStatus.requested && liveFollow && canPaintPartialLiveTail) {
          const tailWindow =
            cachedLiveTailPaintWindow(
              buffer,
              visibleStart,
              visibleRows,
              displayRows,
              renderer !== null,
            ) ?? cursorLiveTailPaintWindow(buffer, visibleStart, visibleRows, displayRows);
          if (!tailWindow) {
            emitScrollMetrics(forSurface);
            return;
          }
          startRow = tailWindow.startRow;
          displayRows = tailWindow.displayRows;
        }
        // Scrolled back into an uncached region: fall through and paint the window
        // in place now, with blank placeholder rows where the mirror is still empty,
        // rather than freezing on the last paint until the prefetch band lands. The
        // async band repaints these rows when it arrives. Rows that must not show as
        // content (stale width after a resize) are dropped from the mirror up front,
        // so a blank here always means "fetching", never "wrong width".
        // (research: never block the gesture; show placeholders and fill async.)
      }
    }

    const windowFrame = frameWithActiveCursorFallback(
      frameFromBufferWindow(buffer, startRow, displayRows),
      startRow,
      displayRows,
      'buffer',
    );
    // A scrolled-back miss paints blank placeholder rows (per the fall-through
    // above) so the gesture keeps moving while the band loads. Only suppress the
    // paint while following the live tail, where a blank flash during output churn
    // reads worse than holding the last frame for a beat.
    if (
      !cacheStatus.cached &&
      liveFollow &&
      terminalBufferHasRenderableRows(buffer) &&
      !terminalFrameHasRenderableCells(windowFrame) &&
      !terminalFrameHasVisibleCursor(windowFrame)
    ) {
      emitScrollMetrics(forSurface);
      return;
    }
    const forceFullPaint = needsFullPaint || lastStartRow !== startRow;
    const activeRenderer = ensureRenderer(forSurface, displayRows);
    const selfContainedPaint = terminalRendererRequiresSelfContainedPaint(activeRenderer);
    const canPaintDirtyRows =
      dirtyAbsoluteRows !== undefined &&
      !needsFullPaint &&
      lastStartRow === startRow &&
      !selfContainedPaint;
    const frameToPaint = canPaintDirtyRows
      ? frameWithDirtyLocalRows(
          windowFrame,
          dirtyRowsInWindow(dirtyAbsoluteRows, startRow),
          cursorLocalRowInWindow(lastPaintedCursorAbsoluteRow, startRow, displayRows),
        )
      : windowFrame;
    if (els.canvas) {
      els.canvas.style.top = `${startRow * forSurface.cellHeight + inset.top}px`;
      els.canvas.style.transform = 'none';
    }
    updateInputPosition(windowFrame, startRow, forSurface, inset.top);
    recomputeBufferedLinks(buffer, startRow, displayRows);
    paintFrameWithMetrics({
      renderer: activeRenderer,
      frame: frameToPaint,
      forSurface,
      startRow,
      displayRows,
      forceFullPaint: selfContainedPaint ? true : canPaintDirtyRows ? false : forceFullPaint,
      bufferBacked: true,
      reason,
    });
    needsFullPaint = false;
    lastStartRow = startRow;
    lastDisplayRows = displayRows;
    emitScrollMetrics(forSurface);
  }

  function positionCanvasForStartRow(startRow: number, forSurface: TerminalSurface) {
    const inset = insetFor(forSurface);
    if (els.canvas) {
      els.canvas.style.top = `${startRow * forSurface.cellHeight + inset.top}px`;
      els.canvas.style.transform = 'none';
    }
    return inset;
  }

  // The aligned band of history rows to keep resident around the paint window.
  // Scrolled back, it reaches HISTORY_PREFETCH_LEAD_ROWS above the window (the
  // scroll-up direction) so one round-trip warms several screens of history and
  // the view hits cache instead of stalling per screen; bounds snap to
  // HISTORY_PREFETCH_ALIGN_ROWS so the request key stays stable across small
  // scrolls and dedupes. At the live tail (no lead) it is just the paint window,
  // so following output never pulls history (decisions.md D6/D7).
  function historyPrefetchBand(
    buffer: TerminalBufferState,
    startRow: number,
    rowCount: number,
    withLead: boolean,
  ): { startRow: number; rowCount: number } {
    if (!withLead) return { startRow, rowCount };
    const align = Math.max(1, HISTORY_PREFETCH_ALIGN_ROWS);
    const desiredStart = Math.max(0, startRow - HISTORY_PREFETCH_LEAD_ROWS);
    // Lead both directions: above (the scroll-up direction) and below the window,
    // so reversing scroll direction also lands on warm cache. One round-trip warms
    // several screens; the serve is bounded by MAX_READ_ROWS.
    const desiredEnd = Math.min(buffer.totalRows, startRow + rowCount + HISTORY_PREFETCH_LEAD_ROWS);
    const bandStart = Math.floor(desiredStart / align) * align;
    const bandEnd = Math.min(
      buffer.totalRows,
      Math.max(bandStart + align, Math.ceil(desiredEnd / align) * align),
    );
    return { startRow: bandStart, rowCount: Math.max(1, bandEnd - bandStart) };
  }

  function requestLiveRowsForPaintWindow(
    buffer: TerminalBufferState,
    startRow: number,
    displayRows: number,
    forSurface: TerminalSurface,
    visibleStartRow: number,
    visibleRowCount: number,
  ) {
    const requestedStart = Math.max(0, Math.floor(startRow));
    const requestedEnd = Math.min(
      buffer.totalRows,
      requestedStart + Math.max(1, Math.floor(displayRows)),
    );
    let requiredStart = requestedStart;
    let requiredEnd = requestedEnd;
    if (liveFollow) {
      const liveStart = Math.max(0, Math.floor(buffer.viewportOffset));
      const liveEnd = Math.min(buffer.totalRows, liveStart + Math.max(1, buffer.viewportRows));
      const overlapStart = Math.max(requestedStart, liveStart);
      const overlapEnd = Math.min(requestedEnd, liveEnd);
      const leadGapRows = liveStart - requestedStart;
      if (
        overlapEnd > overlapStart &&
        (requestedStart >= liveStart || leadGapRows <= LIVE_TAIL_ALLOWED_TOP_GAP_ROWS)
      ) {
        requiredStart = overlapStart;
        requiredEnd = overlapEnd;
      }
    }
    const rowCount = Math.max(1, requiredEnd - requiredStart);
    const cachedRange = terminalBufferCachedRangeForRows(buffer, requiredStart, rowCount);
    const shapeStale = buffer.cols !== forSurface.cols;
    const visibleRequiredRows = Math.max(
      1,
      Math.min(buffer.totalRows - visibleStartRow, visibleRowCount),
    );
    const detachedLiveVisibleRowsCached =
      !liveFollow && terminalBufferHasRows(buffer, visibleStartRow, visibleRequiredRows);
    if ((!cachedRange || shapeStale) && detachedLiveVisibleRowsCached) {
      lastBufferCacheMissTraceKey = '';
      lastHistoryRowsRequestTraceKey = '';
      return {
        cached: true,
        requested: false,
        shapeStale: false,
        cachedRange: terminalBufferCachedRangeForRows(buffer, visibleStartRow, visibleRequiredRows),
      };
    }
    if (shapeStale) {
      // The backend owns reflow after a column change. Keep painting from the
      // stale-width cache until the resize-seeded Full frame arrives instead of
      // asking libghostty for rows at the old shape and generation.
      lastBufferCacheMissTraceKey = '';
      lastHistoryRowsRequestTraceKey = '';
      return { cached: false, requested: false, shapeStale, cachedRange };
    }
    if (!cachedRange) {
      // Pull a big aligned band (paint window + lead above), not just the window,
      // so one round-trip warms the next stretch of scroll-up instead of stalling
      // per screen. The band reduces to the paint window at the live tail.
      const band = historyPrefetchBand(buffer, requiredStart, rowCount, !liveFollow);
      // Fetch only if the band is not already covered by trusted provenance. Raw
      // row-map presence is not enough: blank rows from an old live viewport may
      // still be present in the mirror after drifting into scrollback, but they
      // are deliberately untrusted until a history band confirms them. Fetched
      // blank rows are safe because fetched bands add settled coverage, and blank
      // rows in the current live viewport are safe because coverageRanges unions
      // the live viewport.
      const needsFetch = !terminalBufferHasRows(buffer, band.startRow, band.rowCount);
      let requested = false;
      if (needsFetch) {
        const request = {
          startRow: band.startRow,
          rowCount: band.rowCount,
          totalRows: buffer.totalRows,
          generation: liveGeneration,
        };
        const missTraceKey = `live:${liveGeneration}:${band.startRow}:${band.rowCount}:${buffer.totalRows}:${displayRows}`;
        if (missTraceKey !== lastBufferCacheMissTraceKey) {
          lastBufferCacheMissTraceKey = missTraceKey;
          trace({
            kind: 'buffer_cache_miss',
            mode: 'live',
            startRow: band.startRow,
            rowCount: band.rowCount,
            displayRows,
            totalRows: buffer.totalRows,
            generation: liveGeneration,
            cachedRange,
          });
        }
        requested = requestMissingLiveRows(buffer, request);
        if (requested) {
          const requestTraceKey = `miss:${liveGeneration}:${band.startRow}:${band.rowCount}:${buffer.totalRows}`;
          if (requestTraceKey !== lastHistoryRowsRequestTraceKey) {
            lastHistoryRowsRequestTraceKey = requestTraceKey;
            trace({
              kind: 'history_rows_request',
              source: 'miss',
              startRow: band.startRow,
              rowCount: band.rowCount,
              totalRows: buffer.totalRows,
              generation: liveGeneration,
            });
          }
        }
      } else {
        lastBufferCacheMissTraceKey = '';
        lastHistoryRowsRequestTraceKey = '';
      }
      return { cached: false, requested, shapeStale, cachedRange };
    }

    lastBufferCacheMissTraceKey = '';
    lastHistoryRowsRequestTraceKey = '';
    return { cached: true, requested: false, shapeStale: false, cachedRange };
  }

  function requestMissingLiveRows(
    buffer: TerminalBufferState,
    request: TerminalHistoryRowsRequest,
  ) {
    if (!onMissingLiveRows) return false;
    if (buffer.rowsById.size === 0) return false;
    return onMissingLiveRows(request) !== false;
  }

  function paintWindow(
    frame: TerminalFrame | null = lastComposite,
    forSurface: TerminalSurface = surface,
    reason: TerminalPaintReason = 'frame',
    dirtyAbsoluteRows?: ReadonlySet<number>,
  ) {
    if (!frame) return;
    // A renderer requires a mounted canvas. When the terminal surface is
    // unmounted (the displayed session switched to a non-terminal view like a
    // dashboard, so AppLayout dropped <TerminalSurface>), there is nothing to
    // paint into and no visible window to prefetch history for. Skip rather than
    // compute a degenerate window (a null viewport reads scrollTop 0, pinning the
    // window to row 0) whose every miss would fire a history-row fetch for an
    // off-screen session: the perpetual buffer_cache_miss storm seen in the
    // diagnostics. The per-session buffer is still kept current by ingestFrames;
    // the next paint after the surface remounts repaints from it.
    if (!els.canvas) return;
    if (activeBuffer && frame === lastComposite) {
      bufferPaintWindow(activeBuffer, forSurface, reason, dirtyAbsoluteRows);
      return;
    }
    const viewport = els.viewport;
    const viewportHeight = Math.max(
      forSurface.cellHeight,
      viewport?.clientHeight ?? forSurface.rows * forSurface.cellHeight,
    );
    const scrollTop = viewport?.scrollTop ?? 0;
    const inset = insetFor(forSurface);

    let paintWindow = computePaintWindow({
      frame,
      surface: forSurface,
      scrollTop,
      viewportHeight,
      needsFullPaint,
      lastStartRow,
      topInsetPx: inset.top,
    });
    let { startRow, displayRows, forceFullPaint, windowFrame } = paintWindow;
    const activeRenderer = ensureRenderer(forSurface, displayRows);
    const selfContainedPaint = terminalRendererRequiresSelfContainedPaint(activeRenderer);
    if (selfContainedPaint && !forceFullPaint) {
      paintWindow = computePaintWindow({
        frame,
        surface: forSurface,
        scrollTop,
        viewportHeight,
        needsFullPaint: true,
        lastStartRow: null,
        topInsetPx: inset.top,
      });
      ({ startRow, displayRows, forceFullPaint, windowFrame } = paintWindow);
    }
    windowFrame = frameWithActiveCursorFallback(windowFrame, startRow, displayRows, 'frame');
    const canPaintDirtyRows =
      dirtyAbsoluteRows !== undefined &&
      !needsFullPaint &&
      lastStartRow === startRow &&
      !selfContainedPaint;
    const frameToPaint = canPaintDirtyRows
      ? frameWithDirtyLocalRows(
          windowFrame,
          dirtyRowsInWindow(dirtyAbsoluteRows, startRow),
          cursorLocalRowInWindow(lastPaintedCursorAbsoluteRow, startRow, displayRows),
        )
      : windowFrame;

    if (els.canvas) {
      // The canvas sits below the top inset (the injected blank scroll space), so
      // the first content row never butts against the top edge.
      els.canvas.style.top = `${startRow * forSurface.cellHeight + inset.top}px`;
      els.canvas.style.transform = 'none';
    }
    updateInputPosition(windowFrame, startRow, forSurface, inset.top);
    paintFrameWithMetrics({
      renderer: activeRenderer,
      frame: frameToPaint,
      forSurface,
      startRow,
      displayRows,
      forceFullPaint: selfContainedPaint ? true : canPaintDirtyRows ? false : forceFullPaint,
      bufferBacked: false,
      reason,
    });
    needsFullPaint = false;
    lastStartRow = startRow;
    lastDisplayRows = displayRows;
    emitScrollMetrics(forSurface);
  }

  function paintFrameWithMetrics(args: {
    renderer: TerminalRenderer | null;
    frame: TerminalFrame;
    forSurface: TerminalSurface;
    startRow: number;
    displayRows: number;
    forceFullPaint: boolean;
    bufferBacked: boolean;
    reason: TerminalPaintReason;
  }) {
    const {
      renderer,
      frame,
      forSurface,
      startRow,
      displayRows,
      forceFullPaint,
      bufferBacked,
      reason,
    } = args;
    if (!renderer) return;

    const hasRendererStats = typeof renderer.takeStats === 'function';
    const fallbackRows = hasRendererStats ? null : renderer.rowsToPaint(frame);
    const fallbackCells = fallbackRows?.reduce((sum, row) => sum + row.cells.length, 0) ?? 0;
    const overlay = buildOverlay(startRow, displayRows, forSurface);
    lastOverlayRows = overlayAbsoluteRowsInWindow(startRow, displayRows);
    renderer.takeStats?.();
    const started = nowMs();
    // Full windows carry an explicit background row for every painted line, so
    // painting directly avoids a transient blank canvas during live updates.
    renderer.paintFrame(frame, overlay);
    const elapsedMs = Math.max(0, nowMs() - started);
    const rendererStats = renderer.takeStats?.();
    const cursor = cursorPaintSample(frame);
    lastPaintedCursorAbsoluteRow =
      cursor.visible && cursor.row !== null ? startRow + cursor.row : null;

    onPaintSample?.({
      backend: renderer.capabilities.backend,
      reason,
      elapsedMs,
      startRow,
      displayRows,
      fullPaint: forceFullPaint,
      bufferBacked,
      rowsPainted: rendererStats?.rowsPainted ?? fallbackRows?.length ?? 0,
      cellsPainted: rendererStats?.cellsPainted ?? fallbackCells,
      cursor,
      rendererStats,
    });
    trace({
      kind: 'paint',
      backend: renderer.capabilities.backend,
      reason,
      startRow,
      displayRows,
      fullPaint: forceFullPaint,
      bufferBacked,
      frameDirty: frame.dirty,
      frameRows: frame.rows.length,
      rowsPainted: rendererStats?.rowsPainted ?? fallbackRows?.length ?? 0,
      cellsPainted: rendererStats?.cellsPainted ?? fallbackCells,
      cursor,
    });
  }

  function schedulePaintWindow(reason: TerminalPaintReason = 'scroll') {
    if (scheduledPaint !== null) return;
    scheduledPaint = requestAnimationFrame(() => {
      scheduledPaint = null;
      paintWindow(lastComposite, surface, reason);
    });
  }

  function schedulePostRemountPaint() {
    if (scheduledPostRemountPaint !== null) return;
    scheduledPostRemountPaint = requestAnimationFrame(() => {
      scheduledPostRemountPaint = null;
      needsFullPaint = true;
      paintWindow(lastComposite, surface, 'frame');
    });
  }

  // Compute + publish (deduped) the scroll position/extent for the overlay
  // scrollbar. When the user has scrolled back off the live tail we read the
  // buffer's cached extent; while following live we read the backend's
  // scrollback metadata, since live wheel scrolling is backend-virtual and never
  // moves the DOM.
  let lastScrollMetricsKey = '';
  function emitScrollMetrics(forSurface: TerminalSurface) {
    if (!onScrollMetrics) return;
    const viewport = els.viewport;
    let metrics: TerminalScrollMetrics;
    if (activeBuffer && viewport && !liveFollow) {
      metrics = bufferedViewportScrollMetrics(activeBuffer, forSurface, 'live');
    } else {
      const sb = lastComposite?.scrollback;
      const scrollbackRows = sb?.scrollbackRows ?? 0;
      const viewportRows = forSurface.rows;
      const totalRows = sb?.totalRows ?? scrollbackRows + viewportRows;
      const offsetRows = sb?.viewportOffset ?? scrollbackRows;
      const scrollable = scrollbackRows > 0 && totalRows > viewportRows;
      metrics = {
        mode: 'live',
        scrollable,
        atBottom: sb?.atBottom ?? true,
        totalRows,
        viewportRows,
        offsetRows,
        thumbFraction: totalRows > 0 ? Math.min(1, viewportRows / totalRows) : 1,
        startFraction: totalRows > 0 ? Math.min(1, offsetRows / totalRows) : 0,
      };
    }
    const key = `${metrics.mode}|${metrics.scrollable}|${metrics.atBottom}|${metrics.totalRows}|${metrics.viewportRows}|${metrics.offsetRows}`;
    if (key === lastScrollMetricsKey) return;
    lastScrollMetricsKey = key;
    onScrollMetrics(metrics);
  }

  // Translate the buffer-coordinate interaction state into the window-local
  // overlay the renderer draws. Returns undefined when there is nothing to draw
  // so the renderer can skip the overlay pass entirely.
  function buildOverlay(
    startRow: number,
    displayRows: number,
    forSurface: TerminalSurface,
  ): TerminalOverlay | undefined {
    const selectionSpans = selectionWindowSpans(selection, startRow, displayRows, forSurface.cols);
    const linkSpans: RowSpan[] = [];
    for (const link of links) {
      const span = rowSpanInWindow(
        link.row,
        link.startCol,
        link.endCol,
        startRow,
        displayRows,
        forSurface.cols,
      );
      if (span) linkSpans.push(span);
    }
    const hoverSpan = hoverLink
      ? rowSpanInWindow(
          hoverLink.row,
          hoverLink.startCol,
          hoverLink.endCol,
          startRow,
          displayRows,
          forSurface.cols,
        )
      : null;

    if (selectionSpans.length === 0 && linkSpans.length === 0 && !hoverSpan) {
      return undefined;
    }
    return {
      selection: selectionSpans.length > 0 ? selectionSpans : undefined,
      links: linkSpans.length > 0 ? linkSpans : undefined,
      hoverLink: hoverSpan ?? undefined,
    };
  }

  function overlayAbsoluteRowsInWindow(startRow: number, displayRows: number) {
    const rows = new Set<number>();
    const endRow = startRow + displayRows;

    if (selection) {
      const first = Math.max(selection.start.row, startRow);
      const last = Math.min(selection.end.row, endRow - 1);
      for (let row = first; row <= last; row += 1) rows.add(row);
    }
    for (const link of links) addOverlayRow(rows, link.row, startRow, endRow);
    if (hoverLink) addOverlayRow(rows, hoverLink.row, startRow, endRow);

    return rows;
  }

  // Repaint only rows where overlays were or now are visible. That clears stale
  // selection/hover/search pixels without repainting the whole visible window.
  function repaintOverlay() {
    if (!lastComposite) return;
    if (lastStartRow === null || !renderer) {
      needsFullPaint = true;
      paintWindow(lastComposite, surface, 'overlay');
      return;
    }
    const nextOverlayRows = overlayAbsoluteRowsInWindow(
      lastStartRow,
      lastDisplayRows ?? renderer.rows,
    );
    const dirtyRows = unionRows(lastOverlayRows, nextOverlayRows);
    if (dirtyRows.size === 0) return;
    paintWindow(lastComposite, surface, 'overlay', dirtyRows);
  }

  function shouldAutoFollow() {
    // An active selection pins the viewport: output keeps painting underneath,
    // but we never auto-jump to the tail.
    return liveFollow && selection === null;
  }

  // Rescan the composite frame for URLs so hover/underline/click have up-to-date
  // spans. Cheap at viewport sizes (a regex per visible row). Called whenever the
  // composite changes.
  function recomputeLinks() {
    if (activeBuffer) {
      links = [];
      return;
    }
    if (!lastComposite) {
      links = [];
      return;
    }
    const next: BufferLinkSpan[] = [];
    for (const row of lastComposite.rows) {
      const layout = terminalRowTextLayout(row, surface.cols);
      for (const link of detectLinks(layout.text)) {
        const span = terminalTextRangeToCellSpan(layout, link.start, link.end);
        next.push({
          row: row.index,
          startCol: span.startCol,
          endCol: span.endCol,
          href: link.href,
        });
      }
    }
    links = next;
  }

  function linkAt(cell: BufferCell): BufferLinkSpan | null {
    for (const link of links) {
      if (link.row === cell.row && cell.col >= link.startCol && cell.col < link.endCol) return link;
    }
    return null;
  }

  function followIntentForSession(sessionId: string): boolean {
    return sessionFollowIntents[sessionId] ?? sessionViews[sessionId]?.liveFollow ?? true;
  }

  function setCurrentSession(sessionId: string | null) {
    activeSessionId = sessionId;
    liveGeneration = sessionId ? (sessionGenerations[sessionId] ?? 0) : 0;
    if (sessionId) liveFollow = followIntentForSession(sessionId);
  }

  function viewWithLiveFollow(view: SessionTerminalView, sessionId: string): SessionTerminalView {
    const followIntent =
      view.compositeFrame.modes?.alternateScreen === true
        ? (sessionFollowIntents[sessionId] ?? true)
        : followIntentForSession(sessionId);
    return view.liveFollow === followIntent ? view : { ...view, liveFollow: followIntent };
  }

  function scrollToTail() {
    const viewport = els.viewport;
    if (!viewport) return;
    autoScrolling = true;
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    paintWindow(lastComposite, surface, 'scroll');
    requestAnimationFrame(() => {
      paintWindow(lastComposite, surface, 'scroll');
      if (lastComposite?.modes?.alternateScreen === true) {
        liveFollow = true;
        autoScrolling = false;
        onLiveFollow(true);
        return;
      }
      const stillFollowing =
        viewport.scrollTop + viewport.clientHeight >=
        viewport.scrollHeight - SCROLL_FOLLOW_EPSILON_PX;
      autoScrolling = false;
      setLiveFollow(stillFollowing);
    });
  }

  function scheduleAutoFollowSettle() {
    requestAnimationFrame(() => {
      if (shouldAutoFollow() && needsTailScroll()) {
        scrollToTail();
        return;
      }
      autoScrolling = false;
      if (!shouldAutoFollow()) paintWindow(lastComposite, surface, 'frame');
    });
  }

  function needsTailScroll() {
    const viewport = els.viewport;
    if (!viewport) return false;
    const target = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    return Math.abs(viewport.scrollTop - target) > SCROLL_FOLLOW_EPSILON_PX;
  }

  function buildBufferedSessionView(
    previousView: SessionTerminalView | undefined,
    buffer: TerminalBufferState,
    forSurface: TerminalSurface,
    followIntent = previousView?.liveFollow ?? true,
  ): SessionTerminalView {
    const lastSurfaceFrame = frameFromBufferWindow(
      buffer,
      buffer.viewportOffset,
      Math.max(1, forSurface.rows),
    );
    return {
      lastFrame: lastSurfaceFrame,
      compositeFrame: lastSurfaceFrame,
      scrollbackRows: [],
      rowCount: Math.max(0, buffer.totalRows - buffer.viewportRows),
      liveFollow: followIntent,
    };
  }

  function alignLiveViewportToTail() {
    const viewport = els.viewport;
    if (!viewport || !shouldAutoFollow()) return false;
    const target = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    if (Math.abs(viewport.scrollTop - target) <= SCROLL_FOLLOW_EPSILON_PX) return false;
    viewport.scrollTop = target;
    return true;
  }

  function applyView(
    view: SessionTerminalView,
    forSurface: TerminalSurface = surface,
    buffer: TerminalBufferState | null = null,
    options: {
      dirtyAbsoluteRows?: ReadonlySet<number>;
      forceFullPaint?: boolean;
      // Set on a genuine session switch so a scrolled-back session lands back where
      // the user left it. Never set on live frame ingestion, which must not yank
      // the viewport. Only honored when the session is not following the tail.
      restoreScrollForSession?: string;
    } = {},
  ) {
    const previousPaintMode = terminalPaintMode(lastComposite, activeBuffer);
    const nextPaintMode = terminalPaintMode(view.compositeFrame, buffer);
    if (previousPaintMode !== nextPaintMode || options.forceFullPaint) {
      needsFullPaint = true;
    }
    activeBuffer = buffer;
    lastFrame = view.lastFrame;
    lastComposite = view.compositeFrame;
    liveFollow = view.liveFollow;
    rememberActiveViewCursor(view, buffer);
    recomputeLinks();
    onScrollbackRowCount(view.rowCount);
    let autoFollow = shouldAutoFollow();
    if (autoFollow) autoScrolling = true;
    updateSpacer(buffer?.totalRows ?? view.compositeFrame.rows.length, forSurface);
    if (!autoFollow && buffer && options.restoreScrollForSession) {
      const repinnedToTail = restoreBufferedScrollAnchor(
        options.restoreScrollForSession,
        buffer,
        forSurface,
      );
      // Re-pinning re-arms follow, so the tail-align and auto-follow settle below
      // must run as if this were a following session.
      if (repinnedToTail) {
        autoFollow = shouldAutoFollow();
        if (autoFollow) autoScrolling = true;
      }
    }
    // Emit follow state once the restore has settled it, so a re-pin does not first
    // flash the stale not-following value to consumers.
    onLiveFollow(liveFollow);
    const alignedToTail = alignLiveViewportToTail();
    paintWindow(view.compositeFrame, forSurface, 'frame', options.dirtyAbsoluteRows);
    onComposite?.();
    if (autoFollow) {
      if (alignedToTail || needsTailScroll()) scheduleAutoFollowSettle();
      else autoScrolling = false;
      return;
    }
    requestAnimationFrame(() => {
      if (shouldAutoFollow()) scrollToTail();
      else {
        autoScrolling = false;
        paintWindow(lastComposite, surface, 'frame');
      }
    });
  }

  function applyBufferedMetadataView(
    view: SessionTerminalView,
    buffer: TerminalBufferState,
    forSurface: TerminalSurface = surface,
  ) {
    const previousPaintMode = terminalPaintMode(lastComposite, activeBuffer);
    const nextPaintMode = terminalPaintMode(view.compositeFrame, buffer);
    if (previousPaintMode !== nextPaintMode) {
      applyView(view, forSurface, buffer, { forceFullPaint: true });
      return;
    }

    activeBuffer = buffer;
    lastFrame = view.lastFrame;
    lastComposite = view.compositeFrame;
    liveFollow = view.liveFollow;
    rememberActiveViewCursor(view, buffer);
    onScrollbackRowCount(view.rowCount);
    onLiveFollow(view.liveFollow);
    const autoFollow = shouldAutoFollow();
    if (autoFollow) autoScrolling = true;
    updateSpacer(buffer.totalRows, forSurface);
    const alignedToTail = alignLiveViewportToTail();
    const stalePaintWindow = bufferedPaintWindowNeedsRepaint(buffer, forSurface);
    if (stalePaintWindow || (autoFollow && alignedToTail)) {
      paintWindow(view.compositeFrame, forSurface, 'scroll');
    }
    emitScrollMetrics(forSurface);
    if (autoFollow) {
      if (alignedToTail || needsTailScroll()) scheduleAutoFollowSettle();
      else autoScrolling = false;
    }
  }

  function clearInteractionState() {
    selection = null;
    links = [];
    hoverLink = null;
  }

  function bufferedPaintWindowNeedsRepaint(
    buffer: TerminalBufferState,
    forSurface: TerminalSurface,
  ) {
    if (lastStartRow === null) return true;
    const displayRows = Math.max(1, lastDisplayRows ?? renderer?.rows ?? forSurface.rows);
    if (lastStartRow >= buffer.totalRows) return true;

    const viewport = els.viewport;
    if (!viewport) return false;
    const inset = insetFor(forSurface);
    const viewportStart = Math.max(
      0,
      Math.min(
        Math.max(0, buffer.totalRows - 1),
        Math.floor((viewport.scrollTop - inset.top) / forSurface.cellHeight),
      ),
    );
    const viewportRows = Math.max(1, Math.ceil(viewport.clientHeight / forSurface.cellHeight));
    const viewportEnd = Math.min(buffer.totalRows, viewportStart + viewportRows);
    const paintEnd = lastStartRow + displayRows;
    return paintEnd <= viewportStart || lastStartRow >= viewportEnd;
  }

  function clear(forSurface: TerminalSurface = surface) {
    disposeRenderer('clear');
    activeBuffer = null;
    if (activeSessionId) delete sessionCursorFallbacks[activeSessionId];
    clearAllResizeReflowPending();
    needsFullPaint = true;
    lastStartRow = null;
    lastDisplayRows = null;
    clearInteractionState();
    const view = emptyTerminalView(forSurface);
    lastFrame = null;
    lastComposite = view.compositeFrame;
    setLiveFollow(true);
    onScrollbackRowCount(0);
    updateSpacer(forSurface.rows, forSurface);
    paintWindow(view.compositeFrame, forSurface, 'clear');
  }

  function resetScrollback() {
    activeBuffer = null;
    lastComposite = null;
    if (activeSessionId) delete sessionCursorFallbacks[activeSessionId];
    clearAllResizeReflowPending();
    needsFullPaint = true;
    lastStartRow = null;
    lastDisplayRows = null;
    clearInteractionState();
    setLiveFollow(true);
    onScrollbackRowCount(0);
    updateSpacer(surface.rows, surface);
  }

  function paintFrame(rawFrame: TerminalFrame) {
    activeBuffer = null;
    const surfaceFrame = frameForSurface(rawFrame, surface);
    lastFrame = surfaceFrame;
    onScrollbackRowCount(surfaceFrame.scrollback?.scrollbackRows ?? 0);
    lastComposite = surfaceFrame;
    recomputeLinks();
    const autoFollow = shouldAutoFollow();
    if (autoFollow) autoScrolling = true;
    updateSpacer(surfaceFrame.rows.length, surface);
    const alignedToTail = alignLiveViewportToTail();
    paintWindow(surfaceFrame, surface, 'frame');
    onComposite?.();
    if (autoFollow) {
      if (alignedToTail || needsTailScroll()) scheduleAutoFollowSettle();
      else autoScrolling = false;
      return;
    }
    requestAnimationFrame(() => {
      if (shouldAutoFollow()) scrollToTail();
      else {
        autoScrolling = false;
        paintWindow(lastComposite, surface, 'frame');
      }
    });
  }

  function ensureSessionView(
    sessionId: string,
    forSurface: TerminalSurface = surface,
  ): SessionTerminalView | undefined {
    const buffer = sessionBuffers[sessionId];
    const frame = latestFrames[sessionId];
    if (terminalFrameUsesAlternateScreen(frame)) {
      const previousView = sessionViews[sessionId];
      if (
        frame?.dirty === 'clean' &&
        previousView?.compositeFrame?.modes?.alternateScreen === true
      ) {
        const compositeFrame = frameForSurface(
          {
            ...previousView.compositeFrame,
            dirty: 'full',
            modes: frame.modes ?? previousView.compositeFrame.modes,
          },
          forSurface,
        );
        const view = viewWithLiveFollow(
          { ...previousView, lastFrame: compositeFrame, compositeFrame },
          sessionId,
        );
        sessionViews[sessionId] = view;
        return view;
      }
      const alternateFrame = preserveSparseAlternateResizeFrame(
        frame,
        previousView?.compositeFrame,
        forSurface,
        resizeReflowPendingSessions[sessionId] === true,
      );
      const view = viewWithLiveFollow(
        buildSessionTerminalView(previousView, alternateFrame, forSurface),
        sessionId,
      );
      sessionViews[sessionId] = view;
      return view;
    }
    if (buffer) {
      const followIntent = followIntentForSession(sessionId);
      const projectedBuffer = projectLiveBufferToSurface(buffer, forSurface, followIntent);
      if (projectedBuffer !== buffer) {
        sessionBuffers[sessionId] = projectedBuffer;
      }
      const view = buildBufferedSessionView(
        sessionViews[sessionId],
        projectedBuffer,
        forSurface,
        followIntent,
      );
      sessionViews[sessionId] = view;
      return view;
    }
    if (frame) {
      const view = viewWithLiveFollow(
        buildSessionTerminalView(sessionViews[sessionId], frame, forSurface),
        sessionId,
      );
      sessionViews[sessionId] = view;
      return view;
    }
    return sessionViews[sessionId];
  }

  function paintCurrent(selectedSessionId: string | null, forSurface: TerminalSurface = surface) {
    // A genuine session switch restores that session's remembered scroll position;
    // a same-session repaint (resize, font change, autostart) must preserve the
    // user's current scroll, so it does not.
    const isSessionSwitch = scrollRestoredSessionId !== selectedSessionId;
    scrollRestoredSessionId = selectedSessionId;
    setCurrentSession(selectedSessionId);
    if (selectedSessionId) {
      const view = ensureSessionView(selectedSessionId, forSurface);
      if (view) {
        const frame = latestFrames[selectedSessionId];
        applyView(
          view,
          forSurface,
          terminalFrameUsesAlternateScreen(frame)
            ? null
            : (sessionBuffers[selectedSessionId] ?? null),
          isSessionSwitch ? { restoreScrollForSession: selectedSessionId } : undefined,
        );
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
    ingestFrames(sessionId, [frame], isActive);
  }

  // Coalesced stream ingestion: every frame must update the frontend buffer
  // because Ghostty can emit partial dirty snapshots. The active surface only
  // paints once, using the final frame in the batch.
  function ingestFrames(sessionId: string, frames: readonly TerminalFrame[], isActive: boolean) {
    if (frames.length === 0) return;
    const acceptedFrames = isActive
      ? frames.filter(frame => terminalFrameMatchesSurface(frame, surface))
      : frames;
    if (acceptedFrames.length === 0) return;
    // Diagnostic: record what libghostty reports per batch (on change) so we can
    // see whether scroll-back collapse coincides with the alt-screen flag, a
    // shrinking total_rows, or scrollback_rows being large while total_rows is small.
    const fsFrame = acceptedFrames[acceptedFrames.length - 1];
    if (fsFrame) {
      const sb = fsFrame.scrollback;
      const alt = fsFrame.modes?.alternateScreen === true;
      const fsKey = `${alt ? 'alt' : 'pri'}:${sb?.totalRows ?? -1}:${sb?.scrollbackRows ?? -1}:${sb?.viewportRows ?? -1}:${fsFrame.dirty}`;
      if (fsKey !== lastFrameScrollbackTraceKey) {
        lastFrameScrollbackTraceKey = fsKey;
        trace({
          kind: 'frame_scrollback',
          alternateScreen: alt,
          dirty: fsFrame.dirty,
          totalRows: sb?.totalRows ?? null,
          scrollbackRows: sb?.scrollbackRows ?? null,
          viewportRows: sb?.viewportRows ?? null,
          viewportOffset: sb?.viewportOffset ?? null,
          atBottom: sb?.atBottom ?? null,
        });
      }
    }
    let nextBuffer = sessionBuffers[sessionId] ?? createTerminalBuffer(surface);
    const oldestIdBefore = nextBuffer.oldestId;
    let nextAlternateView = sessionViews[sessionId];
    const alternateDirtyRows = new Set<number>();
    let alternateNeedsFullPaint = false;
    const primaryDirtyRows = new Set<number>();
    let primaryNeedsFullPaint = false;
    for (const frame of acceptedFrames) {
      latestFrames[sessionId] = frame;
      if (terminalFrameUsesAlternateScreen(frame)) {
        const alternateSurface = isActive ? surface : surfaceForFrame(frame, surface);
        const alternateFrame = preserveSparseAlternateResizeFrame(
          frame,
          nextAlternateView?.compositeFrame,
          alternateSurface,
          resizeReflowPendingSessions[sessionId] === true,
        );
        if (alternateFrame !== frame) alternateNeedsFullPaint = true;
        if (frame.dirty === 'full') alternateNeedsFullPaint = true;
        if (alternateFrame.dirty === 'partial') {
          addCursorRowsToDirtySet(
            alternateDirtyRows,
            nextAlternateView?.compositeFrame.cursor,
            alternateFrame.cursor,
            0,
          );
          for (const row of alternateFrame.rows) {
            if (row.dirty !== false) alternateDirtyRows.add(row.index);
          }
        }
        if (alternateFrame.dirty === 'clean') continue;
        nextAlternateView = viewWithLiveFollow(
          buildSessionTerminalView(nextAlternateView, alternateFrame, alternateSurface),
          sessionId,
        );
        sessionViews[sessionId] = nextAlternateView;
        rememberSessionFrameCursor(sessionId, 'frame', nextAlternateView.compositeFrame);
        continue;
      }
      if (frame.dirty === 'full') primaryNeedsFullPaint = true;
      if (frame.dirty === 'partial') {
        const viewportOffset = frame.scrollback?.viewportOffset ?? 0;
        for (const row of frame.rows) {
          if (row.dirty !== false) primaryDirtyRows.add(viewportOffset + row.index);
        }
      }
      const frameSurface = isActive ? surface : surfaceForFrame(frame, surface);
      const preserveBlankRows = shouldHoldBlankResizeFrame(
        resizeReflowPendingSessions[sessionId] === true,
        frame,
      );
      const followIntent = followIntentForSession(sessionId);
      const preserveShapeRows = isActive && followIntent === false;
      const previousPrimaryCursor = nextBuffer.cursor;
      nextBuffer = applyViewportFrameToBuffer(nextBuffer, frame, frameSurface, {
        preserveBlankRows,
        preserveShapeRows,
        anchorPreservedRowsToViewport: isActive && followIntent === true,
      });
      rememberSessionBufferCursor(sessionId, nextBuffer);
      if (frame.dirty === 'partial') {
        addCursorRowsToDirtySet(primaryDirtyRows, previousPrimaryCursor, nextBuffer.cursor, 0);
      }
    }
    sessionBuffers[sessionId] = nextBuffer;

    if (isActive) {
      activeSessionId = sessionId;
      liveFollow = followIntentForSession(sessionId);
      // If the backend evicted rows off the top during this batch, the content the
      // user is viewing moved up by that many rows. When scrolled up (not
      // following), shift the scroll position to keep the view anchored to the same
      // content instead of sliding toward the tail (best-effort; decisions.md D8).
      const evictionShift = nextBuffer.oldestId - oldestIdBefore;
      if (evictionShift > 0 && !liveFollow && els.viewport) {
        els.viewport.scrollTop = Math.max(
          0,
          els.viewport.scrollTop - evictionShift * surface.cellHeight,
        );
      }
      const latestFrame = acceptedFrames[acceptedFrames.length - 1] ?? null;
      if (terminalFrameUsesAlternateScreen(latestFrame)) {
        if (!nextAlternateView && latestFrame?.dirty === 'clean') return;
        if (!alternateNeedsFullPaint && alternateDirtyRows.size === 0) return;
        const next = viewWithLiveFollow(
          markSessionViewDirtyRows(
            nextAlternateView ?? buildSessionTerminalView(undefined, latestFrame, surface),
            alternateDirtyRows,
            alternateNeedsFullPaint,
          ),
          sessionId,
        );
        sessionViews[sessionId] = next;
        applyView(next, surface, null);
        return;
      }
      const next = buildBufferedSessionView(
        sessionViews[sessionId],
        nextBuffer,
        surface,
        followIntentForSession(sessionId),
      );
      sessionViews[sessionId] = next;
      if (!primaryNeedsFullPaint && primaryDirtyRows.size === 0) {
        applyBufferedMetadataView(next, nextBuffer, surface);
        return;
      }
      applyView(next, surface, nextBuffer, {
        dirtyAbsoluteRows: primaryNeedsFullPaint ? undefined : primaryDirtyRows,
        forceFullPaint: primaryNeedsFullPaint,
      });
    } else if (!isActive) {
      const latestFrame = acceptedFrames[acceptedFrames.length - 1] ?? null;
      if (!terminalFrameUsesAlternateScreen(latestFrame)) delete sessionViews[sessionId];
    }
  }

  function terminalFrameUsesAlternateScreen(frame: TerminalFrame | null | undefined) {
    return frame?.modes?.alternateScreen === true;
  }

  function mergeLiveRows(
    frame: TerminalFrame,
    startId: number,
    totalRows: number,
    generation = liveGeneration,
  ) {
    if (generation !== liveGeneration || !activeSessionId) return false;
    const previous =
      sessionBuffers[activeSessionId] ?? activeBuffer ?? createTerminalBuffer(surface);
    // The band is addressed by stable id; convert to the buffer's current position
    // by subtracting the live floor (oldest_id). If the band's rows were evicted
    // since the fetch (its id is now below the floor), drop it. Below eviction the
    // floor is 0, so id == position (decisions.md D8).
    const startRow = startId - previous.oldestId;
    if (startRow < 0) return false;
    // A live session keeps appending rows while the fill round-trips, so the
    // response's totalRows routinely lags the buffer's current total. The window's
    // rows are addressed by absolute id and stay valid regardless, so merge them but
    // never let a lagging total shrink the buffer (that would reset it). Rejecting
    // on any mismatch is what livelocked the live tail under continuous output:
    // every fill came back "stale", the missing rows were never filled, and the
    // renderer kept repainting empty rows every frame. Genuine staleness (a reflow
    // or clear) is already caught by the generation check above.
    const mergeTotalRows = Math.max(totalRows, previous.totalRows);
    const merged = mergeHistoryWindowIntoBuffer(previous, frame, surface, startRow, mergeTotalRows);
    sessionBuffers[activeSessionId] = merged;
    activeBuffer = merged;
    const next = buildBufferedSessionView(
      sessionViews[activeSessionId],
      merged,
      surface,
      followIntentForSession(activeSessionId),
    );
    sessionViews[activeSessionId] = next;
    applyView(next, surface, merged, { forceFullPaint: true });
    return true;
  }

  function scrollBufferedRows(deltaRows: number): boolean {
    const viewport = els.viewport;
    if (!viewport || deltaRows === 0) return false;
    return scrollBufferedPixels(deltaRows * surface.cellHeight);
  }

  function scrollBufferedPixels(deltaPixels: number): boolean {
    const viewport = els.viewport;
    if (!viewport || !Number.isFinite(deltaPixels) || deltaPixels === 0) return false;
    return scrollBufferedToTop(viewport.scrollTop + deltaPixels);
  }

  function scrollBufferedToRow(row: number): boolean {
    const inset = insetFor(surface);
    return scrollBufferedToTop(row * surface.cellHeight + inset.top);
  }

  function scrollBufferedToTop(scrollTop: number): boolean {
    const buffer = activeBuffer;
    const viewport = els.viewport;
    if (!buffer || !viewport) return false;
    if (buffer.totalRows <= buffer.viewportRows) return false;
    const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const targetTop = Math.max(0, Math.min(maxTop, scrollTop));
    // Scrolling is free over the virtualized history. Move the viewport now and
    // paint from the mirror; where rows are not cached yet the paint draws blank
    // placeholders and the paint-window prefetch pulls that band from libghostty
    // (decisions.md D6/D7), filling them in when it lands. We never refuse to move
    // just because a row is uncached, which is what capped scroll-back a few rows
    // above the tail. This is the react-window/TanStack model: a stable-height
    // spacer the user scrolls freely, with rows virtualized in behind the gesture.
    viewport.scrollTop = targetTop;
    const following =
      viewport.scrollTop + viewport.clientHeight >=
      viewport.scrollHeight - SCROLL_FOLLOW_EPSILON_PX;
    setLiveFollow(following);
    needsFullPaint = true;
    schedulePaintWindow('scroll');
    return true;
  }

  function setLiveFollow(live: boolean) {
    liveFollow = live;
    if (activeSessionId) {
      sessionFollowIntents[activeSessionId] = live;
      const view = sessionViews[activeSessionId];
      if (view && view.liveFollow !== live) {
        sessionViews[activeSessionId] = { ...view, liveFollow: live };
      }
    }
    captureActiveScrollAnchor();
    onLiveFollow(live);
  }

  // Remember where the active session is scrolled, so switching away and back
  // lands on the same content. Driven through setLiveFollow, which fires on every
  // scroll settle (wheel, scrollbar, native scroll), so the stored anchor always
  // tracks the user's latest scrolled-back position. We only ever WRITE an anchor
  // (never delete): a following session's "remembered position" is the live tail,
  // and the gated restore ignores any stale anchor while following. Not deleting
  // also avoids a hazard during activation: scrollToTail can re-pin (setLiveFollow
  // true) while activeSessionId still names the OUTGOING session, which would
  // otherwise drop that session's fresh anchor. Follow-intent and the anchor are
  // written together here, so a not-following session always has a fresh anchor.
  function captureActiveScrollAnchor() {
    const sessionId = activeSessionId;
    if (!sessionId || liveFollow) return;
    const viewport = els.viewport;
    if (!activeBuffer || !viewport) return;
    const inset = insetFor(surface);
    const topPosition = Math.max(
      0,
      Math.floor((viewport.scrollTop - inset.top) / surface.cellHeight),
    );
    sessionScrollAnchors[sessionId] = activeBuffer.oldestId + topPosition;
  }

  // Restore a remembered scrolled-back position when a session becomes current.
  // Runs after updateSpacer (so the scroll range is this session's) and before the
  // paint (so there is no flash at the previous session's position). Returns true
  // when it re-pinned to the live tail (and re-armed follow), so the caller resumes
  // the auto-follow path.
  //
  // A session only lands here when its follow intent is false, which happens two
  // ways, and only one is a real scrolled-back position:
  //   - The user scrolled it back: a stable-row-id anchor is recorded. Restore it
  //     and leave the follow intent off, so a deliberate scroll-back stays put even
  //     if a later resize makes the whole live cache fit the viewport.
  //   - No anchor: the user never scrolled it; the intent went false from a
  //     background frame that briefly reported not-at-bottom. The old fallback
  //     parked the viewport at the buffer's viewport offset, which sits a row or
  //     more above the true tail whenever the visible height is shorter than the
  //     buffer's viewport rows. That pushed the live cursor row past the paint
  //     window's bottom edge, so cursorForWindow hid it and the cursor "vanished"
  //     for that session. A never-scrolled session belongs at the live tail, so
  //     re-pin and re-arm follow.
  function restoreBufferedScrollAnchor(
    sessionId: string,
    buffer: TerminalBufferState,
    forSurface: TerminalSurface,
  ): boolean {
    const viewport = els.viewport;
    if (!viewport) return false;
    // The spacer was just sized for this session, so its DOM scroll extent is the
    // authoritative tail position (it accounts for both insets and any partial
    // trailing row); no separate row-space clamp is needed.
    const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const anchorId = sessionScrollAnchors[sessionId];
    if (anchorId !== undefined) {
      // Convert the stable id back to a buffer position through the current oldestId
      // (rows evicted past the backend's floor clamp to the oldest available), then
      // clamp to the tail so a stale anchor now past a shorter tail lands at the
      // bottom rather than beyond it.
      const inset = insetFor(forSurface);
      const targetTop = Math.max(0, anchorId - buffer.oldestId) * forSurface.cellHeight + inset.top;
      viewport.scrollTop = Math.max(0, Math.min(maxTop, targetTop));
      return false;
    }
    // Re-arm follow so output tracks and the cursor shows again. The caller emits
    // onLiveFollow once the rest of applyView has settled.
    viewport.scrollTop = maxTop;
    liveFollow = true;
    sessionFollowIntents[sessionId] = true;
    const view = sessionViews[sessionId];
    if (view && !view.liveFollow) sessionViews[sessionId] = { ...view, liveFollow: true };
    return true;
  }

  function resizeAlternateSessionViews(forSurface: TerminalSurface) {
    for (const sessionId of Object.keys(sessionViews)) {
      const view = sessionViews[sessionId];
      if (!view || !terminalFrameUsesAlternateScreen(view.compositeFrame)) continue;
      const compositeFrame = frameForSurface(
        {
          ...view.compositeFrame,
          dirty: 'full',
        },
        forSurface,
      );
      sessionViews[sessionId] = {
        ...view,
        lastFrame: view.lastFrame
          ? frameForSurface({ ...view.lastFrame, dirty: 'full' }, forSurface)
          : compositeFrame,
        compositeFrame,
        rowCount: compositeFrame.scrollback?.scrollbackRows ?? 0,
      };
    }
  }

  function markResizeReflowPending() {
    for (const sessionId of Object.keys(sessionBuffers)) {
      markSessionResizeReflowPending(sessionId);
    }
    if (activeSessionId) markSessionResizeReflowPending(activeSessionId);
  }

  function markSessionResizeReflowPending(sessionId: string) {
    resizeReflowPendingSessions[sessionId] = true;
    if (typeof window === 'undefined') return;
    const existing = resizeReflowGuardTimers[sessionId];
    if (existing) window.clearTimeout(existing);
    resizeReflowGuardTimers[sessionId] = window.setTimeout(() => {
      clearSessionResizeReflowPending(sessionId);
    }, RESIZE_REFLOW_BLANK_FRAME_GUARD_MS);
  }

  function clearSessionResizeReflowPending(sessionId: string) {
    delete resizeReflowPendingSessions[sessionId];
    if (typeof window === 'undefined') return;
    const existing = resizeReflowGuardTimers[sessionId];
    if (existing) window.clearTimeout(existing);
    delete resizeReflowGuardTimers[sessionId];
  }

  function clearAllResizeReflowPending() {
    for (const sessionId of Object.keys(resizeReflowPendingSessions)) {
      clearSessionResizeReflowPending(sessionId);
    }
    for (const sessionId of Object.keys(resizeReflowGuardTimers)) {
      clearSessionResizeReflowPending(sessionId);
    }
  }

  return {
    attach(next: TerminalDomRefs) {
      els = next;
      attachRendererCanvas(next.canvas);
    },
    setSurface(next: TerminalSurface) {
      const previous = surface;
      const geometryChanged =
        next.cols !== surface.cols ||
        next.rows !== surface.rows ||
        next.cellWidth !== surface.cellWidth ||
        next.cellHeight !== surface.cellHeight ||
        next.fontSize !== surface.fontSize ||
        next.baseline !== surface.baseline;
      if (geometryChanged) {
        invalidatePendingRendererMount();
        needsFullPaint = true;
      }
      if (geometryChanged) {
        trace({
          kind: 'surface_change',
          previous,
          next,
          columnsChanged: next.cols !== previous.cols,
          rowsChanged: next.rows !== previous.rows,
        });
      }
      if (next.cols !== surface.cols) {
        // No generation bump here: the backend bumps the generation on every
        // resize and re-seeds with a Full frame (which `setLiveGeneration`
        // adopts), and that subsumes the reflow invalidation. A frontend-only
        // bump would only desync the serve gate from the backend's generation.
        // `markResizeReflowPending` is still needed for the blank-frame paint
        // guard during reflow churn, which is independent of the generation.
        markResizeReflowPending();
        resizeAlternateSessionViews(next);
        needsFullPaint = true;
      } else if (next.rows !== surface.rows) {
        resizeAlternateSessionViews(next);
        needsFullPaint = true;
      }
      surface = next;
    },
    getSurface() {
      return surface;
    },
    resetRenderer(reason?: string) {
      disposeRenderer(reason ? `reset_renderer:${reason}` : 'reset_renderer');
    },
    tryMountRenderer(): boolean {
      return Boolean(renderer ?? mountRenderer());
    },
    // Apply the active shell theme's terminal colors. Recreates the renderer so
    // its default fg/bg pick up the new theme, then forces a full repaint of the
    // current composite. The live backend terminal is updated separately (the
    // hook calls set_terminal_theme), which also re-emits a themed frame.
    setThemeColors(colors: TerminalThemeColors) {
      themeColors = colors;
      if (els.canvas && renderer) {
        mountRenderer(surface, renderer.rows);
        needsFullPaint = true;
        paintWindow(lastComposite, surface, 'frame');
      }
    },
    // Toggle or retune the CRT post-process. Toggling on/off recreates the
    // renderer (the painted window resizes between ~viewport for CRT and ~3
    // screens for flat, so the warp anchors to the viewport), then full-repaints.
    // A param-only change while active retunes the live renderer in place.
    setCrt(params: CrtParams | null) {
      const toggled = (crtParams != null) !== (params != null);
      crtParams = params;
      if (!els.canvas) return;
      if (toggled) {
        disposeRenderer('crt_toggle');
        needsFullPaint = true;
        paintWindow(lastComposite, surface, 'frame');
      } else if (renderer?.setCrt) {
        renderer.setCrt(params);
      }
    },
    requireRenderer(): TerminalRenderer {
      const active = renderer ?? mountRenderer();
      if (!active) throw new Error('Terminal renderer is not mounted yet');
      return active;
    },
    seedEmptyView(sessionId: string) {
      // A (re)launched session starts fresh at the tail. Drop any remembered scroll
      // anchor and follow intent from a prior run (and the stale view they would be
      // inherited from) so a stable id is never restored against the new, unrelated
      // buffer. This is the per-session reset the relaunch path runs alongside
      // resetScrollback; a session that exits on its own is never dropped, so its
      // scroll memory would otherwise survive into the resumed conversation.
      delete sessionScrollAnchors[sessionId];
      delete sessionFollowIntents[sessionId];
      delete sessionViews[sessionId];
      delete sessionGenerations[sessionId];
      delete sessionCursorFallbacks[sessionId];
      if (activeSessionId === sessionId) liveGeneration = 0;
      const view = viewWithLiveFollow(emptyTerminalView(surface), sessionId);
      sessionViews[sessionId] = view;
      sessionBuffers[sessionId] = createTerminalBuffer(surface);
      return view;
    },
    paintWindow,
    schedulePaintWindow,
    applyView,
    paintFrame,
    paintCurrent,
    setCurrentSession,
    clear,
    resetScrollback,
    scrollToTail,
    ensureSessionView,
    ingestFrame,
    ingestFrames,
    dropSession(sessionId: string) {
      delete sessionViews[sessionId];
      delete latestFrames[sessionId];
      delete sessionBuffers[sessionId];
      delete sessionFollowIntents[sessionId];
      delete sessionScrollAnchors[sessionId];
      delete sessionGenerations[sessionId];
      delete sessionCursorFallbacks[sessionId];
      clearSessionResizeReflowPending(sessionId);
      if (activeSessionId === sessionId) {
        activeSessionId = null;
        liveGeneration = 0;
      }
      if (scrollRestoredSessionId === sessionId) scrollRestoredSessionId = null;
    },
    focusCanvas() {
      if (focusElement(els.input)) return;
      focusElement(els.canvas);
    },
    getLastFrameModes(): TerminalModes | undefined {
      return lastFrame?.modes;
    },
    isLiveFollow() {
      return liveFollow;
    },
    setLiveFollow,
    // Sync the backend-adopted generation from the frame stream. The hook calls
    // this from `handleDecodedFrame` whenever it accepts a frame (adopting a new
    // generation from a Full frame). History-range requests and the merge gate
    // use this value, so they always agree with the backend's generation; never
    // a frontend-only token, or the serve gate would never match.
    setLiveGeneration(generation: number, sessionId?: string, active = false) {
      const targetSessionId = sessionId ?? activeSessionId;
      if (targetSessionId) sessionGenerations[targetSessionId] = generation;
      if (!sessionId || active || activeSessionId === sessionId) {
        liveGeneration = generation;
      }
    },
    getLiveGeneration() {
      return liveGeneration;
    },
    isAutoScrolling() {
      return autoScrolling;
    },

    // --- Interaction layer surface (read state + drive the overlay) ---
    // The painted window origin (buffer row of the top painted row); hit-testing
    // adds the window-local row to this to land in composite coordinates.
    getStartRow(): number {
      return lastStartRow ?? 0;
    },
    // Active CRT barrel curvature (0 when off) so the interaction layer can
    // unwarp the pointer to match what the warped canvas displays.
    getCrtCurvature(): number {
      return crtParams?.curvature ?? 0;
    },
    // The backend's stable-id floor (rows evicted so far). The hook adds this to a
    // buffer position to address a history fetch by stable id, and the band reply
    // is converted back through it on merge; see decisions.md D8.
    getOldestId(): number {
      return activeBuffer?.oldestId ?? 0;
    },
    getResizeAnchor(): { id: number; col: number } | null {
      if (liveFollow || !activeBuffer || !els.viewport) return null;
      if (activeBuffer.modes?.alternateScreen) return null;
      const inset = insetFor(surface);
      const topPosition = Math.max(
        0,
        Math.floor((els.viewport.scrollTop - inset.top) / surface.cellHeight),
      );
      return {
        id: activeBuffer.oldestId + topPosition,
        col: 0,
      };
    },
    getComposite(): TerminalFrame | null {
      if (activeBuffer) {
        return frameFromBufferAbsoluteWindow(
          activeBuffer,
          lastStartRow ?? activeBuffer.viewportOffset,
          lastDisplayRows ?? surface.rows,
        );
      }
      return lastComposite;
    },
    getBufferDebug() {
      const buffer = activeBuffer ?? (activeSessionId ? sessionBuffers[activeSessionId] : null);
      if (!buffer) return null;
      const startRow = Math.max(0, lastStartRow ?? buffer.viewportOffset);
      const rowCount = Math.max(1, Math.min(lastDisplayRows ?? surface.rows, buffer.totalRows));
      const rows = [];
      for (let offset = 0; offset < rowCount; offset += 1) {
        const rowId = startRow + offset;
        const row = buffer.rowsById.get(rowId);
        rows.push({
          rowId,
          cached: row !== undefined,
          cellCount: row?.cells.length ?? 0,
          text: row ? terminalRowTextLayout(row, buffer.cols).text.trimEnd() : '',
        });
      }
      return {
        cols: buffer.cols,
        viewportRows: buffer.viewportRows,
        viewportOffset: buffer.viewportOffset,
        totalRows: buffer.totalRows,
        atBottom: buffer.atBottom,
        generation: buffer.generation,
        rowMapSize: buffer.rowsById.size,
        cachedRanges: buffer.cachedRanges,
        resizeReflowPending: activeSessionId
          ? resizeReflowPendingSessions[activeSessionId] === true
          : false,
        startRow,
        rowCount,
        rows,
      };
    },
    getRowCount(): number {
      return activeBuffer?.totalRows ?? lastComposite?.rows.length ?? 0;
    },
    hasRenderableContent(sessionId?: string): boolean {
      const targetSessionId = sessionId ?? activeSessionId;
      const buffer = targetSessionId ? sessionBuffers[targetSessionId] : (activeBuffer ?? null);
      if (buffer && terminalBufferHasRenderableRows(buffer)) return true;
      const view = targetSessionId ? sessionViews[targetSessionId] : null;
      if (view?.compositeFrame && terminalFrameHasRenderableCells(view.compositeFrame)) {
        return true;
      }
      const frame = targetSessionId ? latestFrames[targetSessionId] : lastComposite;
      return frame ? terminalFrameHasRenderableCells(frame) : false;
    },
    getViewport(): HTMLDivElement | null {
      return els.viewport;
    },
    getCanvas(): HTMLCanvasElement | null {
      return els.canvas;
    },
    getSelection(): SelectionRange | null {
      return selection;
    },
    hasSelection(): boolean {
      return selection !== null;
    },
    setSelection(range: SelectionRange | null) {
      selection =
        range && activeBuffer
          ? expandTerminalBufferRangeToCellBounds(activeBuffer, range, surface.cols)
          : range && lastComposite
            ? expandRangeToCellBounds(lastComposite, range, surface.cols)
            : range;
      repaintOverlay();
    },
    clearSelection() {
      if (selection === null) return;
      selection = null;
      repaintOverlay();
      // No explicit scroll here: shouldAutoFollow() becomes true again, so the
      // next streamed frame resumes tail-follow on its own. Clearing a selection
      // never yanks the viewport.
    },
    // Drop the selection + hover when the displayed session changes, so a stale
    // selection (in the previous session's coordinates) never pins the new
    // session's viewport or leaks into its copied text. Links are frame-derived
    // and rebuilt by recomputeLinks on the next applied view, so they are left
    // alone here.
    resetInteraction() {
      if (selection === null && hoverLink === null) {
        return;
      }
      selection = null;
      hoverLink = null;
      repaintOverlay();
    },
    getSelectionText(): string {
      if (!selection) return '';
      if (activeBuffer) return terminalBufferSelectionText(activeBuffer, selection, surface.cols);
      if (!lastComposite) return '';
      return selectionText(lastComposite, selection, surface.cols);
    },
    setLinks(next: BufferLinkSpan[]) {
      links = next;
      repaintOverlay();
    },
    getLinks(): BufferLinkSpan[] {
      return links;
    },
    linkAt,
    setHoverLink(next: BufferLinkSpan | null) {
      const sameRow =
        hoverLink &&
        next &&
        hoverLink.row === next.row &&
        hoverLink.startCol === next.startCol &&
        hoverLink.endCol === next.endCol;
      if (sameRow || (!hoverLink && !next)) return;
      hoverLink = next;
      repaintOverlay();
    },
    selectAll() {
      const range = activeBuffer
        ? selectAllTerminalBufferRange(activeBuffer, surface.cols)
        : lastComposite
          ? selectAllRange(lastComposite, surface.cols)
          : null;
      if (!range) return;
      selection = range;
      repaintOverlay();
    },
    mergeLiveRows,
    scrollBufferedRows,
    scrollBufferedPixels,
    scrollBufferedToRow,
  };
}

export type TerminalController = ReturnType<typeof createTerminalController>;

function addOverlayRow(rows: Set<number>, row: number, startRow: number, endRow: number) {
  if (row >= startRow && row < endRow) rows.add(row);
}

function unionRows(left: ReadonlySet<number>, right: ReadonlySet<number>) {
  const rows = new Set<number>(left);
  for (const row of right) rows.add(row);
  return rows;
}

function dirtyRowsInWindow(absoluteRows: ReadonlySet<number>, startRow: number) {
  const rows = new Set<number>();
  for (const row of absoluteRows) rows.add(row - startRow);
  return rows;
}

function addCursorRowsToDirtySet(
  rows: Set<number>,
  previousCursor: TerminalCursor | undefined,
  nextCursor: TerminalCursor | undefined,
  nextRowOffset: number,
) {
  const previousRow = cursorPaintRow(previousCursor, 0);
  const nextRow = cursorPaintRow(nextCursor, nextRowOffset);
  if (previousRow !== null) rows.add(previousRow);
  if (nextRow !== null) rows.add(nextRow);
}

function cursorPaintRow(cursor: TerminalCursor | undefined, rowOffset: number) {
  if (cursor?.visible === false) return null;
  const row = cursor?.position?.row ?? cursor?.row;
  if (!Number.isFinite(row)) return null;
  return rowOffset + (row as number);
}

function frameWithDirtyLocalRows(
  frame: TerminalFrame,
  dirtyLocalRows: ReadonlySet<number>,
  previousCursorLocalRow: number | null = null,
) {
  const rowsToPaint = new Set(dirtyLocalRows);
  if (previousCursorLocalRow !== null) rowsToPaint.add(previousCursorLocalRow);
  const cursor = cursorPosition(frame.cursor);
  if (frame.cursor?.visible !== false && cursor) rowsToPaint.add(cursor.row);
  return {
    ...frame,
    dirty: 'partial' as const,
    rows: frame.rows
      .filter(row => rowsToPaint.has(row.index))
      .map(row => ({ ...row, dirty: true })),
  };
}

function cursorLocalRowInWindow(
  absoluteRow: number | null,
  startRow: number,
  displayRows: number,
): number | null {
  if (absoluteRow === null) return null;
  const localRow = absoluteRow - startRow;
  return localRow >= 0 && localRow < displayRows ? localRow : null;
}

function cursorPosition(cursor: TerminalCursor | undefined): { row: number; col: number } | null {
  const row = cursor?.position?.row ?? cursor?.row;
  const col = cursor?.position?.col ?? cursor?.col;
  if (!Number.isFinite(row) || !Number.isFinite(col)) return null;
  return { row: row as number, col: col as number };
}

function visibleCursorAt(
  cursor: TerminalCursor | undefined,
  row: number,
  col: number,
): TerminalCursor {
  return {
    ...cursor,
    visible: true,
    row,
    col,
    position: { row, col },
  };
}

function frameWithSessionCursorFallback(
  frame: TerminalFrame,
  fallback: SessionCursorFallback | undefined,
  startRow: number,
  displayRows: number,
  space: CursorCoordinateSpace,
) {
  const preferred = frameWithSelfRenderedCursorPreference(frame);
  if (preferred !== frame) return preferred;
  const current = cursorPosition(frame.cursor);
  if (frame.cursor?.visible !== false && current) return frame;
  if (!fallback || fallback.space !== space) return frame;
  const fallbackPosition = cursorPosition(fallback.cursor);
  if (!fallbackPosition) return frame;
  const row = fallbackPosition.row - startRow;
  if (row < 0 || row >= Math.max(1, displayRows)) return frame;
  const col = clampCursorColumn(fallbackPosition.col, frame.cols);
  return {
    ...frame,
    cursor: visibleCursorAt(fallback.cursor, row, col),
  };
}

function frameWithSelfRenderedCursorPreference(frame: TerminalFrame) {
  if (!terminalFrameSelfRenderedCursorPosition(frame)) return frame;
  if (frame.cursor?.visible === false) return frame;
  return {
    ...frame,
    cursor: {
      ...frame.cursor,
      visible: false,
    },
  };
}

function terminalFrameSelfRenderedCursorPosition(
  frame: TerminalFrame,
): { row: number; col: number } | null {
  let cursor: { row: number; col: number } | null = null;
  for (const row of frame.rows) {
    for (const cell of row.cells) {
      if (!terminalCellLooksLikeSelfRenderedCursor(cell)) continue;
      if (cursor !== null) return null;
      cursor = { row: row.index, col: cell.col };
    }
  }
  return cursor;
}

function terminalBufferSelfRenderedCursorPosition(
  buffer: TerminalBufferState,
): { row: number; col: number } | null {
  let cursor: { row: number; col: number } | null = null;
  for (const row of buffer.rowsById.values()) {
    for (const cell of row.cells) {
      if (!terminalCellLooksLikeSelfRenderedCursor(cell)) continue;
      if (cursor !== null) return null;
      cursor = { row: row.index, col: cell.col };
    }
  }
  return cursor;
}

function terminalCellLooksLikeSelfRenderedCursor(cell: TerminalRow['cells'][number]) {
  return cell.style?.inverse === true && !cell.style?.invisible && cell.text.trim().length === 0;
}

function clampCursorColumn(col: number, cols: number | undefined) {
  if (!Number.isFinite(cols) || (cols as number) <= 0) return col;
  return Math.min(Math.max(0, (cols as number) - 1), Math.max(0, col));
}

function terminalFrameHasVisibleCursor(frame: TerminalFrame): boolean {
  if (frame.cursor?.visible === false) return false;
  const cursor = cursorPosition(frame.cursor);
  if (!cursor) return false;
  return frame.rows.some(row => row.index === cursor.row);
}

function cursorPaintSample(frame: TerminalFrame): TerminalPaintCursorSample {
  const cursor = cursorPosition(frame.cursor);
  const visible = frame.cursor?.visible !== false && cursor !== null;
  return {
    visible,
    row: cursor?.row ?? null,
    col: cursor?.col ?? null,
    inPaintRows: visible ? frame.rows.some(row => row.index === cursor.row) : false,
  };
}

function terminalPaintMode(
  frame: TerminalFrame | null,
  buffer: TerminalBufferState | null,
): 'none' | 'buffer' | 'alternate' | 'viewport' {
  if (buffer) return 'buffer';
  if (!frame) return 'none';
  return frame.modes?.alternateScreen ? 'alternate' : 'viewport';
}

function preserveSparseAlternateResizeFrame(
  frame: TerminalFrame,
  previousFrame: TerminalFrame | null | undefined,
  surface: TerminalSurface,
  resizeReflowPending: boolean,
) {
  const dirty = frame.dirty ?? 'full';
  if (!resizeReflowPending || (dirty !== 'full' && dirty !== 'partial') || !previousFrame) {
    return frame;
  }
  if (previousFrame.modes?.alternateScreen !== true) return frame;
  const current = frameForSurface(frame, surface);
  const previous = frameForSurface(previousFrame, surface);
  const currentRenderableRows = current.rows.filter(terminalRowHasRenderableCells).length;
  const previousRenderableRows = previous.rows.filter(terminalRowHasRenderableCells).length;
  if (
    previousRenderableRows < 3 ||
    currentRenderableRows >= Math.max(2, Math.floor(previousRenderableRows * 0.75))
  ) {
    return frame;
  }
  const previousRows = new Map(previous.rows.map(row => [row.index, row]));
  return {
    ...current,
    dirty,
    rows: current.rows.map(row => {
      if (terminalRowHasRenderableCells(row)) return row;
      const previousRow = previousRows.get(row.index);
      return previousRow && terminalRowHasRenderableCells(previousRow)
        ? { ...cloneTerminalRow(previousRow), index: row.index, dirty: true }
        : row;
    }),
  };
}

function terminalFrameMatchesSurface(frame: TerminalFrame, surface: TerminalSurface) {
  if (Number.isFinite(frame.cols) && (frame.cols as number) > 0 && frame.cols !== surface.cols) {
    return false;
  }
  const viewportRows = frame.scrollback?.viewportRows;
  if (
    Number.isFinite(viewportRows) &&
    (viewportRows as number) > 0 &&
    viewportRows !== surface.rows
  ) {
    return false;
  }
  return true;
}

function surfaceForFrame(frame: TerminalFrame, fallback: TerminalSurface): TerminalSurface {
  const cols =
    Number.isFinite(frame.cols) && (frame.cols as number) > 0
      ? (frame.cols as number)
      : fallback.cols;
  const viewportRows = frame.scrollback?.viewportRows;
  const rows =
    Number.isFinite(viewportRows) && (viewportRows as number) > 0
      ? (viewportRows as number)
      : fallback.rows;
  return { ...fallback, cols, rows };
}

function terminalFrameHasRenderableCells(frame: TerminalFrame) {
  return frame.rows.some(terminalRowHasRenderableCells);
}

function terminalBufferHasRenderableRows(buffer: TerminalBufferState) {
  for (const row of buffer.rowsById.values()) {
    if (terminalRowHasRenderableCells(row)) return true;
  }
  return false;
}

function shouldHoldBlankResizeFrame(resizeReflowPending: boolean, frame: TerminalFrame) {
  return resizeReflowPending && !terminalFrameHasRenderableCells(frame);
}

function terminalRowHasRenderableCells(row: TerminalRow) {
  return row.cells.some(terminalCellHasVisiblePaint);
}

function markSessionViewDirtyRows(
  view: SessionTerminalView,
  dirtyRows: ReadonlySet<number>,
  forceFull: boolean,
): SessionTerminalView {
  const markFrame = (frame: TerminalFrame): TerminalFrame => ({
    ...frame,
    dirty: forceFull ? 'full' : 'partial',
    rows: frame.rows.map(row => ({
      ...cloneTerminalRow(row),
      dirty: forceFull || dirtyRows.has(row.index),
    })),
  });

  const frame = markFrame(view.compositeFrame);
  return {
    ...view,
    lastFrame: view.lastFrame ? markFrame(view.lastFrame) : view.lastFrame,
    compositeFrame: frame,
  };
}

function rendererMountKey(
  surface: TerminalSurface,
  displayRows: number,
  dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
) {
  // Include the font size + baseline so a font-size change always remounts the
  // renderer (and rebuilds the glyph atlas), even in the rare case two sizes
  // round to the same cell box.
  return [
    surface.cols,
    displayRows,
    surface.cellWidth,
    surface.cellHeight,
    surface.fontSize,
    surface.baseline,
    dpr,
  ].join(':');
}

function projectLiveBufferToSurface(
  buffer: TerminalBufferState,
  forSurface: TerminalSurface,
  followIntent: boolean,
): TerminalBufferState {
  const viewportRows = Math.max(1, Math.ceil(forSurface.rows));
  const maxViewportOffset = Math.max(0, buffer.totalRows - viewportRows);
  const bufferAtTail =
    buffer.atBottom || buffer.viewportOffset + buffer.viewportRows >= buffer.totalRows;
  const atBottom = followIntent && bufferAtTail;
  const viewportOffset = atBottom
    ? maxViewportOffset
    : Math.min(buffer.viewportOffset, maxViewportOffset);
  if (
    viewportRows === buffer.viewportRows &&
    viewportOffset === buffer.viewportOffset &&
    atBottom === buffer.atBottom
  ) {
    return buffer;
  }
  return {
    ...buffer,
    viewportRows,
    viewportOffset,
    atBottom,
  };
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'then' in value &&
    typeof (value as Promise<T>).then === 'function'
  );
}

function terminalRendererRequiresSelfContainedPaint(renderer: TerminalRenderer | null) {
  return renderer !== null && !renderer.capabilities.retainedPartialPaint;
}

function cachedPaintWindowForMissingRows(
  buffer: TerminalBufferState,
  requestedStartRow: number,
  requestedDisplayRows: number,
): { startRow: number; displayRows: number } | null {
  const requestedEndRow = requestedStartRow + requestedDisplayRows;
  let best: {
    start: number;
    end: number;
    overlap: number;
    distance: number;
  } | null = null;

  for (const range of buffer.cachedRanges) {
    const rangeLength = range.end - range.start;
    if (rangeLength <= 0) continue;
    const overlap = Math.max(
      0,
      Math.min(requestedEndRow, range.end) - Math.max(requestedStartRow, range.start),
    );
    const distance =
      overlap > 0
        ? 0
        : range.end <= requestedStartRow
          ? requestedStartRow - range.end
          : range.start - requestedEndRow;
    if (
      !best ||
      overlap > best.overlap ||
      (overlap === best.overlap && distance < best.distance) ||
      (overlap === best.overlap && distance === best.distance && range.end > best.end)
    ) {
      best = {
        start: range.start,
        end: range.end,
        overlap,
        distance,
      };
    }
  }

  if (!best) return null;
  const displayRows = Math.max(1, Math.min(requestedDisplayRows, best.end - best.start));
  return {
    startRow: Math.max(best.start, Math.min(requestedStartRow, best.end - displayRows)),
    displayRows,
  };
}

function cachedLiveTailPaintWindow(
  buffer: TerminalBufferState,
  visibleStartRow: number,
  visibleRowCount: number,
  requestedDisplayRows: number,
  requireVisibleCoverage: boolean,
): { startRow: number; displayRows: number } | null {
  const visibleStart = Math.max(0, Math.floor(visibleStartRow));
  const visibleEnd = Math.min(
    buffer.totalRows,
    visibleStart + Math.max(1, Math.floor(visibleRowCount)),
  );
  if (visibleEnd <= visibleStart) return null;

  let best: {
    range: { start: number; end: number };
    overlap: number;
  } | null = null;
  for (const range of liveTailCoverageRanges(buffer)) {
    const overlap = Math.max(
      0,
      Math.min(visibleEnd, range.end) - Math.max(visibleStart, range.start),
    );
    if (overlap <= 0) continue;
    if (
      !best ||
      range.end > best.range.end ||
      (range.end === best.range.end && overlap > best.overlap)
    ) {
      best = { range, overlap };
    }
  }
  if (!best) return null;

  if (requireVisibleCoverage) {
    if (
      best.range.start > visibleStart + LIVE_TAIL_ALLOWED_TOP_GAP_ROWS ||
      best.range.end < visibleEnd
    ) {
      return null;
    }
  }

  const rangeLength = best.range.end - best.range.start;
  const displayRows = Math.max(1, Math.min(Math.floor(requestedDisplayRows), rangeLength));
  const latestStart = Math.max(best.range.start, best.range.end - displayRows);
  const startRow = Math.max(best.range.start, Math.min(visibleStart, latestStart));
  return {
    startRow,
    displayRows: Math.max(1, Math.min(displayRows, best.range.end - startRow)),
  };
}

function cursorLiveTailPaintWindow(
  buffer: TerminalBufferState,
  visibleStartRow: number,
  visibleRowCount: number,
  requestedDisplayRows: number,
): { startRow: number; displayRows: number } | null {
  if (buffer.cursor?.visible === false) return null;
  const cursor = cursorPosition(buffer.cursor);
  if (!cursor || buffer.totalRows <= 0) return null;

  const liveStart = Math.max(0, Math.floor(buffer.viewportOffset));
  const liveEnd = Math.min(buffer.totalRows, liveStart + Math.max(1, buffer.viewportRows));
  if (cursor.row < liveStart || cursor.row >= liveEnd) return null;

  const visibleStart = Math.max(0, Math.floor(visibleStartRow));
  const visibleEnd = Math.min(
    buffer.totalRows,
    visibleStart + Math.max(1, Math.floor(visibleRowCount)),
  );
  if (visibleEnd <= visibleStart) return null;

  const displayRows = Math.max(
    1,
    Math.min(Math.floor(requestedDisplayRows), Math.max(1, buffer.totalRows)),
  );
  const maxStart = Math.max(0, buffer.totalRows - displayRows);
  const preferredStart = Math.min(visibleStart, cursor.row);
  let startRow = Math.max(0, Math.min(preferredStart, maxStart));
  if (cursor.row < startRow || cursor.row >= startRow + displayRows) {
    startRow = Math.max(0, Math.min(cursor.row, maxStart));
  }

  return { startRow, displayRows };
}

function liveTailCoverageRanges(
  buffer: TerminalBufferState,
): Array<{ start: number; end: number }> {
  const ranges = [...buffer.cachedRanges];
  const liveEnd = Math.min(buffer.totalRows, buffer.viewportOffset + buffer.viewportRows);
  let start: number | null = null;
  for (let rowId = buffer.viewportOffset; rowId < liveEnd; rowId += 1) {
    if (buffer.rowsById.has(rowId)) {
      if (start === null) start = rowId;
      continue;
    }
    if (start !== null) {
      ranges.push({ start, end: rowId });
      start = null;
    }
  }
  if (start !== null) ranges.push({ start, end: liveEnd });
  return ranges;
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function defaultTerminalRendererBackends(): TerminalRendererBackend[] {
  if (typeof window === 'undefined') return ['webgl2', 'canvas2d'];
  const params =
    typeof window.location?.search === 'string'
      ? new URLSearchParams(window.location.search)
      : null;
  const requested =
    params?.get('terminalRenderer') ??
    window.localStorage?.getItem('reverie.terminal.renderer') ??
    undefined;
  return requested === 'canvas2d' ? ['canvas2d', 'webgl2'] : ['webgl2', 'canvas2d'];
}
