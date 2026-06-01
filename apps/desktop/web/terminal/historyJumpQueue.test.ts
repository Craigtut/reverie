import { describe, expect, it } from 'vitest';

import { createLatestHistoryJumpQueue, type HistoryJumpRequest } from './historyJumpQueue';

const baseRequest: HistoryJumpRequest = {
  sessionId: 'session-1',
  cols: 80,
  rows: 24,
  targetRow: 100,
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('latest history jump queue', () => {
  it('runs one replay at a time and keeps only the latest pending target', async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const calls: HistoryJumpRequest[] = [];
    const results = [first.promise, second.promise];
    const queue = createLatestHistoryJumpQueue(request => {
      calls.push(request);
      const next = results.shift();
      if (!next) throw new Error('unexpected replay');
      return next;
    });

    const firstResult = queue.enqueue({ ...baseRequest, targetRow: 100 });
    const queuedSecond = await queue.enqueue({ ...baseRequest, targetRow: 90 });
    const queuedThird = await queue.enqueue({ ...baseRequest, targetRow: 80 });

    expect(queuedSecond).toBe(true);
    expect(queuedThird).toBe(true);
    expect(queue.hasPending()).toBe(true);
    expect(calls.map(call => call.targetRow)).toEqual([100]);

    first.resolve(true);
    expect(await firstResult).toBe(true);
    await Promise.resolve();

    expect(calls.map(call => call.targetRow)).toEqual([100, 80]);
    expect(queue.hasPending()).toBe(false);

    second.resolve(true);
    await Promise.resolve();
  });

  it('clears stale pending work and lets a new request start immediately', async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const calls: HistoryJumpRequest[] = [];
    const results = [first.promise, second.promise];
    const queue = createLatestHistoryJumpQueue(request => {
      calls.push(request);
      const next = results.shift();
      if (!next) throw new Error('unexpected replay');
      return next;
    });

    const firstResult = queue.enqueue({ ...baseRequest, targetRow: 100 });
    await queue.enqueue({ ...baseRequest, targetRow: 90 });

    queue.clear();
    const secondResult = queue.enqueue({ ...baseRequest, targetRow: 40 });

    expect(calls.map(call => call.targetRow)).toEqual([100, 40]);
    expect(queue.hasPending()).toBe(false);

    first.resolve(true);
    second.resolve(true);

    expect(await firstResult).toBe(true);
    expect(await secondResult).toBe(true);
    expect(calls.map(call => call.targetRow)).toEqual([100, 40]);
  });

  it('coalesces duplicate in-flight and pending requests', async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const calls: HistoryJumpRequest[] = [];
    const results = [first.promise, second.promise];
    const queue = createLatestHistoryJumpQueue(request => {
      calls.push(request);
      const next = results.shift();
      if (!next) throw new Error('unexpected replay');
      return next;
    });

    const firstResult = queue.enqueue({ ...baseRequest, targetRow: 100 });
    await queue.enqueue({ ...baseRequest, targetRow: 100 });
    await queue.enqueue({ ...baseRequest, targetRow: 80 });
    await queue.enqueue({ ...baseRequest, targetRow: 80 });

    expect(calls.map(call => call.targetRow)).toEqual([100]);
    expect(queue.hasPending()).toBe(true);

    first.resolve(true);
    expect(await firstResult).toBe(true);
    await Promise.resolve();

    expect(calls.map(call => call.targetRow)).toEqual([100, 80]);
    second.resolve(true);
    await Promise.resolve();
  });
});
