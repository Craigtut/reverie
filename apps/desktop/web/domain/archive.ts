import type { ShellFocus, ShellProject, ShellSession, WorkspaceShellSnapshot } from './types';

// The single source of truth for "is this hidden from the active workspace?".
//
// Curation is one axis with one stored bit per node (`archived`). A node is
// *effectively archived* when its own bit is set OR any ancestor is archived: a
// topic inside an archived project, or a session inside an archived topic or
// project, is hidden exactly as if it were archived itself. Visibility on Home,
// the sidebar, the dashboards, navigation, and the command palette is precisely
// "not effectively archived". The own `archived` bit alone (read directly, not
// through these helpers) is what the history surfaces use: a focus's archived
// sessions, a project's archived topics, the Settings list of archived projects.
//
// Computing visibility by walking ancestry, rather than writing the bit onto
// every descendant when a parent is archived, is what makes restore lossless:
// un-archiving the parent reveals the subtree exactly as it was, and any
// descendant the user had archived on its own stays archived. Keeping this rule
// in one place is also what stops the old drift where Home, the sidebar, and the
// palette each filtered slightly differently and a deleted project's sessions
// leaked onto Home.

export function isProjectArchived(project: ShellProject): boolean {
  return project.archived;
}

export function isFocusEffectivelyArchived(
  focus: ShellFocus,
  shell: Pick<WorkspaceShellSnapshot, 'projects'>,
): boolean {
  if (focus.archived) return true;
  if (!focus.projectId) return false;
  const project = shell.projects.find(p => p.id === focus.projectId);
  return project?.archived ?? false;
}

export function isSessionEffectivelyArchived(
  session: ShellSession,
  shell: Pick<WorkspaceShellSnapshot, 'projects' | 'focuses'>,
): boolean {
  if (session.archived) return true;
  const focus = shell.focuses.find(f => f.id === session.focusId);
  // A session whose focus no longer exists is an orphan; treat it as hidden so it
  // can never leak onto Home.
  if (!focus) return true;
  return isFocusEffectivelyArchived(focus, shell);
}

// The active session set for the whole workspace: what Home groups by state and
// the sidebar's workspace rollup counts. Excludes every effectively-archived
// session (own bit set, or under an archived topic/project).
export function activeWorkspaceSessions(shell: WorkspaceShellSnapshot): ShellSession[] {
  return shell.sessions.filter(session => !isSessionEffectivelyArchived(session, shell));
}
