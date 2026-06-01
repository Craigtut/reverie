const DEFAULT_SAMPLE_LIMIT = 2_048;

export interface TerminalMetricSummary {
  count: number;
  retained: number;
  average: number;
  p95: number;
  max: number;
}

export interface TerminalMetricSamples {
  readonly count: number;
  record(value: number): void;
  summary(): TerminalMetricSummary;
}

export function createTerminalMetricSamples(limit = DEFAULT_SAMPLE_LIMIT): TerminalMetricSamples {
  const sampleLimit = Math.max(1, Math.floor(limit));
  const retained: number[] = [];
  let cursor = 0;
  let count = 0;
  let sum = 0;
  let max = 0;

  return {
    get count() {
      return count;
    },
    record(value: number) {
      if (!Number.isFinite(value)) return;
      const sample = Math.max(0, value);
      count += 1;
      sum += sample;
      max = Math.max(max, sample);

      if (retained.length < sampleLimit) {
        retained.push(sample);
        return;
      }
      retained[cursor] = sample;
      cursor = (cursor + 1) % sampleLimit;
    },
    summary() {
      return {
        count,
        retained: retained.length,
        average: count === 0 ? 0 : sum / count,
        p95: percentile(retained, 0.95),
        max,
      };
    },
  };
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index] ?? 0;
}
