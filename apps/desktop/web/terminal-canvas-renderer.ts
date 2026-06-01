import type {
  TerminalCell,
  TerminalColor,
  TerminalCursor,
  TerminalFrame,
  TerminalOverlay,
  TerminalRenderer,
  TerminalRendererBackend,
  TerminalRendererCapabilities,
  TerminalRendererStats,
  TerminalRow,
  TerminalUnderlineStyle,
} from './terminalTypes';
import { terminalCellAtColumn, terminalCellWidth } from './terminal/cellGeometry';

const DEFAULT_CELL_WIDTH = 9;
const DEFAULT_CELL_HEIGHT = 18;
const DEFAULT_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
const DEFAULT_FONT_SIZE = 14;
const DEFAULT_FOREGROUND = '#e8e1d7';
const DEFAULT_BACKGROUND = '#060605';
// How opaque the terminal's *default* (unstyled) background is painted.
// 1 = fully opaque (classic terminal box), 0 = fully transparent so the shell
// background shows through, values between = a tint. Cells with an explicit
// non-default background are always painted opaque regardless of this.
const DEFAULT_BACKGROUND_OPACITY = 1;
// Selection highlight is a translucent tint of the foreground (monochrome, no
// status color) laid over the glyphs so selected text stays legible. Tuned to
// read clearly over the near-black terminal panel (close to macOS-native
// selection), while staying translucent enough to keep the glyphs legible.
const SELECTION_ALPHA = 0.38;
// Search-match wash (all matches) + the active match's stronger fill. Monochrome
// (foreground-tinted); the active match also gets a 1px outline.
const SEARCH_MATCH_ALPHA = 0.22;
const ACTIVE_MATCH_ALPHA = 0.48;
const FAINT_ALPHA = 0.55;
// Link underline is drawn at the foreground color; the hovered link gets a
// slightly thicker rule.
const LINK_UNDERLINE_HEIGHT = 1;
const HOVER_LINK_UNDERLINE_HEIGHT = 2;
const PALETTE = ['#d8dee9', '#88c0d0', '#a3be8c', '#ebcb8b', '#d08770', '#b48ead', '#81a1c1'];
const CANVAS_RENDERER_CAPABILITIES: TerminalRendererCapabilities = {
  backend: 'canvas2d',
  gpuAccelerated: false,
  fallback: true,
  explicitResourceManagement: false,
  retainedPartialPaint: true,
};

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
  backgroundOpacity?: number;
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
  // Fall back to the (theme) foreground, not a fixed light color: when the VT
  // reports no cursor color, a cream default would vanish on a light surface.
  const defaultCursor = options.cursor ?? defaultForeground;
  const backgroundOpacity = Math.min(
    1,
    Math.max(0, options.backgroundOpacity ?? DEFAULT_BACKGROUND_OPACITY),
  );
  const opaqueBackground = backgroundOpacity >= 1;
  const dpr = window.devicePixelRatio || 1;
  // An opaque background can use a faster non-alpha buffer; any transparency or
  // tint needs the alpha channel so the shell shows through behind the glyphs.
  const context = canvas.getContext('2d', { alpha: !opaqueBackground });

  if (!context) {
    throw new Error('Canvas 2D context is unavailable');
  }

  const ctx: CanvasRenderingContext2D = context;
  let stats = emptyRendererStats('canvas2d');

  canvas.width = cols * cellWidth * dpr;
  canvas.height = rows * cellHeight * dpr;
  canvas.style.width = `${cols * cellWidth}px`;
  canvas.style.height = `${rows * cellHeight}px`;

  ctx.scale(dpr, dpr);
  ctx.textBaseline = 'top';
  setFont(false);
  ctx.textRendering = 'geometricPrecision';

  function setFont(bold: boolean, italic = false) {
    ctx.font = `${italic ? 'italic ' : ''}${bold ? '700' : '400'} ${fontSize}px ${fontFamily}`;
  }

  function colorToCss(color: TerminalColor | undefined, fallback: string) {
    if (!color) return fallback;
    if (typeof color === 'string') return color;
    return `rgb(${color.r}, ${color.g}, ${color.b})`;
  }

  function underlineStyle(cell: TerminalCell): TerminalUnderlineStyle | null {
    if (cell.underline) return 'single';
    const underline = cell.style?.underline;
    if (!underline || underline === 'none') return null;
    return underline;
  }

  function cellBold(cell: TerminalCell) {
    return Boolean(cell.bold || cell.style?.bold);
  }

  function cellItalic(cell: TerminalCell) {
    return Boolean(cell.style?.italic);
  }

  function cellForegroundAlpha(cell: TerminalCell) {
    return cell.style?.faint ? FAINT_ALPHA : 1;
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
    if (frame.dirty === 'clean') return [];
    if (frame.dirty === 'full') return frame.rows;
    const dirtyRows = frame.rows.filter(row => row.dirty);
    return dirtyRows;
  }

  // Paint the terminal's default (unstyled) background for a region. Fully
  // opaque draws a solid fill; otherwise the region is cleared to transparent
  // first (so glyph antialiasing never accumulates across repaints) and an
  // optional tint is laid down at the configured opacity.
  function paintDefaultBackground(
    x: number,
    y: number,
    width: number,
    height: number,
    color: string,
  ) {
    if (opaqueBackground) {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, width, height);
      return;
    }

    ctx.clearRect(x, y, width, height);
    if (backgroundOpacity > 0) {
      const previousAlpha = ctx.globalAlpha;
      ctx.globalAlpha = backgroundOpacity;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, width, height);
      ctx.globalAlpha = previousAlpha;
    }
  }

  function clear(backgroundColor?: TerminalColor) {
    stats.clears += 1;
    paintDefaultBackground(
      0,
      0,
      cols * cellWidth,
      rows * cellHeight,
      colorToCss(backgroundColor, defaultBackground),
    );
  }

  function paintBlockGlyph(text: string, x: number, y: number, width: number, color: string) {
    const halfWidth = Math.ceil(width / 2);
    const halfHeight = Math.ceil(cellHeight / 2);
    const rightHalfX = x + Math.floor(width / 2);
    ctx.fillStyle = color;

    switch (text) {
      case '█':
        ctx.fillRect(x, y, width, cellHeight);
        stats.blockGlyphsPainted += 1;
        return true;
      case '▀':
        ctx.fillRect(x, y, width, halfHeight);
        stats.blockGlyphsPainted += 1;
        return true;
      case '▄':
        ctx.fillRect(x, y + Math.floor(cellHeight / 2), width, halfHeight);
        stats.blockGlyphsPainted += 1;
        return true;
      case '▌':
        ctx.fillRect(x, y, halfWidth, cellHeight);
        stats.blockGlyphsPainted += 1;
        return true;
      case '▐':
        ctx.fillRect(rightHalfX, y, halfWidth, cellHeight);
        stats.blockGlyphsPainted += 1;
        return true;
      case '▖':
        ctx.fillRect(x, y + Math.floor(cellHeight / 2), halfWidth, halfHeight);
        stats.blockGlyphsPainted += 1;
        return true;
      case '▗':
        ctx.fillRect(rightHalfX, y + Math.floor(cellHeight / 2), halfWidth, halfHeight);
        stats.blockGlyphsPainted += 1;
        return true;
      case '▘':
        ctx.fillRect(x, y, halfWidth, halfHeight);
        stats.blockGlyphsPainted += 1;
        return true;
      case '▝':
        ctx.fillRect(rightHalfX, y, halfWidth, halfHeight);
        stats.blockGlyphsPainted += 1;
        return true;
      default:
        return false;
    }
  }

  function paintCellUnderline(
    x: number,
    y: number,
    width: number,
    style: TerminalUnderlineStyle,
    color: string,
  ) {
    ctx.fillStyle = color;
    const baseline = y + cellHeight - 3;
    switch (style) {
      case 'double':
        ctx.fillRect(x, baseline - 2, width, 1);
        ctx.fillRect(x, baseline + 1, width, 1);
        break;
      case 'dotted':
        for (let offset = 0; offset < width; offset += 4) {
          ctx.fillRect(x + offset, baseline, Math.min(2, width - offset), 1);
        }
        break;
      case 'dashed':
        for (let offset = 0; offset < width; offset += 7) {
          ctx.fillRect(x + offset, baseline, Math.min(4, width - offset), 1);
        }
        break;
      case 'curly':
        for (let offset = 0; offset < width; offset += 4) {
          const segmentWidth = Math.min(2, width - offset);
          ctx.fillRect(x + offset, baseline + (offset % 8 === 0 ? 0 : 1), segmentWidth, 1);
        }
        break;
      default:
        ctx.fillRect(x, baseline, width, 1);
    }
  }

  function paintCellRule(x: number, y: number, width: number, offsetY: number, color: string) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y + offsetY, width, 1);
  }

  function cellAt(frame: TerminalFrame, rowIndex: number, col: number) {
    return terminalCellAtColumn(
      frame.rows.find(row => row.index === rowIndex),
      col,
      cols,
    );
  }

  function paintCursor(
    frame: TerminalFrame,
    foreground: string,
    background: string,
    paintedRows: ReadonlySet<number>,
  ) {
    const cursor = cursorPosition(frame.cursor);
    if (!frame.cursor?.visible || !cursor) return;
    if (!paintedRows.has(cursor.row)) return;

    const cell = cellAt(frame, cursor.row, cursor.col);
    const cursorCol = cell?.col ?? cursor.col;
    const cursorWidth = terminalCellWidth(cell ?? { col: cursorCol }, cols) * cellWidth;
    const x = cursorCol * cellWidth;
    const y = cursor.row * cellHeight;
    const cursorColor = colorToCss(frame.colors?.cursor, defaultCursor);
    const style = frame.cursor.style ?? 'block';

    if (style === 'bar') {
      ctx.fillStyle = cursorColor;
      ctx.fillRect(x, y + 1, 2, cellHeight - 2);
      return;
    }

    if (style === 'underline') {
      ctx.fillStyle = cursorColor;
      ctx.fillRect(x, y + cellHeight - 3, cursorWidth, 2);
      return;
    }

    if (style === 'block_hollow') {
      ctx.strokeStyle = cursorColor;
      ctx.strokeRect(x + 0.5, y + 0.5, cursorWidth - 1, cellHeight - 1);
      return;
    }

    ctx.fillStyle = cursorColor;
    ctx.fillRect(x, y, cursorWidth, cellHeight);

    if (cell?.text && cell.text !== ' ' && !cell.style?.invisible) {
      ctx.fillStyle = background === cursorColor ? foreground : background;
      setFont(cellBold(cell), cellItalic(cell));
      stats.glyphsPainted += 1;
      ctx.fillText(cell.text, x, y + 1);
    }
  }

  // Draw selection highlight + link underlines on top of the glyph layer. Only
  // spans on rows that were actually repainted this frame are drawn, so partial
  // (dirty-row) paints never re-tint an already-tinted row. The controller
  // forces a full paint whenever the selection or hover changes, so a changed
  // overlay always lands on freshly painted rows.
  function fillSpanRow(span: { row: number; startCol: number; endCol: number }) {
    const x = span.startCol * cellWidth;
    const width = (span.endCol - span.startCol) * cellWidth;
    if (width > 0) ctx.fillRect(x, span.row * cellHeight, width, cellHeight);
  }

  function paintOverlay(overlay: TerminalOverlay, paintedRows: Set<number>, foreground: string) {
    const selection = overlay.selection ?? [];
    if (selection.length > 0) {
      const previousAlpha = ctx.globalAlpha;
      ctx.globalAlpha = SELECTION_ALPHA;
      ctx.fillStyle = foreground;
      for (const span of selection) {
        if (paintedRows.has(span.row)) fillSpanRow(span);
      }
      ctx.globalAlpha = previousAlpha;
    }

    // Search matches: a lighter foreground wash for every match in view, with
    // the active match a stronger fill plus a 1px outline (no status color, so
    // it stays within the monochrome design rule).
    const searchMatches = overlay.searchMatches ?? [];
    if (searchMatches.length > 0) {
      const previousAlpha = ctx.globalAlpha;
      ctx.globalAlpha = SEARCH_MATCH_ALPHA;
      ctx.fillStyle = foreground;
      for (const span of searchMatches) {
        if (paintedRows.has(span.row)) fillSpanRow(span);
      }
      ctx.globalAlpha = previousAlpha;
    }
    const active = overlay.activeMatch;
    if (active && paintedRows.has(active.row)) {
      const previousAlpha = ctx.globalAlpha;
      ctx.globalAlpha = ACTIVE_MATCH_ALPHA;
      ctx.fillStyle = foreground;
      fillSpanRow(active);
      ctx.globalAlpha = previousAlpha;
      const x = active.startCol * cellWidth;
      const width = (active.endCol - active.startCol) * cellWidth;
      if (width > 0) {
        ctx.strokeStyle = foreground;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, active.row * cellHeight + 0.5, width - 1, cellHeight - 1);
      }
    }

    const links = overlay.links ?? [];
    ctx.fillStyle = foreground;
    for (const span of links) {
      if (!paintedRows.has(span.row)) continue;
      const x = span.startCol * cellWidth;
      const width = (span.endCol - span.startCol) * cellWidth;
      if (width > 0)
        ctx.fillRect(x, span.row * cellHeight + cellHeight - 2, width, LINK_UNDERLINE_HEIGHT);
    }

    const hover = overlay.hoverLink;
    if (hover && paintedRows.has(hover.row)) {
      const x = hover.startCol * cellWidth;
      const width = (hover.endCol - hover.startCol) * cellWidth;
      if (width > 0)
        ctx.fillRect(
          x,
          hover.row * cellHeight + cellHeight - 2,
          width,
          HOVER_LINK_UNDERLINE_HEIGHT,
        );
    }
  }

  function paintFrame(frame: TerminalFrame, overlay?: TerminalOverlay) {
    const paintRows = rowsToPaint(frame);
    const cellsPainted = paintRows.reduce((sum, row) => sum + row.cells.length, 0);
    stats.paints += 1;
    stats.rowsPainted += paintRows.length;
    stats.cellsPainted += cellsPainted;
    stats.maxRowsPerPaint = Math.max(stats.maxRowsPerPaint, paintRows.length);
    stats.maxCellsPerPaint = Math.max(stats.maxCellsPerPaint, cellsPainted);
    // The default foreground/background are Reverie's theme colors (the renderer
    // options), not Ghostty's hardwired white-on-black `frame.colors`. Cells the
    // CLI styled carry explicit fg/bg and still paint with their own colors;
    // every unstyled cell resolves to the theme default here, so the terminal
    // reads as a solid themed panel that matches the shell.
    const foreground = defaultForeground;
    const background = defaultBackground;

    for (const row of paintRows) {
      paintDefaultBackground(0, row.index * cellHeight, cols * cellWidth, cellHeight, background);

      for (const cell of row.cells) {
        const drawWidth = terminalCellWidth(cell, cols) * cellWidth;
        const inverse = Boolean(cell.style?.inverse);
        const fg = inverse ? colorToCss(cell.bg, background) : colorToCss(cell.fg, foreground);
        const bg = inverse ? colorToCss(cell.fg, foreground) : colorToCss(cell.bg, background);
        if (bg !== background) {
          ctx.fillStyle = bg;
          ctx.fillRect(cell.col * cellWidth, row.index * cellHeight, drawWidth, cellHeight);
        }

        const x = cell.col * cellWidth;
        const y = row.index * cellHeight;
        if (!cell.style?.invisible) {
          const previousAlpha = ctx.globalAlpha;
          ctx.globalAlpha = previousAlpha * cellForegroundAlpha(cell);

          if (!paintBlockGlyph(cell.text, x, y, drawWidth, fg)) {
            ctx.fillStyle = fg;
            setFont(cellBold(cell), cellItalic(cell));
            stats.glyphsPainted += 1;
            ctx.fillText(cell.text, x, y + 1);
          }

          const underline = underlineStyle(cell);
          if (underline) {
            paintCellUnderline(
              cell.col * cellWidth,
              row.index * cellHeight,
              drawWidth,
              underline,
              fg,
            );
          }
          if (cell.style?.strikethrough) {
            paintCellRule(x, y, drawWidth, Math.floor(cellHeight / 2), fg);
          }
          if (cell.style?.overline) {
            paintCellRule(x, y, drawWidth, 1, fg);
          }

          ctx.globalAlpha = previousAlpha;
        }
      }
    }

    const paintedRows = new Set(paintRows.map(row => row.index));
    paintCursor(frame, foreground, background, paintedRows);
    if (overlay) {
      paintOverlay(overlay, paintedRows, foreground);
    }
  }

  return {
    capabilities: CANVAS_RENDERER_CAPABILITIES,
    cols,
    rows,
    cellWidth,
    cellHeight,
    clear,
    paintFrame,
    rowsToPaint,
    takeStats() {
      const out = stats;
      stats = emptyRendererStats('canvas2d');
      return out;
    },
    dispose() {},
  };
}

function emptyRendererStats(backend: TerminalRendererBackend): TerminalRendererStats {
  return {
    backend,
    paints: 0,
    clears: 0,
    rowsPainted: 0,
    cellsPainted: 0,
    glyphsPainted: 0,
    blockGlyphsPainted: 0,
    drawCalls: 0,
    rectDrawCalls: 0,
    glyphDrawCalls: 0,
    rectVertices: 0,
    glyphVertices: 0,
    bufferUploads: 0,
    bufferUploadBytes: 0,
    glyphAtlasHits: 0,
    glyphAtlasMisses: 0,
    glyphAtlasUploads: 0,
    glyphAtlasResets: 0,
    maxRowsPerPaint: 0,
    maxCellsPerPaint: 0,
  };
}

export function makeSyntheticFrame(
  frameIndex: number,
  options: {
    cols?: number;
    rows?: number;
    dirtyRowsPerFrame?: number;
    dirtyOnly?: boolean;
  } = {},
): TerminalFrame {
  const cols = options.cols ?? TERMINAL_SURFACE.cols;
  const rowsCount = options.rows ?? TERMINAL_SURFACE.rows;
  const dirtyRowsPerFrame = options.dirtyRowsPerFrame ?? 8;
  const dirtyOnly = options.dirtyOnly ?? false;
  const rows: TerminalRow[] = [];
  const dirtyStart = frameIndex % rowsCount;

  for (let row = 0; row < rowsCount; row += 1) {
    const dirty = !dirtyOnly || (row + rowsCount - dirtyStart) % rowsCount < dirtyRowsPerFrame;
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
