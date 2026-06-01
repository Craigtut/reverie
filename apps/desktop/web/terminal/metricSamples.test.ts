import { describe, expect, it } from 'vitest';

import { createTerminalMetricSamples } from './metricSamples';

describe('terminal metric samples', () => {
  it('keeps exact average and max while bounding retained percentile samples', () => {
    const samples = createTerminalMetricSamples(3);

    for (const value of [1, 2, 3, 4, 100]) samples.record(value);

    expect(samples.summary()).toEqual({
      count: 5,
      retained: 3,
      average: 22,
      p95: 100,
      max: 100,
    });
  });

  it('ignores invalid samples and clamps negative durations', () => {
    const samples = createTerminalMetricSamples(4);

    samples.record(Number.NaN);
    samples.record(-5);

    expect(samples.summary()).toEqual({
      count: 1,
      retained: 1,
      average: 0,
      p95: 0,
      max: 0,
    });
  });
});
