import { describe, it, expect } from 'vitest';

import {
  activityForSession,
  classifyForDashboard,
  dashboardToneForState,
  deriveSessionState,
  glyphStateFor,
  groupSessionsByState,
  plainLanguageStatus,
  statusDotColor,
} from './activity';
import type { ActivityError, ActivityState, SessionTerminalBinding, ShellSession } from './types';

function makeSession(overrides: Partial<ShellSession> = {}): ShellSession {
  return {
    id: 'session-1',
    focusId: 'focus-1',
    title: 'Session',
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

function nonRecoverableError(): ActivityError {
  return {
    category: 'authentication',
    message: 'auth failed',
    recoverable: false,
    occurredAt: '2026-05-28T00:00:00.000Z',
  };
}

function recoverableError(): ActivityError {
  return {
    category: 'rate_limit',
    message: 'slow down',
    recoverable: true,
    occurredAt: '2026-05-28T00:00:00.000Z',
  };
}

describe('activityForSession', () => {
  it('returns null when the session has no nativeSessionRef', () => {
    expect(activityForSession(makeSession(), { 'native-1': makeActivity() })).toBeNull();
  });

  it('returns null when nativeSessionRef has no sessionId', () => {
    const session = makeSession({ nativeSessionRef: { kind: 'claude_code', sessionId: null } });
    expect(activityForSession(session, { 'native-1': makeActivity() })).toBeNull();
  });

  it('returns the activity for a matching native session id', () => {
    const session = makeSession({
      nativeSessionRef: { kind: 'claude_code', sessionId: 'native-1' },
    });
    const activity = makeActivity();
    expect(activityForSession(session, { 'native-1': activity })).toBe(activity);
  });

  it('returns null on a lookup miss', () => {
    const session = makeSession({
      nativeSessionRef: { kind: 'claude_code', sessionId: 'missing' },
    });
    expect(activityForSession(session, { 'native-1': makeActivity() })).toBeNull();
  });
});

describe('classifyForDashboard', () => {
  describe('with live activity', () => {
    it('classifies awaiting_permission as attention', () => {
      expect(
        classifyForDashboard(makeSession(), false, makeActivity({ status: 'awaiting_permission' })),
      ).toBe('attention');
    });

    it('classifies a non-recoverable error as attention', () => {
      const activity = makeActivity({ status: 'error', lastError: nonRecoverableError() });
      expect(classifyForDashboard(makeSession(), true, activity)).toBe('attention');
    });

    it('treats a non-recoverable error as attention even while working', () => {
      const activity = makeActivity({ status: 'working', lastError: nonRecoverableError() });
      expect(classifyForDashboard(makeSession(), true, activity)).toBe('attention');
    });

    it('classifies working as live', () => {
      expect(classifyForDashboard(makeSession(), false, makeActivity({ status: 'working' }))).toBe(
        'live',
      );
    });

    it('classifies awaiting_input as live when bound', () => {
      expect(
        classifyForDashboard(makeSession(), true, makeActivity({ status: 'awaiting_input' })),
      ).toBe('live');
    });

    it('classifies awaiting_input as recent when not bound', () => {
      expect(
        classifyForDashboard(makeSession(), false, makeActivity({ status: 'awaiting_input' })),
      ).toBe('recent');
    });

    it('classifies done as recent', () => {
      expect(classifyForDashboard(makeSession(), true, makeActivity({ status: 'done' }))).toBe(
        'recent',
      );
    });

    it('classifies a recoverable error as recent', () => {
      const activity = makeActivity({ status: 'error', lastError: recoverableError() });
      expect(classifyForDashboard(makeSession(), true, activity)).toBe('recent');
    });
  });

  describe('without activity (record fallback)', () => {
    it('classifies restore_failed as attention', () => {
      expect(classifyForDashboard(makeSession({ status: 'restore_failed' }), false, null)).toBe(
        'attention',
      );
    });

    it('classifies running as live', () => {
      expect(classifyForDashboard(makeSession({ status: 'running' }), false, null)).toBe('live');
    });

    it('classifies a bound session as live', () => {
      expect(classifyForDashboard(makeSession({ status: 'not_started' }), true, null)).toBe('live');
    });

    it('falls back to recent otherwise', () => {
      expect(classifyForDashboard(makeSession({ status: 'restorable' }), false, null)).toBe(
        'recent',
      );
      expect(classifyForDashboard(makeSession({ status: 'not_started' }), false, null)).toBe(
        'recent',
      );
    });
  });
});

describe('deriveSessionState', () => {
  it('routes awaiting-permission and unrecoverable errors to attention', () => {
    expect(
      deriveSessionState(makeSession(), false, makeActivity({ status: 'awaiting_permission' })),
    ).toBe('attention');
    expect(
      deriveSessionState(
        makeSession(),
        true,
        makeActivity({ status: 'error', lastError: nonRecoverableError() }),
      ),
    ).toBe('attention');
  });

  it('routes only a working signal to active', () => {
    expect(deriveSessionState(makeSession(), false, makeActivity({ status: 'working' }))).toBe(
      'active',
    );
  });

  it('routes awaiting-input, done, and recoverable errors to idle', () => {
    expect(
      deriveSessionState(makeSession(), true, makeActivity({ status: 'awaiting_input' })),
    ).toBe('idle');
    expect(deriveSessionState(makeSession(), false, makeActivity({ status: 'done' }))).toBe('idle');
    expect(
      deriveSessionState(
        makeSession(),
        false,
        makeActivity({ status: 'error', lastError: recoverableError() }),
      ),
    ).toBe('idle');
  });

  describe('without activity (record fallback)', () => {
    it('routes restore_failed to attention', () => {
      expect(deriveSessionState(makeSession({ status: 'restore_failed' }), false, null)).toBe(
        'attention',
      );
    });

    it('routes a running or bound session to idle, not active (no working signal)', () => {
      expect(deriveSessionState(makeSession({ status: 'running' }), false, null)).toBe('idle');
      expect(deriveSessionState(makeSession({ status: 'not_started' }), true, null)).toBe('idle');
    });

    it('routes a never-launched session to fresh', () => {
      expect(deriveSessionState(makeSession({ status: 'not_started' }), false, null)).toBe('fresh');
    });

    it('routes an exited or resumable session to idle (open resumes it transparently)', () => {
      expect(deriveSessionState(makeSession({ status: 'restorable' }), false, null)).toBe('idle');
      expect(deriveSessionState(makeSession({ status: 'exited' }), false, null)).toBe('idle');
    });
  });
});

describe('dashboardToneForState', () => {
  it('maps states to card tones', () => {
    expect(dashboardToneForState('attention')).toBe('attention');
    expect(dashboardToneForState('active')).toBe('live');
    expect(dashboardToneForState('idle')).toBe('recent');
    expect(dashboardToneForState('fresh')).toBe('recent');
  });
});

describe('groupSessionsByState', () => {
  it('partitions sessions into the state buckets', () => {
    const running = makeSession({ id: 'a', status: 'running' }); // no feed -> idle
    const fresh = makeSession({ id: 'b', status: 'not_started' });
    const resumable = makeSession({ id: 'c', status: 'restorable' }); // exited but resumable -> idle
    const failed = makeSession({ id: 'd', status: 'restore_failed' });
    const bindings: Record<string, SessionTerminalBinding> = {};
    const groups = groupSessionsByState([running, fresh, resumable, failed], bindings, {});
    expect(groups.idle.map(s => s.id)).toEqual(['a', 'c']);
    expect(groups.fresh.map(s => s.id)).toEqual(['b']);
    expect(groups.attention.map(s => s.id)).toEqual(['d']);
    expect(groups.active).toHaveLength(0);
  });

  it('puts a session with a live working signal in active', () => {
    const session = makeSession({
      id: 'x',
      nativeSessionRef: { kind: 'claude_code', sessionId: 'n1' },
    });
    const groups = groupSessionsByState([session], {}, { n1: makeActivity({ status: 'working' }) });
    expect(groups.active.map(s => s.id)).toEqual(['x']);
    expect(groups.idle).toHaveLength(0);
  });
});

describe('plainLanguageStatus', () => {
  describe('with live activity', () => {
    it('reports awaiting_permission', () => {
      expect(
        plainLanguageStatus(makeSession(), false, makeActivity({ status: 'awaiting_permission' })),
      ).toBe('Needs your approval');
    });

    it('prefers a tool displaySummary while working', () => {
      const activity = makeActivity({
        status: 'working',
        activeTools: [
          { toolCallId: 't1', toolName: 'bash', startedAt: 'now', displaySummary: 'Running tests' },
        ],
      });
      expect(plainLanguageStatus(makeSession(), true, activity)).toBe('Running tests');
    });

    it('falls back to the tool name while working without a summary', () => {
      const activity = makeActivity({
        status: 'working',
        activeTools: [
          { toolCallId: 't1', toolName: 'bash', startedAt: 'now', displaySummary: null },
        ],
      });
      expect(plainLanguageStatus(makeSession(), true, activity)).toBe('Running bash');
    });

    it('reports a generic Working when there is no active tool', () => {
      expect(
        plainLanguageStatus(
          makeSession(),
          true,
          makeActivity({ status: 'working', activeTools: [] }),
        ),
      ).toBe('Working');
      expect(plainLanguageStatus(makeSession(), true, makeActivity({ status: 'working' }))).toBe(
        'Working',
      );
    });

    it('reports awaiting_input as waiting, regardless of bound state', () => {
      expect(
        plainLanguageStatus(makeSession(), true, makeActivity({ status: 'awaiting_input' })),
      ).toBe('Waiting for you');
      expect(
        plainLanguageStatus(makeSession(), false, makeActivity({ status: 'awaiting_input' })),
      ).toBe('Waiting for you');
    });

    it('reports done as waiting for you, never "Ended"', () => {
      expect(plainLanguageStatus(makeSession(), true, makeActivity({ status: 'done' }))).toBe(
        'Waiting for you',
      );
    });

    it('distinguishes recovered and unrecovered errors', () => {
      expect(
        plainLanguageStatus(
          makeSession(),
          true,
          makeActivity({ status: 'error', lastError: recoverableError() }),
        ),
      ).toBe('Recovered from error');
      expect(
        plainLanguageStatus(
          makeSession(),
          true,
          makeActivity({ status: 'error', lastError: nonRecoverableError() }),
        ),
      ).toBe('Errored');
      expect(
        plainLanguageStatus(
          makeSession(),
          true,
          makeActivity({ status: 'error', lastError: null }),
        ),
      ).toBe('Errored');
    });
  });

  describe('without activity (record fallback)', () => {
    it('reports restore_failed as needing attention', () => {
      expect(plainLanguageStatus(makeSession({ status: 'restore_failed' }), false, null)).toBe(
        'Needs your attention',
      );
    });

    it('reports running, resumable, and exited sessions all as "Waiting for you"', () => {
      expect(plainLanguageStatus(makeSession({ status: 'running' }), false, null)).toBe(
        'Waiting for you',
      );
      expect(plainLanguageStatus(makeSession({ status: 'not_started' }), true, null)).toBe(
        'Waiting for you',
      );
      expect(plainLanguageStatus(makeSession({ status: 'restorable' }), false, null)).toBe(
        'Waiting for you',
      );
      const withNative = makeSession({
        status: 'not_started',
        nativeSessionRef: { kind: 'claude_code', sessionId: 'n1' },
      });
      expect(plainLanguageStatus(withNative, false, null)).toBe('Waiting for you');
      expect(plainLanguageStatus(makeSession({ status: 'exited' }), false, null)).toBe(
        'Waiting for you',
      );
    });

    it('reports a never-launched session as "Ready to start"', () => {
      expect(plainLanguageStatus(makeSession({ status: 'not_started' }), false, null)).toBe(
        'Ready to start',
      );
    });
  });
});

describe('statusDotColor', () => {
  it('maps each tone to its CSS variable', () => {
    expect(statusDotColor('attention')).toBe('var(--warn)');
    expect(statusDotColor('live')).toBe('var(--good)');
    expect(statusDotColor('recent')).toBe('var(--text-4)');
  });
});

describe('glyphStateFor', () => {
  it('returns working when the activity is working', () => {
    expect(glyphStateFor(makeActivity({ status: 'working' }), 'live')).toBe('working');
  });

  it('returns attention when awaiting permission', () => {
    expect(glyphStateFor(makeActivity({ status: 'awaiting_permission' }), 'recent')).toBe(
      'attention',
    );
  });

  it('returns attention when the tone is attention even without activity', () => {
    expect(glyphStateFor(null, 'attention')).toBe('attention');
  });

  it('returns error for a non-recoverable error activity', () => {
    expect(
      glyphStateFor(makeActivity({ status: 'error', lastError: nonRecoverableError() }), 'recent'),
    ).toBe('error');
  });

  it('returns idle for a recoverable error activity', () => {
    expect(
      glyphStateFor(makeActivity({ status: 'error', lastError: recoverableError() }), 'recent'),
    ).toBe('idle');
  });

  it('returns idle when there is no activity and the tone is not attention', () => {
    expect(glyphStateFor(null, 'live')).toBe('idle');
    expect(glyphStateFor(null, 'recent')).toBe('idle');
  });

  it('returns idle for done/awaiting_input activity in a non-attention tone', () => {
    expect(glyphStateFor(makeActivity({ status: 'done' }), 'recent')).toBe('idle');
    expect(glyphStateFor(makeActivity({ status: 'awaiting_input' }), 'live')).toBe('idle');
  });
});
