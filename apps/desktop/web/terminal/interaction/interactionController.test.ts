import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalFrame, TerminalModes } from '../../terminalTypes';
import type { TerminalSurface } from '../../terminalScrollback';
import { createTerminalInteraction, type ContextMenuContext } from './interactionController';
import type { BufferCell, BufferLinkSpan, SelectionRange } from './types';

const surface: TerminalSurface = { cols: 10, rows: 5, cellWidth: 10, cellHeight: 20 };

function frame(): TerminalFrame {
  return {
    dirty: 'full',
    rows: Array.from({ length: surface.rows }, (_, index) => ({
      index,
      dirty: true,
      cells: [],
    })),
  };
}

function createCanvasHarness() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const canvas = {
    style: { cursor: '' },
    getBoundingClientRect: () => ({
      x: 100,
      y: 50,
      left: 100,
      top: 50,
      right: 200,
      bottom: 150,
      width: 100,
      height: 100,
      toJSON: () => ({}),
    }),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
      let bucket = listeners.get(type);
      if (!bucket) {
        bucket = new Set();
        listeners.set(type, bucket);
      }
      bucket.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
      listeners.get(type)?.delete(listener);
    }),
  } as unknown as HTMLCanvasElement;

  return {
    canvas,
    dispatch(type: string, event: unknown) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

function pointerEvent(
  overrides: Partial<PointerEvent> = {},
): PointerEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    button: 0,
    pointerId: 7,
    clientX: 125,
    clientY: 95,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as PointerEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

function mouseEvent(
  overrides: Partial<MouseEvent> = {},
): MouseEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    clientX: 125,
    clientY: 95,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as MouseEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

function createPort(canvas: HTMLCanvasElement, modes: TerminalModes | undefined) {
  let selection: SelectionRange | null = { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } };
  return {
    port: {
      getCanvas: () => canvas,
      getViewport: () => null,
      getSurface: () => surface,
      getStartRow: () => 0,
      getRowCount: () => surface.rows,
      getComposite: () => frame(),
      getLastFrameModes: () => modes,
      getSelection: () => selection,
      setSelection: vi.fn((range: SelectionRange | null) => {
        selection = range;
      }),
      clearSelection: vi.fn(() => {
        selection = null;
      }),
      selectAll: vi.fn(),
      setHoverLink: vi.fn(),
      linkAt: vi.fn((_cell: BufferCell): BufferLinkSpan | null => null),
      focusCanvas: vi.fn(),
    },
    getSelection: () => selection,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createTerminalInteraction mouse tracking', () => {
  it('forwards pointer press, motion, and release to the PTY when mouse tracking is active', () => {
    const { canvas, dispatch } = createCanvasHarness();
    const { port } = createPort(canvas, { mouseTracking: true });
    const sendMouseInput = vi.fn();
    const interaction = createTerminalInteraction({ port, sendMouseInput });

    interaction.attach();
    const down = pointerEvent();
    dispatch('pointerdown', down);
    dispatch('pointermove', pointerEvent({ clientX: 135, clientY: 112 }));
    const up = pointerEvent({ clientX: 135, clientY: 112 });
    dispatch('pointerup', up);

    expect(sendMouseInput.mock.calls.map(([input]) => input)).toEqual([
      '\x1b[<0;3;3M',
      '\x1b[<32;4;4M',
      '\x1b[<0;4;4m',
    ]);
    expect(down.preventDefault).toHaveBeenCalled();
    expect(up.preventDefault).toHaveBeenCalled();
    expect(port.setSelection).not.toHaveBeenCalled();
  });

  it('uses local selection when Shift overrides mouse tracking', () => {
    const { canvas, dispatch } = createCanvasHarness();
    const { port } = createPort(canvas, { mouseTracking: true });
    const sendMouseInput = vi.fn();
    const interaction = createTerminalInteraction({ port, sendMouseInput });

    interaction.attach();
    dispatch('pointerdown', pointerEvent({ shiftKey: true }));

    expect(sendMouseInput).not.toHaveBeenCalled();
    expect(port.setSelection).toHaveBeenCalledWith(null);
  });

  it('suppresses the context menu while terminal mouse tracking owns right click', () => {
    const { canvas, dispatch } = createCanvasHarness();
    const { port } = createPort(canvas, { mouseTracking: true });
    const onContextMenu = vi.fn((_context: ContextMenuContext) => {});
    const interaction = createTerminalInteraction({ port, onContextMenu, sendMouseInput: vi.fn() });

    interaction.attach();
    const event = mouseEvent();
    dispatch('contextmenu', event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it('allows the context menu when Shift overrides mouse tracking', () => {
    const { canvas, dispatch } = createCanvasHarness();
    const { port } = createPort(canvas, { mouseTracking: true });
    const onContextMenu = vi.fn((_context: ContextMenuContext) => {});
    const interaction = createTerminalInteraction({ port, onContextMenu, sendMouseInput: vi.fn() });

    interaction.attach();
    dispatch('contextmenu', mouseEvent({ shiftKey: true }));

    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });
});
