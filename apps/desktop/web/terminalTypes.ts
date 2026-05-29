export type TerminalColor = string | { r: number; g: number; b: number };

export interface TerminalCellStyle {
  bold?: boolean;
  underline?: string;
  inverse?: boolean;
}

export interface TerminalCell {
  col: number;
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
  kittyKeyboardFlags?: number;
}

export interface TerminalScrollback {
  totalRows?: number;
  scrollbackRows?: number;
  viewportOffset?: number;
  viewportRows?: number;
  atBottom?: boolean;
}

export interface TerminalFrame {
  dirty?: 'clean' | 'full' | 'partial';
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

export interface TerminalRenderer {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  clear: (background?: TerminalColor) => void;
  paintFrame: (frame: TerminalFrame, overlay?: TerminalOverlay) => void;
  rowsToPaint: (frame: TerminalFrame) => TerminalRow[];
}
