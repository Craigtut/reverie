import { invoke } from './runtime';
import type {
  AgentCliDetection,
  AgentKind,
  CreateFocusRequest,
  CreateProjectRequest,
  CreateSessionRecordRequest,
  ProjectFolderSelection,
  WorkspaceShellSnapshot,
} from '../domain';

// Typed wrappers over the workspace/project/focus/session commands. Callers go
// through these instead of passing raw command strings + untyped arg bags to
// invoke(), so the command surface is discoverable and the request/response
// shapes are checked. Every mutation returns the fresh shell snapshot.

export function fetchWorkspaceShell() {
  return invoke<WorkspaceShellSnapshot>('workspace_shell');
}

export function recordWebviewHeartbeat() {
  return invoke('webview_heartbeat');
}

export function listAgentClis() {
  return invoke<AgentCliDetection[]>('list_agent_clis');
}

// Switch a single agent CLI on or off. Returns the refreshed detection list so
// the shell store updates in one round-trip. Disabling also tears down that
// CLI's inter-agent bridge config on the backend.
export function setAgentCliEnabled(kind: AgentKind, enabled: boolean) {
  return invoke<AgentCliDetection[]>('set_agent_cli_enabled', {
    request: { kind, enabled },
  });
}

export function chooseProjectFolder() {
  return invoke<ProjectFolderSelection | null>('choose_project_folder');
}

export function createProject(request: CreateProjectRequest) {
  return invoke<WorkspaceShellSnapshot>('create_project', { request });
}

export function createFocus(request: CreateFocusRequest) {
  return invoke<WorkspaceShellSnapshot>('create_focus', { request });
}

export function createSession(request: CreateSessionRecordRequest) {
  return invoke<WorkspaceShellSnapshot>('create_session', { request });
}

export function removeSession(sessionId: string) {
  return invoke<WorkspaceShellSnapshot>('remove_session', { sessionId });
}

export function archiveFocus(focusId: string) {
  return invoke<WorkspaceShellSnapshot>('archive_focus', { focusId });
}

export function restoreFocus(focusId: string) {
  return invoke<WorkspaceShellSnapshot>('restore_focus', { focusId });
}

export function deleteFocus(focusId: string) {
  return invoke<WorkspaceShellSnapshot>('delete_focus', { focusId });
}

export function archiveProject(projectId: string) {
  return invoke<WorkspaceShellSnapshot>('archive_project', { projectId });
}

export function deleteProject(projectId: string) {
  return invoke<WorkspaceShellSnapshot>('delete_project', { projectId });
}

export function setWorkspaceDefaultDangerousMode(defaultDangerousMode: boolean) {
  return invoke<WorkspaceShellSnapshot>('set_workspace_default_dangerous_mode', {
    request: { defaultDangerousMode },
  });
}

export function setSessionDangerousMode(sessionId: string, dangerousModeOverride: boolean) {
  return invoke<WorkspaceShellSnapshot>('set_session_dangerous_mode', {
    request: { sessionId, dangerousModeOverride },
  });
}

// Persist that the user viewed a session, clearing its "finished" / unseen
// marker. `viewedAt` is this machine's ISO 8601 timestamp, sent so the stored
// value matches the optimistic one the renderer already applied. Fire-and-forget:
// callers apply the optimistic store update for instant feedback and do not need
// the returned snapshot, so the durability write can fail quietly (e.g. in the
// browser harness, which has no backend).
export function markSessionViewed(shellSessionId: string, viewedAt: string) {
  return invoke<WorkspaceShellSnapshot>('mark_session_viewed', {
    request: { shellSessionId, viewedAt },
  });
}

// Dismiss a session's re-entry ("where we left off") header. Marks the current
// summary dismissed so it hides; it returns the next time the session finishes a
// turn while the user is away. Fire-and-forget like markSessionViewed: callers
// apply the optimistic store update and do not need the returned snapshot.
export function dismissSessionReentry(shellSessionId: string) {
  return invoke<WorkspaceShellSnapshot>('dismiss_session_reentry', {
    request: { shellSessionId },
  });
}

// Answer a tool-permission request from the native approval card. Routes the
// decision to the blocked CLI hook (Claude / Codex) or the Cortex decision file.
// Resolves to whether the decision was delivered: `false` means no waiter was
// found (the request already timed out, or the session is not wired for inline
// answers), so the caller should fall back to "respond in the terminal".
export function resolvePermission(
  shellSessionId: string,
  requestId: string,
  decision: 'allow' | 'deny',
) {
  return invoke<boolean>('resolve_permission', {
    request: { shellSessionId, requestId, decision },
  });
}
