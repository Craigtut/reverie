import { USER_HOME } from './constants';
import { shortId } from './format';
import type { AgentCliDetection, ShellFocus, ShellSession, WorkspaceShellSnapshot } from './types';

// Pure helpers over the session/shell model: breadcrumbs, labels, fallbacks,
// and project/session filtering.

export function fallbackShellSnapshot(): WorkspaceShellSnapshot {
  return {
    workspace: {
      id: 'fallback-workspace',
      name: 'Local workspace',
      generalLabel: 'General',
      defaultDangerousMode: false,
      defaultNewSessionDangerous: false,
      theme: 'dark',
      defaultAgentKind: 'cortex_code',
    },
    projects: [],
    focuses: [],
    sessions: [],
  };
}

export function sessionsForProject(projectId: string | null, shell: WorkspaceShellSnapshot) {
  const focusIds = new Set(
    shell.focuses.filter(focus => focus.projectId === projectId).map(focus => focus.id),
  );
  return shell.sessions.filter(session => focusIds.has(session.focusId));
}

// Non-archived sessions for a single focus, the set the left-nav accordion and
// the focus dashboard show. Archived sessions live only in the focus's archived
// list.
export function activeSessionsInFocus(shell: WorkspaceShellSnapshot, focusId: string) {
  return shell.sessions.filter(session => session.focusId === focusId && !session.archived);
}

// The General project (`projectId == null`) keeps its focus implicit: the UI
// lists General's sessions directly. `ensure_seeded` creates exactly one general
// focus, but pre-existing data may have several, so callers treat them as one
// flat bucket and target the primary one for new sessions.
export function primaryGeneralFocus(shell: WorkspaceShellSnapshot): ShellFocus | null {
  return shell.focuses.find(focus => !focus.projectId && !focus.archived) ?? null;
}

export function activeGeneralSessions(shell: WorkspaceShellSnapshot) {
  const generalFocusIds = new Set(
    shell.focuses.filter(focus => !focus.projectId && !focus.archived).map(focus => focus.id),
  );
  return shell.sessions.filter(
    session => generalFocusIds.has(session.focusId) && !session.archived,
  );
}

// The cwd a new session should default to: the focus's project folder when the
// focus is project-backed, otherwise the user's home directory.
export function defaultCwdForFocus(
  focus: ShellFocus | null,
  shell: WorkspaceShellSnapshot,
): string {
  if (!focus?.projectId) return USER_HOME;
  return shell.projects.find(project => project.id === focus.projectId)?.path ?? USER_HOME;
}

export function sessionBreadcrumb(session: ShellSession, shell: WorkspaceShellSnapshot): string {
  const focus = shell.focuses.find(f => f.id === session.focusId);
  if (!focus) return 'Workspace';
  if (!focus.projectId) return focus.title;
  const project = shell.projects.find(p => p.id === focus.projectId);
  return project ? `${project.name} · ${focus.title}` : focus.title;
}

export function agentLabel(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
}

export function fallbackAgentCliDetections(): AgentCliDetection[] {
  return [
    {
      kind: 'cortex_code',
      displayName: 'Cortex Code',
      executable: 'cortex',
      candidates: ['cortex'],
      available: true,
      enabled: true,
    },
    {
      kind: 'claude_code',
      displayName: 'Claude Code',
      executable: 'claude',
      candidates: ['claude'],
      available: true,
      enabled: true,
    },
    {
      kind: 'codex_cli',
      displayName: 'Codex CLI',
      executable: 'codex',
      candidates: ['codex'],
      available: true,
      enabled: true,
    },
  ];
}

export function agentTabLabel(session: ShellSession) {
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

export function nativeSessionSummary(session: ShellSession | null) {
  const native = session?.nativeSessionRef;
  const nativeId = native?.sessionId;
  if (!nativeId) return null;

  return `${agentLabel(native.kind)} ${shortId(nativeId)}`;
}

export function launchButtonLabel(session: ShellSession) {
  if (session.status === 'restore_failed') return 'Retry resume';
  if (session.launchMode === 'resume' || session.nativeSessionRef) return 'Resume';
  return 'Run';
}

export function dangerousLabel(session: ShellSession | null, workspaceDefault: boolean) {
  const effective = session?.dangerousModeOverride ?? workspaceDefault;
  return effective ? 'Explicitly enabled' : 'Off';
}
