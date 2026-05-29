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

export interface TerminalRenderer {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  clear: (background?: TerminalColor) => void;
  paintFrame: (frame: TerminalFrame) => void;
  rowsToPaint: (frame: TerminalFrame) => TerminalRow[];
}
