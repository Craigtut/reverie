export type TerminalColor = string | { r: number; g: number; b: number };
export type TerminalUnderlineStyle = 'none' | 'single' | 'double' | 'curly' | 'dotted' | 'dashed';

export interface TerminalCellStyle {
  bold?: boolean;
  italic?: boolean;
  faint?: boolean;
  blink?: boolean;
  invisible?: boolean;
  underline?: TerminalUnderlineStyle;
  inverse?: boolean;
  strikethrough?: boolean;
  overline?: boolean;
}

export interface TerminalCell {
  col: number;
  width?: number;
  text: string;
  fg?: TerminalColor;
  bg?: TerminalColor;
  bold?: boolean;
  underline?: boolean;
  style?: TerminalCellStyle;
}

export interface TerminalRow {
  index: number;
  dirty?: boolean;
  cells: TerminalCell[];
}

export interface TerminalCursor {
  visible?: boolean;
  blinking?: boolean;
  style?: 'block' | 'block_hollow' | 'bar' | 'underline';
  row?: number;
  col?: number;
  position?: {
    row: number;
    col: number;
  };
}

export interface TerminalModes {
  cursorKeyApplication?: boolean;
  keypadKeyApplication?: boolean;
  bracketedPaste?: boolean;
  syncOutput?: boolean;
  mouseTracking?: boolean;
  alternateScreen?: boolean;
  kittyKeyboardFlags?: number;
}

export interface TerminalScrollback {
  totalRows?: number;
  scrollbackRows?: number;
  viewportOffset?: number;
  viewportRows?: number;
  atBottom?: boolean;
  // Stable id of the oldest buffered row (rows evicted off the top so far). A
  // buffered row at absolute position `p` has stable id `oldestId + p`, so the
  // frontend keys its cache and viewport anchor by an id that survives trim.
  // 0 until the scrollback cap first evicts. See decisions.md D8.
  oldestId?: number;
}

export interface TerminalFrame {
  dirty?: 'clean' | 'full' | 'partial';
  cols?: number;
  rows: TerminalRow[];
  cursor?: TerminalCursor;
  modes?: TerminalModes;
  scrollback?: TerminalScrollback;
  colors?: {
    foreground?: TerminalColor;
    background?: TerminalColor;
    cursor?: TerminalColor;
  };
}

// A horizontal run of cells on one painted (window-local) row, used to draw
// selection highlight and link underlines on top of the glyph layer.
export interface RowSpan {
  row: number; // window-local row index (0..displayRows)
  startCol: number; // inclusive
  endCol: number; // exclusive
}

// Optional decorations the renderer paints over the glyphs. All spans are
// window-local; the controller translates them from buffer coordinates.
export interface TerminalOverlay {
  selection?: RowSpan[];
  links?: RowSpan[];
  hoverLink?: RowSpan;
}

export type TerminalRendererBackend = 'webgpu' | 'webgl2' | 'canvas2d';

export interface TerminalRendererCapabilities {
  backend: TerminalRendererBackend;
  gpuAccelerated: boolean;
  fallback: boolean;
  explicitResourceManagement: boolean;
  // True when partial paints can rely on pixels from previous paints remaining
  // valid between browser frames. Canvas 2D can retain and repaint dirty rows;
  // WebGL/WebGPU paths should usually paint self-contained visible windows unless
  // they own an explicit retained texture/FBO.
  retainedPartialPaint: boolean;
}

export interface TerminalRendererStats {
  backend: TerminalRendererBackend;
  paints: number;
  clears: number;
  rowsPainted: number;
  cellsPainted: number;
  glyphsPainted: number;
  blockGlyphsPainted: number;
  drawCalls: number;
  rectDrawCalls: number;
  glyphDrawCalls: number;
  rectVertices: number;
  glyphVertices: number;
  bufferUploads: number;
  bufferUploadBytes: number;
  glyphAtlasHits: number;
  glyphAtlasMisses: number;
  glyphAtlasUploads: number;
  glyphAtlasResets: number;
  maxRowsPerPaint: number;
  maxCellsPerPaint: number;
}

export type TerminalPaintReason = 'frame' | 'scroll' | 'overlay' | 'history' | 'clear';

export interface TerminalPaintCursorSample {
  visible: boolean;
  row: number | null;
  col: number | null;
  inPaintRows: boolean;
}

export interface TerminalPaintSample {
  backend?: TerminalRendererBackend;
  reason: TerminalPaintReason;
  elapsedMs: number;
  startRow: number;
  displayRows: number;
  fullPaint: boolean;
  bufferBacked: boolean;
  rowsPainted: number;
  cellsPainted: number;
  cursor?: TerminalPaintCursorSample;
  rendererStats?: TerminalRendererStats;
}

export interface TerminalRenderer {
  capabilities: TerminalRendererCapabilities;
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  clear: (background?: TerminalColor) => void;
  paintFrame: (frame: TerminalFrame, overlay?: TerminalOverlay) => void;
  rowsToPaint: (frame: TerminalFrame) => TerminalRow[];
  takeStats?: () => TerminalRendererStats;
  dispose?: () => void;
}
