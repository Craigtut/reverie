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

  it('accepts the foreground seed before WebKit reports document focus', () => {
    expect(
      terminalFrameBacklogAction({
        pageActive: false,
        awaitingFull: true,
        isFull: true,
        pendingCount: 0,
      }),
    ).toBe('accept_full');
  });

  it('preserves a queued full seed when another burst reaches the limit', () => {
    expect(
      terminalFrameBacklogAction({
        pageActive: true,
        awaitingFull: false,
        isFull: false,
        hasPendingFull: true,
        pendingCount: MAX_PENDING_TERMINAL_FRAMES,
      }),
    ).toBe('resync_preserve_full');
  });

  it('never replaces a queued full seed with an inactive-page resync', () => {
    expect(
      terminalFrameBacklogAction({
        pageActive: false,
        awaitingFull: false,
        isFull: false,
        hasPendingFull: true,
        pendingCount: 1,
      }),
    ).toBe('resync_preserve_full');
  });

  it('keeps a paintable baseline through a second burst before the recovery rAF', () => {
    let awaitingFull = true;
    let pending: Array<'full' | 'diff'> = [];

    const receive = (kind: 'full' | 'diff', pageActive = true) => {
      const action = terminalFrameBacklogAction({
        pageActive,
        awaitingFull,
        isFull: kind === 'full',
        hasPendingFull: pending.includes('full'),
        pendingCount: pending.length,
      });
      if (action === 'accept_full') {
        pending = ['full'];
        awaitingFull = false;
      } else if (action === 'enqueue') {
        pending.push(kind);
      } else if (action === 'resync_preserve_full') {
        pending = pending.filter(frame => frame === 'full').slice(-1);
        awaitingFull = true;
      } else if (action === 'resync') {
        pending = [];
        awaitingFull = true;
      }
      return action;
    };

    expect(receive('full', false)).toBe('accept_full');
    for (let index = 0; index < MAX_PENDING_TERMINAL_FRAMES - 1; index += 1) {
      expect(receive('diff')).toBe('enqueue');
    }
    expect(receive('diff')).toBe('resync_preserve_full');
    expect(pending).toEqual(['full']);
    expect(awaitingFull).toBe(true);
    expect(receive('full')).toBe('accept_full');
    expect(pending).toEqual(['full']);
    expect(awaitingFull).toBe(false);
  });
});
