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

export function setSessionTabVisibility(shellSessionId: string, tabVisible: boolean) {
  return invoke<WorkspaceShellSnapshot>('update_session_tab_visibility', {
    request: { shellSessionId, tabVisible },
  });
}

export function removeSession(sessionId: string) {
  return invoke<WorkspaceShellSnapshot>('remove_session', { sessionId });
}

export function archiveFocus(focusId: string) {
  return invoke<WorkspaceShellSnapshot>('archive_focus', { focusId });
}

export function archiveProject(projectId: string) {
  return invoke<WorkspaceShellSnapshot>('archive_project', { projectId });
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
