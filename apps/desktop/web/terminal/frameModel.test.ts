import { describe, it, expect } from 'vitest';

import type { TerminalSurface } from '../terminalScrollback';
import type { SessionTerminalView } from '../domain';
import type { TerminalFrame, TerminalRow } from '../terminalTypes';
import {
  blankTerminalFrame,
  buildSessionTerminalView,
  computePaintWindow,
  emptyTerminalView,
} from './frameModel';

const surface: TerminalSurface = { cols: 80, rows: 4, cellWidth: 8, cellHeight: 10 };

function row(index: number, dirty = true, text = ''): TerminalRow {
  return { index, dirty, cells: text ? [{ col: 0, text }] : [] };
}

function rowText(row: TerminalRow) {
  return row.cells
    .map(cell => cell.text)
    .join('')
    .trim();
}

function makeFrame(rowCount: number, opts: Partial<TerminalFrame> = {}): TerminalFrame {
  return {
    dirty: 'full',
    rows: Array.from({ length: rowCount }, (_, i) => row(i)),
    cursor: { visible: true, row: 0, col: 0, position: { row: 0, col: 0 } },
    ...opts,
  };
}

describe('blankTerminalFrame', () => {
  it('builds one dirty empty row per surface row, cursor hidden', () => {
    const frame = blankTerminalFrame(surface);
    expect(frame.dirty).toBe('full');
    expect(frame.rows).toHaveLength(surface.rows);
    expect(
      frame.rows.every((r, i) => r.index === i && r.dirty === true && r.cells.length === 0),
    ).toBe(true);
    expect(frame.cursor?.visible).toBe(false);
  });
});

describe('emptyTerminalView', () => {
  it('has no last frame, a blank composite, zero rows, live-follow on', () => {
    const view = emptyTerminalView(surface);
    expect(view.lastFrame).toBeNull();
    expect(view.compositeFrame.rows).toHaveLength(surface.rows);
    expect(view.rowCount).toBe(0);
    expect(view.liveFollow).toBe(true);
  });
});

describe('buildSessionTerminalView', () => {
  it('normalizes the frame to the surface and defaults live-follow on', () => {
    const view = buildSessionTerminalView(undefined, makeFrame(2), surface);
    expect(view.lastFrame).not.toBeNull();
    expect(view.compositeFrame.rows).toHaveLength(surface.rows); // frameForSurface pads to surface
    expect(view.liveFollow).toBe(true);
    expect(view.rowCount).toBe(0);
  });

  it('inherits previous live-follow when the frame has no scrollback signal', () => {
    const prev: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: makeFrame(4),
      scrollbackRows: [],
      rowCount: 0,
      liveFollow: false,
    };
    const view = buildSessionTerminalView(prev, makeFrame(2), surface);
    expect(view.liveFollow).toBe(false);
  });

  it('lets the backend scrollback signal win and reports its row count', () => {
    const frame = makeFrame(2, { scrollback: { atBottom: false, scrollbackRows: 5 } });
    const view = buildSessionTerminalView(undefined, frame, surface);
    expect(view.liveFollow).toBe(false);
    expect(view.rowCount).toBe(5);
  });

  it('merges partial alternate-screen rows over the previous alternate-screen view', () => {
    const previous = buildSessionTerminalView(
      undefined,
      makeFrame(4, {
        modes: { alternateScreen: true },
        rows: [row(0, true, 'top'), row(1, true, 'old'), row(2, true, 'bottom')],
      }),
      surface,
    );

    const view = buildSessionTerminalView(
      previous,
      makeFrame(4, {
        dirty: 'partial',
        modes: { alternateScreen: true },
        rows: [row(1, true, 'new')],
      }),
      surface,
    );

    expect(view.compositeFrame.dirty).toBe('partial');
    expect(view.compositeFrame.rows.map(rowText)).toEqual(['top', 'new', 'bottom', '']);
    expect(view.compositeFrame.rows.map(row => row.dirty)).toEqual([false, true, false, false]);
  });

  it('does not merge a partial alternate-screen frame over a previous primary view', () => {
    const previous = buildSessionTerminalView(
      undefined,
      makeFrame(4, {
        rows: [row(0, true, 'primary'), row(1, true, 'primary-old')],
      }),
      surface,
    );

    const view = buildSessionTerminalView(
      previous,
      makeFrame(4, {
        dirty: 'partial',
        modes: { alternateScreen: true },
        rows: [row(1, true, 'alternate')],
      }),
      surface,
    );

    expect(view.compositeFrame.rows.map(rowText)).toEqual(['', 'alternate', '', '']);
    expect(view.compositeFrame.rows.map(row => row.dirty)).toEqual([false, true, false, false]);
  });
});

describe('computePaintWindow', () => {
  const tall = makeFrame(30, { dirty: 'partial' });

  it('windows rows around the scroll position and rebases indices to 0', () => {
    // viewportHeight 40 / cellHeight 10 = 4, + overscan*2 (6) => 10 display rows.
    // scrollTop 100 => floor(100/10)=10, - overscan 3 => startRow 7.
    const { startRow, displayRows, windowFrame } = computePaintWindow({
      frame: tall,
      surface,
      scrollTop: 100,
      viewportHeight: 40,
      needsFullPaint: true,
      lastStartRow: null,
    });
    expect(displayRows).toBe(10);
    expect(startRow).toBe(7);
    // forceFullPaint (needsFullPaint) => all 10 windowed rows present, rebased 0..9
    expect(windowFrame.rows).toHaveLength(10);
    expect(windowFrame.rows[0].index).toBe(0);
    expect(windowFrame.rows[9].index).toBe(9);
  });

  it('clamps startRow so the window never runs past the end', () => {
    const { startRow } = computePaintWindow({
      frame: tall,
      surface,
      scrollTop: 100000,
      viewportHeight: 40,
      needsFullPaint: true,
      lastStartRow: null,
    });
    expect(startRow).toBe(20); // maxStartRow = 30 - 10
  });

  it('forces a full paint when the start row changed, even on a partial frame', () => {
    const res = computePaintWindow({
      frame: tall,
      surface,
      scrollTop: 100,
      viewportHeight: 40,
      needsFullPaint: false,
      lastStartRow: 3,
    });
    expect(res.forceFullPaint).toBe(true); // lastStartRow(3) !== startRow(7)
    expect(res.windowFrame.dirty).toBe('full');
  });

  it('paints only dirty rows when not forcing (same start, partial frame)', () => {
    const frame = makeFrame(30, { dirty: 'partial' });
    frame.rows = frame.rows.map((r, i) => ({ ...r, dirty: i === 9 })); // only row 9 dirty
    const res = computePaintWindow({
      frame,
      surface,
      scrollTop: 100,
      viewportHeight: 40,
      needsFullPaint: false,
      lastStartRow: 7,
    });
    expect(res.forceFullPaint).toBe(false); // not needed, start unchanged, partial
    expect(res.windowFrame.rows).toHaveLength(1);
    expect(res.windowFrame.rows[0].index).toBe(2); // row 9 rebased: 9 - startRow(7)
  });

  it('remaps a visible cursor into the window and hides it when off-window', () => {
    const withCursor = makeFrame(30, {
      dirty: 'partial',
      cursor: { visible: true, row: 8, col: 5, position: { row: 8, col: 5 } },
    });
    const visible = computePaintWindow({
      frame: withCursor,
      surface,
      scrollTop: 100,
      viewportHeight: 40,
      needsFullPaint: true,
      lastStartRow: null,
    });
    expect(visible.windowFrame.cursor?.row).toBe(1); // 8 - startRow(7)
    expect(visible.windowFrame.cursor?.visible).not.toBe(false);

    const offWindow = makeFrame(30, {
      dirty: 'partial',
      cursor: { visible: true, row: 0, col: 0, position: { row: 0, col: 0 } },
    });
    const hidden = computePaintWindow({
      frame: offWindow,
      surface,
      scrollTop: 100,
      viewportHeight: 40,
      needsFullPaint: true,
      lastStartRow: null,
    });
    expect(hidden.windowFrame.cursor?.visible).toBe(false); // row 0 < startRow 7
  });
});
