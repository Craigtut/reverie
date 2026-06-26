import { describe, expect, it } from 'vitest';

import { deriveActiveTerminalClaim, isTerminalSessionDisplayed } from './terminalClaim';
import type { SessionTerminalBinding } from './types';

const binding: SessionTerminalBinding = { terminalId: 'term-1', inputArmed: true };

describe('deriveActiveTerminalClaim', () => {
  it('claims the displayed session terminal when it is bound on the terminal surface', () => {
    expect(
      deriveActiveTerminalClaim({
        surfaceMode: 'terminal',
        creationMode: null,
        selectedSessionId: 'sess-1',
        binding,
      }),
    ).toEqual({ terminalId: 'term-1', inputArmed: true });
  });

  it('releases the claim when no session is selected', () => {
    expect(
      deriveActiveTerminalClaim({
        surfaceMode: 'terminal',
        creationMode: null,
        selectedSessionId: null,
        binding: undefined,
      }),
    ).toEqual({ terminalId: null, inputArmed: false });
  });

  it('releases the claim on a non-terminal surface even while a session stays selected', () => {
    // The exact storm trigger: navigating to a dashboard unmounts the terminal but
    // leaves the session selected; the claim must drop so its stream stops painting
    // as active against the unmounted canvas.
    for (const surfaceMode of [
      'dashboard',
      'project-dashboard',
      'settings',
      'session-history',
    ] as const) {
      expect(
        deriveActiveTerminalClaim({
          surfaceMode,
          creationMode: null,
          selectedSessionId: 'sess-1',
          binding,
        }),
      ).toEqual({ terminalId: null, inputArmed: false });
    }
  });

  it('releases the claim while a creation composer is open over the terminal', () => {
    expect(
      deriveActiveTerminalClaim({
        surfaceMode: 'terminal',
        creationMode: 'session',
        selectedSessionId: 'sess-1',
        binding,
      }),
    ).toEqual({ terminalId: null, inputArmed: false });
  });

  it('claims with input disarmed when the displayed session has not armed yet', () => {
    expect(
      deriveActiveTerminalClaim({
        surfaceMode: 'terminal',
        creationMode: null,
        selectedSessionId: 'sess-1',
        binding: { terminalId: 'term-2', inputArmed: false },
      }),
    ).toEqual({ terminalId: 'term-2', inputArmed: false });
  });

  it('releases the claim when the displayed session has no live terminal binding', () => {
    expect(
      deriveActiveTerminalClaim({
        surfaceMode: 'terminal',
        creationMode: null,
        selectedSessionId: 'sess-1',
        binding: null,
      }),
    ).toEqual({ terminalId: null, inputArmed: false });
  });
});

describe('isTerminalSessionDisplayed', () => {
  it('is true only on the terminal surface with a selected session and no composer', () => {
    expect(
      isTerminalSessionDisplayed({
        surfaceMode: 'terminal',
        creationMode: null,
        selectedSessionId: 'sess-1',
      }),
    ).toBe(true);
    expect(
      isTerminalSessionDisplayed({
        surfaceMode: 'terminal',
        creationMode: 'session',
        selectedSessionId: 'sess-1',
      }),
    ).toBe(false);
    expect(
      isTerminalSessionDisplayed({
        surfaceMode: 'dashboard',
        creationMode: null,
        selectedSessionId: 'sess-1',
      }),
    ).toBe(false);
  });
});
