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
  row?: number;
  col?: number;
  position?: {
    row: number;
    col: number;
  };
}

export interface TerminalFrame {
  dirty?: 'full' | 'partial';
  rows: TerminalRow[];
  cursor?: TerminalCursor;
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
  clear: () => void;
  paintFrame: (frame: TerminalFrame) => void;
  rowsToPaint: (frame: TerminalFrame) => TerminalRow[];
}
