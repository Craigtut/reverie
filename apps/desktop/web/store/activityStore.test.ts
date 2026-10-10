import { beforeEach, describe, expect, it } from 'vitest';

import type { ActivityState, SessionActivityEventPayload } from '../domain';
import { useActivityStore } from './activityStore';

function event(sequence: number, status: ActivityState['status']): SessionActivityEventPayload {
  return {
    kind: 'updated',
    payload: {
      source: 'codex_cli',
      nativeSessionId: 'native',
      state: {
        version: 1,
        sessionId: 'native',
        status,
        sequence,
        updatedAt: `2026-10-10T12:00:0${sequence}.000Z`,
        cwd: '/tmp',
      },
      stateTimeline: { restingSince: `2026-10-10T12:00:0${sequence}.000Z` },
    },
  };
}

describe('activity event ingestion', () => {
  beforeEach(() => {
    useActivityStore.setState({ cortexActivity: {}, sessionTimelines: {} });
  });

  it('rejects a stale event and its timeline together', () => {
    const { applyActivityEvent } = useActivityStore.getState();
    applyActivityEvent(event(3, 'awaiting_input'));
    const accepted = useActivityStore.getState();
    applyActivityEvent(event(2, 'working'));
    expect(useActivityStore.getState()).toBe(accepted);
    expect(accepted.cortexActivity.native.status).toBe('awaiting_input');
    expect(accepted.sessionTimelines.native.restingSince).toBe('2026-10-10T12:00:03.000Z');
  });

  it('removes activity and timeline together', () => {
    const { applyActivityEvent } = useActivityStore.getState();
    applyActivityEvent(event(1, 'working'));
    applyActivityEvent({
      kind: 'removed',
      payload: { source: 'codex_cli', nativeSessionId: 'native' },
    });
    expect(useActivityStore.getState().cortexActivity).toEqual({});
    expect(useActivityStore.getState().sessionTimelines).toEqual({});
  });
});
