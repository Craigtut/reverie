import { describe, expect, it } from 'vitest';

import { parseNavState, reconcilePersistedView, serializeNavState } from './navState';
import type {
  PersistedNavState,
  ShellFocus,
  ShellProject,
  ShellSession,
  WorkspaceShellSnapshot,
} from './types';

function makeProject(overrides: Partial<ShellProject> = {}): ShellProject {
  return { id: 'project-1', name: 'Reverie', path: '/code/reverie', archived: false, ...overrides };
}

function makeFocus(overrides: Partial<ShellFocus> = {}): ShellFocus {
  return {
    id: 'focus-1',
    projectId: 'project-1',
    title: 'Terminal work',
    description: null,
    sortOrder: 0,
    archived: false,
    ...overrides,
  };
}

function makeSession(overrides: Partial<ShellSession> = {}): ShellSession {
  return {
    id: 'session-1',
    focusId: 'focus-1',
    title: 'Build palette',
    agentKind: 'claude_code',
    cwd: '/code/reverie',
    nativeSessionRef: null,
    launchMode: 'new',
    dangerousModeOverride: null,
    status: 'not_started',
    tabVisible: true,
    ...overrides,
  };
}

function makeShell(overrides: Partial<WorkspaceShellSnapshot> = {}): WorkspaceShellSnapshot {
  return {
    workspace: {
      id: 'workspace-1',
      name: 'Local',
      generalLabel: 'General',
      defaultDangerousMode: false,
      theme: 'dark',
      defaultAgentKind: 'cortex_code',
    },
    projects: [makeProject()],
    focuses: [makeFocus()],
    sessions: [makeSession()],
    ...overrides,
  };
}

function makeView(overrides: Partial<PersistedNavState> = {}): PersistedNavState {
  return {
    selectedProjectId: 'project-1',
    selectedFocusId: 'focus-1',
    selectedSessionId: 'session-1',
    surfaceMode: 'terminal',
    collapsedProjectIds: [],
    expandedFocusIds: [],
    generalCollapsed: false,
    ...overrides,
  };
}

describe('serializeNavState / parseNavState', () => {
  it('round-trips a view', () => {
    const view = makeView({ collapsedProjectIds: ['project-1'], expandedFocusIds: ['focus-1'] });
    expect(parseNavState(serializeNavState(view))).toEqual(view);
  });

  it('is canonical: set ordering does not change the serialized string', () => {
    const a = serializeNavState(makeView({ expandedFocusIds: ['b', 'a', 'c'] }));
    const b = serializeNavState(makeView({ expandedFocusIds: ['c', 'a', 'b'] }));
    expect(a).toBe(b);
  });

  it('returns null for empty, malformed, or shape-wrong input', () => {
    expect(parseNavState(null)).toBeNull();
    expect(parseNavState('')).toBeNull();
    expect(parseNavState('not json')).toBeNull();
    expect(parseNavState('123')).toBeNull();
    // Missing/invalid surfaceMode is the validity gate.
    expect(parseNavState(JSON.stringify({ selectedFocusId: 'focus-1' }))).toBeNull();
    expect(parseNavState(JSON.stringify({ surfaceMode: 'nope' }))).toBeNull();
  });

  it('coerces wrong-typed fields to safe defaults', () => {
    const parsed = parseNavState(
      JSON.stringify({ surfaceMode: 'dashboard', selectedFocusId: 42, collapsedProjectIds: 'x' }),
    );
    expect(parsed).toEqual({
      selectedProjectId: null,
      selectedFocusId: null,
      selectedSessionId: null,
      surfaceMode: 'dashboard',
      collapsedProjectIds: [],
      expandedFocusIds: [],
      generalCollapsed: false,
    });
  });
});

describe('reconcilePersistedView', () => {
  it('soft reload restores the full view, including the terminal surface', () => {
    const view = reconcilePersistedView(makeView(), makeShell(), { isSoftReload: true });
    expect(view).toMatchObject({
      selectedFocusId: 'focus-1',
      selectedSessionId: 'session-1',
      surfaceMode: 'terminal',
    });
  });

  it('cold open keeps the focus but lands on the dashboard with no session selected', () => {
    // The session selection belongs to the terminal surface; carrying it onto the
    // dashboard would get cleared by a reconcile effect and persisted as a null,
    // wiping the saved session. So cold open restores the focus only.
    const view = reconcilePersistedView(makeView(), makeShell(), { isSoftReload: false });
    expect(view).toMatchObject({
      selectedFocusId: 'focus-1',
      selectedSessionId: null,
      surfaceMode: 'dashboard',
    });
  });

  it('drops the session selection on any non-terminal surface (soft reload into history)', () => {
    const view = reconcilePersistedView(makeView({ surfaceMode: 'session-history' }), makeShell(), {
      isSoftReload: true,
    });
    expect(view.surfaceMode).toBe('session-history');
    expect(view.selectedFocusId).toBe('focus-1');
    expect(view.selectedSessionId).toBeNull();
  });

  it('derives the project from the restored focus, ignoring a stale stored project', () => {
    const shell = makeShell({ focuses: [makeFocus({ projectId: 'project-2' })] });
    const view = reconcilePersistedView(
      makeView({ selectedProjectId: 'project-1', selectedSessionId: null }),
      shell,
      { isSoftReload: true },
    );
    expect(view.selectedProjectId).toBe('project-2');
  });

  it('drops a selection whose focus was archived or removed, falling back off the terminal', () => {
    const shell = makeShell({ focuses: [makeFocus({ archived: true })] });
    const view = reconcilePersistedView(makeView(), shell, { isSoftReload: true });
    expect(view.selectedFocusId).toBeNull();
    expect(view.selectedSessionId).toBeNull();
    // No valid session means the terminal surface would be empty: fall back.
    expect(view.surfaceMode).toBe('dashboard');
  });

  it('drops a session that no longer belongs to the focus', () => {
    const shell = makeShell({ sessions: [makeSession({ focusId: 'other-focus' })] });
    const view = reconcilePersistedView(makeView(), shell, { isSoftReload: true });
    expect(view.selectedFocusId).toBe('focus-1');
    expect(view.selectedSessionId).toBeNull();
    expect(view.surfaceMode).toBe('dashboard');
  });

  it('prunes accordion ids to entities that still exist', () => {
    const view = reconcilePersistedView(
      makeView({
        collapsedProjectIds: ['project-1', 'gone-project'],
        expandedFocusIds: ['focus-1', 'gone-focus'],
      }),
      makeShell(),
      { isSoftReload: true },
    );
    expect(view.collapsedProjectIds).toEqual(['project-1']);
    expect(view.expandedFocusIds).toEqual(['focus-1']);
  });
});
