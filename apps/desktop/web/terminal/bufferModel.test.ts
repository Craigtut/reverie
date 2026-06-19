import { describe, expect, it } from 'vitest';

import type { TerminalCell, TerminalFrame, TerminalRow } from '../terminalTypes';
import {
  applyViewportFrameToBuffer,
  createTerminalBuffer,
  expandTerminalBufferRangeToCellBounds,
  frameFromBufferAbsoluteWindow,
  frameFromBufferSnapshot,
  frameFromBufferWindow,
  mergeHistoryWindowIntoBuffer,
  selectAllTerminalBufferRange,
  terminalBufferCachedRangeForRows,
  terminalBufferFullyCached,
  terminalBufferHasRows,
  terminalBufferRowText,
  terminalBufferRowsPresent,
  terminalBufferSelectionText,
} from './bufferModel';

const surface = { cols: 20, rows: 3 };

function row(index: number, text: string, dirty = true): TerminalRow {
  const cells: TerminalCell[] = text.split('').map((ch, col) => ({ col, text: ch }));
  return { index, dirty, cells };
}

function frame(rows: TerminalRow[], opts: Partial<TerminalFrame> = {}): TerminalFrame {
  return {
    dirty: 'full',
    rows,
    cursor: { visible: true, row: 0, col: 0, position: { row: 0, col: 0 } },
    ...opts,
  };
}

describe('terminal buffer model', () => {
  it('stores viewport rows using backend scrollback offsets as stable row ids', () => {
    const initial = createTerminalBuffer(surface);
    const state = applyViewportFrameToBuffer(
      initial,
      frame([row(0, 'alpha'), row(1, 'beta'), row(2, 'gamma')], {
        scrollback: { totalRows: 10, viewportOffset: 7, viewportRows: 3, atBottom: true },
      }),
      surface,
    );

    expect([...state.rowsById.keys()]).toEqual([7, 8, 9]);
    expect(state.cachedRanges).toEqual([{ start: 7, end: 10 }]);
    expect(terminalBufferRowText(state, 7, true)).toBe('alpha');
    expect(state.cursor?.position?.row).toBe(7);
  });

  it('can report a blank row as physically present while coverage still treats it as a miss', () => {
    // This helper is a physical row-map check, not the render/fetch gate. A blank
    // row can be present in the mirror but still not covered by trusted provenance
    // (for example, a stale live blank that drifted into scrollback). Fetch
    // decisions use terminalBufferHasRows instead.
    // Blank row 2 sits in scrollback (below the live viewport [3,5)), so the
    // viewport-union in the coverage model does not cover it.
    const state = {
      ...createTerminalBuffer(surface),
      totalRows: 5,
      viewportOffset: 3,
      viewportRows: 2,
      rowsById: new Map([
        [0, row(0, 'a')],
        [1, row(1, 'b')],
        [2, row(2, '')],
        [3, row(3, 'c')],
        [4, row(4, 'd')],
      ]),
      cachedRanges: [
        { start: 0, end: 2 },
        { start: 3, end: 5 },
      ],
    };

    expect(terminalBufferHasRows(state, 0, 5)).toBe(false);
    expect(terminalBufferRowsPresent(state, 0, 5)).toBe(true);
  });

  it('preserves wide cell widths and clips cells at the surface edge', () => {
    const state = applyViewportFrameToBuffer(
      createTerminalBuffer({ cols: 4, rows: 1 }),
      frame([{ index: 0, dirty: true, cells: [{ col: 3, width: 2, text: '界' }] }]),
      { cols: 4, rows: 1 },
    );

    expect(state.rowsById.get(0)?.cells).toEqual([{ col: 3, width: 1, text: '界' }]);
  });

  it('reconstructs wide cells without covered spacer columns', () => {
    const state = applyViewportFrameToBuffer(
      createTerminalBuffer({ cols: 6, rows: 1 }),
      frame([
        {
          index: 0,
          dirty: true,
          cells: [
            { col: 0, text: 'A' },
            { col: 1, width: 2, text: '界' },
            { col: 3, text: 'B' },
          ],
        },
      ]),
      { cols: 6, rows: 1 },
    );

    expect(terminalBufferRowText(state, 0, true)).toBe('A界B');
    expect(
      terminalBufferSelectionText(state, { start: { row: 0, col: 2 }, end: { row: 0, col: 2 } }),
    ).toBe('界');
  });

  it('updates dirty rows in place so character animations keep one row identity', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'thinking -'), row(1, 'stable'), row(2, 'other')]),
      surface,
    );
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'thinking \\'), row(1, 'stale write ignored', false)], {
        dirty: 'partial',
      }),
      surface,
    );

    expect([...state.rowsById.keys()]).toEqual([0, 1, 2]);
    expect(state.cachedRanges).toEqual([{ start: 0, end: 3 }]);
    expect(terminalBufferRowText(state, 0, true)).toBe('thinking \\');
    expect(terminalBufferRowText(state, 1, true)).toBe('stable');
    expect(terminalBufferRowText(state, 2, true)).toBe('other');
  });

  it('does not mark unseen rows as cached from a partial frame', () => {
    const state = applyViewportFrameToBuffer(
      createTerminalBuffer(surface),
      frame([row(1, 'known')], {
        dirty: 'partial',
        scrollback: { totalRows: 8, viewportOffset: 5, viewportRows: 3, atBottom: true },
      }),
      surface,
    );

    expect([...state.rowsById.keys()]).toEqual([6]);
    expect(state.cachedRanges).toEqual([{ start: 6, end: 7 }]);
    expect(terminalBufferHasRows(state, 5, 3)).toBe(false);
    expect(terminalBufferHasRows(state, 6, 1)).toBe(true);
  });

  it('retains known rows across backend-driven viewport scrolls', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'one'), row(1, 'two'), row(2, 'three')], {
        scrollback: { totalRows: 3, viewportOffset: 0, viewportRows: 3, atBottom: true },
      }),
      surface,
    );
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'three'), row(1, 'four'), row(2, 'five')], {
        scrollback: { totalRows: 5, viewportOffset: 2, viewportRows: 3, atBottom: true },
      }),
      surface,
    );

    expect([...state.rowsById.keys()]).toEqual([0, 1, 2, 3, 4]);
    expect(state.cachedRanges).toEqual([{ start: 0, end: 5 }]);
    expect(terminalBufferRowText(state, 0, true)).toBe('one');
    expect(terminalBufferRowText(state, 4, true)).toBe('five');
  });

  it('does not let DRIFTED blank rows satisfy scrollback misses, but covers the live tail', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(state, frame([row(0, ''), row(1, ''), row(2, '')]), surface);

    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'three'), row(1, 'four'), row(2, '')], {
        scrollback: { totalRows: 6, viewportOffset: 3, viewportRows: 3, atBottom: true },
      }),
      surface,
    );

    expect(terminalBufferRowText(state, 0, true)).toBe('');
    expect(terminalBufferRowText(state, 3, true)).toBe('three');
    // Settled coverage is the rows-with-cells (3, 4); the blanks are not settled.
    expect(state.cachedRanges).toEqual([{ start: 3, end: 5 }]);
    // The blanks 0-2 DRIFTED out of the viewport (they were the live screen in the
    // first frame); they are not covered, so a scroll-back there re-fetches the
    // real content (the stale-blank guard).
    expect(terminalBufferHasRows(state, 0, 3)).toBe(false);
    // Rows 3, 4 are covered (settled, they have cells).
    expect(terminalBufferHasRows(state, 3, 2)).toBe(true);
    // Row 5 is blank but it is in the CURRENT live viewport ([3, 6)), so it is
    // covered: a blank row in the live screen is real content, not a miss. This
    // is the Ink-tail fix; previously this blank made the tail a perpetual miss
    // and livelocked the prefetch.
    expect(terminalBufferHasRows(state, 3, 3)).toBe(true);
  });

  it('covers a blank-padded live tail so the prefetch does not livelock (Ink)', () => {
    // Ink/TUIs pad the bottom of the screen with blank rows. The whole current
    // viewport, blanks included, must be covered or the prefetch re-requests the
    // blank tail forever (the reported scroll-back-stops-short bug).
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'prompt >'), row(1, ''), row(2, '')], {
        scrollback: { totalRows: 12, viewportOffset: 9, viewportRows: 3, atBottom: true },
      }),
      surface,
    );

    // The full live viewport [9, 12) is covered even though rows 10 and 11 are blank.
    expect(terminalBufferHasRows(state, 9, 3)).toBe(true);
    expect(terminalBufferHasRows(state, 11, 1)).toBe(true);
    // A row just above the live viewport that nothing has provided is still a miss.
    expect(terminalBufferHasRows(state, 8, 1)).toBe(false);
  });

  it('realigns the mirror when the backend evicts rows (oldest_id advances)', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'aaa'), row(1, 'bbb'), row(2, 'ccc')], {
        scrollback: {
          totalRows: 3,
          viewportOffset: 0,
          viewportRows: 3,
          atBottom: true,
          oldestId: 0,
        },
      }),
      surface,
    );
    expect(state.oldestId).toBe(0);
    expect(terminalBufferRowText(state, 0, true)).toBe('aaa');

    // The backend evicted 2 rows (oldest_id 0 -> 2): 'ccc' (was position 2) is now
    // position 0, with two new rows appended at the tail.
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'ccc'), row(1, 'ddd'), row(2, 'eee')], {
        scrollback: {
          totalRows: 3,
          viewportOffset: 0,
          viewportRows: 3,
          atBottom: true,
          oldestId: 2,
        },
      }),
      surface,
    );

    expect(state.oldestId).toBe(2);
    // 'aaa'/'bbb' shifted below 0 and were dropped (evicted); the mirror realigned.
    expect([...state.rowsById.keys()]).toEqual([0, 1, 2]);
    expect(terminalBufferRowText(state, 0, true)).toBe('ccc');
    expect(terminalBufferRowText(state, 2, true)).toBe('eee');
  });

  it('preserves fetched scrollback coverage across eviction by realigning it', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'tail')], {
        dirty: 'partial',
        scrollback: {
          totalRows: 20,
          viewportOffset: 17,
          viewportRows: 3,
          atBottom: true,
          oldestId: 0,
        },
      }),
      surface,
    );
    // A fetched band at positions 5-7 (no eviction yet).
    state = mergeHistoryWindowIntoBuffer(
      state,
      frame([row(0, 'h5'), row(1, 'h6'), row(2, 'h7')]),
      surface,
      5,
      20,
    );
    expect(terminalBufferHasRows(state, 5, 3)).toBe(true);

    // The backend evicts 3 (oldest_id -> 3); the fetched band must realign from
    // positions 5-7 to 2-4 and stay covered there, not vanish or misalign.
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'newtail')], {
        dirty: 'partial',
        scrollback: {
          totalRows: 20,
          viewportOffset: 17,
          viewportRows: 3,
          atBottom: true,
          oldestId: 3,
        },
      }),
      surface,
    );

    expect(state.oldestId).toBe(3);
    expect(terminalBufferHasRows(state, 2, 3)).toBe(true);
    expect(terminalBufferRowText(state, 2, true)).toBe('h5');
    // The pre-eviction positions are no longer covered (the rows moved down).
    expect(terminalBufferHasRows(state, 5, 3)).toBe(false);
  });

  it('drops stale cached rows when the backend reports a shorter timeline', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'old'), row(1, 'rows'), row(2, 'kept')], {
        scrollback: { totalRows: 8, viewportOffset: 5, viewportRows: 3, atBottom: true },
      }),
      surface,
    );

    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'new'), row(1, ''), row(2, '')], {
        scrollback: { totalRows: 3, viewportOffset: 0, viewportRows: 3, atBottom: true },
      }),
      surface,
    );

    expect([...state.rowsById.keys()]).toEqual([0, 1, 2]);
    expect(state.cachedRanges).toEqual([{ start: 0, end: 3 }]);
    expect(terminalBufferRowText(state, 0, true)).toBe('new');
  });

  it('keeps scroll-back rows when a redraw dips total_rows but scroll-back remains', () => {
    // Ink/Claude clear and redraw their bottom region every frame, which makes
    // libghostty's total_rows oscillate. A dip that still leaves scroll-back
    // (totalRows > viewportRows) is a redraw, not a loss of history: the fetched
    // scroll-back below the live area must survive it. Wiping/trimming here caused
    // the Ink-only re-fetch flap that read as blank / looping scroll-back.
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'tail-a'), row(1, 'tail-b'), row(2, 'tail-c')], {
        scrollback: { totalRows: 30, viewportOffset: 27, viewportRows: 3, atBottom: true },
      }),
      surface,
    );
    // Scroll up and fetch an older band into the mirror (positions 10..19).
    state = mergeHistoryWindowIntoBuffer(
      state,
      frame(Array.from({ length: 10 }, (_, i) => row(i, `h${10 + i}`))),
      surface,
      10,
      30,
    );
    expect(terminalBufferRowsPresent(state, 10, 10)).toBe(true);

    // total_rows dips to 20 (still well above the 3-row viewport): a live-area
    // redraw, not eviction. The fetched scroll-back below it must stay put.
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'redraw-a'), row(1, 'redraw-b'), row(2, 'redraw-c')], {
        scrollback: { totalRows: 20, viewportOffset: 17, viewportRows: 3, atBottom: true },
      }),
      surface,
    );

    expect(terminalBufferRowsPresent(state, 10, 7)).toBe(true);
  });

  it('treats a full frame without scrollback metadata as a fresh viewport', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'old-tail-a'), row(1, 'old-tail-b'), row(2, 'old-tail-c')], {
        scrollback: { totalRows: 8, viewportOffset: 5, viewportRows: 3, atBottom: true },
      }),
      surface,
    );

    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'fresh'), row(1, ''), row(2, '')]),
      surface,
    );

    expect(state.totalRows).toBe(3);
    expect([...state.rowsById.keys()]).toEqual([0, 1, 2]);
    expect(state.cachedRanges).toEqual([{ start: 0, end: 3 }]);
    expect(terminalBufferRowText(state, 0, true)).toBe('fresh');
  });

  it('preserves known rows for partial frames without scrollback metadata', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'stable'), row(1, 'spinner -'), row(2, 'tail')]),
      surface,
    );

    state = applyViewportFrameToBuffer(
      state,
      frame([row(1, 'spinner \\')], {
        dirty: 'partial',
      }),
      surface,
    );

    expect(state.totalRows).toBe(3);
    expect([...state.rowsById.keys()]).toEqual([0, 1, 2]);
    expect(state.cachedRanges).toEqual([{ start: 0, end: 3 }]);
    expect(terminalBufferRowText(state, 0, true)).toBe('stable');
    expect(terminalBufferRowText(state, 1, true)).toBe('spinner \\');
    expect(terminalBufferRowText(state, 2, true)).toBe('tail');
  });

  it('preserves cached rows across height-only surface resizes', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'one'), row(1, 'two'), row(2, 'three')], {
        scrollback: { totalRows: 6, viewportOffset: 3, viewportRows: 3, atBottom: true },
      }),
      surface,
    );

    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'zero'), row(1, 'one'), row(2, 'two'), row(3, 'three')], {
        scrollback: { totalRows: 6, viewportOffset: 2, viewportRows: 4, atBottom: true },
      }),
      { ...surface, rows: 4 },
    );

    expect([...state.rowsById.keys()].sort((left, right) => left - right)).toEqual([2, 3, 4, 5]);
    expect(state.cachedRanges).toEqual([{ start: 2, end: 6 }]);
    expect(terminalBufferRowText(state, 5, true)).toBe('three');
  });

  it('keeps prior rows through blank gaps in a shape-changing resize reflow frame', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'old-a'), row(1, 'old-b'), row(2, 'old-c')], {
        scrollback: { totalRows: 20, viewportOffset: 17, viewportRows: 3, atBottom: true },
      }),
      surface,
    );

    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, ''), row(1, 'new-tail'), row(2, '')], {
        scrollback: { totalRows: 20, viewportOffset: 17, viewportRows: 3, atBottom: true },
      }),
      { ...surface, cols: 40 },
      { preserveBlankRows: true },
    );

    expect([...state.rowsById.keys()]).toEqual([17, 18, 19]);
    expect(state.cachedRanges).toEqual([{ start: 17, end: 20 }]);
    expect(terminalBufferHasRows(state, 17, 3)).toBe(true);
    expect(terminalBufferRowText(state, 17, true)).toBe('old-a');
    expect(terminalBufferRowText(state, 18, true)).toBe('new-tail');
    expect(terminalBufferRowText(state, 19, true)).toBe('old-c');
  });

  it('anchors preserved blank resize rows to the new live viewport', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'old-a'), row(1, 'old-b'), row(2, 'old-c')], {
        scrollback: { totalRows: 20, viewportOffset: 17, viewportRows: 3, atBottom: true },
      }),
      surface,
    );

    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, ''), row(1, ''), row(2, '')], {
        scrollback: { totalRows: 24, viewportOffset: 21, viewportRows: 3, atBottom: true },
      }),
      { ...surface, cols: 40 },
      { preserveBlankRows: true, anchorPreservedRowsToViewport: true },
    );

    expect([...state.rowsById.keys()]).toEqual([21, 22, 23]);
    expect(state.cachedRanges).toEqual([{ start: 21, end: 24 }]);
    expect(terminalBufferHasRows(state, 21, 3)).toBe(true);
    expect(terminalBufferRowText(state, 21, true)).toBe('old-a');
    expect(terminalBufferRowText(state, 22, true)).toBe('old-b');
    expect(terminalBufferRowText(state, 23, true)).toBe('old-c');
  });

  it('anchors preserved sparse resize rows before applying new cells', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'old-a'), row(1, 'old-b'), row(2, 'old-c')], {
        scrollback: { totalRows: 20, viewportOffset: 17, viewportRows: 3, atBottom: true },
      }),
      surface,
    );

    state = applyViewportFrameToBuffer(
      state,
      frame([row(1, 'new-b')], {
        dirty: 'partial',
        scrollback: { totalRows: 24, viewportOffset: 21, viewportRows: 3, atBottom: true },
      }),
      { ...surface, cols: 40 },
      { preserveBlankRows: true, anchorPreservedRowsToViewport: true },
    );

    expect([...state.rowsById.keys()]).toEqual([21, 22, 23]);
    expect(state.cachedRanges).toEqual([{ start: 21, end: 24 }]);
    expect(terminalBufferRowText(state, 21, true)).toBe('old-a');
    expect(terminalBufferRowText(state, 22, true)).toBe('new-b');
    expect(terminalBufferRowText(state, 23, true)).toBe('old-c');
  });

  it('drops prior scrollback rows on a shape-changing live frame so they re-fetch reflowed', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'old-a'), row(1, 'old-b'), row(2, 'old-c')], {
        scrollback: { totalRows: 20, viewportOffset: 8, viewportRows: 3, atBottom: false },
      }),
      surface,
    );

    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'new-tail-a'), row(1, 'new-tail-b'), row(2, 'new-tail-c')], {
        scrollback: { totalRows: 18, viewportOffset: 15, viewportRows: 3, atBottom: true },
      }),
      { ...surface, cols: 40 },
      { preserveShapeRows: true },
    );

    // The width change drops the scrolled-back rows (stale old width) so they
    // re-fetch reflowed from the backend; only the live tail bridges the resize.
    expect(state.cachedRanges).toEqual([{ start: 15, end: 18 }]);
    expect(terminalBufferHasRows(state, 8, 3)).toBe(false);
    expect(terminalBufferRowText(state, 8, true)).toBe('');
    expect(terminalBufferRowText(state, 15, true)).toBe('new-tail-a');
  });

  it('keeps shape-changed scrollback dropped across later live frames', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'old-a'), row(1, 'old-b'), row(2, 'old-c')], {
        scrollback: { totalRows: 20, viewportOffset: 8, viewportRows: 3, atBottom: false },
      }),
      surface,
    );

    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'new-tail-a'), row(1, 'new-tail-b'), row(2, 'new-tail-c')], {
        scrollback: { totalRows: 24, viewportOffset: 21, viewportRows: 3, atBottom: true },
      }),
      { ...surface, cols: 40 },
      { preserveShapeRows: true },
    );

    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'newer-tail-a'), row(1, 'newer-tail-b'), row(2, 'newer-tail-c')], {
        scrollback: { totalRows: 25, viewportOffset: 22, viewportRows: 3, atBottom: true },
      }),
      { ...surface, cols: 40 },
    );

    // The shape change dropped rows 8..10; later same-width frames never resurrect
    // them (they re-fetch reflowed on demand), they only extend the live tail.
    expect(state.cachedRanges).toEqual([{ start: 21, end: 25 }]);
    expect(terminalBufferHasRows(state, 8, 3)).toBe(false);
    expect(terminalBufferRowText(state, 8, true)).toBe('');
    expect(terminalBufferHasRows(state, 22, 3)).toBe(true);
    expect(terminalBufferRowText(state, 22, true)).toBe('newer-tail-a');
  });

  it('removes previously cached blanks during resize reflow', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, ''), row(1, 'old-tail'), row(2, '')], {
        scrollback: { totalRows: 20, viewportOffset: 17, viewportRows: 3, atBottom: true },
      }),
      surface,
    );

    expect(state.cachedRanges).toEqual([{ start: 18, end: 19 }]);

    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, ''), row(1, 'new-tail'), row(2, '')], {
        scrollback: { totalRows: 20, viewportOffset: 17, viewportRows: 3, atBottom: true },
      }),
      surface,
      { preserveBlankRows: true },
    );

    expect([...state.rowsById.keys()]).toEqual([18]);
    expect(state.cachedRanges).toEqual([{ start: 18, end: 19 }]);
    expect(terminalBufferHasRows(state, 17, 3)).toBe(false);
    expect(terminalBufferRowText(state, 18, true)).toBe('new-tail');
  });

  it('keeps inverse blank cursor cells during resize blank guards', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'old-a'), row(1, 'old-b'), row(2, 'old-c')], {
        scrollback: { totalRows: 3, viewportOffset: 0, viewportRows: 3, atBottom: true },
      }),
      surface,
    );

    state = applyViewportFrameToBuffer(
      state,
      frame(
        [
          row(0, ''),
          { index: 1, dirty: true, cells: [{ col: 0, text: ' ', style: { inverse: true } }] },
          row(2, ''),
        ],
        {
          scrollback: { totalRows: 3, viewportOffset: 0, viewportRows: 3, atBottom: true },
        },
      ),
      surface,
      { preserveBlankRows: true },
    );

    expect([...state.rowsById.keys()]).toEqual([1]);
    expect(state.rowsById.get(1)?.cells).toEqual([
      { col: 0, width: 1, text: ' ', style: { inverse: true } },
    ]);
  });

  it('creates a paintable window frame with rows and cursor rebased to the window', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'zero'), row(1, 'one'), row(2, 'two')], {
        cursor: { visible: true, row: 2, col: 4, position: { row: 2, col: 4 } },
      }),
      surface,
    );

    const windowFrame = frameFromBufferWindow(state, 1, 2);

    expect(windowFrame.rows.map(r => r.index)).toEqual([0, 1]);
    expect(
      windowFrame.rows.map(r =>
        r.cells
          .map(c => c.text)
          .join('')
          .trim(),
      ),
    ).toEqual(['one', 'two']);
    expect(windowFrame.cursor?.position).toEqual({ row: 1, col: 4 });
  });

  it('clamps a viewport cursor before storing it as an absolute buffer row', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'zero'), row(1, 'one'), row(2, 'two')], {
        scrollback: { totalRows: 10, viewportOffset: 7, viewportRows: 3, atBottom: true },
        cursor: { visible: true, row: 3, col: 25, position: { row: 3, col: 25 } },
      }),
      surface,
    );

    expect(state.cursor?.position).toEqual({ row: 9, col: 19 });

    const windowFrame = frameFromBufferWindow(state, 7, 3);

    expect(windowFrame.cursor).toEqual(
      expect.objectContaining({
        visible: true,
        row: 2,
        col: 19,
        position: { row: 2, col: 19 },
      }),
    );
  });

  it('creates an absolute-row snapshot for selection and links', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'alpha'), row(1, 'beta'), row(2, 'gamma')], {
        scrollback: { totalRows: 8, viewportOffset: 5, viewportRows: 3, atBottom: true },
        cursor: { visible: true, row: 1, col: 4, position: { row: 1, col: 4 } },
      }),
      surface,
    );

    const snapshot = frameFromBufferSnapshot(state);

    expect(snapshot.rows.map(r => r.index)).toEqual([5, 6, 7]);
    expect(snapshot.cursor?.position).toEqual({ row: 6, col: 4 });
    expect(snapshot.scrollback?.totalRows).toBe(8);
  });

  it('creates a bounded absolute-row interaction window without snapshotting every cached row', () => {
    let state = createTerminalBuffer(surface);
    state = mergeHistoryWindowIntoBuffer(
      state,
      frame(Array.from({ length: 80 }, (_, index) => row(index, `row-${index}`))),
      surface,
      100,
      1_000,
    );

    const interactionFrame = frameFromBufferAbsoluteWindow(state, 120, 10);

    expect(interactionFrame.rows).toHaveLength(10);
    expect(interactionFrame.rows[0]?.index).toBe(120);
    expect(interactionFrame.rows.at(-1)?.index).toBe(129);
    expect(interactionFrame.scrollback?.totalRows).toBe(1_000);
  });

  it('expands buffer selection endpoints to whole wide cells', () => {
    let state = createTerminalBuffer({ cols: 6, rows: 1 });
    state = applyViewportFrameToBuffer(
      state,
      frame([
        {
          index: 0,
          dirty: true,
          cells: [
            { col: 0, text: 'A' },
            { col: 1, width: 2, text: '界' },
            { col: 3, text: 'B' },
          ],
        },
      ]),
      { cols: 6, rows: 1 },
    );

    expect(
      expandTerminalBufferRangeToCellBounds(state, {
        start: { row: 0, col: 2 },
        end: { row: 0, col: 2 },
      }),
    ).toEqual({
      start: { row: 0, col: 1 },
      end: { row: 0, col: 2 },
    });
  });

  it('builds a select-all range from cached buffer rows only', () => {
    let state = createTerminalBuffer(surface);
    state = mergeHistoryWindowIntoBuffer(state, frame([row(0, 'head')]), surface, 10, 20);
    state = mergeHistoryWindowIntoBuffer(state, frame([row(0, 'tail')]), surface, 18, 20);

    expect(selectAllTerminalBufferRange(state)).toEqual({
      start: { row: 10, col: 0 },
      end: { row: 18, col: 19 },
    });
  });

  it('reports whether a frontend scroll window is fully cached', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'one'), row(1, 'two'), row(2, 'three')]),
      surface,
    );

    expect(terminalBufferHasRows(state, 0, 3)).toBe(true);
    expect(terminalBufferHasRows(state, 0, 4)).toBe(false);
    expect(terminalBufferFullyCached(state)).toBe(true);
  });

  it('uses cached ranges to report partial history coverage without walking every row', () => {
    let state = createTerminalBuffer(surface);
    state = mergeHistoryWindowIntoBuffer(
      state,
      frame([row(0, 'head'), row(1, 'next')]),
      surface,
      0,
      8,
    );
    state = mergeHistoryWindowIntoBuffer(state, frame([row(0, 'tail')]), surface, 7, 8);

    expect(state.cachedRanges).toEqual([
      { start: 0, end: 2 },
      { start: 7, end: 8 },
    ]);
    expect(terminalBufferHasRows(state, 0, 2)).toBe(true);
    expect(terminalBufferHasRows(state, 0, 8)).toBe(false);
    expect(terminalBufferFullyCached(state)).toBe(false);
  });

  it('does not mark sparse merged history rows as contiguous coverage', () => {
    let state = createTerminalBuffer(surface);
    state = mergeHistoryWindowIntoBuffer(
      state,
      frame([row(0, 'head'), row(2, 'tail')]),
      surface,
      10,
      20,
    );

    expect([...state.rowsById.keys()].sort((left, right) => left - right)).toEqual([10, 12]);
    expect(state.cachedRanges).toEqual([
      { start: 10, end: 11 },
      { start: 12, end: 13 },
    ]);
    expect(terminalBufferHasRows(state, 10, 3)).toBe(false);
  });

  it('returns the cached range covering a requested row window', () => {
    let state = createTerminalBuffer(surface);
    state = mergeHistoryWindowIntoBuffer(
      state,
      frame([row(0, 'head'), row(1, 'next'), row(2, 'more')]),
      surface,
      10,
      30,
    );

    expect(terminalBufferCachedRangeForRows(state, 11, 2)).toEqual({ start: 10, end: 13 });
    expect(terminalBufferCachedRangeForRows(state, 9, 2)).toBeNull();
    expect(terminalBufferCachedRangeForRows(state, 12, 2)).toBeNull();
  });

  it('recomputes cached ranges after pruning rows past the buffer limit', () => {
    let state = createTerminalBuffer(surface, { rowLimit: 3 });
    state = mergeHistoryWindowIntoBuffer(
      state,
      frame([row(0, 'a'), row(1, 'b'), row(2, 'c'), row(3, 'd')]),
      surface,
      0,
      4,
    );
    state = mergeHistoryWindowIntoBuffer(
      state,
      frame([row(0, 'x'), row(1, 'y'), row(2, 'z')]),
      surface,
      8,
      11,
    );

    expect([...state.rowsById.keys()].sort((left, right) => left - right)).toEqual([8, 9, 10]);
    expect(state.cachedRanges).toEqual([{ start: 8, end: 11 }]);
  });

  it('merges windows into absolute cached rows', () => {
    let state = createTerminalBuffer(surface);
    state = mergeHistoryWindowIntoBuffer(
      state,
      frame([row(0, 'tail-a'), row(1, 'tail-b')], {
        cursor: { visible: true, row: 1, col: 2, position: { row: 1, col: 2 } },
      }),
      surface,
      8,
      10,
    );
    state = mergeHistoryWindowIntoBuffer(
      state,
      frame([row(0, 'head-a'), row(1, 'head-b')]),
      surface,
      0,
      10,
    );

    expect(state.totalRows).toBe(10);
    expect([...state.rowsById.keys()].sort((left, right) => left - right)).toEqual([0, 1, 8, 9]);
    expect(state.cachedRanges).toEqual([
      { start: 0, end: 2 },
      { start: 8, end: 10 },
    ]);
    expect(terminalBufferRowText(state, 0, true)).toBe('head-a');
    expect(terminalBufferRowText(state, 9, true)).toBe('tail-b');
  });

  it('drops stale cached history rows when a replay reports fewer total rows', () => {
    let state = createTerminalBuffer(surface);
    state = mergeHistoryWindowIntoBuffer(
      state,
      frame([row(0, 'old-tail-a'), row(1, 'old-tail-b')]),
      surface,
      8,
      10,
    );

    state = mergeHistoryWindowIntoBuffer(
      state,
      frame([row(0, 'new-head'), row(1, ''), row(2, '')]),
      surface,
      0,
      3,
    );

    expect(state.totalRows).toBe(3);
    expect([...state.rowsById.keys()]).toEqual([0, 1, 2]);
    expect(state.cachedRanges).toEqual([{ start: 0, end: 3 }]);
    expect(terminalBufferRowText(state, 0, true)).toBe('new-head');
  });

  it('reconstructs selection text from absolute cached rows', () => {
    let state = createTerminalBuffer(surface);
    state = applyViewportFrameToBuffer(
      state,
      frame([row(0, 'alpha'), row(1, 'beta'), row(2, 'gamma')], {
        scrollback: { totalRows: 8, viewportOffset: 5, viewportRows: 3, atBottom: true },
      }),
      surface,
    );

    expect(
      terminalBufferSelectionText(state, {
        start: { row: 5, col: 1 },
        end: { row: 6, col: 2 },
      }),
    ).toBe('lpha\nbet');
  });
});
