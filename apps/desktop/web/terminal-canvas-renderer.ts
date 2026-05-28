import type { TerminalCell, TerminalColor, TerminalCursor, TerminalFrame, TerminalRenderer, TerminalRow } from './terminalTypes';

const DEFAULT_CELL_WIDTH = 9;
const DEFAULT_CELL_HEIGHT = 18;
const DEFAULT_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
const DEFAULT_FONT_SIZE = 14;
const DEFAULT_FOREGROUND = '#d8dee9';
const DEFAULT_BACKGROUND = '#0b1020';
const DEFAULT_CURSOR = '#eceff4';
const PALETTE = [
  '#d8dee9', '#88c0d0', '#a3be8c', '#ebcb8b', '#d08770', '#b48ead', '#81a1c1',
];

export const TERMINAL_SURFACE = Object.freeze({
  cols: 120,
  rows: 36,
  cellWidth: DEFAULT_CELL_WIDTH,
  cellHeight: DEFAULT_CELL_HEIGHT,
});

export interface TerminalCanvasOptions {
  cols?: number;
  rows?: number;
  cellWidth?: number;
  cellHeight?: number;
  fontSize?: number;
  fontFamily?: string;
  foreground?: string;
  background?: string;
  cursor?: string;
}

export function createTerminalCanvasRenderer(
  canvas: HTMLCanvasElement,
  options: TerminalCanvasOptions = {},
): TerminalRenderer {
  const cols = options.cols ?? TERMINAL_SURFACE.cols;
  const rows = options.rows ?? TERMINAL_SURFACE.rows;
  const cellWidth = options.cellWidth ?? DEFAULT_CELL_WIDTH;
  const cellHeight = options.cellHeight ?? DEFAULT_CELL_HEIGHT;
  const fontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
  const fontFamily = options.fontFamily ?? DEFAULT_FONT_FAMILY;
  const defaultForeground = options.foreground ?? DEFAULT_FOREGROUND;
  const defaultBackground = options.background ?? DEFAULT_BACKGROUND;
  const defaultCursor = options.cursor ?? DEFAULT_CURSOR;
  const dpr = window.devicePixelRatio || 1;
  const context = canvas.getContext('2d', { alpha: false });

  if (!context) {
    throw new Error('Canvas 2D context is unavailable');
  }

  const ctx: CanvasRenderingContext2D = context;

  canvas.width = cols * cellWidth * dpr;
  canvas.height = rows * cellHeight * dpr;
  canvas.style.width = `${cols * cellWidth}px`;
  canvas.style.height = `${rows * cellHeight}px`;

  ctx.scale(dpr, dpr);
  ctx.textBaseline = 'top';
  setFont(false);

  function setFont(bold: boolean) {
    ctx.font = `${bold ? '700' : '400'} ${fontSize}px ${fontFamily}`;
  }

  function colorToCss(color: TerminalColor | undefined, fallback: string) {
    if (!color) return fallback;
    if (typeof color === 'string') return color;
    return `rgb(${color.r}, ${color.g}, ${color.b})`;
  }

  function underlineEnabled(cell: TerminalCell) {
    return Boolean(cell.underline || (cell.style && cell.style.underline !== 'none'));
  }

  function cellBold(cell: TerminalCell) {
    return Boolean(cell.bold || cell.style?.bold);
  }

  function cursorPosition(cursor: TerminalCursor | undefined) {
    if (!cursor) return null;
    if (cursor.position) return cursor.position;
    if (Number.isFinite(cursor.row) && Number.isFinite(cursor.col)) {
      return { row: cursor.row as number, col: cursor.col as number };
    }
    return null;
  }

  function rowsToPaint(frame: TerminalFrame): TerminalRow[] {
    if (frame.dirty === 'full') return frame.rows;
    const dirtyRows = frame.rows.filter(row => row.dirty);
    return dirtyRows.length > 0 ? dirtyRows : frame.rows;
  }

  function clear() {
    ctx.fillStyle = defaultBackground;
    ctx.fillRect(0, 0, cols * cellWidth, rows * cellHeight);
  }

  function paintFrame(frame: TerminalFrame) {
    const paintRows = rowsToPaint(frame);
    const foreground = colorToCss(frame.colors?.foreground, defaultForeground);
    const background = colorToCss(frame.colors?.background, defaultBackground);

    for (const row of paintRows) {
      ctx.fillStyle = background;
      ctx.fillRect(0, row.index * cellHeight, cols * cellWidth, cellHeight);

      for (const cell of row.cells) {
        const inverse = Boolean(cell.style?.inverse);
        const fg = inverse ? colorToCss(cell.bg, background) : colorToCss(cell.fg, foreground);
        const bg = inverse ? colorToCss(cell.fg, foreground) : colorToCss(cell.bg, background);
        if (bg !== background) {
          ctx.fillStyle = bg;
          ctx.fillRect(cell.col * cellWidth, row.index * cellHeight, cellWidth, cellHeight);
        }

        ctx.fillStyle = fg;
        setFont(cellBold(cell));
        ctx.fillText(cell.text, cell.col * cellWidth, row.index * cellHeight + 1);

        if (underlineEnabled(cell)) {
          ctx.fillRect(cell.col * cellWidth, row.index * cellHeight + cellHeight - 3, cellWidth, 1);
        }
      }
    }

    const cursor = cursorPosition(frame.cursor);
    if (frame.cursor?.visible && cursor) {
      ctx.strokeStyle = colorToCss(frame.colors?.cursor, defaultCursor);
      ctx.strokeRect(cursor.col * cellWidth + 0.5, cursor.row * cellHeight + 0.5, cellWidth - 1, cellHeight - 1);
    }
  }

  return {
    cols,
    rows,
    cellWidth,
    cellHeight,
    clear,
    paintFrame,
    rowsToPaint,
  };
}

export function makeSyntheticFrame(frameIndex: number, options: {
  cols?: number;
  rows?: number;
  dirtyRowsPerFrame?: number;
  dirtyOnly?: boolean;
} = {}): TerminalFrame {
  const cols = options.cols ?? TERMINAL_SURFACE.cols;
  const rowsCount = options.rows ?? TERMINAL_SURFACE.rows;
  const dirtyRowsPerFrame = options.dirtyRowsPerFrame ?? 8;
  const dirtyOnly = options.dirtyOnly ?? false;
  const rows: TerminalRow[] = [];
  const dirtyStart = frameIndex % rowsCount;

  for (let row = 0; row < rowsCount; row += 1) {
    const dirty = !dirtyOnly || ((row + rowsCount - dirtyStart) % rowsCount) < dirtyRowsPerFrame;
    const cells: TerminalCell[] = [];

    if (dirty) {
      for (let col = 0; col < cols; col += 1) {
        cells.push(makeSyntheticCell(row, col, frameIndex));
      }
    }

    rows.push({ index: row, dirty, cells });
  }

  return {
    dirty: dirtyOnly ? 'partial' : 'full',
    rows,
    cursor: { visible: true, row: frameIndex % rowsCount, col: (frameIndex * 3) % cols },
  };
}

function makeSyntheticCell(row: number, col: number, frame: number): TerminalCell {
  const cursor = (frame + row + col) % 17 === 0;
  const styled = (row + col + frame) % 11 === 0;
  const text = styled ? '◆' : String.fromCharCode(33 + ((row * 13 + col + frame) % 90));

  return {
    col,
    text,
    fg: styled ? PALETTE[(row + col + frame) % PALETTE.length] : DEFAULT_FOREGROUND,
    bg: cursor ? '#3b4252' : DEFAULT_BACKGROUND,
    bold: styled,
    underline: (row + frame) % 19 === 0,
  };
}

export function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
