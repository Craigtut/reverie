import { describe, expect, it } from 'vitest';

import {
  historyWindowRows,
  planHistoryWindowForMissingRows,
  planHistoryWindowForTargetRow,
  resolveHistoryTotalRows,
} from './historyWindowing';

describe('history window planning', () => {
  it('sizes replay windows to several viewports without exceeding total rows', () => {
    expect(historyWindowRows(12, 200)).toBe(144);
    expect(historyWindowRows(12, 20)).toBe(20);
  });

  it('centers a live target row inside a broader replay window', () => {
    expect(planHistoryWindowForTargetRow(50, 10, 100)).toEqual({
      startRow: 0,
      rowCount: 100,
      targetRow: 50,
    });
  });

  it('clamps tail targets while keeping enough preceding context cached', () => {
    expect(planHistoryWindowForTargetRow(98, 10, 100)).toEqual({
      startRow: 0,
      rowCount: 100,
      targetRow: 90,
    });
  });

  it('inflates a missing paint window into a predictive replay band', () => {
    expect(planHistoryWindowForMissingRows(40, 16, 10, 100)).toEqual({
      startRow: 0,
      rowCount: 100,
      targetRow: 43,
    });
  });

  it('clamps missing-window requests near the start', () => {
    expect(planHistoryWindowForMissingRows(0, 16, 10, 100)).toEqual({
      startRow: 0,
      rowCount: 100,
      targetRow: 3,
    });
  });

  it('prefers authoritative replay-frame totals over stale fallback totals', () => {
    expect(resolveHistoryTotalRows(12, 80, 10)).toBe(12);
    expect(resolveHistoryTotalRows(3, 80, 10)).toBe(10);
  });

  it('falls back to known totals when the replay frame has no valid total', () => {
    expect(resolveHistoryTotalRows(undefined, 80, 10)).toBe(80);
    expect(resolveHistoryTotalRows(Number.NaN, 80, 10)).toBe(80);
  });
});
