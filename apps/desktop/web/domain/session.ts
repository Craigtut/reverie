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
      theme: 'dark',
      defaultAgentKind: 'claude_code',
      terminalFontSize: 14,
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
// focus is project-backed. General (project-less) sessions return an empty
// string, because the backend provisions a fresh scratch workspace for each one
// and ignores whatever cwd the frontend sends.
export function defaultCwdForFocus(
  focus: ShellFocus | null,
  shell: WorkspaceShellSnapshot,
): string {
  if (!focus?.projectId) return '';
  return shell.projects.find(project => project.id === focus.projectId)?.path ?? '';
}

export function sessionBreadcrumb(session: ShellSession, shell: WorkspaceShellSnapshot): string {
  const focus = shell.focuses.find(f => f.id === session.focusId);
  if (!focus) return 'Workspace';
  if (!focus.projectId) return focus.title;
  const project = shell.projects.find(p => p.id === focus.projectId);
  return project ? `${project.name} · ${focus.title}` : focus.title;
}

// The breadcrumb split into its parts so a surface can give each its own weight
// (e.g. the dashboard card leads with the project, the cross-project key). A
// General session has no project, so `project` is null and the topic stands alone.
export function sessionContext(
  session: ShellSession,
  shell: WorkspaceShellSnapshot,
): { project: string | null; topic: string } {
  const focus = shell.focuses.find(f => f.id === session.focusId);
  if (!focus) return { project: null, topic: 'Workspace' };
  const project = focus.projectId ? shell.projects.find(p => p.id === focus.projectId) : null;
  return { project: project?.name ?? null, topic: focus.title };
}

export function agentLabel(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
}

// Listed in the agent priority order the backend uses (`built_in_adapters`:
// Claude Code, then Codex, then Cortex, then any later additions), so the
// harness picks the same default and fallback as a real install.
export function fallbackAgentCliDetections(): AgentCliDetection[] {
  return [
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
    {
      kind: 'cortex_code',
      displayName: 'Cortex Code',
      executable: 'cortex',
      candidates: ['cortex'],
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

// Whether restoring an archived session can bring its conversation back. Restore
// puts the tab back and, for a session that already ran, resumes the underlying
// CLI conversation. That resume is only impossible when the session exited
// without ever capturing a native session id: there is nothing to `--resume`
// into. Every other state can be restored (still resumable, retryable after a
// failed resume, never started, or still running), so the UI stays quiet and
// only flags the genuine dead end.
export function sessionCanRestore(session: ShellSession): boolean {
  return !(session.status === 'exited' && !session.nativeSessionRef);
}

// Resolve a session's effective dangerous (auto-approve) mode. Precedence:
// the session's own override, then its topic (focus) default, then the
// workspace default. Mirrors Session::effective_dangerous_mode in the Rust core.
export function effectiveSessionDangerousMode(
  session: ShellSession | null,
  focusDefault: boolean | null | undefined,
  workspaceDefault: boolean,
): boolean {
  return session?.dangerousModeOverride ?? focusDefault ?? workspaceDefault;
}

export function dangerousLabel(
  session: ShellSession | null,
  focusDefault: boolean | null | undefined,
  workspaceDefault: boolean,
) {
  return effectiveSessionDangerousMode(session, focusDefault, workspaceDefault)
    ? 'Explicitly enabled'
    : 'Off';
}
