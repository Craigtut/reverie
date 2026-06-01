import type { ActivityState, PaletteEntry, WorkspaceShellSnapshot } from './types';

// Pure command-palette index: flatten the shell snapshot into focus + session
// entries, then substring-filter them.

export function buildPaletteEntries(
  shell: WorkspaceShellSnapshot,
  cortexActivity: Record<string, ActivityState>,
): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  for (const focus of shell.focuses) {
    if (focus.archived) continue;
    const project = focus.projectId
      ? (shell.projects.find(p => p.id === focus.projectId) ?? null)
      : null;
    if (project?.archived) continue;
    entries.push({
      kind: 'focus',
      id: focus.id,
      title: focus.title,
      projectId: focus.projectId ?? null,
      projectName: project?.name ?? null,
      sessionCount: shell.sessions.filter(s => s.focusId === focus.id && s.tabVisible !== false)
        .length,
    });
  }
  for (const session of shell.sessions) {
    if (session.tabVisible === false) continue;
    const focus = shell.focuses.find(f => f.id === session.focusId);
    if (!focus) continue;
    const project = focus.projectId
      ? (shell.projects.find(p => p.id === focus.projectId) ?? null)
      : null;
    const breadcrumb = project ? `${project.name} · ${focus.title}` : focus.title;
    const cortexId = session.nativeSessionRef?.sessionId;
    const activity = cortexId ? (cortexActivity[cortexId] ?? null) : null;
    entries.push({ kind: 'session', session, breadcrumb, activity });
  }
  return entries;
}

export function paletteHaystack(entry: PaletteEntry): string {
  if (entry.kind === 'focus') {
    return [entry.title, entry.projectName ?? ''].filter(Boolean).join(' ').toLowerCase();
  }
  return [entry.session.title, entry.breadcrumb, entry.session.cwd, entry.session.agentKind]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function filterPalette(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return entries.slice(0, 25);
  // Simple substring filter; small workspace sizes make a fancier matcher
  // unnecessary for v1. If results explode we can swap in a fuse-style scorer.
  return entries.filter(entry => paletteHaystack(entry).includes(needle)).slice(0, 25);
}
