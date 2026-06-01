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
  readTerminalRows,
  recordRenderMetrics,
  recordTerminalDiagnostics,
  resizeTerminal,
  setTerminalFrontendActive,
  setTerminalTheme,
  startSession,
  writeTerminalInput,
} from '../services/terminalApi';
import {
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
  TerminalStreamStartedPayload,
} from '../domain';
import type { TerminalFrame } from '../terminalTypes';
import {
  decodeRowBand,
  decodeTerminalFrame,
  type DecodedTerminalFrame,
} from '../terminal/wireDecode';
import type { TerminalBridgeFramePayload } from '../services/terminalBridge';
import { createSession } from '../services/shellApi';
import { TERMINAL_SURFACE } from '../terminal-canvas-renderer';
import {
  SCROLL_FOLLOW_EPSILON_PX,
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
const TERMINAL_DIAGNOSTIC_FLUSH_MS = 500;
const TERMINAL_DIAGNOSTIC_BATCH_LIMIT = 100;
const TERMINAL_SLOW_PAINT_MS = 24;

interface TerminalDebugApi {
  trace: () => TimedTerminalControllerTraceEvent[];
  clear: () => void;
  summary: () => Record<string, unknown>;
  visibleRows: () => Array<{ index: number; text: string }>;
}

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
  let terminalLiveRowRequests = 0;
  let terminalBufferCacheMisses = 0;
  let terminalLiveBufferCacheMisses = 0;
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
      terminalLiveRowRequests += 1;
    } else if (event.kind === 'buffer_cache_miss') {
      terminalBufferCacheMisses += 1;
      terminalLiveBufferCacheMisses += 1;
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
    terminalLiveRowRequests,
    terminalBufferCacheMisses,
    terminalLiveBufferCacheMisses,
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
  // In-flight history-range prefetches, keyed by `terminalId:generation:start:count`,
  // so a band that is still round-tripping is never re-requested every paint (the
  // paint loop asks again until the rows land in the mirror). Cleared per key when
  // the fetch settles. Lives in a ref so the long-lived controller callback always
  // sees the current set without re-creating the controller.
  const inFlightRowFetchesRef = useRef<Set<string>>(new Set());

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

  // The controller calls this (synchronously, from the paint loop) when scrolling
  // up lands on rows the mirror does not have yet. We kick off an async
  // history-range prefetch and return true so the controller marks the request
  // issued; the rows are merged later via `controller.mergeLiveRows` when the
  // band lands. Dispatched through a ref so the long-lived controller callback
  // always sees the latest closure without re-creating the controller.
  const requestMissingLiveRowsRef = useRef<
    (request: TerminalHistoryRowsRequest) => boolean | undefined
  >(() => false);

  const controllerRef = useRef<TerminalController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createTerminalController({
      surface: TERMINAL_SURFACE,
      onScrollbackRowCount: count => useTerminalStore.getState().setScrollbackRowCount(count),
      onLiveFollow: live => {
        lastLiveFollowRef.current = live;
        useTerminalStore.getState().setTerminalLiveFollow(live);
      },
      onMissingLiveRows: request => requestMissingLiveRowsRef.current(request),
      onScrollMetrics: metrics => useTerminalStore.getState().setTerminalScroll(metrics),
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
    controller.resetInteraction();
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

    controller.setSurface(next);
    useTerminalStore.getState().setTerminalSurface(next);
    controller.paintCurrent(useNavigationStore.getState().selectedSessionId, next);

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
  ): Promise<{ cleanup: () => void; onFrame: unknown }> {
    controller.tryMountRenderer();
    const interEventTimings = createTerminalMetricSamples();
    let cellsDrawn = 0;
    let framesReceived = 0;
    let droppedFrames = 0;
    let lastEventAt: number | null = null;
    let receiveStarted: number | null = null;
    let startedPayload: TerminalStreamStartedPayload | null = null;
    // Latest backend generation this stream has accepted. A resize bumps the
    // backend generation and is immediately followed by a Full frame; the
    // frontend adopts that generation from the Full frame and drops any frame
    // whose generation is older than the latest. See wire-protocol.md.
    let latestGeneration = 0;
    let pendingTerminalFramePayloads: { frame: TerminalFrame }[] = [];
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

    // Apply the wire-protocol generation rules to one decoded frame, then queue
    // it for the existing rAF-batched ingest path. Shared by both transports
    // (Tauri Channel + harness SSE bridge) so they behave identically.
    function handleDecodedFrame(decoded: DecodedTerminalFrame) {
      terminalEventDebugRef.current.frameEventsSeen += 1;
      terminalEventDebugRef.current.lastFrameTerminalId = terminalId;

      // Drop a frame older than the latest generation we have accepted. A Full
      // frame adopts (resets to) its generation and rebuilds the mirror; a diff
      // that runs ahead of the current baseline (no Full seen yet) is dropped,
      // never merged across generations.
      if (decoded.generation < latestGeneration) {
        droppedFrames += 1;
        return;
      }
      if (decoded.dirty === 'full') {
        latestGeneration = decoded.generation;
      } else if (decoded.generation > latestGeneration) {
        droppedFrames += 1;
        return;
      }

      // Sync the controller to the backend-adopted generation so history-range
      // requests and the merge gate are stamped with the backend's generation
      // (which starts at 1 and bumps on every resize), not a frontend-only token.
      // Without this the serve gate never matches and scroll-back past the live
      // mirror fetches nothing. Only sync for the active terminal: a background
      // session's frames must not move the visible session's request generation.
      if (useTerminalStore.getState().activeTerminalId === terminalId) {
        controller.setLiveGeneration(latestGeneration);
      }

      terminalEventDebugRef.current.frameEventsMatched += 1;
      terminalEventDebugRef.current.lastMatchedFrameSeq = framesReceived;

      const now = performance.now();
      if (receiveStarted === null) receiveStarted = now;
      if (lastEventAt !== null) interEventTimings.record(now - lastEventAt);
      lastEventAt = now;

      framesReceived += 1;
      pendingTerminalFramePayloads.push({ frame: decoded.frame });
      if (!terminalFrameRaf) terminalFrameRaf = requestAnimationFrame(paintPendingTerminalFrames);
    }

    // Frame transport. In the desktop app this is a per-session binary Tauri
    // Channel: each `start_session` gets a `Channel<ArrayBuffer>` and the worker
    // streams encoded frames over it (delivered here as ArrayBuffers). In the
    // browser harness there is no Tauri Channel, so frames arrive over the SSE
    // bridge as base64 of the same wire bytes; `terminalBridge` decodes them and
    // hands us a `TerminalBridgeFramePayload` via the JSON-event listen shim.
    let onFrame: unknown;
    if (isTauriRuntime) {
      const { Channel } = await import('@tauri-apps/api/core');
      const frameChannel = new Channel<ArrayBuffer>();
      frameChannel.onmessage = buffer => {
        handleDecodedFrame(decodeTerminalFrame(buffer));
      };
      onFrame = frameChannel;
    } else {
      // Two non-Tauri sources can deliver `terminal_frame`: the SSE bridge
      // (which decodes the binary wire format and sets `generation`/`dirty`),
      // and the in-memory fixture service used by the default harness (which
      // emits a synthetic frame with no generation). Derive both fields so the
      // generation rules apply uniformly: fixtures have no resizes, so they sit
      // at generation 1, and the frame carries its own dirty kind.
      unlisteners.push(
        await listen<Partial<TerminalBridgeFramePayload> & { frame: TerminalFrame }>(
          'terminal_frame',
          event => {
            const payload = event.payload;
            if (payload.terminalId && payload.terminalId !== terminalId) {
              terminalEventDebugRef.current.frameEventsMismatched += 1;
              return;
            }
            handleDecodedFrame({
              generation: payload.generation ?? 1,
              dirty: payload.dirty ?? payload.frame.dirty ?? 'full',
              frame: payload.frame,
            });
          },
        ),
      );
    }

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

    return { cleanup, onFrame };
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
      const listeners = await attachRuntimeSessionListeners(terminalId, session);
      cleanup = listeners.cleanup;
      const surface = controller.getSurface();
      const request: StartSessionRequest = {
        sessionId: session.id,
        terminalId,
        cols: surface.cols,
        rows: surface.rows,
      };
      store.setSessionTerminalBindings(current => ({
        ...current,
        [session.id]: { terminalId, inputArmed: false },
      }));
      store.setTerminalInputArmed(false);
      store.setActiveTerminalId(terminalId);
      store.setRunningSessionId(session.id);
      writeLog(`Launching ${session.title} as its own terminal session.`);
      // Pass the per-session binary frame Channel (desktop) to the backend; in
      // the harness `onFrame` is undefined and frames arrive over the bridge.
      await startSession(request, listeners.onFrame);
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

  // Prefetch a band of older rows the mirror is missing, straight from
  // libghostty's live buffer (decisions.md D6/D7). The controller calls the
  // synchronous `requestMissingLiveRows` below from its paint loop; this async
  // worker does the actual round-trip and merges the decoded band back into the
  // mirror. Scrolling itself never waits on this: the view keeps moving over the
  // mirror while the top-up lands in the background.
  async function fetchHistoryRowBand(request: TerminalHistoryRowsRequest): Promise<void> {
    const terminalId = useTerminalStore.getState().activeTerminalId;
    if (!terminalId) return;
    const startRow = Math.max(0, Math.floor(request.startRow));
    const count = Math.max(1, Math.floor(request.rowCount));
    const key = `${terminalId}:${request.generation}:${startRow}:${count}`;
    const inFlight = inFlightRowFetchesRef.current;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      const bytes = await readTerminalRows(terminalId, startRow, count, request.generation);
      // The active terminal may have changed while the band round-tripped; the
      // band belongs to the terminal we asked, so drop it if focus moved on
      // (the new session's own prefetch will fill its mirror).
      if (useTerminalStore.getState().activeTerminalId !== terminalId) return;
      const band = decodeRowBand(bytes);
      if (band.rows.length === 0) return;
      // The band rows are contiguous from `band.startRow` and 0-indexed within
      // the band, which is exactly the frame shape `mergeLiveRows` expects. The
      // merge is dropped if the generation no longer matches the live mirror (a
      // resize bumped it), so a stale band can never mix rows across generations.
      const frame: TerminalFrame = {
        dirty: 'full',
        cols: controller.getSurface().cols,
        rows: band.rows,
      };
      controller.mergeLiveRows(frame, band.startRow, request.totalRows, band.generation);
    } catch (error) {
      writeLog(`History rows fetch failed: ${errorMessage(error)}`);
    } finally {
      inFlight.delete(key);
    }
  }

  // Synchronous entry point the controller calls from its paint loop. Kick off
  // the async prefetch and report the request as issued (true) so the controller
  // does not keep re-tracing a miss; an in-flight band is deduped inside
  // `fetchHistoryRowBand`.
  requestMissingLiveRowsRef.current = request => {
    void fetchHistoryRowBand(request);
    return true;
  };

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

  function handleTerminalKeyDown(event: KeyboardEvent<HTMLCanvasElement | HTMLTextAreaElement>) {
    if (terminalTextComposingRef.current || event.nativeEvent.isComposing) return;

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
    if (controller.isLiveFollow()) return;
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
      const target = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      if (Math.abs(viewport.scrollTop - target) > SCROLL_FOLLOW_EPSILON_PX) {
        viewport.scrollTop = target;
      }
      return;
    }
    const following =
      viewport.scrollTop + viewport.clientHeight >=
      viewport.scrollHeight - SCROLL_FOLLOW_EPSILON_PX;
    controller.setLiveFollow(following);
    if (!following) {
      // Scrolled up off the live tail: paint from the mirror at the viewport's
      // top row. When the mirror runs low near the top, the controller prefetches
      // a band straight from libghostty's buffer via `onMissingLiveRows`
      // (decisions.md D6/D7); scrolling itself never round-trips.
      const surface = controller.getSurface();
      const inset = terminalInsetPx(surface);
      const targetRow = Math.max(
        0,
        Math.floor((viewport.scrollTop - inset.top) / surface.cellHeight),
      );
      controller.scrollBufferedToRow(targetRow);
    }
  }

  // Apply a wheel delta to the terminal. Mouse-tracking apps consume the wheel as
  // input; otherwise scroll back through the cached live buffer. Returns whether
  // it consumed the event, so the caller can preventDefault.
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
    const terminalId = useTerminalStore.getState().activeTerminalId;
    const modes = controller.getLastFrameModes();
    if (!terminalId) return false;
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
    if (modes?.alternateScreen) {
      // Alternate-screen apps without mouse tracking own the whole screen; there
      // is nothing to scroll back into.
      return true;
    }
    const metrics = useTerminalStore.getState().terminalScroll;
    const totalRows = Math.max(metrics?.totalRows ?? controller.getRowCount(), surface.rows);
    const maxStartRow = Math.max(0, totalRows - surface.rows);
    if (deltaRows > 0) {
      const offsetRows = metrics?.offsetRows ?? controller.getStartRow();
      if (offsetRows + surface.rows >= maxStartRow + surface.rows) {
        followLiveTerminalOutput();
        return true;
      }
    } else if (controller.isLiveFollow()) {
      controller.setLiveFollow(false);
    }
    controller.scrollBufferedRows(deltaRows);
    return true;
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
  // driven by the overlay scrollbar's thumb, scrolling within the cached live
  // buffer.
  function scrollToFraction(startFraction: number) {
    const metrics = useTerminalStore.getState().terminalScroll;
    if (!metrics?.scrollable) return;
    const terminalId = useTerminalStore.getState().activeTerminalId;
    if (!terminalId) return;
    const target = Math.round(startFraction * metrics.totalRows);
    const clamped = Math.max(0, Math.min(metrics.totalRows - metrics.viewportRows, target));
    const delta = clamped - metrics.offsetRows;
    if (delta === 0) return;
    if (clamped >= Math.max(0, metrics.totalRows - metrics.viewportRows)) {
      followLiveTerminalOutput();
      return;
    }
    if (delta < 0) controller.setLiveFollow(false);
    controller.scrollBufferedToRow(clamped);
  }

  // Jump back to the live tail and re-pin (the jump-to-bottom button + resume on
  // input). Fully frontend-local: the mirror already holds the latest rows, so
  // re-pinning and snapping the viewport to the tail is all it takes, with no
  // backend round-trip (decisions.md D6).
  function followLiveTerminalOutput() {
    controller.setLiveFollow(true);
    requestAnimationFrame(() => {
      controller.scrollToTail();
      controller.focusCanvas();
    });
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
