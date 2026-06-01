import { makeSyntheticFrame } from '../terminal-canvas-renderer';
import type { TerminalFrame } from '../terminalTypes';
import type {
  AgentCliDetection,
  AgentKind,
  RenderMetrics,
  WorkspaceShellSnapshot,
} from '../domain';
import type { EventHandler, UnlistenFn } from './types';

// The most recent frame per terminal. The history fixtures serve it as the whole
// replayed transcript, so the harness can exercise full-history scroll without a
// real replay engine.
const lastFixtureFrames = new Map<string, TerminalFrame>();

// Browser fixture backend: an in-memory, localStorage-persisted stand-in for
// the Tauri commands + events, used by `npm run dev:harness` so the React shell
// can run in a plain browser with no Rust process. The runtime shim
// (services/runtime.ts) routes here whenever the real Tauri APIs are absent.
//
// Fixture state mirrors the real domain model (WorkspaceShellSnapshot,
// ShellSession, ...) so there is a single source of truth for the shapes.

const browserListeners = new Map<string, Set<EventHandler<unknown>>>();
const runningTerminals = new Map<
  string,
  {
    sessionId: string;
    cancelled: boolean;
    frontendActive: boolean;
    startedAt: number;
    framesEmitted: number;
  }
>();
const fixtureStorageKey = makeFixtureStorageKey();
// Test-only record of terminal input writes, surfaced on the window hook so the
// harness can assert "send to input" / "ask an agent" seeded the right text.
const recordedTerminalInputs: Array<{ terminalId: string; input: string }> = [];
const frontendActivityEvents: Array<{ terminalId: string; active: boolean }> = [];
const recordedRenderMetrics: RenderMetrics[] = [];
let fixtureShell: WorkspaceShellSnapshot = loadFixtureShellSnapshot();
// CLIs the user has switched off in the harness. Drives the same enabled/
// disabled behavior as the real workspace pref so the settings toggle and the
// downstream gating can be exercised without a Rust backend.
const fixtureDisabledClis = new Set<AgentKind>();

export async function invokeBrowserFixture<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  switch (command) {
    case 'workspace_shell':
      return clone(fixtureShell) as T;
    case 'system_home_dir':
      return '/Users/user' as T;
    case 'choose_project_folder':
      return { name: 'reverie', path: '/Users/user/Code/reverie' } as T;
    case 'resolve_project_folder':
      return resolveFixtureProjectFolder(args) as T;
    case 'create_project':
      return createFixtureProject(args) as T;
    case 'create_focus':
      return createFixtureFocus(args) as T;
    case 'create_session':
      return createFixtureSession(args) as T;
    case 'update_session_tab_visibility':
      return updateFixtureSessionTabVisibility(args) as T;
    case 'set_session_archived':
      return updateFixtureSessionArchived(args) as T;
    case 'remove_session':
      return removeFixtureSession(args) as T;
    case 'archive_focus':
      return archiveFixtureFocus(args) as T;
    case 'archive_project':
      return archiveFixtureProject(args) as T;
    case 'reorder_focuses':
      return reorderFixtureFocuses(args) as T;
    case 'reorder_projects':
      return reorderFixtureProjects(args) as T;
    case 'reorder_sessions':
      return reorderFixtureSessions(args) as T;
    case 'move_session':
      return moveFixtureSession(args) as T;
    case 'list_agent_clis':
      return listFixtureAgentClis() as T;
    case 'set_agent_cli_enabled':
      return setFixtureAgentCliEnabled(args) as T;
    case 'ghostty_frame_sequence':
      return makeFixtureFrameSequence() as T;
    case 'start_session':
      return startFixtureSession(args) as T;
    case 'terminate_session':
      return terminateFixtureSession(args) as T;
    case 'write_terminal_input': {
      const terminalId = readDirectArg<string>(args, 'terminalId');
      const input = (args?.input as string) ?? '';
      recordedTerminalInputs.push({ terminalId, input });
      return undefined as T;
    }
    case 'resize_terminal':
      return undefined as T;
    case 'scroll_terminal_viewport':
      return undefined as T;
    case 'scroll_terminal_viewport_to_top':
      return undefined as T;
    case 'scroll_terminal_viewport_to_bottom':
      return undefined as T;
    case 'set_terminal_frontend_active': {
      const terminalId = readDirectArg<string>(args, 'terminalId');
      const active = readDirectArg<boolean>(args, 'active');
      frontendActivityEvents.push({ terminalId, active });
      const terminal = runningTerminals.get(terminalId);
      if (terminal) terminal.frontendActive = active;
      return undefined as T;
    }
    case 'set_terminal_theme':
      // No backend terminal in the browser harness; the Canvas renderer applies
      // theme colors directly via the controller, so this is a no-op here.
      return undefined as T;
    case 'record_render_metrics':
      recordedRenderMetrics.push(clone(args?.metrics as RenderMetrics));
      return undefined as T;
    case 'record_terminal_diagnostics':
      return undefined as T;
    case 'set_workspace_nav_state':
      // The desktop backend persists the last view so a reload/relaunch reopens
      // it. The browser harness deliberately does not, so a harness reload always
      // lands on the seeded default view (which the smoke test asserts). Nav
      // restore is verified in the real app, not here.
      return undefined as T;
    case 'open_url': {
      // In the browser harness there is no system opener; open a new tab so a
      // human can see the link resolve. The desktop build routes this to the
      // opener plugin instead.
      const url = readDirectArg<string>(args, 'url');
      if (url && typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
      return undefined as T;
    }
    default:
      throw new Error(`Browser fixture does not implement Tauri command: ${command}`);
  }
}

export function subscribeFixtureEvent<T>(eventName: string, handler: EventHandler<T>): UnlistenFn {
  const handlers = browserListeners.get(eventName) ?? new Set<EventHandler<unknown>>();
  handlers.add(handler as EventHandler<unknown>);
  browserListeners.set(eventName, handlers);
  return () => handlers.delete(handler as EventHandler<unknown>);
}

// The harness has no filesystem to stat, so it treats any dropped path as a
// valid folder and derives the name from the last path segment, mirroring the
// real `resolve_project_folder` command's happy path.
function resolveFixtureProjectFolder(args?: Record<string, unknown>) {
  const path = readDirectArg<string>(args, 'path').trim();
  const name =
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() ?? 'New project';
  return { name, path };
}

function createFixtureProject(args?: Record<string, unknown>) {
  const request = readRequest<{ name: string; path: string }>(args);
  const project = {
    id: makeId('project'),
    name: request.name.trim() || 'Untitled project',
    path: request.path.trim() || '/Users/user',
    archived: false,
  };

  fixtureShell = {
    ...fixtureShell,
    projects: [...fixtureShell.projects, project],
  };
  persistFixtureShellSnapshot();

  return clone(fixtureShell);
}

function createFixtureFocus(args?: Record<string, unknown>) {
  const request = readRequest<{
    projectId: string | null;
    title: string;
    description?: string | null;
    defaultDangerousMode?: boolean | null;
  }>(args);
  const projectFocuses = fixtureShell.focuses.filter(
    focus => focus.projectId === request.projectId,
  );
  const focus = {
    id: makeId('focus'),
    projectId: request.projectId,
    title: request.title,
    description: request.description ?? null,
    sortOrder: projectFocuses.length * 10,
    archived: false,
    defaultDangerousMode: request.defaultDangerousMode ?? null,
  };

  fixtureShell = {
    ...fixtureShell,
    focuses: [...fixtureShell.focuses, focus],
  };
  persistFixtureShellSnapshot();

  return clone(fixtureShell);
}

function createFixtureSession(args?: Record<string, unknown>) {
  const request = readRequest<{
    focusId: string;
    title: string;
    agentKind: AgentKind;
    cwd: string;
    dangerousModeOverride?: boolean | null;
  }>(args);
  const session = {
    id: makeId('session'),
    focusId: request.focusId,
    title: request.title,
    agentKind: request.agentKind,
    cwd: request.cwd,
    nativeSessionRef: null,
    launchMode: 'new' as const,
    // Null means "inherit" (topic default, then workspace default); only an
    // explicit boolean is a per-session override.
    dangerousModeOverride: request.dangerousModeOverride ?? null,
    status: 'not_started' as const,
    lastExitCode: null,
    tabVisible: true,
    archived: false,
  };

  fixtureShell = {
    ...fixtureShell,
    sessions: [...fixtureShell.sessions, session],
  };
  persistFixtureShellSnapshot();

  return clone(fixtureShell);
}

function updateFixtureSessionTabVisibility(args?: Record<string, unknown>) {
  const request = readRequest<{ shellSessionId: string; tabVisible: boolean }>(args);
  const session = fixtureShell.sessions.find(item => item.id === request.shellSessionId);
  if (!session) throw new Error(`Unknown fixture session: ${request.shellSessionId}`);
  session.tabVisible = request.tabVisible;
  persistFixtureShellSnapshot();
  return clone(fixtureShell);
}

function updateFixtureSessionArchived(args?: Record<string, unknown>) {
  const request = readRequest<{ shellSessionId: string; archived: boolean }>(args);
  const session = fixtureShell.sessions.find(item => item.id === request.shellSessionId);
  if (!session) throw new Error(`Unknown fixture session: ${request.shellSessionId}`);
  session.archived = request.archived;
  session.tabVisible = !request.archived;
  persistFixtureShellSnapshot();
  return clone(fixtureShell);
}

function removeFixtureSession(args?: Record<string, unknown>) {
  const sessionId = readDirectArg<string>(args, 'sessionId');
  const before = fixtureShell.sessions.length;
  fixtureShell = {
    ...fixtureShell,
    sessions: fixtureShell.sessions.filter(session => session.id !== sessionId),
  };
  if (fixtureShell.sessions.length === before)
    throw new Error(`Unknown fixture session: ${sessionId}`);
  persistFixtureShellSnapshot();
  return clone(fixtureShell);
}

function archiveFixtureFocus(args?: Record<string, unknown>) {
  const focusId = readDirectArg<string>(args, 'focusId');
  const focus = fixtureShell.focuses.find(item => item.id === focusId);
  if (!focus) throw new Error(`Unknown fixture focus: ${focusId}`);
  focus.archived = true;
  for (const session of fixtureShell.sessions.filter(item => item.focusId === focusId)) {
    session.tabVisible = false;
  }
  persistFixtureShellSnapshot();
  return clone(fixtureShell);
}

function reorderFixtureFocuses(args?: Record<string, unknown>) {
  const orderedIds = readDirectArg<string[]>(args, 'orderedFocusIds');
  orderedIds.forEach((id, index) => {
    const focus = fixtureShell.focuses.find(item => item.id === id);
    if (focus) focus.sortOrder = index * 10;
  });
  persistFixtureShellSnapshot();
  return clone(fixtureShell);
}

function reorderFixtureProjects(args?: Record<string, unknown>) {
  const orderedIds = readDirectArg<string[]>(args, 'orderedProjectIds');
  orderedIds.forEach((id, index) => {
    const project = fixtureShell.projects.find(item => item.id === id);
    if (project) project.sortOrder = index * 10;
  });
  persistFixtureShellSnapshot();
  return clone(fixtureShell);
}

function reorderFixtureSessions(args?: Record<string, unknown>) {
  const orderedIds = readDirectArg<string[]>(args, 'orderedSessionIds');
  orderedIds.forEach((id, index) => {
    const session = fixtureShell.sessions.find(item => item.id === id);
    if (session) session.sortOrder = index * 10;
  });
  persistFixtureShellSnapshot();
  return clone(fixtureShell);
}

function moveFixtureSession(args?: Record<string, unknown>) {
  const sessionId = readDirectArg<string>(args, 'sessionId');
  const targetFocusId = readDirectArg<string>(args, 'targetFocusId');
  const targetIndex = readDirectArg<number>(args, 'targetIndex');
  const moved = fixtureShell.sessions.find(item => item.id === sessionId);
  if (!moved) throw new Error(`Unknown fixture session: ${sessionId}`);
  moved.focusId = targetFocusId;
  // Rebuild the destination order with the moved session spliced in.
  const order = fixtureShell.sessions
    .filter(item => item.focusId === targetFocusId && !item.archived && item.id !== sessionId)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map(item => item.id);
  order.splice(Math.min(targetIndex, order.length), 0, sessionId);
  order.forEach((id, position) => {
    const session = fixtureShell.sessions.find(item => item.id === id);
    if (session) session.sortOrder = position * 10;
  });
  persistFixtureShellSnapshot();
  return clone(fixtureShell);
}

function archiveFixtureProject(args?: Record<string, unknown>) {
  const projectId = readDirectArg<string>(args, 'projectId');
  const project = fixtureShell.projects.find(item => item.id === projectId);
  if (!project) throw new Error(`Unknown fixture project: ${projectId}`);
  project.archived = true;
  const focusIds = new Set(
    fixtureShell.focuses.filter(focus => focus.projectId === projectId).map(focus => focus.id),
  );
  for (const focus of fixtureShell.focuses.filter(item => focusIds.has(item.id))) {
    focus.archived = true;
  }
  for (const session of fixtureShell.sessions.filter(item => focusIds.has(item.focusId))) {
    session.tabVisible = false;
  }
  persistFixtureShellSnapshot();
  return clone(fixtureShell);
}

function listFixtureAgentClis(): AgentCliDetection[] {
  const cliFixture = new URLSearchParams(window.location.search).get('cli');
  const unavailable = new Set<AgentKind>();
  if (cliFixture === 'partial') unavailable.add('codex_cli');
  if (cliFixture === 'none') {
    unavailable.add('cortex_code');
    unavailable.add('claude_code');
    unavailable.add('codex_cli');
  }

  return [
    makeFixtureAgentCli({
      kind: 'cortex_code',
      displayName: 'Cortex Code',
      executable: '/usr/local/bin/cortex',
      candidates: ['cortex'],
      unavailable,
    }),
    makeFixtureAgentCli({
      kind: 'claude_code',
      displayName: 'Claude Code',
      executable: '/usr/local/bin/claude',
      candidates: ['claude'],
      unavailable,
    }),
    makeFixtureAgentCli({
      kind: 'codex_cli',
      displayName: 'Codex CLI',
      executable: '/usr/local/bin/codex',
      candidates: ['codex'],
      unavailable,
    }),
  ];
}

function makeFixtureAgentCli({
  kind,
  displayName,
  executable,
  candidates,
  unavailable,
}: {
  kind: AgentKind;
  displayName: string;
  executable: string;
  candidates: string[];
  unavailable: Set<AgentKind>;
}): AgentCliDetection {
  const available = !unavailable.has(kind);
  return {
    kind,
    displayName,
    executable: available ? executable : null,
    candidates,
    available,
    enabled: !fixtureDisabledClis.has(kind),
  };
}

function setFixtureAgentCliEnabled(args?: Record<string, unknown>): AgentCliDetection[] {
  const request = readRequest<{ kind: AgentKind; enabled: boolean }>(args);
  if (request.enabled) {
    fixtureDisabledClis.delete(request.kind);
  } else {
    fixtureDisabledClis.add(request.kind);
  }
  return listFixtureAgentClis();
}

function startFixtureSession(args?: Record<string, unknown>) {
  const request = readRequest<{
    sessionId: string;
    terminalId: string;
    cols: number;
    rows: number;
  }>(args);
  const session = fixtureShell.sessions.find(item => item.id === request.sessionId);
  if (!session) throw new Error(`Unknown fixture session: ${request.sessionId}`);

  session.status = 'running';
  persistFixtureShellSnapshot();
  const terminal = {
    sessionId: request.sessionId,
    cancelled: false,
    frontendActive: true,
    startedAt: performance.now(),
    framesEmitted: 0,
  };
  runningTerminals.set(request.terminalId, terminal);

  window.setTimeout(() => {
    emit('terminal_stream_started', {
      terminalId: request.terminalId,
      targetFrames: 48,
      cols: request.cols,
      rows: request.rows,
    });
    emitFixtureFrames(request.terminalId, request.cols, request.rows);
  }, 0);

  return request.terminalId;
}

function terminateFixtureSession(args?: Record<string, unknown>) {
  const terminalId = String(args?.terminalId ?? '');
  const terminal = runningTerminals.get(terminalId);
  if (!terminal) return undefined;

  terminal.cancelled = true;
  finishFixtureTerminal(terminalId, false);
  return undefined;
}

function emitFixtureFrames(terminalId: string, cols: number, rows: number) {
  const terminal = runningTerminals.get(terminalId);
  if (!terminal || terminal.cancelled) return;

  const seq = terminal.framesEmitted;
  const frame = makeSyntheticFrame(seq, { cols, rows, dirtyOnly: false });
  terminal.framesEmitted += 1;
  lastFixtureFrames.set(terminalId, frame);
  emit('terminal_frame', {
    terminalId,
    seq,
    bytesRead: (seq + 1) * cols * rows,
    chunkBytes: cols * rows,
    rustElapsedMs: performance.now() - terminal.startedAt,
    frame,
  });

  if (terminal.framesEmitted >= 240) {
    finishFixtureTerminal(terminalId, true);
    return;
  }

  window.setTimeout(
    () => emitFixtureFrames(terminalId, cols, rows),
    terminal.frontendActive ? 16 : 100,
  );
}

function finishFixtureTerminal(terminalId: string, childSuccess: boolean) {
  const terminal = runningTerminals.get(terminalId);
  if (!terminal) return;

  runningTerminals.delete(terminalId);
  const session = fixtureShell.sessions.find(item => item.id === terminal.sessionId);
  if (session) {
    session.status = childSuccess ? 'restorable' : 'exited';
    session.lastExitCode = childSuccess ? 0 : 1;
    persistFixtureShellSnapshot();
  }

  const elapsed = performance.now() - terminal.startedAt;
  emit('terminal_exit', {
    terminalId,
    framesEmitted: terminal.framesEmitted,
    chunksRead: terminal.framesEmitted,
    bytesRead: terminal.framesEmitted * 120 * 36,
    rustElapsedMs: elapsed,
    totalEmitMs: elapsed,
    avgEmitMs: terminal.framesEmitted === 0 ? 0 : elapsed / terminal.framesEmitted,
    maxEmitMs: 16,
    childSuccess,
  });
}

function makeFixtureFrameSequence() {
  const frames: TerminalFrame[] = Array.from({ length: 72 }, (_, index) =>
    makeSyntheticFrame(index, {
      cols: 120,
      rows: 36,
      dirtyOnly: false,
    }),
  );

  return {
    frames,
    output_bytes: frames.length * 120 * 36,
  };
}

function emit<T>(eventName: string, payload: T) {
  const handlers = browserListeners.get(eventName);
  if (!handlers) return;

  for (const handler of [...handlers]) {
    handler({ payload });
  }
}

// Build a deterministic frame from plain text lines (one cell per character).
// Used by the test hook below so the harness + manual checks can drive known
// content (e.g. a URL) instead of the random synthetic stream.
function frameFromLines(lines: string[], cols: number, rows: number): TerminalFrame {
  const rowModels = Array.from({ length: rows }, (_, index) => {
    const text = lines[index] ?? '';
    const cells = [];
    for (let col = 0; col < Math.min(cols, text.length); col += 1) {
      cells.push({ col, text: text[col] });
    }
    return { index, dirty: true, cells };
  });
  return {
    dirty: 'full',
    rows: rowModels,
    cursor: { visible: false, row: 0, col: 0, position: { row: 0, col: 0 } },
    scrollback: {
      totalRows: rows,
      scrollbackRows: 0,
      viewportOffset: 0,
      viewportRows: rows,
      atBottom: true,
    },
  };
}

// Test-only hook (browser fixture builds): lets the harness + manual checks push
// a known terminal frame to the active terminal so selection/link assertions are
// deterministic. No-op outside a browser.
if (typeof window !== 'undefined') {
  (window as unknown as { __REVERIE_FIXTURE__?: unknown }).__REVERIE_FIXTURE__ = {
    // Freeze the synthetic stream without ending the session, so an injected
    // frame is not overwritten and the frame listener stays attached.
    stopStream(terminalId: string) {
      const terminal = runningTerminals.get(terminalId);
      if (terminal) terminal.cancelled = true;
    },
    emitTerminalFrame(terminalId: string, lines: string[], cols = 120, rows = 36) {
      const frame = frameFromLines(lines, cols, rows);
      lastFixtureFrames.set(terminalId, frame);
      emit('terminal_frame', {
        terminalId,
        seq: 9999,
        bytesRead: 0,
        chunkBytes: 0,
        rustElapsedMs: 0,
        frame,
      });
    },
    emitRawTerminalFrame(terminalId: string, frame: TerminalFrame, seq = 9999) {
      lastFixtureFrames.set(terminalId, frame);
      emit('terminal_frame', {
        terminalId,
        seq,
        bytesRead: 0,
        chunkBytes: frame.rows.reduce((sum, row) => sum + row.cells.length, 0),
        rustElapsedMs: 0,
        frame,
      });
    },
    finishTerminal(terminalId: string, childSuccess = true) {
      finishFixtureTerminal(terminalId, childSuccess);
    },
    frontendActivityEvents() {
      return frontendActivityEvents.slice();
    },
    recordedInputs() {
      return recordedTerminalInputs.slice();
    },
    recordedRenderMetrics() {
      return recordedRenderMetrics.slice();
    },
  };
}

function readRequest<T>(args?: Record<string, unknown>) {
  const request = args?.request;
  if (!request || typeof request !== 'object') {
    throw new Error('Missing command request payload');
  }

  return request as T;
}

function readDirectArg<T>(args: Record<string, unknown> | undefined, key: string): T {
  const value = args?.[key];
  if (value === undefined || value === null) {
    throw new Error(`Missing command argument: ${key}`);
  }
  return value as T;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeFixtureStorageKey() {
  const params = new URLSearchParams(window.location.search);
  const fixtureName = params.get('fixture') ?? 'default';
  const cliName = params.get('cli') ?? 'all';
  return `reverie.browserFixture.${fixtureName}.${cliName}.v1`;
}

function loadFixtureShellSnapshot(): WorkspaceShellSnapshot {
  if (new URLSearchParams(window.location.search).get('resetFixture') === '1') {
    window.localStorage.removeItem(fixtureStorageKey);
  }

  const stored = window.localStorage.getItem(fixtureStorageKey);
  if (stored) {
    try {
      const snapshot = JSON.parse(stored) as WorkspaceShellSnapshot;
      normalizeFixtureShellSnapshot(snapshot);
      persistFixtureShellSnapshot(snapshot);
      return snapshot;
    } catch {
      window.localStorage.removeItem(fixtureStorageKey);
    }
  }

  const snapshot = makeFixtureShellSnapshot();
  persistFixtureShellSnapshot(snapshot);
  return snapshot;
}

function persistFixtureShellSnapshot(snapshot = fixtureShell) {
  window.localStorage.setItem(fixtureStorageKey, JSON.stringify(snapshot));
}

function normalizeFixtureShellSnapshot(snapshot: WorkspaceShellSnapshot) {
  for (const session of snapshot.sessions) {
    session.tabVisible ??= true;
    session.archived ??= false;
  }
  // Mirror the backend `ensure_seeded`: a workspace always has a General focus so
  // sessions can be spun up without a project.
  if (!snapshot.focuses.some(focus => !focus.projectId && !focus.archived)) {
    snapshot.focuses.unshift({
      id: 'focus-general',
      projectId: null,
      title: snapshot.workspace.generalLabel,
      description: null,
      sortOrder: 0,
      archived: false,
    });
  }
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function makeFixtureShellSnapshot(): WorkspaceShellSnapshot {
  const workspace: WorkspaceShellSnapshot['workspace'] = {
    id: 'fixture-workspace',
    name: 'Browser fixture workspace',
    generalLabel: 'General',
    defaultDangerousMode: false,
    defaultNewSessionDangerous: false,
    theme: 'dark',
    defaultAgentKind: 'cortex_code',
  };

  const generalFocus = {
    id: 'focus-general',
    projectId: null,
    title: 'General',
    description: null,
    sortOrder: 0,
    archived: false,
  };

  // `?fixture=populated` returns a rich workspace (projects, focuses, sessions
  // across every state, plus archived ones) for exercising the dashboard,
  // sidebar accordions, and focus view. Every other value (including `empty`)
  // returns the seeded-but-empty first-launch shape.
  if (new URLSearchParams(window.location.search).get('fixture') === 'populated') {
    return makePopulatedFixtureSnapshot(workspace, generalFocus);
  }

  return {
    workspace,
    projects: [],
    focuses: [generalFocus],
    sessions: [],
  };
}

function makePopulatedFixtureSnapshot(
  workspace: WorkspaceShellSnapshot['workspace'],
  generalFocus: WorkspaceShellSnapshot['focuses'][number],
): WorkspaceShellSnapshot {
  const project = {
    id: 'project-cortex-mono',
    name: 'cortex-mono',
    path: '/Users/user/Code/cortex-mono',
    archived: false,
  };
  const authFocus = {
    id: 'focus-auth',
    projectId: project.id,
    title: 'Auth',
    description: null,
    sortOrder: 0,
    archived: false,
  };
  const brandingFocus = {
    id: 'focus-branding',
    projectId: project.id,
    title: 'Branding',
    description: null,
    sortOrder: 10,
    archived: false,
  };

  const session = (
    overrides: Partial<WorkspaceShellSnapshot['sessions'][number]> & {
      id: string;
      focusId: string;
      title: string;
    },
  ): WorkspaceShellSnapshot['sessions'][number] => ({
    agentKind: 'cortex_code',
    cwd: project.path,
    nativeSessionRef: null,
    launchMode: 'new',
    dangerousModeOverride: false,
    status: 'not_started',
    lastExitCode: null,
    tabVisible: true,
    archived: false,
    ...overrides,
  });

  return {
    workspace,
    projects: [project],
    focuses: [generalFocus, authFocus, brandingFocus],
    sessions: [
      session({
        id: 'session-auth-running',
        focusId: authFocus.id,
        title: 'OAuth refactor',
        agentKind: 'claude_code',
        status: 'running',
      }),
      session({
        id: 'session-auth-failed',
        focusId: authFocus.id,
        title: 'Token rotation',
        agentKind: 'cortex_code',
        status: 'restore_failed',
      }),
      session({
        id: 'session-auth-fresh',
        focusId: authFocus.id,
        title: 'Session store spike',
        agentKind: 'codex_cli',
        status: 'not_started',
      }),
      session({
        id: 'session-auth-done',
        focusId: authFocus.id,
        title: 'Login form polish',
        agentKind: 'claude_code',
        status: 'restorable',
      }),
      session({
        id: 'session-auth-archived',
        focusId: authFocus.id,
        title: 'Old password reset',
        agentKind: 'cortex_code',
        status: 'exited',
        tabVisible: false,
        archived: true,
      }),
      session({
        id: 'session-branding-running',
        focusId: brandingFocus.id,
        title: 'Logo explorations',
        agentKind: 'codex_cli',
        status: 'running',
      }),
      session({
        id: 'session-general-fresh',
        focusId: generalFocus.id,
        title: 'Scratch notes',
        agentKind: 'cortex_code',
        cwd: '/Users/user',
        status: 'not_started',
      }),
      session({
        id: 'session-general-done',
        focusId: generalFocus.id,
        title: 'Weekly summary',
        agentKind: 'claude_code',
        cwd: '/Users/user',
        status: 'restorable',
      }),
    ],
  };
}
