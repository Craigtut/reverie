import { describe, expect, it } from 'vitest';

import {
  createTerminalFrameBatchAggregate,
  recordTerminalFrameBatch,
  terminalFrameBatchRenderMetrics,
} from './frameCoalescing';

describe('terminal frame coalescing metrics', () => {
  it('tracks frontend paint batches separately from backend frames', () => {
    const aggregate = createTerminalFrameBatchAggregate();

    recordTerminalFrameBatch(aggregate, 3, 12);
    recordTerminalFrameBatch(aggregate, 1, 5);

    expect(terminalFrameBatchRenderMetrics(aggregate, 4)).toEqual(
      expect.objectContaining({
        avgFrameMs: 4.25,
        p95FrameMs: 5,
        maxFrameMs: 5,
        frontendFrameBatches: 2,
        coalescedFrames: 2,
        avgFramesPerBatch: 2,
        maxFramesPerBatch: 3,
        avgBatchPaintMs: 8.5,
        p95BatchPaintMs: 12,
        maxBatchPaintMs: 12,
      }),
    );
  });

  it('ignores empty batches', () => {
    const aggregate = createTerminalFrameBatchAggregate();

    recordTerminalFrameBatch(aggregate, 0, 10);

    expect(terminalFrameBatchRenderMetrics(aggregate, 0)).toEqual(
      expect.objectContaining({
        avgFrameMs: 0,
        frontendFrameBatches: 0,
        coalescedFrames: 0,
        avgFramesPerBatch: 0,
      }),
    );
  });
});
