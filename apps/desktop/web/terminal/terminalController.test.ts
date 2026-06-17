import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionTerminalView } from '../domain';
import type { TerminalSurface } from '../terminalScrollback';
import type {
  TerminalFrame,
  TerminalRenderer,
  TerminalRendererBackend,
  TerminalRow,
} from '../terminalTypes';
import {
  createTerminalBuffer,
  frameFromBufferSnapshot,
  type TerminalBufferState,
} from './bufferModel';
import { createTerminalController } from './terminalController';
import { decodeRowBand } from './wireDecode';

const surface: TerminalSurface = {
  cols: 80,
  rows: 4,
  cellWidth: 8,
  cellHeight: 10,
  fontSize: 14,
  baseline: 8,
  fontFamily: 'monospace',
};

function row(index: number, text = ''): TerminalRow {
  return { index, dirty: true, cells: text ? [{ col: 0, text }] : [] };
}

function rowRange(start: number, endExclusive: number) {
  const rows = new Map<number, TerminalRow>();
  for (let index = start; index < endExclusive; index += 1) {
    rows.set(index, row(index, String(index % 10)));
  }
  return rows;
}

function frame(rows: TerminalRow[]): TerminalFrame {
  return {
    dirty: 'full',
    rows,
    cursor: { visible: false, row: 0, col: 0, position: { row: 0, col: 0 } },
  };
}

function liveFrameAtBottom(offset: number, rows: TerminalRow[]): TerminalFrame {
  return {
    ...frame(rows),
    scrollback: {
      scrollbackRows: offset,
      viewportOffset: offset,
      viewportRows: surface.rows,
      totalRows: offset + surface.rows,
      atBottom: true,
    },
  };
}

function rowText(row: TerminalRow) {
  return row.cells
    .map(cell => cell.text)
    .join('')
    .trim();
}

function fakeRenderer(
  displayRows: number,
  backend: TerminalRendererBackend = 'canvas2d',
): TerminalRenderer {
  return {
    capabilities: {
      backend,
      gpuAccelerated: backend !== 'canvas2d',
      fallback: backend === 'canvas2d',
      explicitResourceManagement: backend !== 'canvas2d',
      retainedPartialPaint: backend === 'canvas2d' || backend === 'webgl2',
    },
    cols: surface.cols,
    rows: displayRows,
    cellWidth: surface.cellWidth,
    cellHeight: surface.cellHeight,
    clear: vi.fn(),
    paintFrame: vi.fn(),
    rowsToPaint: (frame: TerminalFrame) => frame.rows,
  };
}

function canvasWithRendererEvents() {
  const listeners = new Map<string, EventListenerOrEventListenerObject>();
  const addEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    listeners.set(type, listener);
  });
  const removeEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  );
  const canvas = {
    style: {},
    addEventListener,
    removeEventListener,
  } as unknown as HTMLCanvasElement;

  return {
    canvas,
    addEventListener,
    removeEventListener,
    dispatch(type: string, event: Event) {
      const listener = listeners.get(type);
      if (!listener) return;
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    },
  };
}

describe('createTerminalController', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sizes the scroll spacer from the buffer total, not only cached rows', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 0, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 250,
      viewportRows: surface.rows,
      viewportOffset: 246,
      rowsById: rowRange(246, 250),
      cachedRanges: [{ start: 246, end: 250 }],
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 246,
      liveFollow: false,
    };

    controller.applyView(view, surface, buffer);

    expect(spacer.style.height).toBe('2510px');
    expect(spacer.style.width).toBe('640px');
  });

  it('pins live follow to the tail before painting a buffered view', () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      }),
    );

    const onLiveFollow = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow,
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 2510, scrollTop: 2400 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 250,
      viewportRows: surface.rows,
      viewportOffset: 246,
      rowsById: rowRange(246, 250),
      cachedRanges: [{ start: 246, end: 250 }],
      atBottom: true,
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 246,
      liveFollow: true,
    };

    controller.applyView(view, surface, buffer);

    expect(viewport.scrollTop).toBe(2470);
    expect(controller.isAutoScrolling()).toBe(true);
    rafCallbacks.shift()?.(0);
    expect(controller.isAutoScrolling()).toBe(false);
    expect(onLiveFollow).toHaveBeenLastCalledWith(true);
  });

  it('keeps user scroll intent off even when new backend frames are at the tail', () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      }),
    );

    const onLiveFollow = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow,
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrames(
      'session-1',
      [liveFrameAtBottom(20, [row(0, 'one'), row(1, 'two'), row(2, 'three'), row(3, 'four')])],
      true,
    );
    rafCallbacks.shift()?.(0);
    rafCallbacks.shift()?.(0);
    expect(controller.isLiveFollow()).toBe(true);

    controller.setLiveFollow(false);
    onLiveFollow.mockClear();

    controller.ingestFrames(
      'session-1',
      [liveFrameAtBottom(21, [row(0, 'two'), row(1, 'three'), row(2, 'four'), row(3, 'five')])],
      true,
    );

    expect(controller.isLiveFollow()).toBe(false);
    expect(controller.isAutoScrolling()).toBe(false);
    expect(onLiveFollow).toHaveBeenLastCalledWith(false);
  });

  it('does not report an empty seeded launch view as renderable content', () => {
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });

    controller.seedEmptyView('session-1');

    expect(controller.hasRenderableContent('session-1')).toBe(false);
  });

  it('reports renderable content after an active session ingests real rows', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });

    controller.ingestFrames(
      'session-1',
      [liveFrameAtBottom(0, [row(0, ''), row(1, 'ready'), row(2, ''), row(3, '')])],
      true,
    );

    expect(controller.hasRenderableContent('session-1')).toBe(true);
  });

  it('buffers inactive primary frames with their own viewport size', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const visibleSurface = { ...surface, rows: 6 };
    const controller = createTerminalController({
      surface: visibleSurface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 60, scrollHeight: 60, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-bg',
      {
        ...frame([row(0, 'zero'), row(1, 'one'), row(2, 'two'), row(3, 'three')]),
        cols: surface.cols,
        scrollback: {
          totalRows: 4,
          viewportOffset: 0,
          viewportRows: 4,
          atBottom: true,
        },
      },
      false,
    );
    controller.paintCurrent('session-bg', visibleSurface);

    expect(controller.getBufferDebug()).toEqual(
      expect.objectContaining({
        totalRows: 4,
        rowMapSize: 4,
        cachedRanges: [{ start: 0, end: 4 }],
      }),
    );
  });

  it('re-pins a cached live-following session when repainting it as current', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 2510, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrames(
      'session-1',
      [liveFrameAtBottom(246, [row(0, 'one'), row(1, 'two'), row(2, 'three'), row(3, 'four')])],
      true,
    );
    viewport.scrollTop = 0;

    controller.paintCurrent('session-1');

    expect(viewport.scrollTop).toBe(2470);
  });

  it('restores each session to its own scrolled-back position across switches', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    // Both sessions hold 200 rows, so the scroll extent (200*10 + 10 inset) is the
    // same throughout and the assertions read straight off viewport.scrollTop.
    const viewport = { clientHeight: 40, scrollHeight: 2010, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    // Session A: scroll back so its top row is buffer row 30.
    controller.ingestFrame(
      'session-a',
      liveFrameAtBottom(196, [row(0, 'a'), row(1, 'a'), row(2, 'a'), row(3, 'a')]),
      true,
    );
    controller.scrollBufferedToRow(30);
    expect(viewport.scrollTop).toBe(310);
    expect(controller.isLiveFollow()).toBe(false);

    // Session B becomes current, then scrolls back to its own row 80.
    controller.ingestFrame(
      'session-b',
      liveFrameAtBottom(196, [row(0, 'b'), row(1, 'b'), row(2, 'b'), row(3, 'b')]),
      true,
    );
    controller.scrollBufferedToRow(80);
    expect(viewport.scrollTop).toBe(810);

    // Back to A: its remembered position, not B's.
    controller.paintCurrent('session-a');
    expect(viewport.scrollTop).toBe(310);
    expect(controller.isLiveFollow()).toBe(false);

    // Back to B: its own remembered position.
    controller.paintCurrent('session-b');
    expect(viewport.scrollTop).toBe(810);
  });

  it('restores scroll on switch even when a streamed frame marks the session active first', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 2010, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-a',
      liveFrameAtBottom(196, [row(0, 'a'), row(1, 'a'), row(2, 'a'), row(3, 'a')]),
      true,
    );
    controller.scrollBufferedToRow(30);
    expect(viewport.scrollTop).toBe(310);

    controller.ingestFrame(
      'session-b',
      liveFrameAtBottom(196, [row(0, 'b'), row(1, 'b'), row(2, 'b'), row(3, 'b')]),
      true,
    );
    controller.scrollBufferedToRow(70);
    controller.paintCurrent('session-b');
    expect(viewport.scrollTop).toBe(710);

    // Re-select A, but a streamed clean frame for A lands first and marks it the
    // active session (as happens for a session producing output). The switch must
    // still be detected and A restored, not treated as a same-session repaint.
    controller.ingestFrame(
      'session-a',
      {
        ...frame([]),
        dirty: 'clean',
        scrollback: { totalRows: 200, viewportOffset: 196, viewportRows: 4, atBottom: false },
      },
      true,
    );
    controller.paintCurrent('session-a');

    expect(viewport.scrollTop).toBe(310);
  });

  it('makes a relaunched session forget its prior scroll anchor and re-follow the tail', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 2010, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    // A is scrolled back: a stable-id anchor and a not-following intent are stored.
    controller.ingestFrame(
      'session-a',
      liveFrameAtBottom(196, [row(0, 'a'), row(1, 'a'), row(2, 'a'), row(3, 'a')]),
      true,
    );
    controller.scrollBufferedToRow(30);
    expect(viewport.scrollTop).toBe(310);
    expect(controller.isLiveFollow()).toBe(false);

    // Move to B so returning to A later is a genuine switch.
    controller.ingestFrame(
      'session-b',
      liveFrameAtBottom(196, [row(0, 'b'), row(1, 'b'), row(2, 'b'), row(3, 'b')]),
      true,
    );

    // A's process exits and is relaunched: seedEmptyView resets its per-session
    // scroll memory. The resumed conversation then streams in while B is shown.
    controller.seedEmptyView('session-a');
    controller.ingestFrame(
      'session-a',
      liveFrameAtBottom(196, [row(0, 'a2'), row(1, 'a2'), row(2, 'a2'), row(3, 'a2')]),
      false,
    );

    // Returning to A follows the new tail, not the stale row-30 anchor.
    controller.paintCurrent('session-a');
    expect(viewport.scrollTop).toBe(1970);
    expect(controller.isLiveFollow()).toBe(true);
  });

  it('returns a session that was at the bottom to the live tail after a detour', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 2010, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    // Session A stays pinned to the tail (never scrolled back).
    controller.ingestFrame(
      'session-a',
      liveFrameAtBottom(196, [row(0, 'a'), row(1, 'a'), row(2, 'a'), row(3, 'a')]),
      true,
    );
    expect(viewport.scrollTop).toBe(1970);
    expect(controller.isLiveFollow()).toBe(true);

    // Detour through B, scrolled back.
    controller.ingestFrame(
      'session-b',
      liveFrameAtBottom(196, [row(0, 'b'), row(1, 'b'), row(2, 'b'), row(3, 'b')]),
      true,
    );
    controller.scrollBufferedToRow(50);
    expect(viewport.scrollTop).toBe(510);

    // Returning to A re-pins the tail; it is not left at B's offset.
    controller.paintCurrent('session-a');
    expect(viewport.scrollTop).toBe(1970);
    expect(controller.isLiveFollow()).toBe(true);
  });

  it('coalesces scheduled scroll paints into one animation frame', () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      }),
    );

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 2510, scrollTop: 2400 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 250,
      viewportRows: surface.rows,
      viewportOffset: 246,
      rowsById: rowRange(240, 250),
      cachedRanges: [{ start: 240, end: 250 }],
    };
    controller.applyView(
      {
        lastFrame: null,
        compositeFrame: frameFromBufferSnapshot(buffer),
        scrollbackRows: [],
        rowCount: 246,
        liveFollow: false,
      },
      surface,
      buffer,
    );
    rafCallbacks.length = 0;
    paintFrame.mockClear();

    controller.schedulePaintWindow();
    controller.schedulePaintWindow();

    expect(rafCallbacks).toHaveLength(1);
    expect(paintFrame).not.toHaveBeenCalled();
    rafCallbacks[0]?.(0);
    expect(paintFrame).toHaveBeenCalledTimes(1);
  });

  it('publishes paint samples for scheduled scroll repaints', () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      }),
    );

    const onPaintSample = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      onPaintSample,
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });
    controller.paintFrame(frame([row(0, 'a'), row(1, 'b')]));
    rafCallbacks.length = 0;
    onPaintSample.mockClear();

    controller.schedulePaintWindow();
    rafCallbacks[0]?.(0);

    expect(onPaintSample).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'canvas2d',
        reason: 'scroll',
        bufferBacked: false,
        rowsPainted: 4,
        cellsPainted: 2,
      }),
    );
  });

  it('remounts and repaints after a WebGL context restore', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrames: ReturnType<typeof vi.fn>[] = [];
    const clears: ReturnType<typeof vi.fn>[] = [];
    const disposes: ReturnType<typeof vi.fn>[] = [];
    const createRenderer = vi.fn((_canvas, _surface, displayRows) => {
      const paintFrame = vi.fn();
      const clear = vi.fn();
      const dispose = vi.fn();
      paintFrames.push(paintFrame);
      clears.push(clear);
      disposes.push(dispose);
      return {
        ...fakeRenderer(displayRows),
        capabilities: {
          backend: 'webgl2' as const,
          gpuAccelerated: true,
          fallback: false,
          explicitResourceManagement: true,
          retainedPartialPaint: false,
        },
        clear,
        paintFrame,
        dispose,
      };
    });
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer,
    });
    const events = canvasWithRendererEvents();
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas: events.canvas, viewport, spacer });
    controller.paintFrame(frame([row(0, 'a'), row(1, 'b')]));

    expect(createRenderer).toHaveBeenCalledTimes(1);
    paintFrames[0]?.mockClear();
    clears[0]?.mockClear();

    const lostEvent = { preventDefault: vi.fn() } as unknown as Event;
    events.dispatch('webglcontextlost', lostEvent);
    expect(lostEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(disposes[0]).toHaveBeenCalledTimes(1);
    expect(createRenderer).toHaveBeenCalledTimes(1);
    expect(controller.tryMountRenderer()).toBe(false);
    controller.paintFrame(frame([row(0, 'while-lost')]));
    expect(createRenderer).toHaveBeenCalledTimes(1);

    events.dispatch('webglcontextrestored', { preventDefault: vi.fn() } as unknown as Event);

    expect(createRenderer).toHaveBeenCalledTimes(2);
    expect(clears[1]).not.toHaveBeenCalled();
    expect(paintFrames[1]).toHaveBeenCalledTimes(1);
    expect((paintFrames[1]?.mock.calls[0]?.[0] as TerminalFrame).rows.map(rowText)).toEqual([
      'while-lost',
      '',
      '',
      '',
    ]);
  });

  it('repaints a buffered window from the frontend cache after WebGL context restore', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrames: ReturnType<typeof vi.fn>[] = [];
    const disposes: ReturnType<typeof vi.fn>[] = [];
    const createRenderer = vi.fn((_canvas, _surface, displayRows) => {
      const paintFrame = vi.fn();
      const dispose = vi.fn();
      paintFrames.push(paintFrame);
      disposes.push(dispose);
      return {
        ...fakeRenderer(displayRows),
        capabilities: {
          backend: 'webgl2' as const,
          gpuAccelerated: true,
          fallback: false,
          explicitResourceManagement: true,
          retainedPartialPaint: false,
        },
        paintFrame,
        dispose,
      };
    });
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer,
    });
    const events = canvasWithRendererEvents();
    const viewport = { clientHeight: 40, scrollHeight: 1010, scrollTop: 520 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas: events.canvas, viewport, spacer });

    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 100,
      viewportRows: surface.rows,
      viewportOffset: 96,
      rowsById: rowRange(40, 70),
      cachedRanges: [{ start: 40, end: 70 }],
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 96,
      liveFollow: false,
    };
    controller.applyView(view, surface, buffer);
    expect(createRenderer).toHaveBeenCalledTimes(1);
    paintFrames[0]?.mockClear();

    events.dispatch('webglcontextlost', { preventDefault: vi.fn() } as unknown as Event);
    expect(disposes[0]).toHaveBeenCalledTimes(1);
    events.dispatch('webglcontextrestored', { preventDefault: vi.fn() } as unknown as Event);

    expect(createRenderer).toHaveBeenCalledTimes(2);
    expect(paintFrames[1]).toHaveBeenCalledTimes(1);
    const painted = paintFrames[1]?.mock.calls[0]?.[0] as TerminalFrame;
    expect(painted.rows).toHaveLength(12);
    expect(painted.rows[0]?.index).toBe(0);
    expect(painted.rows.map(rowText)).toEqual([
      '7',
      '8',
      '9',
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
    ]);
  });

  it('accepts an async renderer factory and repaints the latest composite when it resolves', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    let resolveRenderer: (renderer: TerminalRenderer) => void = () => {};
    const rendererPromise = new Promise<TerminalRenderer>(resolve => {
      resolveRenderer = resolve;
    });
    const createRenderer = vi.fn(() => rendererPromise);
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer,
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.paintFrame(frame([row(0, 'first')]));
    controller.paintFrame(frame([row(0, 'second')]));

    expect(createRenderer).toHaveBeenCalledTimes(1);
    expect(paintFrame).not.toHaveBeenCalled();

    resolveRenderer({
      ...fakeRenderer(surface.rows),
      paintFrame,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(paintFrame).toHaveBeenCalledTimes(1);
    expect((paintFrame.mock.calls[0]?.[0] as TerminalFrame).rows.map(rowText)).toEqual([
      'second',
      '',
      '',
      '',
    ]);
  });

  it('disposes an async renderer that resolves after the canvas changes', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const dispose = vi.fn();
    let resolveRenderer: (renderer: TerminalRenderer) => void = () => {};
    const rendererPromise = new Promise<TerminalRenderer>(resolve => {
      resolveRenderer = resolve;
    });
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: vi.fn(() => rendererPromise),
    });
    const first = canvasWithRendererEvents();
    const second = canvasWithRendererEvents();
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas: first.canvas, viewport, spacer });
    controller.paintFrame(frame([row(0, 'first')]));
    controller.attach({ canvas: second.canvas, viewport, spacer });

    resolveRenderer({
      ...fakeRenderer(surface.rows),
      paintFrame,
      dispose,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(paintFrame).not.toHaveBeenCalled();
  });

  it('disposes an async renderer that resolves after surface geometry changes', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const dispose = vi.fn();
    let resolveRenderer: (renderer: TerminalRenderer) => void = () => {};
    const rendererPromise = new Promise<TerminalRenderer>(resolve => {
      resolveRenderer = resolve;
    });
    const createRenderer = vi.fn(() => rendererPromise);
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer,
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.paintFrame(frame([row(0, 'first')]));
    controller.setSurface({ ...surface, cols: 81 });

    resolveRenderer({
      ...fakeRenderer(surface.rows),
      paintFrame,
      dispose,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(paintFrame).not.toHaveBeenCalled();
  });

  it('mounts a fresh async renderer after a pending surface-change renderer is invalidated', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const staleDispose = vi.fn();
    const freshPaintFrame = vi.fn();
    let resolveStale: (renderer: TerminalRenderer) => void = () => {};
    let resolveFresh: (renderer: TerminalRenderer) => void = () => {};
    const stalePromise = new Promise<TerminalRenderer>(resolve => {
      resolveStale = resolve;
    });
    const freshPromise = new Promise<TerminalRenderer>(resolve => {
      resolveFresh = resolve;
    });
    const rendererPromises = [stalePromise, freshPromise];
    const createRenderer = vi.fn(
      (_canvas: HTMLCanvasElement, _surface: TerminalSurface, _displayRows: number) => {
        const next = rendererPromises.shift();
        if (!next) throw new Error('unexpected renderer mount');
        return next;
      },
    );
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer,
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.paintFrame(frame([row(0, 'first')]));
    const nextSurface = { ...surface, cols: 81 };
    controller.setSurface(nextSurface);
    controller.paintCurrent(null, nextSurface);

    resolveStale({
      ...fakeRenderer(surface.rows),
      dispose: staleDispose,
    });
    resolveFresh({
      ...fakeRenderer(surface.rows),
      cols: 81,
      paintFrame: freshPaintFrame,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(staleDispose).toHaveBeenCalledTimes(1);
    expect(freshPaintFrame).toHaveBeenCalledTimes(1);
    expect(createRenderer).toHaveBeenCalledTimes(2);
    expect(createRenderer.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ cols: 81 }));
  });

  it('disposes an async renderer that resolves after device pixel ratio changes', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    vi.stubGlobal('window', { devicePixelRatio: 1 });

    const paintFrame = vi.fn();
    const dispose = vi.fn();
    let resolveRenderer: (renderer: TerminalRenderer) => void = () => {};
    const rendererPromise = new Promise<TerminalRenderer>(resolve => {
      resolveRenderer = resolve;
    });
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: vi.fn(() => rendererPromise),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.paintFrame(frame([row(0, 'first')]));
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });

    resolveRenderer({
      ...fakeRenderer(surface.rows),
      paintFrame,
      dispose,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(paintFrame).not.toHaveBeenCalled();
  });

  it('mounts a fresh async renderer after a pending DPR-change renderer is rejected', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    vi.stubGlobal('window', { devicePixelRatio: 1 });

    const staleDispose = vi.fn();
    const freshPaintFrame = vi.fn();
    let resolveStale: (renderer: TerminalRenderer) => void = () => {};
    let resolveFresh: (renderer: TerminalRenderer) => void = () => {};
    const stalePromise = new Promise<TerminalRenderer>(resolve => {
      resolveStale = resolve;
    });
    const freshPromise = new Promise<TerminalRenderer>(resolve => {
      resolveFresh = resolve;
    });
    const rendererPromises = [stalePromise, freshPromise];
    const createRenderer = vi.fn(
      (_canvas: HTMLCanvasElement, _surface: TerminalSurface, _displayRows: number) => {
        const next = rendererPromises.shift();
        if (!next) throw new Error('unexpected renderer mount');
        return next;
      },
    );
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer,
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.paintFrame(frame([row(0, 'first')]));
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    controller.paintFrame(frame([row(0, 'second')]));

    resolveStale({
      ...fakeRenderer(surface.rows),
      dispose: staleDispose,
    });
    resolveFresh({
      ...fakeRenderer(surface.rows),
      paintFrame: freshPaintFrame,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(staleDispose).toHaveBeenCalledTimes(1);
    expect(freshPaintFrame).toHaveBeenCalledTimes(1);
    expect(createRenderer).toHaveBeenCalledTimes(2);
  });

  it('moves renderer lifecycle listeners when the canvas changes', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const first = canvasWithRendererEvents();
    const second = canvasWithRendererEvents();
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;

    controller.attach({ canvas: first.canvas, viewport, spacer });
    controller.attach({ canvas: second.canvas, viewport, spacer });

    expect(first.addEventListener).toHaveBeenCalledWith('webglcontextlost', expect.any(Function));
    expect(first.addEventListener).toHaveBeenCalledWith(
      'webglcontextrestored',
      expect.any(Function),
    );
    expect(first.removeEventListener).toHaveBeenCalledWith(
      'webglcontextlost',
      expect.any(Function),
    );
    expect(first.removeEventListener).toHaveBeenCalledWith(
      'webglcontextrestored',
      expect.any(Function),
    );
    expect(second.addEventListener).toHaveBeenCalledWith('webglcontextlost', expect.any(Function));
    expect(second.addEventListener).toHaveBeenCalledWith(
      'webglcontextrestored',
      expect.any(Function),
    );
  });

  it('disposes the mounted renderer when the canvas changes', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const dispose = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        dispose,
      }),
    });
    const first = canvasWithRendererEvents();
    const second = canvasWithRendererEvents();
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;

    controller.attach({ canvas: first.canvas, viewport, spacer });
    controller.tryMountRenderer();
    controller.attach({ canvas: second.canvas, viewport, spacer });

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('remounts the renderer when cell geometry changes without a row or column change', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const disposes: ReturnType<typeof vi.fn>[] = [];
    const createRenderer = vi.fn((_canvas, nextSurface: TerminalSurface, displayRows) => {
      const dispose = vi.fn();
      disposes.push(dispose);
      return {
        ...fakeRenderer(displayRows),
        cellWidth: nextSurface.cellWidth,
        cellHeight: nextSurface.cellHeight,
        dispose,
      };
    });
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer,
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.paintFrame(frame([row(0, 'a')]));
    controller.setSurface({ ...surface, cellWidth: 10, cellHeight: 12 });
    controller.paintFrame(frame([row(0, 'b')]));

    expect(createRenderer).toHaveBeenCalledTimes(2);
    expect(disposes[0]).toHaveBeenCalledTimes(1);
    expect(createRenderer.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ cellWidth: 10, cellHeight: 12 }),
    );
  });

  it('remounts the renderer when device pixel ratio changes', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    vi.stubGlobal('window', { devicePixelRatio: 1 });

    const disposes: ReturnType<typeof vi.fn>[] = [];
    const createRenderer = vi.fn((_canvas, _surface, displayRows) => {
      const dispose = vi.fn();
      disposes.push(dispose);
      return {
        ...fakeRenderer(displayRows),
        dispose,
      };
    });
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer,
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.paintFrame(frame([row(0, 'a')]));
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    controller.paintFrame(frame([row(0, 'b')]));

    expect(createRenderer).toHaveBeenCalledTimes(2);
    expect(disposes[0]).toHaveBeenCalledTimes(1);
  });

  it('focuses the terminal text input before falling back to the canvas', () => {
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {}, focus: vi.fn() } as unknown as HTMLCanvasElement;
    const input = { focus: vi.fn() } as unknown as HTMLTextAreaElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;

    controller.attach({ canvas, viewport, spacer, input });
    controller.focusCanvas();

    expect(input.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(canvas.focus).not.toHaveBeenCalled();

    controller.attach({ canvas, viewport, spacer, input: null });
    controller.focusCanvas();

    expect(canvas.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('positions the terminal text input on the rendered cursor cell', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const input = { style: {} } as HTMLTextAreaElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer, input });

    controller.paintFrame({
      ...frame([row(0, 'a'), row(1, 'b'), row(2, 'c')]),
      cursor: { visible: true, row: 2, col: 3, position: { row: 2, col: 3 } },
    });

    expect(input.style.left).toBe('24px');
    expect(input.style.top).toBe('30px');
    expect(input.style.width).toBe('8px');
    expect(input.style.height).toBe('10px');
  });

  it('repaints only overlay rows when selection changes inside the same window', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const clear = vi.fn();
    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        clear,
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });
    controller.paintFrame(frame([row(0, 'a'), row(1, 'b'), row(2, 'c'), row(3, 'd')]));
    clear.mockClear();
    paintFrame.mockClear();

    controller.setSelection({
      start: { row: 1, col: 0 },
      end: { row: 1, col: 0 },
    });

    expect(clear).not.toHaveBeenCalled();
    expect(paintFrame).toHaveBeenCalledTimes(1);
    expect((paintFrame.mock.calls[0]?.[0] as TerminalFrame).dirty).toBe('partial');
    expect((paintFrame.mock.calls[0]?.[0] as TerminalFrame).rows.map(row => row.index)).toEqual([
      1,
    ]);

    paintFrame.mockClear();
    controller.setSelection({
      start: { row: 2, col: 0 },
      end: { row: 2, col: 0 },
    });

    expect(clear).not.toHaveBeenCalled();
    expect((paintFrame.mock.calls[0]?.[0] as TerminalFrame).dirty).toBe('partial');
    expect((paintFrame.mock.calls[0]?.[0] as TerminalFrame).rows.map(row => row.index)).toEqual([
      1, 2,
    ]);

    paintFrame.mockClear();
    controller.clearSelection();

    expect(clear).not.toHaveBeenCalled();
    expect((paintFrame.mock.calls[0]?.[0] as TerminalFrame).dirty).toBe('partial');
    expect((paintFrame.mock.calls[0]?.[0] as TerminalFrame).rows.map(row => row.index)).toEqual([
      2,
    ]);
  });

  it('expands selection overlays to whole wide cells', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });
    controller.paintFrame(
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
    );
    paintFrame.mockClear();

    controller.setSelection({
      start: { row: 0, col: 2 },
      end: { row: 0, col: 2 },
    });

    expect(controller.getSelection()).toEqual({
      start: { row: 0, col: 1 },
      end: { row: 0, col: 2 },
    });
    expect(paintFrame.mock.calls[0]?.[1]?.selection).toEqual([{ row: 0, startCol: 1, endCol: 3 }]);
  });

  it('preserves every frame in a coalesced ingestion batch but paints once', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 0, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrames(
      'session-1',
      [
        {
          ...frame([row(0, 'one')]),
          dirty: 'partial',
        },
        {
          ...frame([row(1, 'two')]),
          dirty: 'partial',
        },
      ],
      true,
    );

    expect(paintFrame).toHaveBeenCalledTimes(1);
    const painted = paintFrame.mock.calls[0]?.[0] as TerminalFrame;
    expect(painted.rows).toHaveLength(12);
    expect(painted.rows.slice(0, 4).map(rowText)).toEqual(['one', 'two', '', '']);
  });

  it('paints only dirty primary-buffer rows plus cursor rows after partial frames', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'zero'), row(1, 'one'), row(2, 'two'), row(3, 'three')]),
        cursor: { visible: true, row: 0, col: 0, position: { row: 0, col: 0 } },
      },
      true,
    );
    paintFrame.mockClear();

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(2, 'TWO')]),
        dirty: 'partial',
        cursor: { visible: true, row: 1, col: 0, position: { row: 1, col: 0 } },
      },
      true,
    );

    const painted = paintFrame.mock.calls[0]?.[0] as TerminalFrame;
    expect(painted.dirty).toBe('partial');
    expect(painted.rows.map(row => row.index)).toEqual([0, 1, 2]);
    expect(painted.rows.map(rowText)).toEqual(['zero', 'one', 'TWO']);
  });

  it('paints a full live-buffer window for non-retained GPU partial updates', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => {
        const renderer = fakeRenderer(displayRows, 'webgl2');
        return {
          ...renderer,
          capabilities: {
            ...renderer.capabilities,
            retainedPartialPaint: false,
          },
          paintFrame,
        };
      },
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      frame([row(0, 'zero'), row(1, 'one'), row(2, 'two'), row(3, 'three')]),
      true,
    );
    paintFrame.mockClear();

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(2, 'TWO')]),
        dirty: 'partial',
      },
      true,
    );

    const painted = paintFrame.mock.calls[0]?.[0] as TerminalFrame;
    expect(painted.dirty).toBe('full');
    expect(painted.rows.slice(0, 4).map(rowText)).toEqual(['zero', 'one', 'TWO', 'three']);
  });

  it('uses retained partial-paint capability instead of backend name', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => {
        const renderer = fakeRenderer(displayRows, 'webgl2');
        return {
          ...renderer,
          capabilities: {
            ...renderer.capabilities,
            retainedPartialPaint: true,
          },
          paintFrame,
        };
      },
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      frame([row(0, 'zero'), row(1, 'one'), row(2, 'two'), row(3, 'three')]),
      true,
    );
    paintFrame.mockClear();

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(2, 'TWO')]),
        dirty: 'partial',
      },
      true,
    );

    const painted = paintFrame.mock.calls[0]?.[0] as TerminalFrame;
    expect(painted.dirty).toBe('partial');
    expect(painted.rows.map(rowText)).toEqual(['TWO']);
  });

  it('does not schedule a tail repaint when retained partial paint is already aligned', () => {
    const requestAnimationFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows, 'webgl2'),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      frame([row(0, 'zero'), row(1, 'one'), row(2, 'two'), row(3, 'three')]),
      true,
    );
    requestAnimationFrame.mockClear();
    paintFrame.mockClear();

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(2, 'TWO')]),
        dirty: 'partial',
      },
      true,
    );

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(paintFrame).toHaveBeenCalledTimes(1);
    expect((paintFrame.mock.calls[0]?.[0] as TerminalFrame).dirty).toBe('partial');
  });

  it('does not repaint the active primary buffer for clean frames', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame('session-1', frame([row(0, 'stable')]), true);
    paintFrame.mockClear();

    controller.ingestFrame(
      'session-1',
      {
        ...frame([]),
        dirty: 'clean',
        scrollback: { totalRows: 4, viewportOffset: 0, viewportRows: 4, atBottom: true },
      },
      true,
    );

    expect(paintFrame).not.toHaveBeenCalled();
    expect(controller.getComposite()?.rows.map(rowText)).toEqual(['stable', '', '', '']);
  });

  it('updates live-buffer scroll metadata for clean off-screen output without repainting', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const onScrollbackRowCount = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount,
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 1010, scrollTop: 410 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'scrolled'), row(1, 'stable'), row(2, 'viewport'), row(3, 'rows')]),
        scrollback: { totalRows: 100, viewportOffset: 40, viewportRows: 4, atBottom: false },
      },
      true,
    );
    paintFrame.mockClear();
    onScrollbackRowCount.mockClear();

    controller.ingestFrame(
      'session-1',
      {
        ...frame([]),
        dirty: 'clean',
        scrollback: { totalRows: 110, viewportOffset: 40, viewportRows: 4, atBottom: false },
      },
      true,
    );

    expect(paintFrame).not.toHaveBeenCalled();
    expect(controller.getRowCount()).toBe(110);
    expect(spacer.style.height).toBe('1110px');
    expect(onScrollbackRowCount).toHaveBeenLastCalledWith(106);
  });

  it('repaints clean buffered metadata when the painted window no longer covers the viewport', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const onMissingLiveRows = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      onMissingLiveRows,
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewportState = { clientHeight: 40, scrollHeight: 2010, scrollTop: 0 };
    const viewport = viewportState as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.seedEmptyView('session-1');
    controller.paintCurrent('session-1');
    controller.setLiveFollow(false);
    viewportState.scrollTop = 0;
    paintFrame.mockClear();
    onMissingLiveRows.mockClear();

    const transcriptFrames: TerminalFrame[] = [];
    for (let offset = 0; offset <= 120; offset += surface.rows) {
      transcriptFrames.push({
        ...frame(
          Array.from({ length: surface.rows }, (_, localRow) =>
            row(localRow, `abs-${offset + localRow}`),
          ),
        ),
        scrollback: {
          totalRows: 200,
          viewportOffset: offset,
          viewportRows: surface.rows,
          atBottom: false,
        },
      });
    }
    controller.ingestFrames('session-1', transcriptFrames, true);
    expect(controller.getStartRow()).toBe(0);

    paintFrame.mockClear();
    onMissingLiveRows.mockClear();
    viewportState.scrollTop = 810;
    controller.ingestFrame(
      'session-1',
      {
        ...frame([]),
        dirty: 'clean',
        scrollback: {
          totalRows: 200,
          viewportOffset: 120,
          viewportRows: surface.rows,
          atBottom: false,
        },
      },
      true,
    );

    expect(onMissingLiveRows).not.toHaveBeenCalled();
    expect(paintFrame).toHaveBeenCalledTimes(1);
    expect(controller.getStartRow()).toBe(76);
    expect(canvas.style.top).toBe('770px');
    expect((paintFrame.mock.calls[0]?.[0] as TerminalFrame).rows.map(rowText)).toEqual([
      'abs-76',
      'abs-77',
      'abs-78',
      'abs-79',
      'abs-80',
      'abs-81',
      'abs-82',
      'abs-83',
      'abs-84',
      'abs-85',
      'abs-86',
      'abs-87',
    ]);
  });

  it('repaints when clean live metadata moves the followed tail', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 210, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      liveFrameAtBottom(16, [row(0, 'one'), row(1, 'two'), row(2, 'three'), row(3, 'four')]),
      true,
    );
    expect(viewport.scrollTop).toBe(170);

    paintFrame.mockClear();
    viewport.scrollTop = 120;
    controller.ingestFrame(
      'session-1',
      {
        ...frame([]),
        dirty: 'clean',
        scrollback: { totalRows: 20, viewportOffset: 16, viewportRows: 4, atBottom: true },
      },
      true,
    );

    expect(viewport.scrollTop).toBe(170);
    expect(paintFrame).toHaveBeenCalled();
  });

  it('paints alternate screen frames without overwriting the primary scroll cache', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 0, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame('session-1', frame([row(0, 'primary')]), true);

    paintFrame.mockClear();
    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'alternate')]),
        modes: { alternateScreen: true },
      },
      true,
    );

    expect((paintFrame.mock.calls[0]?.[0] as TerminalFrame).rows.map(rowText)).toEqual([
      'alternate',
      '',
      '',
      '',
    ]);

    paintFrame.mockClear();
    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(1, 'primary two')]),
        dirty: 'partial',
        modes: { alternateScreen: false },
      },
      true,
    );

    expect((paintFrame.mock.calls[0]?.[0] as TerminalFrame).rows.slice(0, 4).map(rowText)).toEqual([
      'primary',
      'primary two',
      '',
      '',
    ]);
  });

  it('keeps alternate-screen scroll-away intent until primary output resumes', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const onLiveFollow = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow,
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      liveFrameAtBottom(20, [row(0, 'one'), row(1, 'two'), row(2, 'three'), row(3, 'four')]),
      true,
    );
    controller.setLiveFollow(false);
    onLiveFollow.mockClear();

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'alternate')]),
        modes: { alternateScreen: true },
      },
      true,
    );

    expect(controller.isLiveFollow()).toBe(false);
    expect(onLiveFollow).toHaveBeenLastCalledWith(false);

    controller.ingestFrame(
      'session-1',
      {
        ...liveFrameAtBottom(21, [row(0, 'two'), row(1, 'three'), row(2, 'four'), row(3, 'five')]),
        modes: { alternateScreen: false },
      },
      true,
    );

    expect(controller.isLiveFollow()).toBe(false);
    expect(onLiveFollow).toHaveBeenLastCalledWith(false);
  });

  it('paints a full alternate-screen frame over the primary buffer', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const clear = vi.fn();
    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        clear,
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame('session-1', frame([row(0, 'primary'), row(1, 'kept')]), true);
    clear.mockClear();
    paintFrame.mockClear();

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(3, 'alternate prompt')]),
        dirty: 'partial',
        modes: { alternateScreen: true },
      },
      true,
    );

    expect(clear).not.toHaveBeenCalled();
    const painted = paintFrame.mock.calls[0]?.[0] as TerminalFrame;
    expect(painted.dirty).toBe('full');
    expect(painted.rows.map(rowText)).toEqual(['', '', '', 'alternate prompt']);
  });

  it('preserves alternate-screen clean rows across partial redraws', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'old status'), row(1, 'stable details')]),
        modes: { alternateScreen: true },
      },
      true,
    );
    paintFrame.mockClear();

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'new status')]),
        dirty: 'partial',
        modes: { alternateScreen: true },
      },
      true,
    );

    const composite = controller.getComposite();
    expect(composite?.rows.map(rowText)).toEqual(['new status', 'stable details', '', '']);
    const painted = paintFrame.mock.calls[0]?.[0] as TerminalFrame;
    expect(painted.dirty).toBe('partial');
    expect(painted.rows.map(rowText)).toEqual(['new status']);
  });

  it('keeps WebGL alternate-screen partial updates retained in the backbuffer', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows, 'webgl2'),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'zero'), row(1, 'one'), row(2, 'two'), row(3, 'three')]),
        modes: { alternateScreen: true },
      },
      true,
    );
    paintFrame.mockClear();

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(2, 'TWO')]),
        dirty: 'partial',
        modes: { alternateScreen: true },
      },
      true,
    );

    const painted = paintFrame.mock.calls[0]?.[0] as TerminalFrame;
    expect(painted.dirty).toBe('partial');
    expect(painted.rows.map(row => row.index)).toEqual([2]);
    expect(painted.rows.map(rowText)).toEqual(['TWO']);
  });

  it('does not repaint the active alternate screen for clean frames', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'stable status')]),
        modes: { alternateScreen: true },
      },
      true,
    );
    paintFrame.mockClear();

    controller.ingestFrame(
      'session-1',
      {
        ...frame([]),
        dirty: 'clean',
        modes: { alternateScreen: true },
      },
      true,
    );

    expect(paintFrame).not.toHaveBeenCalled();
    expect(controller.getComposite()?.rows.map(rowText)).toEqual(['stable status', '', '', '']);
  });

  it('preserves an inactive alternate screen when its latest frame is clean', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'stable status'), row(1, 'stable details')]),
        modes: { alternateScreen: true },
      },
      false,
    );
    controller.ingestFrame(
      'session-1',
      {
        ...frame([]),
        dirty: 'clean',
        modes: { alternateScreen: true },
      },
      false,
    );

    controller.paintCurrent('session-1');

    expect(controller.getComposite()?.rows.map(rowText)).toEqual([
      'stable status',
      'stable details',
      '',
      '',
    ]);
  });

  it('preserves every alternate-screen frame in a coalesced ingestion batch', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'first old'), row(1, 'second old'), row(2, 'stable')]),
        modes: { alternateScreen: true },
      },
      true,
    );
    paintFrame.mockClear();

    controller.ingestFrames(
      'session-1',
      [
        {
          ...frame([row(0, 'first new')]),
          dirty: 'partial',
          modes: { alternateScreen: true },
        },
        {
          ...frame([row(1, 'second new')]),
          dirty: 'partial',
          modes: { alternateScreen: true },
        },
      ],
      true,
    );

    expect(paintFrame).toHaveBeenCalledTimes(1);
    expect(controller.getComposite()?.rows.map(rowText)).toEqual([
      'first new',
      'second new',
      'stable',
      '',
    ]);
    const painted = paintFrame.mock.calls[0]?.[0] as TerminalFrame;
    expect(painted.rows.map(rowText)).toEqual(['first new', 'second new']);
  });

  it('preserves alternate-screen composite state across a surface resize', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'base zero'), row(1, 'stable one'), row(2, 'base two')]),
        modes: { alternateScreen: true },
      },
      true,
    );
    controller.ingestFrames(
      'session-1',
      [
        {
          ...frame([row(0, 'updated zero')]),
          dirty: 'partial',
          modes: { alternateScreen: true },
        },
        {
          ...frame([row(2, 'updated two')]),
          dirty: 'partial',
          modes: { alternateScreen: true },
        },
      ],
      true,
    );

    const resized = { ...surface, rows: 6 };
    controller.setSurface(resized);
    controller.paintCurrent('session-1', resized);

    expect(controller.getComposite()?.rows.slice(0, 3).map(rowText)).toEqual([
      'updated zero',
      'stable one',
      'updated two',
    ]);
  });

  it('preserves alternate-screen rows when a sparse full frame lands during resize reflow', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'old header'), row(1, 'stable one'), row(2, 'stable two')]),
        modes: { alternateScreen: true },
      },
      true,
    );

    const resized = { ...surface, cols: 100 };
    controller.setSurface(resized);
    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'new header')]),
        modes: { alternateScreen: true },
      },
      true,
    );

    expect(controller.getComposite()?.rows.slice(0, 4).map(rowText)).toEqual([
      'new header',
      'stable one',
      'stable two',
      '',
    ]);
    const painted = paintFrame.mock.calls.at(-1)?.[0] as TerminalFrame;
    expect(painted.rows.slice(0, 3).map(rowText)).toEqual([
      'new header',
      'stable one',
      'stable two',
    ]);
  });

  it('preserves alternate-screen rows when a sparse partial frame lands during resize reflow', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'old header'), row(1, 'stable one'), row(2, 'stable two')]),
        modes: { alternateScreen: true },
      },
      true,
    );

    const resized = { ...surface, cols: 100, rows: 6 };
    controller.setSurface(resized);
    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'new header')]),
        dirty: 'partial',
        modes: { alternateScreen: true },
      },
      true,
    );

    expect(controller.getComposite()?.rows.slice(0, 6).map(rowText)).toEqual([
      'new header',
      'stable one',
      'stable two',
      '',
      '',
      '',
    ]);
    const painted = paintFrame.mock.calls.at(-1)?.[0] as TerminalFrame;
    expect(painted.dirty).toBe('full');
    expect(painted.rows.slice(0, 3).map(rowText)).toEqual([
      'new header',
      'stable one',
      'stable two',
    ]);
  });

  it('preserves background alternate-screen state for later activation', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrames(
      'session-1',
      [
        {
          ...frame([row(0, 'background old'), row(1, 'background stable')]),
          modes: { alternateScreen: true },
        },
        {
          ...frame([row(0, 'background new')]),
          dirty: 'partial',
          modes: { alternateScreen: true },
        },
      ],
      false,
    );

    expect(paintFrame).not.toHaveBeenCalled();
    controller.paintCurrent('session-1');

    expect((paintFrame.mock.calls[0]?.[0] as TerminalFrame).rows.map(rowText)).toEqual([
      'background new',
      'background stable',
      '',
      '',
    ]);
  });

  it('preserves the live row cache across height-only surface resizes', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        rows: displayRows,
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 50, scrollHeight: 50, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'one'), row(1, 'two'), row(2, 'three'), row(3, 'four')]),
        scrollback: { totalRows: 5, viewportOffset: 1, viewportRows: 4, atBottom: true },
      },
      true,
    );

    controller.setSurface({ ...surface, rows: 5 });
    paintFrame.mockClear();
    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'zero')]),
        dirty: 'partial',
        scrollback: { totalRows: 5, viewportOffset: 0, viewportRows: 5, atBottom: true },
      },
      true,
    );

    expect((paintFrame.mock.calls[0]?.[0] as TerminalFrame).rows.slice(0, 5).map(rowText)).toEqual([
      'zero',
      'one',
      'two',
      'three',
      'four',
    ]);
  });

  it('pins live-follow buffered paints to the tail during a surface resize', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, nextSurface: TerminalSurface, displayRows) => ({
        ...fakeRenderer(displayRows),
        cols: nextSurface.cols,
        rows: displayRows,
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 310, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const liveRows = (offset: number, labels: string[], atBottom: boolean): TerminalFrame => ({
      ...frame(labels.map((label, index) => row(index, label))),
      cols: surface.cols,
      scrollback: {
        totalRows: 30,
        viewportOffset: offset,
        viewportRows: surface.rows,
        atBottom,
      },
    });

    controller.ingestFrame('session-1', liveRows(18, ['18', '19', '20', '21'], false), true);
    controller.ingestFrame('session-1', liveRows(22, ['22', '23', '24', '25'], false), true);
    controller.ingestFrame('session-1', liveRows(26, ['26', '27', '28', '29'], true), true);

    viewport.scrollTop = 0;
    Object.assign(viewport, { clientHeight: 60, scrollHeight: 310 });
    const resized = { ...surface, rows: 6 };
    controller.setSurface(resized);
    paintFrame.mockClear();
    controller.paintCurrent('session-1', resized);

    expect(viewport.scrollTop).toBe(250);
    expect((paintFrame.mock.calls[0]?.[0] as TerminalFrame).rows.map(rowText)).toEqual([
      '',
      '',
      '',
      '',
      '',
      '',
      '18',
      '19',
      '20',
      '21',
      '22',
      '23',
      '24',
      '25',
      '26',
      '27',
      '28',
      '29',
    ]);
  });

  it('treats a tail-offset live buffer as bottomed while follow intent is on', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, nextSurface: TerminalSurface, displayRows) => ({
        ...fakeRenderer(displayRows),
        cols: nextSurface.cols,
        rows: displayRows,
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 310, scrollTop: 270 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      {
        ...frame(['26', '27', '28', '29'].map((label, index) => row(index, label))),
        cols: surface.cols,
        scrollback: {
          totalRows: 30,
          viewportOffset: 26,
          viewportRows: surface.rows,
          atBottom: false,
        },
      },
      true,
    );

    expect(controller.isLiveFollow()).toBe(true);

    Object.assign(viewport, { clientHeight: 30, scrollHeight: 310, scrollTop: 270 });
    const resized = { ...surface, rows: 3 };
    controller.setSurface(resized);
    paintFrame.mockClear();
    controller.paintCurrent('session-1', resized);

    expect(viewport.scrollTop).toBe(280);
    expect(controller.getBufferDebug()).toEqual(
      expect.objectContaining({
        atBottom: true,
        viewportOffset: 27,
      }),
    );
    expect((paintFrame.mock.calls[0]?.[0] as TerminalFrame).rows.map(rowText).slice(-3)).toEqual([
      '27',
      '28',
      '29',
    ]);
  });

  it('keeps live-follow off when a resize makes the live cache fit the viewport', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const onLiveFollow = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow,
      createRenderer: (_canvas, nextSurface: TerminalSurface, displayRows) => ({
        ...fakeRenderer(displayRows),
        cols: nextSurface.cols,
        rows: displayRows,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 310, scrollTop: 270 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const liveRows = (offset: number, labels: string[], atBottom: boolean): TerminalFrame => ({
      ...frame(labels.map((label, index) => row(index, label))),
      cols: surface.cols,
      scrollback: {
        totalRows: 30,
        viewportOffset: offset,
        viewportRows: surface.rows,
        atBottom,
      },
    });

    controller.ingestFrame('session-1', liveRows(18, ['18', '19', '20', '21'], false), true);
    controller.ingestFrame('session-1', liveRows(22, ['22', '23', '24', '25'], false), true);
    controller.ingestFrame('session-1', liveRows(26, ['26', '27', '28', '29'], true), true);

    expect(controller.scrollBufferedToRow(21)).toBe(true);
    expect(controller.isLiveFollow()).toBe(false);

    const resized = { ...surface, rows: 20 };
    Object.assign(viewport, { clientHeight: 200, scrollHeight: 310 });
    controller.setSurface(resized);
    controller.paintCurrent('session-1', resized);

    expect(controller.isLiveFollow()).toBe(false);
    expect(onLiveFollow).toHaveBeenLastCalledWith(false);
  });

  it('ignores active frames that still describe the pre-resize geometry', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'stable'), row(1, 'one'), row(2, 'two'), row(3, 'three')]),
        cols: surface.cols,
        scrollback: { totalRows: 4, viewportOffset: 0, viewportRows: 4, atBottom: true },
      },
      true,
    );

    const resized = { ...surface, rows: 6 };
    controller.setSurface(resized);
    paintFrame.mockClear();
    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'stale resize frame')]),
        dirty: 'full',
        cols: surface.cols,
        scrollback: { totalRows: 4, viewportOffset: 0, viewportRows: 4, atBottom: true },
      },
      true,
    );

    expect(paintFrame).not.toHaveBeenCalled();
    expect(rowText(controller.getComposite()?.rows[0] as TerminalRow)).toBe('stable');
  });

  it('preserves the live row cache across column resizes until the backend replies', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const createRenderer = vi.fn((_canvas, nextSurface: TerminalSurface, displayRows) => ({
      ...fakeRenderer(displayRows),
      cols: nextSurface.cols,
      rows: displayRows,
      paintFrame,
    }));
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer,
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      frame([row(0, 'zero'), row(1, 'one'), row(2, 'two'), row(3, 'three')]),
      true,
    );
    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(2, 'TWO')]),
        dirty: 'partial',
      },
      true,
    );

    const resized = { ...surface, cols: 81 };
    controller.setSurface(resized);
    controller.paintCurrent('session-1', resized);

    expect(controller.getComposite()?.rows.map(rowText)).toEqual(['zero', 'one', 'TWO', 'three']);
    expect(createRenderer).toHaveBeenCalledTimes(2);
    expect(createRenderer.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ cols: 81 }));

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'zero'), row(1, 'one'), row(2, 'TWO'), row(3, 'three')]),
        cols: resized.cols,
      },
      true,
    );

    expect(createRenderer).toHaveBeenCalledTimes(3);
    expect(createRenderer.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ cols: 81 }));
  });

  it('keeps cached live rows when a resize frame is temporarily blank', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, nextSurface: TerminalSurface, displayRows) => ({
        ...fakeRenderer(displayRows),
        cols: nextSurface.cols,
        rows: displayRows,
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 210, scrollTop: 170 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'ROW 017'), row(1, 'ROW 018'), row(2, 'ROW 019'), row(3, 'ROW 020')]),
        cols: surface.cols,
        scrollback: { totalRows: 20, viewportOffset: 16, viewportRows: 4, atBottom: true },
      },
      true,
    );

    const resized = { ...surface, cols: 100 };
    controller.setSurface(resized);
    paintFrame.mockClear();
    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0), row(1), row(2), row(3)]),
        cols: resized.cols,
        scrollback: { totalRows: 20, viewportOffset: 16, viewportRows: 4, atBottom: true },
      },
      true,
    );
    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0), row(1), row(2), row(3)]),
        cols: resized.cols,
        scrollback: { totalRows: 20, viewportOffset: 16, viewportRows: 4, atBottom: true },
      },
      true,
    );

    expect(
      (paintFrame.mock.calls.at(-1)?.[0] as TerminalFrame).rows.slice(-4).map(rowText),
    ).toEqual(['ROW 017', 'ROW 018', 'ROW 019', 'ROW 020']);
  });

  it('clears blank rows in mixed Ink redraws during a pending resize guard', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, nextSurface: TerminalSurface, displayRows) => ({
        ...fakeRenderer(displayRows),
        cols: nextSurface.cols,
        rows: displayRows,
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      {
        ...frame([
          row(0, 'old question'),
          row(1, 'old choice'),
          row(2, 'old notes'),
          row(3, 'old footer'),
        ]),
        cols: surface.cols,
        scrollback: { totalRows: 4, viewportOffset: 0, viewportRows: 4, atBottom: true },
      },
      true,
    );

    const resized = { ...surface, cols: 100 };
    controller.setSurface(resized);
    paintFrame.mockClear();

    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0), row(1, 'new question'), row(2), row(3, 'new footer')]),
        dirty: 'partial',
        cols: resized.cols,
        scrollback: { totalRows: 4, viewportOffset: 0, viewportRows: 4, atBottom: true },
      },
      true,
    );

    expect(
      (paintFrame.mock.calls.at(-1)?.[0] as TerminalFrame).rows.slice(0, 4).map(rowText),
    ).toEqual(['', 'new question', '', 'new footer']);
  });

  it('scrolls a live buffered viewport to an absolute row when cached', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const onLiveFollow = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow,
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 2510, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 250,
      viewportRows: surface.rows,
      viewportOffset: 246,
      rowsById: rowRange(240, 250),
      cachedRanges: [{ start: 240, end: 250 }],
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 246,
      liveFollow: false,
    };
    controller.applyView(view, surface, buffer);

    expect(controller.scrollBufferedToRow(246)).toBe(true);
    expect(viewport.scrollTop).toBe(2470);
    expect(onLiveFollow).toHaveBeenLastCalledWith(true);
  });

  it('scrolls freely into uncached rows instead of refusing the gesture', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 2510, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 250,
      viewportRows: surface.rows,
      viewportOffset: 246,
      rowsById: rowRange(246, 250),
      cachedRanges: [{ start: 246, end: 250 }],
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 246,
      liveFollow: false,
    };
    controller.applyView(view, surface, buffer);

    // The target rows are not cached yet, but scrolling must still move the
    // viewport: placeholders paint and the paint-window prefetch fills the rows in
    // when the band lands. Refusing to move (the old gate) is what capped
    // scroll-back a few rows above the tail.
    expect(controller.scrollBufferedToRow(100)).toBe(true);
    expect(viewport.scrollTop).toBe(1010);
  });

  it('scrolls a live buffered viewport by pixel deltas below one row', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const onLiveFollow = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow,
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 2510, scrollTop: 1010 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 250,
      viewportRows: surface.rows,
      viewportOffset: 246,
      rowsById: rowRange(96, 108),
      cachedRanges: [{ start: 96, end: 108 }],
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 246,
      liveFollow: false,
    };
    controller.applyView(view, surface, buffer);

    expect(controller.scrollBufferedPixels(3.5)).toBe(true);
    expect(viewport.scrollTop).toBe(1013.5);
    expect(controller.isLiveFollow()).toBe(false);
    expect(onLiveFollow).toHaveBeenLastCalledWith(false);
  });

  it('requests a history jump when live painting lands on uncached buffer rows', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const onMissingLiveRows = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      onMissingLiveRows,
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 2510, scrollTop: 1210 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 250,
      viewportRows: surface.rows,
      viewportOffset: 246,
      rowsById: rowRange(246, 250),
      cachedRanges: [{ start: 246, end: 250 }],
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 246,
      liveFollow: false,
    };
    controller.applyView(view, surface, buffer);

    // A scrolled-back miss now fetches the aligned prefetch band (paint window +
    // lead above, snapped to HISTORY_PREFETCH_ALIGN_ROWS), not just the window,
    // so one round-trip warms the next stretch of scroll-up.
    expect(onMissingLiveRows).toHaveBeenCalledWith({
      startRow: 0,
      rowCount: 250,
      totalRows: 250,
      generation: 0,
    });
  });

  it('requests history for drifted blank rows that are present but not covered', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const onMissingLiveRows = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      onMissingLiveRows,
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 130, scrollTop: 30 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const rowsById = new Map<number, TerminalRow>();
    for (let index = 0; index < 12; index += 1) rowsById.set(index, row(index, ''));
    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 12,
      viewportRows: surface.rows,
      viewportOffset: 8,
      rowsById,
      cachedRanges: [{ start: 8, end: 12 }],
      atBottom: false,
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 8,
      liveFollow: false,
    };
    controller.applyView(view, surface, buffer);

    expect(onMissingLiveRows).toHaveBeenCalledWith({
      startRow: 0,
      rowCount: 12,
      totalRows: 12,
      generation: 0,
    });
  });

  it('requests history when only blank live viewport rows are known', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const onMissingLiveRows = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      onMissingLiveRows,
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 210, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const rowsById = new Map<number, TerminalRow>();
    for (let index = 16; index < 20; index += 1) rowsById.set(index, row(index, ''));
    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 20,
      viewportRows: surface.rows,
      viewportOffset: 16,
      rowsById,
      cachedRanges: [],
      atBottom: true,
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 16,
      liveFollow: false,
    };
    controller.applyView(view, surface, buffer);

    expect(onMissingLiveRows).toHaveBeenCalledWith({
      startRow: 0,
      rowCount: 20,
      totalRows: 20,
      generation: 0,
    });
  });

  it('does not request a live history jump when visible rows are cached but overscan is missing', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const onMissingLiveRows = vi.fn();
    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      onMissingLiveRows,
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 2510, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 250,
      viewportRows: surface.rows,
      viewportOffset: 0,
      rowsById: rowRange(0, 4),
      cachedRanges: [{ start: 0, end: 4 }],
      atBottom: false,
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 246,
      liveFollow: false,
    };
    controller.applyView(view, surface, buffer);

    expect(onMissingLiveRows).not.toHaveBeenCalled();
    expect(
      (paintFrame.mock.calls.at(-1)?.[0] as TerminalFrame).rows.map(rowText).slice(0, 4),
    ).toEqual(['0', '1', '2', '3']);
  });

  it('does not request a live history jump during stale-shape resize when visible rows are cached', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const onMissingLiveRows = vi.fn();
    const paintFrame = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      onMissingLiveRows,
      createRenderer: (_canvas, _surface, displayRows) => ({
        ...fakeRenderer(displayRows),
        paintFrame,
      }),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 2510, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const staleShape = { ...surface, cols: surface.cols + 20 };
    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(staleShape),
      totalRows: 250,
      viewportRows: staleShape.rows,
      viewportOffset: 0,
      rowsById: rowRange(0, 4),
      cachedRanges: [{ start: 0, end: 4 }],
      atBottom: false,
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 246,
      liveFollow: false,
    };
    controller.applyView(view, surface, buffer);

    expect(onMissingLiveRows).not.toHaveBeenCalled();
    expect(
      (paintFrame.mock.calls.at(-1)?.[0] as TerminalFrame).rows.map(rowText).slice(0, 4),
    ).toEqual(['0', '1', '2', '3']);
  });

  it('paints blank placeholder rows for a requested live cache miss', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const onMissingLiveRows = vi.fn(() => true);
    const paintFrame = vi.fn();
    const createRenderer = vi.fn((_canvas, _surface, displayRows) => ({
      ...fakeRenderer(displayRows),
      paintFrame,
    }));
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      onMissingLiveRows,
      createRenderer,
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 2510, scrollTop: 1210 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 250,
      viewportRows: surface.rows,
      viewportOffset: 246,
      rowsById: rowRange(246, 250),
      cachedRanges: [{ start: 246, end: 250 }],
      atBottom: false,
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 246,
      liveFollow: false,
    };
    controller.applyView(view, surface, buffer);

    // Scrolled back into an uncached region: request the fill AND paint blank
    // placeholder rows in place now, so the gesture never freezes on the round-trip.
    expect(onMissingLiveRows).toHaveBeenCalled();
    expect(createRenderer).toHaveBeenCalled();
    const painted = paintFrame.mock.calls.at(-1)?.[0] as TerminalFrame;
    expect(painted.rows.length).toBeGreaterThan(0);
    expect(painted.rows.every(row => rowText(row) === '')).toBe(true);
  });

  it('paints the cached live tail instead of placeholder overscan rows', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const onMissingLiveRows = vi.fn(() => true);
    const paintFrame = vi.fn();
    const createRenderer = vi.fn(
      (_canvas: HTMLCanvasElement, nextSurface: TerminalSurface, displayRows: number) => ({
        ...fakeRenderer(displayRows),
        cols: nextSurface.cols,
        rows: displayRows,
        cellWidth: nextSurface.cellWidth,
        cellHeight: nextSurface.cellHeight,
        paintFrame,
      }),
    );
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      onMissingLiveRows,
      createRenderer,
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 60, scrollHeight: 210, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 20,
      viewportRows: surface.rows,
      viewportOffset: 16,
      rowsById: rowRange(16, 20),
      cachedRanges: [{ start: 16, end: 20 }],
      atBottom: true,
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 16,
      liveFollow: true,
    };

    controller.applyView(view, surface, buffer);

    const painted = paintFrame.mock.calls.at(-1)?.[0] as TerminalFrame;
    expect(onMissingLiveRows).toHaveBeenCalledWith({
      startRow: 2,
      rowCount: 18,
      totalRows: 20,
      generation: 0,
    });
    expect(painted.rows.map(rowText)).toEqual(['6', '7', '8', '9']);
    expect(canvas.style.top).toBe('170px');
  });

  it('stamps requests with the backend-adopted generation and merges a gen-1 band (front-to-back boundary)', () => {
    // The real boundary the running app crosses: the backend starts at generation
    // 1 (fresh, un-resized) and re-seeds with a Full frame; the hook adopts that 1
    // and calls `setLiveGeneration(1)`. The request the controller issues must then
    // carry generation 1 (NOT the old frontend-only token that started at 0, which
    // never matched the backend and made every serve come back empty), and a band
    // the backend serves at generation 1 must pass the merge gate. This builds the
    // band with the exact `encode_row_band` wire bytes and decodes them with the
    // shared `decodeRowBand`, so it crosses the real wire format too.
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    // Capture the last request the controller issues so we can assert its
    // generation and reuse its totalRows for the merge, without depending on the
    // mock-call tuple typing.
    type HistoryRequest = {
      startRow: number;
      rowCount: number;
      totalRows: number;
      generation: number;
    };
    let lastRequest: HistoryRequest | null = null;
    const onMissingLiveRows = vi.fn((request: HistoryRequest) => {
      lastRequest = request;
      return true;
    });
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      onMissingLiveRows,
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 60, scrollHeight: 210, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    // The hook does this from `handleDecodedFrame` when it adopts the backend's
    // generation from the first Full frame. The backend's fresh generation is 1.
    controller.setLiveGeneration(1);
    expect(controller.getLiveGeneration()).toBe(1);

    // Ingest a live tail with a gap above it (rows 16..19 cached out of 20 total,
    // viewport scrolled to the top), so the controller asks for the missing older
    // rows as it paints. Ingesting (not a manual applyView) sets the active
    // session, which the merge gate requires, and is the real runtime path.
    controller.ingestFrame(
      'session-1',
      liveFrameAtBottom(16, [row(0, '16'), row(1, '17'), row(2, '18'), row(3, '19')]),
      true,
    );

    // THE FIX: the request carries the backend-adopted generation 1, not 0.
    expect(onMissingLiveRows).toHaveBeenCalled();
    if (!lastRequest) throw new Error('expected a history-range request to be issued');
    const request: HistoryRequest = lastRequest;
    expect(request.generation).toBe(1);

    // A row band the backend serves at generation 1, start row 8, one row 'H'
    // then a blank, in the exact `encode_row_band` wire format. Decoding it with
    // the shared `decodeRowBand` and merging at the band's generation must be
    // accepted, because the controller's live generation is now 1.
    const bandBytes = new Uint8Array([
      0x02, // kind = row band
      0x01,
      0x00,
      0x00,
      0x00, // generation = 1
      0x08,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // start_id (u64) = 8
      0x02,
      0x00,
      0x00,
      0x00, // row_count = 2
      0x01,
      0x00, // row[0] cell_count = 1
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x00, // cell col=0 width=1 style=0 colorFlags=0
      0x01,
      0x00,
      0x48, // text_len=1, 'H'
      0x00,
      0x00, // row[1] cell_count = 0
    ]);
    const band = decodeRowBand(bandBytes.buffer);
    expect(band.generation).toBe(1);
    const bandFrame: TerminalFrame = { dirty: 'full', cols: surface.cols, rows: band.rows };
    const merged = controller.mergeLiveRows(
      bandFrame,
      band.startId,
      request.totalRows,
      band.generation,
    );

    // Accepted: the gen-1 gate matches the gen-1 request, the band is merged, and
    // its rows now back the mirror at absolute ids 8..9.
    expect(merged).toBe(true);
    const debug = controller.getBufferDebug();
    const coversBand = debug?.cachedRanges.some(range => range.start <= 8 && range.end >= 10);
    expect(coversBand).toBe(true);
  });

  it('drops a band whose generation no longer matches the backend-adopted generation', () => {
    // The complement of the boundary test: after a resize the backend bumps to 2
    // and the hook calls `setLiveGeneration(2)`; a band still tagged generation 1
    // (in flight across the resize, or served stale) must be dropped, never merged
    // across the renumber.
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 210, scrollTop: 170 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      liveFrameAtBottom(16, [row(0, '16'), row(1, '17'), row(2, '18'), row(3, '19')]),
      true,
    );
    controller.setLiveGeneration(2);

    const merged = controller.mergeLiveRows(frame([row(0, 'stale-8')]), 8, 20, 1);
    expect(merged).toBe(false);
  });

  it('drops a history band whose rows evicted during the fetch round-trip (id below the floor)', () => {
    // mergeLiveRows addresses the band by stable id and converts it to a buffer
    // position via the live floor. If the backend evicted past the band's id while
    // the fetch was in flight (its id is now below oldest_id), the band is stale and
    // must be dropped, never merged at a negative position (D8, scenarios T / RC).
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 210, scrollTop: 170 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    // A frame whose stable-id floor is 50 (the backend has evicted 50 rows).
    const evicted: TerminalFrame = {
      ...frame([row(0, 'a'), row(1, 'b'), row(2, 'c'), row(3, 'd')]),
      scrollback: {
        scrollbackRows: 100,
        viewportOffset: 100,
        viewportRows: surface.rows,
        totalRows: 104,
        atBottom: true,
        oldestId: 50,
      },
    };
    controller.ingestFrame('session-1', evicted, true);

    // A band for stable id 30 is below the floor (50): its rows have evicted, so the
    // merge drops it rather than placing it at a negative buffer position.
    const merged = controller.mergeLiveRows(frame([row(0, 'gone')]), 30, 104);
    expect(merged).toBe(false);
  });

  it('paints cached stale-width rows while waiting for backend resize', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const onMissingLiveRows = vi.fn(() => true);
    const paintFrame = vi.fn();
    const createRenderer = vi.fn(
      (_canvas: HTMLCanvasElement, nextSurface: TerminalSurface, displayRows: number) => ({
        ...fakeRenderer(displayRows),
        cols: nextSurface.cols,
        rows: displayRows,
        cellWidth: nextSurface.cellWidth,
        cellHeight: nextSurface.cellHeight,
        paintFrame,
      }),
    );
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      onMissingLiveRows,
      createRenderer,
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewportState = { clientHeight: 60, scrollHeight: 210, scrollTop: 0 };
    const viewport = viewportState as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 20,
      viewportRows: surface.rows,
      viewportOffset: 16,
      rowsById: rowRange(6, 20),
      cachedRanges: [{ start: 6, end: 20 }],
      atBottom: true,
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 16,
      liveFollow: true,
    };
    controller.applyView(view, surface, buffer);

    createRenderer.mockClear();
    paintFrame.mockClear();
    onMissingLiveRows.mockClear();
    viewportState.clientHeight = 80;
    viewportState.scrollHeight = 210;

    const resized = { ...surface, cols: 100, rows: 6 };
    controller.setSurface(resized);
    controller.applyView(view, resized, buffer);

    expect(onMissingLiveRows).not.toHaveBeenCalled();
    expect(createRenderer).toHaveBeenCalledTimes(1);
    expect(createRenderer.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ cols: 100 }));
    expect((paintFrame.mock.calls.at(-1)?.[0] as TerminalFrame).rows.map(rowText)).toEqual([
      '6',
      '7',
      '8',
      '9',
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
  });

  it('keeps stale-width cached rows anchored when the resized viewport is uncached', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const onMissingLiveRows = vi.fn(() => true);
    const paintFrame = vi.fn();
    const createRenderer = vi.fn(
      (_canvas: HTMLCanvasElement, nextSurface: TerminalSurface, displayRows: number) => ({
        ...fakeRenderer(displayRows),
        cols: nextSurface.cols,
        rows: displayRows,
        cellWidth: nextSurface.cellWidth,
        cellHeight: nextSurface.cellHeight,
        paintFrame,
      }),
    );
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      onMissingLiveRows,
      createRenderer,
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewportState = { clientHeight: 60, scrollHeight: 810, scrollTop: 0 };
    const viewport = viewportState as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 80,
      viewportRows: surface.rows,
      viewportOffset: 76,
      rowsById: rowRange(0, 12),
      cachedRanges: [{ start: 0, end: 12 }],
      atBottom: false,
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 76,
      liveFollow: false,
    };
    controller.applyView(view, surface, buffer);

    createRenderer.mockClear();
    paintFrame.mockClear();
    onMissingLiveRows.mockClear();
    viewportState.clientHeight = 80;
    viewportState.scrollTop = 670;

    const resized = { ...surface, cols: 100, rows: 6 };
    controller.setSurface(resized);
    controller.applyView(view, resized, buffer);

    expect(onMissingLiveRows).not.toHaveBeenCalled();
    expect(createRenderer).toHaveBeenCalledTimes(1);
    expect(createRenderer.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ cols: 100 }));
    expect(canvas.style.top).toBe('570px');
    expect((paintFrame.mock.calls.at(-1)?.[0] as TerminalFrame).rows.map(rowText)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '0',
      '1',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
  });

  it('keeps the previous live paint when a stale tail cache is too short', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const onMissingLiveRows = vi.fn(() => true);
    const paintFrame = vi.fn();
    const createRenderer = vi.fn(
      (_canvas: HTMLCanvasElement, nextSurface: TerminalSurface, displayRows: number) => ({
        ...fakeRenderer(displayRows),
        cols: nextSurface.cols,
        rows: displayRows,
        cellWidth: nextSurface.cellWidth,
        cellHeight: nextSurface.cellHeight,
        paintFrame,
      }),
    );
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      onMissingLiveRows,
      createRenderer,
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewportState = { clientHeight: 410, scrollHeight: 1620, scrollTop: 1210 };
    const viewport = viewportState as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const fullTailBuffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 161,
      viewportRows: surface.rows,
      viewportOffset: 157,
      rowsById: rowRange(114, 161),
      cachedRanges: [{ start: 114, end: 161 }],
      atBottom: true,
    };
    const fullTailView: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(fullTailBuffer),
      scrollbackRows: [],
      rowCount: 157,
      liveFollow: true,
    };
    controller.applyView(fullTailView, surface, fullTailBuffer);

    createRenderer.mockClear();
    paintFrame.mockClear();
    onMissingLiveRows.mockClear();

    const shortTailBuffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 161,
      viewportRows: surface.rows,
      viewportOffset: 157,
      rowsById: rowRange(136, 161),
      cachedRanges: [{ start: 136, end: 161 }],
      atBottom: true,
    };
    const shortTailView: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(shortTailBuffer),
      scrollbackRows: [],
      rowCount: 157,
      liveFollow: true,
    };
    const resized = { ...surface, cols: 100, rows: 6 };
    controller.setSurface(resized);
    controller.applyView(shortTailView, resized, shortTailBuffer);

    expect(onMissingLiveRows).not.toHaveBeenCalled();
    expect(createRenderer).not.toHaveBeenCalled();
    expect(paintFrame).not.toHaveBeenCalled();
  });

  it('keeps the live tail canvas full-size after a resize cache reset', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const paintFrame = vi.fn();
    const createRenderer = vi.fn((_canvas, _surface, displayRows) => ({
      ...fakeRenderer(displayRows),
      paintFrame,
    }));
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer,
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 60, scrollHeight: 210, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 20,
      viewportRows: surface.rows,
      viewportOffset: 16,
      rowsById: rowRange(16, 20),
      cachedRanges: [{ start: 16, end: 20 }],
      atBottom: true,
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 16,
      liveFollow: true,
    };

    controller.applyView(view, surface, buffer);

    const painted = paintFrame.mock.calls.at(-1)?.[0] as TerminalFrame;
    expect(painted.rows.map(rowText)).toEqual([
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '6',
      '7',
      '8',
      '9',
    ]);
    expect(createRenderer).toHaveBeenLastCalledWith(canvas, surface, 18);
    expect(canvas.style.top).toBe('30px');
    expect(canvas.style.transform).toBe('none');
  });

  it('does not request a live history jump for an empty live buffer', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const onMissingLiveRows = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      onMissingLiveRows,
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const buffer = createTerminalBuffer(surface);
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 0,
      liveFollow: false,
    };
    controller.applyView(view, surface, buffer);

    expect(onMissingLiveRows).not.toHaveBeenCalled();
  });

  it('requests missing cached rows while following the live tail', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const onMissingLiveRows = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      onMissingLiveRows,
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 2510, scrollTop: 1210 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 250,
      viewportRows: surface.rows,
      viewportOffset: 246,
      rowsById: rowRange(246, 250),
      cachedRanges: [{ start: 246, end: 250 }],
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 246,
      liveFollow: true,
    };
    controller.applyView(view, surface, buffer);

    expect(onMissingLiveRows).toHaveBeenCalledWith({
      startRow: 238,
      rowCount: 12,
      totalRows: 250,
      generation: 0,
    });
  });

  it('merges a lagging live cache fill without shrinking the advanced buffer', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 210, scrollTop: 170 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      liveFrameAtBottom(16, [row(0, '16'), row(1, '17'), row(2, '18'), row(3, '19')]),
      true,
    );
    controller.ingestFrame(
      'session-1',
      liveFrameAtBottom(17, [row(0, '17'), row(1, '18'), row(2, '19'), row(3, '20')]),
      true,
    );

    // The fill was requested while the total was 20; by the time it returns the live
    // buffer has advanced to 21. Its rows are addressed by absolute id and remain
    // valid (genuine staleness from a reflow/clear is caught by the generation
    // check), so it must merge. Rejecting it on the lagging total is what livelocked
    // the live tail under continuous output: every fill came back "stale", the
    // missing rows were never filled, and the renderer kept repainting empty rows.
    // The merge must not let the lagging total shrink the advanced buffer.
    const merged = controller.mergeLiveRows(frame([row(0, 'history-8')]), 8, 20);

    expect(merged).toBe(true);
    expect(controller.getRowCount()).toBe(21);
  });

  it('merges a decoded history row band (the read_terminal_rows prefetch path)', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 210, scrollTop: 170 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    // Seed a live tail so the mirror exists, advancing the buffer to 20 rows.
    controller.ingestFrame(
      'session-1',
      liveFrameAtBottom(16, [row(0, '16'), row(1, '17'), row(2, '18'), row(3, '19')]),
      true,
    );

    // A row band exactly as the backend `read_terminal_rows` returns it: kind 2,
    // start row 8, two contiguous rows ('H' then a blank). Decoding it yields the
    // 0-based-within-band rows the hook wraps into a frame and merges absolutely.
    const bandBytes = new Uint8Array([
      0x02,
      0x00,
      0x00,
      0x00,
      0x00, // kind=2, generation=0
      0x08,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // start_id (u64) = 8
      0x02,
      0x00,
      0x00,
      0x00, // row_count=2
      0x01,
      0x00, // row[0]: cell_count=1
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x00, // cell col=0 width=1 style=0 colorFlags=0
      0x01,
      0x00,
      0x48, // text_len=1, 'H'
      0x00,
      0x00, // row[1]: cell_count=0
    ]);
    const band = decodeRowBand(bandBytes.buffer);
    expect(band.startId).toBe(8);
    expect(band.rows.map(r => r.index)).toEqual([0, 1]);
    expect(band.rows[0].cells.map(c => c.text)).toEqual(['H']);

    // The hook builds this exact frame shape from the decoded band and merges it
    // at the band's absolute start row. The merge is accepted (generation 0
    // matches the un-resized mirror) and the prefetched band extends the mirror's
    // cached range upward to include row 8, without shrinking the live total.
    const bandFrame: TerminalFrame = { dirty: 'full', cols: surface.cols, rows: band.rows };
    const merged = controller.mergeLiveRows(bandFrame, band.startId, 20, band.generation);

    expect(merged).toBe(true);
    expect(controller.getRowCount()).toBe(20);
    const debug = controller.getBufferDebug();
    // The band's rows (ids 8..9) are now cached in the mirror alongside the live
    // tail (16..19), so a scroll back to row 8 paints from the mirror with no
    // further round-trip.
    const coversBand = debug?.cachedRanges.some(range => range.start <= 8 && range.end >= 10);
    expect(coversBand).toBe(true);
  });

  it('does not paint an all-blank live resize miss over cached text', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const onMissingLiveRows = vi.fn(() => true);
    const paintFrame = vi.fn();
    const createRenderer = vi.fn((_canvas, _surface, displayRows) => ({
      ...fakeRenderer(displayRows),
      paintFrame,
    }));
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      onMissingLiveRows,
      createRenderer,
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 210, scrollTop: 170 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 20,
      viewportRows: surface.rows,
      viewportOffset: 16,
      rowsById: rowRange(0, 4),
      cachedRanges: [{ start: 0, end: 4 }],
      atBottom: true,
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 16,
      liveFollow: true,
    };

    controller.applyView(view, surface, buffer);

    expect(onMissingLiveRows).toHaveBeenCalled();
    expect(createRenderer).not.toHaveBeenCalled();
    expect(paintFrame).not.toHaveBeenCalled();
  });

  it('keeps the live backing renderer stable while a short buffer grows', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const createRenderer = vi.fn((_canvas, _surface, displayRows) => fakeRenderer(displayRows));
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer,
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 50, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const bufferForRows = (totalRows: number): TerminalBufferState => ({
      ...createTerminalBuffer(surface),
      totalRows,
      viewportRows: surface.rows,
      viewportOffset: Math.max(0, totalRows - surface.rows),
      rowsById: rowRange(0, totalRows),
      cachedRanges: [{ start: 0, end: totalRows }],
    });
    const viewForBuffer = (buffer: TerminalBufferState): SessionTerminalView => ({
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: Math.max(0, buffer.totalRows - buffer.viewportRows),
      liveFollow: false,
    });

    const firstBuffer = bufferForRows(4);
    controller.applyView(viewForBuffer(firstBuffer), surface, firstBuffer);

    expect(createRenderer).toHaveBeenCalledTimes(1);
    expect(createRenderer.mock.calls[0]?.[2]).toBe(12);

    const secondBuffer = bufferForRows(5);
    controller.applyView(viewForBuffer(secondBuffer), surface, secondBuffer, {
      dirtyAbsoluteRows: new Set([4]),
    });

    expect(createRenderer).toHaveBeenCalledTimes(1);
  });

  it('remounts the renderer when height-only surface resizes change the paint rows', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const traces: unknown[] = [];
    const createRenderer = vi.fn((_canvas, _surface, displayRows) => fakeRenderer(displayRows));
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      onTrace: event => traces.push(event),
      createRenderer,
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      frame([row(0, 'zero'), row(1, 'one'), row(2, 'two'), row(3, 'three')]),
      true,
    );

    expect(createRenderer).toHaveBeenCalledTimes(1);
    expect(createRenderer.mock.calls[0]?.[2]).toBe(12);

    Object.assign(viewport, { clientHeight: 50 });
    const fiveRows = { ...surface, rows: 5 };
    controller.setSurface(fiveRows);
    controller.paintCurrent('session-1', fiveRows);

    Object.assign(viewport, { clientHeight: 90 });
    const nineRows = { ...surface, rows: 9 };
    controller.setSurface(nineRows);
    controller.paintCurrent('session-1', nineRows);

    expect(createRenderer).toHaveBeenCalledTimes(3);
    expect(createRenderer.mock.calls[1]?.[2]).toBe(15);
    expect(createRenderer.mock.calls[2]?.[2]).toBe(27);

    Object.assign(viewport, { clientHeight: 110 });
    const elevenRows = { ...surface, rows: 11 };
    controller.setSurface(elevenRows);
    controller.paintCurrent('session-1', elevenRows);

    expect(createRenderer).toHaveBeenCalledTimes(4);
    expect(createRenderer.mock.calls[3]?.[2]).toBe(33);
    expect(
      traces.filter(
        event =>
          typeof event === 'object' &&
          event !== null &&
          'kind' in event &&
          event.kind === 'surface_change',
      ),
    ).toHaveLength(3);
  });

  it('remounts the renderer at the exact column count during width resizes', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const createRenderer = vi.fn((_canvas, nextSurface: TerminalSurface, displayRows) => ({
      ...fakeRenderer(displayRows),
      cols: nextSurface.cols,
      rows: displayRows,
    }));
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer,
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 40, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-1',
      frame([row(0, 'zero'), row(1, 'one'), row(2, 'two'), row(3, 'three')]),
      true,
    );

    expect(createRenderer).toHaveBeenCalledTimes(1);
    expect(createRenderer.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ cols: 80 }));

    const eightyOneCols = { ...surface, cols: 81 };
    controller.setSurface(eightyOneCols);
    controller.paintCurrent('session-1', eightyOneCols);

    expect(createRenderer).toHaveBeenCalledTimes(2);
    expect(createRenderer.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ cols: 81 }));
    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'zero'), row(1, 'one'), row(2, 'two'), row(3, 'three')]),
        cols: eightyOneCols.cols,
      },
      true,
    );

    expect(createRenderer).toHaveBeenCalledTimes(3);
    expect(createRenderer.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ cols: 81 }));

    const ninetyCols = { ...surface, cols: 90 };
    controller.setSurface(ninetyCols);
    controller.paintCurrent('session-1', ninetyCols);

    expect(createRenderer).toHaveBeenCalledTimes(4);
    expect(createRenderer.mock.calls[3]?.[1]).toEqual(expect.objectContaining({ cols: 90 }));
    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'zero'), row(1, 'one'), row(2, 'two'), row(3, 'three')]),
        cols: ninetyCols.cols,
      },
      true,
    );

    expect(createRenderer).toHaveBeenCalledTimes(5);
    expect(createRenderer.mock.calls[4]?.[1]).toEqual(expect.objectContaining({ cols: 90 }));

    const ninetySevenCols = { ...surface, cols: 97 };
    controller.setSurface(ninetySevenCols);
    controller.paintCurrent('session-1', ninetySevenCols);

    expect(createRenderer).toHaveBeenCalledTimes(6);
    expect(createRenderer.mock.calls[5]?.[1]).toEqual(expect.objectContaining({ cols: 97 }));
    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'zero'), row(1, 'one'), row(2, 'two'), row(3, 'three')]),
        cols: ninetySevenCols.cols,
      },
      true,
    );

    expect(createRenderer).toHaveBeenCalledTimes(7);
    expect(createRenderer.mock.calls[6]?.[1]).toEqual(expect.objectContaining({ cols: 97 }));

    const seventyCols = { ...surface, cols: 70 };
    controller.setSurface(seventyCols);
    controller.paintCurrent('session-1', seventyCols);

    expect(createRenderer).toHaveBeenCalledTimes(8);
    expect(createRenderer.mock.calls[7]?.[1]).toEqual(expect.objectContaining({ cols: 70 }));
    controller.ingestFrame(
      'session-1',
      {
        ...frame([row(0, 'zero'), row(1, 'one'), row(2, 'two'), row(3, 'three')]),
        cols: seventyCols.cols,
      },
      true,
    );

    expect(createRenderer).toHaveBeenCalledTimes(9);
    expect(createRenderer.mock.calls[8]?.[1]).toEqual(expect.objectContaining({ cols: 70 }));
  });

  it('restores the backend generation for an idle session when it becomes current', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 210, scrollTop: 170 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-a',
      liveFrameAtBottom(16, [row(0, 'a16'), row(1, 'a17'), row(2, 'a18'), row(3, 'a19')]),
      true,
    );
    controller.setLiveGeneration(3, 'session-a', true);
    expect(controller.getLiveGeneration()).toBe(3);

    controller.ingestFrame(
      'session-b',
      liveFrameAtBottom(16, [row(0, 'b16'), row(1, 'b17'), row(2, 'b18'), row(3, 'b19')]),
      false,
    );
    controller.setLiveGeneration(7, 'session-b', false);
    expect(controller.getLiveGeneration()).toBe(3);

    controller.paintCurrent('session-b');

    expect(controller.getLiveGeneration()).toBe(7);
  });

  it('restores the backend generation for the immediate activation path', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 210, scrollTop: 170 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    controller.ingestFrame(
      'session-a',
      liveFrameAtBottom(16, [row(0, 'a16'), row(1, 'a17'), row(2, 'a18'), row(3, 'a19')]),
      true,
    );
    controller.setLiveGeneration(3, 'session-a', true);

    controller.ingestFrame(
      'session-b',
      liveFrameAtBottom(16, [row(0, 'b16'), row(1, 'b17'), row(2, 'b18'), row(3, 'b19')]),
      false,
    );
    controller.setLiveGeneration(7, 'session-b', false);
    expect(controller.getLiveGeneration()).toBe(3);

    controller.setCurrentSession('session-b');
    const view = controller.ensureSessionView('session-b');
    if (!view) throw new Error('expected session view');
    controller.applyView(view);

    expect(controller.getLiveGeneration()).toBe(7);
  });

  it('exposes only the painted live-buffer window as the interaction composite', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 10_010, scrollTop: 1_210 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 1_000,
      viewportRows: surface.rows,
      viewportOffset: 996,
      rowsById: rowRange(100, 180),
      cachedRanges: [{ start: 100, end: 180 }],
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 996,
      liveFollow: false,
    };

    controller.applyView(view, surface, buffer);

    const composite = controller.getComposite();
    expect(composite?.rows).toHaveLength(12);
    expect(composite?.rows[0]?.index).toBe(116);
    expect(composite?.rows.at(-1)?.index).toBe(127);
    expect(controller.getRowCount()).toBe(1_000);
  });

  it('expands live-buffer selections against absolute cached rows', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 2_510, scrollTop: 1_210 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const rows = new Map<number, TerminalRow>([
      [
        120,
        {
          index: 120,
          dirty: true,
          cells: [
            { col: 0, text: 'A' },
            { col: 1, width: 2, text: '界' },
            { col: 3, text: 'B' },
          ],
        },
      ],
    ]);
    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 250,
      viewportRows: surface.rows,
      viewportOffset: 246,
      rowsById: rows,
      cachedRanges: [{ start: 120, end: 121 }],
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 246,
      liveFollow: false,
    };
    controller.applyView(view, surface, buffer);

    controller.setSelection({
      start: { row: 120, col: 2 },
      end: { row: 120, col: 2 },
    });

    expect(controller.getSelection()).toEqual({
      start: { row: 120, col: 1 },
      end: { row: 120, col: 2 },
    });
  });

  it('publishes live scroll metrics from the frontend buffer position', () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      }),
    );

    const onScrollMetrics = vi.fn();
    const controller = createTerminalController({
      surface,
      onScrollbackRowCount: vi.fn(),
      onLiveFollow: vi.fn(),
      onScrollMetrics,
      createRenderer: (_canvas, _surface, displayRows) => fakeRenderer(displayRows),
    });
    const canvas = { style: {} } as HTMLCanvasElement;
    const viewport = { clientHeight: 40, scrollHeight: 2510, scrollTop: 0 } as HTMLDivElement;
    const spacer = { style: {} } as HTMLDivElement;
    controller.attach({ canvas, viewport, spacer });

    const buffer: TerminalBufferState = {
      ...createTerminalBuffer(surface),
      totalRows: 250,
      viewportRows: surface.rows,
      viewportOffset: 246,
      rowsById: rowRange(240, 250),
      cachedRanges: [{ start: 240, end: 250 }],
    };
    const view: SessionTerminalView = {
      lastFrame: null,
      compositeFrame: frameFromBufferSnapshot(buffer),
      scrollbackRows: [],
      rowCount: 246,
      liveFollow: false,
    };
    controller.applyView(view, surface, buffer);
    rafCallbacks.length = 0;
    onScrollMetrics.mockClear();

    expect(controller.scrollBufferedToRow(244)).toBe(true);

    expect(onScrollMetrics).not.toHaveBeenCalled();
    expect(rafCallbacks).toHaveLength(1);
    rafCallbacks[0]?.(0);
    expect(onScrollMetrics).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: 'live',
        atBottom: false,
        totalRows: 250,
        viewportRows: 4,
        offsetRows: 244,
      }),
    );
  });
});
