import { ArrowClockwise, Stop } from '@phosphor-icons/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, FormEvent, KeyboardEvent, UIEvent } from 'react';
import { css } from './styled-system/css';
import { Typography } from './components/primitives/Typography';
import {
  listenTerminalBridge,
  resizeTerminalBridgeSession,
  scrollTerminalBridgeViewportToBottom,
  startTerminalBridgeSession,
  terminateTerminalBridgeSession,
  terminalBridgeHistoryInfo,
  terminalBridgeHistoryWindow,
  terminalBridgeBaseUrl,
  terminalBridgeHealth,
  writeTerminalBridgeInput,
  type TerminalBridgeExitPayload,
  type TerminalBridgeFailedPayload,
  type TerminalBridgeFramePayload,
  type TerminalBridgeStartedPayload,
} from './services/terminalBridge';
import { terminalInputForKey, terminalWheelDeltaRows } from './domain/terminalInput';
import {
  createTerminalController,
  type TimedTerminalControllerTraceEvent,
} from './terminal/terminalController';
import { createTerminalCanvasRenderer } from './terminal-canvas-renderer';
import { createTerminalGpuRenderer } from './terminal-gpu-renderer';
import { terminalRowTextLayout } from './terminal/cellGeometry';
import {
  SCROLL_FOLLOW_EPSILON_PX,
  terminalInsetPx,
  terminalSurfaceForBounds,
  type TerminalSurface,
} from './terminalScrollback';
import type { TerminalFrame, TerminalRendererBackend } from './terminalTypes';
import {
  planHistoryWindowForMissingRows,
  planHistoryWindowForTargetRow,
  resolveHistoryTotalRows,
} from './terminal/historyWindowing';
import { createLatestHistoryJumpQueue, type HistoryJumpRequest } from './terminal/historyJumpQueue';

const DEBUG_SESSION_ID = 'terminal-bridge-debug-session';
const DEFAULT_SURFACE: TerminalSurface = {
  cols: 120,
  rows: 32,
  cellWidth: 9,
  cellHeight: 18,
};
const DEFAULT_SCROLLBACK_ROWS = 100_000;
const HISTORY_RESIZE_REPLAY_DEBOUNCE_MS = 240;
const HISTORY_SCROLL_JUMP_DEBOUNCE_MS = 90;
const PENDING_TARGET_SETTLE_FRAMES = 90;
const BRIDGE_HISTORY_PREFETCH_ROWS = 2_048;

declare global {
  interface Window {
    __REVERIE_TERMINAL_DEBUG__?: () => unknown;
  }
}

export function TerminalBridgeDebug() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const wheelHandlerRef = useRef<(event: globalThis.WheelEvent) => void>(() => {});
  const terminalIdRef = useRef<string>(crypto.randomUUID());
  const inputWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingFramesRef = useRef<TerminalFrame[]>([]);
  const paintRafRef = useRef(0);
  const resizeRafRef = useRef(0);
  const surfaceRef = useRef(DEFAULT_SURFACE);
  const bridgeStartedRef = useRef(false);
  const controllerRef = useRef<ReturnType<typeof createTerminalController> | null>(null);
  const liveHistoryRequestKeyRef = useRef<string | null>(null);
  const historyJumpKeyRef = useRef<string | null>(null);
  const historyJumpSeqRef = useRef(0);
  const lastLiveFollowRef = useRef(true);
  const pendingHistoryRowsRequestRef = useRef<{
    startRow: number;
    rowCount: number;
    totalRows: number;
    generation: number;
  } | null>(null);
  const pendingHistoryScrollTargetRowRef = useRef<number | null>(null);
  const pendingHistoryResizeReplayRef = useRef<{
    targetRow: number;
    knownTotalRows?: number;
  } | null>(null);
  const pendingHistoryJumpRef = useRef<{
    targetRow: number;
    knownTotalRows?: number;
    liveHistoryRequestKey?: string;
  } | null>(null);
  const pendingLiveTopJumpRef = useRef(false);
  const liveTopJumpRafRef = useRef(0);
  const pendingLiveScrollTargetRowRef = useRef<number | null>(null);
  const liveScrollSettleRafRef = useRef(0);
  const pendingTargetSettleRafRef = useRef(0);
  const historyResizeReplayTimerRef = useRef(0);
  const historyJumpTimerRef = useRef(0);
  const loadingHistoryRowsRef = useRef(false);
  const historyJumpQueueRef = useRef(
    createLatestHistoryJumpQueue(request => runBridgeHistoryJump(request)),
  );
  const bridgeHistoryTotalRowsRef = useRef<Map<string, number>>(new Map());
  const startupBackfillKeyRef = useRef<string | null>(null);
  const traceRef = useRef<TimedTerminalControllerTraceEvent[]>([]);

  const [surface, setSurface] = useState(DEFAULT_SURFACE);
  const [runKey, setRunKey] = useState(0);
  const [status, setStatus] = useState('starting');
  const [started, setStarted] = useState<TerminalBridgeStartedPayload | null>(null);
  const [lastFrame, setLastFrame] = useState<TerminalBridgeFramePayload | null>(null);
  const [exitPayload, setExitPayload] = useState<TerminalBridgeExitPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paintSummary, setPaintSummary] = useState({
    backend: 'none',
    rows: 0,
    cells: 0,
    elapsedMs: 0,
  });
  const [historyFills, setHistoryFills] = useState({
    requested: 0,
    merged: 0,
    failed: 0,
  });

  const commitSurface = useCallback((next: TerminalSurface) => {
    surfaceRef.current = next;
    setSurface(next);
  }, []);

  const backfillTranscriptTail = useCallback(async (terminalId: string, reason: string) => {
    const activeSurface = controllerRef.current?.getSurface() ?? surfaceRef.current;
    const key = `${terminalId}:${activeSurface.cols}:${activeSurface.rows}:${reason}`;
    if (startupBackfillKeyRef.current === key) return;
    startupBackfillKeyRef.current = key;
    setHistoryFills(value => ({ ...value, requested: value.requested + 1 }));
    try {
      const info = await terminalBridgeHistoryInfo(
        terminalId,
        activeSurface.cols,
        activeSurface.rows,
      );
      rememberBridgeHistoryTotalRows(activeSurface, info.totalRows);
      const rowCount = Math.max(1, Math.min(info.totalRows, activeSurface.rows));
      const startRow = Math.max(0, info.totalRows - rowCount);
      const result = await terminalBridgeHistoryWindow(
        terminalId,
        startRow,
        activeSurface.cols,
        activeSurface.rows,
        rowCount,
      );
      const latestSurface = controllerRef.current?.getSurface();
      if (
        terminalIdRef.current !== terminalId ||
        !latestSurface ||
        latestSurface.cols !== activeSurface.cols ||
        latestSurface.rows !== activeSurface.rows
      ) {
        return;
      }
      controllerRef.current?.ingestFrames(DEBUG_SESSION_ID, [result.frame], true);
      setHistoryFills(value => ({ ...value, merged: value.merged + 1 }));
    } catch (backfillError) {
      if (terminalIdRef.current === terminalId) {
        setHistoryFills(value => ({ ...value, failed: value.failed + 1 }));
        setError(errorMessage(backfillError));
      }
    } finally {
      if (startupBackfillKeyRef.current === key) startupBackfillKeyRef.current = null;
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: controller is stable; requestBridgeHistoryRows reads live refs.
  const controller = useMemo(
    () =>
      createTerminalController({
        surface: DEFAULT_SURFACE,
        onScrollbackRowCount: () => {},
        onLiveFollow: live => {
          const wasLive = lastLiveFollowRef.current;
          lastLiveFollowRef.current = live;
          if (live && !wasLive) clearBridgeHistoryWorkForLiveFollow();
        },
        onPaintSample: sample => {
          setPaintSummary({
            backend: sample.backend ?? 'unknown',
            rows: sample.rowsPainted,
            cells: sample.cellsPainted,
            elapsedMs: sample.elapsedMs,
          });
        },
        onTrace: event => {
          traceRef.current.push(event);
          if (traceRef.current.length > 120)
            traceRef.current.splice(0, traceRef.current.length - 120);
        },
        onMissingHistoryRows: request => {
          requestBridgeHistoryRows(request);
          return true;
        },
        onMissingLiveRows: request => {
          const surface = controllerRef.current?.getSurface() ?? surfaceRef.current;
          const terminalId = terminalIdRef.current;
          const key = `${terminalId}:${surface.cols}:${surface.rows}:${request.startRow}:${request.rowCount}:${request.totalRows}:${request.generation}`;
          if (controllerRef.current && !controllerRef.current.isLiveFollow()) {
            const pendingTarget = pendingHistoryScrollTargetRowRef.current;
            if (pendingTarget !== null) {
              if (pendingTarget === 0 && pendingLiveTopJumpRef.current) return true;
              if (pendingLiveScrollTargetRowRef.current === pendingTarget) return true;
              if (
                pendingHistoryJumpRef.current?.targetRow !== pendingTarget &&
                !historyJumpQueueRef.current.isBusy()
              ) {
                scheduleBridgeHistoryJump(pendingTarget, request.totalRows);
              }
              return true;
            }
            if (liveHistoryRequestKeyRef.current !== null || historyJumpQueueRef.current.isBusy()) {
              return true;
            }
            liveHistoryRequestKeyRef.current = key;
            scheduleBridgeHistoryJump(request.startRow, request.totalRows, {
              liveHistoryRequestKey: key,
            });
            return true;
          }
          if (liveHistoryRequestKeyRef.current !== null) return true;
          liveHistoryRequestKeyRef.current = key;
          setHistoryFills(value => ({ ...value, requested: value.requested + 1 }));
          void terminalBridgeHistoryWindow(
            terminalId,
            request.startRow,
            surface.cols,
            surface.rows,
            request.rowCount,
          )
            .then(result => {
              const activeSurface = controllerRef.current?.getSurface();
              if (
                liveHistoryRequestKeyRef.current !== key ||
                !activeSurface ||
                activeSurface.cols !== surface.cols ||
                activeSurface.rows !== surface.rows
              ) {
                return;
              }
              const totalRows = result.frame.scrollback?.totalRows ?? request.totalRows;
              const merged =
                controllerRef.current?.mergeLiveRows(
                  result.frame,
                  result.startRow,
                  totalRows,
                  request.generation,
                ) ?? false;
              liveHistoryRequestKeyRef.current = null;
              if (merged) setHistoryFills(value => ({ ...value, merged: value.merged + 1 }));
            })
            .catch(historyError => {
              if (liveHistoryRequestKeyRef.current === key) liveHistoryRequestKeyRef.current = null;
              setHistoryFills(value => ({ ...value, failed: value.failed + 1 }));
              setError(errorMessage(historyError));
            });
          return true;
        },
        createRenderer: (canvas, surface, displayRows) => {
          const backend = bridgeRendererBackend();
          const rendererSurface = {
            ...surface,
            rows: displayRows,
          };
          if (backend === 'canvas2d') {
            return createTerminalCanvasRenderer(canvas, rendererSurface);
          }
          return createTerminalGpuRenderer(canvas, {
            ...rendererSurface,
            preferredBackends: ['webgl2', 'canvas2d'],
          });
        },
      }),
    [],
  );
  controllerRef.current = controller;

  useLayoutEffect(() => {
    window.__REVERIE_TERMINAL_DEBUG__ = () => {
      const canvas = canvasRef.current;
      const viewport = viewportRef.current;
      const spacer = spacerRef.current;
      const composite = controller.getComposite();
      const controllerSurface = controller.getSurface();
      const canvasRect = canvas ? plainRect(canvas.getBoundingClientRect()) : null;
      const viewportRect = viewport ? plainRect(viewport.getBoundingClientRect()) : null;
      const spacerRect = spacer ? plainRect(spacer.getBoundingClientRect()) : null;
      const rows =
        composite?.rows.slice(0, 80).map(row => ({
          index: row.index,
          text: terminalRowTextLayout(row, controllerSurface.cols).text.trimEnd(),
        })) ?? [];
      const trace = traceRef.current.slice(-80);
      const lastPaint = lastPaintTrace(trace);
      return {
        status,
        terminalId: terminalIdRef.current,
        surface: controllerSurface,
        surfaceState: surface,
        started,
        lastFrameSeq: lastFrame?.seq ?? null,
        lastFrameRows: lastFrame?.frame.rows.length ?? 0,
        paintSummary,
        historyFills,
        pendingFrames: pendingFramesRef.current.length,
        paintRafScheduled: paintRafRef.current !== 0,
        resizeRafScheduled: resizeRafRef.current !== 0,
        controller: {
          startRow: controller.getStartRow(),
          rowCount: controller.getRowCount(),
          liveFollow: controller.isLiveFollow(),
          historyMode: controller.isHistoryMode(),
          knownHistoryRows: bridgeKnownHistoryTotalRows(controllerSurface),
          pendingHistoryScrollTarget: pendingHistoryScrollTargetRowRef.current,
          pendingHistoryJumpTarget: pendingHistoryJumpRef.current?.targetRow ?? null,
          historyJumpBusy:
            historyJumpQueueRef.current.isBusy() &&
            (pendingHistoryScrollTargetRowRef.current !== null ||
              pendingHistoryJumpRef.current !== null),
        },
        buffer: controller.getBufferDebug(),
        canvas: canvas
          ? {
              width: canvas.width,
              height: canvas.height,
              styleWidth: canvas.style.width,
              styleHeight: canvas.style.height,
              transform: canvas.style.transform,
              rect: canvasRect,
            }
          : null,
        spacer: spacer
          ? {
              clientWidth: spacer.clientWidth,
              clientHeight: spacer.clientHeight,
              scrollHeight: spacer.scrollHeight,
              styleWidth: spacer.style.width,
              styleHeight: spacer.style.height,
              rect: spacerRect,
            }
          : null,
        viewport: viewport
          ? {
              clientWidth: viewport.clientWidth,
              clientHeight: viewport.clientHeight,
              scrollTop: viewport.scrollTop,
              scrollHeight: viewport.scrollHeight,
              rect: viewportRect,
            }
          : null,
        rows,
        visibleRows: visibleRowsForPaint(
          rows,
          controllerSurface,
          canvasRect,
          viewportRect,
          lastPaint?.startRow,
        ),
        lastPaint,
        trace,
      };
    };
    return () => {
      delete window.__REVERIE_TERMINAL_DEBUG__;
    };
  }, [controller, historyFills, lastFrame, paintSummary, started, status, surface]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: history helpers read live refs.
  const applyMeasuredSurface = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return surfaceRef.current;
    const previous = controller.getSurface();
    const wasHistoryMode = controller.isHistoryMode();
    const wasLiveFollow = controller.isLiveFollow();
    const historyTopRow = currentBridgeHistoryTopRow(previous);
    const next = terminalSurfaceForBounds(viewport.clientWidth, viewport.clientHeight, previous);
    controller.setSurface(next);
    commitSurface(next);
    if (wasHistoryMode) {
      pendingHistoryScrollTargetRowRef.current = null;
      if (next.cols === previous.cols) {
        controller.paintWindow(undefined, next, 'history');
      } else {
        pendingHistoryScrollTargetRowRef.current = historyTopRow;
        controller.paintWindow(undefined, next, 'history');
        if (controller.scrollHistoryBufferedToRow(historyTopRow)) {
          pendingHistoryScrollTargetRowRef.current = null;
        }
        scheduleBridgeHistoryResizeReplay(historyTopRow);
      }
    } else {
      if (!wasLiveFollow && next.cols !== previous.cols) {
        pendingHistoryScrollTargetRowRef.current = historyTopRow === 0 ? null : historyTopRow;
        controller.paintCurrent(DEBUG_SESSION_ID, next);
        if (historyTopRow === 0) {
          cancelBridgeLiveTopJump();
          cancelBridgeLiveScrollSettle();
          historyJumpKeyRef.current = null;
          historyJumpSeqRef.current += 1;
          historyJumpQueueRef.current.clear();
          cancelBridgeHistoryResizeReplay();
          cancelBridgeHistoryJump();
          cancelBridgePendingTargetSettle();
        } else {
          scheduleBridgeHistoryResizeReplay(historyTopRow);
        }
      } else {
        controller.paintCurrent(DEBUG_SESSION_ID, next);
      }
    }
    return next;
  }, [commitSurface, controller]);

  function cancelBridgeHistoryResizeReplay() {
    pendingHistoryResizeReplayRef.current = null;
    if (historyResizeReplayTimerRef.current !== 0) {
      window.clearTimeout(historyResizeReplayTimerRef.current);
      historyResizeReplayTimerRef.current = 0;
    }
  }

  function scheduleBridgeHistoryResizeReplay(targetRow: number, knownTotalRows?: number) {
    pendingHistoryResizeReplayRef.current = { targetRow, knownTotalRows };
    if (historyResizeReplayTimerRef.current !== 0) {
      window.clearTimeout(historyResizeReplayTimerRef.current);
    }
    historyResizeReplayTimerRef.current = window.setTimeout(() => {
      historyResizeReplayTimerRef.current = 0;
      const pending = pendingHistoryResizeReplayRef.current;
      pendingHistoryResizeReplayRef.current = null;
      if (!pending) return;
      void loadBridgeHistoryAtRow(pending.targetRow, pending.knownTotalRows);
    }, HISTORY_RESIZE_REPLAY_DEBOUNCE_MS);
  }

  function cancelBridgeHistoryJump() {
    pendingHistoryJumpRef.current = null;
    if (historyJumpTimerRef.current !== 0) {
      window.clearTimeout(historyJumpTimerRef.current);
      historyJumpTimerRef.current = 0;
    }
  }

  function clearBridgeHistoryWorkForLiveFollow() {
    historyJumpKeyRef.current = null;
    historyJumpSeqRef.current += 1;
    historyJumpQueueRef.current.clear();
    pendingHistoryRowsRequestRef.current = null;
    pendingHistoryScrollTargetRowRef.current = null;
    liveHistoryRequestKeyRef.current = null;
    cancelBridgeLiveTopJump();
    cancelBridgeLiveScrollSettle();
    cancelBridgePendingTargetSettle();
    cancelBridgeHistoryResizeReplay();
    cancelBridgeHistoryJump();
  }

  function cancelBridgeLiveTopJump() {
    pendingLiveTopJumpRef.current = false;
    if (liveTopJumpRafRef.current !== 0) {
      cancelAnimationFrame(liveTopJumpRafRef.current);
      liveTopJumpRafRef.current = 0;
    }
  }

  function cancelBridgeLiveScrollSettle() {
    pendingLiveScrollTargetRowRef.current = null;
    if (liveScrollSettleRafRef.current !== 0) {
      cancelAnimationFrame(liveScrollSettleRafRef.current);
      liveScrollSettleRafRef.current = 0;
    }
  }

  function cancelBridgePendingTargetSettle() {
    if (pendingTargetSettleRafRef.current !== 0) {
      cancelAnimationFrame(pendingTargetSettleRafRef.current);
      pendingTargetSettleRafRef.current = 0;
    }
  }

  function settleBridgePendingTargetFromCache() {
    const targetRow = pendingHistoryScrollTargetRowRef.current;
    if (targetRow === null || controller.isHistoryMode()) return false;
    if (!scrollBridgeLiveBufferedAbsoluteTarget(targetRow)) return false;
    pendingHistoryScrollTargetRowRef.current = null;
    pendingLiveScrollTargetRowRef.current = null;
    pendingLiveTopJumpRef.current = false;
    liveHistoryRequestKeyRef.current = null;
    historyJumpKeyRef.current = null;
    historyJumpSeqRef.current += 1;
    historyJumpQueueRef.current.clear();
    cancelBridgeHistoryJump();
    cancelBridgeHistoryResizeReplay();
    cancelBridgePendingTargetSettle();
    return true;
  }

  function scheduleBridgePendingTargetSettle(attempt = 0) {
    if (pendingTargetSettleRafRef.current !== 0) {
      cancelAnimationFrame(pendingTargetSettleRafRef.current);
    }
    pendingTargetSettleRafRef.current = requestAnimationFrame(() => {
      pendingTargetSettleRafRef.current = 0;
      if (pendingHistoryScrollTargetRowRef.current === null || controller.isHistoryMode()) return;
      if (settleBridgePendingTargetFromCache()) return;
      if (attempt >= PENDING_TARGET_SETTLE_FRAMES) {
        pendingHistoryScrollTargetRowRef.current = null;
        pendingLiveScrollTargetRowRef.current = null;
        pendingLiveTopJumpRef.current = false;
        return;
      }
      scheduleBridgePendingTargetSettle(attempt + 1);
    });
  }

  function scheduleBridgeHistoryJump(
    targetRow: number,
    knownTotalRows?: number,
    options: { liveHistoryRequestKey?: string } = {},
  ) {
    if (controller.isLiveFollow()) {
      clearBridgeHistoryWorkForLiveFollow();
      return;
    }
    pendingHistoryJumpRef.current = {
      targetRow,
      knownTotalRows,
      liveHistoryRequestKey: options.liveHistoryRequestKey,
    };
    scheduleBridgePendingTargetSettle();
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
          pending.liveHistoryRequestKey &&
          liveHistoryRequestKeyRef.current === pending.liveHistoryRequestKey
        ) {
          liveHistoryRequestKeyRef.current = null;
        }
        pendingHistoryScrollTargetRowRef.current = null;
        return;
      }
      void loadBridgeHistoryAtRow(pending.targetRow, pending.knownTotalRows).then(loaded => {
        if (!loaded && pending.liveHistoryRequestKey) {
          if (liveHistoryRequestKeyRef.current === pending.liveHistoryRequestKey) {
            liveHistoryRequestKeyRef.current = null;
          }
        }
      });
    }, HISTORY_SCROLL_JUMP_DEBOUNCE_MS);
  }

  useEffect(() => {
    controller.attach({
      canvas: canvasRef.current,
      viewport: viewportRef.current,
      spacer: spacerRef.current,
      input: inputRef.current,
    });
    controller.applyView(controller.seedEmptyView(DEBUG_SESSION_ID));
    requestAnimationFrame(() => {
      applyMeasuredSurface();
      inputRef.current?.focus({ preventScroll: true });
    });
    return () => {
      controller.resetRenderer('terminal_bridge_debug_unmount');
    };
  }, [applyMeasuredSurface, controller]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      if (resizeRafRef.current !== 0) return;
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = 0;
        const next = applyMeasuredSurface();
        if (!bridgeStartedRef.current) return;
        const terminalId = terminalIdRef.current;
        void resizeTerminalBridgeSession(terminalId, next.cols, next.rows).catch(resizeError => {
          setError(errorMessage(resizeError));
        });
      });
    });
    observer.observe(viewport);
    return () => {
      observer.disconnect();
      if (resizeRafRef.current !== 0) {
        cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = 0;
      }
    };
  }, [applyMeasuredSurface]);

  useEffect(() => {
    void runKey;
    let cancelled = false;
    const terminalId = crypto.randomUUID();
    terminalIdRef.current = terminalId;
    bridgeStartedRef.current = false;
    pendingFramesRef.current = [];
    liveHistoryRequestKeyRef.current = null;
    historyJumpKeyRef.current = null;
    historyJumpSeqRef.current += 1;
    historyJumpQueueRef.current.clear();
    pendingHistoryRowsRequestRef.current = null;
    pendingHistoryScrollTargetRowRef.current = null;
    cancelBridgeLiveTopJump();
    cancelBridgeLiveScrollSettle();
    cancelBridgePendingTargetSettle();
    cancelBridgeHistoryResizeReplay();
    cancelBridgeHistoryJump();
    loadingHistoryRowsRef.current = false;
    bridgeHistoryTotalRowsRef.current.clear();
    startupBackfillKeyRef.current = null;
    setStatus('starting');
    setStarted(null);
    setLastFrame(null);
    setExitPayload(null);
    setError(null);
    setHistoryFills({ requested: 0, merged: 0, failed: 0 });

    const unlisten = [
      listenTerminalBridge<TerminalBridgeStartedPayload>('terminal_stream_started', event => {
        if (event.payload.terminalId !== terminalId) return;
        bridgeStartedRef.current = true;
        setStarted(event.payload);
        setStatus('running');
      }),
      listenTerminalBridge<TerminalBridgeFramePayload>('terminal_frame', event => {
        if (event.payload.terminalId !== terminalId) return;
        setLastFrame(event.payload);
        pendingFramesRef.current.push(event.payload.frame);
        if (paintRafRef.current !== 0) return;
        paintRafRef.current = requestAnimationFrame(() => {
          paintRafRef.current = 0;
          const frames = pendingFramesRef.current.splice(0);
          controller.ingestFrames(DEBUG_SESSION_ID, frames, true);
          settleBridgePendingTargetFromCache();
        });
      }),
      listenTerminalBridge<TerminalBridgeExitPayload>('terminal_exit', event => {
        if (event.payload.terminalId !== terminalId) return;
        setExitPayload(event.payload);
        setStatus('exited');
      }),
      listenTerminalBridge<TerminalBridgeFailedPayload>('terminal_failed', event => {
        if (event.payload.terminalId && event.payload.terminalId !== terminalId) return;
        setError(event.payload.message);
        setStatus('failed');
      }),
    ];

    void (async () => {
      try {
        await terminalBridgeHealth();
        const next = applyMeasuredSurface();
        if (cancelled) return;
        await startTerminalBridgeSession({
          terminalId,
          cols: next.cols,
          rows: next.rows,
          maxScrollback: DEFAULT_SCROLLBACK_ROWS,
        });
        bridgeStartedRef.current = true;
        window.setTimeout(() => {
          if (!cancelled && terminalIdRef.current === terminalId) {
            void backfillTranscriptTail(terminalId, 'startup');
          }
        }, 150);
      } catch (startError) {
        if (!cancelled) {
          setError(errorMessage(startError));
          setStatus('failed');
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const off of unlisten) off();
      if (paintRafRef.current !== 0) {
        cancelAnimationFrame(paintRafRef.current);
        paintRafRef.current = 0;
      }
      cancelBridgeHistoryResizeReplay();
      cancelBridgeLiveTopJump();
      cancelBridgeLiveScrollSettle();
      cancelBridgePendingTargetSettle();
      cancelBridgeHistoryJump();
      void terminateTerminalBridgeSession(terminalId).catch(() => {});
      bridgeStartedRef.current = false;
    };
  }, [applyMeasuredSurface, backfillTranscriptTail, controller, runKey]);

  function restart() {
    setRunKey(value => value + 1);
  }

  function stop() {
    void terminateTerminalBridgeSession(terminalIdRef.current);
  }

  function writeInput(input: string) {
    if (!input) return;
    followLiveForUserInput();
    const terminalId = terminalIdRef.current;
    const send = async () => {
      try {
        await writeTerminalBridgeInput(terminalId, input);
      } catch (inputError) {
        setError(errorMessage(inputError));
      }
    };
    inputWriteQueueRef.current = inputWriteQueueRef.current.then(send, send);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const input = terminalInputForKey(event, controller.getLastFrameModes());
    if (!input) return;
    event.preventDefault();
    writeInput(input);
  }

  function handleTextInput(event: FormEvent<HTMLTextAreaElement>) {
    const value = event.currentTarget.value;
    event.currentTarget.value = '';
    writeInput(value);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const text = event.clipboardData.getData('text');
    if (!text) return;
    event.preventDefault();
    writeInput(text);
  }

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    controller.schedulePaintWindow('scroll');
    if (controller.isAutoScrolling()) return;
    const viewport = event.currentTarget;
    if (controller.getLastFrameModes()?.alternateScreen) {
      historyJumpKeyRef.current = null;
      historyJumpSeqRef.current += 1;
      historyJumpQueueRef.current.clear();
      pendingHistoryRowsRequestRef.current = null;
      pendingHistoryScrollTargetRowRef.current = null;
      cancelBridgeLiveTopJump();
      cancelBridgeLiveScrollSettle();
      cancelBridgePendingTargetSettle();
      cancelBridgeHistoryResizeReplay();
      cancelBridgeHistoryJump();
      const target = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      if (Math.abs(viewport.scrollTop - target) > SCROLL_FOLLOW_EPSILON_PX) {
        viewport.scrollTop = target;
      }
      return;
    }
    if (controller.isHistoryMode()) {
      const activeSurface = controller.getSurface();
      const maxStartRow = bridgeMaxStartRow(activeSurface);
      const targetRow = Math.max(
        0,
        Math.min(maxStartRow, currentBridgeHistoryTopRow(activeSurface)),
      );
      pendingHistoryScrollTargetRowRef.current = targetRow;
      if (targetRow >= maxStartRow) {
        pendingHistoryScrollTargetRowRef.current = null;
        followLiveForUserInput();
        return;
      }
      if (controller.scrollHistoryBufferedToRow(targetRow)) {
        pendingHistoryScrollTargetRowRef.current = null;
        cancelBridgeHistoryJump();
        return;
      }
      if (targetRow === 0) {
        cancelBridgeLiveTopJump();
        cancelBridgeLiveScrollSettle();
        cancelBridgeHistoryJump();
        void loadBridgeHistoryAtRow(targetRow);
        return;
      }
      cancelBridgeLiveTopJump();
      cancelBridgeLiveScrollSettle();
      scheduleBridgeHistoryJump(targetRow);
      return;
    }
    const following =
      viewport.scrollTop + viewport.clientHeight >=
      viewport.scrollHeight - SCROLL_FOLLOW_EPSILON_PX;
    if (following) {
      historyJumpKeyRef.current = null;
      historyJumpSeqRef.current += 1;
      historyJumpQueueRef.current.clear();
      pendingHistoryScrollTargetRowRef.current = null;
      cancelBridgeLiveTopJump();
      cancelBridgeLiveScrollSettle();
      cancelBridgePendingTargetSettle();
      cancelBridgeHistoryJump();
    }
    controller.setLiveFollow(following);
    if (!controller.isHistoryMode() && !following) {
      const activeSurface = controller.getSurface();
      const maxStartRow = bridgeMaxStartRow(activeSurface);
      const targetRow = Math.max(
        0,
        Math.min(
          maxStartRow,
          bridgeLiveLocalBase(activeSurface) + currentBridgeHistoryTopRow(activeSurface),
        ),
      );
      pendingHistoryScrollTargetRowRef.current = targetRow;
      const localBase = bridgeLiveLocalBase(activeSurface);
      const localTarget = targetRow - localBase;
      const localMaxStart = Math.max(
        0,
        Math.max(controller.getRowCount(), activeSurface.rows) - activeSurface.rows,
      );
      const targetCached =
        localBase > 0
          ? localTarget >= 0 &&
            localTarget <= localMaxStart &&
            controller.scrollBufferedToRow(localTarget)
          : controller.scrollBufferedToRow(targetRow);
      if (targetCached) {
        pendingHistoryScrollTargetRowRef.current = null;
        cancelBridgeHistoryJump();
        return;
      }
      if (targetRow === 0) {
        cancelBridgeLiveTopJump();
        cancelBridgeLiveScrollSettle();
        cancelBridgeHistoryJump();
        void loadBridgeHistoryAtRow(targetRow);
        return;
      }
      scheduleBridgeHistoryJump(targetRow);
    }
  }

  function handleWheel(event: globalThis.WheelEvent) {
    const rows = terminalWheelDeltaRows(event, surface);
    if (rows === 0) return;
    event.preventDefault();
    cancelBridgeHistoryResizeReplay();
    if (controller.getLastFrameModes()?.alternateScreen) {
      historyJumpKeyRef.current = null;
      historyJumpSeqRef.current += 1;
      historyJumpQueueRef.current.clear();
      pendingHistoryRowsRequestRef.current = null;
      pendingHistoryScrollTargetRowRef.current = null;
      cancelBridgeLiveTopJump();
      cancelBridgeLiveScrollSettle();
      cancelBridgePendingTargetSettle();
      cancelBridgeHistoryJump();
      return;
    }
    if (controller.isHistoryMode()) {
      const targetRow = targetHistoryRowForBridgeScroll(rows);
      const activeSurface = controller.getSurface();
      const maxStartRow = bridgeMaxStartRow(activeSurface);
      if (rows > 0 && targetRow >= maxStartRow) {
        followLiveForUserInput();
        return;
      }
      pendingHistoryScrollTargetRowRef.current = targetRow;
      if (controller.scrollHistoryBufferedToRow(targetRow)) {
        pendingHistoryScrollTargetRowRef.current = null;
        cancelBridgeHistoryJump();
        return;
      }
      if (targetRow === 0) {
        cancelBridgeLiveTopJump();
        cancelBridgeHistoryJump();
        void loadBridgeHistoryAtRow(targetRow);
        return;
      }
      cancelBridgeLiveTopJump();
      cancelBridgeLiveScrollSettle();
      scheduleBridgeHistoryJump(targetRow);
      return;
    }
    if (rows < 0) {
      if (controller.isLiveFollow()) cancelBridgeHistoryJump();
      controller.setLiveFollow(false);
    }
    const targetRow = targetHistoryRowForBridgeScroll(rows);
    const hasPendingHistoryTarget = pendingHistoryScrollTargetRowRef.current !== null;
    if (rows > 0) {
      const activeSurface = controller.getSurface();
      const maxStartRow = bridgeMaxStartRow(activeSurface);
      if (targetRow >= maxStartRow) {
        followLiveForUserInput();
        return;
      }
    }
    if (!hasPendingHistoryTarget && scrollBridgeLiveBufferedTarget(targetRow, rows)) return;
    pendingHistoryScrollTargetRowRef.current = targetRow;
    if (scrollBridgeLiveBufferedAbsoluteTarget(targetRow)) {
      pendingHistoryScrollTargetRowRef.current = null;
      historyJumpKeyRef.current = null;
      historyJumpSeqRef.current += 1;
      historyJumpQueueRef.current.clear();
      cancelBridgeHistoryJump();
      return;
    }
    if (targetRow === 0) {
      cancelBridgeLiveTopJump();
      cancelBridgeLiveScrollSettle();
      cancelBridgeHistoryJump();
      void loadBridgeHistoryAtRow(targetRow);
      return;
    }
    cancelBridgeLiveTopJump();
    cancelBridgeLiveScrollSettle();
    scheduleBridgeHistoryJump(targetRow);
  }
  wheelHandlerRef.current = handleWheel;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: globalThis.WheelEvent) => wheelHandlerRef.current(event);
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, []);

  function followLiveForUserInput() {
    historyJumpKeyRef.current = null;
    historyJumpSeqRef.current += 1;
    historyJumpQueueRef.current.clear();
    pendingHistoryRowsRequestRef.current = null;
    pendingHistoryScrollTargetRowRef.current = null;
    cancelBridgeLiveTopJump();
    cancelBridgeLiveScrollSettle();
    cancelBridgePendingTargetSettle();
    cancelBridgeHistoryResizeReplay();
    cancelBridgeHistoryJump();
    if (controller.isHistoryMode()) {
      controller.exitHistory();
      controller.paintCurrent(DEBUG_SESSION_ID);
    }
    if (!controller.isLiveFollow()) controller.setLiveFollow(true);
    void scrollTerminalBridgeViewportToBottom(terminalIdRef.current).catch(scrollError => {
      setError(errorMessage(scrollError));
    });
    requestAnimationFrame(() => {
      controller.scrollToTail();
      controller.focusCanvas();
    });
  }

  function targetHistoryRowForBridgeScroll(deltaRows: number) {
    const activeSurface = controller.getSurface();
    const maxStartRow = bridgeMaxStartRow(activeSurface);
    const clampTarget = (row: number) =>
      clampBridgeWheelTargetRow(row, deltaRows, maxStartRow, activeSurface.rows);
    if (pendingHistoryScrollTargetRowRef.current !== null) {
      return clampTarget(pendingHistoryScrollTargetRowRef.current + deltaRows);
    }
    if (controller.isHistoryMode()) {
      return clampTarget(currentBridgeHistoryTopRow(activeSurface) + deltaRows);
    }
    if (controller.isLiveFollow()) return clampTarget(maxStartRow + deltaRows);
    const viewport = viewportRef.current;
    if (!viewport) return clampTarget(maxStartRow + deltaRows);
    const targetTopRow =
      bridgeLiveLocalBase(activeSurface) + currentBridgeHistoryTopRow(activeSurface);
    const targetRow = targetTopRow + deltaRows;
    return clampTarget(targetRow);
  }

  function clampBridgeWheelTargetRow(
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

  function bridgeTotalRows(forSurface: TerminalSurface) {
    return Math.max(
      bridgeKnownHistoryTotalRows(forSurface) ?? 0,
      controller.getRowCount(),
      forSurface.rows,
    );
  }

  function bridgeHistoryTotalRowsKey(forSurface: TerminalSurface) {
    return `${forSurface.cols}:${forSurface.rows}`;
  }

  function bridgeKnownHistoryTotalRows(forSurface: TerminalSurface) {
    return bridgeHistoryTotalRowsRef.current.get(bridgeHistoryTotalRowsKey(forSurface)) ?? null;
  }

  function rememberBridgeHistoryTotalRows(forSurface: TerminalSurface, totalRows: number) {
    const key = bridgeHistoryTotalRowsKey(forSurface);
    bridgeHistoryTotalRowsRef.current.set(
      key,
      Math.max(bridgeHistoryTotalRowsRef.current.get(key) ?? 0, totalRows, forSurface.rows),
    );
  }

  function bridgeMaxStartRow(forSurface: TerminalSurface) {
    return Math.max(0, bridgeTotalRows(forSurface) - forSurface.rows);
  }

  function bridgeLiveLocalBase(forSurface: TerminalSurface) {
    if (controller.isHistoryMode()) return 0;
    return Math.max(
      0,
      bridgeTotalRows(forSurface) - Math.max(controller.getRowCount(), forSurface.rows),
    );
  }

  function scrollBridgeLiveBufferedTarget(targetRow: number, deltaRows: number) {
    const activeSurface = controller.getSurface();
    const localBase = bridgeLiveLocalBase(activeSurface);
    if (localBase > 0) {
      const localTarget = targetRow - localBase;
      const localMaxStart = Math.max(
        0,
        Math.max(controller.getRowCount(), activeSurface.rows) - activeSurface.rows,
      );
      if (localTarget < 0 || localTarget > localMaxStart) return false;
      return controller.scrollBufferedToRow(localTarget);
    }
    return controller.scrollBufferedRows(deltaRows);
  }

  function scrollBridgeLiveBufferedAbsoluteTarget(targetRow: number) {
    const activeSurface = controller.getSurface();
    const localBase = bridgeLiveLocalBase(activeSurface);
    if (localBase > 0) {
      const localTarget = targetRow - localBase;
      const localMaxStart = Math.max(
        0,
        Math.max(controller.getRowCount(), activeSurface.rows) - activeSurface.rows,
      );
      if (localTarget < 0 || localTarget > localMaxStart) return false;
      return controller.scrollBufferedToRow(localTarget);
    }
    return controller.scrollBufferedToRow(targetRow);
  }

  function requestBridgeHistoryRows(request: {
    startRow: number;
    rowCount: number;
    totalRows: number;
    generation: number;
  }) {
    pendingHistoryRowsRequestRef.current = request;
    if (loadingHistoryRowsRef.current) return;
    loadingHistoryRowsRef.current = true;
    void drainBridgeHistoryRows().finally(() => {
      loadingHistoryRowsRef.current = false;
      if (pendingHistoryRowsRequestRef.current)
        requestBridgeHistoryRows(pendingHistoryRowsRequestRef.current);
    });
  }

  async function drainBridgeHistoryRows() {
    while (pendingHistoryRowsRequestRef.current) {
      const request = pendingHistoryRowsRequestRef.current;
      pendingHistoryRowsRequestRef.current = null;
      await loadMissingBridgeHistoryRows(request);
    }
  }

  async function loadMissingBridgeHistoryRows(request: {
    startRow: number;
    rowCount: number;
    totalRows: number;
    generation: number;
  }) {
    const terminalId = terminalIdRef.current;
    const activeSurface = controller.getSurface();
    const plan = planHistoryWindowForMissingRows(
      request.startRow,
      request.rowCount,
      activeSurface.rows,
      request.totalRows,
      bridgeHistoryWindowMultiplier(activeSurface.rows, request.totalRows),
    );
    setHistoryFills(value => ({ ...value, requested: value.requested + 1 }));
    try {
      const result = await terminalBridgeHistoryWindow(
        terminalId,
        plan.startRow,
        activeSurface.cols,
        activeSurface.rows,
        plan.rowCount,
      );
      const latestSurface = controller.getSurface();
      if (
        terminalIdRef.current !== terminalId ||
        latestSurface.cols !== activeSurface.cols ||
        latestSurface.rows !== activeSurface.rows
      ) {
        return;
      }
      const totalRows = resolveHistoryTotalRows(
        result.frame.scrollback?.totalRows,
        request.totalRows,
        activeSurface.rows,
      );
      if (
        controller.mergeHistoryWindow(result.frame, result.startRow, totalRows, request.generation)
      ) {
        setHistoryFills(value => ({ ...value, merged: value.merged + 1 }));
      }
    } catch (historyError) {
      const latestSurface = controller.getSurface();
      if (
        terminalIdRef.current !== terminalId ||
        latestSurface.cols !== activeSurface.cols ||
        latestSurface.rows !== activeSurface.rows ||
        !controller.isHistoryMode()
      ) {
        return;
      }
      setHistoryFills(value => ({ ...value, failed: value.failed + 1 }));
      setError(errorMessage(historyError));
    }
  }

  function currentBridgeHistoryTopRow(forSurface: TerminalSurface) {
    const viewport = viewportRef.current;
    if (!viewport) return controller.getStartRow();
    const inset = terminalInsetPx(forSurface);
    return Math.max(0, Math.floor((viewport.scrollTop - inset.top) / forSurface.cellHeight));
  }

  async function loadBridgeHistoryAtRow(targetRow: number, knownTotalRows?: number) {
    if (!controller.isHistoryMode()) {
      if (settleBridgePendingTargetFromCache()) return true;
      scheduleBridgePendingTargetSettle();
    }
    const activeSurface = controller.getSurface();
    return historyJumpQueueRef.current.enqueue({
      sessionId: DEBUG_SESSION_ID,
      cols: activeSurface.cols,
      rows: activeSurface.rows,
      targetRow,
      knownTotalRows,
    });
  }

  async function runBridgeHistoryJump(request: HistoryJumpRequest) {
    const requestSeq = historyJumpSeqRef.current + 1;
    historyJumpSeqRef.current = requestSeq;
    const terminalId = terminalIdRef.current;
    if (controller.isLiveFollow()) {
      liveHistoryRequestKeyRef.current = null;
      pendingHistoryScrollTargetRowRef.current = null;
      return true;
    }
    const knownTotal =
      request.knownTotalRows === undefined
        ? undefined
        : resolveHistoryTotalRows(request.knownTotalRows, request.knownTotalRows, request.rows);
    const info =
      knownTotal === undefined
        ? await terminalBridgeHistoryInfo(terminalId, request.cols, request.rows)
        : null;
    if (historyJumpSeqRef.current !== requestSeq) return true;
    const totalRows = Math.max(knownTotal ?? info?.totalRows ?? request.rows, request.rows);
    rememberBridgeHistoryTotalRows(
      { ...controller.getSurface(), cols: request.cols, rows: request.rows },
      totalRows,
    );
    const plan = planHistoryWindowForTargetRow(request.targetRow, request.rows, totalRows);
    const replayPlan = planHistoryWindowForTargetRow(
      request.targetRow,
      request.rows,
      totalRows,
      bridgeHistoryWindowMultiplier(request.rows, totalRows),
    );
    const key = `${requestSeq}:${terminalId}:${request.cols}:${request.rows}:${replayPlan.startRow}:${replayPlan.rowCount}:${replayPlan.targetRow}:${totalRows}`;
    historyJumpKeyRef.current = key;
    setHistoryFills(value => ({ ...value, requested: value.requested + 1 }));
    try {
      const result = await terminalBridgeHistoryWindow(
        terminalId,
        replayPlan.startRow,
        request.cols,
        request.rows,
        replayPlan.rowCount,
      );
      if (historyJumpQueueRef.current.hasPending()) return true;
      if (
        historyJumpSeqRef.current !== requestSeq ||
        historyJumpKeyRef.current !== key ||
        terminalIdRef.current !== terminalId ||
        controller.getSurface().cols !== request.cols ||
        controller.getSurface().rows !== request.rows
      ) {
        return true;
      }
      const resolvedTotalRows = resolveHistoryTotalRows(
        result.frame.scrollback?.totalRows,
        totalRows,
        request.rows,
      );
      rememberBridgeHistoryTotalRows(
        { ...controller.getSurface(), cols: request.cols, rows: request.rows },
        resolvedTotalRows,
      );
      if (controller.isLiveFollow()) {
        liveHistoryRequestKeyRef.current = null;
        return true;
      }
      controller.enterHistoryWindow(
        result.frame,
        result.startRow,
        resolvedTotalRows,
        false,
        plan.targetRow,
      );
      liveHistoryRequestKeyRef.current = null;
      if (
        pendingHistoryScrollTargetRowRef.current === request.targetRow ||
        pendingHistoryScrollTargetRowRef.current === plan.targetRow
      ) {
        pendingHistoryScrollTargetRowRef.current = null;
      }
      setHistoryFills(value => ({ ...value, merged: value.merged + 1 }));
      return true;
    } catch (scrollError) {
      if (
        historyJumpSeqRef.current !== requestSeq ||
        historyJumpKeyRef.current !== key ||
        terminalIdRef.current !== terminalId ||
        controller.getSurface().cols !== request.cols ||
        controller.getSurface().rows !== request.rows
      ) {
        return true;
      }
      setHistoryFills(value => ({ ...value, failed: value.failed + 1 }));
      setError(errorMessage(scrollError));
      return false;
    } finally {
      if (historyJumpKeyRef.current === key) historyJumpKeyRef.current = null;
    }
  }

  function bridgeHistoryWindowMultiplier(surfaceRows: number, totalRows: number) {
    const rows = Math.max(1, Math.floor(surfaceRows));
    const cappedRows = Math.max(1, Math.min(BRIDGE_HISTORY_PREFETCH_ROWS, Math.floor(totalRows)));
    return Math.max(3, Math.ceil(cappedRows / rows));
  }

  return (
    <main className={debugShellClass}>
      <header className={toolbarClass}>
        <div className={titleBlockClass}>
          <Typography variant="smallBodyAlt" tone="default">
            Terminal bridge debug
          </Typography>
          <Typography variant="tiny" tone="muted">
            {terminalBridgeBaseUrl()} | {status}
          </Typography>
        </div>
        <dl className={metricsClass}>
          <Metric label="surface" value={`${surface.cols}x${surface.rows}`} />
          <Metric label="frame" value={lastFrame ? String(lastFrame.seq) : 'none'} />
          <Metric label="backend" value={paintSummary.backend} />
          <Metric label="paint" value={`${paintSummary.rows}r ${paintSummary.cells}c`} />
          <Metric label="history" value={`${historyFills.merged}/${historyFills.requested}`} />
          <Metric
            label="rust"
            value={lastFrame ? `${lastFrame.rustElapsedMs.toFixed(0)}ms` : '0ms'}
          />
        </dl>
        <div className={toolbarButtonsClass}>
          <button type="button" className={iconButtonClass} title="Restart" onClick={restart}>
            <ArrowClockwise size={16} weight="bold" />
          </button>
          <button type="button" className={iconButtonClass} title="Stop" onClick={stop}>
            <Stop size={16} weight="bold" />
          </button>
        </div>
      </header>

      {error ? (
        <div className={errorClass} role="status">
          <Typography variant="caption" tone="warn">
            {error}
          </Typography>
        </div>
      ) : null}

      <section className={terminalPanelClass}>
        <div
          ref={viewportRef}
          className={viewportClass}
          data-testid="terminal-bridge-debug-viewport"
          role="application"
          aria-label="Terminal bridge debug viewport"
          onScroll={handleScroll}
          onMouseDown={() => inputRef.current?.focus({ preventScroll: true })}
        >
          <div ref={spacerRef} className={spacerClass}>
            <canvas
              ref={canvasRef}
              className="terminal-canvas"
              data-testid="terminal-bridge-debug-canvas"
              aria-label="Terminal bridge debug canvas"
            />
            <textarea
              ref={inputRef}
              className={inputClass}
              data-testid="terminal-bridge-debug-input"
              aria-label="Terminal bridge debug input"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              rows={1}
              onKeyDown={handleKeyDown}
              onInput={handleTextInput}
              onPaste={handlePaste}
            />
          </div>
        </div>
      </section>

      <footer className={footerClass}>
        <Typography variant="tiny" tone="muted">
          Started {started ? `${started.cols}x${started.rows}` : 'pending'} | Exited{' '}
          {exitPayload ? `${exitPayload.framesEmitted} frames` : 'no'}
        </Typography>
      </footer>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={metricItemClass}>
      <dt>
        <Typography variant="tiny" tone="muted">
          {label}
        </Typography>
      </dt>
      <dd>
        <Typography variant="tiny" tone="default">
          {value}
        </Typography>
      </dd>
    </div>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function bridgeRendererBackend(): TerminalRendererBackend {
  if (typeof window === 'undefined') return 'canvas2d';
  const params = new URLSearchParams(window.location.search);
  const requested =
    params.get('bridgeRenderer') ?? window.localStorage.getItem('reverie.terminalBridge.renderer');
  return requested === 'webgl2' ? 'webgl2' : 'canvas2d';
}

type TerminalBridgeDebugRow = {
  index: number;
  text: string;
};

type TerminalBridgeDebugRect = ReturnType<typeof plainRect>;

function lastPaintTrace(trace: readonly TimedTerminalControllerTraceEvent[]) {
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const event = trace[index];
    if (event.kind === 'paint') return event;
  }
  return null;
}

function visibleRowsForPaint(
  rows: readonly TerminalBridgeDebugRow[],
  surface: TerminalSurface,
  canvasRect: TerminalBridgeDebugRect | null,
  viewportRect: TerminalBridgeDebugRect | null,
  paintStartRow: number | undefined,
) {
  if (!canvasRect || !viewportRect || surface.cellHeight <= 0) return rows;
  const firstRowIndex = paintStartRow ?? rows[0]?.index ?? 0;
  return rows.filter(row => {
    const ordinal = Math.max(0, row.index - firstRowIndex);
    const top = canvasRect.top + ordinal * surface.cellHeight;
    const bottom = top + surface.cellHeight;
    return top >= viewportRect.top - 1 && bottom <= viewportRect.bottom + 1;
  });
}

function plainRect(rect: DOMRect) {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  };
}

const debugShellClass = css({
  height: '100vh',
  display: 'grid',
  gridTemplateRows: 'auto auto minmax(0, 1fr) auto',
  background: 'var(--bg, #0B0A09)',
  color: 'var(--text, #EFE9DF)',
});

const toolbarClass = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(180px, 1fr) auto auto',
  alignItems: 'center',
  gap: '14px',
  padding: '10px 12px',
  borderBottom: '1px solid var(--line, rgba(245, 235, 220, 0.09))',
  background: 'var(--surface-1, #131210)',
});

const titleBlockClass = css({
  minWidth: 0,
  display: 'grid',
  gap: '2px',
});

const metricsClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
});

const metricItemClass = css({
  minWidth: '54px',
  display: 'grid',
  gap: '1px',
  '& dd': { margin: 0 },
});

const toolbarButtonsClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
});

const iconButtonClass = css({
  width: '30px',
  height: '30px',
  display: 'grid',
  placeItems: 'center',
  color: 'var(--text-2)',
  background: 'transparent',
  border: '1px solid var(--line)',
  borderRadius: '6px',
  cursor: 'pointer',
  _hover: {
    color: 'var(--text)',
    borderColor: 'var(--line-strong)',
    background: 'var(--surface-2)',
  },
});

const errorClass = css({
  padding: '8px 12px',
  borderBottom: '1px solid color-mix(in srgb, var(--warn) 28%, transparent)',
  background: 'color-mix(in srgb, var(--warn) 12%, transparent)',
});

const terminalPanelClass = css({
  minHeight: 0,
  display: 'grid',
  background: 'var(--terminal-bg, #0B0A09)',
});

const viewportClass = css({
  position: 'relative',
  minHeight: 0,
  overflow: 'auto',
  scrollbarWidth: 'thin',
  background: 'var(--terminal-bg, #0B0A09)',
});

const spacerClass = css({
  position: 'relative',
  minHeight: '100%',
  margin: '0 auto',
  overflow: 'hidden',
  background: 'var(--terminal-bg, #0B0A09)',
});

const inputClass = css({
  position: 'absolute',
  left: 0,
  top: 0,
  width: '1px',
  height: '1px',
  padding: 0,
  border: 0,
  outline: 0,
  opacity: 0,
  pointerEvents: 'none',
});

const footerClass = css({
  padding: '7px 12px',
  borderTop: '1px solid var(--line, rgba(245, 235, 220, 0.09))',
  background: 'var(--surface-1, #131210)',
});
