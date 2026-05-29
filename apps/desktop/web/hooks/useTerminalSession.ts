import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type UIEvent,
  type WheelEvent,
} from 'react';

import { listen, type UnlistenFn } from '../services/runtime';
import {
  recordRenderMetrics,
  resizeTerminal,
  scrollTerminalViewport,
  scrollTerminalViewportToBottom,
  startSession,
  terminalHistoryInfo,
  terminalHistoryWindow,
  writeTerminalInput,
} from '../services/terminalApi';
import { cycleIndex, findMatchesInFrame, type FrameMatch } from '../terminal/findModel';
import {
  DEFAULT_TERMINAL_SCROLLBACK_ROWS,
  USER_HOME,
  average,
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
  TerminalExitPayload,
  TerminalFailedPayload,
  TerminalFramePayload,
  TerminalStreamStartedPayload,
} from '../domain';
import { createSession } from '../services/shellApi';
import { TERMINAL_SURFACE, percentile } from '../terminal-canvas-renderer';
import {
  SCROLL_FOLLOW_EPSILON_PX,
  type TerminalSurface,
  terminalSurfaceForBounds,
} from '../terminalScrollback';
import { useNavigationStore, useShellStore, useTerminalStore } from '../store';
import { openExternalUrl } from '../services/openApi';
import { createTerminalController, type TerminalController } from '../terminal/terminalController';
import {
  buildActionContext,
  buildMenuItems,
  createTerminalInteraction,
  registerDefaultInteractions,
  resolveTopTarget,
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

const FIND_DEBOUNCE_MS = 120;
// Find searches the whole session, so a single query can match thousands of
// times; cap the kept matches (still report the true total) so navigation and
// the overlay stay cheap.
const FIND_MAX_MATCHES = 2_000;

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

  // Re-maps find matches onto the (possibly scrolled) viewport after each frame.
  // Held in a ref so the long-lived controller can call the latest closure.
  const applyFindOverlayRef = useRef<() => void>(() => {});

  const controllerRef = useRef<TerminalController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createTerminalController({
      surface: TERMINAL_SURFACE,
      onScrollbackRowCount: count => useTerminalStore.getState().setScrollbackRowCount(count),
      onLiveFollow: live => useTerminalStore.getState().setTerminalLiveFollow(live),
      onComposite: () => applyFindOverlayRef.current(),
    });
  }
  const controller = controllerRef.current;

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

  const surfaceMode = useNavigationStore(s => s.surfaceMode);
  const creationMode = useNavigationStore(s => s.creationMode);

  // Keep the controller pointed at the live DOM elements (they mount/unmount as
  // the terminal surface shows/hides), and bind/unbind the pointer island to the
  // live canvas alongside it.
  useEffect(() => {
    controller.attach({
      canvas: canvasRef.current,
      viewport: surfaceViewportRef.current,
      spacer: terminalScrollSpacerRef.current,
    });
    if (canvasRef.current) interaction.attach();
    else interaction.detach();
  });

  // Switching the displayed session drops any active selection/hover. Without
  // this, a selection made in session A would pin session B's viewport
  // (shouldAutoFollow stays false) and Copy/Send-to-input would read B at A's
  // coordinates. Keyed on the session id only, so a resize repaint never clears.
  useEffect(() => {
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
  }, [selectedSession?.id]);

  // First paint.
  useEffect(() => {
    controller.paintCurrent(useNavigationStore.getState().selectedSessionId);
    writeLog(
      'Ready. Reverie shell is using the floating-panel UI direction; terminal rendering remains a Canvas island.',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  // Force a remount + repaint when the surface becomes visible or the selected session changes.
  useEffect(() => {
    if (surfaceMode !== 'terminal') return;
    controller.resetRenderer();
    requestAnimationFrame(() =>
      controller.paintCurrent(useNavigationStore.getState().selectedSessionId),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceMode]);

  useEffect(() => {
    if (surfaceMode !== 'terminal' || creationMode || !selectedSession) {
      controller.resetRenderer();
      return;
    }
    controller.resetRenderer();
    requestAnimationFrame(() =>
      controller.paintCurrent(useNavigationStore.getState().selectedSessionId),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creationMode, selectedSession?.id, surfaceMode]);

  // Resize the surface to the viewport and tell the backend to match.
  useEffect(() => {
    const viewport = surfaceViewportRef.current;
    console.log(
      '[RESIZE-DBG] effect run ' +
        JSON.stringify({
          surfaceMode,
          selectedSessionId: selectedSession?.id,
          hasViewport: !!viewport,
          ch: viewport?.clientHeight,
          cw: viewport?.clientWidth,
        }),
    );
    if (!viewport) return;

    function applyViewportSize(width: number, height: number) {
      const previous = controller.getSurface();
      const next = terminalSurfaceForBounds(width, height, previous);
      console.log(
        '[RESIZE-DBG] applyViewportSize ' + JSON.stringify({ width, height, previous, next }),
      );
      if (next.cols === previous.cols && next.rows === previous.rows) return;

      controller.setSurface(next);
      useTerminalStore.getState().setTerminalSurface(next);
      // In the full-history view, re-replay the transcript at the new width so a
      // resize reflows deep history rather than clobbering it back to the live
      // frame (the live repaint path is width-correct only for the live band).
      if (controller.isHistoryMode()) {
        const activeFind = findRef.current;
        if (activeFind.open && activeFind.query.length > 0) {
          // A resize while finding: reflow without jumping to the tail, then
          // re-run the search so matches + the active position are recomputed
          // for the new width and the viewport stays on the match.
          void loadFullHistory(next, false).then(loaded => {
            if (loaded) void runSearch(activeFind.query, activeFind.caseSensitive);
          });
        } else {
          void loadFullHistory(next);
        }
      } else {
        controller.paintCurrent(useNavigationStore.getState().selectedSessionId, next);
      }

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
      if (isTauriRuntime)
        writeLog(`Unable to record metrics through Tauri: ${errorMessage(error)}`);
    }
  }

  async function attachRuntimeSessionListeners(
    terminalId: string,
    session: ShellSession,
  ): Promise<() => void> {
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
      store.setSessionTerminalBindings(current => ({
        ...current,
        [session.id]: { terminalId, inputArmed },
      }));
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

    unlisteners.push(
      await listen<TerminalStreamStartedPayload>('terminal_stream_started', event => {
        if (event.payload.terminalId !== terminalId) return;
        startedPayload = event.payload;
        receiveStarted = performance.now();
        setSessionTerminalInputReady(true);
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
      }),
    );

    unlisteners.push(
      await listen<TerminalExitPayload>('terminal_exit', event => {
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
  // scrolling. Find operates on the full-history composite, so a match's row is
  // its absolute row in the whole session.
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

  // Find searches the entire persisted session, not just the visible area. It
  // loads the full replayed transcript into the history view (once) and matches
  // against that composite in-memory, so every keystroke after the first is a
  // cheap re-scan with no backend replay.
  async function runSearch(query: string, caseSensitive: boolean) {
    const sessionId = useNavigationStore.getState().selectedSessionId;
    if (!sessionId || query.length === 0) {
      updateFind({ matches: [], total: 0, capped: false, activeIndex: -1, busy: false });
      controller.clearSearch();
      return;
    }
    updateFind({ busy: true });
    try {
      if (!controller.isHistoryMode()) {
        // Enter history without landing at the bottom; scrollToActiveMatch
        // positions the viewport on the first match instead.
        const loaded = await loadFullHistory(controller.getSurface(), false);
        if (!loaded) {
          updateFind({ busy: false });
          return;
        }
        findEnteredHistoryRef.current = true;
        setHistoryViewing(true);
      }
      const composite = controller.getComposite();
      const all = composite
        ? findMatchesInFrame(composite, query, caseSensitive, controller.getSurface().cols)
        : [];
      const capped = all.length > FIND_MAX_MATCHES;
      const matches = capped ? all.slice(0, FIND_MAX_MATCHES) : all;
      const activeIndex = matches.length > 0 ? 0 : -1;
      updateFind({ matches, total: all.length, capped, activeIndex, busy: false });
      if (activeIndex >= 0) {
        controller.setSearchActive(true);
        scrollToActiveMatch();
      } else {
        controller.clearSearch();
      }
    } catch (error) {
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
    const query = prefill && prefill.length > 0 ? prefill : findRef.current.query;
    updateFind({ open: true, query });
    controller.setSearchActive(true);
    if (query.length > 0) void runSearch(query, findRef.current.caseSensitive);
  }

  function closeFind() {
    window.clearTimeout(findDebounceRef.current);
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

  function handleTerminalKeyDown(event: KeyboardEvent<HTMLCanvasElement>) {
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
    void sendTerminalInput(input);
  }

  // Send pasted text to the terminal, wrapping in bracketed-paste markers when
  // the app requested that mode. Shared by the paste event + the menu action.
  async function pasteTextToTerminal(text: string) {
    if (!inputReady() || !text) return;
    const input = controller.getLastFrameModes()?.bracketedPaste
      ? `\x1b[200~${text}\x1b[201~`
      : text;
    await sendTerminalInput(input);
  }

  function handleTerminalPaste(event: ClipboardEvent<HTMLCanvasElement>) {
    if (!inputReady()) return;
    const text = event.clipboardData.getData('text');
    if (!text) return;
    event.preventDefault();
    void pasteTextToTerminal(text);
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
    const cwd = selectedSession?.cwd ?? USER_HOME;
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
    controller.paintWindow();
    if (controller.isAutoScrolling()) {
      controller.setLiveFollow(true);
      return;
    }
    const viewport = event.currentTarget;
    const following =
      viewport.scrollTop + viewport.clientHeight >=
      viewport.scrollHeight - SCROLL_FOLLOW_EPSILON_PX;
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
    // Returning to the live tail also ends any full-history find session (its
    // match coordinates belong to the frozen history composite).
    if (findRef.current.open) {
      window.clearTimeout(findDebounceRef.current);
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

  // Fetch the full persisted transcript replayed at `surface`'s width and hand it
  // to the controller's history view. Returns whether the load succeeded. Shared
  // by the initial "Full history" entry and the resize reflow (deep history is
  // width-dependent, so a resize must re-replay at the new width).
  async function loadFullHistory(surface: TerminalSurface, scrollToBottom = true) {
    const sessionId = useNavigationStore.getState().selectedSessionId;
    if (!sessionId) return false;
    try {
      const info = await terminalHistoryInfo(sessionId, surface.cols, surface.rows);
      const totalRows = Math.max(info.totalRows, surface.rows);
      const windowResult = await terminalHistoryWindow(sessionId, 0, surface.cols, totalRows);
      controller.enterHistory(windowResult.frame, scrollToBottom);
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
      controller.resetRenderer();
      controller.paintCurrent(useNavigationStore.getState().selectedSessionId);
      void launchSession(session).catch(error =>
        writeLog(`Autostart session failed: ${errorMessage(error)}`),
      );
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
    clearSurface: () => controller.clear(),
    dropSession: (sessionId: string) => controller.dropSession(sessionId),
  };
}

// The handle returned by useTerminalSession: the DOM refs the React tree binds,
// the input/scroll handlers, and the session lifecycle senders. Components that
// render the terminal surface accept (a slice of) this so the hook stays the
// single owner of the imperative island.
export type TerminalSession = ReturnType<typeof useTerminalSession>;
