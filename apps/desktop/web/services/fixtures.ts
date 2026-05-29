import { makeSyntheticFrame } from '../terminal-canvas-renderer';
import { findMatchesInFrame } from '../terminal/findModel';
import type { TerminalFrame } from '../terminalTypes';
import type { AgentCliDetection, AgentKind, WorkspaceShellSnapshot } from '../domain';
import type { EventHandler, UnlistenFn } from './types';

// Fixture frames are authored at the default surface width; search reuses it.
const FIXTURE_COLS = 120;
const FIXTURE_SEARCH_MAX = 2_000;
// The most recent frame per terminal, so the fixture `search_terminal` can scan
// the same content the harness injected/streamed (the real backend searches the
// live Ghostty buffer).
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
  { sessionId: string; cancelled: boolean; startedAt: number; framesEmitted: number }
>();
const fixtureStorageKey = makeFixtureStorageKey();
// Test-only record of terminal input writes, surfaced on the window hook so the
// harness can assert "send to input" / "ask an agent" seeded the right text.
const recordedTerminalInputs: Array<{ terminalId: string; input: string }> = [];
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
    case 'choose_project_folder':
      return { name: 'reverie', path: '/Users/user/Code/reverie' } as T;
    case 'create_project':
      return createFixtureProject(args) as T;
    case 'create_focus':
      return createFixtureFocus(args) as T;
    case 'create_session':
      return createFixtureSession(args) as T;
    case 'update_session_tab_visibility':
      return updateFixtureSessionTabVisibility(args) as T;
    case 'remove_session':
      return removeFixtureSession(args) as T;
    case 'archive_focus':
      return archiveFixtureFocus(args) as T;
    case 'archive_project':
      return archiveFixtureProject(args) as T;
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
    case 'scroll_terminal_viewport_to_row':
      return undefined as T;
    case 'search_terminal':
      return searchFixtureTerminal(args) as T;
    case 'terminal_history_info':
      return historyInfoFixture(args) as T;
    case 'terminal_history_window':
      return historyWindowFixture(args) as T;
    case 'record_render_metrics':
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
    dangerousModeOverride: request.dangerousModeOverride ?? false,
    status: 'not_started' as const,
    lastExitCode: null,
    tabVisible: true,
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

// The fixture has no replay engine; it serves the last injected/streamed frame
// as the whole "history" (keyed by session id in the harness via the active
// terminal's frame). Good enough to exercise the history-view UI flow.
function fixtureSessionFrame(): TerminalFrame | undefined {
  // The harness drives a single active terminal; return its last frame.
  const frames = [...lastFixtureFrames.values()];
  return frames[frames.length - 1];
}

function historyInfoFixture(_args?: Record<string, unknown>) {
  const frame = fixtureSessionFrame();
  return { totalRows: frame ? frame.rows.length : 0 };
}

function historyWindowFixture(args?: Record<string, unknown>) {
  const startRow = Number(args?.startRow ?? 0);
  const frame = fixtureSessionFrame() ?? { dirty: 'full', rows: [] };
  return { startRow, frame };
}

function searchFixtureTerminal(args?: Record<string, unknown>) {
  const terminalId = readDirectArg<string>(args, 'terminalId');
  const query = (args?.query as string) ?? '';
  const caseSensitive = Boolean(args?.caseSensitive);
  const frame = lastFixtureFrames.get(terminalId);
  if (!frame || query.length === 0) {
    return { matches: [], total: 0, capped: false };
  }
  const all = findMatchesInFrame(frame, query, caseSensitive, FIXTURE_COLS);
  return {
    matches: all.slice(0, FIXTURE_SEARCH_MAX),
    total: all.length,
    capped: all.length > FIXTURE_SEARCH_MAX,
  };
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

  window.setTimeout(() => emitFixtureFrames(terminalId, cols, rows), 16);
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
    recordedInputs() {
      return recordedTerminalInputs.slice();
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
  }
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function makeFixtureShellSnapshot(): WorkspaceShellSnapshot {
  const workspace = {
    id: 'fixture-workspace',
    name: 'Browser fixture workspace',
    generalLabel: 'General',
    defaultDangerousMode: false,
  };

  // The harness defaults to an empty workspace, matching the Tauri build's first-launch state.
  // The `?fixture=empty` URL param is still honored for callers that pass it explicitly; the
  // default branch returns the same shape.
  return {
    workspace,
    projects: [],
    focuses: [],
    sessions: [],
  };
}
