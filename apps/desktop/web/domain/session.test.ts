import { describe, it, expect } from 'vitest';

import {
  agentLabel,
  agentTabLabel,
  dangerousLabel,
  fallbackAgentCliDetections,
  fallbackShellSnapshot,
  launchButtonLabel,
  nativeSessionSummary,
  sessionBreadcrumb,
  sessionsForProject,
} from './session';
import type { ShellFocus, ShellProject, ShellSession, WorkspaceShellSnapshot } from './types';

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
      defaultNewSessionDangerous: false,
      theme: 'dark',
      defaultAgentKind: 'cortex_code',
    },
    projects: [],
    focuses: [],
    sessions: [],
    ...overrides,
  };
}

describe('fallbackShellSnapshot', () => {
  it('returns a well-shaped empty snapshot', () => {
    const shell = fallbackShellSnapshot();
    expect(shell.workspace).toMatchObject({
      id: 'fallback-workspace',
      name: 'Local workspace',
      generalLabel: 'General',
      defaultDangerousMode: false,
    });
    expect(shell.projects).toEqual([]);
    expect(shell.focuses).toEqual([]);
    expect(shell.sessions).toEqual([]);
  });
});

describe('fallbackAgentCliDetections', () => {
  it('lists the three known agent CLIs, all available', () => {
    const detections = fallbackAgentCliDetections();
    expect(detections.map(d => d.kind)).toEqual(['cortex_code', 'claude_code', 'codex_cli']);
    for (const detection of detections) {
      expect(detection.available).toBe(true);
      expect(detection.displayName.length).toBeGreaterThan(0);
      expect(typeof detection.executable).toBe('string');
      expect(detection.candidates.length).toBeGreaterThan(0);
    }
  });
});

describe('sessionsForProject', () => {
  it('returns sessions whose focus belongs to the project', () => {
    const shell = makeShell({
      projects: [makeProject(), makeProject({ id: 'project-2', name: 'Other' })],
      focuses: [
        makeFocus({ id: 'f1', projectId: 'project-1' }),
        makeFocus({ id: 'f2', projectId: 'project-2' }),
      ],
      sessions: [
        makeSession({ id: 's1', focusId: 'f1' }),
        makeSession({ id: 's2', focusId: 'f2' }),
        makeSession({ id: 's3', focusId: 'f1' }),
      ],
    });
    const result = sessionsForProject('project-1', shell);
    expect(result.map(s => s.id).sort()).toEqual(['s1', 's3']);
  });

  it('treats projectId null as the General bucket', () => {
    const shell = makeShell({
      focuses: [
        makeFocus({ id: 'general', projectId: null }),
        makeFocus({ id: 'proj', projectId: 'project-1' }),
      ],
      sessions: [
        makeSession({ id: 's-general', focusId: 'general' }),
        makeSession({ id: 's-proj', focusId: 'proj' }),
      ],
    });
    const result = sessionsForProject(null, shell);
    expect(result.map(s => s.id)).toEqual(['s-general']);
  });

  it('returns nothing for a project with no focuses', () => {
    const shell = makeShell({ focuses: [], sessions: [makeSession()] });
    expect(sessionsForProject('project-1', shell)).toEqual([]);
  });
});

describe('sessionBreadcrumb', () => {
  it('returns Workspace when the session focus is missing', () => {
    const shell = makeShell({ focuses: [] });
    expect(sessionBreadcrumb(makeSession({ focusId: 'gone' }), shell)).toBe('Workspace');
  });

  it('returns the focus title when the focus has no project', () => {
    const shell = makeShell({ focuses: [makeFocus({ id: 'f', projectId: null, title: 'Notes' })] });
    expect(sessionBreadcrumb(makeSession({ focusId: 'f' }), shell)).toBe('Notes');
  });

  it('returns "Project · Title" when the project resolves', () => {
    const shell = makeShell({
      projects: [makeProject({ id: 'p', name: 'Reverie' })],
      focuses: [makeFocus({ id: 'f', projectId: 'p', title: 'Terminal' })],
    });
    expect(sessionBreadcrumb(makeSession({ focusId: 'f' }), shell)).toBe('Reverie · Terminal');
  });

  it('falls back to the focus title when the project id does not resolve', () => {
    const shell = makeShell({
      projects: [],
      focuses: [makeFocus({ id: 'f', projectId: 'ghost', title: 'Terminal' })],
    });
    expect(sessionBreadcrumb(makeSession({ focusId: 'f' }), shell)).toBe('Terminal');
  });
});

describe('agentLabel', () => {
  it('converts snake_case to Title Case', () => {
    expect(agentLabel('claude_code')).toBe('Claude Code');
    expect(agentLabel('codex_cli')).toBe('Codex Cli');
    expect(agentLabel('cortex_code')).toBe('Cortex Code');
  });

  it('capitalizes a single word', () => {
    expect(agentLabel('claude')).toBe('Claude');
  });

  it('returns an empty string unchanged', () => {
    expect(agentLabel('')).toBe('');
  });
});

describe('agentTabLabel', () => {
  it('uses the trimmed session title when present', () => {
    expect(agentTabLabel(makeSession({ title: '  My Session  ' }))).toBe('My Session');
  });

  it('falls back per agent kind when the title is blank', () => {
    expect(agentTabLabel(makeSession({ title: '   ', agentKind: 'claude_code' }))).toBe(
      'Claude Code',
    );
    expect(agentTabLabel(makeSession({ title: '', agentKind: 'codex_cli' }))).toBe('Codex');
    expect(agentTabLabel(makeSession({ title: '', agentKind: 'cortex_code' }))).toBe('Cortex');
  });

  it('falls back to Session for an unknown agent kind with a blank title', () => {
    expect(agentTabLabel(makeSession({ title: '', agentKind: 'mystery_cli' }))).toBe('Session');
  });
});

describe('nativeSessionSummary', () => {
  it('returns null for a null session', () => {
    expect(nativeSessionSummary(null)).toBeNull();
  });

  it('returns null when there is no native session id', () => {
    expect(nativeSessionSummary(makeSession({ nativeSessionRef: null }))).toBeNull();
    expect(
      nativeSessionSummary(
        makeSession({ nativeSessionRef: { kind: 'claude_code', sessionId: null } }),
      ),
    ).toBeNull();
  });

  it('summarizes the native kind and short id', () => {
    const session = makeSession({
      nativeSessionRef: { kind: 'claude_code', sessionId: '0123456789abcdef' },
    });
    expect(nativeSessionSummary(session)).toBe('Claude Code 01234567');
  });
});

describe('launchButtonLabel', () => {
  it('returns "Retry resume" for a restore_failed session', () => {
    expect(launchButtonLabel(makeSession({ status: 'restore_failed' }))).toBe('Retry resume');
  });

  it('returns "Resume" for resume launch mode', () => {
    expect(launchButtonLabel(makeSession({ launchMode: 'resume' }))).toBe('Resume');
  });

  it('returns "Resume" when there is a native session ref', () => {
    const session = makeSession({
      launchMode: 'new',
      nativeSessionRef: { kind: 'claude_code', sessionId: 'n1' },
    });
    expect(launchButtonLabel(session)).toBe('Resume');
  });

  it('returns "Run" for a fresh new session', () => {
    expect(launchButtonLabel(makeSession({ launchMode: 'new', nativeSessionRef: null }))).toBe(
      'Run',
    );
  });
});

describe('dangerousLabel', () => {
  it('uses the session override when set', () => {
    expect(dangerousLabel(makeSession({ dangerousModeOverride: true }), false)).toBe(
      'Explicitly enabled',
    );
    expect(dangerousLabel(makeSession({ dangerousModeOverride: false }), true)).toBe('Off');
  });

  it('falls back to the workspace default when there is no override', () => {
    expect(dangerousLabel(makeSession({ dangerousModeOverride: null }), true)).toBe(
      'Explicitly enabled',
    );
    expect(dangerousLabel(makeSession({ dangerousModeOverride: null }), false)).toBe('Off');
  });

  it('falls back to the workspace default for a null session', () => {
    expect(dangerousLabel(null, true)).toBe('Explicitly enabled');
    expect(dangerousLabel(null, false)).toBe('Off');
  });
});
