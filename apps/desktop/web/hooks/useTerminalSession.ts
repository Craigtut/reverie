import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent, type MouseEvent, type UIEvent, type WheelEvent } from 'react';

import { listen, type UnlistenFn } from '../services/runtime';
import {
  recordRenderMetrics,
  resizeTerminal,
  scrollTerminalViewport,
  scrollTerminalViewportToBottom,
  startSession,
  writeTerminalInput,
} from '../services/terminalApi';
import {
  DEFAULT_TERMINAL_SCROLLBACK_ROWS,
  average,
  errorMessage,
  shortId,
  terminalInputForKey,
  terminalWheelDeltaRows,
} from '../domain';
import type {
  RenderMetrics,
  ShellSession,
  StartSessionRequest,
  TerminalExitPayload,
  TerminalFailedPayload,
  TerminalFramePayload,
  TerminalStreamStartedPayload,
} from '../domain';
import { TERMINAL_SURFACE, percentile } from '../terminal-canvas-renderer';
import { SCROLL_FOLLOW_EPSILON_PX, terminalSurfaceForBounds } from '../terminalScrollback';
import { useNavigationStore, useTerminalStore } from '../store';
import { createTerminalController, type TerminalController } from '../terminal/terminalController';

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
  const surfaceViewportRef = useRef<HTMLDivElement | null>(null);
  const terminalScrollSpacerRef = useRef<HTMLDivElement | null>(null);

  const controllerRef = useRef<TerminalController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createTerminalController({
      surface: TERMINAL_SURFACE,
      onScrollbackRowCount: count => useTerminalStore.getState().setScrollbackRowCount(count),
      onLiveFollow: live => useTerminalStore.getState().setTerminalLiveFollow(live),
    });
  }
  const controller = controllerRef.current;

  const surfaceMode = useNavigationStore(s => s.surfaceMode);
  const creationMode = useNavigationStore(s => s.creationMode);

  // Keep the controller pointed at the live DOM elements (they mount/unmount as
  // the terminal surface shows/hides).
  useEffect(() => {
    controller.attach({
      canvas: canvasRef.current,
      viewport: surfaceViewportRef.current,
      spacer: terminalScrollSpacerRef.current,
    });
  });

  // First paint.
  useEffect(() => {
    controller.paintCurrent(useNavigationStore.getState().selectedSessionId);
    writeLog('Ready. Reverie shell is using the floating-panel UI direction; terminal rendering remains a Canvas island.');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  // Force a remount + repaint when the surface becomes visible or the selected session changes.
  useEffect(() => {
    if (surfaceMode !== 'terminal') return;
    controller.resetRenderer();
    requestAnimationFrame(() => controller.paintCurrent(useNavigationStore.getState().selectedSessionId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceMode]);

  useEffect(() => {
    if (surfaceMode !== 'terminal' || creationMode || !selectedSession) {
      controller.resetRenderer();
      return;
    }
    controller.resetRenderer();
    requestAnimationFrame(() => controller.paintCurrent(useNavigationStore.getState().selectedSessionId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creationMode, selectedSession?.id, surfaceMode]);

  // Resize the surface to the viewport and tell the backend to match.
  useEffect(() => {
    const viewport = surfaceViewportRef.current;
    if (!viewport) return;

    function applyViewportSize(width: number, height: number) {
      const previous = controller.getSurface();
      const next = terminalSurfaceForBounds(width, height, previous);
      if (next.cols === previous.cols && next.rows === previous.rows) return;

      controller.setSurface(next);
      useTerminalStore.getState().setTerminalSurface(next);
      controller.paintCurrent(useNavigationStore.getState().selectedSessionId, next);

      const terminalId = useTerminalStore.getState().activeTerminalId;
      if (terminalId && isTauriRuntime) {
        void resizeTerminal(terminalId, next.cols, next.rows).catch(error => {
          writeLog(`Terminal resize failed: ${errorMessage(error)}`);
        });
      }
    }

    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      applyViewportSize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(viewport);
    applyViewportSize(viewport.clientWidth, viewport.clientHeight);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTauriRuntime, surfaceMode, selectedSession?.id]);

  async function recordMetrics(result: RenderMetrics) {
    try {
      await recordRenderMetrics(result);
    } catch (error) {
      if (isTauriRuntime) writeLog(`Unable to record metrics through Tauri: ${errorMessage(error)}`);
    }
  }

  async function attachRuntimeSessionListeners(terminalId: string, session: ShellSession): Promise<() => void> {
    controller.requireRenderer();
    const timings: number[] = [];
    const interEventTimings: number[] = [];
    let cellsDrawn = 0;
    let framesReceived = 0;
    let droppedFrames = 0;
    let expectedSeq = 0;
    let lastEventAt: number | null = null;
    let receiveStarted: number | null = null;
    let startedPayload: TerminalStreamStartedPayload | null = null;
    let pendingTerminalFramePayload: TerminalFramePayload | null = null;
    let terminalFrameRaf = 0;
    const unlisteners: UnlistenFn[] = [];
    const store = useTerminalStore.getState();

    function cleanup() {
      if (terminalFrameRaf) {
        cancelAnimationFrame(terminalFrameRaf);
        terminalFrameRaf = 0;
      }
      for (const unlisten of unlisteners.splice(0)) unlisten();
    }

    function paintPendingTerminalFrame() {
      terminalFrameRaf = 0;
      const payload = pendingTerminalFramePayload;
      pendingTerminalFramePayload = null;
      if (!payload) return;

      const frameStarted = performance.now();
      const isActive = useTerminalStore.getState().activeTerminalId === terminalId;
      controller.ingestFrame(session.id, payload.frame, isActive);
      const frameEnded = performance.now();
      timings.push(frameEnded - frameStarted);
      cellsDrawn += payload.frame.rows.reduce((sum, row) => sum + row.cells.length, 0);
    }

    function setSessionTerminalInputReady(inputArmed: boolean) {
      store.setSessionTerminalBindings(current => ({ ...current, [session.id]: { terminalId, inputArmed } }));
      if (useTerminalStore.getState().activeTerminalId === terminalId) {
        store.setTerminalInputArmed(inputArmed);
      }
    }

    function clearActiveTerminal() {
      store.setSessionTerminalBindings(current => {
        const next = { ...current };
        delete next[session.id];
        return next;
      });
      store.setTerminalInputArmed(false);
      store.setActiveTerminalId(current => (current === terminalId ? null : current));
      store.setRunningSessionId(current => (current === session.id ? null : current));
    }

    unlisteners.push(await listen<TerminalStreamStartedPayload>('terminal_stream_started', event => {
      if (event.payload.terminalId !== terminalId) return;
      startedPayload = event.payload;
      receiveStarted = performance.now();
      setSessionTerminalInputReady(true);
      requestAnimationFrame(() => controller.focusCanvas());
      writeLog(`Runtime session started: terminal=${shortId(terminalId)} session=${shortId(session.id)} cols=${startedPayload.cols} rows=${startedPayload.rows}.`);
      void loadWorkspaceShell();
    }));

    unlisteners.push(await listen<TerminalFramePayload>('terminal_frame', event => {
      const payload = event.payload;
      if (payload.terminalId !== terminalId) return;

      const now = performance.now();
      if (receiveStarted === null) receiveStarted = now;
      if (lastEventAt !== null) interEventTimings.push(now - lastEventAt);
      lastEventAt = now;

      if (payload.seq !== expectedSeq) droppedFrames += Math.max(0, payload.seq - expectedSeq);
      expectedSeq = payload.seq + 1;
      framesReceived += 1;
      pendingTerminalFramePayload = payload;
      if (!terminalFrameRaf) terminalFrameRaf = requestAnimationFrame(paintPendingTerminalFrame);
    }));

    unlisteners.push(await listen<TerminalExitPayload>('terminal_exit', event => {
      const finished = event.payload;
      if (finished.terminalId !== terminalId) return;

      if (pendingTerminalFramePayload) {
        if (terminalFrameRaf) {
          cancelAnimationFrame(terminalFrameRaf);
          terminalFrameRaf = 0;
        }
        paintPendingTerminalFrame();
      }
      const receiveElapsed = receiveStarted === null ? 0 : performance.now() - receiveStarted;
      cleanup();
      clearActiveTerminal();
      const result: RenderMetrics = {
        mode: 'Cortex adapter terminal session',
        terminalId,
        frames: finished.framesEmitted,
        framesReceived,
        droppedFrames,
        chunksRead: finished.chunksRead,
        cellsDrawn,
        elapsedMs: receiveElapsed,
        avgFrameMs: average(timings),
        p95FrameMs: percentile(timings, 0.95),
        maxFrameMs: Math.max(0, ...timings),
        cellsPerSecond: cellsDrawn / Math.max(0.001, receiveElapsed / 1000),
        outputBytes: finished.bytesRead,
        rustElapsedMs: finished.rustElapsedMs,
        totalEmitMs: finished.totalEmitMs,
        avgEmitMs: finished.avgEmitMs,
        maxEmitMs: finished.maxEmitMs,
        avgInterEventMs: average(interEventTimings),
        p95InterEventMs: percentile(interEventTimings, 0.95),
        maxInterEventMs: Math.max(0, ...interEventTimings),
        childSuccess: finished.childSuccess,
        targetFrames: startedPayload?.targetFrames ?? undefined,
      };
      writeLog(`Runtime session exited: terminal=${shortId(terminalId)} received=${result.framesReceived}/${result.frames} chunks=${result.chunksRead}.`);
      void recordMetrics(result);
      void loadWorkspaceShell();
    }));

    unlisteners.push(await listen<TerminalFailedPayload>('terminal_failed', event => {
      const failedTerminalId = event.payload?.terminalId;
      if (failedTerminalId && failedTerminalId !== terminalId) return;
      cleanup();
      clearActiveTerminal();
      writeLog(`Runtime session failed: ${event.payload?.message || 'terminal session failed'}`);
      void loadWorkspaceShell();
    }));

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
      store.setTerminalInputArmed(false);
      return false;
    }

    store.setActiveTerminalId(binding.terminalId);
    store.setRunningSessionId(session.id);
    store.setTerminalInputArmed(binding.inputArmed);
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
      store.setSessionTerminalBindings(current => ({ ...current, [session.id]: { terminalId, inputArmed: false } }));
      store.setTerminalInputArmed(false);
      store.setActiveTerminalId(terminalId);
      store.setRunningSessionId(session.id);
      writeLog(`Launching ${session.title} as its own terminal session.`);
      await startSession(request);
      void loadWorkspaceShell();
    } catch (error) {
      cleanup?.();
      store.setSessionTerminalBindings(current => {
        const next = { ...current };
        delete next[session.id];
        return next;
      });
      store.setTerminalInputArmed(false);
      store.setActiveTerminalId(current => (current === terminalId ? null : current));
      store.setRunningSessionId(current => (current === session.id ? null : current));
      store.setLaunchingSessionId(current => (current === session.id ? null : current));
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
    try {
      await writeTerminalInput(terminalId, input);
    } catch (error) {
      writeLog(`Terminal input failed: ${errorMessage(error)}`);
    }
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

  function handleTerminalKeyDown(event: KeyboardEvent<HTMLCanvasElement>) {
    const input = terminalInputForKey(event, controller.getLastFrameModes());
    if (!input || !inputReady()) return;
    event.preventDefault();
    void sendTerminalInput(input);
  }

  function handleTerminalPaste(event: ClipboardEvent<HTMLCanvasElement>) {
    if (!inputReady()) return;
    const text = event.clipboardData.getData('text');
    if (!text) return;
    event.preventDefault();
    const input = controller.getLastFrameModes()?.bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text;
    void sendTerminalInput(input);
  }

  function focusTerminalCanvas(event?: MouseEvent<HTMLElement>) {
    event?.preventDefault();
    controller.focusCanvas();
  }

  function handleTerminalScroll(event: UIEvent<HTMLDivElement>) {
    controller.paintWindow();
    if (controller.isAutoScrolling()) {
      controller.setLiveFollow(true);
      return;
    }
    const viewport = event.currentTarget;
    const following = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - SCROLL_FOLLOW_EPSILON_PX;
    controller.setLiveFollow(following);
  }

  function handleTerminalWheel(event: WheelEvent<HTMLDivElement>) {
    const terminalId = useTerminalStore.getState().activeTerminalId;
    if (!terminalId || controller.getLastFrameModes()?.mouseTracking) return;
    const deltaRows = terminalWheelDeltaRows(event, controller.getSurface());
    if (deltaRows === 0) return;
    event.preventDefault();
    if (deltaRows < 0) controller.setLiveFollow(false);
    void sendTerminalViewportScroll(deltaRows);
  }

  function followLiveTerminalOutput() {
    controller.setLiveFollow(true);
    void sendTerminalViewportToBottom();
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
        else writeLog(`Autostart session delayed: terminal surface did not mount for ${session.title}.`);
        return;
      }
      controller.resetRenderer();
      controller.paintCurrent(useNavigationStore.getState().selectedSessionId);
      void launchSession(session).catch(error => writeLog(`Autostart session failed: ${errorMessage(error)}`));
    };
    window.setTimeout(tryLaunch, 0);
  }

  return {
    canvasRef,
    surfaceViewportRef,
    terminalScrollSpacerRef,
    handleTerminalKeyDown,
    handleTerminalPaste,
    focusTerminalCanvas,
    handleTerminalScroll,
    handleTerminalWheel,
    followLiveTerminalOutput,
    launchSession,
    activateSession,
    autostartSession,
    clearSurface: () => controller.clear(),
    dropSession: (sessionId: string) => controller.dropSession(sessionId),
  };
}
