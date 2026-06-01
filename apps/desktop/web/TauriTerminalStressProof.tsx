import { useEffect, useRef, useState } from 'react';

import { css } from './styled-system/css';
import { Typography } from './components/primitives/Typography';
import type {
  RenderMetrics,
  TerminalExitPayload,
  TerminalFailedPayload,
  TerminalFramePayload,
  TerminalStreamStartedPayload,
} from './domain';
import { listen, type UnlistenFn } from './services/runtime';
import {
  recordRenderMetrics,
  setTerminalFrontendActive,
  startSession,
  terminateSession,
} from './services/terminalApi';
import { createTerminalGpuRenderer } from './terminal-gpu-renderer';
import { percentile, TERMINAL_SURFACE } from './terminal-canvas-renderer';
import type { TerminalFrame } from './terminalTypes';

const TERMINAL_COUNT = 3;
const STRESS_LINES = 650;
const STRESS_TIMEOUT_MS = 20_000;

type StressStatus = 'idle' | 'running' | 'passed' | 'failed';

interface StressTerminalState {
  terminalId: string;
  framesReceived: number;
  framesRendered: number;
  chunksRead: number;
  bytesRead: number;
  droppedFrames: number;
  cellsDrawn: number;
  childSuccess: boolean | null;
  renderSamples: number[];
  interEventSamples: number[];
  lastSeq: number | null;
  lastEventAt: number | null;
  pendingFrame: TerminalFrame | null;
  raf: number;
  canvas: HTMLCanvasElement;
  renderer: ReturnType<typeof createTerminalGpuRenderer>;
}

interface StressResult extends RenderMetrics {
  terminalCount: number;
  terminalsExited: number;
  rendererBackends: string[];
  status?: StressStatus;
  error?: string;
}

export function TauriTerminalStressProof() {
  const startedRef = useRef(false);
  const [status, setStatus] = useState<StressStatus>('idle');
  const [result, setResult] = useState<StressResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    const cleanup = runTauriTerminalStressProof({
      isCancelled: () => cancelled,
      onStatus: setStatus,
      onResult: value => {
        if (cancelled) return;
        setResult(value);
        setStatus('passed');
      },
      onError: message => {
        if (cancelled) return;
        setError(message);
        setStatus('failed');
      },
    });

    return () => {
      cancelled = true;
      startedRef.current = false;
      void cleanup.then(dispose => dispose());
    };
  }, []);

  return (
    <main className={rootClass} data-testid="tauri-terminal-stress-proof">
      <Typography as="h1" variant="title3">
        Tauri terminal stress proof
      </Typography>
      <Typography as="p" variant="body" tone={status === 'failed' ? 'bad' : 'muted'}>
        {status}
      </Typography>
      <Typography
        as="pre"
        variant="caption"
        tone="default"
        className={resultClass}
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}
      >
        {error ?? (result ? JSON.stringify(result, null, 2) : 'Waiting for metrics...')}
      </Typography>
    </main>
  );
}

async function runTauriTerminalStressProof({
  isCancelled,
  onStatus,
  onResult,
  onError,
}: {
  isCancelled: () => boolean;
  onStatus: (status: StressStatus) => void;
  onResult: (result: StressResult) => void;
  onError: (message: string) => void;
}): Promise<() => void> {
  onStatus('running');

  const terminalStates = new Map<string, StressTerminalState>();
  const unlisteners: UnlistenFn[] = [];
  let completed = false;
  let timeout: number | null = null;
  const startedAt = performance.now();
  const terminalIds: string[] = Array.from({ length: TERMINAL_COUNT }, () => crypto.randomUUID());
  const activeTerminalId = terminalIds[0] ?? '';

  function fail(message: string) {
    if (completed) return;
    completed = true;
    const result: StressResult = {
      ...summarizeStressResult([...terminalStates.values()], performance.now() - startedAt),
      status: 'failed',
      error: message,
      childSuccess: false,
    };
    void recordRenderMetrics(result).catch(() => {});
    onError(message);
    void cleanup();
  }

  async function finishIfDone() {
    if (completed || terminalStates.size !== TERMINAL_COUNT) return;
    const states = [...terminalStates.values()];
    if (!states.every(state => state.childSuccess !== null)) return;
    if (!states.every(state => state.childSuccess === true)) {
      fail('one or more terminal stress children exited unsuccessfully');
      return;
    }

    completed = true;
    const result = {
      ...summarizeStressResult(states, performance.now() - startedAt),
      status: 'passed' as const,
    };
    try {
      await recordRenderMetrics(result);
    } catch {
      // The visible result is still enough for a local stress run; metrics
      // recording is only for the cargo-run stdout proof.
    }
    onResult(result);
    await cleanup();
  }

  function paintPendingFrame(state: StressTerminalState) {
    state.raf = 0;
    const frame = state.pendingFrame;
    state.pendingFrame = null;
    if (!frame) return;

    const started = performance.now();
    state.renderer.paintFrame(frame);
    state.renderSamples.push(performance.now() - started);
    state.framesRendered += 1;
    state.cellsDrawn += frame.rows.reduce((sum, row) => sum + row.cells.length, 0);
  }

  async function cleanup() {
    if (timeout !== null) {
      window.clearTimeout(timeout);
      timeout = null;
    }
    for (const unlisten of unlisteners.splice(0)) unlisten();
    for (const state of terminalStates.values()) {
      if (state.raf) cancelAnimationFrame(state.raf);
      state.canvas.remove();
      if (state.childSuccess === null) void terminateSession(state.terminalId).catch(() => {});
    }
  }

  async function stopIfCancelled() {
    if (!isCancelled()) return false;
    await cleanup();
    return true;
  }

  timeout = window.setTimeout(() => {
    fail(`terminal stress proof timed out after ${STRESS_TIMEOUT_MS}ms`);
  }, STRESS_TIMEOUT_MS);
  if (await stopIfCancelled()) return () => {};

  unlisteners.push(
    await listen<TerminalStreamStartedPayload>('terminal_stream_started', event => {
      if (isCancelled()) return;
      const terminalId = event.payload.terminalId;
      if (!terminalIds.includes(terminalId)) return;
      void setTerminalFrontendActive(terminalId, terminalId === activeTerminalId);
    }),
  );
  if (await stopIfCancelled()) return () => {};

  unlisteners.push(
    await listen<TerminalFramePayload>('terminal_frame', event => {
      if (isCancelled()) return;
      const payload = event.payload;
      const state = terminalStates.get(payload.terminalId);
      if (!state) return;

      const now = performance.now();
      if (state.lastEventAt !== null) state.interEventSamples.push(now - state.lastEventAt);
      state.lastEventAt = now;
      if (state.lastSeq !== null && payload.seq !== state.lastSeq + 1) {
        state.droppedFrames += Math.max(0, payload.seq - state.lastSeq - 1);
      }
      state.lastSeq = payload.seq;
      state.framesReceived += 1;
      state.bytesRead = payload.bytesRead;
      state.chunksRead += 1;
      state.pendingFrame = payload.frame;
      if (!state.raf) state.raf = requestAnimationFrame(() => paintPendingFrame(state));
    }),
  );
  if (await stopIfCancelled()) return () => {};

  unlisteners.push(
    await listen<TerminalExitPayload>('terminal_exit', event => {
      if (isCancelled()) return;
      const state = terminalStates.get(event.payload.terminalId);
      if (!state) return;
      if (state.raf) {
        cancelAnimationFrame(state.raf);
        state.raf = 0;
      }
      paintPendingFrame(state);
      state.childSuccess = event.payload.childSuccess;
      state.bytesRead = event.payload.bytesRead;
      state.chunksRead = event.payload.chunksRead;
      void finishIfDone();
    }),
  );
  if (await stopIfCancelled()) return () => {};

  unlisteners.push(
    await listen<TerminalFailedPayload>('terminal_failed', event => {
      if (isCancelled()) return;
      const terminalId = event.payload.terminalId;
      if (terminalId && !terminalIds.includes(terminalId)) return;
      fail(event.payload.message ?? 'terminal stress proof failed');
    }),
  );
  if (await stopIfCancelled()) return () => {};

  for (let index = 0; index < terminalIds.length; index += 1) {
    if (await stopIfCancelled()) return () => {};
    const terminalId = terminalIds[index] ?? crypto.randomUUID();
    const canvas = document.createElement('canvas');
    canvas.width = TERMINAL_SURFACE.cols * TERMINAL_SURFACE.cellWidth;
    canvas.height = TERMINAL_SURFACE.rows * TERMINAL_SURFACE.cellHeight;
    canvas.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1080px;height:648px;pointer-events:none;';
    document.body.appendChild(canvas);
    const renderer = createTerminalGpuRenderer(canvas, {
      cols: TERMINAL_SURFACE.cols,
      rows: TERMINAL_SURFACE.rows,
      cellWidth: TERMINAL_SURFACE.cellWidth,
      cellHeight: TERMINAL_SURFACE.cellHeight,
      preferredBackends: ['webgl2', 'canvas2d'],
    });
    terminalStates.set(terminalId, {
      terminalId,
      framesReceived: 0,
      framesRendered: 0,
      chunksRead: 0,
      bytesRead: 0,
      droppedFrames: 0,
      cellsDrawn: 0,
      childSuccess: null,
      renderSamples: [],
      interEventSamples: [],
      lastSeq: null,
      lastEventAt: null,
      pendingFrame: null,
      raf: 0,
      canvas,
      renderer,
    });

    await startSession({
      terminalId,
      spawnSpec: {
        command: {
          program: '/bin/sh',
          args: ['-lc', stressScript(index)],
          cwd: '/tmp',
          env: {},
        },
        cols: TERMINAL_SURFACE.cols,
        rows: TERMINAL_SURFACE.rows,
        title: `Reverie stress ${index + 1}`,
      },
      maxScrollback: 4_000,
    });
    if (await stopIfCancelled()) return () => {};
  }

  return () => {
    void cleanup();
  };
}

function stressScript(index: number) {
  const line = `stress-${index + 1} abcdefghijklmnopqrstuvwxyz 0123456789`;
  return `/usr/bin/yes ${JSON.stringify(line)} | /usr/bin/head -n ${STRESS_LINES}`;
}

function summarizeStressResult(states: StressTerminalState[], elapsedMs: number): StressResult {
  const renderSamples = states.flatMap(state => state.renderSamples);
  const interEventSamples = states.flatMap(state => state.interEventSamples);
  const cellsDrawn = states.reduce((sum, state) => sum + state.cellsDrawn, 0);
  const framesReceived = states.reduce((sum, state) => sum + state.framesReceived, 0);
  const framesRendered = states.reduce((sum, state) => sum + state.framesRendered, 0);
  const droppedFrames = states.reduce((sum, state) => sum + state.droppedFrames, 0);
  const chunksRead = states.reduce((sum, state) => sum + state.chunksRead, 0);
  const outputBytes = states.reduce((sum, state) => sum + state.bytesRead, 0);

  return {
    mode: 'Tauri multi-terminal stress proof',
    terminalCount: states.length,
    terminalsExited: states.filter(state => state.childSuccess).length,
    terminalId: states.map(state => state.terminalId).join(','),
    rendererBackends: [
      ...new Set(
        states
          .map(state => state.renderer.capabilities.backend)
          .filter(backend => Boolean(backend)),
      ),
    ] as string[],
    frames: framesRendered,
    framesReceived,
    droppedFrames,
    chunksRead,
    cellsDrawn,
    elapsedMs,
    avgFrameMs: average(renderSamples),
    p95FrameMs: percentile(renderSamples, 0.95),
    maxFrameMs: Math.max(0, ...renderSamples),
    cellsPerSecond: cellsDrawn / Math.max(0.001, elapsedMs / 1000),
    outputBytes,
    avgInterEventMs: average(interEventSamples),
    p95InterEventMs: percentile(interEventSamples, 0.95),
    maxInterEventMs: Math.max(0, ...interEventSamples),
    childSuccess: states.length > 0 && states.every(state => state.childSuccess === true),
  };
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const rootClass = css({
  minHeight: '100vh',
  padding: '24px',
  background: 'var(--bg)',
  color: 'var(--text)',
  display: 'grid',
  alignContent: 'start',
  gap: '12px',
});

const resultClass = css({
  whiteSpace: 'pre-wrap',
  overflow: 'auto',
});
