import type { RenderMetrics } from '../domain';
import { createTerminalMetricSamples, type TerminalMetricSamples } from './metricSamples';

export interface TerminalFrameBatchAggregate {
  frameBatches: number;
  coalescedFrames: number;
  maxFramesPerBatch: number;
  perFrameTimings: TerminalMetricSamples;
  batchTimings: TerminalMetricSamples;
}

export function createTerminalFrameBatchAggregate(): TerminalFrameBatchAggregate {
  return {
    frameBatches: 0,
    coalescedFrames: 0,
    maxFramesPerBatch: 0,
    perFrameTimings: createTerminalMetricSamples(),
    batchTimings: createTerminalMetricSamples(),
  };
}

export function recordTerminalFrameBatch(
  aggregate: TerminalFrameBatchAggregate,
  frameCount: number,
  elapsedMs: number,
) {
  const count = Math.max(0, Math.floor(frameCount));
  if (count === 0) return;
  const elapsed = Math.max(0, elapsedMs);
  const perFrameElapsed = elapsed / count;

  aggregate.frameBatches += 1;
  aggregate.coalescedFrames += Math.max(0, count - 1);
  aggregate.maxFramesPerBatch = Math.max(aggregate.maxFramesPerBatch, count);
  aggregate.batchTimings.record(elapsed);
  for (let index = 0; index < count; index += 1) {
    aggregate.perFrameTimings.record(perFrameElapsed);
  }
}

export function terminalFrameBatchRenderMetrics(
  aggregate: TerminalFrameBatchAggregate,
  framesReceived: number,
): Pick<RenderMetrics, 'avgFrameMs' | 'p95FrameMs' | 'maxFrameMs'> & Partial<RenderMetrics> {
  const perFrame = aggregate.perFrameTimings.summary();
  const batch = aggregate.batchTimings.summary();
  return {
    avgFrameMs: perFrame.average,
    p95FrameMs: perFrame.p95,
    maxFrameMs: perFrame.max,
    frontendFrameBatches: aggregate.frameBatches,
    coalescedFrames: aggregate.coalescedFrames,
    avgFramesPerBatch: framesReceived / Math.max(1, aggregate.frameBatches),
    maxFramesPerBatch: aggregate.maxFramesPerBatch,
    avgBatchPaintMs: batch.average,
    p95BatchPaintMs: batch.p95,
    maxBatchPaintMs: batch.max,
  };
}
