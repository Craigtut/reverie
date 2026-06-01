import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type UIEvent,
  type WheelEvent,
} from 'react';

import { listen, type UnlistenFn } from '../services/runtime';
import {
  recordRenderMetrics,
  recordTerminalDiagnostics,
  resizeTerminal,
  scrollTerminalViewport,
  scrollTerminalViewportToBottom,
  setTerminalFrontendActive,
  setTerminalTheme,
  startSession,
  terminalHistoryInfo,
  terminalHistorySearchWindow,
  terminalHistoryWindow,
  writeTerminalInput,
} from '../services/terminalApi';
import { cycleIndex, resolvedActiveMatchIndex, type FrameMatch } from '../terminal/findModel';
import {
  DEFAULT_TERMINAL_SCROLLBACK_ROWS,
  getUserHome,
  errorMessage,
  shortId,
  terminalInputForKey,
  terminalWheelDeltaRows,
} from '../domain';
import type {
  CreateSessionRecordRequest,
  RenderMetrics,
  ShellSession,
  StartSessionRequest,
  SessionTerminalBinding,
  TerminalExitPayload,
  TerminalFailedPayload,
  TerminalFramePayload,
  TerminalStreamStartedPayload,
} from '../domain';
import { createSession } from '../services/shellApi';
import { TERMINAL_SURFACE } from '../terminal-canvas-renderer';
import {
  SCROLL_FOLLOW_EPSILON_PX,
  type TerminalSurface,
  terminalInsetPx,
  terminalSurfaceForBounds,
} from '../terminalScrollback';
import { useNavigationStore, useShellStore, useTerminalStore, useUiStore } from '../store';
import { TERMINAL_THEME } from '../themes/terminalTheme';
import { openExternalUrl } from '../services/openApi';
import {
  createTerminalController,
  type TerminalController,
  type TerminalHistoryRowsRequest,
  type TimedTerminalControllerTraceEvent,
} from '../terminal/terminalController';
import type { TerminalPaintSample, TerminalRow } from '../terminalTypes';
import {
  historyWindowRows,
  planHistoryWindowForMissingRows,
  planHistoryWindowForTargetRow,
  resolveHistoryTotalRows,
} from '../terminal/historyWindowing';
import {
  createLatestHistoryJumpQueue,
  type HistoryJumpRequest,
} from '../terminal/historyJumpQueue';
import {
  createTerminalFrameBatchAggregate,
  recordTerminalFrameBatch,
  terminalFrameBatchRenderMetrics,
} from '../terminal/frameCoalescing';
import { createTerminalMetricSamples, type TerminalMetricSamples } from '../terminal/metricSamples';
import {
  buildActionContext,
  buildMenuItems,
  createTerminalInteraction,
  encodeSgrWheelEvent,
  registerDefaultInteractions,
  resolveTopTarget,
  terminalMouseCellFromClientPoint,
  type ActionContextDeps,
  type ContextMenuContext,
  type InteractionProbe,
  type MenuModel,
  type TerminalInteraction,
} from '../terminal/interaction';

// Register the built-in resolvers + actions once, before any menu is built.
registerDefaultInteractions();

interface FindState {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  matches: FrameMatch[];
  activeIndex: number; // 0-based into matches, -1 when none
  total: number;
  capped: boolean;
  busy: boolean;
}

interface TerminalRenderAggregate {
  backend?: string;
  paintTimings: TerminalMetricSamples;
  scrollPaintTimings: TerminalMetricSamples;
  paints: number;
  clears: number;
  rowsPainted: number;
  cellsPainted: number;
  glyphsPainted: number;
  blockGlyphsPainted: number;
  drawCalls: number;
  rectDrawCalls: number;
  glyphDrawCalls: number;
  bufferUploads: number;
  bufferUploadBytes: number;
  glyphAtlasHits: number;
  glyphAtlasMisses: number;
  glyphAtlasUploads: number;
  glyphAtlasResets: number;
  maxRowsPerPaint: number;
  maxCellsPerPaint: number;
}

const TERMINAL_TRACE_LIMIT = 1_000;
const TERMINAL_BACKEND_RESIZE_FLUSH_MS = 16;
// Settle window for committing a new surface geometry. A view/session transition,
// tab-bar reflow, or window-resize drag reports a different viewport size on every
// animation frame; each committed size that crosses a row/column boundary tears
// down and rebuilds the WebGL renderer and invalidates the scrollback cache (the
// remount flap that paints black). Waiting for the size to hold still collapses a
// storm into one commit. The first measure after the viewport mounts bypasses this
// so initial paint stays instant.
const SURFACE_RESIZE_SETTLE_MS = 80;
const HISTORY_RESIZE_REPLAY_DEBOUNCE_MS = 240;
const HISTORY_SCROLL_JUMP_DEBOUNCE_MS = 24;
const PENDING_TARGET_SETTLE_FRAMES = 90;
const TERMINAL_DIAGNOSTIC_FLUSH_MS = 500;
const TERMINAL_DIAGNOSTIC_BATCH_LIMIT = 100;
const TERMINAL_SLOW_PAINT_MS = 24;

interface TerminalDebugApi {
  trace: () => TimedTerminalControllerTraceEvent[];
  clear: () => void;
  summary: () => Record<string, unknown>;
  visibleRows: () => Array<{ index: number; text: string }>;
}

const FIND_DEBOUNCE_MS = 120;
// Find searches the whole session, so a single query can match thousands of
// times; cap the kept matches (still report the true total) so navigation and
// the overlay stay cheap.
const FIND_MAX_MATCHES = 2_000;

function terminalInputArmedForActiveId(
  bindings: Record<string, SessionTerminalBinding>,
  activeTerminalId: string | null,
): boolean {
  if (!activeTerminalId) return false;
  return Object.values(bindings).some(
    binding => binding.terminalId === activeTerminalId && binding.inputArmed,
  );
}

function createTerminalRenderAggregate(): TerminalRenderAggregate {
  return {
    paintTimings: createTerminalMetricSamples(),
    scrollPaintTimings: createTerminalMetricSamples(),
    paints: 0,
    clears: 0,
    rowsPainted: 0,
    cellsPainted: 0,
    glyphsPainted: 0,
    blockGlyphsPainted: 0,
    drawCalls: 0,
    rectDrawCalls: 0,
    glyphDrawCalls: 0,
    bufferUploads: 0,
    bufferUploadBytes: 0,
    glyphAtlasHits: 0,
    glyphAtlasMisses: 0,
    glyphAtlasUploads: 0,
    glyphAtlasResets: 0,
    maxRowsPerPaint: 0,
    maxCellsPerPaint: 0,
  };
}

function recordTerminalPaintSample(
  aggregate: TerminalRenderAggregate,
  sample: TerminalPaintSample,
) {
  aggregate.backend = sample.backend ?? aggregate.backend;
  aggregate.paintTimings.record(sample.elapsedMs);
  if (sample.reason === 'scroll') aggregate.scrollPaintTimings.record(sample.elapsedMs);

  const stats = sample.rendererStats;
  aggregate.paints += stats?.paints ?? 1;
  aggregate.clears += stats?.clears ?? 0;
  aggregate.rowsPainted += stats?.rowsPainted ?? sample.rowsPainted;
  aggregate.cellsPainted += stats?.cellsPainted ?? sample.cellsPainted;
  aggregate.glyphsPainted += stats?.glyphsPainted ?? 0;
  aggregate.blockGlyphsPainted += stats?.blockGlyphsPainted ?? 0;
  aggregate.drawCalls += stats?.drawCalls ?? 0;
  aggregate.rectDrawCalls += stats?.rectDrawCalls ?? 0;
  aggregate.glyphDrawCalls += stats?.glyphDrawCalls ?? 0;
  aggregate.bufferUploads += stats?.bufferUploads ?? 0;
  aggregate.bufferUploadBytes += stats?.bufferUploadBytes ?? 0;
  aggregate.glyphAtlasHits += stats?.glyphAtlasHits ?? 0;
  aggregate.glyphAtlasMisses += stats?.glyphAtlasMisses ?? 0;
  aggregate.glyphAtlasUploads += stats?.glyphAtlasUploads ?? 0;
  aggregate.glyphAtlasResets += stats?.glyphAtlasResets ?? 0;
  aggregate.maxRowsPerPaint = Math.max(
    aggregate.maxRowsPerPaint,
    stats?.maxRowsPerPaint ?? sample.rowsPainted,
  );
  aggregate.maxCellsPerPaint = Math.max(
    aggregate.maxCellsPerPaint,
    stats?.maxCellsPerPaint ?? sample.cellsPainted,
  );
}

function terminalRenderMetrics(aggregate: TerminalRenderAggregate): Partial<RenderMetrics> {
  const paint = aggregate.paintTimings.summary();
  const scrollPaint = aggregate.scrollPaintTimings.summary();
  return {
    rendererBackend: aggregate.backend,
    paintSamples: paint.count,
    scrollPaintSamples: scrollPaint.count,
    avgPaintMs: paint.average,
    p95PaintMs: paint.p95,
    maxPaintMs: paint.max,
    avgScrollPaintMs: scrollPaint.average,
    p95ScrollPaintMs: scrollPaint.p95,
    maxScrollPaintMs: scrollPaint.max,
    rendererPaints: aggregate.paints,
    rendererClears: aggregate.clears,
    rendererRowsPainted: aggregate.rowsPainted,
    rendererCellsPainted: aggregate.cellsPainted,
    rendererGlyphsPainted: aggregate.glyphsPainted,
    rendererBlockGlyphsPainted: aggregate.blockGlyphsPainted,
    rendererDrawCalls: aggregate.drawCalls,
    rendererRectDrawCalls: aggregate.rectDrawCalls,
    rendererGlyphDrawCalls: aggregate.glyphDrawCalls,
    rendererBufferUploads: aggregate.bufferUploads,
    rendererBufferUploadBytes: aggregate.bufferUploadBytes,
    glyphAtlasHits: aggregate.glyphAtlasHits,
    glyphAtlasMisses: aggregate.glyphAtlasMisses,
    glyphAtlasUploads: aggregate.glyphAtlasUploads,
    glyphAtlasResets: aggregate.glyphAtlasResets,
    maxRowsPerPaint: aggregate.maxRowsPerPaint,
    maxCellsPerPaint: aggregate.maxCellsPerPaint,
  };
}

function terminalTraceMetrics(
  trace: readonly TimedTerminalControllerTraceEvent[],
): Partial<RenderMetrics> {
  let rendererMounts = 0;
  let rendererMountStarts = 0;
  let rendererDisposes = 0;
  let terminalSurfaceChanges = 0;
  let terminalHistoryRowRequests = 0;
  let terminalHistoryWindowMerges = 0;
  let terminalBufferCacheMisses = 0;
  let terminalLiveBufferCacheMisses = 0;
  let terminalHistoryBufferCacheMisses = 0;
  let terminalFullPaints = 0;
  let terminalPartialPaints = 0;
  let maxRendererRows = 0;

  for (const event of trace) {
    if (event.kind === 'renderer_mount') {
      if (event.phase === 'start') rendererMountStarts += 1;
      if (event.phase === 'sync' || event.phase === 'async_resolved') rendererMounts += 1;
      maxRendererRows = Math.max(maxRendererRows, event.rendererRows);
    } else if (event.kind === 'renderer_dispose') {
      if (event.hadRenderer || event.pendingRenderer) rendererDisposes += 1;
    } else if (event.kind === 'surface_change') {
      terminalSurfaceChanges += 1;
    } else if (event.kind === 'history_rows_request') {
      terminalHistoryRowRequests += 1;
    } else if (event.kind === 'history_window_merge') {
      terminalHistoryWindowMerges += 1;
    } else if (event.kind === 'buffer_cache_miss') {
      terminalBufferCacheMisses += 1;
      if (event.mode === 'live') terminalLiveBufferCacheMisses += 1;
      else terminalHistoryBufferCacheMisses += 1;
    } else if (event.kind === 'paint') {
      if (event.fullPaint) terminalFullPaints += 1;
      else terminalPartialPaints += 1;
    }
  }

  return {
    terminalTraceEvents: trace.length,
    rendererMounts,
    rendererMountStarts,
    rendererDisposes,
    terminalSurfaceChanges,
    terminalHistoryRowRequests,
    terminalHistoryWindowMerges,
    terminalBufferCacheMisses,
    terminalLiveBufferCacheMisses,
    terminalHistoryBufferCacheMisses,
    terminalFullPaints,
    terminalPartialPaints,
    maxRendererRows,
  };
}

function terminalTraceCounts(trace: readonly TimedTerminalControllerTraceEvent[]) {
  const counts: Record<string, number> = {};
  for (const event of trace) {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    if (event.kind === 'renderer_mount') {
      const key = `renderer_mount:${event.phase}`;
      counts[key] = (counts[key] ?? 0) + 1;
    } else if (event.kind === 'renderer_dispose') {
      const key = `renderer_dispose:${event.reason}`;
      counts[key] = (counts[key] ?? 0) + 1;
    } else if (event.kind === 'history_rows_request') {
      const key = `history_rows_request:${event.source}`;
      counts[key] = (counts[key] ?? 0) + 1;
    } else if (event.kind === 'buffer_cache_miss') {
      const key = `buffer_cache_miss:${event.mode}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

function terminalTraceEventShouldPersist(event: TimedTerminalControllerTraceEvent) {
  if (event.kind === 'buffer_cache_miss') return true;
  if (event.kind === 'renderer_dispose') return event.hadRenderer || event.pendingRenderer;
  if (event.kind === 'renderer_mount') return event.phase !== 'start';
  if (event.kind === 'history_window_merge') return true;
  return event.kind === 'history_rows_request' && event.source === 'miss';
}

function terminalRowDebugText(row: TerminalRow) {
  return row.cells
    .slice()
    .sort((left, right) => left.col - right.col)
    .map(cell => cell.text)
    .join('')
    .trimEnd();
}

function terminalDebugVisibleRows(controller: TerminalController) {
  return (
    controller.getComposite()?.rows.map(row => ({
      index: row.index,
      text: terminalRowDebugText(row),
    })) ?? []
  );
}

// React binding for the terminal island. Owns the imperative TerminalController,
// wires the canvas/viewport DOM, runs the paint/resize effects, subscribes to the
// backend frame stream, exposes the input/scroll handlers, and drives the
// session launch/activate lifecycle. All terminal-coupled state lives in the
// terminalStore; current values are read via getState() inside callbacks so the
// long-lived event listeners never close over stale React state.
export function useTerminalSession(params: {
  selectedSession: ShellSession | null;
  writeLog: (line: string) => void;
  loadWorkspaceShell: () => Promise<unknown>;
  setBusy: (busy: boolean) => void;
  isTauriRuntime: boolean;
}) {
  const { selectedSession, writeLog, loadWorkspaceShell, setBusy, isTauriRuntime } = params;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const terminalTextInputRef = useRef<HTMLTextAreaElement | null>(null);
  const surfaceViewportRef = useRef<HTMLDivElement | null>(null);
  const terminalScrollSpacerRef = useRef<HTMLDivElement | null>(null);
  const terminalTextComposingRef = useRef(false);
  const terminalWheelHandlerRef = useRef<(event: globalThis.WheelEvent) => void>(() => {});
  const terminalWheelListenerRef = useRef<((event: globalThis.WheelEvent) => void) | null>(null);
  const terminalInputQueuesRef = useRef<Map<string, Promise<void>>>(new Map());

  // Re-maps find matches onto the (possibly scrolled) viewport after each frame.
  // Held in a ref so the long-lived controller can call the latest closure.
  const applyFindOverlayRef = useRef<() => void>(() => {});
  const requestHistoryRowsRef = useRef<(request: TerminalHistoryRowsRequest) => void>(() => {});
  const requestLiveRowsRef = useRef<(request: TerminalHistoryRowsRequest) => boolean>(() => false);
  const historyWindowRequestsRef = useRef<Set<string>>(new Set());
  const liveMissingRowsRequestKeyRef = useRef<string | null>(null);
  const pendingHistoryRowsRequestRef = useRef<TerminalHistoryRowsRequest | null>(null);
  const pendingHistoryScrollTargetRowRef = useRef<number | null>(null);
  const pendingHistoryResizeReplayRef = useRef<{
    targetRow: number;
    knownTotalRows?: number;
  } | null>(null);
  const pendingHistoryJumpRef = useRef<{
    targetRow: number;
    knownTotalRows?: number;
    fallbackDeltaRows?: number;
    liveMissingRowsKey?: string;
  } | null>(null);
  const pendingLiveTopJumpRef = useRef(false);
  const liveTopJumpRafRef = useRef(0);
  const pendingLiveScrollTargetRowRef = useRef<number | null>(null);
  const liveScrollSettleRafRef = useRef(0);
  const pendingTargetSettleRafRef = useRef(0);
  const historyResizeReplayTimerRef = useRef(0);
  const historyJumpTimerRef = useRef(0);
  const loadingHistoryRowsRef = useRef(false);
  const runHistoryJumpRef = useRef<(request: HistoryJumpRequest) => Promise<boolean>>(async () => {
    return false;
  });
  const historyJumpQueueRef = useRef(
    createLatestHistoryJumpQueue(request => runHistoryJumpRef.current(request)),
  );
  const historyInfoCacheRef = useRef<Map<string, number>>(new Map());
  const historyRequestSeqRef = useRef(0);
  const lastLiveFollowRef = useRef(true);
  const renderSampleCollectorsRef = useRef(
    new Map<string, (sample: TerminalPaintSample) => void>(),
  );
  const terminalTraceRef = useRef<TimedTerminalControllerTraceEvent[]>([]);
  const terminalEventDebugRef = useRef({
    frameEventsSeen: 0,
    frameEventsMatched: 0,
    frameEventsMismatched: 0,
    lastFrameTerminalId: null as string | null,
    lastMatchedFrameSeq: null as number | null,
    frameBatches: 0,
    activeFrameBatches: 0,
    framePayloadsIngested: 0,
    lastBatchSize: 0,
    lastBatchActive: false,
  });
  const pendingViewportSizeRef = useRef<{ width: number; height: number } | null>(null);
  const surfaceResizeSettleTimerRef = useRef(0);
  const hasMeasuredSurfaceRef = useRef(false);
  const pendingBackendResizeRef = useRef<{
    terminalId: string;
    cols: number;
    rows: number;
  } | null>(null);
  const backendResizeTimerRef = useRef(0);
  const terminalDiagnosticEventsRef = useRef<unknown[]>([]);
  const terminalDiagnosticTimerRef = useRef(0);

  const controllerRef = useRef<TerminalController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createTerminalController({
      surface: TERMINAL_SURFACE,
      onScrollbackRowCount: count => useTerminalStore.getState().setScrollbackRowCount(count),
      onLiveFollow: live => {
        const wasLive = lastLiveFollowRef.current;
        lastLiveFollowRef.current = live;
        useTerminalStore.getState().setTerminalLiveFollow(live);
        if (live && !wasLive) clearHistoryWorkForLiveFollow();
      },
      onScrollMetrics: metrics => useTerminalStore.getState().setTerminalScroll(metrics),
      onComposite: () => applyFindOverlayRef.current(),
      onMissingHistoryRows: request => {
        requestHistoryRowsRef.current(request);
        return true;
      },
      onMissingLiveRows: request => requestLiveRowsRef.current(request),
      onPaintSample: sample => {
        const activeTerminalId = useTerminalStore.getState().activeTerminalId;
        if (!activeTerminalId) return;
        renderSampleCollectorsRef.current.get(activeTerminalId)?.(sample);
        if (sample.elapsedMs >= TERMINAL_SLOW_PAINT_MS) {
          enqueueTerminalDiagnostic({
            kind: 'slow_paint',
            sample,
          });
        }
      },
      onTrace: event => {
        const trace = terminalTraceRef.current;
        trace.push(event);
        if (trace.length > TERMINAL_TRACE_LIMIT) {
          trace.splice(0, trace.length - TERMINAL_TRACE_LIMIT);
        }
        if (typeof window !== 'undefined') {
          (
            window as unknown as {
              __REVERIE_TERMINAL_TRACE__?: TimedTerminalControllerTraceEvent[];
            }
          ).__REVERIE_TERMINAL_TRACE__ = trace;
        }
        if (terminalTraceEventShouldPersist(event)) {
          enqueueTerminalDiagnostic({
            kind: 'trace',
            event,
          });
        }
      },
    });
  }
  const controller = controllerRef.current;

  function enqueueTerminalDiagnostic(payload: unknown) {
    if (!isTauriRuntime || typeof window === 'undefined') return;
    terminalDiagnosticEventsRef.current.push({
      wallTime: new Date().toISOString(),
      timestampMs: performance.now(),
      selectedSessionId: useNavigationStore.getState().selectedSessionId,
      activeTerminalId: useTerminalStore.getState().activeTerminalId,
      payload,
    });
    if (terminalDiagnosticEventsRef.current.length > TERMINAL_DIAGNOSTIC_BATCH_LIMIT * 5) {
      terminalDiagnosticEventsRef.current.splice(
        0,
        terminalDiagnosticEventsRef.current.length - TERMINAL_DIAGNOSTIC_BATCH_LIMIT * 5,
      );
    }
    if (terminalDiagnosticTimerRef.current !== 0) return;
    terminalDiagnosticTimerRef.current = window.setTimeout(
      flushTerminalDiagnostics,
      TERMINAL_DIAGNOSTIC_FLUSH_MS,
    );
  }

  function flushTerminalDiagnostics() {
    terminalDiagnosticTimerRef.current = 0;
    const batch = terminalDiagnosticEventsRef.current.splice(0, TERMINAL_DIAGNOSTIC_BATCH_LIMIT);
    if (batch.length === 0) return;
    void recordTerminalDiagnostics(batch).catch(error => {
      if (import.meta.env?.DEV) {
        console.warn('Terminal diagnostics write failed', error);
      }
    });
    if (terminalDiagnosticEventsRef.current.length > 0 && typeof window !== 'undefined') {
      terminalDiagnosticTimerRef.current = window.setTimeout(
        flushTerminalDiagnostics,
        TERMINAL_DIAGNOSTIC_FLUSH_MS,
      );
    }
  }

  if (typeof window !== 'undefined') {
    const debugApi: TerminalDebugApi = {
      trace: () => terminalTraceRef.current.slice(),
      clear: () => {
        terminalTraceRef.current.length = 0;
        (
          window as unknown as {
            __REVERIE_TERMINAL_TRACE__?: TimedTerminalControllerTraceEvent[];
          }
        ).__REVERIE_TERMINAL_TRACE__ = terminalTraceRef.current;
      },
      summary: () => {
        const visibleRows = terminalDebugVisibleRows(controller);
        const surface = controller.getSurface();
        const terminalStore = useTerminalStore.getState();
        return {
          surface,
          historyMode: controller.isHistoryMode(),
          liveFollow: controller.isLiveFollow(),
          startRow: controller.getStartRow(),
          rowCount: controller.getRowCount(),
          visibleRowCount: visibleRows.length,
          firstVisibleRow: visibleRows[0]?.index ?? null,
          lastVisibleRow: visibleRows.at(-1)?.index ?? null,
          traceLength: terminalTraceRef.current.length,
          traceCounts: terminalTraceCounts(terminalTraceRef.current),
          metrics: terminalTraceMetrics(terminalTraceRef.current),
          activeTerminalId: terminalStore.activeTerminalId,
          sessionTerminalBindings: terminalStore.sessionTerminalBindings,
          events: { ...terminalEventDebugRef.current },
        };
      },
      visibleRows: () => terminalDebugVisibleRows(controller),
    };
    (
      window as unknown as {
        __REVERIE_TERMINAL_DEBUG__?: TerminalDebugApi;
        __REVERIE_TERMINAL_TRACE__?: TimedTerminalControllerTraceEvent[];
      }
    ).__REVERIE_TERMINAL_DEBUG__ = debugApi;
    (
      window as unknown as {
        __REVERIE_TERMINAL_TRACE__?: TimedTerminalControllerTraceEvent[];
      }
    ).__REVERIE_TERMINAL_TRACE__ = terminalTraceRef.current;
  }

  // The input island: pointer-driven selection + the right-click menu. It reads
  // paint state from the controller and writes selection ranges back. The
  // contextmenu callback is dispatched through a ref so it always sees the latest
  // services without recreating the (long-lived) interaction controller.
  const contextMenuHandlerRef = useRef<(context: ContextMenuContext) => void>(() => {});
  const interactionRef = useRef<TerminalInteraction | null>(null);
  if (interactionRef.current === null) {
    interactionRef.current = createTerminalInteraction({
      port: controller,
      onContextMenu: context => contextMenuHandlerRef.current(context),
      onActivateLink: href => {
        void openExternalUrl(href).catch(error =>
          writeLog(`Open link failed: ${errorMessage(error)}`),
        );
      },
      sendMouseInput: input => {
        void sendTerminalInput(input);
      },
    });
  }
  const interaction = interactionRef.current;
  const [contextMenu, setContextMenu] = useState<MenuModel | null>(null);

  // Find-in-terminal state. `findRef` is the authoritative copy so the
  // controller's onComposite callback + async search resolution always read
  // fresh matches; `find` drives the React find bar.
  const initialFind: FindState = {
    open: false,
    query: '',
    caseSensitive: false,
    matches: [],
    activeIndex: -1,
    total: 0,
    capped: false,
    busy: false,
  };
  const [find, setFind] = useState<FindState>(initialFind);
  const findRef = useRef<FindState>(initialFind);
  const findDebounceRef = useRef<number>(0);
  const findSearchSeqRef = useRef(0);
  // Whether the full-history (deep scroll) view is showing.
  const [historyViewing, setHistoryViewing] = useState(false);
  // True when Find was the thing that opened the full-history view, so closing
  // Find returns to the live tail (but leaves history alone if the user had
  // opened it themselves via "Full history").
  const findEnteredHistoryRef = useRef(false);
  function updateFind(patch: Partial<FindState>) {
    findRef.current = { ...findRef.current, ...patch };
    setFind(findRef.current);
  }

  function invalidateHistoryRequests(
    options: {
      clearJumpQueue?: boolean;
      preserveLiveMissingRows?: boolean;
      preserveScrollTarget?: boolean;
    } = {},
  ) {
    const clearJumpQueue = options.clearJumpQueue ?? true;
    historyRequestSeqRef.current += 1;
    historyWindowRequestsRef.current.clear();
    if (options.preserveLiveMissingRows !== true) {
      liveMissingRowsRequestKeyRef.current = null;
    }
    pendingHistoryRowsRequestRef.current = null;
    if (options.preserveScrollTarget !== true) {
      pendingHistoryScrollTargetRowRef.current = null;
      cancelLiveTopJump();
      cancelLiveScrollSettle();
      cancelPendingTargetSettle();
    }
    if (options.preserveScrollTarget !== true) {
      cancelPendingHistoryResizeReplay();
      cancelPendingHistoryJump();
    }
    if (clearJumpQueue) historyJumpQueueRef.current.clear();
  }

  function clearHistoryWorkForLiveFollow() {
    historyRequestSeqRef.current += 1;
    historyWindowRequestsRef.current.clear();
    liveMissingRowsRequestKeyRef.current = null;
    pendingHistoryRowsRequestRef.current = null;
    pendingHistoryScrollTargetRowRef.current = null;
    cancelLiveTopJump();
    cancelLiveScrollSettle();
    cancelPendingTargetSettle();
    cancelPendingHistoryResizeReplay();
    cancelPendingHistoryJump();
    historyJumpQueueRef.current.clear();
  }

  function cancelPendingHistoryResizeReplay() {
    pendingHistoryResizeReplayRef.current = null;
    if (historyResizeReplayTimerRef.current !== 0) {
      window.clearTimeout(historyResizeReplayTimerRef.current);
      historyResizeReplayTimerRef.current = 0;
    }
  }

  function scheduleHistoryResizeReplay(targetRow: number, knownTotalRows?: number) {
    pendingHistoryResizeReplayRef.current = { targetRow, knownTotalRows };
    if (historyResizeReplayTimerRef.current !== 0) {
      window.clearTimeout(historyResizeReplayTimerRef.current);
    }
    historyResizeReplayTimerRef.current = window.setTimeout(() => {
      historyResizeReplayTimerRef.current = 0;
      const pending = pendingHistoryResizeReplayRef.current;
      pendingHistoryResizeReplayRef.current = null;
      if (!pending) return;
      void loadHistoryAtRow(pending.targetRow, pending.knownTotalRows);
    }, HISTORY_RESIZE_REPLAY_DEBOUNCE_MS);
  }

  function cancelPendingHistoryJump() {
    pendingHistoryJumpRef.current = null;
    if (historyJumpTimerRef.current !== 0) {
      window.clearTimeout(historyJumpTimerRef.current);
      historyJumpTimerRef.current = 0;
    }
  }

  function cancelLiveTopJump() {
    pendingLiveTopJumpRef.current = false;
    if (liveTopJumpRafRef.current !== 0) {
      cancelAnimationFrame(liveTopJumpRafRef.current);
      liveTopJumpRafRef.current = 0;
    }
  }

  function cancelLiveScrollSettle() {
    pendingLiveScrollTargetRowRef.current = null;
    if (liveScrollSettleRafRef.current !== 0) {
      cancelAnimationFrame(liveScrollSettleRafRef.current);
      liveScrollSettleRafRef.current = 0;
    }
  }

  function cancelPendingTargetSettle() {
    if (pendingTargetSettleRafRef.current !== 0) {
      cancelAnimationFrame(pendingTargetSettleRafRef.current);
      pendingTargetSettleRafRef.current = 0;
    }
  }

  function settlePendingLiveTargetFromCache() {
    const targetRow = pendingHistoryScrollTargetRowRef.current;
    if (targetRow === null || controller.isHistoryMode()) return false;
    if (!controller.scrollBufferedToRow(targetRow)) return false;
    pendingHistoryScrollTargetRowRef.current = null;
    pendingLiveScrollTargetRowRef.current = null;
    pendingLiveTopJumpRef.current = false;
    liveMissingRowsRequestKeyRef.current = null;
    invalidateHistoryRequests();
    cancelPendingTargetSettle();
    return true;
  }

  function schedulePendingTargetSettle(attempt = 0) {
    if (pendingTargetSettleRafRef.current !== 0) {
      cancelAnimationFrame(pendingTargetSettleRafRef.current);
    }
    pendingTargetSettleRafRef.current = requestAnimationFrame(() => {
      pendingTargetSettleRafRef.current = 0;
      if (pendingHistoryScrollTargetRowRef.current === null || controller.isHistoryMode()) return;
      if (settlePendingLiveTargetFromCache()) return;
      if (attempt >= PENDING_TARGET_SETTLE_FRAMES) {
        pendingHistoryScrollTargetRowRef.current = null;
        pendingLiveScrollTargetRowRef.current = null;
        pendingLiveTopJumpRef.current = false;
        return;
      }
      schedulePendingTargetSettle(attempt + 1);
    });
  }

  function scheduleHistoryJump(
    targetRow: number,
    knownTotalRows?: number,
    options: {
      fallbackDeltaRows?: number;
      liveMissingRowsKey?: string;
    } = {},
  ) {
    if (controller.isLiveFollow()) {
      clearHistoryWorkForLiveFollow();
      return;
    }
    pendingHistoryJumpRef.current = {
      targetRow,
      knownTotalRows,
      fallbackDeltaRows: options.fallbackDeltaRows,
      liveMissingRowsKey: options.liveMissingRowsKey,
    };
    schedulePendingTargetSettle();
    if (historyJumpTimerRef.current !== 0) {
      window.clearTimeout(historyJumpTimerRef.current);
    }
    historyJumpTimerRef.current = window.setTimeout(() => {
      historyJumpTimerRef.current = 0;
      const pending = pendingHistoryJumpRef.current;
      pendingHistoryJumpRef.current = null;
      if (!pending) return;
      if (controller.isLiveFollow()) {
        if (
          pending.liveMissingRowsKey &&
          liveMissingRowsRequestKeyRef.current === pending.liveMissingRowsKey
        ) {
          liveMissingRowsRequestKeyRef.current = null;
        }
        pendingHistoryScrollTargetRowRef.current = null;
        return;
      }
      void loadHistoryAtRow(pending.targetRow, pending.knownTotalRows).then(loaded => {
        if (!loaded && pending.liveMissingRowsKey) {
          if (liveMissingRowsRequestKeyRef.current === pending.liveMissingRowsKey) {
            liveMissingRowsRequestKeyRef.current = null;
          }
        }
        if (!loaded && pending.fallbackDeltaRows !== undefined) {
          void sendTerminalViewportScroll(pending.fallbackDeltaRows);
        }
      });
    }, HISTORY_SCROLL_JUMP_DEBOUNCE_MS);
  }

  function startHistoryRequest(
    sessionId: string,
    surface: TerminalSurface,
    options: {
      clearJumpQueue?: boolean;
      preserveLiveMissingRows?: boolean;
      preserveScrollTarget?: boolean;
    } = {},
  ) {
    invalidateHistoryRequests(options);
    return {
      seq: historyRequestSeqRef.current,
      sessionId,
      cols: surface.cols,
      rows: surface.rows,
    };
  }

  function historyInfoCacheKey(sessionId: string, cols: number, rows: number) {
    return `${sessionId}:${cols}:${rows}`;
  }

  function currentHistoryRequest(sessionId: string, surface: TerminalSurface) {
    return {
      seq: historyRequestSeqRef.current,
      sessionId,
      cols: surface.cols,
      rows: surface.rows,
    };
  }

  function historyRequestIsCurrent(request: {
    seq: number;
    sessionId: string;
    cols: number;
    rows: number;
  }) {
    const surface = controller.getSurface();
    return (
      request.seq === historyRequestSeqRef.current &&
      useNavigationStore.getState().selectedSessionId === request.sessionId &&
      surface.cols === request.cols &&
      surface.rows === request.rows
    );
  }

  const surfaceMode = useNavigationStore(s => s.surfaceMode);
  const creationMode = useNavigationStore(s => s.creationMode);
  const selectedSessionId = selectedSession?.id ?? null;
  // Reactive scroll metrics for the overlay scrollbar (the controller publishes
  // them, deduped, on every paint).
  const terminalScroll = useTerminalStore(s => s.terminalScroll);

  // Keep the controller pointed at the live DOM elements (they mount/unmount as
  // the terminal surface shows/hides), and bind/unbind the pointer island to the
  // live canvas alongside it.
  useEffect(() => {
    controller.attach({
      canvas: canvasRef.current,
      input: terminalTextInputRef.current,
      viewport: surfaceViewportRef.current,
      spacer: terminalScrollSpacerRef.current,
    });
    if (canvasRef.current) interaction.attach();
    else interaction.detach();
  });

  // Tear the pointer island's listeners off the canvas on unmount. The attach
  // effect above runs every render (and attach() is idempotent), so it never
  // cleans up on its own; without this, unmounting the terminal surface leaks a
  // pointerdown/contextmenu handler bound to the detached canvas.
  useEffect(() => {
    return () => interaction.detach();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only; interaction is a stable ref
  }, []);

  // Keep the terminal colors matched to the active shell theme. On mount and on
  // every light/dark switch: repaint the live canvas with the theme's default
  // fg/bg (B), and push the same colors to the backend so Ghostty's reported
  // defaults + any CLI that queries OSC 10/11 agree with the shell (D).
  const theme = useUiStore(s => s.theme);
  useEffect(() => {
    const colors = TERMINAL_THEME[theme] ?? TERMINAL_THEME.dark;
    controller.setThemeColors(colors);
    void setTerminalTheme(colors.foreground, colors.background).catch(error =>
      writeLog(`Set terminal theme failed: ${errorMessage(error)}`),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- controller/writeLog are stable refs
  }, [theme]);

  // Switching the displayed session drops any active selection/hover. Without
  // this, a selection made in session A would pin session B's viewport
  // (shouldAutoFollow stays false) and Copy/Send-to-input would read B at A's
  // coordinates. Keyed on the session id only, so a resize repaint never clears.
  // biome-ignore lint/correctness/useExhaustiveDependencies: session id is the trigger.
  useEffect(() => {
    invalidateHistoryRequests();
    controller.resetInteraction();
    // Hard-reset find on session switch: clear the bar without the live-tail
    // dance (which would target the newly-selected session), then drop history.
    findEnteredHistoryRef.current = false;
    closeFind();
    if (controller.isHistoryMode()) {
      controller.exitHistory();
      setHistoryViewing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session id is the trigger
  }, [selectedSessionId]);

  // First paint.
  useEffect(() => {
    controller.paintCurrent(useNavigationStore.getState().selectedSessionId);
    writeLog(
      'Ready. Reverie shell is using the floating-panel UI direction; terminal rendering remains an imperative renderer island.',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  useEffect(() => {
    if (surfaceMode !== 'terminal' || creationMode || !selectedSessionId) {
      controller.resetRenderer('terminal_inactive');
      return;
    }
    requestAnimationFrame(() => {
      controller.paintCurrent(useNavigationStore.getState().selectedSessionId);
      controller.focusCanvas();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creationMode, selectedSessionId, surfaceMode]);

  // Resize the surface to the viewport and tell the backend to match. Bound to
  // the viewport through a callback ref (`attachViewport`) instead of an effect
  // reading `surfaceViewportRef`, because the old effect could run while the ref
  // was still null (viewport height reports 0 for a frame on mount) and then
  // never re-run, leaving the surface stuck at the default size. The callback ref
  // sets the ResizeObserver up exactly when the live node mounts and tears it
  // down on unmount, so resize always tracks. The applied-size closure lives in a
  // ref so the long-lived observer always sees the latest services.
  const applyViewportSizeRef = useRef<(width: number, height: number) => void>(() => {});
  function applyTerminalSurfaceResize(width: number, height: number) {
    // Skip degenerate readings: the viewport reports 0 height for a frame on
    // mount before its grid track resolves. The observer fires again with the
    // real size once layout settles.
    if (!(width > 0) || !(height > 0)) return;
    const previous = controller.getSurface();
    const next = terminalSurfaceForBounds(width, height, previous);
    if (next.cols === previous.cols && next.rows === previous.rows) return;
    const wasHistoryMode = controller.isHistoryMode();
    const wasLiveFollow = controller.isLiveFollow();
    const scrollMetrics = useTerminalStore.getState().terminalScroll;
    const historyTopRow = currentHistoryTopRow(
      previous,
      scrollMetrics?.offsetRows ?? controller.getStartRow(),
    );

    controller.setSurface(next);
    useTerminalStore.getState().setTerminalSurface(next);
    // In history view, only column changes need transcript reflow. Height-only
    // resize keeps the same row cache and repaints in place; replaying on every
    // height tick during a window drag is exactly the expensive churn that makes
    // the terminal flicker and fall behind.
    if (wasHistoryMode) {
      pendingHistoryScrollTargetRowRef.current = null;
      const activeFind = findRef.current;
      if (next.cols === previous.cols) {
        controller.paintWindow(undefined, next, 'history');
      } else if (activeFind.open && activeFind.query.length > 0) {
        // A resize while finding: reflow without jumping to the tail, then
        // re-run the search so matches + the active position are recomputed
        // for the new width and the viewport stays on the match.
        void runSearch(activeFind.query, activeFind.caseSensitive);
      } else {
        pendingHistoryScrollTargetRowRef.current = historyTopRow;
        controller.paintWindow(undefined, next, 'history');
        if (controller.scrollHistoryBufferedToRow(historyTopRow)) {
          pendingHistoryScrollTargetRowRef.current = null;
        }
        scheduleHistoryResizeReplay(historyTopRow);
      }
    } else {
      if (!wasLiveFollow && next.cols !== previous.cols) {
        pendingHistoryScrollTargetRowRef.current = historyTopRow === 0 ? null : historyTopRow;
        controller.paintCurrent(useNavigationStore.getState().selectedSessionId, next);
        if (historyTopRow === 0) {
          cancelLiveTopJump();
          cancelLiveScrollSettle();
          historyJumpQueueRef.current.clear();
          cancelPendingHistoryResizeReplay();
          cancelPendingHistoryJump();
        } else {
          scheduleHistoryResizeReplay(historyTopRow);
        }
      } else {
        controller.paintCurrent(useNavigationStore.getState().selectedSessionId, next);
      }
    }

    const terminalId = useTerminalStore.getState().activeTerminalId;
    if (terminalId) {
      scheduleBackendTerminalResize(terminalId, next.cols, next.rows);
    }
  }

  function flushPendingBackendResize() {
    backendResizeTimerRef.current = 0;
    const pending = pendingBackendResizeRef.current;
    pendingBackendResizeRef.current = null;
    if (!pending) return;
    void resizeTerminal(pending.terminalId, pending.cols, pending.rows).catch(error => {
      writeLog(`Terminal resize failed: ${errorMessage(error)}`);
    });
  }

  function scheduleBackendTerminalResize(terminalId: string, cols: number, rows: number) {
    pendingBackendResizeRef.current = { terminalId, cols, rows };
    if (backendResizeTimerRef.current !== 0) return;
    backendResizeTimerRef.current = window.setTimeout(
      flushPendingBackendResize,
      TERMINAL_BACKEND_RESIZE_FLUSH_MS,
    );
  }

  function flushSettledViewportSize() {
    if (surfaceResizeSettleTimerRef.current !== 0) {
      window.clearTimeout(surfaceResizeSettleTimerRef.current);
      surfaceResizeSettleTimerRef.current = 0;
    }
    const pending = pendingViewportSizeRef.current;
    pendingViewportSizeRef.current = null;
    if (!pending) return;
    hasMeasuredSurfaceRef.current = true;
    applyTerminalSurfaceResize(pending.width, pending.height);
  }

  applyViewportSizeRef.current = (width: number, height: number) => {
    if (!(width > 0) || !(height > 0)) return;
    pendingViewportSizeRef.current = { width, height };
    // First measure after the viewport (re)mounts applies immediately so the
    // terminal fills the space without a default-size flash. After that, wait for
    // the size to hold still: a transition or resize drag reports a new size every
    // frame, and committing each one churns the WebGL renderer and scrollback cache.
    if (!hasMeasuredSurfaceRef.current) {
      flushSettledViewportSize();
      return;
    }
    if (surfaceResizeSettleTimerRef.current !== 0) {
      window.clearTimeout(surfaceResizeSettleTimerRef.current);
    }
    surfaceResizeSettleTimerRef.current = window.setTimeout(
      flushSettledViewportSize,
      SURFACE_RESIZE_SETTLE_MS,
    );
  };

  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const attachViewport = useCallback((node: HTMLDivElement | null) => {
    if (surfaceViewportRef.current && terminalWheelListenerRef.current) {
      surfaceViewportRef.current.removeEventListener('wheel', terminalWheelListenerRef.current);
      terminalWheelListenerRef.current = null;
    }
    surfaceViewportRef.current = node;
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (surfaceResizeSettleTimerRef.current !== 0) {
      window.clearTimeout(surfaceResizeSettleTimerRef.current);
      surfaceResizeSettleTimerRef.current = 0;
    }
    pendingViewportSizeRef.current = null;
    // A freshly attached viewport (initial mount, or re-entering the terminal view)
    // takes its first measured size immediately; the settle only guards subsequent
    // changes while the node stays mounted.
    hasMeasuredSurfaceRef.current = false;
    if (!node) return;
    const onWheel = (event: globalThis.WheelEvent) => terminalWheelHandlerRef.current(event);
    node.addEventListener('wheel', onWheel, { passive: false });
    terminalWheelListenerRef.current = onWheel;
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      applyViewportSizeRef.current(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(node);
    resizeObserverRef.current = observer;
    // Eager first measure, then one more next frame: the viewport often reports 0
    // height for the first commit before its grid track resolves, so the eager
    // read is skipped and this rAF (plus the observer's own initial delivery)
    // catches the real size once layout settles.
    applyViewportSizeRef.current(node.clientWidth, node.clientHeight);
    requestAnimationFrame(() => applyViewportSizeRef.current(node.clientWidth, node.clientHeight));
  }, []);

  useEffect(() => {
    return () => {
      if (surfaceResizeSettleTimerRef.current !== 0) {
        window.clearTimeout(surfaceResizeSettleTimerRef.current);
        surfaceResizeSettleTimerRef.current = 0;
      }
      if (backendResizeTimerRef.current !== 0) {
        window.clearTimeout(backendResizeTimerRef.current);
        backendResizeTimerRef.current = 0;
      }
      if (historyResizeReplayTimerRef.current !== 0) {
        window.clearTimeout(historyResizeReplayTimerRef.current);
        historyResizeReplayTimerRef.current = 0;
      }
      if (historyJumpTimerRef.current !== 0) {
        window.clearTimeout(historyJumpTimerRef.current);
        historyJumpTimerRef.current = 0;
      }
      if (terminalDiagnosticTimerRef.current !== 0) {
        window.clearTimeout(terminalDiagnosticTimerRef.current);
        terminalDiagnosticTimerRef.current = 0;
      }
      if (surfaceViewportRef.current && terminalWheelListenerRef.current) {
        surfaceViewportRef.current.removeEventListener('wheel', terminalWheelListenerRef.current);
        terminalWheelListenerRef.current = null;
      }
      pendingViewportSizeRef.current = null;
      pendingBackendResizeRef.current = null;
      pendingHistoryResizeReplayRef.current = null;
      pendingHistoryJumpRef.current = null;
      flushTerminalDiagnostics();
    };
  }, []);

  async function recordMetrics(result: RenderMetrics) {
    try {
      await recordRenderMetrics(result);
    } catch (error) {
      if (isTauriRuntime)
        writeLog(`Unable to record metrics through Tauri: ${errorMessage(error)}`);
    }
  }

  function syncTerminalFrontendActivity(activeTerminalId: string | null) {
    const terminalIds = new Set(
      Object.values(useTerminalStore.getState().sessionTerminalBindings).map(
        binding => binding.terminalId,
      ),
    );
    for (const terminalId of terminalIds) {
      void setTerminalFrontendActive(terminalId, terminalId === activeTerminalId).catch(error => {
        if (isTauriRuntime) writeLog(`Terminal priority update failed: ${errorMessage(error)}`);
      });
    }
  }

  async function attachRuntimeSessionListeners(
    terminalId: string,
    session: ShellSession,
  ): Promise<() => void> {
    controller.tryMountRenderer();
    const interEventTimings = createTerminalMetricSamples();
    let cellsDrawn = 0;
    let framesReceived = 0;
    let droppedFrames = 0;
    let expectedSeq = 0;
    let lastEventAt: number | null = null;
    let receiveStarted: number | null = null;
    let startedPayload: TerminalStreamStartedPayload | null = null;
    let pendingTerminalFramePayloads: TerminalFramePayload[] = [];
    let terminalFrameRaf = 0;
    const renderAggregate = createTerminalRenderAggregate();
    const frameBatchAggregate = createTerminalFrameBatchAggregate();
    const unlisteners: UnlistenFn[] = [];
    const store = useTerminalStore.getState();

    function cleanup() {
      if (terminalFrameRaf) {
        cancelAnimationFrame(terminalFrameRaf);
        terminalFrameRaf = 0;
      }
      renderSampleCollectorsRef.current.delete(terminalId);
      for (const unlisten of unlisteners.splice(0)) unlisten();
    }

    renderSampleCollectorsRef.current.set(terminalId, sample =>
      recordTerminalPaintSample(renderAggregate, sample),
    );

    function paintPendingTerminalFrames() {
      terminalFrameRaf = 0;
      const payloads = pendingTerminalFramePayloads;
      pendingTerminalFramePayloads = [];
      if (payloads.length === 0) return;

      const frameStarted = performance.now();
      const isActive = useTerminalStore.getState().activeTerminalId === terminalId;
      terminalEventDebugRef.current.frameBatches += 1;
      terminalEventDebugRef.current.lastBatchSize = payloads.length;
      terminalEventDebugRef.current.lastBatchActive = isActive;
      terminalEventDebugRef.current.framePayloadsIngested += payloads.length;
      if (isActive) terminalEventDebugRef.current.activeFrameBatches += 1;
      controller.ingestFrames(
        session.id,
        payloads.map(payload => payload.frame),
        isActive,
      );
      if (isActive) settlePendingLiveTargetFromCache();
      const frameEnded = performance.now();
      recordTerminalFrameBatch(frameBatchAggregate, payloads.length, frameEnded - frameStarted);
      for (const payload of payloads) {
        cellsDrawn += payload.frame.rows.reduce((sum, row) => sum + row.cells.length, 0);
      }
    }

    function setSessionTerminalInputReady(inputArmed: boolean) {
      store.setSessionTerminalBindings(current => ({
        ...current,
        [session.id]: { terminalId, inputArmed },
      }));
      if (useTerminalStore.getState().activeTerminalId === terminalId) {
        store.setTerminalInputArmed(inputArmed);
      }
    }

    function clearActiveTerminal() {
      const currentStore = useTerminalStore.getState();
      const nextBindings = { ...currentStore.sessionTerminalBindings };
      delete nextBindings[session.id];
      const nextActiveTerminalId =
        currentStore.activeTerminalId === terminalId ? null : currentStore.activeTerminalId;
      store.setSessionTerminalBindings(nextBindings);
      store.setActiveTerminalId(nextActiveTerminalId);
      store.setTerminalInputArmed(
        terminalInputArmedForActiveId(nextBindings, nextActiveTerminalId),
      );
      store.setRunningSessionId(current => (current === session.id ? null : current));
      syncTerminalFrontendActivity(nextActiveTerminalId);
    }

    unlisteners.push(
      await listen<TerminalStreamStartedPayload>('terminal_stream_started', event => {
        if (event.payload.terminalId !== terminalId) return;
        startedPayload = event.payload;
        receiveStarted = performance.now();
        setSessionTerminalInputReady(true);
        syncTerminalFrontendActivity(useTerminalStore.getState().activeTerminalId);
        requestAnimationFrame(() => controller.focusCanvas());
        writeLog(
          `Runtime session started: terminal=${shortId(terminalId)} session=${shortId(session.id)} cols=${startedPayload.cols} rows=${startedPayload.rows}.`,
        );
        void loadWorkspaceShell();
      }),
    );

    unlisteners.push(
      await listen<TerminalFramePayload>('terminal_frame', event => {
        const payload = event.payload;
        terminalEventDebugRef.current.frameEventsSeen += 1;
        terminalEventDebugRef.current.lastFrameTerminalId = payload.terminalId;
        if (payload.terminalId !== terminalId) {
          terminalEventDebugRef.current.frameEventsMismatched += 1;
          return;
        }
        terminalEventDebugRef.current.frameEventsMatched += 1;
        terminalEventDebugRef.current.lastMatchedFrameSeq = payload.seq;

        const now = performance.now();
        if (receiveStarted === null) receiveStarted = now;
        if (lastEventAt !== null) interEventTimings.record(now - lastEventAt);
        lastEventAt = now;

        if (payload.seq !== expectedSeq) droppedFrames += Math.max(0, payload.seq - expectedSeq);
        expectedSeq = payload.seq + 1;
        framesReceived += 1;
        pendingTerminalFramePayloads.push(payload);
        if (!terminalFrameRaf) terminalFrameRaf = requestAnimationFrame(paintPendingTerminalFrames);
      }),
    );

    unlisteners.push(
      await listen<TerminalExitPayload>('terminal_exit', event => {
        const finished = event.payload;
        if (finished.terminalId !== terminalId) return;

        if (pendingTerminalFramePayloads.length > 0) {
          if (terminalFrameRaf) {
            cancelAnimationFrame(terminalFrameRaf);
            terminalFrameRaf = 0;
          }
          paintPendingTerminalFrames();
        }
        const receiveElapsed = receiveStarted === null ? 0 : performance.now() - receiveStarted;
        cleanup();
        clearActiveTerminal();
        const { avgFrameMs, p95FrameMs, maxFrameMs, ...frameBatchMetrics } =
          terminalFrameBatchRenderMetrics(frameBatchAggregate, framesReceived);
        const interEvents = interEventTimings.summary();
        const result: RenderMetrics = {
          mode: 'Cortex adapter terminal session',
          terminalId,
          frames: finished.framesEmitted,
          framesReceived,
          droppedFrames,
          chunksRead: finished.chunksRead,
          cellsDrawn,
          elapsedMs: receiveElapsed,
          avgFrameMs,
          p95FrameMs,
          maxFrameMs,
          cellsPerSecond: cellsDrawn / Math.max(0.001, receiveElapsed / 1000),
          outputBytes: finished.bytesRead,
          rustElapsedMs: finished.rustElapsedMs,
          totalEmitMs: finished.totalEmitMs,
          avgEmitMs: finished.avgEmitMs,
          maxEmitMs: finished.maxEmitMs,
          avgInterEventMs: interEvents.average,
          p95InterEventMs: interEvents.p95,
          maxInterEventMs: interEvents.max,
          childSuccess: finished.childSuccess,
          targetFrames: startedPayload?.targetFrames ?? undefined,
          ...frameBatchMetrics,
          ...terminalRenderMetrics(renderAggregate),
          ...terminalTraceMetrics(terminalTraceRef.current),
        };
        writeLog(
          `Runtime session exited: terminal=${shortId(terminalId)} received=${result.framesReceived}/${result.frames} chunks=${result.chunksRead}.`,
        );
        void recordMetrics(result);
        void loadWorkspaceShell();
      }),
    );

    unlisteners.push(
      await listen<TerminalFailedPayload>('terminal_failed', event => {
        const failedTerminalId = event.payload?.terminalId;
        if (failedTerminalId && failedTerminalId !== terminalId) return;
        cleanup();
        clearActiveTerminal();
        writeLog(`Runtime session failed: ${event.payload?.message || 'terminal session failed'}`);
        void loadWorkspaceShell();
      }),
    );

    return cleanup;
  }

  function activateSession(session: ShellSession): boolean {
    const nav = useNavigationStore.getState();
    const store = useTerminalStore.getState();
    const binding = store.sessionTerminalBindings[session.id];
    nav.setSelectedSessionId(session.id);
    nav.setCreationMode(null);
    nav.setSurfaceMode('terminal');

    const view = controller.ensureSessionView(session.id);
    if (!binding) {
      if (view) controller.applyView(view);
      else controller.clear();
      store.setActiveTerminalId(null);
      store.setTerminalInputArmed(false);
      syncTerminalFrontendActivity(null);
      return false;
    }

    store.setActiveTerminalId(binding.terminalId);
    store.setRunningSessionId(session.id);
    store.setTerminalInputArmed(binding.inputArmed);
    syncTerminalFrontendActivity(binding.terminalId);
    if (view) controller.applyView(view);
    else controller.clear();
    requestAnimationFrame(() => controller.focusCanvas());
    return true;
  }

  async function launchSession(session: ShellSession, options: { manageBusy?: boolean } = {}) {
    const store = useTerminalStore.getState();
    const existing = store.sessionTerminalBindings[session.id];
    if (existing) {
      activateSession(session);
      writeLog(`${session.title} already owns terminal ${shortId(existing.terminalId)}.`);
      return;
    }
    // The binding is only registered after the first await below, so two
    // launches for the same session in one tick would both pass the check
    // above and each spawn a PTY (and a transcript writer) for that session,
    // whose writers then race on the same chunk seq. `launchingSessionId` is
    // set synchronously, so guarding on it collapses concurrent launches to one.
    if (store.launchingSessionId === session.id) {
      writeLog(`${session.title} is already launching; ignoring duplicate request.`);
      return;
    }

    useNavigationStore.getState().setSurfaceMode('terminal');
    if (options.manageBusy !== false) setBusy(true);
    store.setLaunchingSessionId(session.id);
    controller.resetScrollback();
    controller.applyView(controller.seedEmptyView(session.id));
    const terminalId = crypto.randomUUID();
    let cleanup: (() => void) | null = null;
    try {
      cleanup = await attachRuntimeSessionListeners(terminalId, session);
      const surface = controller.getSurface();
      const request: StartSessionRequest = {
        sessionId: session.id,
        terminalId,
        cols: surface.cols,
        rows: surface.rows,
        maxScrollback: DEFAULT_TERMINAL_SCROLLBACK_ROWS,
      };
      store.setSessionTerminalBindings(current => ({
        ...current,
        [session.id]: { terminalId, inputArmed: false },
      }));
      store.setTerminalInputArmed(false);
      store.setActiveTerminalId(terminalId);
      store.setRunningSessionId(session.id);
      writeLog(`Launching ${session.title} as its own terminal session.`);
      await startSession(request);
      void loadWorkspaceShell();
    } catch (error) {
      cleanup?.();
      const currentStore = useTerminalStore.getState();
      const nextBindings = { ...currentStore.sessionTerminalBindings };
      delete nextBindings[session.id];
      const nextActiveTerminalId =
        currentStore.activeTerminalId === terminalId ? null : currentStore.activeTerminalId;
      store.setSessionTerminalBindings(nextBindings);
      store.setActiveTerminalId(nextActiveTerminalId);
      store.setTerminalInputArmed(
        terminalInputArmedForActiveId(nextBindings, nextActiveTerminalId),
      );
      store.setRunningSessionId(current => (current === session.id ? null : current));
      store.setLaunchingSessionId(current => (current === session.id ? null : current));
      syncTerminalFrontendActivity(nextActiveTerminalId);
      writeLog(`Runtime session launch failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      if (options.manageBusy !== false) setBusy(false);
    }
  }

  function inputReady() {
    const store = useTerminalStore.getState();
    return Boolean(store.activeTerminalId && store.terminalInputArmed);
  }

  async function sendTerminalInput(input: string) {
    const terminalId = useTerminalStore.getState().activeTerminalId;
    if (!terminalId || !inputReady() || input.length === 0) return;
    const queues = terminalInputQueuesRef.current;
    const previous = queues.get(terminalId) ?? Promise.resolve();
    const send = async () => {
      try {
        await writeTerminalInput(terminalId, input);
      } catch (error) {
        writeLog(`Terminal input failed: ${errorMessage(error)}`);
      }
    };
    let next = previous.then(send, send);
    next = next.finally(() => {
      if (queues.get(terminalId) === next) {
        queues.delete(terminalId);
      }
    });
    queues.set(terminalId, next);
    await next;
  }

  async function sendTerminalViewportScroll(deltaRows: number) {
    const terminalId = useTerminalStore.getState().activeTerminalId;
    if (!terminalId || deltaRows === 0) return;
    try {
      await scrollTerminalViewport(terminalId, deltaRows);
    } catch (error) {
      writeLog(`Terminal scroll failed: ${errorMessage(error)}`);
    }
  }

  async function sendTerminalViewportToBottom() {
    const terminalId = useTerminalStore.getState().activeTerminalId;
    if (!terminalId) return;
    try {
      await scrollTerminalViewportToBottom(terminalId);
    } catch (error) {
      writeLog(`Follow live failed: ${errorMessage(error)}`);
    }
  }

  async function copySelectionToClipboard(): Promise<boolean> {
    const text = controller.getSelectionText();
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      writeLog(`Copy failed: ${errorMessage(error)}`);
      return false;
    }
  }

  // --- Find in terminal ---

  // Push the stored matches (absolute composite-row coords) to the renderer
  // overlay; the controller clips them to the painted window. Re-runs on every
  // painted frame (via the controller's onComposite) so highlights track
  // scrolling. Find operates on absolute history rows, so matches survive sparse
  // history-window swaps as the buffer fills.
  function applyFindOverlay() {
    const state = findRef.current;
    if (!state.open || state.matches.length === 0) {
      controller.clearSearch();
      return;
    }
    controller.setSearchMatches(
      state.matches.map(match => ({
        row: match.row,
        startCol: match.startCol,
        endCol: match.endCol,
      })),
    );
    const active = state.activeIndex >= 0 ? state.matches[state.activeIndex] : undefined;
    controller.setActiveMatch(
      active ? { row: active.row, startCol: active.startCol, endCol: active.endCol } : null,
    );
  }
  applyFindOverlayRef.current = applyFindOverlay;

  function scrollToActiveMatch() {
    const state = findRef.current;
    const match = state.activeIndex >= 0 ? state.matches[state.activeIndex] : undefined;
    if (!match) return;
    // Find lives in the full-history view, so navigation scrolls the frontend
    // viewport to the match's absolute row; the repaint re-applies the overlay.
    controller.scrollToHistoryRow(match.row);
    applyFindOverlay();
  }

  function topRowForMatch(row: number, surface: TerminalSurface) {
    return Math.max(0, row - Math.floor(surface.rows / 3));
  }

  function activeIndexForResolvedSearch(
    matches: FrameMatch[],
    query: string,
    caseSensitive: boolean,
  ) {
    const latest = findRef.current;
    const active = latest.activeIndex >= 0 ? latest.matches[latest.activeIndex] : undefined;
    return resolvedActiveMatchIndex(
      matches,
      latest.query === query && latest.caseSensitive === caseSensitive ? active : undefined,
    );
  }

  // Find searches the entire persisted session, not just the visible area. Rust
  // replays the durable transcript through Ghostty and returns capped row/column
  // matches plus the first paintable history window from the same replay.
  async function runSearch(query: string, caseSensitive: boolean) {
    findSearchSeqRef.current += 1;
    const searchSeq = findSearchSeqRef.current;
    const sessionId = useNavigationStore.getState().selectedSessionId;
    if (!sessionId || query.length === 0) {
      updateFind({ matches: [], total: 0, capped: false, activeIndex: -1, busy: false });
      controller.clearSearch();
      controller.setSearchActive(false);
      return;
    }
    updateFind({ busy: true });
    try {
      const surface = controller.getSurface();
      const historyRequest = startHistoryRequest(sessionId, surface);
      const openedHistory = !controller.isHistoryMode();
      const result = await terminalHistorySearchWindow(
        sessionId,
        query,
        caseSensitive,
        surface.cols,
        surface.rows,
      );
      if (searchSeq !== findSearchSeqRef.current || !historyRequestIsCurrent(historyRequest)) {
        return;
      }
      const matches = result.search.matches.slice(0, FIND_MAX_MATCHES);
      const activeIndex = activeIndexForResolvedSearch(matches, query, caseSensitive);
      const totalRows = resolveHistoryTotalRows(
        result.frame.scrollback?.totalRows,
        result.search.totalRows,
        surface.rows,
      );
      updateFind({
        matches,
        total: result.search.total,
        capped: result.search.capped || result.search.matches.length > matches.length,
        activeIndex,
        busy: false,
      });
      controller.enterHistoryWindow(
        result.frame,
        result.startRow,
        totalRows,
        false,
        activeIndex >= 0 ? topRowForMatch(matches[activeIndex].row, surface) : 0,
      );
      setHistoryViewing(true);
      if (activeIndex >= 0) {
        if (openedHistory) findEnteredHistoryRef.current = true;
        controller.setSearchActive(true);
        requestAnimationFrame(() => scrollToActiveMatch());
      } else {
        controller.clearSearch();
        controller.setSearchActive(false);
        if (openedHistory) {
          findEnteredHistoryRef.current = true;
        }
      }
    } catch (error) {
      if (searchSeq !== findSearchSeqRef.current) return;
      updateFind({ busy: false });
      writeLog(`Find failed: ${errorMessage(error)}`);
    }
  }

  function scheduleSearch(query: string, caseSensitive: boolean) {
    window.clearTimeout(findDebounceRef.current);
    findDebounceRef.current = window.setTimeout(() => {
      void runSearch(query, caseSensitive);
    }, FIND_DEBOUNCE_MS);
  }

  function openFind(prefill?: string) {
    // Find matches within a single row, so a multi-line selection prefill (lines
    // joined with \n) could never match. Seed from the first line of the prefill.
    const firstLine = prefill?.split('\n', 1)[0] ?? '';
    const query = firstLine.length > 0 ? firstLine : findRef.current.query;
    updateFind({ open: true, query });
    controller.setSearchActive(true);
    if (query.length > 0) void runSearch(query, findRef.current.caseSensitive);
  }

  function closeFind() {
    window.clearTimeout(findDebounceRef.current);
    findSearchSeqRef.current += 1;
    // If Find opened the full-history view, closing it returns to the live tail
    // (which also clears the find bar). Otherwise just dismiss the bar and stay
    // wherever the user is (e.g. a history view they opened themselves).
    if (findEnteredHistoryRef.current) {
      followLiveTerminalOutput();
      return;
    }
    controller.clearSearch();
    controller.setSearchActive(false);
    updateFind({ open: false, query: '', matches: [], total: 0, capped: false, activeIndex: -1 });
    controller.focusCanvas();
  }

  function setFindQuery(query: string) {
    updateFind({ query });
    scheduleSearch(query, findRef.current.caseSensitive);
  }

  function toggleFindCase() {
    const caseSensitive = !findRef.current.caseSensitive;
    updateFind({ caseSensitive });
    void runSearch(findRef.current.query, caseSensitive);
  }

  function moveFind(delta: number) {
    const state = findRef.current;
    if (state.matches.length === 0) return;
    updateFind({ activeIndex: cycleIndex(state.activeIndex, state.matches.length, delta) });
    scrollToActiveMatch();
  }

  function handleTerminalKeyDown(event: KeyboardEvent<HTMLCanvasElement | HTMLTextAreaElement>) {
    if (terminalTextComposingRef.current || event.nativeEvent.isComposing) return;

    // Cmd/Ctrl-F opens the find bar (never reaches the PTY), prefilled with the
    // current selection if any. Takes precedence over the selection shortcuts.
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      (event.key === 'f' || event.key === 'F')
    ) {
      event.preventDefault();
      openFind(controller.getSelectionText() || undefined);
      return;
    }

    // Selection-aware shortcuts take precedence while a selection exists. We do
    // not intercept a plain Ctrl-C (that stays SIGINT); copy is Cmd-C (macOS) or
    // Ctrl-Shift-C, matching terminal convention.
    if (controller.hasSelection()) {
      if (event.key === 'Escape') {
        event.preventDefault();
        controller.clearSelection();
        return;
      }
      const isCopyKey = event.key === 'c' || event.key === 'C';
      const copyCombo =
        (event.metaKey && !event.ctrlKey && isCopyKey) ||
        (event.ctrlKey && event.shiftKey && isCopyKey);
      if (copyCombo) {
        event.preventDefault();
        void copySelectionToClipboard();
        return;
      }
    }

    const input = terminalInputForKey(event, controller.getLastFrameModes());
    if (!input || !inputReady()) return;
    event.preventDefault();
    // Typing into the terminal drops any selection (standard terminal behavior),
    // which also lets tail-follow resume instead of staying pinned mid-scroll.
    controller.clearSelection();
    resumeLiveForUserInput();
    void sendTerminalInput(input);
  }

  function clearTerminalTextInput(event: { currentTarget: HTMLTextAreaElement }) {
    event.currentTarget.value = '';
  }

  function commitTerminalTextInput(text: string) {
    if (!inputReady() || text.length === 0) return;
    controller.clearSelection();
    resumeLiveForUserInput();
    void sendTerminalInput(text);
  }

  function handleTerminalCompositionStart() {
    terminalTextComposingRef.current = true;
  }

  function handleTerminalCompositionEnd(event: CompositionEvent<HTMLTextAreaElement>) {
    terminalTextComposingRef.current = false;
    const text = event.data || event.currentTarget.value;
    clearTerminalTextInput(event);
    commitTerminalTextInput(text);
  }

  function handleTerminalTextInput(event: FormEvent<HTMLTextAreaElement>) {
    if (terminalTextComposingRef.current) return;
    const value = event.currentTarget.value;
    clearTerminalTextInput(event);
    commitTerminalTextInput(value);
  }

  // Send pasted text to the terminal, wrapping in bracketed-paste markers when
  // the app requested that mode. Shared by the paste event + the menu action.
  async function pasteTextToTerminal(text: string) {
    if (!inputReady() || !text) return;
    resumeLiveForUserInput();
    const input = controller.getLastFrameModes()?.bracketedPaste
      ? `\x1b[200~${text}\x1b[201~`
      : text;
    await sendTerminalInput(input);
  }

  // Insert text (a dropped file's quoted path) into a specific session's
  // terminal, which need not be the active one (drag-to-tab routes to another
  // session). Returns whether it reached an armed terminal. Bracketed-paste
  // wrapping is applied only for the active session, whose live frame modes we
  // know; for a background session we send the path text as-is.
  async function insertTextIntoSession(sessionId: string, text: string): Promise<boolean> {
    if (!text) return false;
    const store = useTerminalStore.getState();
    const binding = store.sessionTerminalBindings[sessionId];
    if (!binding?.inputArmed) return false;
    const isActive = binding.terminalId === store.activeTerminalId;
    const payload =
      isActive && controller.getLastFrameModes()?.bracketedPaste
        ? `\x1b[200~${text}\x1b[201~`
        : text;
    try {
      await writeTerminalInput(binding.terminalId, payload);
      return true;
    } catch (error) {
      writeLog(`Drop insert failed: ${errorMessage(error)}`);
      return false;
    }
  }

  function handleTerminalPaste(event: ClipboardEvent<HTMLCanvasElement | HTMLTextAreaElement>) {
    if (!inputReady()) return;
    const text = event.clipboardData.getData('text');
    if (!text) return;
    event.preventDefault();
    void pasteTextToTerminal(text);
  }

  function resumeLiveForUserInput() {
    if (!controller.isHistoryMode() && controller.isLiveFollow()) return;
    followLiveTerminalOutput();
  }

  // Resolve once the newly-launched session's terminal input is armed, then
  // write the seed prompt into it. Bounded so a session that never arms (launch
  // failure) does not hang the caller.
  function seedPromptWhenArmed(sessionId: string, text: string, timeoutMs = 8000): Promise<void> {
    return new Promise(resolve => {
      const tryWrite = () => {
        const binding = useTerminalStore.getState().sessionTerminalBindings[sessionId];
        if (!binding?.inputArmed) return false;
        void writeTerminalInput(binding.terminalId, text);
        return true;
      };
      if (tryWrite()) {
        resolve();
        return;
      }
      const unsubscribe = useTerminalStore.subscribe(() => {
        if (tryWrite()) {
          unsubscribe();
          resolve();
        }
      });
      window.setTimeout(() => {
        unsubscribe();
        resolve();
      }, timeoutMs);
    });
  }

  // "Ask an agent about this": spin up a new session under the current focus,
  // seeded with the text. The new session inherits the current session's agent
  // kind + cwd so the context matches. The prompt is typed into the new session
  // but not auto-submitted, keeping it explicit/calm.
  async function askAgentAbout(text: string) {
    const focusId =
      useNavigationStore.getState().selectedFocusId ?? selectedSession?.focusId ?? null;
    if (!focusId) {
      writeLog('Ask an agent: select a focus first.');
      return;
    }
    // ShellSession.agentKind is a free string; coerce to the request's enum.
    const agentKind =
      (selectedSession?.agentKind as CreateSessionRecordRequest['agentKind']) ?? 'cortex_code';
    const cwd = selectedSession?.cwd ?? getUserHome();
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 40);
    const request: CreateSessionRecordRequest = {
      focusId,
      title: preview ? `Ask: ${preview}` : 'Ask an agent',
      agentKind,
      cwd,
      dangerousModeOverride: false,
    };
    try {
      const snapshot = await createSession(request);
      const created = snapshot.sessions[snapshot.sessions.length - 1];
      useShellStore.getState().setShell(snapshot);
      if (!created) return;
      useNavigationStore.getState().setSelectedSessionId(created.id);
      autostartSession(created);
      await seedPromptWhenArmed(created.id, text);
      writeLog(`Asked a new ${agentKind} session about the selection.`);
    } catch (error) {
      writeLog(`Ask an agent failed: ${errorMessage(error)}`);
    }
  }

  // Services the menu actions run against. Built fresh per menu open so values
  // like input-readiness are current.
  function buildMenuActionDeps(): ActionContextDeps {
    return {
      pasteText: pasteTextToTerminal,
      sendInput: sendTerminalInput,
      selectAll: () => interaction.selectAll(),
      clearSelection: () => controller.clearSelection(),
      openExternal: href => openExternalUrl(href),
      askAgent: prompt => askAgentAbout(prompt),
      openFind: prefill => openFind(prefill),
      canSendInput: () => inputReady(),
    };
  }

  // Resolve the right-click target and assemble the menu model.
  function buildContextMenu(menuContext: ContextMenuContext) {
    menuContext.event.preventDefault();
    const composite = controller.getComposite();
    if (!composite) {
      setContextMenu(null);
      return;
    }
    const event = menuContext.event;
    const probe: InteractionProbe = {
      cell: menuContext.cell,
      frame: composite,
      surface: controller.getSurface(),
      selection: menuContext.selection,
      selectionText: controller.getSelectionText(),
      modifiers: {
        shift: event.shiftKey,
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
      },
    };
    const target = resolveTopTarget(probe);
    if (!target) {
      setContextMenu(null);
      return;
    }
    const items = buildMenuItems(target, buildActionContext(buildMenuActionDeps()));
    if (items.length === 0) {
      setContextMenu(null);
      return;
    }
    setContextMenu({ open: true, x: event.clientX, y: event.clientY, items });
  }
  contextMenuHandlerRef.current = buildContextMenu;

  function focusTerminalCanvas(event?: MouseEvent<HTMLElement>) {
    event?.preventDefault();
    controller.focusCanvas();
  }

  function handleTerminalScroll(event: UIEvent<HTMLDivElement>) {
    controller.schedulePaintWindow();
    if (controller.isAutoScrolling()) {
      return;
    }
    const viewport = event.currentTarget;
    if (controller.getLastFrameModes()?.alternateScreen) {
      invalidateHistoryRequests();
      const target = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      if (Math.abs(viewport.scrollTop - target) > SCROLL_FOLLOW_EPSILON_PX) {
        viewport.scrollTop = target;
      }
      return;
    }
    if (controller.isHistoryMode()) {
      const surface = controller.getSurface();
      const metrics = useTerminalStore.getState().terminalScroll;
      const totalRows = Math.max(metrics?.totalRows ?? controller.getRowCount(), surface.rows);
      const maxStartRow = Math.max(0, totalRows - surface.rows);
      const targetRow = Math.max(0, Math.min(maxStartRow, currentHistoryTopRow(surface)));
      pendingHistoryScrollTargetRowRef.current = targetRow;
      if (targetRow >= maxStartRow) {
        pendingHistoryScrollTargetRowRef.current = null;
        followLiveTerminalOutput();
        return;
      }
      if (controller.scrollHistoryBufferedToRow(targetRow)) {
        pendingHistoryScrollTargetRowRef.current = null;
        cancelPendingHistoryJump();
        return;
      }
      if (targetRow === 0) {
        cancelLiveTopJump();
        cancelLiveScrollSettle();
        cancelPendingHistoryJump();
        void loadHistoryAtRow(targetRow, totalRows);
        return;
      }
      cancelLiveTopJump();
      cancelLiveScrollSettle();
      scheduleHistoryJump(targetRow, totalRows);
      return;
    }
    const following =
      viewport.scrollTop + viewport.clientHeight >=
      viewport.scrollHeight - SCROLL_FOLLOW_EPSILON_PX;
    if (!controller.isHistoryMode() && following) {
      invalidateHistoryRequests();
    }
    controller.setLiveFollow(following);
    if (!controller.isHistoryMode() && !following) {
      const surface = controller.getSurface();
      const metrics = useTerminalStore.getState().terminalScroll;
      const totalRows = Math.max(metrics?.totalRows ?? controller.getRowCount(), surface.rows);
      const maxStartRow = Math.max(0, totalRows - surface.rows);
      const targetRow = Math.max(0, Math.min(maxStartRow, currentHistoryTopRow(surface)));
      pendingHistoryScrollTargetRowRef.current = targetRow;
      if (controller.scrollBufferedToRow(targetRow)) {
        pendingHistoryScrollTargetRowRef.current = null;
        cancelPendingHistoryJump();
        return;
      }
      if (targetRow === 0) {
        cancelLiveTopJump();
        cancelLiveScrollSettle();
        cancelPendingHistoryJump();
        void loadHistoryAtRow(targetRow, totalRows);
        return;
      }
      scheduleHistoryJump(targetRow, totalRows);
    }
  }

  // Apply a wheel delta to the terminal: in the full-history view scroll the DOM
  // viewport; while live, use the frontend row cache first and jump into a
  // replayed history window when the target rows are not cached yet. Returns
  // whether it consumed the event, so the caller can preventDefault.
  function applyWheelScroll(delta: {
    deltaY: number;
    deltaMode: number;
    clientX?: number;
    clientY?: number;
    shiftKey?: boolean;
    altKey?: boolean;
    ctrlKey?: boolean;
  }): boolean {
    const surface = controller.getSurface();
    const deltaRows = terminalWheelDeltaRows(delta, surface);
    if (deltaRows === 0) return false;
    cancelPendingHistoryResizeReplay();
    const terminalId = useTerminalStore.getState().activeTerminalId;
    if (controller.isHistoryMode()) {
      const knownTotalRows = useTerminalStore.getState().terminalScroll?.totalRows;
      const targetRow = targetHistoryRowForHistoryScroll(deltaRows, surface);
      const maxStartRow = Math.max(
        0,
        Math.max(knownTotalRows ?? controller.getRowCount(), surface.rows) - surface.rows,
      );
      if (deltaRows > 0 && targetRow >= maxStartRow) {
        followLiveTerminalOutput();
        return true;
      }
      pendingHistoryScrollTargetRowRef.current = targetRow;
      if (controller.scrollHistoryBufferedToRow(targetRow)) {
        pendingHistoryScrollTargetRowRef.current = null;
        cancelPendingHistoryJump();
        return true;
      }
      if (targetRow === 0) {
        cancelLiveTopJump();
        cancelLiveScrollSettle();
        cancelPendingHistoryJump();
        void loadHistoryAtRow(targetRow);
        return true;
      }
      cancelLiveTopJump();
      cancelLiveScrollSettle();
      if (terminalId) scheduleHistoryJump(targetRow, knownTotalRows);
      return true;
    }
    const modes = controller.getLastFrameModes();
    if (!terminalId) return false;
    if (modes?.alternateScreen) {
      if (modes.mouseTracking && !delta.shiftKey) {
        const canvas = controller.getCanvas();
        const cell =
          canvas && delta.clientX !== undefined && delta.clientY !== undefined
            ? terminalMouseCellFromClientPoint(delta.clientX, delta.clientY, canvas, surface)
            : null;
        if (!cell || !inputReady()) return false;
        void sendTerminalInput(
          encodeSgrWheelEvent({
            cell,
            direction: deltaRows < 0 ? 'up' : 'down',
            modifiers: { alt: delta.altKey, ctrl: delta.ctrlKey },
          }),
        );
      } else if (deltaRows < 0) {
        enterAlternateScreenHistoryFromWheel(deltaRows, surface);
      }
      return true;
    }
    if (modes?.mouseTracking && !delta.shiftKey) {
      const canvas = controller.getCanvas();
      const cell =
        canvas && delta.clientX !== undefined && delta.clientY !== undefined
          ? terminalMouseCellFromClientPoint(delta.clientX, delta.clientY, canvas, surface)
          : null;
      if (!cell || !inputReady()) return false;
      void sendTerminalInput(
        encodeSgrWheelEvent({
          cell,
          direction: deltaRows < 0 ? 'up' : 'down',
          modifiers: { alt: delta.altKey, ctrl: delta.ctrlKey },
        }),
      );
      return true;
    }
    if (deltaRows < 0) {
      if (controller.isLiveFollow()) cancelPendingHistoryJump();
      controller.setLiveFollow(false);
    }
    const targetRow = targetHistoryRowForLiveScroll(deltaRows, surface);
    const hasPendingHistoryTarget = pendingHistoryScrollTargetRowRef.current !== null;
    const knownTotalRows = useTerminalStore.getState().terminalScroll?.totalRows;
    const totalRows = Math.max(knownTotalRows ?? controller.getRowCount(), surface.rows);
    const maxStartRow = Math.max(0, totalRows - surface.rows);
    if (deltaRows > 0) {
      if (targetRow >= maxStartRow) {
        followLiveTerminalOutput();
        return true;
      }
    }
    if (!hasPendingHistoryTarget && controller.scrollBufferedRows(deltaRows)) return true;
    pendingHistoryScrollTargetRowRef.current = targetRow;
    if (controller.scrollBufferedToRow(targetRow)) {
      pendingHistoryScrollTargetRowRef.current = null;
      invalidateHistoryRequests();
      return true;
    }
    if (targetRow === 0) {
      cancelLiveTopJump();
      cancelLiveScrollSettle();
      cancelPendingHistoryJump();
      void loadHistoryAtRow(targetRow, totalRows);
      return true;
    }
    cancelLiveTopJump();
    cancelLiveScrollSettle();
    scheduleHistoryJump(targetRow, totalRows, { fallbackDeltaRows: deltaRows });
    return true;
  }

  async function enterAlternateScreenHistoryFromWheel(deltaRows: number, surface: TerminalSurface) {
    const sessionId = useNavigationStore.getState().selectedSessionId;
    if (!sessionId) return;
    cancelLiveTopJump();
    cancelLiveScrollSettle();
    cancelPendingHistoryJump();
    cancelPendingHistoryResizeReplay();
    controller.setLiveFollow(false);
    try {
      const totalRows = Math.max(
        (await terminalHistoryInfo(sessionId, surface.cols, surface.rows)).totalRows,
        surface.rows,
      );
      const maxStartRow = Math.max(0, totalRows - surface.rows);
      if (maxStartRow === 0) return;
      const targetRow = clampWheelTargetRow(
        maxStartRow + deltaRows,
        deltaRows,
        maxStartRow,
        surface.rows,
      );
      pendingHistoryScrollTargetRowRef.current = targetRow;
      await loadHistoryAtRow(targetRow, totalRows);
    } catch (error) {
      writeLog(`Alternate screen history failed: ${errorMessage(error)}`);
    }
  }

  function handleTerminalWheel(event: WheelEvent<HTMLDivElement>) {
    if (applyWheelScroll(event)) event.preventDefault();
  }
  terminalWheelHandlerRef.current = event => {
    if (applyWheelScroll(event)) event.preventDefault();
  };

  // Edge-to-edge scroll target: the shell forwards wheel events that land in the
  // gaps around the terminal (beside the sidebar, the window padding) so hovering
  // anywhere over the stage scrolls the terminal, not just the grid itself.
  function forwardWheel(delta: { deltaY: number; deltaMode: number }) {
    applyWheelScroll(delta);
  }

  // Move the terminal to a scroll position (0 = top, 1 = bottom of content),
  // driven by the overlay scrollbar's thumb. History sets the DOM scrollTop; live
  // uses cached rows first, then swaps to a replayed history window if needed.
  function scrollToFraction(startFraction: number) {
    const metrics = useTerminalStore.getState().terminalScroll;
    if (!metrics?.scrollable) return;
    if (metrics.mode === 'history') {
      const target = Math.round(startFraction * metrics.totalRows);
      const clamped = Math.max(0, Math.min(metrics.totalRows - metrics.viewportRows, target));
      if (clamped >= Math.max(0, metrics.totalRows - metrics.viewportRows)) {
        followLiveTerminalOutput();
        return;
      }
      pendingHistoryScrollTargetRowRef.current = clamped;
      if (controller.scrollHistoryBufferedToRow(clamped)) {
        pendingHistoryScrollTargetRowRef.current = null;
        cancelPendingHistoryJump();
        return;
      }
      if (clamped === 0) {
        cancelLiveTopJump();
        cancelLiveScrollSettle();
        cancelPendingHistoryJump();
        void loadHistoryAtRow(clamped, metrics.totalRows);
        return;
      }
      cancelLiveTopJump();
      cancelLiveScrollSettle();
      scheduleHistoryJump(clamped, metrics.totalRows);
      return;
    }
    const terminalId = useTerminalStore.getState().activeTerminalId;
    if (!terminalId) return;
    const target = Math.round(startFraction * metrics.totalRows);
    const clamped = Math.max(0, Math.min(metrics.totalRows - metrics.viewportRows, target));
    const delta = clamped - metrics.offsetRows;
    if (delta === 0) return;
    if (delta < 0) controller.setLiveFollow(false);
    if (controller.scrollBufferedToRow(clamped)) return;
    pendingHistoryScrollTargetRowRef.current = clamped;
    if (clamped === 0) {
      cancelLiveTopJump();
      cancelLiveScrollSettle();
      cancelPendingHistoryJump();
      void loadHistoryAtRow(clamped, metrics.totalRows);
      return;
    }
    cancelLiveTopJump();
    cancelLiveScrollSettle();
    scheduleHistoryJump(clamped, metrics.totalRows, { fallbackDeltaRows: delta });
  }

  function followLiveTerminalOutput() {
    invalidateHistoryRequests();
    // Returning to the live tail also ends any full-history find session (its
    // match coordinates belong to the frozen history composite).
    if (findRef.current.open) {
      window.clearTimeout(findDebounceRef.current);
      findSearchSeqRef.current += 1;
      controller.clearSearch();
      controller.setSearchActive(false);
      findEnteredHistoryRef.current = false;
      updateFind({ open: false, query: '', matches: [], total: 0, capped: false, activeIndex: -1 });
    }
    // "Jump to latest" also leaves the full-history view.
    if (controller.isHistoryMode()) {
      controller.exitHistory();
      setHistoryViewing(false);
      controller.paintCurrent(useNavigationStore.getState().selectedSessionId);
    }
    controller.setLiveFollow(true);
    void sendTerminalViewportToBottom();
    requestAnimationFrame(() => {
      controller.scrollToTail();
      controller.focusCanvas();
    });
  }

  function targetHistoryRowForLiveScroll(deltaRows: number, surface: TerminalSurface) {
    const metrics = useTerminalStore.getState().terminalScroll;
    const totalRows = Math.max(metrics?.totalRows ?? controller.getRowCount(), surface.rows);
    const maxStartRow = Math.max(0, totalRows - surface.rows);
    const clampTarget = (row: number) =>
      clampWheelTargetRow(row, deltaRows, maxStartRow, surface.rows);
    if (pendingHistoryScrollTargetRowRef.current !== null) {
      return clampTarget(pendingHistoryScrollTargetRowRef.current + deltaRows);
    }
    if (controller.isLiveFollow() && metrics?.mode === 'live') {
      return clampTarget(metrics.offsetRows + deltaRows);
    }
    const viewport = controller.getViewport();
    if (!viewport) {
      return clampTarget((metrics?.offsetRows ?? maxStartRow) + deltaRows);
    }
    const inset = terminalInsetPx(surface);
    const targetTop = viewport.scrollTop + deltaRows * surface.cellHeight;
    return clampTarget(Math.floor((targetTop - inset.top) / surface.cellHeight));
  }

  function targetHistoryRowForHistoryScroll(deltaRows: number, surface: TerminalSurface) {
    const metrics = useTerminalStore.getState().terminalScroll;
    const totalRows = Math.max(metrics?.totalRows ?? controller.getRowCount(), surface.rows);
    const maxStartRow = Math.max(0, totalRows - surface.rows);
    const baseRow =
      pendingHistoryScrollTargetRowRef.current ??
      currentHistoryTopRow(surface, metrics?.offsetRows);
    return clampWheelTargetRow(baseRow + deltaRows, deltaRows, maxStartRow, surface.rows);
  }

  function clampWheelTargetRow(
    row: number,
    deltaRows: number,
    maxStartRow: number,
    viewportRows: number,
  ) {
    const clamped = Math.max(0, Math.min(maxStartRow, row));
    const boundarySnapRows = Math.max(1, viewportRows * 4);
    if (deltaRows < 0 && clamped <= boundarySnapRows) return 0;
    if (deltaRows > 0 && maxStartRow - clamped <= boundarySnapRows) return maxStartRow;
    return clamped;
  }

  function currentHistoryTopRow(surface: TerminalSurface, fallbackRow = controller.getStartRow()) {
    const viewport = controller.getViewport();
    if (!viewport) return Math.max(0, fallbackRow);
    const inset = terminalInsetPx(surface);
    return Math.max(0, Math.floor((viewport.scrollTop - inset.top) / surface.cellHeight));
  }

  async function loadHistoryAtRow(targetRow: number, knownTotalRows?: number) {
    const sessionId = useNavigationStore.getState().selectedSessionId;
    if (!sessionId) return false;
    if (!controller.isHistoryMode()) {
      if (settlePendingLiveTargetFromCache()) return true;
      schedulePendingTargetSettle();
    }
    const surface = controller.getSurface();
    return historyJumpQueueRef.current.enqueue({
      sessionId,
      cols: surface.cols,
      rows: surface.rows,
      targetRow,
      knownTotalRows,
    });
  }

  function requestLiveRows(request: TerminalHistoryRowsRequest) {
    if (controller.isHistoryMode()) return false;
    const sessionId = useNavigationStore.getState().selectedSessionId;
    if (!sessionId) return false;
    const surface = controller.getSurface();
    const key = `${sessionId}:${surface.cols}:${surface.rows}:${request.startRow}:${request.rowCount}:${request.totalRows}`;
    const fillLiveTail = controller.isLiveFollow();
    if (!fillLiveTail && pendingHistoryScrollTargetRowRef.current !== null) {
      const targetRow = pendingHistoryScrollTargetRowRef.current;
      if (targetRow === 0 && pendingLiveTopJumpRef.current) return true;
      if (pendingLiveScrollTargetRowRef.current === targetRow) return true;
      if (
        pendingHistoryJumpRef.current?.targetRow !== targetRow &&
        !historyJumpQueueRef.current.isBusy()
      ) {
        scheduleHistoryJump(targetRow, request.totalRows);
      }
      return true;
    }
    if (liveMissingRowsRequestKeyRef.current !== null) return true;
    if (!fillLiveTail && historyJumpQueueRef.current.isBusy()) return true;
    liveMissingRowsRequestKeyRef.current = key;
    enqueueTerminalDiagnostic({
      kind: fillLiveTail ? 'live_cache_miss_fill' : 'live_cache_miss_history_jump',
      request,
      surface,
    });
    if (fillLiveTail) {
      void loadLiveTailRows(sessionId, surface, request, key);
      return true;
    }
    scheduleHistoryJump(request.startRow, request.totalRows, { liveMissingRowsKey: key });
    return true;
  }
  requestLiveRowsRef.current = requestLiveRows;

  async function loadLiveTailRows(
    sessionId: string,
    surface: TerminalSurface,
    request: TerminalHistoryRowsRequest,
    key: string,
  ) {
    try {
      const result = await terminalHistoryWindow(
        sessionId,
        request.startRow,
        surface.cols,
        surface.rows,
        request.rowCount,
      );
      const currentSurface = controller.getSurface();
      if (
        controller.isHistoryMode() ||
        liveMissingRowsRequestKeyRef.current !== key ||
        currentSurface.cols !== surface.cols ||
        currentSurface.rows !== surface.rows
      ) {
        // Abandoning this response (left live-tail, geometry changed mid-flight, or
        // a newer fill superseded us). Release the in-flight guard if we still own
        // it; otherwise no future live-tail fill can start and the live view stays
        // frozen until an unrelated event (e.g. a resize) happens to clear it.
        if (liveMissingRowsRequestKeyRef.current === key) {
          liveMissingRowsRequestKeyRef.current = null;
        }
        return;
      }
      const totalRows = resolveHistoryTotalRows(
        result.frame.scrollback?.totalRows,
        request.totalRows,
        surface.rows,
      );
      const merged = controller.mergeLiveRows(
        result.frame,
        result.startRow,
        totalRows,
        request.generation,
      );
      if (liveMissingRowsRequestKeyRef.current === key) liveMissingRowsRequestKeyRef.current = null;
      enqueueTerminalDiagnostic({
        kind: merged ? 'live_cache_miss_filled' : 'live_cache_miss_stale',
        request,
        returnedStartRow: result.startRow,
        returnedRows: result.frame.rows.length,
        totalRows,
      });
    } catch (error) {
      const currentSurface = controller.getSurface();
      if (
        controller.isHistoryMode() ||
        liveMissingRowsRequestKeyRef.current !== key ||
        currentSurface.cols !== surface.cols ||
        currentSurface.rows !== surface.rows
      ) {
        // Abandoning this response (left live-tail, geometry changed mid-flight, or
        // a newer fill superseded us). Release the in-flight guard if we still own
        // it; otherwise no future live-tail fill can start and the live view stays
        // frozen until an unrelated event (e.g. a resize) happens to clear it.
        if (liveMissingRowsRequestKeyRef.current === key) {
          liveMissingRowsRequestKeyRef.current = null;
        }
        return;
      }
      liveMissingRowsRequestKeyRef.current = null;
      enqueueTerminalDiagnostic({
        kind: 'live_cache_miss_fill_failed',
        request,
        message: errorMessage(error),
      });
    }
  }

  async function runHistoryJump(request: HistoryJumpRequest) {
    const currentSurface = controller.getSurface();
    const requestSurface = {
      ...currentSurface,
      cols: request.cols,
      rows: request.rows,
    };
    enqueueTerminalDiagnostic({
      kind: 'history_jump_start',
      request,
      currentSurface,
    });
    const historyRequest = startHistoryRequest(request.sessionId, requestSurface, {
      clearJumpQueue: false,
      preserveLiveMissingRows: true,
      preserveScrollTarget: true,
    });
    try {
      if (controller.isLiveFollow()) {
        liveMissingRowsRequestKeyRef.current = null;
        pendingHistoryScrollTargetRowRef.current = null;
        enqueueTerminalDiagnostic({
          kind: 'history_jump_discarded_for_live_follow',
          request,
        });
        return true;
      }
      const cacheKey = historyInfoCacheKey(request.sessionId, request.cols, request.rows);
      let totalRows =
        request.knownTotalRows === undefined
          ? historyInfoCacheRef.current.get(cacheKey)
          : request.knownTotalRows;
      if (totalRows === undefined) {
        totalRows = Math.max(
          (await terminalHistoryInfo(request.sessionId, request.cols, request.rows)).totalRows,
          request.rows,
        );
        historyInfoCacheRef.current.set(cacheKey, totalRows);
      } else {
        totalRows = Math.max(totalRows, request.rows);
      }
      if (!historyRequestIsCurrent(historyRequest)) {
        enqueueTerminalDiagnostic({ kind: 'history_jump_stale_before_window', request });
        return true;
      }
      const plan = planHistoryWindowForTargetRow(request.targetRow, request.rows, totalRows);
      const windowResult = await terminalHistoryWindow(
        request.sessionId,
        plan.startRow,
        request.cols,
        request.rows,
        plan.rowCount,
      );
      if (historyJumpQueueRef.current.hasPending()) {
        enqueueTerminalDiagnostic({
          kind: 'history_jump_discarded_for_newer_request',
          request,
          plan,
        });
        return true;
      }
      if (!historyRequestIsCurrent(historyRequest)) {
        enqueueTerminalDiagnostic({ kind: 'history_jump_stale_after_window', request, plan });
        return true;
      }
      const resolvedTotalRows = resolveHistoryTotalRows(
        windowResult.frame.scrollback?.totalRows,
        totalRows,
        request.rows,
      );
      if (controller.isLiveFollow()) {
        liveMissingRowsRequestKeyRef.current = null;
        enqueueTerminalDiagnostic({
          kind: 'history_jump_discarded_for_live_follow',
          request,
          plan,
        });
        return true;
      }
      historyInfoCacheRef.current.set(cacheKey, resolvedTotalRows);
      controller.enterHistoryWindow(
        windowResult.frame,
        windowResult.startRow,
        resolvedTotalRows,
        false,
        plan.targetRow,
      );
      if (
        pendingHistoryScrollTargetRowRef.current === request.targetRow ||
        pendingHistoryScrollTargetRowRef.current === plan.targetRow
      ) {
        pendingHistoryScrollTargetRowRef.current = null;
      }
      liveMissingRowsRequestKeyRef.current = null;
      setHistoryViewing(true);
      requestAnimationFrame(() => {
        controller.focusCanvas();
      });
      enqueueTerminalDiagnostic({
        kind: 'history_jump_merged',
        request,
        plan,
        returnedStartRow: windowResult.startRow,
        returnedRows: windowResult.frame.rows.length,
        resolvedTotalRows,
      });
      return true;
    } catch (error) {
      if (
        controller.isLiveFollow() ||
        historyJumpQueueRef.current.hasPending() ||
        !historyRequestIsCurrent(historyRequest)
      ) {
        enqueueTerminalDiagnostic({
          kind: 'history_jump_stale_after_window',
          request,
        });
        return true;
      }
      enqueueTerminalDiagnostic({
        kind: 'history_jump_failed',
        request,
        message: errorMessage(error),
      });
      writeLog(`History jump failed: ${errorMessage(error)}`);
      return false;
    }
  }
  runHistoryJumpRef.current = runHistoryJump;

  async function requestHistoryRows(request: TerminalHistoryRowsRequest) {
    pendingHistoryRowsRequestRef.current = request;
    if (loadingHistoryRowsRef.current) return;

    loadingHistoryRowsRef.current = true;
    try {
      while (pendingHistoryRowsRequestRef.current) {
        const next = pendingHistoryRowsRequestRef.current;
        pendingHistoryRowsRequestRef.current = null;
        await loadMissingHistoryRows(next);
      }
    } finally {
      loadingHistoryRowsRef.current = false;
    }
  }

  async function loadMissingHistoryRows(request: TerminalHistoryRowsRequest) {
    const sessionId = useNavigationStore.getState().selectedSessionId;
    if (!sessionId || !controller.isHistoryMode()) return;
    const surface = controller.getSurface();
    const historyRequest = currentHistoryRequest(sessionId, surface);
    const plan = planHistoryWindowForMissingRows(
      request.startRow,
      request.rowCount,
      surface.rows,
      request.totalRows,
    );
    const key = `${request.generation}:${sessionId}:${surface.cols}:${surface.rows}:${plan.startRow}:${plan.rowCount}`;
    if (historyWindowRequestsRef.current.has(key)) return;
    historyWindowRequestsRef.current.add(key);
    try {
      const result = await terminalHistoryWindow(
        sessionId,
        plan.startRow,
        surface.cols,
        surface.rows,
        plan.rowCount,
      );
      if (!controller.isHistoryMode() || !historyRequestIsCurrent(historyRequest)) return;
      const totalRows = resolveHistoryTotalRows(
        result.frame.scrollback?.totalRows,
        request.totalRows,
        surface.rows,
      );
      controller.mergeHistoryWindow(result.frame, result.startRow, totalRows, request.generation);
    } catch (error) {
      if (!controller.isHistoryMode() || !historyRequestIsCurrent(historyRequest)) return;
      writeLog(`History rows failed: ${errorMessage(error)}`);
    } finally {
      historyWindowRequestsRef.current.delete(key);
    }
  }
  requestHistoryRowsRef.current = requestHistoryRows;

  // Fetch persisted transcript history replayed at `surface`'s width and hand it
  // to the controller's history view. The initial view uses a bounded window and
  // lazily fills missing rows as the user scrolls.
  async function loadFullHistory(surface: TerminalSurface, scrollToBottom = true) {
    const sessionId = useNavigationStore.getState().selectedSessionId;
    if (!sessionId) return false;
    const historyRequest = startHistoryRequest(sessionId, surface);
    try {
      const info = await terminalHistoryInfo(sessionId, surface.cols, surface.rows);
      if (!historyRequestIsCurrent(historyRequest)) return false;
      const totalRows = Math.max(info.totalRows, surface.rows);
      const rowCount = historyWindowRows(surface.rows, totalRows);
      const startRow = scrollToBottom ? Math.max(0, totalRows - rowCount) : 0;
      const windowResult = await terminalHistoryWindow(
        sessionId,
        startRow,
        surface.cols,
        surface.rows,
        rowCount,
      );
      if (!historyRequestIsCurrent(historyRequest)) return false;
      const resolvedTotalRows = resolveHistoryTotalRows(
        windowResult.frame.scrollback?.totalRows,
        totalRows,
        surface.rows,
      );
      controller.enterHistoryWindow(
        windowResult.frame,
        windowResult.startRow,
        resolvedTotalRows,
        scrollToBottom,
        scrollToBottom ? undefined : 0,
      );
      return true;
    } catch (error) {
      writeLog(`View full history failed: ${errorMessage(error)}`);
      return false;
    }
  }

  // Load the full persisted transcript (deep history) and show it as a
  // scrollable view, so the user can scroll back to the very beginning, beyond
  // Ghostty's in-memory cap and across restarts.
  async function viewFullHistory() {
    if (await loadFullHistory(controller.getSurface())) setHistoryViewing(true);
  }

  // Newly-created sessions launch as soon as the terminal surface mounts.
  function autostartSession(session: ShellSession) {
    let attempts = 0;
    const tryLaunch = () => {
      if (!canvasRef.current || !surfaceViewportRef.current) {
        attempts += 1;
        if (attempts <= 12) window.setTimeout(tryLaunch, 25);
        else
          writeLog(
            `Autostart session delayed: terminal surface did not mount for ${session.title}.`,
          );
        return;
      }
      controller.paintCurrent(useNavigationStore.getState().selectedSessionId);
      void launchSession(session).catch(error =>
        writeLog(`Autostart session failed: ${errorMessage(error)}`),
      );
    };
    window.setTimeout(tryLaunch, 0);
  }

  return {
    canvasRef,
    terminalTextInputRef,
    surfaceViewportRef,
    attachViewport,
    terminalScrollSpacerRef,
    handleTerminalKeyDown,
    handleTerminalCompositionStart,
    handleTerminalCompositionEnd,
    handleTerminalTextInput,
    handleTerminalPaste,
    focusTerminalCanvas,
    handleTerminalScroll,
    handleTerminalWheel,
    followLiveTerminalOutput,
    launchSession,
    activateSession,
    autostartSession,
    contextMenu,
    closeContextMenu: () => setContextMenu(null),
    find: {
      open: find.open,
      query: find.query,
      caseSensitive: find.caseSensitive,
      current: find.activeIndex >= 0 ? find.activeIndex + 1 : 0,
      total: find.total,
      capped: find.capped,
      busy: find.busy,
    },
    openFind,
    closeFind,
    setFindQuery,
    toggleFindCase,
    findNext: () => moveFind(1),
    findPrev: () => moveFind(-1),
    historyViewing,
    viewFullHistory,
    forwardWheel,
    scrollbar: {
      metrics: terminalScroll,
      scrollToFraction,
    },
    clearSurface: () => controller.clear(),
    dropSession: (sessionId: string) => controller.dropSession(sessionId),
    insertTextIntoSession,
  };
}

// The handle returned by useTerminalSession: the DOM refs the React tree binds,
// the input/scroll handlers, and the session lifecycle senders. Components that
// render the terminal surface accept (a slice of) this so the hook stays the
// single owner of the imperative island.
export type TerminalSession = ReturnType<typeof useTerminalSession>;
