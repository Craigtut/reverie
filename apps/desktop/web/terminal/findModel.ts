import type { TerminalFrame } from '../terminalTypes';
import { terminalRowTextLayout, terminalTextRangeToCellSpan } from './cellGeometry';

// Pure substring-find model for the terminal: no DOM, no state. The interaction
// controller + find bar drive these. v1 is plain substring with a case toggle
// (no regex); matches are within a single rendered row (wrapped-line matches are
// a documented limitation). Columns are half-open [start, end) to match RowSpan.

export interface LineMatch {
  startCol: number;
  endCol: number;
}

export interface FrameMatch {
  row: number; // composite-frame row index
  startCol: number;
  endCol: number;
  lineText: string;
}

// Non-overlapping left-to-right matches of `query` within one line of text.
// Empty query (or whitespace-only) yields none.
export function findMatchesInLine(
  lineText: string,
  query: string,
  caseSensitive: boolean,
): LineMatch[] {
  if (query.length === 0) return [];
  const haystack = caseSensitive ? lineText : lineText.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: LineMatch[] = [];
  let from = 0;
  // Search the case-folded copy but emit column indices into the original line;
  // toLowerCase here is 1:1 in length for the BMP text terminals emit, so column
  // offsets line up.
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    matches.push({ startCol: index, endCol: index + needle.length });
    from = index + needle.length; // non-overlapping
  }
  return matches;
}

// All matches across a composite frame, in reading order. `cols` bounds the
// per-row text reconstruction. Each match carries the full line text for the
// find bar's context.
export function findMatchesInFrame(
  frame: TerminalFrame,
  query: string,
  caseSensitive: boolean,
  cols: number,
): FrameMatch[] {
  if (query.length === 0) return [];
  const out: FrameMatch[] = [];
  for (const row of frame.rows) {
    const layout = terminalRowTextLayout(row, cols);
    const lineText = layout.text.replace(/\s+$/u, '');
    if (lineText.length === 0) continue;
    for (const match of findMatchesInLine(lineText, query, caseSensitive)) {
      const span = terminalTextRangeToCellSpan(layout, match.startCol, match.endCol);
      out.push({ row: row.index, startCol: span.startCol, endCol: span.endCol, lineText });
    }
  }
  return out;
}

// "3 / 12", "3 / 2000+" when capped, "0 / 0" when empty. `current` is 1-based;
// pass 0 for no active match.
export function formatMatchCount(current: number, total: number, capped: boolean): string {
  const totalLabel = capped ? `${total}+` : `${total}`;
  return `${current} / ${totalLabel}`;
}

// Wrap an index into [0, total) for next/prev cycling; -1 when there are none.
export function cycleIndex(index: number, total: number, delta: number): number {
  if (total <= 0) return -1;
  return (((index + delta) % total) + total) % total;
}

// When a same-query search replay resolves after the user has navigated, keep
// the visible active match instead of snapping back to the first result.
export function resolvedActiveMatchIndex(matches: FrameMatch[], active?: FrameMatch): number {
  if (matches.length === 0) return -1;
  if (!active) return 0;
  const index = matches.findIndex(
    match =>
      match.row === active.row &&
      match.startCol === active.startCol &&
      match.endCol === active.endCol,
  );
  return index >= 0 ? index : 0;
}
