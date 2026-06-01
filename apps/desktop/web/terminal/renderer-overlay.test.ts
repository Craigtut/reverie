import { describe, it, expect, beforeAll } from 'vitest';
import { createTerminalCanvasRenderer } from '../terminal-canvas-renderer';
import type { TerminalFrame, TerminalOverlay } from '../terminalTypes';

// Regression guard: the renderer must actually paint the selection wash.
// A stale compiled `terminal-canvas-renderer.js` once shadowed the `.ts` (imports
// are extensionless and the bundler prefers `.js`), so the app loaded a renderer
// with no overlay pass: selection worked + copied, but never highlighted. This
// drives the REAL renderer with a recording 2D-context stub and asserts the
// overlay produces translucent fills, so that class of bug fails CI instead of
// shipping silently.

interface FillCall {
  alpha: number;
  style: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TextCall {
  alpha: number;
  font: string;
  text: string;
  x: number;
  y: number;
}

function recordingContext() {
  const fills: FillCall[] = [];
  const text: TextCall[] = [];
  let globalAlpha = 1;
  const ctx = {
    get globalAlpha() {
      return globalAlpha;
    },
    set globalAlpha(v: number) {
      globalAlpha = v;
    },
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '',
    textBaseline: 'top',
    textRendering: 'auto',
    scale() {},
    fillRect(x: number, y: number, w: number, h: number) {
      fills.push({ alpha: globalAlpha, style: String(ctx.fillStyle), x, y, w, h });
    },
    clearRect() {},
    fillText(value: string, x: number, y: number) {
      text.push({ alpha: globalAlpha, font: ctx.font, text: value, x, y });
    },
    strokeRect() {},
    measureText() {
      return { width: 9 } as TextMetrics;
    },
  };
  return { ctx, fills, text };
}

function fakeCanvas(ctx: unknown): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    style: {} as CSSStyleDeclaration,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
}

function fullFrame(rowCount: number): TerminalFrame {
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    index,
    dirty: true,
    cells: index === 0 ? 'hello'.split('').map((ch, col) => ({ col, text: ch })) : [],
  }));
  return { dirty: 'full', rows } as unknown as TerminalFrame;
}

beforeAll(() => {
  // The renderer reads window.devicePixelRatio at construction.
  (globalThis as unknown as { window: { devicePixelRatio: number } }).window = {
    devicePixelRatio: 1,
  };
});

describe('renderer overlay pass', () => {
  function render(overlay: TerminalOverlay) {
    const { ctx, fills } = recordingContext();
    const renderer = createTerminalCanvasRenderer(fakeCanvas(ctx), {
      cols: 80,
      rows: 24,
      cellWidth: 9,
      cellHeight: 18,
      foreground: '#EFE9DF',
      background: '#0B0A09',
    });
    renderer.paintFrame(fullFrame(24), overlay);
    return fills;
  }

  it('fills the selection span with a translucent wash on a full paint', () => {
    const fills = render({ selection: [{ row: 0, startCol: 0, endCol: 5 }] });
    // cols 0..5 at cellWidth 9 = 45px wide, on row 0 (y 0), height = cellHeight.
    const wash = fills.filter(f => f.alpha < 1 && f.y === 0 && f.h === 18 && f.w === 45);
    expect(wash.length).toBeGreaterThan(0);
  });

  it('paints wide cell backgrounds across their full cell span', () => {
    const { ctx, fills } = recordingContext();
    const renderer = createTerminalCanvasRenderer(fakeCanvas(ctx), {
      cols: 8,
      rows: 1,
      cellWidth: 9,
      cellHeight: 18,
      foreground: '#EFE9DF',
      background: '#0B0A09',
    });

    renderer.paintFrame({
      dirty: 'full',
      rows: [{ index: 0, dirty: true, cells: [{ col: 1, width: 2, text: '界', bg: '#ff0000' }] }],
    });

    expect(fills).toContainEqual(expect.objectContaining({ x: 9, y: 0, w: 18, h: 18 }));
  });

  it('positions wide right-half block glyphs from the full rendered width', () => {
    const { ctx, fills } = recordingContext();
    const renderer = createTerminalCanvasRenderer(fakeCanvas(ctx), {
      cols: 8,
      rows: 1,
      cellWidth: 10,
      cellHeight: 18,
      foreground: '#EFE9DF',
      background: '#0B0A09',
    });

    renderer.paintFrame({
      dirty: 'full',
      rows: [{ index: 0, dirty: true, cells: [{ col: 1, width: 2, text: '▐', fg: '#ff0000' }] }],
    });

    expect(fills).toContainEqual(expect.objectContaining({ style: '#ff0000', x: 20, w: 10 }));
  });

  it('draws a cursor on the tail column across the whole wide cell', () => {
    const { ctx, fills } = recordingContext();
    const renderer = createTerminalCanvasRenderer(fakeCanvas(ctx), {
      cols: 8,
      rows: 1,
      cellWidth: 9,
      cellHeight: 18,
      foreground: '#EFE9DF',
      background: '#0B0A09',
    });

    renderer.paintFrame({
      dirty: 'full',
      colors: { cursor: '#00ff00' },
      cursor: { visible: true, row: 0, col: 2, position: { row: 0, col: 2 } },
      rows: [{ index: 0, dirty: true, cells: [{ col: 1, width: 2, text: '界' }] }],
    });

    expect(fills).toContainEqual(expect.objectContaining({ style: '#00ff00', x: 9, w: 18 }));
  });

  it('uses italic font styling for italic terminal cells', () => {
    const { ctx, text } = recordingContext();
    const renderer = createTerminalCanvasRenderer(fakeCanvas(ctx), {
      cols: 8,
      rows: 1,
      cellWidth: 9,
      cellHeight: 18,
      foreground: '#EFE9DF',
      background: '#0B0A09',
    });

    renderer.paintFrame({
      dirty: 'full',
      rows: [
        {
          index: 0,
          dirty: true,
          cells: [{ col: 0, text: 'i', style: { italic: true } }],
        },
      ],
    });

    expect(text).toContainEqual(
      expect.objectContaining({ font: expect.stringMatching(/^italic /u) }),
    );
  });

  it('paints double underline terminal cells as two rules', () => {
    const { ctx, fills } = recordingContext();
    const renderer = createTerminalCanvasRenderer(fakeCanvas(ctx), {
      cols: 8,
      rows: 1,
      cellWidth: 9,
      cellHeight: 18,
      foreground: '#EFE9DF',
      background: '#0B0A09',
    });

    renderer.paintFrame({
      dirty: 'full',
      rows: [
        {
          index: 0,
          dirty: true,
          cells: [{ col: 1, width: 2, text: 'u', fg: '#ff0000', style: { underline: 'double' } }],
        },
      ],
    });

    expect(fills).toContainEqual(
      expect.objectContaining({ style: '#ff0000', x: 9, y: 13, w: 18, h: 1 }),
    );
    expect(fills).toContainEqual(
      expect.objectContaining({ style: '#ff0000', x: 9, y: 16, w: 18, h: 1 }),
    );
  });

  it('paints strikethrough and overline terminal cells', () => {
    const { ctx, fills } = recordingContext();
    const renderer = createTerminalCanvasRenderer(fakeCanvas(ctx), {
      cols: 8,
      rows: 1,
      cellWidth: 9,
      cellHeight: 18,
      foreground: '#EFE9DF',
      background: '#0B0A09',
    });

    renderer.paintFrame({
      dirty: 'full',
      rows: [
        {
          index: 0,
          dirty: true,
          cells: [
            {
              col: 1,
              width: 2,
              text: 's',
              fg: '#ff0000',
              style: { strikethrough: true, overline: true },
            },
          ],
        },
      ],
    });

    expect(fills).toContainEqual(
      expect.objectContaining({ style: '#ff0000', x: 9, y: 9, w: 18, h: 1 }),
    );
    expect(fills).toContainEqual(
      expect.objectContaining({ style: '#ff0000', x: 9, y: 1, w: 18, h: 1 }),
    );
  });

  it('dims faint cells and hides invisible cell glyphs', () => {
    const { ctx, text } = recordingContext();
    const renderer = createTerminalCanvasRenderer(fakeCanvas(ctx), {
      cols: 8,
      rows: 1,
      cellWidth: 9,
      cellHeight: 18,
      foreground: '#EFE9DF',
      background: '#0B0A09',
    });

    renderer.paintFrame({
      dirty: 'full',
      rows: [
        {
          index: 0,
          dirty: true,
          cells: [
            { col: 0, text: 'f', fg: '#ff0000', style: { faint: true } },
            { col: 1, text: 'i', fg: '#ff0000', style: { invisible: true } },
          ],
        },
      ],
    });

    expect(text).toContainEqual(expect.objectContaining({ text: 'f', alpha: 0.55 }));
    expect(text).not.toContainEqual(expect.objectContaining({ text: 'i' }));
  });

  it('does not draw a cursor on a row that was not repainted', () => {
    const { ctx, fills } = recordingContext();
    const renderer = createTerminalCanvasRenderer(fakeCanvas(ctx), {
      cols: 8,
      rows: 2,
      cellWidth: 9,
      cellHeight: 18,
      foreground: '#EFE9DF',
      background: '#0B0A09',
    });

    renderer.paintFrame({
      dirty: 'partial',
      colors: { cursor: '#00ff00' },
      cursor: { visible: true, row: 0, col: 0, position: { row: 0, col: 0 } },
      rows: [{ index: 1, dirty: true, cells: [{ col: 0, text: 'x' }] }],
    });

    expect(fills).not.toContainEqual(expect.objectContaining({ style: '#00ff00' }));
  });
});
