import { describe, expect, it } from 'vitest';
import { WHEEL_GESTURE_IDLE_MS, WheelReportAccumulator } from './wheelReports';

const CELL = 18;

function feed(accumulator: WheelReportAccumulator, deltas: number[], stepMs = 8, start = 0) {
  return deltas.map((deltaPixels, index) =>
    accumulator.take({
      deltaPixels,
      pixelsPerReport: CELL,
      maxReports: 40,
      now: start + index * stepMs,
    }),
  );
}

describe('WheelReportAccumulator', () => {
  it('turns a burst of small trackpad deltas into one report per cell of travel', () => {
    const accumulator = new WheelReportAccumulator();
    // 30 events x 3px = 90px = 5 cells. The first event reports immediately.
    const reports = feed(accumulator, Array(30).fill(3));
    const total = reports.reduce((sum, count) => sum + count, 0);
    expect(total).toBeGreaterThanOrEqual(5);
    expect(total).toBeLessThanOrEqual(6);
    expect(reports.filter(count => count !== 0).length).toBe(total);
  });

  it('reports scrolling up as negative counts', () => {
    const accumulator = new WheelReportAccumulator();
    expect(feed(accumulator, [-40])).toEqual([-2]);
  });

  it('guarantees a report for the first event of a gesture', () => {
    const accumulator = new WheelReportAccumulator();
    expect(feed(accumulator, [2])).toEqual([1]);
    // Same gesture: small deltas accumulate without reporting.
    expect(feed(accumulator, [2, 2], 8, 8)).toEqual([0, 0]);
    // After a quiet gap, a new gesture reports straight away again.
    expect(feed(accumulator, [2], 8, 8 + WHEEL_GESTURE_IDLE_MS + 16)).toEqual([1]);
  });

  it('drops leftover travel when the direction flips', () => {
    const accumulator = new WheelReportAccumulator();
    feed(accumulator, [30, 10]); // 1 report, 22px pending
    expect(feed(accumulator, [-10], 8, 16)).toEqual([0]);
    expect(feed(accumulator, [-10], 8, 24)).toEqual([-1]);
  });

  it('scales the step for apps that scroll several rows per report', () => {
    const accumulator = new WheelReportAccumulator();
    const reports = Array.from({ length: 12 }, (_, index) =>
      accumulator.take({
        deltaPixels: 9,
        pixelsPerReport: CELL * 3,
        maxReports: 40,
        now: index * 8,
      }),
    );
    // 108px of travel = 2 steps of three cells.
    expect(reports.reduce((sum, count) => sum + count, 0)).toBe(2);
  });

  it('caps a single huge event and does not queue the excess', () => {
    const accumulator = new WheelReportAccumulator();
    expect(
      accumulator.take({ deltaPixels: 10_000, pixelsPerReport: CELL, maxReports: 5, now: 0 }),
    ).toBe(5);
    expect(accumulator.take({ deltaPixels: 1, pixelsPerReport: CELL, maxReports: 5, now: 8 })).toBe(
      0,
    );
  });

  it('ignores zero and non-finite deltas', () => {
    const accumulator = new WheelReportAccumulator();
    expect(feed(accumulator, [0, Number.NaN])).toEqual([0, 0]);
  });
});
