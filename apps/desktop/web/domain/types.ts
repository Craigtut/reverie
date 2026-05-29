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

export interface GhosttyFrameSequencePayload {
  frames: TerminalFrame[];
  output_bytes: number;
}

export interface StartSessionRequest {
  sessionId: string;
  terminalId: string;
  cols: number;
  rows: number;
  maxScrollback: number;
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
}

export interface ShellProject {
  id: string;
  name: string;
  path: string;
  archived: boolean;
}

export interface ShellFocus {
  id: string;
  projectId?: string | null;
  title: string;
  description?: string | null;
  sortOrder: number;
  archived: boolean;
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
  nativeSessionRef?: NativeSessionRef | null;
  launchMode: 'new' | 'resume';
  dangerousModeOverride?: boolean | null;
  status: 'not_started' | 'running' | 'exited' | 'restorable' | 'restore_failed';
  lastExitCode?: number | null;
  tabVisible?: boolean;
  // Persisted last-observed activity for this session (from the Cortex
  // filesystem watcher, eventually also Claude/Codex hooks). Seeds the
  // dashboard cortexActivity map on app start so state is visible immediately.
  latestActivity?: ActivityState | null;
}

// Mirrors reverie-core's ActivityStatus enum (snake_case wire format).
export type ActivityStatus = 'working' | 'awaiting_input' | 'awaiting_permission' | 'done' | 'error';

export interface ActivityPermissionRequest {
  id: string;
  toolName: string;
  displaySummary: string;
  args?: unknown;
  requestedAt: string;
}

export interface ActivityError {
  category: 'rate_limit' | 'authentication' | 'network' | 'context_overflow' | 'cancelled' | 'other';
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
  turn?: { id: string; status: 'running' | 'completed' | 'aborted'; startedAt: string; endedAt?: string | null } | null;
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
  | { kind: 'updated'; payload: { source: SessionActivitySource; nativeSessionId: string; state: ActivityState } }
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
  available: boolean;
}

export type PaletteEntry =
  | { kind: 'focus'; id: string; title: string; projectId: string | null; projectName: string | null; sessionCount: number }
  | { kind: 'session'; session: ShellSession; breadcrumb: string; activity: ActivityState | null };

export type DashboardStatus = 'attention' | 'live' | 'recent';

export type GlyphState = 'working' | 'attention' | 'error' | 'idle';
