import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type UIEvent,
  type WheelEvent,
} from 'react';
import { invoke, listen, type UnlistenFn } from './services/runtime';
import { useActivityStore, useNavigationStore, usePaletteStore, useShellStore, useTerminalStore, useUiStore } from './store';
import { useAgentClis, useAppFocus, useCommandPalette, useSessionActivity } from './hooks';
import { BrandMark, DotMatrixWord } from './components/brand';
import { AgentGlyph, SessionStatusGlyph } from './components/glyphs';
import { TrafficLights, DotField } from './components/chrome';
import { ProjectGroup, FocusRow } from './components/nav';
import { SessionLaunchOverlay, SessionHistorySurface } from './components/session';
import { CommandPalette } from './components/palette';
import { EmptyState } from './components/onboarding';
import { DashboardSurface } from './components/dashboard';
import { CreationComposer } from './components/creation';
import { SettingsSurface } from './components/settings';
import { motion } from 'motion/react';
import {
  CaretRight,
  CircleDashed,
  Folder,
  GearSix,
  House,
  MagnifyingGlass,
  Moon,
  Play,
  Plus,
  ShieldWarning,
  Sun,
  TerminalWindow,
  Warning,
  X,
} from '@phosphor-icons/react';

import { css, cx } from './styled-system/css';
import { appShellClass } from './themes/appShell';
import { rimLitPanelClass } from './themes/surfaces';
import {
  USER_HOME,
  DEFAULT_TERMINAL_SCROLLBACK_ROWS,
  average,
  sessionBreadcrumb,
  sessionsForProject,
  shortenCwd,
  shortId,
  folderNameFromPath,
  agentLabel,
  agentTabLabel,
  dangerousLabel,
  activityForSession,
  terminalInputForKey,
  terminalWheelDeltaRows,
  errorMessage,
} from './domain';
import type {
  CreationMode,
  RenderMetrics,
  GhosttyFrameSequencePayload,
  StartSessionRequest,
  TerminalStreamStartedPayload,
  TerminalFramePayload,
  TerminalExitPayload,
  TerminalFailedPayload,
  WorkspaceShellSnapshot,
  ShellProject,
  ShellFocus,
  ShellSession,
  ActivityPermissionRequest,
  ActivityState,
  CreateProjectRequest,
  ProjectFolderSelection,
  SessionTerminalBinding,
  SessionTerminalView,
  CreateFocusRequest,
  CreateSessionRecordRequest,
} from './domain';
import {
  TERMINAL_SURFACE,
  createTerminalCanvasRenderer,
  percentile,
} from './terminal-canvas-renderer';
import {
  SCROLL_FOLLOW_EPSILON_PX,
  cloneTerminalRow,
  frameForSurface,
  terminalScrollbackContract,
  terminalSurfaceForBounds,
  type TerminalSurface,
} from './terminalScrollback';
import type { TerminalFrame, TerminalModes, TerminalRenderer, TerminalRow } from './terminalTypes';
import { maybeRunHarnessSmokeTest } from './harnessSmoke';



// Opacity of the terminal's default background. 0 lets the shell background
// (gradient + dot field) show fully through so the session feels painted onto
// the surface rather than inside a box; raise toward 1 for a tinted or solid
// backdrop if legibility ever needs it.
const TERMINAL_BACKGROUND_OPACITY = 0;


export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceViewportRef = useRef<HTMLDivElement | null>(null);
  const terminalScrollSpacerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<TerminalRenderer | null>(null);
  const activeTerminalIdRef = useRef<string | null>(null);
  const terminalSurfaceRef = useRef<TerminalSurface>(TERMINAL_SURFACE);
  const lastTerminalFrameRef = useRef<TerminalFrame | null>(null);
  const lastCompositeTerminalFrameRef = useRef<TerminalFrame | null>(null);
  const scrollbackRowsRef = useRef<TerminalRow[]>([]);
  const rendererNeedsFullPaintRef = useRef(true);
  const lastTerminalPaintStartRowRef = useRef<number | null>(null);
  const liveFollowRef = useRef(true);
  const autoScrollingTerminalRef = useRef(false);
  const shell = useShellStore(s => s.shell);
  const setShell = useShellStore(s => s.setShell);
  const selectedProjectId = useNavigationStore(s => s.selectedProjectId);
  const setSelectedProjectId = useNavigationStore(s => s.setSelectedProjectId);
  const selectedFocusId = useNavigationStore(s => s.selectedFocusId);
  const setSelectedFocusId = useNavigationStore(s => s.setSelectedFocusId);
  const selectedSessionId = useNavigationStore(s => s.selectedSessionId);
  const setSelectedSessionId = useNavigationStore(s => s.setSelectedSessionId);
  const creationMode = useNavigationStore(s => s.creationMode);
  const setCreationMode = useNavigationStore(s => s.setCreationMode);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newFocusTitle, setNewFocusTitle] = useState('');
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [newSessionCwd, setNewSessionCwd] = useState(USER_HOME);
  const [newSessionAgentKind, setNewSessionAgentKind] = useState<CreateSessionRecordRequest['agentKind']>('cortex_code');
  const [newSessionDangerousMode, setNewSessionDangerousMode] = useState(false);
  const agentCliDetections = useShellStore(s => s.agentCliDetections);
  const activeTerminalId = useTerminalStore(s => s.activeTerminalId);
  const setActiveTerminalId = useTerminalStore(s => s.setActiveTerminalId);
  const runningSessionId = useTerminalStore(s => s.runningSessionId);
  const setRunningSessionId = useTerminalStore(s => s.setRunningSessionId);
  // Tracks which session is mid-launch so the terminal surface can show the
  // breathing launch animation. Cleared automatically when the live terminal
  // binding arrives, or on launch failure.
  const launchingSessionId = useTerminalStore(s => s.launchingSessionId);
  const setLaunchingSessionId = useTerminalStore(s => s.setLaunchingSessionId);
  // Command palette visibility + current query. The palette filters across
  // focuses and sessions in the whole workspace; bound to ⌘K (Ctrl+K on
  // non-mac) and to clicking the search bar.
  const paletteOpen = usePaletteStore(s => s.paletteOpen);
  const setPaletteOpen = usePaletteStore(s => s.setPaletteOpen);
  const paletteQuery = usePaletteStore(s => s.paletteQuery);
  const setPaletteQuery = usePaletteStore(s => s.setPaletteQuery);
  // Map from Cortex session id → live ActivityState. Reverie sessions look up
  // their entry by `nativeSessionRef.sessionId`. Sessions Reverie doesn't own
  // still land in the map but stay invisible until correlation succeeds.
  const cortexActivity = useActivityStore(s => s.cortexActivity);
  const terminalInputArmed = useTerminalStore(s => s.terminalInputArmed);
  const setTerminalInputArmed = useTerminalStore(s => s.setTerminalInputArmed);
  const sessionTerminalBindings = useTerminalStore(s => s.sessionTerminalBindings);
  const setSessionTerminalBindings = useTerminalStore(s => s.setSessionTerminalBindings);
  const terminalSurface = useTerminalStore(s => s.terminalSurface);
  const setTerminalSurface = useTerminalStore(s => s.setTerminalSurface);
  const scrollbackRowCount = useTerminalStore(s => s.scrollbackRowCount);
  const setScrollbackRowCount = useTerminalStore(s => s.setScrollbackRowCount);
  const terminalLiveFollow = useTerminalStore(s => s.terminalLiveFollow);
  const setTerminalLiveFollow = useTerminalStore(s => s.setTerminalLiveFollow);
  const [logs, setLogs] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<RenderMetrics[]>([]);
  const [busy, setBusy] = useState(false);
  const theme = useUiStore(s => s.theme);
  const setTheme = useUiStore(s => s.setTheme);
  const surfaceMode = useNavigationStore(s => s.surfaceMode);
  const setSurfaceMode = useNavigationStore(s => s.setSurfaceMode);
  const appFocused = useUiStore(s => s.appFocused);
  const isTauriRuntime = useMemo(() => Boolean(window.__TAURI_INTERNALS__ || (window.__TAURI__ && !window.__REVERIE_BROWSER_FIXTURE__)), []);
  const canUseAppServices = true;
  const scrollbackContract = useMemo(() => terminalScrollbackContract(terminalSurface), [terminalSurface]);

  const selectedProject = selectedProjectId ? shell.projects.find(project => project.id === selectedProjectId) ?? null : null;
  const selectedProjectIdRef = useRef<string | null>(selectedProjectId);
  const selectedProjectRef = useRef<ShellProject | null>(selectedProject);
  const sessionTerminalBindingsRef = useRef<Record<string, SessionTerminalBinding>>({});
  const sessionTerminalViewsRef = useRef<Record<string, SessionTerminalView>>({});
  // Latest raw backend frame per session. Background sessions keep only this and
  // skip the per-row surface mapping (buildSessionTerminalView); the view is
  // built lazily when the session is brought to front, so output churning in
  // off-screen sessions costs nothing on the main thread.
  const sessionLatestFrameRef = useRef<Record<string, TerminalFrame>>({});
  const visibleFocuses = useMemo(() => {
    return shell.focuses
      .filter(focus => !focus.archived)
      .filter(focus => selectedProjectId === null ? !focus.projectId : focus.projectId === selectedProjectId)
      .sort((left, right) => left.sortOrder - right.sortOrder);
  }, [selectedProjectId, shell.focuses]);
  const selectedFocus = visibleFocuses.find(focus => focus.id === selectedFocusId) ?? visibleFocuses[0] ?? null;
  const selectedFocusProject = selectedFocus?.projectId
    ? shell.projects.find(project => project.id === selectedFocus.projectId) ?? null
    : null;
  const selectedFocusDefaultCwd = selectedFocusProject?.path ?? USER_HOME;
  const focusSessions = useMemo(() => {
    if (!selectedFocus) return [];
    return shell.sessions.filter(session => session.focusId === selectedFocus.id);
  }, [selectedFocus, shell.sessions]);
  const visibleSessions = useMemo(() => focusSessions.filter(session => session.tabVisible !== false), [focusSessions]);
  const hiddenFocusSessions = useMemo(() => focusSessions.filter(session => session.tabVisible === false), [focusSessions]);
  const selectedSession = creationMode || surfaceMode === 'session-history' || surfaceMode === 'dashboard' ? null : visibleSessions.find(session => session.id === selectedSessionId) ?? visibleSessions[0] ?? null;
  const selectedTerminalBinding = selectedSession ? sessionTerminalBindings[selectedSession.id] ?? null : null;
  const isLaunchingSelectedSession = Boolean(
    selectedSession && launchingSessionId === selectedSession.id && !selectedTerminalBinding,
  );
  const selectedSessionActivity: ActivityState | null = selectedSession
    ? activityForSession(selectedSession, cortexActivity)
    : null;
  const selectedPermissionRequest: ActivityPermissionRequest | null =
    selectedSessionActivity?.status === 'awaiting_permission'
      ? (selectedSessionActivity.awaitingPermission ?? null)
      : null;
  const liveSessionCount = useMemo(
    () => shell.sessions.filter(s => {
      if (s.tabVisible === false) return false;
      if (s.status === 'running' || sessionTerminalBindings[s.id]) return true;
      const cortexId = s.nativeSessionRef?.sessionId;
      const activity = cortexId ? cortexActivity[cortexId] : null;
      return activity?.status === 'working' || activity?.status === 'awaiting_permission';
    }).length,
    [shell.sessions, sessionTerminalBindings, cortexActivity],
  );

  // Clean up the launchingSessionId once the live binding arrives (the breathing
  // overlay disappears as soon as the real terminal surface takes over).
  useEffect(() => {
    if (launchingSessionId && sessionTerminalBindings[launchingSessionId]) {
      setLaunchingSessionId(null);
    }
  }, [launchingSessionId, sessionTerminalBindings]);
  const runningSession = runningSessionId ? shell.sessions.find(session => session.id === runningSessionId) ?? null : null;
  const hasActiveTerminal = activeTerminalId !== null;
  const effectiveDangerousMode = dangerousLabel(selectedSession, shell.workspace.defaultDangerousMode) !== 'Off';
  // Plain-language status shown in the terminal meta strip. We deliberately
  // omit terminal-internal details (cols×rows, scrollback row counts) from
  // the primary surface; they're available behind diagnostics if needed.
  const runningLabel = selectedTerminalBinding
    ? (selectedTerminalBinding.inputArmed ? 'Running' : 'Starting')
    : busy ? 'Working' : selectedSession ? 'Ready to launch' : 'Ready';

  const writeLog = (line: string) => {
    const stamped = `[${new Date().toLocaleTimeString()}] ${line}`;
    setLogs(current => [stamped, ...current].slice(0, 80));
  };

  function mountTerminalRenderer(surface = terminalSurfaceRef.current, displayRows = surface.rows) {
    if (!canvasRef.current) return null;

    const renderer = createTerminalCanvasRenderer(canvasRef.current, { ...surface, rows: displayRows, backgroundOpacity: TERMINAL_BACKGROUND_OPACITY });
    rendererRef.current = renderer;
    return renderer;
  }

  function ensureTerminalRenderer(surface: TerminalSurface, displayRows: number) {
    const renderer = rendererRef.current;
    if (!renderer || renderer.cols !== surface.cols || renderer.rows !== displayRows) {
      rendererNeedsFullPaintRef.current = true;
      lastTerminalPaintStartRowRef.current = null;
      return mountTerminalRenderer(surface, displayRows);
    }

    return renderer;
  }

  function blankTerminalFrame(surface = terminalSurfaceRef.current): TerminalFrame {
    return {
      dirty: 'full',
      rows: Array.from({ length: surface.rows }, (_, index) => ({
        index,
        dirty: true,
        cells: [],
      })),
      cursor: { visible: false, row: 0, col: 0, position: { row: 0, col: 0 } },
    };
  }

  function emptyTerminalView(surface = terminalSurfaceRef.current): SessionTerminalView {
    const frame = blankTerminalFrame(surface);
    return {
      lastFrame: null,
      compositeFrame: frame,
      scrollbackRows: [],
      rowCount: 0,
      liveFollow: true,
    };
  }

  function buildSessionTerminalView(previousView: SessionTerminalView | undefined, frame: TerminalFrame, surface = terminalSurfaceRef.current): SessionTerminalView {
    const surfaceFrame = frameForSurface(frame, surface);
    const renderedScrollbackRows: TerminalRow[] = [];
    return {
      lastFrame: surfaceFrame,
      compositeFrame: surfaceFrame,
      scrollbackRows: renderedScrollbackRows,
      rowCount: surfaceFrame.scrollback?.scrollbackRows ?? renderedScrollbackRows.length,
      liveFollow: surfaceFrame.scrollback?.atBottom ?? previousView?.liveFollow ?? true,
    };
  }

  // Resolve the view to paint for a session. Prefers a fresh build from the
  // latest raw frame (correct even if the surface resized while the session was
  // backgrounded); falls back to any previously stored view.
  function ensureSessionTerminalView(sessionId: string, surface = terminalSurfaceRef.current): SessionTerminalView | undefined {
    const frame = sessionLatestFrameRef.current[sessionId];
    if (frame) {
      const view = buildSessionTerminalView(sessionTerminalViewsRef.current[sessionId], frame, surface);
      sessionTerminalViewsRef.current[sessionId] = view;
      return view;
    }
    return sessionTerminalViewsRef.current[sessionId];
  }

  function applyTerminalView(view: SessionTerminalView, surface = terminalSurfaceRef.current) {
    lastTerminalFrameRef.current = view.lastFrame;
    lastCompositeTerminalFrameRef.current = view.compositeFrame;
    scrollbackRowsRef.current = view.scrollbackRows;
    liveFollowRef.current = view.liveFollow;
    setScrollbackRowCount(view.rowCount);
    setTerminalLiveFollow(view.liveFollow);
    updateTerminalScrollSpacer(view.compositeFrame.rows.length, surface);
    paintVisibleTerminalWindow(view.compositeFrame, surface);

    requestAnimationFrame(() => {
      if (liveFollowRef.current) {
        scrollTerminalViewportToTail();
      } else {
        paintVisibleTerminalWindow();
      }
    });
  }

  function clearTerminalSurface(surface = terminalSurfaceRef.current) {
    rendererRef.current = null;
    rendererNeedsFullPaintRef.current = true;
    lastTerminalPaintStartRowRef.current = null;
    const view = emptyTerminalView(surface);
    lastTerminalFrameRef.current = null;
    lastCompositeTerminalFrameRef.current = view.compositeFrame;
    scrollbackRowsRef.current = [];
    liveFollowRef.current = true;
    setScrollbackRowCount(0);
    setTerminalLiveFollow(true);
    updateTerminalScrollSpacer(surface.rows, surface);
    paintVisibleTerminalWindow(view.compositeFrame, surface);
  }

  function resetTerminalScrollback() {
    scrollbackRowsRef.current = [];
    lastCompositeTerminalFrameRef.current = null;
    rendererNeedsFullPaintRef.current = true;
    lastTerminalPaintStartRowRef.current = null;
    liveFollowRef.current = true;
    setScrollbackRowCount(0);
    setTerminalLiveFollow(true);
    updateTerminalScrollSpacer(terminalSurfaceRef.current.rows, terminalSurfaceRef.current);
  }

  function updateTerminalScrollSpacer(totalRows: number, surface: TerminalSurface) {
    const spacer = terminalScrollSpacerRef.current;
    if (!spacer) return;

    spacer.style.height = `${Math.max(totalRows, surface.rows) * surface.cellHeight}px`;
    spacer.style.width = `${surface.cols * surface.cellWidth}px`;
  }

  function scrollTerminalViewportToTail() {
    const viewport = surfaceViewportRef.current;
    if (!viewport) return;

    autoScrollingTerminalRef.current = true;
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    paintVisibleTerminalWindow();

    requestAnimationFrame(() => {
      paintVisibleTerminalWindow();
      const isStillFollowing = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - SCROLL_FOLLOW_EPSILON_PX;
      autoScrollingTerminalRef.current = false;
      liveFollowRef.current = isStillFollowing;
      setTerminalLiveFollow(isStillFollowing);
    });
  }

  function paintVisibleTerminalWindow(frame = lastCompositeTerminalFrameRef.current, surface = terminalSurfaceRef.current) {
    if (!frame) return;

    const viewport = surfaceViewportRef.current;
    const viewportHeight = Math.max(surface.cellHeight, viewport?.clientHeight ?? surface.rows * surface.cellHeight);
    const overscanRows = 3;
    const targetDisplayRows = Math.max(surface.rows, Math.ceil(viewportHeight / surface.cellHeight) + overscanRows * 2);
    const displayRows = Math.max(1, Math.min(frame.rows.length, targetDisplayRows));
    const scrollTop = viewport?.scrollTop ?? 0;
    const maxStartRow = Math.max(0, frame.rows.length - displayRows);
    const startRow = Math.min(maxStartRow, Math.max(0, Math.floor(scrollTop / surface.cellHeight) - overscanRows));
    const endRow = startRow + displayRows;
    const renderer = ensureTerminalRenderer(surface, displayRows);
    const forceFullPaint = rendererNeedsFullPaintRef.current || lastTerminalPaintStartRowRef.current !== startRow || frame.dirty !== 'partial';
    const rows = frame.rows
      .filter(row => row.index >= startRow && row.index < endRow && (forceFullPaint || row.dirty))
      .map(row => ({
        ...cloneTerminalRow(row),
        index: row.index - startRow,
        dirty: forceFullPaint || row.dirty,
      }));
    const cursorRow = frame.cursor?.position?.row ?? frame.cursor?.row;
    const cursorCol = frame.cursor?.position?.col ?? frame.cursor?.col;
    const cursorVisible = Number.isFinite(cursorRow) && Number.isFinite(cursorCol) && (cursorRow as number) >= startRow && (cursorRow as number) < endRow;
    const windowFrame: TerminalFrame = {
      ...frame,
      dirty: forceFullPaint ? 'full' : frame.dirty,
      rows,
      cursor: cursorVisible
        ? {
            ...frame.cursor,
            row: (cursorRow as number) - startRow,
            col: cursorCol as number,
            position: {
              row: (cursorRow as number) - startRow,
              col: cursorCol as number,
            },
          }
        : { ...frame.cursor, visible: false },
    };
    if (canvasRef.current) {
      canvasRef.current.style.transform = `translateY(${startRow * surface.cellHeight}px)`;
    }
    if (forceFullPaint) {
      renderer?.clear(windowFrame.colors?.background);
    }
    renderer?.paintFrame(windowFrame);
    rendererNeedsFullPaintRef.current = false;
    lastTerminalPaintStartRowRef.current = startRow;
  }

  function paintTerminalFrame(frame: TerminalFrame) {
    const surface = terminalSurfaceRef.current;
    const surfaceFrame = frameForSurface(frame, surface);

    lastTerminalFrameRef.current = surfaceFrame;
    const renderedScrollbackRows: TerminalRow[] = [];
    if (renderedScrollbackRows.length !== scrollbackRowsRef.current.length) {
      scrollbackRowsRef.current = renderedScrollbackRows;
    }
    setScrollbackRowCount(surfaceFrame.scrollback?.scrollbackRows ?? renderedScrollbackRows.length);
    const compositeFrame = surfaceFrame;
    lastCompositeTerminalFrameRef.current = compositeFrame;
    updateTerminalScrollSpacer(compositeFrame.rows.length, surface);
    paintVisibleTerminalWindow(compositeFrame, surface);

    requestAnimationFrame(() => {
      if (liveFollowRef.current) {
        scrollTerminalViewportToTail();
      } else {
        paintVisibleTerminalWindow();
      }
    });
  }

  function paintCurrentTerminalFrame(surface = terminalSurfaceRef.current) {
    if (selectedSessionId) {
      const sessionView = ensureSessionTerminalView(selectedSessionId, surface);
      if (sessionView) {
        applyTerminalView(sessionView, surface);
        return;
      }
    }

    if (lastTerminalFrameRef.current) {
      paintTerminalFrame(lastTerminalFrameRef.current);
      return;
    }

    clearTerminalSurface(surface);
  }

  useEffect(() => {
    if (rendererRef.current) return;

    paintCurrentTerminalFrame();
    writeLog('Ready. Reverie shell is now using the floating-panel UI direction; terminal rendering remains a Canvas island.');
  }, []);

  useEffect(() => {
    activeTerminalIdRef.current = activeTerminalId;
  }, [activeTerminalId]);

  useEffect(() => {
    if (surfaceMode !== 'terminal') return;
    rendererRef.current = null;
    requestAnimationFrame(() => paintCurrentTerminalFrame());
  }, [surfaceMode]);

  useEffect(() => {
    if (surfaceMode !== 'terminal' || creationMode || !selectedSession) {
      rendererRef.current = null;
      return;
    }

    rendererRef.current = null;
    requestAnimationFrame(() => paintCurrentTerminalFrame());
  }, [creationMode, selectedSession?.id, surfaceMode]);

  useEffect(() => {
    const viewport = surfaceViewportRef.current;
    if (!viewport) return;

    function applyViewportSize(width: number, height: number) {
      const next = terminalSurfaceForBounds(width, height, terminalSurfaceRef.current);
      const previous = terminalSurfaceRef.current;
      if (next.cols === previous.cols && next.rows === previous.rows) return;

      terminalSurfaceRef.current = next;
      setTerminalSurface(next);
      paintCurrentTerminalFrame(next);

      const terminalId = activeTerminalIdRef.current;
      if (terminalId && isTauriRuntime) {
        void invoke('resize_terminal', { terminalId, cols: next.cols, rows: next.rows }).catch(error => {
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
  }, [isTauriRuntime, surfaceMode, selectedSession?.id]);

  // Global ⌘K / Ctrl+K opens the command palette from any surface, and Esc
  // closes it. We swallow the default browser behavior for the shortcut so
  // it doesn't trigger find-in-page when the focus is inside the terminal.
  useCommandPalette();

  useSessionActivity(writeLog);

  async function loadWorkspaceShell() {
    if (!canUseAppServices) return null;

    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>('workspace_shell');
      setShell(snapshot);
      writeLog(`Loaded persisted workspace shell: ${snapshot.projects.length} project, ${snapshot.focuses.length} focuses, ${snapshot.sessions.length} sessions.`);
      return snapshot;
    } catch (error) {
      writeLog(`Workspace shell command failed; using browser fallback data: ${errorMessage(error)}`);
      return null;
    }
  }

  useEffect(() => {
    loadWorkspaceShell().catch(error => {
      writeLog(`Workspace shell load failed: ${errorMessage(error)}`);
    });
  }, [isTauriRuntime]);

  useAgentClis(newSessionAgentKind, setNewSessionAgentKind, writeLog);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
    selectedProjectRef.current = selectedProject;
  }, [selectedProject, selectedProjectId]);

  useEffect(() => {
    sessionTerminalBindingsRef.current = sessionTerminalBindings;
  }, [sessionTerminalBindings]);

  useEffect(() => {
    if (selectedFocus && selectedFocus.id !== selectedFocusId) {
      setSelectedFocusId(selectedFocus.id);
    }
  }, [selectedFocus, selectedFocusId]);

  useEffect(() => {
    if (selectedSession && selectedSession.id !== selectedSessionId) {
      setSelectedSessionId(selectedSession.id);
    } else if (!selectedSession && selectedSessionId !== null) {
      setSelectedSessionId(null);
    }
  }, [selectedSession, selectedSessionId]);

  useEffect(() => {
    if (shell.focuses.length === 0) return;
    if (selectedFocusId && shell.focuses.some(focus => focus.id === selectedFocusId && !focus.archived)) return;

    const firstFocus = shell.focuses
      .filter(focus => !focus.archived)
      .sort((left, right) => left.sortOrder - right.sortOrder)[0];
    if (!firstFocus) return;

    const firstSession = shell.sessions.find(session => session.focusId === firstFocus.id) ?? null;
    setSelectedProjectId(firstFocus.projectId ?? null);
    setSelectedFocusId(firstFocus.id);
    setSelectedSessionId(firstSession?.id ?? null);
  }, [selectedFocusId, shell.focuses, shell.sessions]);

  useEffect(() => {
    setNewSessionCwd(selectedFocusDefaultCwd);
  }, [selectedFocusDefaultCwd]);

  useEffect(() => {
    maybeRunHarnessSmokeTest();
  }, []);

  useAppFocus();

  async function attachRuntimeSessionListeners(terminalId: string, session: ShellSession): Promise<() => void> {
    requireRenderer();
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

    function cleanup() {
      if (terminalFrameRaf) {
        cancelAnimationFrame(terminalFrameRaf);
        terminalFrameRaf = 0;
      }
      for (const unlisten of unlisteners.splice(0)) {
        unlisten();
      }
    }

    function paintPendingTerminalFrame() {
      terminalFrameRaf = 0;
      const payload = pendingTerminalFramePayload;
      pendingTerminalFramePayload = null;
      if (!payload) return;

      const frameStarted = performance.now();
      sessionLatestFrameRef.current[session.id] = payload.frame;
      if (activeTerminalIdRef.current === terminalId) {
        const previousView = sessionTerminalViewsRef.current[session.id];
        const nextView = buildSessionTerminalView(previousView, payload.frame);
        sessionTerminalViewsRef.current[session.id] = nextView;
        applyTerminalView(nextView);
      } else {
        // Backgrounded: drop any stale built view so the next activation rebuilds
        // from this raw frame instead of paying for the surface mapping now.
        delete sessionTerminalViewsRef.current[session.id];
      }
      const frameEnded = performance.now();
      timings.push(frameEnded - frameStarted);
      cellsDrawn += payload.frame.rows.reduce((sum, row) => sum + row.cells.length, 0);
    }

    function setSessionTerminalInputReady(inputArmed: boolean) {
      setSessionTerminalBindings(current => ({
        ...current,
        [session.id]: { terminalId, inputArmed },
      }));
      if (activeTerminalIdRef.current === terminalId) {
        setTerminalInputArmed(inputArmed);
      }
    }

    function clearActiveTerminal() {
      setSessionTerminalBindings(current => {
        const next = { ...current };
        delete next[session.id];
        return next;
      });
      setTerminalInputArmed(false);
      if (activeTerminalIdRef.current === terminalId) {
        activeTerminalIdRef.current = null;
      }
      setActiveTerminalId(current => current === terminalId ? null : current);
      setRunningSessionId(current => current === session.id ? null : current);
    }

    unlisteners.push(await listen<TerminalStreamStartedPayload>('terminal_stream_started', event => {
      if (event.payload.terminalId !== terminalId) return;
      startedPayload = event.payload;
      receiveStarted = performance.now();
      setSessionTerminalInputReady(true);
      requestAnimationFrame(() => canvasRef.current?.focus());
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

      if (payload.seq !== expectedSeq) {
        droppedFrames += Math.max(0, payload.seq - expectedSeq);
      }
      expectedSeq = payload.seq + 1;

      framesReceived += 1;
      pendingTerminalFramePayload = payload;
      if (!terminalFrameRaf) {
        terminalFrameRaf = requestAnimationFrame(paintPendingTerminalFrame);
      }
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
      setMetrics([result]);
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

  function defaultCwdForFocus(focus: ShellFocus | null, snapshot: WorkspaceShellSnapshot = shell) {
    if (!focus?.projectId) return USER_HOME;
    return snapshot.projects.find(project => project.id === focus.projectId)?.path ?? USER_HOME;
  }

  async function chooseProjectFolder() {
    if (!canUseAppServices) return;
    setBusy(true);
    try {
      const selection = await invoke<ProjectFolderSelection | null>('choose_project_folder');
      if (!selection) {
        writeLog('Project folder selection cancelled.');
        return;
      }
      setNewProjectPath(selection.path);
      setNewProjectName(selection.name || folderNameFromPath(selection.path) || 'New project');
      setNewSessionCwd(selection.path);
      writeLog(`Selected project folder: ${selection.path}.`);
    } catch (error) {
      writeLog(`Choose project folder failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function createProjectFromComposer() {
    if (!canUseAppServices) return;
    setBusy(true);
    try {
      const request: CreateProjectRequest = {
        name: newProjectName.trim() || folderNameFromPath(newProjectPath) || 'New project',
        path: newProjectPath.trim(),
      };
      const snapshot = await invoke<WorkspaceShellSnapshot>('create_project', { request });
      const created = snapshot.projects[snapshot.projects.length - 1];
      const nextProjectId = created?.id ?? selectedProjectId;
      selectedProjectIdRef.current = nextProjectId;
      selectedProjectRef.current = created ?? selectedProjectRef.current;
      setShell(snapshot);
      setSelectedProjectId(nextProjectId);
      setSelectedFocusId(null);
      setSelectedSessionId(null);
      setNewProjectName('');
      setNewProjectPath('');
      setCreationMode('focus');
      writeLog(`Created project: ${created?.name ?? request.name}.`);
    } catch (error) {
      writeLog(`Create project failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function createFocusForSelection() {
    if (!canUseAppServices) return;
    setBusy(true);
    try {
      const targetProjectId = selectedProjectIdRef.current;
      const targetProject = selectedProjectRef.current;
      const title = newFocusTitle.trim() || (targetProject ? `${targetProject.name} focus` : 'New focus');
      const request: CreateFocusRequest = {
        projectId: targetProjectId,
        title,
        description: targetProject
          ? `Focused work under ${targetProject.name}.`
          : 'Unprojected work that can become project-backed later.',
      };
      const snapshot = await invoke<WorkspaceShellSnapshot>('create_focus', { request });
      const created = snapshot.focuses[snapshot.focuses.length - 1];
      setShell(snapshot);
      setSelectedFocusId(created?.id ?? null);
      setSelectedSessionId(null);
      setNewFocusTitle('');
      setNewSessionCwd(defaultCwdForFocus(created ?? null, snapshot));
      setCreationMode('session');
      setSurfaceMode('terminal');
      writeLog(`Created focus: ${created?.title ?? request.title}.`);
    } catch (error) {
      writeLog(`Create focus failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  function scheduleSessionAutostart(session: ShellSession) {
    let attempts = 0;

    const tryLaunchAfterTerminalMount = () => {
      if (!canvasRef.current || !surfaceViewportRef.current) {
        attempts += 1;
        if (attempts <= 12) {
          window.setTimeout(tryLaunchAfterTerminalMount, 25);
        } else {
          writeLog(`Autostart session delayed: terminal surface did not mount for ${session.title}.`);
        }
        return;
      }

      rendererRef.current = null;
      paintCurrentTerminalFrame();
      void launchRuntimeSession(session).catch(error => {
        writeLog(`Autostart session failed: ${errorMessage(error)}`);
      });
    };

    window.setTimeout(tryLaunchAfterTerminalMount, 0);
  }

  async function createSessionForSelection() {
    if (!canUseAppServices || !selectedFocus) return;
    setBusy(true);
    try {
      const title = newSessionTitle.trim() || `${agentLabel(newSessionAgentKind)} session`;
      const defaultCwd = defaultCwdForFocus(selectedFocus);
      const enteredCwd = newSessionCwd.trim();
      const cwd = enteredCwd || defaultCwd;
      const request: CreateSessionRecordRequest = {
        focusId: selectedFocus.id,
        title,
        agentKind: newSessionAgentKind,
        cwd,
        dangerousModeOverride: newSessionDangerousMode,
      };
      const snapshot = await invoke<WorkspaceShellSnapshot>('create_session', { request });
      const created = snapshot.sessions[snapshot.sessions.length - 1];
      setShell(snapshot);
      setSelectedSessionId(created?.id ?? null);
      setNewSessionTitle('');
      setCreationMode(null);
      setSurfaceMode('terminal');
      writeLog(`Created session: ${created?.title ?? request.title}. Preparing terminal handoff for the selected CLI.`);
      if (created) {
        scheduleSessionAutostart(created);
      }
    } catch (error) {
      writeLog(`Create session failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function launchRuntimeSession(session: ShellSession, options: { manageBusy?: boolean } = {}) {
    const existingBinding = sessionTerminalBindingsRef.current[session.id];
    if (existingBinding) {
      activateSessionTerminal(session);
      writeLog(`${session.title} already owns terminal ${shortId(existingBinding.terminalId)}.`);
      return;
    }

    setSurfaceMode('terminal');
    if (options.manageBusy !== false) setBusy(true);
    setLaunchingSessionId(session.id);
    resetTerminalScrollback();
    sessionTerminalViewsRef.current[session.id] = emptyTerminalView();
    applyTerminalView(sessionTerminalViewsRef.current[session.id]);
    const terminalId = crypto.randomUUID();
    let cleanup: (() => void) | null = null;
    try {
      cleanup = await attachRuntimeSessionListeners(terminalId, session);
      const surface = terminalSurfaceRef.current;
      const request: StartSessionRequest = {
        sessionId: session.id,
        terminalId,
        cols: surface.cols,
        rows: surface.rows,
        maxScrollback: DEFAULT_TERMINAL_SCROLLBACK_ROWS,
      };
      setSessionTerminalBindings(current => ({
        ...current,
        [session.id]: { terminalId, inputArmed: false },
      }));
      setTerminalInputArmed(false);
      activeTerminalIdRef.current = terminalId;
      setActiveTerminalId(terminalId);
      setRunningSessionId(session.id);
      writeLog(`Launching ${session.title} as its own terminal session.`);
      await invoke<string>('start_session', { request });
      void loadWorkspaceShell();
    } catch (error) {
      cleanup?.();
      setSessionTerminalBindings(current => {
        const next = { ...current };
        delete next[session.id];
        return next;
      });
      setTerminalInputArmed(false);
      if (activeTerminalIdRef.current === terminalId) {
        activeTerminalIdRef.current = null;
      }
      setActiveTerminalId(current => current === terminalId ? null : current);
      setRunningSessionId(current => current === session.id ? null : current);
      setLaunchingSessionId(current => current === session.id ? null : current);
      writeLog(`Runtime session launch failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      if (options.manageBusy !== false) setBusy(false);
    }
  }

  async function sendTerminalInput(input: string) {
    if (!activeTerminalId || !terminalInputArmed || input.length === 0) return;

    try {
      await invoke('write_terminal_input', { terminalId: activeTerminalId, input });
    } catch (error) {
      writeLog(`Terminal input failed: ${errorMessage(error)}`);
    }
  }

  async function sendTerminalViewportScroll(deltaRows: number) {
    if (!activeTerminalId || deltaRows === 0) return;

    try {
      await invoke('scroll_terminal_viewport', { terminalId: activeTerminalId, deltaRows });
    } catch (error) {
      writeLog(`Terminal scroll failed: ${errorMessage(error)}`);
    }
  }

  async function sendTerminalViewportToBottom() {
    if (!activeTerminalId) return;

    try {
      await invoke('scroll_terminal_viewport_to_bottom', { terminalId: activeTerminalId });
    } catch (error) {
      writeLog(`Follow live failed: ${errorMessage(error)}`);
    }
  }

  function terminalInputReady() {
    return Boolean(activeTerminalId && terminalInputArmed);
  }

  function handleTerminalKeyDown(event: KeyboardEvent<HTMLCanvasElement>) {
    const input = terminalInputForKey(event, lastTerminalFrameRef.current?.modes);
    if (!input || !terminalInputReady()) return;

    event.preventDefault();
    void sendTerminalInput(input);
  }

  function handleTerminalPaste(event: ClipboardEvent<HTMLCanvasElement>) {
    if (!terminalInputReady()) return;

    const text = event.clipboardData.getData('text');
    if (!text) return;

    event.preventDefault();
    const input = lastTerminalFrameRef.current?.modes?.bracketedPaste
      ? `\x1b[200~${text}\x1b[201~`
      : text;
    void sendTerminalInput(input);
  }

  function focusTerminalCanvas(event?: MouseEvent<HTMLElement>) {
    event?.preventDefault();
    canvasRef.current?.focus();
  }

  function handleTerminalScroll(event: UIEvent<HTMLDivElement>) {
    paintVisibleTerminalWindow();

    if (autoScrollingTerminalRef.current) {
      liveFollowRef.current = true;
      setTerminalLiveFollow(true);
      return;
    }

    const viewport = event.currentTarget;
    const following = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - SCROLL_FOLLOW_EPSILON_PX;
    liveFollowRef.current = following;
    setTerminalLiveFollow(following);
  }

  function handleTerminalWheel(event: WheelEvent<HTMLDivElement>) {
    if (!activeTerminalId || lastTerminalFrameRef.current?.modes?.mouseTracking) return;

    const deltaRows = terminalWheelDeltaRows(event, terminalSurfaceRef.current);
    if (deltaRows === 0) return;

    event.preventDefault();
    if (deltaRows < 0) {
      liveFollowRef.current = false;
      setTerminalLiveFollow(false);
    }
    void sendTerminalViewportScroll(deltaRows);
  }

  function followLiveTerminalOutput() {
    liveFollowRef.current = true;
    setTerminalLiveFollow(true);
    void sendTerminalViewportToBottom();

    requestAnimationFrame(() => {
      scrollTerminalViewportToTail();
      canvasRef.current?.focus();
    });
  }

  async function recordMetrics(result: RenderMetrics) {
    try {
      await invoke('record_render_metrics', { metrics: result });
    } catch (error) {
      if (isTauriRuntime) {
        writeLog(`Unable to record metrics through Tauri: ${errorMessage(error)}`);
      }
    }
  }

  function requireRenderer() {
    const renderer = rendererRef.current ?? mountTerminalRenderer();
    if (!renderer) {
      throw new Error('Terminal renderer is not mounted yet');
    }
    return renderer;
  }

  function activateSessionTerminal(session: ShellSession): boolean {
    const binding = sessionTerminalBindingsRef.current[session.id];
    setSelectedSessionId(session.id);
    setCreationMode(null);
    setSurfaceMode('terminal');

    if (!binding) {
      const view = ensureSessionTerminalView(session.id);
      if (view) {
        applyTerminalView(view);
      } else {
        clearTerminalSurface();
      }
      setTerminalInputArmed(false);
      return false;
    }

    activeTerminalIdRef.current = binding.terminalId;
    setActiveTerminalId(binding.terminalId);
    setRunningSessionId(session.id);
    setTerminalInputArmed(binding.inputArmed);
    const view = ensureSessionTerminalView(session.id);
    if (view) {
      applyTerminalView(view);
    } else {
      clearTerminalSurface();
    }
    requestAnimationFrame(() => canvasRef.current?.focus());
    return true;
  }

  function selectSessionTab(session: ShellSession) {
    // Selecting a tab is an "open this session" intent. If it's already bound
    // to a live PTY we just re-focus it; otherwise we launch (or resume, if
    // there's a native session ref). The user shouldn't have to also click a
    // separate Run button just to start a session they meant to open.
    const attached = activateSessionTerminal(session);
    if (attached) return;
    void launchRuntimeSession(session).catch(error => {
      const verb = session.nativeSessionRef ? 'Resume' : 'Launch';
      writeLog(`${verb} failed for ${session.title}: ${errorMessage(error)}`);
    });
  }

  function goToDashboard() {
    setCreationMode(null);
    setSurfaceMode('dashboard');
  }

  function openSessionFromDashboard(session: ShellSession) {
    const focus = shell.focuses.find(f => f.id === session.focusId);
    if (!focus) return;
    const projectId = focus.projectId ?? null;
    selectedProjectIdRef.current = projectId;
    selectedProjectRef.current = projectId
      ? shell.projects.find(p => p.id === projectId) ?? null
      : null;
    setSelectedProjectId(projectId);
    setSelectedFocusId(session.focusId);
    setSelectedSessionId(session.id);
    setCreationMode(null);
    setSurfaceMode('terminal');
    selectSessionTab(session);
  }

  function openFocus(projectId: string | null, focusId: string) {
    selectedProjectIdRef.current = projectId;
    selectedProjectRef.current = projectId ? shell.projects.find(project => project.id === projectId) ?? null : null;
    setSelectedProjectId(projectId);
    setSelectedFocusId(focusId);
    const firstSession = shell.sessions.find(session => session.focusId === focusId && session.tabVisible !== false) ?? null;
    if (firstSession) {
      selectSessionTab(firstSession);
    } else {
      setSelectedSessionId(null);
      clearTerminalSurface();
    }
    setCreationMode(null);
    setSurfaceMode('terminal');
  }

  function openSessionHistory(projectId: string | null, focusId: string) {
    selectedProjectIdRef.current = projectId;
    selectedProjectRef.current = projectId ? shell.projects.find(project => project.id === projectId) ?? null : null;
    setSelectedProjectId(projectId);
    setSelectedFocusId(focusId);
    setSelectedSessionId(null);
    setCreationMode(null);
    setSurfaceMode('session-history');
    clearTerminalSurface();
  }

  async function setWorkspaceDefaultDangerousMode(next: boolean) {
    if (shell.workspace.defaultDangerousMode === next) return;
    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>('set_workspace_default_dangerous_mode', {
        request: { defaultDangerousMode: next },
      });
      setShell(snapshot);
      writeLog(`Default auto-approve set to ${next ? 'on' : 'off'} for this workspace.`);
    } catch (error) {
      writeLog(`Update workspace default auto-approve failed: ${errorMessage(error)}`);
    }
  }

  async function toggleSelectedSessionYolo() {
    // The CLIs read their auto-approve flag at process start, so changing the
    // setting on a live session means terminate + relaunch with --resume +
    // the new flag. The adapter contract handles the right flag per CLI
    // (Cortex `--yolo`, Claude `--dangerously-skip-permissions`, Codex
    // `--dangerously-bypass-approvals-and-sandbox`). If the session has no
    // live binding we just update the override and the next launch picks it
    // up.
    if (!selectedSession) return;
    const current = selectedSession.dangerousModeOverride ?? shell.workspace.defaultDangerousMode;
    const next = !current;
    const binding = sessionTerminalBindingsRef.current[selectedSession.id];
    if (binding) {
      const confirmed = window.confirm(
        `Restart this session with auto-approve ${next ? 'on' : 'off'}? The current ${agentLabel(selectedSession.agentKind)} process will terminate and resume with the new mode.`,
      );
      if (!confirmed) return;
    }

    setBusy(true);
    try {
      if (binding) {
        await invoke('terminate_session', { terminalId: binding.terminalId }).catch(error => {
          writeLog(`Restart terminate failed: ${errorMessage(error)}`);
        });
      }
      const snapshot = await invoke<WorkspaceShellSnapshot>('set_session_dangerous_mode', {
        request: { sessionId: selectedSession.id, dangerousModeOverride: next },
      });
      setShell(snapshot);
      const updated = snapshot.sessions.find(s => s.id === selectedSession.id);
      writeLog(`Auto-approve ${next ? 'on' : 'off'} for ${selectedSession.title}.`);
      if (updated && binding) {
        // Relaunch through the same path as a tab-click: launchRuntimeSession
        // rebuilds the spawn spec from the persisted session, which now sees
        // the updated override and will include the right dangerous flag.
        void launchRuntimeSession(updated).catch(error => {
          writeLog(`Restart with new auto-approve failed: ${errorMessage(error)}`);
        });
      }
    } catch (error) {
      writeLog(`Toggle auto-approve failed: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function setSessionTabVisibility(session: ShellSession, tabVisible: boolean) {
    const snapshot = await invoke<WorkspaceShellSnapshot>('update_session_tab_visibility', {
      request: { shellSessionId: session.id, tabVisible },
    });
    setShell(snapshot);
    return snapshot;
  }

  async function hideSessionTab(event: { stopPropagation: () => void }, session: ShellSession) {
    event.stopPropagation();
    // Closing a tab terminates the underlying CLI process. The session record
    // (title, focus, cwd, native session ref) stays in the store so the user
    // can resume it later; reopening will call the adapter's resume path
    // with the captured native session id (Cortex today, Claude/Codex once
    // their capture lands), which restarts the CLI with `--resume <id>` and
    // the session's current dangerous-mode override.
    const binding = sessionTerminalBindingsRef.current[session.id];
    if (binding) {
      try {
        await invoke('terminate_session', { terminalId: binding.terminalId });
      } catch (error) {
        writeLog(`Close requested terminal stop first; stop failed for ${shortId(binding.terminalId)}: ${errorMessage(error)}`);
      }
    }
    const nextVisibleSession = visibleSessions.find(candidate => candidate.id !== session.id) ?? null;
    const snapshot = await setSessionTabVisibility(session, false);
    if (selectedSessionId === session.id) {
      if (nextVisibleSession) {
        selectSessionTab(nextVisibleSession);
      } else {
        setSelectedSessionId(null);
        clearTerminalSurface();
        const stillHasHistory = snapshot.sessions.some(candidate => candidate.focusId === session.focusId);
        if (stillHasHistory) setSurfaceMode('session-history');
      }
    }
    writeLog(`Closed ${session.title}; CLI process terminated. Reopen to resume.`);
  }

  async function restoreSessionTab(session: ShellSession) {
    await setSessionTabVisibility(session, true);
    setSurfaceMode('terminal');
    selectSessionTab({ ...session, tabVisible: true });
    writeLog(`Restored ${session.title} to active tabs.`);
  }

  async function removeSessionRecord(session: ShellSession) {
    if (!window.confirm(`Delete session “${session.title}”? This removes it from the focus history.`)) return;
    const binding = sessionTerminalBindingsRef.current[session.id];
    if (binding) {
      await invoke('terminate_session', { terminalId: binding.terminalId }).catch(error => {
        writeLog(`Delete requested terminal stop first; stop failed for ${shortId(binding.terminalId)}: ${errorMessage(error)}`);
      });
    }
    const snapshot = await invoke<WorkspaceShellSnapshot>('remove_session', { sessionId: session.id });
    setShell(snapshot);
    setSessionTerminalBindings(bindings => {
      const next = { ...bindings };
      delete next[session.id];
      return next;
    });
    delete sessionTerminalBindingsRef.current[session.id];
    delete sessionTerminalViewsRef.current[session.id];
    delete sessionLatestFrameRef.current[session.id];
    if (selectedSessionId === session.id) {
      setSelectedSessionId(null);
      clearTerminalSurface();
    }
    writeLog(`Deleted session record: ${session.title}.`);
  }

  async function archiveFocusRecord(focus: ShellFocus) {
    if (!window.confirm(`Remove focus “${focus.title}” from navigation? Sessions under it will no longer be shown in this workspace view.`)) return;
    await terminateBoundSessions(shell.sessions.filter(session => session.focusId === focus.id));
    const snapshot = await invoke<WorkspaceShellSnapshot>('archive_focus', { focusId: focus.id });
    setShell(snapshot);
    if (selectedFocusId === focus.id) {
      setSelectedFocusId(null);
      setSelectedSessionId(null);
      clearTerminalSurface();
    }
    writeLog(`Removed focus from navigation: ${focus.title}.`);
  }

  async function terminateBoundSessions(sessions: ShellSession[]) {
    for (const session of sessions) {
      const binding = sessionTerminalBindingsRef.current[session.id];
      if (!binding) continue;
      await invoke('terminate_session', { terminalId: binding.terminalId }).catch(error => {
        writeLog(`Stop before removal failed for ${session.title}: ${errorMessage(error)}`);
      });
    }
  }

  async function archiveProjectRecord(project: ShellProject) {
    if (!window.confirm(`Remove project “${project.name}” from navigation? Its focuses and session tabs will be hidden.`)) return;
    const projectFocusIds = new Set(shell.focuses.filter(focus => focus.projectId === project.id).map(focus => focus.id));
    await terminateBoundSessions(shell.sessions.filter(session => projectFocusIds.has(session.focusId)));
    const snapshot = await invoke<WorkspaceShellSnapshot>('archive_project', { projectId: project.id });
    setShell(snapshot);
    if (selectedProjectId === project.id) {
      setSelectedProjectId(null);
      setSelectedFocusId(null);
      setSelectedSessionId(null);
      clearTerminalSurface();
    }
    writeLog(`Removed project from navigation: ${project.name}.`);
  }

  function openCreation(mode: NonNullable<CreationMode>, projectId = selectedProjectId) {
    setCreationMode(mode);
    setSurfaceMode('terminal');
    if (mode === 'focus') {
      selectedProjectIdRef.current = projectId;
      selectedProjectRef.current = projectId ? shell.projects.find(project => project.id === projectId) ?? null : null;
      setSelectedProjectId(projectId);
    }
    if (mode === 'session') {
      setNewSessionCwd(defaultCwdForFocus(selectedFocus));
    }
  }

  return (
    <main className={appShellClass} data-theme={theme} data-app-focused={appFocused ? 'true' : 'false'} data-testid="reverie-app-shell">
      <div className={windowDragStripClass} data-tauri-drag-region aria-hidden="true" />
      <DotField variant="ambient" />

      <aside className={cx(rimLitPanelClass, leftPanelClass)} aria-label="Reverie navigation" data-testid="left-panel">
        <div className={titlebarClass} data-tauri-drag-region>
          <TrafficLights />
          <div className={brandClass} data-tauri-drag-region>
            <BrandMark />
            REVERIE
          </div>
        </div>

        <button
          type="button"
          className={searchClass}
          data-testid="focus-search"
          aria-label="Open command palette"
          onClick={() => setPaletteOpen(true)}
        >
          <MagnifyingGlass size={14} />
          <span className={searchPlaceholderClass}>Search focuses, sessions…</span>
          <span className={searchShortcutClass}>⌘K</span>
        </button>

        <nav className={navClass} data-testid="workspace-nav">
          <button
            type="button"
            className={homeRowClass({ active: surfaceMode === 'dashboard' })}
            data-testid="home-nav-button"
            data-active={surfaceMode === 'dashboard' ? 'true' : 'false'}
            onClick={goToDashboard}
          >
            <House size={15} weight={surfaceMode === 'dashboard' ? 'fill' : 'regular'} />
            <span className={homeRowLabelClass}>Home</span>
            {liveSessionCount > 0 ? (
              <span className={homeRowMetaClass} data-testid="home-nav-live-count">{liveSessionCount} live</span>
            ) : null}
          </button>

          <ProjectGroup
            icon={<CircleDashed size={15} />}
            title={shell.workspace.generalLabel}
            count={sessionsForProject(null, shell).length}
            active={selectedProjectId === null && surfaceMode !== 'dashboard'}
            onProjectClick={() => {
              setSelectedProjectId(null);
              setSurfaceMode('terminal');
            }}
          >
            {shell.focuses.filter(focus => !focus.archived && !focus.projectId).map(focus => (
              <FocusRow
                key={focus.id}
                focus={focus}
                count={shell.sessions.filter(session => session.focusId === focus.id).length}
                active={focus.id === selectedFocus?.id}
                live={shell.sessions.some(session => session.focusId === focus.id && session.status === 'running')}
                onClick={() => openFocus(null, focus.id)}
                onHistory={event => {
                  event.stopPropagation();
                  openSessionHistory(null, focus.id);
                }}
                onRemoveFocus={event => {
                  event.stopPropagation();
                  void archiveFocusRecord(focus);
                }}
              />
            ))}
            <button className={addFocusRowClass} type="button" data-testid="create-focus-button" disabled={busy || !canUseAppServices} onClick={() => openCreation('focus', null)}>
              <Plus size={13} />
              <span>New focus</span>
            </button>
          </ProjectGroup>

          <div className={sectionLabelClass}>
            <span>Projects</span>
            <button type="button" title="Add project" data-testid="add-project-button" disabled={busy || !canUseAppServices} onClick={() => openCreation('project')}><Plus size={13} /></button>
          </div>

          {shell.projects.filter(project => !project.archived).map(project => {
            const projectFocuses = shell.focuses.filter(focus => !focus.archived && focus.projectId === project.id);
            return (
              <ProjectGroup
                key={project.id}
                icon={<Folder size={15} />}
                title={project.name}
                count={sessionsForProject(project.id, shell).length}
                active={selectedProjectId === project.id}
                onProjectClick={() => {
                  setSelectedProjectId(project.id);
                  setSurfaceMode('terminal');
                }}
                onRemoveProject={event => {
                  event.stopPropagation();
                  void archiveProjectRecord(project);
                }}
              >
                {projectFocuses.map(focus => (
                  <FocusRow
                    key={focus.id}
                    focus={focus}
                    count={shell.sessions.filter(session => session.focusId === focus.id).length}
                    active={focus.id === selectedFocus?.id}
                    live={shell.sessions.some(session => session.focusId === focus.id && session.status === 'running')}
                    onClick={() => openFocus(project.id, focus.id)}
                    onHistory={event => {
                      event.stopPropagation();
                      openSessionHistory(project.id, focus.id);
                    }}
                    onRemoveFocus={event => {
                      event.stopPropagation();
                      void archiveFocusRecord(focus);
                    }}
                  />
                ))}
                <button className={addFocusRowClass} type="button" data-testid="create-project-focus-button" disabled={busy || !canUseAppServices} onClick={() => openCreation('focus', project.id)}>
                  <Plus size={13} />
                  <span>New focus</span>
                </button>
              </ProjectGroup>
            );
          })}
        </nav>

        <div className={leftFooterClass}>
          <button
            type="button"
            className={settingsNavRowClass({ active: surfaceMode === 'settings' })}
            data-testid="open-settings-button"
            data-active={surfaceMode === 'settings' ? 'true' : 'false'}
            onClick={() => setSurfaceMode('settings')}
          >
            <GearSix size={15} weight={surfaceMode === 'settings' ? 'fill' : 'regular'} />
            <span>Settings</span>
          </button>
        </div>
      </aside>

      <section className={canvasStageClass} aria-label="Focus view" data-testid="focus-stage">
        {surfaceMode === 'dashboard' ? (
          <DashboardSurface
            shell={shell}
            sessionTerminalBindings={sessionTerminalBindings}
            cortexActivity={cortexActivity}
            onOpenSession={openSessionFromDashboard}
            onCreateProject={() => openCreation('project')}
            onCreateFocus={() => openCreation('focus')}
            cliDetections={agentCliDetections}
            onSetWorkspaceDefaultDangerousMode={next => void setWorkspaceDefaultDangerousMode(next)}
          />
        ) : surfaceMode === 'settings' ? (
          <SettingsSurface
            newSessionAgentKind={newSessionAgentKind}
            setNewSessionAgentKind={setNewSessionAgentKind}
            newSessionDangerousMode={newSessionDangerousMode}
            setNewSessionDangerousMode={setNewSessionDangerousMode}
          />
        ) : surfaceMode === 'session-history' ? (
          <SessionHistorySurface
            focus={selectedFocus}
            sessions={focusSessions}
            visibleCount={visibleSessions.length}
            hiddenCount={hiddenFocusSessions.length}
            onRestore={session => restoreSessionTab(session).catch(error => writeLog(`Restore failed: ${errorMessage(error)}`))}
            onDelete={session => removeSessionRecord(session).catch(error => writeLog(`Delete failed: ${errorMessage(error)}`))}
            onCreateSession={() => openCreation('session')}
            busy={busy}
          />
        ) : (
          <div className={activeSurfaceClass} data-testid="terminal-stage">
            {!creationMode ? (
              <div className={topBandClass}>
                <div className={tabsClass} data-testid="session-tabs">
                  {visibleSessions.map(session => (
                    <button
                      key={session.id}
                      className={tabClass({ active: session.id === selectedSession?.id })}
                      type="button"
                      data-testid="session-tab"
                      data-session-id={session.id}
                      data-active={session.id === selectedSession?.id ? 'true' : 'false'}
                      onClick={() => selectSessionTab(session)}
                    >
                      <AgentGlyph kind={session.agentKind} />
                      <span>{agentTabLabel(session)}</span>
                      {session.status === 'running' || session.id === runningSessionId ? <i className={runningDotClass} /> : null}
                      <span
                        className={tabCloseClass}
                        role="button"
                        tabIndex={0}
                        data-testid="close-session-tab-button"
                        aria-label={`Close ${session.title} tab`}
                        onClick={event => void hideSessionTab(event, session)}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') void hideSessionTab(event, session);
                        }}
                      >
                        <X size={12} />
                      </span>
                    </button>
                  ))}
                  {visibleSessions.length === 0 ? (
                    <div className={emptyTabsHintClass} data-testid="empty-session-tabs">No sessions in this focus</div>
                  ) : null}
                  <span className={tabDividerClass} />
                  <button className={newTabClass} type="button" data-testid="create-session-button" disabled={busy || !canUseAppServices || !selectedFocus} onClick={() => openCreation('session')} title="New session">
                    <Plus size={14} />
                  </button>
                </div>

                <div className={topControlsClass} data-testid="terminal-controls">
                  <button
                    type="button"
                    className={autoApproveChipClass({ warn: effectiveDangerousMode })}
                    data-testid="auto-approve-chip"
                    aria-pressed={effectiveDangerousMode}
                    disabled={!selectedSession || busy}
                    title={
                      selectedTerminalBinding
                        ? `Click to restart this session with auto-approve ${effectiveDangerousMode ? 'off' : 'on'}.`
                        : `Click to set auto-approve ${effectiveDangerousMode ? 'off' : 'on'} for the next launch.`
                    }
                    onClick={() => void toggleSelectedSessionYolo()}
                  >
                    <ShieldWarning size={14} />
                    {effectiveDangerousMode ? 'Auto-approve · on' : 'Auto-approve · off'}
                  </button>
                </div>
              </div>
            ) : null}

            {creationMode ? (
              <CreationComposer
                mode={creationMode}
                selectedProject={selectedProject}
                selectedFocus={selectedFocus}
                newProjectName={newProjectName}
                setNewProjectName={setNewProjectName}
                newProjectPath={newProjectPath}
                setNewProjectPath={setNewProjectPath}
                newFocusTitle={newFocusTitle}
                setNewFocusTitle={setNewFocusTitle}
                newSessionTitle={newSessionTitle}
                setNewSessionTitle={setNewSessionTitle}
                newSessionCwd={newSessionCwd}
                setNewSessionCwd={setNewSessionCwd}
                newSessionAgentKind={newSessionAgentKind}
                setNewSessionAgentKind={setNewSessionAgentKind}
                newSessionDangerousMode={newSessionDangerousMode}
                setNewSessionDangerousMode={setNewSessionDangerousMode}
                cliDetections={agentCliDetections}
                busy={busy}
                onChooseProjectFolder={() => chooseProjectFolder().catch(() => {})}
                onCreateProject={() => createProjectFromComposer().catch(() => {})}
                onCreateFocus={() => createFocusForSelection().catch(() => {})}
                onCreateSession={() => createSessionForSelection().catch(() => {})}
                onCancel={() => setCreationMode(null)}
              />
            ) : null}

            {selectedSession && !creationMode ? (
              <div className={terminalBodyClass} data-testid="terminal-body" data-session-id={selectedSession.id} data-terminal-id={selectedTerminalBinding?.terminalId ?? ''}>
                <div className={terminalMetaStripClass} data-testid="terminal-meta-strip" data-session-id={selectedSession.id} data-terminal-id={selectedTerminalBinding?.terminalId ?? ''}>
                  <span className={metaStripBreadcrumbClass}>{sessionBreadcrumb(selectedSession, shell)} · {selectedSession.title}</span>
                  <span data-testid="terminal-status-label" className={metaStripStatusClass}>{runningLabel}</span>
                  <span className={metaStripCwdClass} title={selectedSession.cwd}>{shortenCwd(selectedSession.cwd)}</span>
                  {!terminalLiveFollow ? (
                    <button type="button" className={followLiveButtonClass} data-testid="follow-live-button" onClick={followLiveTerminalOutput}>Jump to latest</button>
                  ) : null}
                  <span data-testid="scrollback-row-count" hidden>{scrollbackRowCount.toLocaleString()} / {scrollbackContract.maxRenderedHistoryRows.toLocaleString()}</span>
                  <span data-testid="follow-live-state" hidden>{terminalLiveFollow ? 'live' : 'history'}</span>
                </div>
                {selectedPermissionRequest ? (
                  <div
                    className={permissionBannerClass}
                    data-testid="session-permission-banner"
                    role="status"
                  >
                    <ShieldWarning size={14} weight="fill" />
                    <div className={permissionBannerBodyClass}>
                      <strong>{agentLabel(selectedSession?.agentKind ?? '')} wants to {selectedPermissionRequest.toolName}</strong>
                      <span data-testid="session-permission-banner-summary">{selectedPermissionRequest.displaySummary}</span>
                    </div>
                    <span className={permissionBannerHintClass}>Respond in the terminal</span>
                  </div>
                ) : null}
                <div ref={surfaceViewportRef} className={surfaceViewportClass} data-testid="terminal-viewport" onScroll={handleTerminalScroll} onWheel={handleTerminalWheel} onMouseDown={focusTerminalCanvas}>
                  <div ref={terminalScrollSpacerRef} className={terminalScrollSpacerClass} data-testid="terminal-scroll-spacer">
                    <canvas
                      ref={canvasRef}
                      className="terminal-canvas"
                      data-testid="terminal-canvas"
                      aria-label="Terminal runtime surface"
                      tabIndex={0}
                      onKeyDown={handleTerminalKeyDown}
                      onPaste={handleTerminalPaste}
                      onMouseDown={focusTerminalCanvas}
                    />
                  </div>
                  {!selectedTerminalBinding ? (
                    <SessionLaunchOverlay
                      session={selectedSession}
                      launching={isLaunchingSelectedSession}
                      disabled={busy && !isLaunchingSelectedSession}
                      onLaunch={() => {
                        void launchRuntimeSession(selectedSession).catch(error => {
                          writeLog(`Launch failed: ${errorMessage(error)}`);
                        });
                      }}
                    />
                  ) : null}
                </div>
              </div>
            ) : creationMode ? null : (
              <EmptyState
                cliDetections={agentCliDetections}
                createFocus={() => openCreation('focus')}
                createProject={() => openCreation('project')}
                openSettings={() => setSurfaceMode('settings')}
                workspaceDefaultDangerousMode={shell.workspace.defaultDangerousMode}
                onSetWorkspaceDefaultDangerousMode={next => void setWorkspaceDefaultDangerousMode(next)}
              />
            )}
          </div>
        )}
      </section>

      {paletteOpen ? (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onPickSession={session => {
            setPaletteOpen(false);
            openSessionFromDashboard(session);
          }}
          onPickFocus={(projectId, focusId) => {
            setPaletteOpen(false);
            openFocus(projectId, focusId);
          }}
        />
      ) : null}
    </main>
  );
}







const canUseAppServices = true;


const windowDragStripClass = css({
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  height: '22px',
  zIndex: 4,
  lgDown: { height: '14px' },
  mdDown: { display: 'none' },
});

// Layout-only; the rim-lit surface treatment is composed in via cx() at the
// call site (see themes/surfaces.ts rimLitPanelClass).
const leftPanelClass = css({
  zIndex: 2,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
});

const titlebarClass = css({
  position: 'relative',
  zIndex: 2,
  padding: '14px 16px 10px',
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
});

const brandClass = css({
  marginLeft: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  color: 'var(--text-2)',
  fontSize: '11.5px',
  fontWeight: 500,
  letterSpacing: '0.04em',
});

const searchClass = css({
  margin: '6px 14px 12px',
  padding: '8px 10px',
  background: 'var(--surface-2)',
  border: '1px solid var(--line)',
  borderRadius: '10px',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  color: 'var(--text-3)',
  position: 'relative',
  zIndex: 2,
  cursor: 'pointer',
  width: 'calc(100% - 28px)',
  textAlign: 'left',
  transition: 'border-color 120ms ease, color 120ms ease',
  _hover: { borderColor: 'var(--line-strong)', color: 'var(--text-2)' },
});

const searchPlaceholderClass = css({
  flex: 1,
  minWidth: 0,
  fontSize: '13px',
  color: 'var(--text-3)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const searchShortcutClass = css({
  fontSize: '10.5px',
  color: 'var(--text-3)',
  padding: '1px 5px',
  border: '1px solid var(--line)',
  borderRadius: '4px',
  background: 'var(--surface-1)',
  flexShrink: 0,
});


const navClass = css({
  flex: 1,
  overflowY: 'auto',
  padding: '4px 8px 12px',
  position: 'relative',
  zIndex: 2,
  '&::-webkit-scrollbar': { width: '8px' },
  '&::-webkit-scrollbar-thumb': {
    background: 'var(--line)',
    borderRadius: '8px',
    border: '2px solid var(--surface-1)',
  },
});

function homeRowClass({ active }: { active: boolean }) {
  return css({
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    padding: '7px 10px',
    marginBottom: '8px',
    borderRadius: '8px',
    border: '1px solid',
    borderColor: active ? 'var(--line-strong)' : 'transparent',
    color: active ? 'var(--text)' : 'var(--text-2)',
    background: active ? 'var(--surface-3)' : 'transparent',
    cursor: 'pointer',
    userSelect: 'none',
    textAlign: 'left',
    fontSize: '13px',
    fontWeight: 500,
    letterSpacing: '-0.005em',
    transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
    _hover: { background: 'var(--surface-2)', color: 'var(--text)' },
    '& svg': { color: active ? 'var(--text)' : 'var(--text-3)', flexShrink: 0 },
  });
}

const homeRowLabelClass = css({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const homeRowMetaClass = css({
  fontSize: '10.5px',
  color: 'var(--text-3)',
  fontVariantNumeric: 'tabular-nums',
  padding: '1px 7px',
  border: '1px solid var(--line)',
  borderRadius: '999px',
  background: 'color-mix(in srgb, var(--surface-1) 70%, transparent)',
});


const addFocusRowClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  width: '100%',
  padding: '5px 10px',
  borderRadius: '8px',
  color: 'var(--text-3)',
  cursor: 'pointer',
  textAlign: 'left',
  _hover: { background: 'var(--surface-2)', color: 'var(--text)' },
});

const sectionLabelClass = css({
  padding: '12px 8px 4px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  color: 'var(--text-3)',
  fontSize: '10.5px',
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  '& button': {
    color: 'var(--text-3)',
    width: '18px',
    height: '18px',
    display: 'grid',
    placeItems: 'center',
    borderRadius: '5px',
    cursor: 'pointer',
    _hover: { background: 'var(--surface-2)', color: 'var(--text)' },
  },
});

const leftFooterClass = css({
  borderTop: '1px solid var(--line-faint)',
  padding: '8px 10px 10px',
  position: 'relative',
  zIndex: 2,
});

function settingsNavRowClass({ active }: { active: boolean }) {
  return css({
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    padding: '9px 10px',
    borderRadius: '8px',
    border: '1px solid',
    borderColor: active ? 'var(--line-strong)' : 'transparent',
    color: active ? 'var(--text)' : 'var(--text-2)',
    background: active ? 'var(--surface-3)' : 'transparent',
    cursor: 'pointer',
    userSelect: 'none',
    textAlign: 'left',
    fontSize: '13px',
    fontWeight: 500,
    letterSpacing: '-0.005em',
    transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
    _hover: { background: 'var(--surface-2)', color: 'var(--text)' },
    '& svg': { color: active ? 'var(--text)' : 'var(--text-3)', flexShrink: 0 },
    '& span': { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  });
}

const canvasStageClass = css({
  zIndex: 2,
  minWidth: 0,
  minHeight: 0,
  position: 'relative',
});

const activeSurfaceClass = css({
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  borderRadius: '22px',
  background: 'transparent',
});

const topBandClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '16px',
  padding: '4px 4px 12px',
  flexShrink: 0,
});

const tabsClass = css({
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0',
  overflowX: 'auto',
  padding: '4px',
  borderRadius: '12px',
  border: '1px solid var(--line)',
  background: 'var(--surface-1)',
  boxShadow: 'var(--shadow)',
});

function tabClass({ active }: { active: boolean }) {
  return css({
    height: '28px',
    minWidth: 'auto',
    maxWidth: '174px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '7px',
    padding: '0 11px',
    borderRadius: '8px',
    color: active ? 'var(--text)' : 'var(--text-2)',
    background: active ? 'var(--surface-3)' : 'transparent',
    border: '0',
    boxShadow: active ? 'inset 0 1px 0 rgba(255,255,255,0.035)' : 'none',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    fontSize: '12px',
    fontWeight: 500,
    transition: 'background 0.15s ease, color 0.15s ease',
    _hover: { color: 'var(--text)' },
    '& > span:nth-child(2)': { overflow: 'hidden', textOverflow: 'ellipsis' },
  });
}

const runningDotClass = css({
  width: '5px',
  height: '5px',
  borderRadius: '50%',
  background: 'var(--good)',
  boxShadow: '0 0 0 3px rgba(111,184,122,0.14)',
  marginLeft: '2px',
});

const tabCloseClass = css({
  opacity: 0.45,
  flexShrink: 0,
  width: '14px',
  height: '14px',
  padding: '1px',
  borderRadius: '3px',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  _hover: { opacity: 1, background: 'var(--surface-hi)' },
});

const emptyTabsHintClass = css({
  color: 'var(--text-3)',
  padding: '0 8px',
  fontSize: '12px',
});

const tabDividerClass = css({
  width: '1px',
  height: '18px',
  background: 'var(--line)',
  margin: '0 2px',
  flexShrink: 0,
});

const newTabClass = css({
  width: '26px',
  height: '26px',
  display: 'grid',
  placeItems: 'center',
  borderRadius: '8px',
  border: '0',
  color: 'var(--text-3)',
  background: 'transparent',
  cursor: 'pointer',
  _hover: { background: 'var(--surface-3)', color: 'var(--text)' },
  _disabled: { opacity: 0.45, cursor: 'not-allowed' },
});

const topControlsClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '10px',
  flexShrink: 0,
});

function autoApproveChipClass({ warn }: { warn: boolean }) {
  return css({
    height: '28px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '0 10px 0 8px',
    borderRadius: '999px',
    border: `1px solid ${warn ? 'color-mix(in srgb, var(--warn) 38%, transparent)' : 'var(--line)'}`,
    color: warn ? 'var(--warn)' : 'var(--text-2)',
    background: 'var(--surface-1)',
    boxShadow: 'var(--shadow)',
    fontSize: '11.5px',
    fontWeight: 500,
    whiteSpace: 'nowrap',
  });
}

const launchButtonClass = css({
  height: '28px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '7px',
  padding: '0 10px',
  borderRadius: '999px',
  border: '1px solid var(--line)',
  color: 'var(--text)',
  background: 'var(--surface-1)',
  boxShadow: 'var(--shadow)',
  cursor: 'pointer',
  fontSize: '11.5px',
  fontWeight: 500,
  _disabled: { opacity: 0.45, cursor: 'not-allowed' },
});

const terminateButtonClass = css({
  height: '28px',
  padding: '0 10px',
  borderRadius: '999px',
  border: '1px solid var(--line)',
  color: 'var(--text-2)',
  background: 'var(--surface-1)',
  boxShadow: 'var(--shadow)',
  cursor: 'pointer',
  fontSize: '11.5px',
  fontWeight: 500,
  _disabled: { opacity: 0.4, cursor: 'not-allowed' },
});

const terminalBodyClass = css({
  position: 'relative',
  flex: 1,
  minHeight: 0,
  display: 'grid',
  // meta strip | optional permission banner | viewport
  gridTemplateRows: 'auto auto minmax(0, 1fr)',
  overflow: 'hidden',
  borderRadius: '0 0 22px 22px',
  background: 'transparent',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.025)',
});

const permissionBannerClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '8px 14px',
  background: 'color-mix(in srgb, var(--warn) 12%, transparent)',
  borderBottom: '1px solid color-mix(in srgb, var(--warn) 28%, transparent)',
  color: 'var(--text)',
  fontSize: '12px',
  '& > svg': { color: 'var(--warn)', flexShrink: 0 },
});

const permissionBannerBodyClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  minWidth: 0,
  flex: 1,
  '& strong': { fontWeight: 500, color: 'var(--text)' },
  '& span': {
    fontSize: '11.5px',
    color: 'var(--text-2)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

const permissionBannerHintClass = css({
  fontSize: '10.5px',
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--warn)',
  flexShrink: 0,
});

const terminalMetaStripClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '8px 14px',
  borderBottom: '1px solid color-mix(in srgb, var(--line) 60%, transparent)',
  color: 'var(--text-3)',
  fontSize: '11.5px',
  whiteSpace: 'nowrap',
  overflowX: 'auto',
  '& [hidden]': { display: 'none' },
});

const metaStripBreadcrumbClass = css({
  color: 'var(--text-2)',
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  minWidth: 0,
  flex: '0 1 auto',
});

const metaStripStatusClass = css({
  color: 'var(--text-3)',
  fontSize: '10.5px',
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  flexShrink: 0,
});

const metaStripCwdClass = css({
  color: 'var(--text-3)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: '10.5px',
  marginLeft: 'auto',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

const followLiveButtonClass = css({
  color: 'var(--text-2)',
  border: '1px solid var(--line)',
  background: 'transparent',
  borderRadius: '999px',
  padding: '3px 9px',
  cursor: 'pointer',
  fontSize: '10.5px',
  fontWeight: 500,
  flexShrink: 0,
  transition: 'color 140ms ease, border-color 140ms ease',
  _hover: { color: 'var(--text)', borderColor: 'var(--line-strong)' },
});

const surfaceViewportClass = css({
  position: 'relative',
  minHeight: 0,
  height: '100%',
  overflow: 'auto',
  background: 'transparent',
});

const terminalScrollSpacerClass = css({
  position: 'relative',
  minHeight: '100%',
  overflow: 'hidden',
});





