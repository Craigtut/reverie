import { ArrowClockwise, Stop } from '@phosphor-icons/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, FormEvent, KeyboardEvent, UIEvent } from 'react';
import { css } from './styled-system/css';
import { Typography } from './components/primitives/Typography';
import {
  listenTerminalBridge,
  resizeTerminalBridgeSession,
  startTerminalBridgeSession,
  terminateTerminalBridgeSession,
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
  terminalSurfaceForBounds,
  type TerminalSurface,
} from './terminalScrollback';
import type { TerminalFrame, TerminalRendererBackend } from './terminalTypes';

const DEBUG_SESSION_ID = 'terminal-bridge-debug-session';
const DEFAULT_SURFACE: TerminalSurface = {
  cols: 120,
  rows: 32,
  cellWidth: 9,
  cellHeight: 18,
};

declare global {
  interface Window {
    __REVERIE_TERMINAL_DEBUG__?: () => unknown;
  }
}

// Browser-only terminal debug surface. It drives the standalone terminal debug
// bridge (a native PTY exposed over HTTP) and paints its live frames through the
// same imperative controller the product uses. Scroll-back reaches as far as the
// frontend buffer the live frames have populated; range-fetching beyond it is a
// later-phase rework (serve straight from libghostty), and there is no
// transcript-replay deep history.
export function TerminalBridgeDebug() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const wheelHandlerRef = useRef<(event: globalThis.WheelEvent) => void>(() => {});
  const inputWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingFramesRef = useRef<TerminalFrame[]>([]);
  const paintRafRef = useRef(0);
  const resizeRafRef = useRef(0);
  const surfaceRef = useRef(DEFAULT_SURFACE);
  const bridgeStartedRef = useRef(false);
  const controllerRef = useRef<ReturnType<typeof createTerminalController> | null>(null);
  const terminalIdRef = useRef<string>(crypto.randomUUID());
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

  const commitSurface = useCallback((next: TerminalSurface) => {
    surfaceRef.current = next;
    setSurface(next);
  }, []);

  const controller = useMemo(
    () =>
      createTerminalController({
        surface: DEFAULT_SURFACE,
        onScrollbackRowCount: () => {},
        onLiveFollow: () => {},
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
        createRenderer: (canvas, rendererSurface, displayRows) => {
          const backend = bridgeRendererBackend();
          const sized = {
            ...rendererSurface,
            rows: displayRows,
          };
          if (backend === 'canvas2d') {
            return createTerminalCanvasRenderer(canvas, sized);
          }
          return createTerminalGpuRenderer(canvas, {
            ...sized,
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
        pendingFrames: pendingFramesRef.current.length,
        paintRafScheduled: paintRafRef.current !== 0,
        resizeRafScheduled: resizeRafRef.current !== 0,
        controller: {
          startRow: controller.getStartRow(),
          rowCount: controller.getRowCount(),
          liveFollow: controller.isLiveFollow(),
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
  }, [controller, lastFrame, paintSummary, started, status, surface]);

  const applyMeasuredSurface = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return surfaceRef.current;
    const previous = controller.getSurface();
    const next = terminalSurfaceForBounds(viewport.clientWidth, viewport.clientHeight, previous);
    controller.setSurface(next);
    commitSurface(next);
    controller.paintCurrent(DEBUG_SESSION_ID, next);
    return next;
  }, [commitSurface, controller]);

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
    setStatus('starting');
    setStarted(null);
    setLastFrame(null);
    setExitPayload(null);
    setError(null);

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
        });
        bridgeStartedRef.current = true;
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
      void terminateTerminalBridgeSession(terminalId).catch(() => {});
      bridgeStartedRef.current = false;
    };
  }, [applyMeasuredSurface, controller, runKey]);

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
  }

  function handleWheel(event: globalThis.WheelEvent) {
    const rows = terminalWheelDeltaRows(event, surface);
    if (rows === 0) return;
    event.preventDefault();
    const modes = controller.getLastFrameModes();
    if (modes?.alternateScreen) return;
    if (rows > 0 && controller.isLiveFollow()) {
      followLiveForUserInput();
      return;
    }
    if (rows < 0 && controller.isLiveFollow()) controller.setLiveFollow(false);
    controller.scrollBufferedRows(rows);
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
    // Following the live tail is now fully frontend-local: re-pin and snap the
    // viewport to the tail. The mirror already holds the latest rows, so there
    // is no backend round-trip (decisions.md D6).
    if (!controller.isLiveFollow()) controller.setLiveFollow(true);
    requestAnimationFrame(() => {
      controller.scrollToTail();
      controller.focusCanvas();
    });
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
