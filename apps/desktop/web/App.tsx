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
} from 'react';
import { invoke, listen, type UnlistenFn } from './appRuntime';
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

import { css } from './styled-system/css';
import {
  TERMINAL_SURFACE,
  createTerminalCanvasRenderer,
  makeSyntheticFrame,
  percentile,
} from './terminal-canvas-renderer';
import {
  SCROLL_FOLLOW_EPSILON_PX,
  boundedRenderedScrollback,
  cloneTerminalRow,
  frameForSurface,
  frameWithScrollback,
  scrolledOffRows,
  terminalScrollbackContract,
  terminalSurfaceForBounds,
  type TerminalSurface,
} from './terminalScrollback';
import type { TerminalFrame, TerminalRenderer, TerminalRow } from './terminalTypes';
import { maybeRunHarnessSmokeTest } from './harnessSmoke';
import { createDotField, type DotFieldHandle, type DotFieldVariant } from './dotField';

type WindowControlAction = 'close' | 'minimize' | 'toggleMaximize';
async function invokeWindowControl(action: WindowControlAction) {
  // Lazy-import so the browser harness (no Tauri APIs) doesn't pay the cost
  // and so a missing module never breaks the React shell.
  try {
    const tauriGlobals = window as Window & {
      __TAURI_INTERNALS__?: unknown;
      __TAURI__?: unknown;
      __REVERIE_BROWSER_FIXTURE__?: unknown;
    };
    if (!tauriGlobals.__TAURI_INTERNALS__ && !tauriGlobals.__TAURI__) return;
    if (tauriGlobals.__REVERIE_BROWSER_FIXTURE__) return;
    const mod = await import('@tauri-apps/api/window');
    const win = mod.getCurrentWindow();
    if (action === 'close') await win.close();
    else if (action === 'minimize') await win.minimize();
    else await win.toggleMaximize();
  } catch (error) {
    console.warn('[reverie] window control failed', action, error);
  }
}

const BENCH_FRAMES = 360;
const DIRTY_ROWS_PER_FRAME = 8;
const DEFAULT_TERMINAL_SCROLLBACK_ROWS = 10_000;
const USER_HOME = '/Users/user';

type MetricValue = string | number | boolean | undefined;
type ProjectFilter = string | null;
type ThemeMode = 'dark' | 'light';
type SurfaceMode = 'dashboard' | 'terminal' | 'settings' | 'session-history';

interface RenderMetrics {
  mode: string;
  frames: number;
  framesReceived?: number;
  droppedFrames?: number;
  chunksRead?: number;
  cellsDrawn: number;
  elapsedMs: number;
  avgFrameMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
  cellsPerSecond: number;
  bridgeMs?: number;
  outputBytes?: number;
  rustElapsedMs?: number;
  totalEmitMs?: number;
  avgEmitMs?: number;
  maxEmitMs?: number;
  avgInterEventMs?: number;
  p95InterEventMs?: number;
  maxInterEventMs?: number;
  childSuccess?: boolean;
  targetFrames?: number;
  terminalId?: string;
}

interface GhosttyFrameSequencePayload {
  frames: TerminalFrame[];
  output_bytes: number;
}

interface StartSessionRequest {
  sessionId: string;
  terminalId: string;
  cols: number;
  rows: number;
  maxScrollback: number;
}

interface TerminalStreamStartedPayload {
  terminalId: string;
  targetFrames?: number | null;
  cols: number;
  rows: number;
}

interface TerminalFramePayload {
  terminalId: string;
  seq: number;
  bytesRead: number;
  chunkBytes: number;
  rustElapsedMs: number;
  frame: TerminalFrame;
}

interface TerminalExitPayload {
  terminalId: string;
  framesEmitted: number;
  chunksRead: number;
  bytesRead: number;
  rustElapsedMs: number;
  totalEmitMs: number;
  avgEmitMs: number;
  maxEmitMs: number;
  childSuccess: boolean;
}

interface TerminalFailedPayload {
  terminalId?: string;
  message?: string;
}

interface WorkspaceShellSnapshot {
  workspace: ShellWorkspace;
  projects: ShellProject[];
  focuses: ShellFocus[];
  sessions: ShellSession[];
}

interface ShellWorkspace {
  id: string;
  name: string;
  generalLabel: string;
  defaultDangerousMode: boolean;
}

interface ShellProject {
  id: string;
  name: string;
  path: string;
  archived: boolean;
}

interface ShellFocus {
  id: string;
  projectId?: string | null;
  title: string;
  description?: string | null;
  sortOrder: number;
  archived: boolean;
}

interface NativeSessionRef {
  kind: string;
  sessionId?: string | null;
  metadataPath?: string | null;
  adapterPayload?: unknown;
}

interface ShellSession {
  id: string;
  focusId: string;
  title: string;
  agentKind: string;
  cwd: string;
  nativeSessionRef?: NativeSessionRef | null;
  launchMode: 'new' | 'resume';
  dangerousModeOverride?: boolean | null;
  status: 'not_started' | 'running' | 'exited' | 'restorable' | 'restore_failed';
  lastExitCode?: number | null;
  tabVisible?: boolean;
}

type AgentKind = 'claude_code' | 'codex_cli' | 'cortex_code';
type CreationMode = 'project' | 'focus' | 'session' | null;

interface CreateProjectRequest {
  name: string;
  path: string;
}

interface ProjectFolderSelection {
  name: string;
  path: string;
}

interface SessionTerminalBinding {
  terminalId: string;
  inputArmed: boolean;
}

interface SessionTerminalView {
  lastFrame: TerminalFrame | null;
  compositeFrame: TerminalFrame;
  scrollbackRows: TerminalRow[];
  rowCount: number;
  liveFollow: boolean;
}

interface CreateFocusRequest {
  projectId: string | null;
  title: string;
  description?: string | null;
}

interface CreateSessionRecordRequest {
  focusId: string;
  title: string;
  agentKind: AgentKind;
  cwd: string;
  dangerousModeOverride?: boolean | null;
}

interface AgentCliDetection {
  kind: AgentKind;
  displayName: string;
  executable?: string | null;
  candidates: string[];
  available: boolean;
}

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
  const liveFollowRef = useRef(true);
  const autoScrollingTerminalRef = useRef(false);
  const userTerminalScrollRef = useRef(false);
  const [shell, setShell] = useState<WorkspaceShellSnapshot>(() => fallbackShellSnapshot());
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectFilter>(null);
  const [selectedFocusId, setSelectedFocusId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [creationMode, setCreationMode] = useState<CreationMode>(null);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newFocusTitle, setNewFocusTitle] = useState('');
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [newSessionCwd, setNewSessionCwd] = useState(USER_HOME);
  const [newSessionAgentKind, setNewSessionAgentKind] = useState<CreateSessionRecordRequest['agentKind']>('cortex_code');
  const [newSessionDangerousMode, setNewSessionDangerousMode] = useState(false);
  const [agentCliDetections, setAgentCliDetections] = useState<AgentCliDetection[]>(() => fallbackAgentCliDetections());
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [runningSessionId, setRunningSessionId] = useState<string | null>(null);
  // Tracks which session is mid-launch so the terminal surface can show the
  // breathing launch animation. Cleared automatically when the live terminal
  // binding arrives, or on launch failure.
  const [launchingSessionId, setLaunchingSessionId] = useState<string | null>(null);
  const [terminalInputArmed, setTerminalInputArmed] = useState(false);
  const [sessionTerminalBindings, setSessionTerminalBindings] = useState<Record<string, SessionTerminalBinding>>({});
  const [terminalSurface, setTerminalSurface] = useState<TerminalSurface>(() => TERMINAL_SURFACE);
  const [scrollbackRowCount, setScrollbackRowCount] = useState(0);
  const [terminalLiveFollow, setTerminalLiveFollow] = useState(true);
  const [logs, setLogs] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<RenderMetrics[]>([]);
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>('dashboard');
  const isTauriRuntime = useMemo(() => Boolean(window.__TAURI_INTERNALS__ || (window.__TAURI__ && !window.__REVERIE_BROWSER_FIXTURE__)), []);
  const canUseAppServices = true;
  const scrollbackContract = useMemo(() => terminalScrollbackContract(terminalSurface), [terminalSurface]);

  const selectedProject = selectedProjectId ? shell.projects.find(project => project.id === selectedProjectId) ?? null : null;
  const selectedProjectIdRef = useRef<string | null>(selectedProjectId);
  const selectedProjectRef = useRef<ShellProject | null>(selectedProject);
  const sessionTerminalBindingsRef = useRef<Record<string, SessionTerminalBinding>>({});
  const sessionTerminalViewsRef = useRef<Record<string, SessionTerminalView>>({});
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
  const liveSessionCount = useMemo(
    () => shell.sessions.filter(s => s.tabVisible !== false && (s.status === 'running' || sessionTerminalBindings[s.id])).length,
    [shell.sessions, sessionTerminalBindings],
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
  const runningLabel = selectedTerminalBinding
    ? `${selectedSession?.title ?? 'Terminal'} · ${shortId(selectedTerminalBinding.terminalId)}${selectedTerminalBinding.inputArmed ? '' : ' · starting'}`
    : busy ? 'Working' : selectedSession ? 'Created · waiting for launch' : 'Ready';

  const writeLog = (line: string) => {
    const stamped = `[${new Date().toLocaleTimeString()}] ${line}`;
    setLogs(current => [stamped, ...current].slice(0, 80));
  };

  function mountTerminalRenderer(surface = terminalSurfaceRef.current, displayRows = surface.rows) {
    if (!canvasRef.current) return null;

    const renderer = createTerminalCanvasRenderer(canvasRef.current, { ...surface, rows: displayRows });
    rendererRef.current = renderer;
    return renderer;
  }

  function ensureTerminalRenderer(surface: TerminalSurface, displayRows: number) {
    const renderer = rendererRef.current;
    if (!renderer || renderer.cols !== surface.cols || renderer.rows !== displayRows) {
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
    let renderedScrollbackRows = previousView?.scrollbackRows ?? [];

    if (previousView?.lastFrame) {
      const scrolledRows = scrolledOffRows(previousView.lastFrame.rows, surfaceFrame.rows);
      if (scrolledRows.length > 0) {
        renderedScrollbackRows = boundedRenderedScrollback(
          [
            ...renderedScrollbackRows,
            ...scrolledRows.map(cloneTerminalRow),
          ],
          surface,
        );
      }
    }

    renderedScrollbackRows = boundedRenderedScrollback(renderedScrollbackRows, surface);
    return {
      lastFrame: surfaceFrame,
      compositeFrame: frameWithScrollback(renderedScrollbackRows, surfaceFrame),
      scrollbackRows: renderedScrollbackRows,
      rowCount: renderedScrollbackRows.length,
      liveFollow: previousView?.liveFollow ?? true,
    };
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

  function rememberScrolledRows(previousFrame: TerminalFrame | null, nextFrame: TerminalFrame, surface: TerminalSurface) {
    if (!previousFrame) return;

    const scrolledRows = scrolledOffRows(previousFrame.rows, nextFrame.rows);
    if (scrolledRows.length === 0) return;

    const nextScrollback = boundedRenderedScrollback(
      [
        ...scrollbackRowsRef.current,
        ...scrolledRows.map(cloneTerminalRow),
      ],
      surface,
    );

    scrollbackRowsRef.current = nextScrollback;
    setScrollbackRowCount(nextScrollback.length);
  }

  function paintVisibleTerminalWindow(frame = lastCompositeTerminalFrameRef.current, surface = terminalSurfaceRef.current) {
    if (!frame) return;

    const viewport = surfaceViewportRef.current;
    const viewportHeight = Math.max(surface.cellHeight, viewport?.clientHeight ?? surface.rows * surface.cellHeight);
    const overscanRows = 3;
    const displayRows = Math.max(surface.rows, Math.ceil(viewportHeight / surface.cellHeight) + overscanRows * 2);
    const scrollTop = viewport?.scrollTop ?? 0;
    const maxStartRow = Math.max(0, frame.rows.length - displayRows);
    const startRow = Math.min(maxStartRow, Math.max(0, Math.floor(scrollTop / surface.cellHeight) - overscanRows));
    const endRow = startRow + displayRows;
    const rows = frame.rows
      .filter(row => row.index >= startRow && row.index < endRow)
      .map(row => ({
        ...cloneTerminalRow(row),
        index: row.index - startRow,
        dirty: true,
      }));
    const cursorRow = frame.cursor?.position?.row ?? frame.cursor?.row;
    const cursorCol = frame.cursor?.position?.col ?? frame.cursor?.col;
    const cursorVisible = Number.isFinite(cursorRow) && Number.isFinite(cursorCol) && (cursorRow as number) >= startRow && (cursorRow as number) < endRow;
    const windowFrame: TerminalFrame = {
      ...frame,
      dirty: 'full',
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
    const renderer = ensureTerminalRenderer(surface, displayRows);
    if (canvasRef.current) {
      canvasRef.current.style.transform = `translateY(${startRow * surface.cellHeight}px)`;
    }
    renderer?.clear();
    renderer?.paintFrame(windowFrame);
  }

  function paintTerminalFrame(frame: TerminalFrame, { rememberScrollback = true }: { rememberScrollback?: boolean } = {}) {
    const surface = terminalSurfaceRef.current;
    const surfaceFrame = frameForSurface(frame, surface);

    if (rememberScrollback) {
      rememberScrolledRows(lastTerminalFrameRef.current, surfaceFrame, surface);
    }

    lastTerminalFrameRef.current = surfaceFrame;
    const renderedScrollbackRows = boundedRenderedScrollback(scrollbackRowsRef.current, surface);
    if (renderedScrollbackRows.length !== scrollbackRowsRef.current.length) {
      scrollbackRowsRef.current = renderedScrollbackRows;
      setScrollbackRowCount(renderedScrollbackRows.length);
    }
    const compositeFrame = frameWithScrollback(renderedScrollbackRows, surfaceFrame);
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
      const sessionView = sessionTerminalViewsRef.current[selectedSessionId];
      if (sessionView) {
        applyTerminalView(sessionView, surface);
        return;
      }
    }

    if (lastTerminalFrameRef.current) {
      paintTerminalFrame(lastTerminalFrameRef.current, { rememberScrollback: false });
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

  useEffect(() => {
    invoke<AgentCliDetection[]>('list_agent_clis')
      .then(detections => {
        setAgentCliDetections(detections);
        const firstAvailable = detections.find(detection => detection.available);
        if (firstAvailable && !detections.some(detection => detection.kind === newSessionAgentKind && detection.available)) {
          setNewSessionAgentKind(firstAvailable.kind);
        }
      })
      .catch(error => {
        setAgentCliDetections(fallbackAgentCliDetections());
        writeLog(`CLI detection failed; using fixture choices: ${errorMessage(error)}`);
      });
  }, [newSessionAgentKind]);

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

  async function runSyntheticBenchmark({ dirtyOnly }: { dirtyOnly: boolean }): Promise<RenderMetrics> {
    const renderer = requireRenderer();
    const timings: number[] = [];
    let cellsDrawn = 0;
    const started = performance.now();

    for (let frameIndex = 0; frameIndex < BENCH_FRAMES; frameIndex += 1) {
      const frame = makeSyntheticFrame(frameIndex, {
        cols: renderer.cols,
        rows: renderer.rows,
        dirtyRowsPerFrame: DIRTY_ROWS_PER_FRAME,
        dirtyOnly,
      });
      const frameStarted = performance.now();
      renderer.paintFrame(frame);
      const frameEnded = performance.now();
      timings.push(frameEnded - frameStarted);
      cellsDrawn += frame.rows.reduce((sum, row) => sum + row.cells.length, 0);

      if (frameIndex % 30 === 0) {
        await new Promise(requestAnimationFrame);
      }
    }

    const elapsed = performance.now() - started;
    return {
      mode: dirtyOnly ? 'synthetic dirty-row patch' : 'synthetic full-frame repaint',
      frames: BENCH_FRAMES,
      cellsDrawn,
      elapsedMs: elapsed,
      avgFrameMs: average(timings),
      p95FrameMs: percentile(timings, 0.95),
      maxFrameMs: Math.max(...timings),
      cellsPerSecond: cellsDrawn / (elapsed / 1000),
    };
  }

  async function runGhosttyBridgeBenchmark(): Promise<RenderMetrics> {
    requireRenderer();
    const fetchStarted = performance.now();
    const payload = await invoke<GhosttyFrameSequencePayload>('ghostty_frame_sequence');
    const fetchElapsed = performance.now() - fetchStarted;
    const timings: number[] = [];
    let cellsDrawn = 0;
    resetTerminalScrollback();
    const renderStarted = performance.now();

    for (let frameIndex = 0; frameIndex < payload.frames.length; frameIndex += 1) {
      const frame = payload.frames[frameIndex];
      const frameStarted = performance.now();
      paintTerminalFrame(frame);
      const frameEnded = performance.now();
      timings.push(frameEnded - frameStarted);
      cellsDrawn += frame.rows.reduce((sum, row) => sum + row.cells.length, 0);

      if (frameIndex % 12 === 0) {
        await new Promise(requestAnimationFrame);
      }
    }

    const renderElapsed = performance.now() - renderStarted;
    return {
      mode: 'Ghostty frame bridge',
      frames: payload.frames.length,
      cellsDrawn,
      elapsedMs: renderElapsed,
      avgFrameMs: average(timings),
      p95FrameMs: percentile(timings, 0.95),
      maxFrameMs: Math.max(...timings),
      cellsPerSecond: cellsDrawn / (renderElapsed / 1000),
      bridgeMs: fetchElapsed,
      outputBytes: payload.output_bytes,
    };
  }

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
    const unlisteners: UnlistenFn[] = [];

    function cleanup() {
      for (const unlisten of unlisteners.splice(0)) {
        unlisten();
      }
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

      const frameStarted = performance.now();
      const previousView = sessionTerminalViewsRef.current[session.id];
      const nextView = buildSessionTerminalView(previousView, payload.frame);
      sessionTerminalViewsRef.current[session.id] = nextView;
      if (activeTerminalIdRef.current === terminalId) {
        applyTerminalView(nextView);
      }
      const frameEnded = performance.now();
      timings.push(frameEnded - frameStarted);
      cellsDrawn += payload.frame.rows.reduce((sum, row) => sum + row.cells.length, 0);
      framesReceived += 1;
    }));

    unlisteners.push(await listen<TerminalExitPayload>('terminal_exit', event => {
      const finished = event.payload;
      if (finished.terminalId !== terminalId) return;

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

  async function launchSelectedRuntimeSession() {
    if (!selectedSession) {
      writeLog('Select a Reverie shell session before launching.');
      return;
    }
    await launchRuntimeSession(selectedSession);
  }

  async function terminateActiveTerminal() {
    if (!activeTerminalId) return;

    setBusy(true);
    try {
      await invoke('terminate_session', { terminalId: activeTerminalId });
      writeLog(`Terminate requested for terminal ${shortId(activeTerminalId)}.`);
    } catch (error) {
      writeLog(`Terminate failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      setBusy(false);
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

  function terminalInputReady() {
    return Boolean(activeTerminalId && terminalInputArmed);
  }

  function handleTerminalKeyDown(event: KeyboardEvent<HTMLCanvasElement>) {
    const input = terminalInputForKey(event);
    if (!input || !terminalInputReady()) return;

    event.preventDefault();
    void sendTerminalInput(input);
  }

  function handleTerminalPaste(event: ClipboardEvent<HTMLCanvasElement>) {
    if (!terminalInputReady()) return;

    const text = event.clipboardData.getData('text');
    if (!text) return;

    event.preventDefault();
    void sendTerminalInput(text);
  }

  function focusTerminalCanvas(event?: MouseEvent<HTMLElement>) {
    event?.preventDefault();
    canvasRef.current?.focus();
  }

  function handleTerminalScroll(event: UIEvent<HTMLDivElement>) {
    paintVisibleTerminalWindow();

    if (autoScrollingTerminalRef.current || (!userTerminalScrollRef.current && liveFollowRef.current)) {
      liveFollowRef.current = true;
      setTerminalLiveFollow(true);
      return;
    }

    const viewport = event.currentTarget;
    const following = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - SCROLL_FOLLOW_EPSILON_PX;
    userTerminalScrollRef.current = false;
    liveFollowRef.current = following;
    setTerminalLiveFollow(following);
  }

  function handleTerminalWheel() {
    userTerminalScrollRef.current = true;
  }

  function followLiveTerminalOutput() {
    liveFollowRef.current = true;
    setTerminalLiveFollow(true);

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

  async function runSyntheticProof() {
    setSurfaceMode('terminal');
    setBusy(true);
    try {
      const full = await runSyntheticBenchmark({ dirtyOnly: false });
      const dirty = await runSyntheticBenchmark({ dirtyOnly: true });
      setMetrics([full, dirty]);
      writeLog(`Paint proof complete: avg=${full.avgFrameMs.toFixed(3)}ms p95=${full.p95FrameMs.toFixed(3)}ms.`);
    } finally {
      setBusy(false);
    }
  }

  async function runGhosttyBridgeProof() {
    setSurfaceMode('terminal');
    setBusy(true);
    try {
      const result = await runGhosttyBridgeBenchmark();
      setMetrics([result]);
      await recordMetrics(result);
      writeLog(`Ghostty bridge complete: frames=${result.frames} avg=${result.avgFrameMs.toFixed(3)}ms p95=${result.p95FrameMs.toFixed(3)}ms.`);
    } finally {
      setBusy(false);
    }
  }

  function activateSessionTerminal(session: ShellSession): boolean {
    const binding = sessionTerminalBindingsRef.current[session.id];
    setSelectedSessionId(session.id);
    setCreationMode(null);
    setSurfaceMode('terminal');

    if (!binding) {
      const view = sessionTerminalViewsRef.current[session.id];
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
    const view = sessionTerminalViewsRef.current[session.id];
    if (view) {
      applyTerminalView(view);
    } else {
      clearTerminalSurface();
    }
    requestAnimationFrame(() => canvasRef.current?.focus());
    return true;
  }

  function shouldAutoResumeSession(session: ShellSession) {
    return session.status === 'restorable' || session.status === 'restore_failed' || session.launchMode === 'resume' || Boolean(session.nativeSessionRef);
  }

  function selectSessionTab(session: ShellSession) {
    const attached = activateSessionTerminal(session);
    if (!attached && shouldAutoResumeSession(session)) {
      void launchRuntimeSession(session).catch(error => {
        writeLog(`Resume failed for ${session.title}: ${errorMessage(error)}`);
      });
    }
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

  async function setSessionTabVisibility(session: ShellSession, tabVisible: boolean) {
    const snapshot = await invoke<WorkspaceShellSnapshot>('update_session_tab_visibility', {
      request: { shellSessionId: session.id, tabVisible },
    });
    setShell(snapshot);
    return snapshot;
  }

  async function hideSessionTab(event: { stopPropagation: () => void }, session: ShellSession) {
    event.stopPropagation();
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
    writeLog(`Closed ${session.title} from active tabs; session record preserved for restore.`);
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
    <main className={appClass} data-theme={theme} data-testid="reverie-app-shell">
      <DotField variant="ambient" theme={theme} />

      <aside className={leftPanelClass} aria-label="Reverie navigation" data-testid="left-panel">
        <div className={titlebarClass} data-tauri-drag-region>
          <TrafficLights />
          <div className={brandClass} data-tauri-drag-region>
            <BrandMark />
            REVERIE
          </div>
        </div>

        <div className={searchClass} data-testid="focus-search">
          <MagnifyingGlass size={14} />
          <input placeholder="Search focuses, sessions…" aria-label="Search focuses and sessions" />
          <span>⌘K</span>
        </div>

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
          <button className={userButtonClass} type="button" data-testid="open-settings-button" onClick={() => setSurfaceMode('settings')}>
            <span className={avatarClass}>{workspaceInitial(shell.workspace.name)}</span>
            <span>
              <strong>{shell.workspace.name}</strong>
            </span>
            <GearSix size={16} />
          </button>
        </div>
      </aside>

      <section className={canvasStageClass} aria-label="Focus view" data-testid="focus-stage">
        {surfaceMode === 'dashboard' ? (
          <DashboardSurface
            shell={shell}
            theme={theme}
            sessionTerminalBindings={sessionTerminalBindings}
            onOpenSession={openSessionFromDashboard}
            onCreateProject={() => openCreation('project')}
            onCreateFocus={() => openCreation('focus')}
            cliDetections={agentCliDetections}
          />
        ) : surfaceMode === 'settings' ? (
          <SettingsSurface
            theme={theme}
            setTheme={setTheme}
            workspaceDefaultDangerousMode={shell.workspace.defaultDangerousMode}
            newSessionTitle={newSessionTitle}
            setNewSessionTitle={setNewSessionTitle}
            newSessionCwd={newSessionCwd}
            setNewSessionCwd={setNewSessionCwd}
            newSessionAgentKind={newSessionAgentKind}
            setNewSessionAgentKind={setNewSessionAgentKind}
            newSessionDangerousMode={newSessionDangerousMode}
            setNewSessionDangerousMode={setNewSessionDangerousMode}
            logs={logs}
            metrics={metrics}
            runSyntheticProof={runSyntheticProof}
            runGhosttyBridgeProof={runGhosttyBridgeProof}
            busy={busy}
            hasActiveTerminal={hasActiveTerminal}
            isTauriRuntime={isTauriRuntime}
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
                  <div className={autoApproveChipClass({ warn: effectiveDangerousMode })} data-testid="auto-approve-chip" title="Auto approval / YOLO state for the selected session">
                    <ShieldWarning size={14} />
                    {effectiveDangerousMode ? 'Auto-approve · session' : 'Auto-approve · off'}
                  </div>
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
                  <span>{selectedFocus?.title ?? 'Focus'} / {selectedSession.title}</span>
                  <span data-testid="terminal-status-label">{runningLabel}</span>
                  <span>{terminalSurface.cols}×{terminalSurface.rows}</span>
                  <span data-testid="scrollback-row-count">{scrollbackRowCount.toLocaleString()} / {scrollbackContract.maxRenderedHistoryRows.toLocaleString()} rows</span>
                  {!terminalLiveFollow ? (
                    <button type="button" data-testid="follow-live-button" onClick={followLiveTerminalOutput}>Follow live</button>
                  ) : <span data-testid="follow-live-state">Following live</span>}
                </div>
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
                      theme={theme}
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
              />
            )}
          </div>
        )}
      </section>

      <button className={themeToggleClass} type="button" data-testid="theme-toggle" aria-label="Toggle theme" onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')}>
        {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
      </button>
    </main>
  );
}

function TrafficLights() {
  return (
    <div className={lightsClass} aria-label="Window controls" data-testid="window-controls">
      <button
        type="button"
        aria-label="Close window"
        data-action="close"
        data-tauri-drag-region={false}
        onClick={() => void invokeWindowControl('close')}
      />
      <button
        type="button"
        aria-label="Minimize window"
        data-action="min"
        data-tauri-drag-region={false}
        onClick={() => void invokeWindowControl('minimize')}
      />
      <button
        type="button"
        aria-label="Maximize window"
        data-action="max"
        data-tauri-drag-region={false}
        onClick={() => void invokeWindowControl('toggleMaximize')}
      />
    </div>
  );
}

function SessionLaunchOverlay({
  session,
  theme,
  launching,
  disabled,
  onLaunch,
}: {
  session: ShellSession | null;
  theme: ThemeMode;
  launching: boolean;
  disabled: boolean;
  onLaunch: () => void;
}) {
  if (!session) return null;

  if (launching) {
    return (
      <div className={launchOverlayClass} data-testid="session-launch-overlay" data-state="launching">
        <div className={launchCardClass} data-state="launching">
          <div className={launchFieldClass}>
            <DotField variant="launching" theme={theme} />
          </div>
          <span className={launchingLabelClass} data-testid="session-launching-label">
            Launching {agentLabel(session.agentKind)}
          </span>
          <span className={launchCardMetaClass}>{session.cwd}</span>
        </div>
      </div>
    );
  }

  const label = launchButtonLabel(session);
  return (
    <div className={launchOverlayClass} data-testid="session-launch-overlay" data-state="idle">
      <div className={launchCardClass} data-state="idle">
        <span className={launchCardTitleClass}>{agentTabLabel(session)}</span>
        <span className={launchCardMetaClass}>
          {agentLabel(session.agentKind)} · {session.cwd}
        </span>
        <button
          type="button"
          className={primaryLaunchButtonClass}
          data-testid="session-launch-button"
          disabled={disabled}
          onClick={onLaunch}
        >
          <Play size={13} weight="fill" />
          {label}
        </button>
      </div>
    </div>
  );
}

function DotField({ variant = 'ambient', theme }: { variant?: DotFieldVariant; theme: ThemeMode }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handleRef = useRef<DotFieldHandle | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    handleRef.current = createDotField(canvasRef.current, { variant });
    return () => {
      handleRef.current?.destroy();
      handleRef.current = null;
    };
  }, [variant]);

  useEffect(() => {
    handleRef.current?.refresh();
  }, [theme]);

  return <canvas ref={canvasRef} className={dotFieldCanvasClass} aria-hidden="true" />;
}

function BrandMark() {
  return (
    <span className={brandMarkClass} aria-hidden="true">
      {[true, true, true, false, true, false, true, false, true, true, false, false, true, false, true, false].map((on, index) => (
        <i key={index} data-on={on ? 'true' : 'false'} />
      ))}
    </span>
  );
}

function ProjectGroup({ icon, title, count, active, onProjectClick, onRemoveProject, children }: {
  icon: ReactNode;
  title: string;
  count: number;
  active: boolean;
  onProjectClick: () => void;
  onRemoveProject?: (event: MouseEvent<HTMLElement>) => void;
  children: ReactNode;
}) {
  return (
    <div className={projectGroupClass}>
      <div className={navRowActionWrapClass}>
        <button className={projectRowClass({ active })} type="button" onClick={onProjectClick}>
          <span className={caretClass}><CaretRight size={11} weight="bold" /></span>
          {icon}
          <span className={rowLabelClass}>{title}</span>
          <span className={rowMetaClass}>{count || ''}</span>
        </button>
        {onRemoveProject ? (
          <button className={navRowActionClass} type="button" onClick={onRemoveProject} title={`Remove project ${title}`} data-testid="remove-project-button">
            <X size={11} />
          </button>
        ) : null}
      </div>
      <div className={childrenClass}>{children}</div>
    </div>
  );
}

function FocusRow({ focus, count, active, live, onClick, onHistory, onRemoveFocus }: {
  focus: ShellFocus;
  count: number;
  active: boolean;
  live: boolean;
  onClick: () => void;
  onHistory: (event: MouseEvent<HTMLElement>) => void;
  onRemoveFocus: (event: MouseEvent<HTMLElement>) => void;
}) {
  return (
    <div className={navRowActionWrapClass}>
      <button className={focusRowClass({ active })} type="button" onClick={onClick}>
        <span className={focusDotClass({ live })} />
        <span className={rowLabelClass}>{focus.title}</span>
        <span className={rowMetaClass}>{count || ''}</span>
      </button>
      <button className={navRowActionClass} type="button" onClick={onHistory} title={`View session history for ${focus.title}`} data-testid="focus-session-history-button">
        <TerminalWindow size={12} />
      </button>
      <button className={navRowActionClass} type="button" onClick={onRemoveFocus} title={`Remove focus ${focus.title}`} data-testid="remove-focus-button">
        <X size={11} />
      </button>
    </div>
  );
}

function SessionHistorySurface({ focus, sessions, visibleCount, hiddenCount, onRestore, onDelete, onCreateSession, busy }: {
  focus: ShellFocus | null;
  sessions: ShellSession[];
  visibleCount: number;
  hiddenCount: number;
  onRestore: (session: ShellSession) => void;
  onDelete: (session: ShellSession) => void;
  onCreateSession: () => void;
  busy: boolean;
}) {
  return (
    <div className={sessionHistorySurfaceClass} data-testid="session-history-surface">
      <div className={sessionHistoryHeaderClass}>
        <div>
          <p>Focus session history</p>
          <h2>{focus?.title ?? 'No focus selected'}</h2>
          <span>{sessions.length} total · {visibleCount} active tabs · {hiddenCount} closed tabs</span>
        </div>
        <button className={primaryComposerButtonClass} type="button" onClick={onCreateSession} disabled={busy || !focus}>
          <Plus size={14} /> New session
        </button>
      </div>

      <div className={sessionHistoryListClass}>
        {sessions.length === 0 ? (
          <div className={sessionHistoryEmptyClass} data-testid="session-history-empty">No sessions have been created under this focus yet.</div>
        ) : sessions.map(session => {
          const tabVisible = session.tabVisible !== false;
          return (
            <div className={sessionHistoryRowClass} key={session.id} data-testid="session-history-row" data-session-id={session.id} data-tab-visible={tabVisible ? 'true' : 'false'}>
              <div>
                <strong>{session.title}</strong>
                <span>{agentLabel(session.agentKind)} · {session.status.replace(/_/g, ' ')} · {shortId(session.id)}</span>
                <small>{session.cwd}</small>
              </div>
              <div className={sessionHistoryActionsClass}>
                {tabVisible ? <span className={activeTabPillClass}>Active tab</span> : (
                  <button className={secondaryComposerButtonClass} type="button" data-testid="restore-session-tab-button" onClick={() => onRestore(session)} disabled={busy}>
                    Restore tab
                  </button>
                )}
                <button className={dangerComposerButtonClass} type="button" data-testid="delete-session-button" onClick={() => onDelete(session)} disabled={busy}>
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgentGlyph({ kind }: { kind: string }) {
  return (
    <span className={agentGlyphClass({ kind })} aria-hidden="true">
      <span /><span /><span /><span />
    </span>
  );
}

function EmptyState({ cliDetections, createFocus, createProject, openSettings }: {
  cliDetections: AgentCliDetection[];
  createFocus: () => void;
  createProject: () => void;
  openSettings: () => void;
}) {
  const availableCliCount = cliDetections.filter(detection => detection.available).length;
  const onboardingGridClass = css({
    width: 'min(860px, calc(100vw - 380px))',
    display: 'grid',
    gridTemplateColumns: '1.15fr 0.85fr',
    gap: '18px',
    alignItems: 'stretch',
    lgDown: { width: 'min(720px, calc(100vw - 340px))', gridTemplateColumns: '1fr' },
  });
  const onboardingHeroClass = css({
    display: 'grid',
    justifyItems: 'start',
    alignContent: 'center',
    gap: '16px',
    padding: '28px',
    borderRadius: '28px',
    border: '1px solid var(--line)',
    background: 'linear-gradient(135deg, color-mix(in srgb, var(--surface-2) 72%, transparent), color-mix(in srgb, var(--surface-1) 88%, transparent))',
    boxShadow: 'var(--shadow)',
    '& p': { maxWidth: '520px', lineHeight: 1.7, textAlign: 'left' },
  });
  const onboardingKickerClass = css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    color: 'var(--text-3)',
    fontSize: '12px',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  });
  const onboardingStepsClass = css({
    display: 'grid',
    gap: '10px',
  });
  const onboardingStepClass = css({
    display: 'grid',
    gap: '4px',
    padding: '14px',
    borderRadius: '18px',
    border: '1px solid var(--line)',
    background: 'color-mix(in srgb, var(--surface-1) 78%, transparent)',
    textAlign: 'left',
    '& strong': { color: 'var(--text)', fontSize: '13px' },
    '& span': { color: 'var(--text-3)', fontSize: '12px', lineHeight: 1.55 },
  });
  const onboardingCliClass = css({
    gridColumn: '1 / -1',
    display: 'grid',
    gap: '8px',
    paddingTop: '2px',
    '& > span': { color: 'var(--text-3)', fontSize: '12px', textAlign: 'left' },
  });

  return (
    <div className={emptyStateClass} data-testid="onboarding-panel">
      <motion.div className={emptyCenterClass} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28 }}>
        <div className={onboardingGridClass}>
          <section className={onboardingHeroClass} data-testid="onboarding-hero">
            <span className={onboardingKickerClass}><TerminalWindow size={14} /> First run</span>
            <DotMatrixWord />
            <p>Start by giving Reverie one real working context. Create a project for folder-backed work, or keep it general when the agent session is not tied to a repo.</p>
            <div className={emptyActionsClass}>
              <button type="button" data-testid="empty-create-project-button" onClick={createProject}><Plus size={14} /> Create project</button>
              <button type="button" data-testid="empty-create-focus-button" onClick={createFocus}><Plus size={14} /> General focus</button>
              <button type="button" data-testid="empty-settings-button" onClick={openSettings}><GearSix size={14} /> Settings</button>
            </div>
          </section>

          <aside className={onboardingStepsClass} data-testid="onboarding-steps">
            <div className={onboardingStepClass}>
              <strong>1. Project</strong>
              <span>Optional folder-backed context for long-running work.</span>
            </div>
            <div className={onboardingStepClass}>
              <strong>2. Focus</strong>
              <span>The human-sized thread inside a project or General workspace.</span>
            </div>
            <div className={onboardingStepClass}>
              <strong>3. Session</strong>
              <span>Choose a detected CLI, set the cwd, then launch or resume.</span>
            </div>
            <div className={onboardingCliClass} data-testid="onboarding-cli-summary">
              <span>{availableCliCount} CLI choices available in this harness</span>
              <div className={cliChoiceGridClass}>
                {cliDetections.map(detection => (
                  <button
                    key={detection.kind}
                    type="button"
                    className={cliChoiceClass({ active: false, available: detection.available })}
                    data-testid="onboarding-cli-choice"
                    data-cli-kind={detection.kind}
                    data-available={detection.available ? 'true' : 'false'}
                    disabled
                  >
                    <AgentGlyph kind={detection.kind} />
                    <span>
                      <strong>{detection.displayName}</strong>
                      <small>{detection.available ? 'Fixture-detected' : `Missing: ${detection.candidates.join(', ')}`}</small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </motion.div>
    </div>
  );
}

type DashboardStatus = 'attention' | 'live' | 'recent';

function sessionBreadcrumb(session: ShellSession, shell: WorkspaceShellSnapshot): string {
  const focus = shell.focuses.find(f => f.id === session.focusId);
  if (!focus) return 'Workspace';
  if (!focus.projectId) return `General · ${focus.title}`;
  const project = shell.projects.find(p => p.id === focus.projectId);
  return project ? `${project.name} · ${focus.title}` : focus.title;
}

function plainLanguageStatus(session: ShellSession, isBound: boolean): string {
  if (session.status === 'restore_failed') return 'Needs your attention';
  if (session.status === 'running' || isBound) return 'Running';
  if (session.status === 'restorable' || session.nativeSessionRef) return 'Resumable';
  if (session.status === 'exited') return 'Ended';
  return 'Ready to launch';
}

function statusDotColor(status: DashboardStatus): string {
  if (status === 'attention') return 'var(--warn)';
  if (status === 'live') return 'var(--good)';
  return 'var(--text-4)';
}

function DashboardSurface({
  shell,
  theme,
  sessionTerminalBindings,
  onOpenSession,
  onCreateProject,
  onCreateFocus,
  cliDetections,
}: {
  shell: WorkspaceShellSnapshot;
  theme: ThemeMode;
  sessionTerminalBindings: Record<string, SessionTerminalBinding>;
  onOpenSession: (session: ShellSession) => void;
  onCreateProject: () => void;
  onCreateFocus: () => void;
  cliDetections: AgentCliDetection[];
}) {
  // Partition visible sessions across the three rails. The set is defined from
  // local product data so the dashboard ships before the activity-state pipeline
  // arrives. As that lands, `attention` will pick up awaiting_permission too
  // and `live` will reflect the richer working/awaiting_input split.
  const visible = shell.sessions.filter(s => s.tabVisible !== false);
  const attention = visible.filter(s => s.status === 'restore_failed');
  const live = visible.filter(
    s => s.status === 'running' || Boolean(sessionTerminalBindings[s.id]),
  );
  const liveIds = new Set(live.map(s => s.id));
  const attentionIds = new Set(attention.map(s => s.id));
  const recent = visible.filter(s => !liveIds.has(s.id) && !attentionIds.has(s.id));

  const totalVisible = visible.length;
  const isEmptyWorkspace = totalVisible === 0;

  if (isEmptyWorkspace) {
    return (
      <EmptyState
        cliDetections={cliDetections}
        createFocus={onCreateFocus}
        createProject={onCreateProject}
        openSettings={() => undefined}
      />
    );
  }

  return (
    <div className={dashboardSurfaceClass} data-testid="dashboard-surface">
      <DotField variant="ambient" theme={theme} />
      <motion.div
        className={dashboardContentClass}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      >
        <header className={dashboardHeaderClass}>
          <div>
            <p className={dashboardKickerClass}>Workspace</p>
            <h1 className={dashboardTitleClass}>{shell.workspace.name}</h1>
          </div>
          <div className={dashboardCountsClass}>
            <span data-tone={live.length > 0 ? 'live' : 'idle'} data-testid="dashboard-live-count">
              <i style={{ background: live.length > 0 ? 'var(--good)' : 'var(--text-4)' }} />
              {live.length} live
            </span>
            <span data-tone={attention.length > 0 ? 'attention' : 'idle'} data-testid="dashboard-attention-count">
              <i style={{ background: attention.length > 0 ? 'var(--warn)' : 'var(--text-4)' }} />
              {attention.length} need attention
            </span>
            <span data-tone="recent" data-testid="dashboard-recent-count">
              <i style={{ background: 'var(--text-4)' }} />
              {recent.length} recent
            </span>
          </div>
        </header>

        {attention.length > 0 ? (
          <DashboardRail
            title="Needs your attention"
            icon={<Warning size={13} weight="fill" />}
            tone="attention"
            sessions={attention}
            shell={shell}
            bindings={sessionTerminalBindings}
            onOpenSession={onOpenSession}
          />
        ) : null}

        {live.length > 0 ? (
          <DashboardRail
            title="Live now"
            tone="live"
            sessions={live}
            shell={shell}
            bindings={sessionTerminalBindings}
            onOpenSession={onOpenSession}
          />
        ) : null}

        {recent.length > 0 ? (
          <DashboardRail
            title="Recent"
            tone="recent"
            sessions={recent}
            shell={shell}
            bindings={sessionTerminalBindings}
            onOpenSession={onOpenSession}
          />
        ) : null}
      </motion.div>
    </div>
  );
}

function DashboardRail({
  title,
  icon,
  tone,
  sessions,
  shell,
  bindings,
  onOpenSession,
}: {
  title: string;
  icon?: ReactNode;
  tone: DashboardStatus;
  sessions: ShellSession[];
  shell: WorkspaceShellSnapshot;
  bindings: Record<string, SessionTerminalBinding>;
  onOpenSession: (session: ShellSession) => void;
}) {
  return (
    <section className={dashboardRailClass} data-tone={tone} data-testid={`dashboard-rail-${tone}`}>
      <header className={dashboardRailHeaderClass}>
        {icon ? <span data-testid={`dashboard-rail-icon-${tone}`}>{icon}</span> : null}
        <h2 style={tone === 'attention' ? { color: 'var(--warn)' } : undefined}>{title}</h2>
        <span className={dashboardRailCountClass}>{sessions.length}</span>
      </header>
      <div className={dashboardCardsClass}>
        {sessions.map(session => (
          <SessionDashboardCard
            key={session.id}
            session={session}
            shell={shell}
            isBound={Boolean(bindings[session.id])}
            tone={tone}
            onOpen={() => onOpenSession(session)}
          />
        ))}
      </div>
    </section>
  );
}

function SessionDashboardCard({
  session,
  shell,
  isBound,
  tone,
  onOpen,
}: {
  session: ShellSession;
  shell: WorkspaceShellSnapshot;
  isBound: boolean;
  tone: DashboardStatus;
  onOpen: () => void;
}) {
  const breadcrumb = sessionBreadcrumb(session, shell);
  const statusLabel = plainLanguageStatus(session, isBound);

  return (
    <button
      type="button"
      className={dashboardCardClass}
      data-tone={tone}
      data-testid="dashboard-session-card"
      data-session-id={session.id}
      onClick={onOpen}
    >
      <div className={dashboardCardTopClass}>
        <AgentGlyph kind={session.agentKind} />
        <span className={dashboardCardDotClass} style={{ background: statusDotColor(tone) }} aria-hidden="true" />
      </div>
      <div className={dashboardCardTitleClass}>{agentTabLabel(session)}</div>
      <div className={dashboardCardBreadcrumbClass}>{breadcrumb}</div>
      <div className={dashboardCardStatusClass}>{statusLabel}</div>
    </button>
  );
}

function CreationComposer({
  mode,
  selectedProject,
  selectedFocus,
  newProjectName,
  setNewProjectName,
  newProjectPath,
  setNewProjectPath,
  newFocusTitle,
  setNewFocusTitle,
  newSessionTitle,
  setNewSessionTitle,
  newSessionCwd,
  setNewSessionCwd,
  newSessionAgentKind,
  setNewSessionAgentKind,
  newSessionDangerousMode,
  setNewSessionDangerousMode,
  cliDetections,
  busy,
  onChooseProjectFolder,
  onCreateProject,
  onCreateFocus,
  onCreateSession,
  onCancel,
}: {
  mode: NonNullable<CreationMode>;
  selectedProject: ShellProject | null;
  selectedFocus: ShellFocus | null;
  newProjectName: string;
  setNewProjectName: (value: string) => void;
  newProjectPath: string;
  setNewProjectPath: (value: string) => void;
  newFocusTitle: string;
  setNewFocusTitle: (value: string) => void;
  newSessionTitle: string;
  setNewSessionTitle: (value: string) => void;
  newSessionCwd: string;
  setNewSessionCwd: (value: string) => void;
  newSessionAgentKind: AgentKind;
  setNewSessionAgentKind: (value: AgentKind) => void;
  newSessionDangerousMode: boolean;
  setNewSessionDangerousMode: (value: boolean) => void;
  cliDetections: AgentCliDetection[];
  busy: boolean;
  onChooseProjectFolder: () => void;
  onCreateProject: () => void;
  onCreateFocus: () => void;
  onCreateSession: () => void;
  onCancel: () => void;
}) {
  const selectedDetection = cliDetections.find(detection => detection.kind === newSessionAgentKind);
  const availableDetections = cliDetections.filter(detection => detection.available);
  const availableCliCount = availableDetections.length;
  const selectedExecutable = selectedDetection?.executable ?? selectedDetection?.candidates[0] ?? null;
  const selectedCliSummary = selectedDetection?.available
    ? `${selectedDetection.displayName} is ready${selectedExecutable ? ` at ${selectedExecutable}` : ''}.`
    : selectedDetection
      ? `${selectedDetection.displayName} is not available. Reverie will not create a session with a missing CLI.`
      : 'Pick one detected CLI before creating a session.';
  const canCreateSession = Boolean(
    selectedFocus
      && newSessionCwd.trim().length > 0
      && availableCliCount > 0
      && (selectedDetection?.available ?? false),
  );
  const sessionBlocker = !selectedFocus
    ? 'Choose or create a focus before creating a session.'
    : availableCliCount === 0
      ? 'No supported CLIs are currently detected. Install Cortex, Claude Code, or Codex CLI, then retry detection.'
      : !selectedDetection?.available
        ? `${selectedDetection?.displayName ?? 'Selected CLI'} is not available on this machine.`
        : newSessionCwd.trim().length === 0
          ? 'Working directory is required.'
          : null;

  return (
    <section className={creationComposerClass} data-testid="creation-composer" data-mode={mode}>
      <div className={creationHeaderClass}>
        <span>{mode === 'project' ? 'New project' : mode === 'focus' ? 'New focus' : 'New session'}</span>
        <button type="button" data-testid="close-creation-composer" onClick={onCancel}>Close</button>
      </div>

      {mode === 'project' ? (
        <div className={creationGridClass}>
          <div className={folderPickerCardClass} data-testid="project-folder-selection" data-selected={newProjectPath.trim().length > 0 ? 'true' : 'false'}>
            <Folder size={18} />
            <span>{newProjectPath.trim().length > 0 ? newProjectName || folderNameFromPath(newProjectPath) || 'Selected folder' : 'Choose a project folder'}</span>
            <small>{newProjectPath.trim().length > 0 ? newProjectPath : 'Reverie will name the project from the folder and use that folder as the session working directory.'}</small>
          </div>
          <button className={secondaryComposerButtonClass} type="button" data-testid="choose-project-folder-button" disabled={busy} onClick={onChooseProjectFolder}>{newProjectPath.trim().length > 0 ? 'Choose different folder' : 'Choose folder…'}</button>
          <p className={composerHintClass} data-testid="project-form-hint">Projects start from a local folder selection, not manual path entry. New sessions under the project inherit that cwd.</p>
          <button className={primaryComposerButtonClass} type="button" data-testid="submit-project-button" disabled={busy || newProjectPath.trim().length === 0} onClick={onCreateProject}>{busy ? 'Creating…' : 'Add project'}</button>
        </div>
      ) : null}

      {mode === 'focus' ? (
        <div className={creationGridClass}>
          <p className={creationContextClass}>Project: <strong>{selectedProject?.name ?? 'General workspace'}</strong></p>
          <label>Focus title<input data-testid="focus-title-input" value={newFocusTitle} placeholder="Terminal rendering" required onChange={event => setNewFocusTitle(event.currentTarget.value)} /></label>
          <p className={composerHintClass} data-testid="focus-form-hint">A focus is the durable thread sessions will attach to.</p>
          <button className={primaryComposerButtonClass} type="button" data-testid="submit-focus-button" disabled={busy || newFocusTitle.trim().length === 0} onClick={onCreateFocus}>{busy ? 'Creating…' : 'Create focus'}</button>
        </div>
      ) : null}

      {mode === 'session' ? (
        <div className={creationGridClass}>
          <p className={creationContextClass}>Focus: <strong>{selectedFocus?.title ?? 'Choose a focus first'}</strong></p>
          <label>Session title<input data-testid="session-title-input" value={newSessionTitle} placeholder={`${agentLabel(newSessionAgentKind)} session`} onChange={event => setNewSessionTitle(event.currentTarget.value)} /></label>
          <label>Working directory<input data-testid="session-cwd-input" value={newSessionCwd} required onChange={event => setNewSessionCwd(event.currentTarget.value)} /></label>
          <p className={composerHintClass} data-testid="session-form-hint">{sessionBlocker ?? `${selectedDetection?.displayName ?? 'Selected CLI'} will launch from this directory.`}</p>
          <div className={selectedCliSummaryClass({ available: selectedDetection?.available ?? false })} data-testid="selected-cli-summary">
            <span>Selected agent</span>
            <strong>{selectedDetection?.displayName ?? 'No CLI selected'}</strong>
            <small>{selectedCliSummary}</small>
          </div>
          <div className={cliChoiceHeaderClass}>
            <span>Choose agent CLI</span>
            <small data-testid="cli-availability-summary">{availableCliCount === 0 ? 'No supported CLIs detected' : `${availableCliCount} of ${cliDetections.length} detected`}</small>
          </div>
          <div className={cliChoiceGridClass} data-testid="cli-choice-list" aria-label="Detected CLI choices">
            {cliDetections.map(detection => {
              const active = detection.kind === newSessionAgentKind;
              const detectedText = detection.executable ?? detection.candidates[0] ?? 'Detected on PATH';
              return (
                <button
                  key={detection.kind}
                  type="button"
                  className={cliChoiceClass({ active, available: detection.available })}
                  data-testid="cli-choice"
                  data-cli-kind={detection.kind}
                  data-available={detection.available ? 'true' : 'false'}
                  data-selected={active ? 'true' : 'false'}
                  aria-pressed={active}
                  title={detection.available ? `${detection.displayName} detected at ${detectedText}` : `${detection.displayName} is not installed or not on PATH`}
                  disabled={!detection.available}
                  onClick={() => setNewSessionAgentKind(detection.kind)}
                >
                  <AgentGlyph kind={detection.kind} />
                  <span>
                    <strong>{detection.displayName}</strong>
                    <small>{detection.available ? detectedText : `Missing: ${detection.candidates.join(', ')}`}</small>
                  </span>
                  <em>{active ? 'Selected' : detection.available ? 'Ready' : 'Unavailable'}</em>
                </button>
              );
            })}
          </div>
          {availableCliCount === 0 ? (
            <p className={cliEmptyHelpClass} data-testid="cli-empty-help">Reverie can still organize projects and focuses, but sessions stay disabled until at least one supported agent CLI is installed and detected.</p>
          ) : null}
          <label className={checkRowClass}><input data-testid="session-dangerous-checkbox" type="checkbox" checked={newSessionDangerousMode} onChange={event => setNewSessionDangerousMode(event.currentTarget.checked)} /> Enable YOLO for this session</label>
          <button className={primaryComposerButtonClass} type="button" data-testid="submit-session-button" disabled={busy || !canCreateSession} onClick={onCreateSession}>{busy ? 'Creating…' : 'Create session'}</button>
        </div>
      ) : null}
    </section>
  );
}

function DotMatrixWord() {
  const letters = 'REVERIE'.split('');
  return (
    <div className={wordMarkClass} aria-hidden="true">
      {letters.map((letter, letterIndex) => (
        <span key={`${letter}-${letterIndex}`} className={wordLetterClass}>
          {Array.from({ length: 35 }).map((_, dotIndex) => (
            <i key={dotIndex} data-on={isWordDotOn(letter, dotIndex) ? 'true' : 'false'} />
          ))}
        </span>
      ))}
    </div>
  );
}

const canUseAppServices = true;

function SettingsSurface({
  theme,
  setTheme,
  workspaceDefaultDangerousMode,
  newSessionTitle,
  setNewSessionTitle,
  newSessionCwd,
  setNewSessionCwd,
  newSessionAgentKind,
  setNewSessionAgentKind,
  newSessionDangerousMode,
  setNewSessionDangerousMode,
  logs,
  metrics,
  runSyntheticProof,
  runGhosttyBridgeProof,
  busy,
  hasActiveTerminal,
  isTauriRuntime,
}: {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  workspaceDefaultDangerousMode: boolean;
  newSessionTitle: string;
  setNewSessionTitle: (value: string) => void;
  newSessionCwd: string;
  setNewSessionCwd: (value: string) => void;
  newSessionAgentKind: CreateSessionRecordRequest['agentKind'];
  setNewSessionAgentKind: (value: CreateSessionRecordRequest['agentKind']) => void;
  newSessionDangerousMode: boolean;
  setNewSessionDangerousMode: (value: boolean) => void;
  logs: string[];
  metrics: RenderMetrics[];
  runSyntheticProof: () => Promise<void>;
  runGhosttyBridgeProof: () => Promise<void>;
  busy: boolean;
  hasActiveTerminal: boolean;
  isTauriRuntime: boolean;
}) {
  return (
    <div className={settingsSurfaceClass}>
      <div className={settingsHeaderClass}>
        <span>Settings</span>
        <h1>Workspace preferences</h1>
        <p>Settings load into the main stage instead of a separate modal. This keeps Reverie’s floating surface model intact.</p>
      </div>

      <div className={settingsGridClass}>
        <section className={floatingCardClass}>
          <h2>Appearance</h2>
          <p>Warm neutral theme with the same rim-lit panel language in light and dark.</p>
          <div className={segmentedClass}>
            <button type="button" data-active={theme === 'dark'} onClick={() => setTheme('dark')}>Dark</button>
            <button type="button" data-active={theme === 'light'} onClick={() => setTheme('light')}>Light</button>
          </div>
        </section>

        <section className={floatingCardClass}>
          <h2>Session defaults</h2>
          <label>Title<input value={newSessionTitle} placeholder="New Cortex session" onChange={event => setNewSessionTitle(event.currentTarget.value)} /></label>
          <label>Agent<select value={newSessionAgentKind} onChange={event => setNewSessionAgentKind(event.currentTarget.value as CreateSessionRecordRequest['agentKind'])}>
            <option value="cortex_code">Cortex Code</option>
            <option value="codex_cli">Codex CLI</option>
            <option value="claude_code">Claude Code</option>
          </select></label>
          <label>Working directory<input value={newSessionCwd} onChange={event => setNewSessionCwd(event.currentTarget.value)} /></label>
          <label className={checkRowClass}><input type="checkbox" checked={newSessionDangerousMode} onChange={event => setNewSessionDangerousMode(event.currentTarget.checked)} /> Enable YOLO for new sessions</label>
          <p>Workspace default auto-approve: <strong>{workspaceDefaultDangerousMode ? 'on' : 'off'}</strong></p>
        </section>

        <section className={floatingCardClass}>
          <h2>Diagnostics</h2>
          <p>Kept here so the primary product surface no longer reads like a proof harness.</p>
          <div className={settingsActionsClass}>
            <button type="button" disabled={busy || hasActiveTerminal} onClick={() => runSyntheticProof().catch(() => {})}>Paint proof</button>
            <button type="button" disabled={busy || hasActiveTerminal || !canUseAppServices} onClick={() => runGhosttyBridgeProof().catch(() => {})}>Ghostty proof</button>
          </div>
          <pre className="proof-log">{logs.slice(0, 12).join('\n')}</pre>
        </section>

        <section className={floatingCardClass}>
          <h2>Last metrics</h2>
          {metrics.length === 0 ? <p>No metrics captured in this view yet.</p> : metrics.map(metric => (
            <dl className={metricListClass} key={metric.mode}>
              <Metric label="Mode" value={metric.mode} />
              <Metric label="Frames" value={metric.frames} />
              <Metric label="P95 paint" value={`${metric.p95FrameMs.toFixed(3)} ms`} />
              <Metric label="Dropped" value={metric.droppedFrames} />
              <Metric label="Terminal" value={shortId(metric.terminalId)} />
            </dl>
          ))}
        </section>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: MetricValue }) {
  if (value === undefined || value === null) return null;

  return (
    <div className={metricRowClass}>
      <dt>{label}</dt>
      <dd>{String(value)}</dd>
    </div>
  );
}

// Initial React state before the backend snapshot loads. Intentionally empty so the first paint
// matches the Tauri build's first-launch state; the real snapshot replaces this once `workspace_shell`
// resolves. If the backend fails to load, the user sees an empty workspace rather than fake content.
function fallbackShellSnapshot(): WorkspaceShellSnapshot {
  return {
    workspace: {
      id: 'fallback-workspace',
      name: 'Local workspace',
      generalLabel: 'General',
      defaultDangerousMode: false,
    },
    projects: [],
    focuses: [],
    sessions: [],
  };
}

function sessionsForProject(projectId: string | null, shell: WorkspaceShellSnapshot) {
  const focusIds = new Set(shell.focuses.filter(focus => focus.projectId === projectId).map(focus => focus.id));
  return shell.sessions.filter(session => focusIds.has(session.focusId));
}

function average(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function workspaceInitial(value: string) {
  return (value.trim()[0] ?? 'R').toUpperCase();
}

function shortId(value: string | undefined | null) {
  return value ? value.slice(0, 8) : undefined;
}

function folderNameFromPath(path: string | undefined | null) {
  if (!path) return '';
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

function agentLabel(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
}

function fallbackAgentCliDetections(): AgentCliDetection[] {
  return [
    {
      kind: 'cortex_code',
      displayName: 'Cortex Code',
      executable: 'cortex',
      candidates: ['cortex'],
      available: true,
    },
    {
      kind: 'claude_code',
      displayName: 'Claude Code',
      executable: 'claude',
      candidates: ['claude'],
      available: true,
    },
    {
      kind: 'codex_cli',
      displayName: 'Codex CLI',
      executable: 'codex',
      candidates: ['codex'],
      available: true,
    },
  ];
}

function agentTabLabel(session: ShellSession) {
  // Tab identity is the user's session title; the agent kind travels in the
  // AgentGlyph next to the label so parallel sessions of the same CLI are
  // distinguishable at a glance.
  const title = session.title.trim();
  if (title.length > 0) return title;
  const kind = session.agentKind;
  if (kind === 'claude_code') return 'Claude Code';
  if (kind === 'codex_cli') return 'Codex';
  if (kind === 'cortex_code') return 'Cortex';
  return 'Session';
}

function nativeSessionSummary(session: ShellSession | null) {
  const native = session?.nativeSessionRef;
  const nativeId = native?.sessionId;
  if (!nativeId) return null;

  return `${agentLabel(native.kind)} ${shortId(nativeId)}`;
}

function launchButtonLabel(session: ShellSession) {
  if (session.status === 'restore_failed') return 'Retry resume';
  if (session.launchMode === 'resume' || session.nativeSessionRef) return 'Resume';
  return 'Run';
}

function dangerousLabel(session: ShellSession | null, workspaceDefault: boolean) {
  const effective = session?.dangerousModeOverride ?? workspaceDefault;
  return effective ? 'Explicitly enabled' : 'Off';
}

function terminalInputForKey(event: KeyboardEvent<HTMLCanvasElement>) {
  if (event.metaKey) return null;

  if (event.ctrlKey) {
    const key = event.key.toLowerCase();
    if (key === 'c') return '\x03';
    if (key === 'd') return '\x04';
    if (key === 'l') return '\x0c';
    if (key === 'u') return '\x15';
    if (key === 'w') return '\x17';
    return null;
  }

  if (event.altKey && event.key.length === 1) {
    return `\x1b${event.key}`;
  }

  switch (event.key) {
    case 'Enter':
      return '\r';
    case 'Backspace':
      return '\x7f';
    case 'Tab':
      return '\t';
    case 'Escape':
      return '\x1b';
    case 'ArrowUp':
      return '\x1b[A';
    case 'ArrowDown':
      return '\x1b[B';
    case 'ArrowRight':
      return '\x1b[C';
    case 'ArrowLeft':
      return '\x1b[D';
    case 'Delete':
      return '\x1b[3~';
    case 'Home':
      return '\x1b[H';
    case 'End':
      return '\x1b[F';
    default:
      return event.key.length === 1 ? event.key : null;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isWordDotOn(letter: string, dotIndex: number) {
  const patterns: Record<string, string[]> = {
    R: ['11110', '10010', '11110', '10100', '10010', '10010', '10001'],
    E: ['11111', '10000', '11110', '10000', '10000', '10000', '11111'],
    V: ['10001', '10001', '10001', '01010', '01010', '00100', '00100'],
    I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  };
  const row = Math.floor(dotIndex / 5);
  const col = dotIndex % 5;
  return patterns[letter]?.[row]?.[col] === '1';
}

const appClass = css({
  '--bg': '#0B0A09',
  '--bg-deep': '#060605',
  '--surface-1': '#131210',
  '--surface-2': '#1A1816',
  '--surface-3': '#221F1C',
  '--surface-hi': '#2A2622',
  '--line-faint': 'rgba(245, 235, 220, 0.05)',
  '--line': 'rgba(245, 235, 220, 0.09)',
  '--line-strong': 'rgba(245, 235, 220, 0.16)',
  '--text': '#EFE9DF',
  '--text-2': '#B7AEA1',
  '--text-3': '#7B7268',
  '--text-4': '#4F4842',
  '--dot-bg': 'rgba(239, 233, 223, 0.08)',
  '--dot-ambient': 'rgba(239, 233, 223, 0.55)',
  '--dot-bright': 'rgba(239, 233, 223, 0.95)',
  '--rim-1': 'rgba(255, 250, 240, 0.55)',
  '--rim-2': 'rgba(255, 250, 240, 0.04)',
  '--good': '#6FB87A',
  '--warn': '#E5A24E',
  '--bad': '#D96B5C',
  '--terminal-bg': '#060605',
  '--shadow': '0 30px 60px -20px rgba(0,0,0,0.55), 0 12px 32px -12px rgba(0,0,0,0.6)',
  position: 'fixed',
  inset: 0,
  display: 'grid',
  gridTemplateColumns: '288px minmax(0, 1fr)',
  gap: '18px',
  padding: '22px',
  overflow: 'hidden',
  color: 'var(--text)',
  background: 'radial-gradient(circle at 18% 10%, var(--surface-2), transparent 30%), linear-gradient(135deg, var(--bg), var(--bg-deep))',
  fontSize: '13px',
  lineHeight: '1.45',
  letterSpacing: '-0.005em',
  transition: 'background 0.45s ease, color 0.45s ease',
  '&[data-theme="light"]': {
    '--bg': '#F4F1EB',
    '--bg-deep': '#ECE7DD',
    '--surface-1': '#FAF7F0',
    '--surface-2': '#F1ECE2',
    '--surface-3': '#E8E2D5',
    '--surface-hi': '#DDD6C7',
    '--line-faint': 'rgba(40, 28, 14, 0.05)',
    '--line': 'rgba(40, 28, 14, 0.09)',
    '--line-strong': 'rgba(40, 28, 14, 0.18)',
    '--text': '#1B1814',
    '--text-2': '#524A40',
    '--text-3': '#877E72',
    '--text-4': '#ADA395',
    '--dot-bg': 'rgba(40, 28, 14, 0.08)',
    '--dot-ambient': 'rgba(40, 28, 14, 0.50)',
    '--dot-bright': 'rgba(20, 14, 6, 0.90)',
    '--rim-1': 'rgba(255, 255, 255, 0.95)',
    '--rim-2': 'rgba(255, 255, 255, 0.15)',
    '--good': '#4A8F58',
    '--warn': '#B07A1E',
    '--bad': '#B14738',
    '--terminal-bg': '#11100e',
    '--shadow': '0 30px 60px -22px rgba(60, 40, 20, 0.18), 0 12px 28px -14px rgba(60, 40, 20, 0.18)',
  },
  lgDown: {
    gridTemplateColumns: '260px minmax(0, 1fr)',
    padding: '14px',
  },
  mdDown: {
    position: 'relative',
    minHeight: '100vh',
    gridTemplateColumns: '1fr',
    overflow: 'auto',
  },
});

const dotFieldCanvasClass = css({
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
  zIndex: 0,
  display: 'block',
});

const rimLitPanel = {
  position: 'relative',
  background: 'var(--surface-1)',
  borderRadius: '22px',
  boxShadow: 'var(--shadow)',
  overflow: 'hidden',
  isolation: 'isolate',
  '&::before': {
    content: '""',
    position: 'absolute',
    inset: 0,
    borderRadius: 'inherit',
    padding: '1.2px',
    background: 'conic-gradient(from 180deg at 25% 18%, var(--rim-2) 0deg, var(--rim-2) 40deg, var(--rim-1) 130deg, var(--rim-1) 175deg, var(--rim-2) 240deg, var(--rim-2) 360deg)',
    WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
    WebkitMaskComposite: 'xor',
    maskComposite: 'exclude',
    pointerEvents: 'none',
    zIndex: 3,
  },
  '&::after': {
    content: '""',
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '220px',
    background: 'radial-gradient(circle at 20% 10%, rgba(255, 250, 240, 0.08), transparent 60%)',
    pointerEvents: 'none',
    zIndex: 1,
  },
} as const;

const leftPanelClass = css({
  ...rimLitPanel,
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

const lightsClass = css({
  display: 'flex',
  gap: '8px',
  alignItems: 'center',
  '& button': {
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    border: '0.5px solid rgba(0,0,0,0.18)',
    padding: 0,
    margin: 0,
    cursor: 'pointer',
    background: 'var(--surface-hi)',
    transition: 'background 140ms ease, transform 140ms ease',
  },
  '& button:hover': { transform: 'scale(1.05)' },
  '&:hover button[data-action="close"]': { background: '#ED6A5E' },
  '&:hover button[data-action="min"]':   { background: '#F4BF4F' },
  '&:hover button[data-action="max"]':   { background: '#61C554' },
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

const brandMarkClass = css({
  width: '18px',
  height: '18px',
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  gridTemplateRows: 'repeat(4, 1fr)',
  gap: '1.5px',
  '& i': {
    background: 'var(--dot-ambient)',
    borderRadius: '0.5px',
    opacity: 0.35,
  },
  '& i[data-on="true"]': {
    opacity: 1,
    background: 'var(--text)',
  },
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
  '& input': {
    flex: 1,
    minWidth: 0,
    background: 'transparent',
    border: 0,
    outline: 'none',
    color: 'var(--text)',
    font: 'inherit',
  },
  '& span': {
    fontSize: '10.5px',
    color: 'var(--text-3)',
    padding: '1px 5px',
    border: '1px solid var(--line)',
    borderRadius: '4px',
    background: 'var(--surface-1)',
  },
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

const projectGroupClass = css({
  display: 'grid',
  gap: '2px',
});

function projectRowClass({ active }: { active: boolean }) {
  return css({
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    padding: '6px 10px',
    borderRadius: '8px',
    color: active ? 'var(--text)' : 'var(--text-2)',
    background: active ? 'var(--surface-3)' : 'transparent',
    cursor: 'pointer',
    userSelect: 'none',
    textAlign: 'left',
    position: 'relative',
    _hover: { background: 'var(--surface-2)', color: 'var(--text)' },
    '& svg': { color: active ? 'var(--text)' : 'var(--text-3)', flexShrink: 0 },
  });
}

const caretClass = css({
  width: '14px',
  display: 'grid',
  placeItems: 'center',
  color: 'var(--text-3)',
  transform: 'rotate(90deg)',
});

const childrenClass = css({
  paddingLeft: '18px',
  display: 'grid',
  gap: '1px',
});

const navRowActionWrapClass = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto auto',
  alignItems: 'center',
  gap: '2px',
  width: '100%',
  '&:not(:hover) [data-testid="remove-project-button"], &:not(:hover) [data-testid="remove-focus-button"]': { opacity: 0 },
});

const navRowActionClass = css({
  width: '24px',
  height: '24px',
  border: '0',
  borderRadius: '7px',
  display: 'grid',
  placeItems: 'center',
  color: 'var(--text-3)',
  background: 'transparent',
  cursor: 'pointer',
  _hover: { color: 'var(--text)', background: 'var(--surface-2)' },
});

function focusRowClass({ active }: { active: boolean }) {
  return css({
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    padding: '5px 10px',
    borderRadius: '8px',
    color: active ? 'var(--text)' : 'var(--text-2)',
    background: active ? 'var(--surface-3)' : 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    position: 'relative',
    _hover: { background: 'var(--surface-2)', color: 'var(--text)' },
    '&::before': active ? {
      content: '""',
      position: 'absolute',
      left: '-8px',
      top: '50%',
      transform: 'translateY(-50%)',
      width: '3px',
      height: '16px',
      background: 'var(--text)',
      borderRadius: '2px',
    } : {},
  });
}

const rowLabelClass = css({
  flex: 1,
  minWidth: 0,
  fontSize: '13px',
  fontWeight: 450,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const rowMetaClass = css({
  fontSize: '11px',
  color: 'var(--text-4)',
  fontVariantNumeric: 'tabular-nums',
});

function focusDotClass({ live }: { live: boolean }) {
  return css({
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: live ? 'var(--good)' : 'var(--dot-ambient)',
    boxShadow: live ? '0 0 0 3px rgba(111,184,122,0.12)' : 'none',
    flexShrink: 0,
  });
}

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
  borderTop: '1px solid var(--line)',
  padding: '10px 12px 12px',
  position: 'relative',
  zIndex: 2,
  background: 'linear-gradient(to top, var(--surface-1), transparent)',
});

const userButtonClass = css({
  width: '100%',
  display: 'grid',
  gridTemplateColumns: '24px minmax(0, 1fr) 18px',
  alignItems: 'center',
  gap: '10px',
  padding: '6px',
  borderRadius: '8px',
  cursor: 'pointer',
  textAlign: 'left',
  _hover: { background: 'var(--surface-2)' },
  '& strong': { display: 'block', fontSize: '12.5px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  '& small': { display: 'block', fontSize: '11.5px', color: 'var(--text-3)' },
});

const avatarClass = css({
  width: '24px',
  height: '24px',
  borderRadius: '7px',
  background: 'var(--surface-3)',
  display: 'grid',
  placeItems: 'center',
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--text)',
  border: '1px solid var(--line)',
});

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

function agentGlyphClass({ kind }: { kind: string }) {
  const color = kind === 'claude_code' ? '#D97757' : kind === 'codex_cli' ? '#8FA5FF' : 'var(--good)';
  return css({
    width: '14px',
    height: '14px',
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gridTemplateRows: 'repeat(2, 1fr)',
    gap: '1.5px',
    flexShrink: 0,
    color,
    '& span': {
      borderRadius: '1px',
      background: 'currentColor',
      opacity: 0.45,
    },
    '& span:nth-child(1)': { opacity: kind === 'codex_cli' ? 0.45 : 1 },
    '& span:nth-child(2)': { opacity: kind === 'claude_code' ? 0.45 : 1 },
    '& span:nth-child(3)': { opacity: kind === 'claude_code' ? 0.45 : 1 },
    '& span:nth-child(4)': { opacity: kind === 'cortex_code' ? 0.45 : 1 },
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
  gridTemplateRows: 'auto minmax(0, 1fr)',
  overflow: 'hidden',
  borderRadius: '0 0 22px 22px',
  background: 'var(--terminal-bg)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.025)',
});

const launchOverlayClass = css({
  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  pointerEvents: 'none',
  zIndex: 5,
  '& > *': { pointerEvents: 'auto' },
});

const launchCardClass = css({
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '14px',
  padding: '28px 32px 26px',
  borderRadius: '20px',
  background: 'color-mix(in srgb, var(--surface-1) 84%, transparent)',
  border: '1px solid var(--line)',
  boxShadow: '0 24px 70px -28px rgba(0,0,0,0.55)',
  minWidth: '320px',
  maxWidth: '420px',
  textAlign: 'center',
  backdropFilter: 'blur(10px)',
});

const launchCardTitleClass = css({
  fontSize: '14px',
  fontWeight: 500,
  color: 'var(--text)',
  letterSpacing: '-0.005em',
});

const launchCardMetaClass = css({
  fontSize: '11px',
  color: 'var(--text-3)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  wordBreak: 'break-all',
  lineHeight: 1.5,
});

const primaryLaunchButtonClass = css({
  marginTop: '6px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  padding: '9px 18px',
  borderRadius: '999px',
  background: 'var(--text)',
  color: 'var(--bg)',
  border: 0,
  cursor: 'pointer',
  fontWeight: 500,
  fontSize: '12.5px',
  letterSpacing: '0.01em',
  transition: 'transform 140ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms ease',
  '&:hover': { transform: 'translateY(-1px)' },
  '&:active': { transform: 'translateY(0)' },
  '&:disabled': { opacity: 0.5, cursor: 'not-allowed', transform: 'none' },
  '& svg': { color: 'var(--bg)' },
});

const launchFieldClass = css({
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  opacity: 0.85,
});

const launchingLabelClass = css({
  position: 'relative',
  zIndex: 1,
  fontSize: '11.5px',
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-2)',
});

const terminalMetaStripClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '7px 14px',
  borderBottom: '1px solid rgba(255,255,255,0.045)',
  color: 'var(--text-3)',
  fontSize: '11px',
  whiteSpace: 'nowrap',
  overflowX: 'auto',
  '& span:first-child': { color: 'var(--text-2)' },
  '& button': {
    color: 'var(--text)',
    border: '1px solid var(--line)',
    borderRadius: '999px',
    padding: '2px 7px',
    cursor: 'pointer',
  },
});

const surfaceViewportClass = css({
  position: 'relative',
  minHeight: 0,
  height: '100%',
  overflow: 'auto',
  background: 'var(--terminal-bg)',
});

const terminalScrollSpacerClass = css({
  position: 'relative',
  minHeight: '100%',
});

const dashboardSurfaceClass = css({
  ...rimLitPanel,
  position: 'relative',
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
});

const dashboardContentClass = css({
  position: 'relative',
  zIndex: 2,
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '28px 32px 40px',
  display: 'flex',
  flexDirection: 'column',
  gap: '28px',
  '&::-webkit-scrollbar': { width: '10px' },
  '&::-webkit-scrollbar-thumb': {
    background: 'var(--line)',
    borderRadius: '8px',
    border: '2px solid transparent',
    backgroundClip: 'padding-box',
  },
});

const dashboardHeaderClass = css({
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: '16px',
  flexWrap: 'wrap',
});

const dashboardKickerClass = css({
  margin: 0,
  fontSize: '10.5px',
  fontWeight: 500,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
});

const dashboardTitleClass = css({
  margin: '4px 0 0',
  fontSize: '22px',
  fontWeight: 500,
  letterSpacing: '-0.012em',
  color: 'var(--text)',
});

const dashboardCountsClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  flexWrap: 'wrap',
  '& span': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '7px',
    padding: '5px 11px',
    fontSize: '11.5px',
    fontWeight: 500,
    color: 'var(--text-2)',
    background: 'color-mix(in srgb, var(--surface-1) 70%, transparent)',
    border: '1px solid var(--line)',
    borderRadius: '999px',
    fontVariantNumeric: 'tabular-nums',
  },
  '& span i': {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    display: 'inline-block',
  },
});

const dashboardRailClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
});

const dashboardRailHeaderClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  color: 'var(--text-3)',
  '& > span': {
    display: 'inline-flex',
    color: 'var(--warn)',
  },
  '& h2': {
    margin: 0,
    fontSize: '11px',
    fontWeight: 500,
    letterSpacing: '0.10em',
    textTransform: 'uppercase',
    color: 'var(--text-3)',
  },
});

const dashboardRailCountClass = css({
  fontSize: '11px',
  color: 'var(--text-4)',
  fontVariantNumeric: 'tabular-nums',
});

const dashboardCardsClass = css({
  display: 'grid',
  gap: '12px',
  gridTemplateColumns: 'repeat(auto-fill, minmax(228px, 1fr))',
});

const dashboardCardClass = css({
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '8px',
  padding: '14px 14px 13px',
  borderRadius: '14px',
  border: '1px solid var(--line)',
  background: 'color-mix(in srgb, var(--surface-1) 78%, transparent)',
  color: 'var(--text-2)',
  textAlign: 'left',
  cursor: 'pointer',
  overflow: 'hidden',
  transition: 'border-color 140ms ease, transform 140ms cubic-bezier(0.22, 1, 0.36, 1), background 140ms ease',
  _hover: {
    borderColor: 'var(--line-strong)',
    transform: 'translateY(-1px)',
    background: 'color-mix(in srgb, var(--surface-2) 78%, transparent)',
    color: 'var(--text)',
  },
  '&[data-tone="attention"]': {
    borderColor: 'color-mix(in srgb, var(--warn) 35%, var(--line) 65%)',
  },
});

const dashboardCardTopClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  color: 'var(--text-3)',
});

const dashboardCardDotClass = css({
  display: 'inline-block',
  width: '8px',
  height: '8px',
  borderRadius: '50%',
});

const dashboardCardTitleClass = css({
  fontSize: '14px',
  fontWeight: 500,
  color: 'var(--text)',
  letterSpacing: '-0.005em',
  width: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const dashboardCardBreadcrumbClass = css({
  fontSize: '11px',
  color: 'var(--text-3)',
  width: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const dashboardCardStatusClass = css({
  fontSize: '10.5px',
  fontWeight: 500,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
});

const emptyStateClass = css({
  position: 'relative',
  minHeight: 0,
  height: '100%',
  display: 'grid',
  placeItems: 'center',
  overflow: 'hidden',
  background: 'radial-gradient(circle at 50% 42%, color-mix(in srgb, var(--dot-ambient) 18%, transparent), transparent 42%), var(--bg)',
  '&::before': {
    content: '""',
    position: 'absolute',
    inset: 0,
    backgroundImage: 'radial-gradient(var(--dot-bg) 1px, transparent 1px)',
    backgroundSize: '18px 18px',
    opacity: 0.8,
  },
});

const emptyCenterClass = css({
  position: 'relative',
  zIndex: 1,
  display: 'grid',
  justifyItems: 'center',
  gap: '18px',
  color: 'var(--text-2)',
  '& p': { margin: 0 },
});

const wordMarkClass = css({
  display: 'flex',
  gap: '10px',
});

const wordLetterClass = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(5, 9px)',
  gridTemplateRows: 'repeat(7, 9px)',
  gap: '4px',
  '& i': {
    width: '9px',
    height: '9px',
    borderRadius: '2px',
    background: 'var(--dot-bg)',
  },
  '& i[data-on="true"]': {
    background: 'var(--dot-bright)',
    boxShadow: '0 0 18px color-mix(in srgb, var(--dot-bright) 24%, transparent)',
  },
});

const emptyActionsClass = css({
  display: 'flex',
  gap: '10px',
  '& button': {
    height: '34px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '7px',
    padding: '0 12px',
    borderRadius: '999px',
    border: '1px solid var(--line)',
    color: 'var(--text-2)',
    background: 'var(--surface-1)',
    boxShadow: 'var(--shadow)',
    cursor: 'pointer',
    _hover: { color: 'var(--text)', background: 'var(--surface-2)' },
  },
});

const creationComposerClass = css({
  margin: '0',
  padding: '24px 26px',
  minHeight: '100%',
  alignContent: 'start',
  background: 'transparent',
  display: 'grid',
  gap: '16px',
});

const creationHeaderClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  color: 'var(--text)',
  '& span': { fontSize: '12px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-3)' },
  '& button': {
    border: '1px solid var(--line)',
    borderRadius: '999px',
    padding: '5px 9px',
    color: 'var(--text-2)',
    background: 'var(--surface-1)',
    cursor: 'pointer',
  },
});

const creationGridClass = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '10px',
  alignItems: 'end',
  '& label': {
    display: 'grid',
    gap: '6px',
    color: 'var(--text-3)',
    fontSize: '12px',
  },
  '& input': {
    height: '34px',
    border: '1px solid var(--line)',
    borderRadius: '10px',
    padding: '0 10px',
    background: 'var(--surface-1)',
    color: 'var(--text)',
    outline: 'none',
  },
  mdDown: { gridTemplateColumns: '1fr' },
});

const creationContextClass = css({
  margin: 0,
  color: 'var(--text-3)',
  fontSize: '12px',
  alignSelf: 'center',
  '& strong': { color: 'var(--text-2)', fontWeight: 500 },
});

const composerHintClass = css({
  margin: 0,
  color: 'var(--text-3)',
  fontSize: '11.5px',
  lineHeight: 1.45,
  alignSelf: 'center',
});

const sessionHistorySurfaceClass = css({
  minHeight: '100%',
  padding: '44px',
  color: 'var(--text)',
  background: 'radial-gradient(circle at 70% 14%, rgba(134,167,255,0.10), transparent 38%)',
});

const sessionHistoryHeaderClass = css({
  display: 'flex',
  justifyContent: 'space-between',
  gap: '24px',
  alignItems: 'flex-start',
  marginBottom: '22px',
  '& p': { margin: 0, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.14em', fontSize: '11px', fontWeight: 700 },
  '& h2': { margin: '6px 0', fontSize: '30px', letterSpacing: '-0.04em' },
  '& span': { color: 'var(--text-3)', fontSize: '12px' },
});

const sessionHistoryListClass = css({
  display: 'grid',
  gap: '10px',
});

const sessionHistoryRowClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '18px',
  padding: '14px 16px',
  border: '1px solid var(--line)',
  borderRadius: '18px',
  background: 'color-mix(in srgb, var(--surface-2) 72%, transparent)',
  boxShadow: '0 18px 50px rgba(0,0,0,0.16)',
  '& strong': { display: 'block', fontSize: '14px' },
  '& span': { display: 'block', marginTop: '4px', color: 'var(--text-3)', fontSize: '12px' },
  '& small': { display: 'block', marginTop: '3px', color: 'var(--text-3)', fontSize: '11px', maxWidth: '540px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

const sessionHistoryActionsClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
});

const sessionHistoryEmptyClass = css({
  padding: '18px',
  border: '1px dashed var(--line)',
  borderRadius: '18px',
  color: 'var(--text-3)',
});

const activeTabPillClass = css({
  height: '28px',
  padding: '0 10px',
  border: '1px solid var(--line)',
  borderRadius: '999px',
  display: 'inline-flex !important',
  alignItems: 'center',
  color: 'var(--text-2) !important',
  fontSize: '11px !important',
});

const dangerComposerButtonClass = css({
  height: '34px',
  border: '1px solid color-mix(in srgb, var(--bad, #ff7a7a) 45%, var(--line))',
  borderRadius: '999px',
  color: 'var(--text)',
  background: 'rgba(255, 95, 95, 0.09)',
  cursor: 'pointer',
  fontWeight: 650,
  padding: '0 14px',
  _hover: { borderColor: 'rgba(255, 120, 120, 0.65)' },
  _disabled: { opacity: 0.45, cursor: 'not-allowed' },
});

const primaryComposerButtonClass = css({
  height: '34px',
  border: '1px solid var(--line-strong)',
  borderRadius: '999px',
  color: 'var(--bg)',
  background: 'var(--text)',
  cursor: 'pointer',
  fontWeight: 650,
  _disabled: { opacity: 0.45, cursor: 'not-allowed' },
});

const secondaryComposerButtonClass = css({
  height: '34px',
  border: '1px solid var(--line)',
  borderRadius: '999px',
  color: 'var(--text)',
  background: 'color-mix(in srgb, var(--surface-2) 72%, transparent)',
  cursor: 'pointer',
  fontWeight: 600,
  _hover: { borderColor: 'var(--line-strong)' },
  _disabled: { opacity: 0.45, cursor: 'not-allowed' },
});

const folderPickerCardClass = css({
  gridColumn: '1 / -1',
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '3px 10px',
  alignItems: 'center',
  minHeight: '76px',
  padding: '13px 14px',
  borderRadius: '16px',
  border: '1px dashed var(--line-strong)',
  background: 'rgba(0,0,0,0.18)',
  color: 'var(--text)',
  '& svg': { color: 'var(--text-3)', gridRow: '1 / span 2' },
  '& span': { fontSize: '14px', fontWeight: 650 },
  '& small': { color: 'var(--text-3)', fontSize: '11.5px', lineHeight: 1.45, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

function selectedCliSummaryClass({ available }: { available: boolean }) {
  return css({
    gridColumn: '1 / -1',
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: '3px 10px',
    alignItems: 'center',
    padding: '10px 12px',
    borderRadius: '14px',
    border: `1px solid ${available ? 'color-mix(in srgb, var(--line-strong) 82%, var(--accent))' : 'var(--line)'}`,
    background: available
      ? 'linear-gradient(135deg, color-mix(in srgb, var(--surface-hi) 78%, transparent), color-mix(in srgb, var(--accent) 8%, transparent))'
      : 'var(--surface-1)',
    '& span': { color: 'var(--text-3)', fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase' },
    '& strong': { color: 'var(--text)', fontSize: '13px' },
    '& small': { gridColumn: '1 / -1', color: available ? 'var(--text-2)' : 'var(--text-4)', fontSize: '11.5px', lineHeight: 1.45 },
  });
}

const cliChoiceHeaderClass = css({
  gridColumn: '1 / -1',
  display: 'flex',
  justifyContent: 'space-between',
  gap: '12px',
  alignItems: 'center',
  color: 'var(--text-3)',
  fontSize: '11px',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  '& small': { letterSpacing: '0', textTransform: 'none', color: 'var(--text-4)' },
});

const cliChoiceGridClass = css({
  gridColumn: '1 / -1',
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: '8px',
  lgDown: { gridTemplateColumns: '1fr' },
});

function cliChoiceClass({ active, available }: { active: boolean; available: boolean }) {
  return css({
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: '9px',
    minHeight: '54px',
    borderRadius: '14px',
    border: `1px solid ${active ? 'color-mix(in srgb, var(--line-strong) 82%, var(--accent))' : 'var(--line)'}`,
    background: active ? 'var(--surface-hi)' : 'var(--surface-1)',
    color: available ? 'var(--text)' : 'var(--text-4)',
    cursor: available ? 'pointer' : 'not-allowed',
    textAlign: 'left',
    padding: '9px 10px',
    opacity: available ? 1 : 0.56,
    boxShadow: active ? 'inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent)' : 'none',
    '& span:nth-child(2)': { display: 'grid', gap: '2px', minWidth: 0 },
    '& strong': { fontSize: '12px', fontWeight: 650 },
    '& small': { color: 'var(--text-3)', fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    '& em': {
      justifySelf: 'end',
      borderRadius: '999px',
      padding: '3px 7px',
      color: active ? 'var(--bg)' : 'var(--text-3)',
      background: active ? 'var(--text)' : 'var(--surface-2)',
      fontSize: '9.5px',
      fontStyle: 'normal',
      fontWeight: 700,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
    },
  });
}

const cliEmptyHelpClass = css({
  gridColumn: '1 / -1',
  margin: 0,
  padding: '10px 12px',
  borderRadius: '14px',
  border: '1px solid var(--line)',
  background: 'var(--surface-1)',
  color: 'var(--text-3)',
  fontSize: '11.5px',
  lineHeight: 1.5,
});

const settingsSurfaceClass = css({
  ...rimLitPanel,
  height: '100%',
  zIndex: 2,
  padding: '26px',
  overflow: 'auto',
  display: 'grid',
  gridTemplateRows: 'auto minmax(0, 1fr)',
  gap: '22px',
});

const settingsHeaderClass = css({
  position: 'relative',
  zIndex: 2,
  maxWidth: '760px',
  '& span': { display: 'block', color: 'var(--text-3)', fontSize: '12px', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '8px' },
  '& h1': { margin: '0 0 8px', fontSize: '28px', letterSpacing: '-0.04em' },
  '& p': { margin: 0, color: 'var(--text-2)', lineHeight: 1.55 },
});

const settingsGridClass = css({
  position: 'relative',
  zIndex: 2,
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '14px',
  lgDown: { gridTemplateColumns: '1fr' },
});

const floatingCardClass = css({
  border: '1px solid var(--line)',
  borderRadius: '16px',
  background: 'linear-gradient(135deg, color-mix(in srgb, var(--surface-2) 78%, transparent), color-mix(in srgb, var(--surface-1) 92%, transparent))',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
  padding: '16px',
  display: 'grid',
  gap: '12px',
  '& h2': { margin: 0, fontSize: '15px' },
  '& p': { margin: 0, color: 'var(--text-2)', lineHeight: 1.5 },
  '& label': { display: 'grid', gap: '6px', color: 'var(--text-3)', fontSize: '11px', letterSpacing: '0.04em', textTransform: 'uppercase' },
  '& input, & select': {
    width: '100%',
    border: '1px solid var(--line)',
    borderRadius: '10px',
    background: 'var(--surface-1)',
    color: 'var(--text)',
    padding: '8px 10px',
    font: 'inherit',
    outline: 'none',
  },
});

const segmentedClass = css({
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '6px',
  padding: '4px',
  borderRadius: '12px',
  border: '1px solid var(--line)',
  background: 'var(--surface-1)',
  '& button': {
    borderRadius: '9px',
    padding: '8px 10px',
    color: 'var(--text-3)',
    cursor: 'pointer',
  },
  '& button[data-active="true"]': {
    color: 'var(--text)',
    background: 'var(--surface-3)',
  },
});

const checkRowClass = css({
  display: 'flex! important',
  alignItems: 'center',
  gap: '8px',
  textTransform: 'none! important',
  letterSpacing: '0! important',
  color: 'var(--text-2)! important',
  '& input': { width: 'auto! important' },
});

const settingsActionsClass = css({
  display: 'flex',
  gap: '8px',
  flexWrap: 'wrap',
  '& button': {
    border: '1px solid var(--line)',
    borderRadius: '999px',
    padding: '8px 10px',
    color: 'var(--text)',
    background: 'var(--surface-2)',
    cursor: 'pointer',
    _disabled: { opacity: 0.45, cursor: 'not-allowed' },
  },
});

const metricListClass = css({
  display: 'grid',
  gap: '8px',
  margin: 0,
});

const metricRowClass = css({
  display: 'flex',
  justifyContent: 'space-between',
  gap: '16px',
  fontSize: '13px',
  '& dt': { color: 'var(--text-3)' },
  '& dd': { margin: 0, fontVariantNumeric: 'tabular-nums', textAlign: 'right' },
});

const themeToggleClass = css({
  position: 'fixed',
  right: '22px',
  bottom: '22px',
  zIndex: 5,
  width: '42px',
  height: '42px',
  display: 'grid',
  placeItems: 'center',
  borderRadius: '999px',
  border: '1px solid var(--line)',
  background: 'var(--surface-1)',
  color: 'var(--text-2)',
  boxShadow: 'var(--shadow)',
  cursor: 'pointer',
  _hover: { color: 'var(--text)', background: 'var(--surface-2)' },
});
