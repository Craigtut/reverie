import { describe, it, expect } from 'vitest';

import { buildPaletteEntries, filterPalette, paletteHaystack } from './palette';
import type {
  ActivityState,
  PaletteEntry,
  ShellFocus,
  ShellProject,
  ShellSession,
  WorkspaceShellSnapshot,
} from './types';

function makeProject(overrides: Partial<ShellProject> = {}): ShellProject {
  return {
    id: 'project-1',
    name: 'Reverie',
    path: '/Users/user/Code/reverie',
    archived: false,
    ...overrides,
  };
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
    cwd: '/Users/user/Code/reverie',
    nativeSessionRef: null,
    launchMode: 'new',
    dangerousModeOverride: null,
    status: 'running',
    tabVisible: true,
    ...overrides,
  };
}

function makeActivity(overrides: Partial<ActivityState> = {}): ActivityState {
  return {
    version: 1,
    sessionId: 'native-1',
    status: 'working',
    updatedAt: '2026-05-28T00:00:00.000Z',
    sequence: 1,
    cwd: '/Users/user/Code/reverie',
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
    },
    projects: [],
    focuses: [],
    sessions: [],
    ...overrides,
  };
}

describe('buildPaletteEntries', () => {
  it('builds a focus entry and a session entry for an active focus', () => {
    const shell = makeShell({
      projects: [makeProject()],
      focuses: [makeFocus()],
      sessions: [makeSession()],
    });
    const entries = buildPaletteEntries(shell, {});
    expect(entries).toHaveLength(2);

    const focusEntry = entries.find(e => e.kind === 'focus');
    expect(focusEntry).toMatchObject({
      kind: 'focus',
      id: 'focus-1',
      title: 'Terminal work',
      projectId: 'project-1',
      projectName: 'Reverie',
      sessionCount: 1,
    });

    const sessionEntry = entries.find(e => e.kind === 'session');
    expect(sessionEntry).toMatchObject({
      kind: 'session',
      breadcrumb: 'Reverie · Terminal work',
      activity: null,
    });
  });

  it('skips archived focuses', () => {
    const shell = makeShell({
      projects: [makeProject()],
      focuses: [makeFocus({ archived: true })],
      sessions: [],
    });
    expect(buildPaletteEntries(shell, {})).toHaveLength(0);
  });

  it('skips focuses whose project is archived', () => {
    const shell = makeShell({
      projects: [makeProject({ archived: true })],
      focuses: [makeFocus()],
      sessions: [],
    });
    expect(buildPaletteEntries(shell, {})).toHaveLength(0);
  });

  it('builds a project-less focus entry with a null project name and a bare breadcrumb', () => {
    const shell = makeShell({
      projects: [],
      focuses: [makeFocus({ projectId: null })],
      sessions: [makeSession()],
    });
    const entries = buildPaletteEntries(shell, {});
    const focusEntry = entries.find(e => e.kind === 'focus');
    expect(focusEntry).toMatchObject({ projectId: null, projectName: null });
    const sessionEntry = entries.find(e => e.kind === 'session');
    expect(sessionEntry && sessionEntry.kind === 'session' ? sessionEntry.breadcrumb : null).toBe('Terminal work');
  });

  it('excludes hidden sessions (tabVisible === false) from session entries', () => {
    const shell = makeShell({
      projects: [makeProject()],
      focuses: [makeFocus()],
      sessions: [makeSession({ id: 'visible' }), makeSession({ id: 'hidden', tabVisible: false })],
    });
    const sessionEntries = buildPaletteEntries(shell, {}).filter(e => e.kind === 'session');
    expect(sessionEntries).toHaveLength(1);
    expect(sessionEntries[0].kind === 'session' && sessionEntries[0].session.id).toBe('visible');
  });

  it('counts only visible sessions in a focus sessionCount', () => {
    const shell = makeShell({
      projects: [makeProject()],
      focuses: [makeFocus()],
      sessions: [
        makeSession({ id: 'a' }),
        makeSession({ id: 'b' }),
        makeSession({ id: 'hidden', tabVisible: false }),
      ],
    });
    const focusEntry = buildPaletteEntries(shell, {}).find(e => e.kind === 'focus');
    expect(focusEntry && focusEntry.kind === 'focus' ? focusEntry.sessionCount : null).toBe(2);
  });

  it('skips sessions whose focus is missing', () => {
    const shell = makeShell({
      projects: [makeProject()],
      focuses: [],
      sessions: [makeSession({ focusId: 'orphan' })],
    });
    expect(buildPaletteEntries(shell, {})).toHaveLength(0);
  });

  it('attaches activity by nativeSessionRef.sessionId', () => {
    const shell = makeShell({
      projects: [makeProject()],
      focuses: [makeFocus()],
      sessions: [makeSession({ nativeSessionRef: { kind: 'claude_code', sessionId: 'native-1' } })],
    });
    const activity = makeActivity({ sessionId: 'native-1' });
    const entries = buildPaletteEntries(shell, { 'native-1': activity });
    const sessionEntry = entries.find(e => e.kind === 'session');
    expect(sessionEntry && sessionEntry.kind === 'session' ? sessionEntry.activity : null).toBe(activity);
  });

  it('leaves activity null when there is no matching native session id', () => {
    const shell = makeShell({
      projects: [makeProject()],
      focuses: [makeFocus()],
      sessions: [makeSession({ nativeSessionRef: { kind: 'claude_code', sessionId: 'unknown' } })],
    });
    const entries = buildPaletteEntries(shell, { 'native-1': makeActivity() });
    const sessionEntry = entries.find(e => e.kind === 'session');
    expect(sessionEntry && sessionEntry.kind === 'session' ? sessionEntry.activity : 'sentinel').toBeNull();
  });
});

describe('paletteHaystack', () => {
  it('lowercases focus title and project name', () => {
    const entry: PaletteEntry = {
      kind: 'focus',
      id: 'f',
      title: 'Terminal Work',
      projectId: 'p',
      projectName: 'Reverie',
      sessionCount: 0,
    };
    expect(paletteHaystack(entry)).toBe('terminal work reverie');
  });

  it('omits a null project name', () => {
    const entry: PaletteEntry = {
      kind: 'focus',
      id: 'f',
      title: 'General Notes',
      projectId: null,
      projectName: null,
      sessionCount: 0,
    };
    expect(paletteHaystack(entry)).toBe('general notes');
  });

  it('combines session title, breadcrumb, cwd, and agent kind', () => {
    const entry: PaletteEntry = {
      kind: 'session',
      session: makeSession({ title: 'My Session', cwd: '/tmp/X', agentKind: 'codex_cli' }),
      breadcrumb: 'Reverie · Focus',
      activity: null,
    };
    expect(paletteHaystack(entry)).toBe('my session reverie · focus /tmp/x codex_cli');
  });
});

describe('filterPalette', () => {
  it('returns the first 25 entries for an empty query', () => {
    const entries: PaletteEntry[] = Array.from({ length: 40 }, (_, i) => ({
      kind: 'focus',
      id: `f-${i}`,
      title: `Focus ${i}`,
      projectId: null,
      projectName: null,
      sessionCount: 0,
    }));
    const result = filterPalette(entries, '');
    expect(result).toHaveLength(25);
    expect(result[0].kind === 'focus' && result[0].id).toBe('f-0');
  });

  it('treats a whitespace-only query as empty', () => {
    const entries: PaletteEntry[] = [
      { kind: 'focus', id: 'f', title: 'Alpha', projectId: null, projectName: null, sessionCount: 0 },
    ];
    expect(filterPalette(entries, '   ')).toHaveLength(1);
  });

  it('matches substrings case-insensitively across all haystack fields', () => {
    const entries: PaletteEntry[] = [
      { kind: 'focus', id: 'f1', title: 'Terminal work', projectId: null, projectName: null, sessionCount: 0 },
      {
        kind: 'session',
        session: makeSession({ title: 'Codex run', agentKind: 'codex_cli', cwd: '/srv/api' }),
        breadcrumb: 'Reverie · API',
        activity: null,
      },
    ];

    // Title match
    expect(filterPalette(entries, 'TERMINAL')).toHaveLength(1);
    // agentKind match
    expect(filterPalette(entries, 'codex_cli').map(e => e.kind)).toEqual(['session']);
    // cwd match
    expect(filterPalette(entries, '/srv/api').map(e => e.kind)).toEqual(['session']);
    // breadcrumb match
    expect(filterPalette(entries, 'reverie · api').map(e => e.kind)).toEqual(['session']);
    // no match
    expect(filterPalette(entries, 'zzz')).toHaveLength(0);
  });

  it('caps matched results at 25', () => {
    const entries: PaletteEntry[] = Array.from({ length: 60 }, (_, i) => ({
      kind: 'focus',
      id: `f-${i}`,
      title: 'match me',
      projectId: null,
      projectName: null,
      sessionCount: 0,
    }));
    expect(filterPalette(entries, 'match')).toHaveLength(25);
  });
});
