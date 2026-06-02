import { describe, it, expect } from 'vitest';
import { buildMenuItems } from './actionRegistry';
import { resolveTopTarget } from './targetRegistry';
import { registerDefaultInteractions } from './defaultActions';
import type {
  ActionContext,
  GridTarget,
  InteractionProbe,
  LinkTarget,
  SelectionTarget,
} from './types';
import type { TerminalFrame } from '../../terminalTypes';
import type { TerminalSurface } from '../../terminalScrollback';

registerDefaultInteractions();

const surface: TerminalSurface = {
  cols: 20,
  rows: 10,
  cellWidth: 9,
  cellHeight: 18,
  fontSize: 14,
  baseline: 14,
  fontFamily: 'monospace',
};
const frame: TerminalFrame = { dirty: 'full', rows: [] };

function fakeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    copyText: async () => {},
    pasteFromClipboard: async () => {},
    selectAll: () => {},
    clearSelection: () => {},
    searchWeb: async () => {},
    openUrl: async () => {},
    sendToInput: async () => {},
    askAgent: async () => {},
    clipboardWriteAvailable: true,
    clipboardReadAvailable: true,
    canSendInput: true,
    ...overrides,
  };
}

function probe(overrides: Partial<InteractionProbe>): InteractionProbe {
  return {
    cell: null,
    frame,
    surface,
    selection: null,
    selectionText: '',
    modifiers: { shift: false, meta: false, ctrl: false, alt: false },
    ...overrides,
  };
}

describe('resolveTopTarget', () => {
  it('prefers a non-empty selection over the grid fallback', () => {
    const target = resolveTopTarget(probe({ selectionText: 'hello', cell: { row: 0, col: 0 } }));
    expect(target?.kind).toBe('selection');
  });

  it('falls back to grid when a cell is present and there is no selection', () => {
    const target = resolveTopTarget(probe({ cell: { row: 3, col: 4 } }));
    expect(target).toEqual({ kind: 'grid', cell: { row: 3, col: 4 } });
  });

  it('falls back to empty when there is no cell', () => {
    expect(resolveTopTarget(probe({}))).toEqual({ kind: 'empty', cell: null });
  });

  it('does not treat a wide-cell spacer column before a link as part of the link', () => {
    const linkFrame: TerminalFrame = {
      dirty: 'full',
      rows: [
        {
          index: 0,
          dirty: true,
          cells: [
            { col: 0, width: 2, text: '界' },
            ...'https://x.com'.split('').map((text, index) => ({ col: index + 2, text })),
          ],
        },
      ],
    };

    expect(resolveTopTarget(probe({ frame: linkFrame, cell: { row: 0, col: 1 } }))).toEqual({
      kind: 'grid',
      cell: { row: 0, col: 1 },
    });
    expect(resolveTopTarget(probe({ frame: linkFrame, cell: { row: 0, col: 2 } }))).toEqual(
      expect.objectContaining({ kind: 'link', href: 'https://x.com' }),
    );
  });
});

describe('buildMenuItems for a selection', () => {
  const selection: SelectionTarget = { kind: 'selection', text: 'hello world', isUrl: false };

  it('offers clipboard / search / agent / select actions but not open-url', () => {
    const ids = buildMenuItems(selection, fakeCtx()).map(i => i.id);
    expect(ids).toEqual([
      'copy',
      'copy-markdown',
      'paste',
      'search-web',
      'send-to-input',
      'ask-agent',
      'select-all',
    ]);
  });

  it('offers open-url only when the selection is a URL', () => {
    const url: SelectionTarget = {
      kind: 'selection',
      text: 'https://x.com',
      isUrl: true,
      url: 'https://x.com',
    };
    expect(buildMenuItems(url, fakeCtx()).map(i => i.id)).toContain('open-url');
  });

  it('disables paste when input is not available', () => {
    const items = buildMenuItems(selection, fakeCtx({ canSendInput: false }));
    expect(items.find(i => i.id === 'paste')?.enabled).toBe(false);
    expect(items.find(i => i.id === 'copy')?.enabled).toBe(true);
  });
});

describe('buildMenuItems for the grid fallback', () => {
  const grid: GridTarget = { kind: 'grid', cell: { row: 0, col: 0 } };

  it('offers paste and select-all', () => {
    expect(buildMenuItems(grid, fakeCtx()).map(i => i.id)).toEqual(['paste', 'select-all']);
  });
});

describe('buildMenuItems for a link', () => {
  it('offers open / copy-address / search; hides copy-link-text when text equals href', () => {
    const link: LinkTarget = {
      kind: 'link',
      href: 'https://x.com',
      text: 'https://x.com',
      cell: { row: 0, col: 0 },
    };
    const ids = buildMenuItems(link, fakeCtx()).map(i => i.id);
    expect(ids).toEqual(['copy-link-address', 'open-link', 'search-web-link', 'ask-agent-link']);
  });

  it('shows copy-link-text when the visible text differs from the href', () => {
    const link: LinkTarget = {
      kind: 'link',
      href: 'https://x.com',
      text: 'docs',
      cell: { row: 0, col: 0 },
    };
    expect(buildMenuItems(link, fakeCtx()).map(i => i.id)).toContain('copy-link-text');
  });
});
