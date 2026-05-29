// Shared types for the terminal interaction layer.
//
// The interaction layer turns a pointer position into a semantic target and asks
// "what can be done here", then surfaces those actions through a menu / click /
// keyboard. Selection, copy, and links are all MODEL operations: we hit-test
// pixels to cells, keep the model in buffer coordinates, and reconstruct text
// from the cell model. The canvas is only ever a paint target.

// A cell address in COMPOSITE-FRAME coordinates: `row` indexes into the
// composite frame's rows (not the painted window), so it survives scrolling.
export interface BufferCell {
  row: number;
  col: number;
}

// A normalized selection: `start` is top-left, `end` is bottom-right, both
// INCLUSIVE (selectionText and the overlay both treat end.col as the last
// selected column). The interaction controller suppresses zero-movement clicks
// via its own `moved` guard, so a range here always names real selected cells.
export interface SelectionRange {
  start: BufferCell;
  end: BufferCell;
}

// How a drag/click grows the selection: per-character, per-word (double-click),
// or whole-line (triple-click).
export type SelectionMode = 'char' | 'word' | 'line';

// The renderer owns the overlay contract; re-export it here so interaction
// modules have one import home for their shared types.
export type { RowSpan, TerminalOverlay } from '../../terminalTypes';

import type { TerminalFrame } from '../../terminalTypes';
import type { TerminalSurface } from '../../terminalScrollback';

// --- Targets: what's semantically under the pointer ---

// An active text selection (the right-click-on-selection case).
export interface SelectionTarget {
  kind: 'selection';
  text: string;
  isUrl: boolean;
  url?: string; // present iff the whole selection is a single openable URL
}

// A detected link (URL) under the pointer.
export interface LinkTarget {
  kind: 'link';
  href: string;
  text: string;
  cell: BufferCell;
}

// A detected link in buffer coordinates: one row, [startCol, endCol). The
// terminal controller stores these so hover/underline/click can resolve quickly.
export interface BufferLinkSpan {
  row: number;
  startCol: number;
  endCol: number;
  href: string;
}

// A cell with content but no selection/link (the general right-click case).
export interface GridTarget {
  kind: 'grid';
  cell: BufferCell;
}

// Blank space / outside the grid.
export interface EmptyTarget {
  kind: 'empty';
  cell: BufferCell | null;
}

export type InteractionTarget = SelectionTarget | LinkTarget | GridTarget | EmptyTarget;
export type InteractionTargetKind = InteractionTarget['kind'];

// The normalized input a resolver inspects to produce targets.
export interface InteractionProbe {
  cell: BufferCell | null;
  frame: TerminalFrame;
  surface: TerminalSurface;
  selection: SelectionRange | null;
  selectionText: string;
  modifiers: { shift: boolean; meta: boolean; ctrl: boolean; alt: boolean };
}

// A registered way to recognize a target. Higher priority wins when several
// resolvers fire for the same probe.
export interface TargetResolver {
  id: string;
  priority: number;
  resolve(probe: InteractionProbe): InteractionTarget[];
}

// --- Actions: what can be done to a target ---

export type ActionGroup = 'clipboard' | 'open' | 'search' | 'agent' | 'find' | 'select';

// The injected services an action runs against. This is the ONLY seam between
// the registry (app-agnostic) and the app: the React layer builds it, closing
// over the terminal hook + stores, and a test/harness can fake it wholesale.
export interface AskAgentOptions {
  focusId?: string;
  cwd?: string;
}

export interface ActionContext {
  copyText(text: string): Promise<void>;
  pasteFromClipboard(): Promise<void>;
  selectAll(): void;
  clearSelection(): void;
  searchWeb(query: string): Promise<void>;
  openUrl(href: string): Promise<void>;
  sendToInput(text: string): Promise<void>;
  askAgent(prompt: string, opts?: AskAgentOptions): Promise<void>;
  openFind(prefill?: string): void;
  clipboardWriteAvailable: boolean;
  clipboardReadAvailable: boolean;
  canSendInput: boolean;
}

// A declarative menu action. `kinds` is the generalization seam: a new menu item
// is one registerAction call naming the target kinds it applies to. `isAvailable`
// hides an item; `isEnabled` greys it out (kept stable so menu shape is testable).
export interface TerminalAction<T extends InteractionTarget = InteractionTarget> {
  id: string;
  group: ActionGroup;
  order: number;
  kinds: InteractionTargetKind[];
  label: string | ((target: T, ctx: ActionContext) => string);
  isAvailable?(target: T, ctx: ActionContext): boolean;
  isEnabled?(target: T, ctx: ActionContext): boolean;
  invoke(target: T, ctx: ActionContext): void | Promise<void>;
}

// --- Menu model handed to React (flat, already resolved) ---

export interface MenuItemModel {
  id: string;
  label: string;
  group: ActionGroup;
  enabled: boolean;
  onInvoke: () => void;
}

export interface MenuModel {
  open: boolean;
  x: number;
  y: number;
  items: MenuItemModel[];
}
