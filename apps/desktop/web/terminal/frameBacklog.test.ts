import { describe, expect, it } from 'vitest';

import { MAX_PENDING_TERMINAL_FRAMES, terminalFrameBacklogAction } from './frameBacklog';

describe('terminal frame backlog', () => {
  it('requests a resync instead of queueing frames while the page is inactive', () => {
    expect(
      terminalFrameBacklogAction({
        pageActive: false,
        awaitingFull: false,
        isFull: false,
        pendingCount: 0,
      }),
    ).toBe('resync');
  });

  it('bounds the pending rAF queue', () => {
    expect(
      terminalFrameBacklogAction({
        pageActive: true,
        awaitingFull: false,
        isFull: false,
        pendingCount: MAX_PENDING_TERMINAL_FRAMES,
      }),
    ).toBe('resync');
  });

  it('drops diffs until a full seed restores a safe baseline', () => {
    expect(
      terminalFrameBacklogAction({
        pageActive: true,
        awaitingFull: true,
        isFull: false,
        pendingCount: 0,
      }),
    ).toBe('drop');
    expect(
      terminalFrameBacklogAction({
        pageActive: true,
        awaitingFull: true,
        isFull: true,
        pendingCount: 0,
      }),
    ).toBe('accept_full');
  });
});
