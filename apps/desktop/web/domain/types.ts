import type { TerminalFrame, TerminalRow } from '../terminalTypes';

// The Reverie domain model as consumed by the frontend: the workspace shell
// snapshot, the activity stream, agent/session descriptors, and the command
// payload shapes shared between the React shell and the Tauri runtime. These
// are plain data shapes with no React or Tauri coupling.

export type ProjectFilter = string | null;
export type SurfaceMode = 'dashboard' | 'terminal' | 'settings' | 'session-history';
export type AgentKind = 'claude_code' | 'codex_cli' | 'cortex_code';
export type CreationMode = 'project' | 'focus' | 'session' | null;

export interface RenderMetrics {
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
  frontendFrameBatches?: number;
  coalescedFrames?: number;
  avgFramesPerBatch?: number;
  maxFramesPerBatch?: number;
  avgBatchPaintMs?: number;
  p95BatchPaintMs?: number;
  maxBatchPaintMs?: number;
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
  rendererBackend?: string;
  paintSamples?: number;
  scrollPaintSamples?: number;
  avgPaintMs?: number;
  p95PaintMs?: number;
  maxPaintMs?: number;
  avgScrollPaintMs?: number;
  p95ScrollPaintMs?: number;
  maxScrollPaintMs?: number;
  rendererPaints?: number;
  rendererClears?: number;
  rendererRowsPainted?: number;
  rendererCellsPainted?: number;
  rendererGlyphsPainted?: number;
  rendererBlockGlyphsPainted?: number;
  rendererDrawCalls?: number;
  rendererRectDrawCalls?: number;
  rendererGlyphDrawCalls?: number;
  rendererBufferUploads?: number;
  rendererBufferUploadBytes?: number;
  glyphAtlasHits?: number;
  glyphAtlasMisses?: number;
  glyphAtlasUploads?: number;
  glyphAtlasResets?: number;
  maxRowsPerPaint?: number;
  maxCellsPerPaint?: number;
}

export interface GhosttyFrameSequencePayload {
  frames: TerminalFrame[];
  output_bytes: number;
}

export interface StartSessionRequest {
  sessionId?: string | null;
  terminalId?: string;
  spawnSpec?: TerminalSpawnSpec;
  cols?: number;
  rows?: number;
  maxScrollback?: number;
}

export interface TerminalSpawnSpec {
  command: TerminalCommandSpec;
  cols: number;
  rows: number;
  title?: string | null;
}

export interface TerminalCommandSpec {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface TerminalStreamStartedPayload {
  terminalId: string;
  targetFrames?: number | null;
  cols: number;
  rows: number;
}

export interface TerminalFramePayload {
  terminalId: string;
  seq: number;
  bytesRead: number;
  chunkBytes: number;
  rustElapsedMs: number;
  frame: TerminalFrame;
}

export interface TerminalExitPayload {
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

export interface TerminalFailedPayload {
  terminalId?: string;
  message?: string;
}

export interface WorkspaceShellSnapshot {
  workspace: ShellWorkspace;
  projects: ShellProject[];
  focuses: ShellFocus[];
  sessions: ShellSession[];
}

export interface ShellWorkspace {
  id: string;
  name: string;
  generalLabel: string;
  defaultDangerousMode: boolean;
  // Persisted default YOLO state seeded into the new-session composer. Only a
  // starting value for the form; it does not affect existing sessions and is
  // independent of defaultDangerousMode (the per-session fallback).
  defaultNewSessionDangerous: boolean;
  // Agent CLIs the user has switched off. Absent/empty means all enabled.
  disabledAgentKinds?: AgentKind[];
  // Persisted light/dark appearance. The renderer seeds the live uiStore theme
  // from this on load, so the chosen mode survives restarts.
  theme: 'light' | 'dark';
  // Persisted default agent kind seeded into the new-session composer. Only a
  // starting value for the form; it does not affect existing sessions.
  defaultAgentKind: AgentKind;
  // Opaque, frontend-owned UI view state (last selection, surface, sidebar
  // accordion) serialized as JSON, so the workspace reopens where the user left
  // it. Absent/null means "never saved" (seed the default view). See
  // PersistedNavState and useNavPersistence.
  navState?: string | null;
}

// The navigation we persist so a reload or relaunch reopens the last view
// instead of resetting to the dashboard. Serialized into ShellWorkspace.navState
// (a backend column the domain stores verbatim). Sets are stored as arrays since
// JSON has no Set; creationMode is deliberately excluded (we never restore a
// half-finished creation flow).
export interface PersistedNavState {
  selectedProjectId: ProjectFilter;
  selectedFocusId: string | null;
  selectedSessionId: string | null;
  surfaceMode: SurfaceMode;
  collapsedProjectIds: string[];
  expandedFocusIds: string[];
  generalCollapsed: boolean;
}

export interface ShellProject {
  id: string;
  name: string;
  path: string;
  archived: boolean;
  // Position in the left-nav project list, for drag-to-reorder. The backend
  // always sends it; absent only in hand-built fixtures/tests (treated as 0).
  sortOrder?: number;
}

export interface ShellFocus {
  id: string;
  projectId?: string | null;
  title: string;
  description?: string | null;
  sortOrder: number;
  archived: boolean;
  // Topic-wide default dangerous (auto-approve) mode. Sessions in this focus
  // inherit it unless they carry their own override; null/undefined falls
  // through to the workspace default.
  defaultDangerousMode?: boolean | null;
}

export interface NativeSessionRef {
  kind: string;
  sessionId?: string | null;
  metadataPath?: string | null;
  adapterPayload?: unknown;
}

export interface ShellSession {
  id: string;
  focusId: string;
  title: string;
  agentKind: string;
  cwd: string;
  // Position within its focus (topic), for drag-to-reorder. The backend always
  // sends it; absent only in hand-built fixtures/tests (treated as 0).
  sortOrder?: number;
  nativeSessionRef?: NativeSessionRef | null;
  launchMode: 'new' | 'resume';
  dangerousModeOverride?: boolean | null;
  status: 'not_started' | 'running' | 'exited' | 'restorable' | 'restore_failed';
  lastExitCode?: number | null;
  tabVisible?: boolean;
  // Whether the user archived this session. Archived sessions leave Home and the
  // sidebar focus lists and live only in the focus's archived list (restorable
  // anytime). Closing a session archives it. Absent/false means not archived.
  archived?: boolean;
  // Persisted last-observed activity for this session (from the Cortex
  // filesystem watcher, eventually also Claude/Codex hooks). Seeds the
  // dashboard cortexActivity map on app start so state is visible immediately.
  latestActivity?: ActivityState | null;
}

// Mirrors reverie-core's ActivityStatus enum (snake_case wire format).
export type ActivityStatus =
  | 'working'
  | 'awaiting_input'
  | 'awaiting_permission'
  | 'done'
  | 'error';

export interface ActivityPermissionRequest {
  id: string;
  toolName: string;
  displaySummary: string;
  args?: unknown;
  requestedAt: string;
}

export interface ActivityError {
  category:
    | 'rate_limit'
    | 'authentication'
    | 'network'
    | 'context_overflow'
    | 'cancelled'
    | 'other';
  message: string;
  recoverable: boolean;
  occurredAt: string;
}

export interface ActivityState {
  version: number;
  sessionId: string;
  status: ActivityStatus;
  updatedAt: string;
  sequence: number;
  cwd: string;
  turn?: {
    id: string;
    status: 'running' | 'completed' | 'aborted';
    startedAt: string;
    endedAt?: string | null;
  } | null;
  activeTools?: {
    toolCallId: string;
    toolName: string;
    startedAt: string;
    displaySummary?: string | null;
    childTaskId?: string | null;
  }[];
  awaitingPermission?: ActivityPermissionRequest | null;
  lastError?: ActivityError | null;
}

// Payload shape from the Tauri `session_activity_changed` event. Matches the
// Rust `SessionActivityEvent` enum at apps/desktop/src-tauri/src/main.rs.
// One stream now carries Cortex (filesystem watcher) plus Claude and Codex
// (HTTP hook receiver) updates; the `source` discriminator says which.
export type SessionActivitySource = 'cortex_code' | 'claude_code' | 'codex_cli';
export type SessionActivityEventPayload =
  | {
      kind: 'updated';
      payload: { source: SessionActivitySource; nativeSessionId: string; state: ActivityState };
    }
  | { kind: 'removed'; payload: { source: SessionActivitySource; nativeSessionId: string } };

export interface CreateProjectRequest {
  name: string;
  path: string;
}

export interface ProjectFolderSelection {
  name: string;
  path: string;
}

export interface SessionTerminalBinding {
  terminalId: string;
  inputArmed: boolean;
}

export interface SessionTerminalView {
  lastFrame: TerminalFrame | null;
  compositeFrame: TerminalFrame;
  scrollbackRows: TerminalRow[];
  rowCount: number;
  liveFollow: boolean;
}

export interface CreateFocusRequest {
  projectId: string | null;
  title: string;
  description?: string | null;
  defaultDangerousMode?: boolean | null;
}

export interface CreateSessionRecordRequest {
  focusId: string;
  title: string;
  agentKind: AgentKind;
  cwd: string;
  dangerousModeOverride?: boolean | null;
}

export interface AgentCliDetection {
  kind: AgentKind;
  displayName: string;
  executable?: string | null;
  candidates: string[];
  // Detected on this machine (installed and on PATH / at a known location).
  available: boolean;
  // User has this CLI switched on. Enabled by default; only an explicit
  // toggle-off in settings sets this false. A CLI must be both `available`
  // and `enabled` to be offered as a session agent.
  enabled: boolean;
}

export type PaletteEntry =
  | {
      kind: 'focus';
      id: string;
      title: string;
      projectId: string | null;
      projectName: string | null;
      sessionCount: number;
    }
  | { kind: 'session'; session: ShellSession; breadcrumb: string; activity: ActivityState | null };

export type DashboardStatus = 'attention' | 'live' | 'recent';

// The user-facing lifecycle state a session is grouped under on Home and in the
// focus view. Derived from the live activity feed when present, the persisted
// record status otherwise. `archived` is handled separately (a filter, not a
// group), so it is not part of this set.
//   active   = the agent is mid-turn, actively working
//   idle     = the session is waiting for you. Whether its process is still
//              alive or has exited is deliberately not surfaced: opening it
//              re-attaches if live and resumes if not, so both read the same to
//              a user. `fresh` (never launched) stays separate because there is
//              no conversation to reopen yet.
export type SessionState = 'attention' | 'active' | 'idle' | 'fresh';

export type GlyphState = 'working' | 'attention' | 'error' | 'idle';
