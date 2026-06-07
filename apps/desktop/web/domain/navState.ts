// Pure, React-free logic for persisted navigation: parse the stored blob,
// serialize the live view canonically, and reconcile a saved view against the
// current shell. The effectful side (when to hydrate/write, soft-reload vs cold
// open) lives in hooks/useNavPersistence.

import { isFocusEffectivelyArchived } from './archive';
import type { PersistedNavState, SurfaceMode, WorkspaceShellSnapshot } from './types';

const SURFACE_MODES: ReadonlySet<string> = new Set<SurfaceMode>([
  'dashboard',
  'project-dashboard',
  'terminal',
  'settings',
  'session-history',
]);

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

// Parse the stored blob defensively: anything malformed or shape-wrong returns
// null, so a corrupt value falls back to seeding a default view, never a throw.
export function parseNavState(raw: string | null | undefined): PersistedNavState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value.surfaceMode !== 'string' || !SURFACE_MODES.has(value.surfaceMode)) return null;
  return {
    selectedProjectId: typeof value.selectedProjectId === 'string' ? value.selectedProjectId : null,
    selectedFocusId: typeof value.selectedFocusId === 'string' ? value.selectedFocusId : null,
    selectedSessionId: typeof value.selectedSessionId === 'string' ? value.selectedSessionId : null,
    surfaceMode: value.surfaceMode as SurfaceMode,
    collapsedProjectIds: toStringArray(value.collapsedProjectIds),
    expandedFocusIds: toStringArray(value.expandedFocusIds),
    generalCollapsed: value.generalCollapsed === true,
  };
}

// Canonical serialization: fixed key order and sorted id sets, so two views that
// differ only in set ordering serialize identically. That lets the writer skip a
// no-op write and lets hydration seed `lastWritten` with exactly what the writer
// would produce, so it never echoes the just-restored view straight back.
export function serializeNavState(view: PersistedNavState): string {
  return JSON.stringify({
    selectedProjectId: view.selectedProjectId,
    selectedFocusId: view.selectedFocusId,
    selectedSessionId: view.selectedSessionId,
    surfaceMode: view.surfaceMode,
    collapsedProjectIds: [...view.collapsedProjectIds].sort(),
    expandedFocusIds: [...view.expandedFocusIds].sort(),
    generalCollapsed: view.generalCollapsed,
  });
}

// Reconcile a parsed view against the current shell: drop a selection that no
// longer exists (archived/deleted), prune accordion ids to entities that still
// exist, derive the project from the focus so the two never disagree, and apply
// the cold-open surface policy. A deep surface with no valid target falls back to
// the dashboard so we never restore into an empty terminal or topic overview.
export function reconcilePersistedView(
  persisted: PersistedNavState,
  shell: WorkspaceShellSnapshot,
  options: { isSoftReload: boolean },
): PersistedNavState {
  const focus = persisted.selectedFocusId
    ? (shell.focuses.find(
        f => f.id === persisted.selectedFocusId && !isFocusEffectivelyArchived(f, shell),
      ) ?? null)
    : null;

  let selectedFocusId: string | null = null;
  let selectedProjectId: string | null = null;
  let selectedSessionId: string | null = null;
  if (focus) {
    selectedFocusId = focus.id;
    selectedProjectId = focus.projectId ?? null;
    const session = persisted.selectedSessionId
      ? (shell.sessions.find(
          s => s.id === persisted.selectedSessionId && s.focusId === focus.id && !s.archived,
        ) ?? null)
      : null;
    selectedSessionId = session?.id ?? null;
  }

  const projectIds = new Set(shell.projects.map(project => project.id));
  const focusIds = new Set(shell.focuses.map(f => f.id));

  let surfaceMode: SurfaceMode = options.isSoftReload ? persisted.surfaceMode : 'dashboard';
  if (surfaceMode === 'terminal' && !selectedSessionId) surfaceMode = 'dashboard';
  if (surfaceMode === 'session-history' && !selectedFocusId) surfaceMode = 'dashboard';

  // The project dashboard owns a project selection of its own, independent of any
  // focus (an empty project still has a dashboard). Restore it from the stored
  // project, validated against what still exists, and fall back to Home if that
  // project is gone. A focus selection is irrelevant to this surface.
  if (surfaceMode === 'project-dashboard') {
    const storedProject = persisted.selectedProjectId
      ? (shell.projects.find(p => p.id === persisted.selectedProjectId && !p.archived) ?? null)
      : null;
    if (storedProject) {
      selectedProjectId = storedProject.id;
      selectedFocusId = null;
    } else {
      surfaceMode = 'dashboard';
    }
  }

  // Only the terminal surface owns a session selection; every other surface keeps
  // selectedSessionId null (the app's standing invariant). If we restored a
  // session onto a non-terminal surface (e.g. cold-open lands on the dashboard),
  // a reconcile effect would immediately clear it and the writer would persist
  // that null, wiping the saved session. Drop it here instead, so the backend
  // keeps the full terminal view for the next soft reload to restore.
  if (surfaceMode !== 'terminal') selectedSessionId = null;

  return {
    selectedProjectId,
    selectedFocusId,
    selectedSessionId,
    surfaceMode,
    collapsedProjectIds: persisted.collapsedProjectIds.filter(id => projectIds.has(id)),
    expandedFocusIds: persisted.expandedFocusIds.filter(id => focusIds.has(id)),
    generalCollapsed: persisted.generalCollapsed,
  };
}
