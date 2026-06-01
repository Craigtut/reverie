import { registerAction } from './actionRegistry';
import { registerResolver } from './targetRegistry';
import { asUrl, detectLinks } from './linkProvider';
import { terminalRowTextLayout, terminalTextRangeToCellSpan } from '../cellGeometry';
import type { GridTarget, LinkTarget, SelectionTarget } from './types';

// Registers the built-in resolvers + actions. Idempotent: safe to call from the
// hook on every mount. New interactions (links in Phase 3, agent actions in
// Phase 4) extend this one file; nothing else changes.
let registered = false;

export function registerDefaultInteractions(): void {
  if (registered) return;
  registered = true;

  // --- Resolvers ---

  // A non-empty selection wins regardless of where the right-click landed, so
  // "right-click to copy what I selected" works the way people expect.
  registerResolver({
    id: 'selection',
    priority: 20,
    resolve(probe) {
      const text = probe.selectionText;
      if (text.trim().length === 0) return [];
      const url = asUrl(text);
      const target: SelectionTarget = {
        kind: 'selection',
        text,
        isUrl: url !== null,
        url: url ?? undefined,
      };
      return [target];
    },
  });

  // A URL under the pointer wins over a selection, so right-clicking a link acts
  // on the link. Detection is self-contained: scan the pointed row's text.
  registerResolver({
    id: 'link',
    priority: 30,
    resolve(probe) {
      if (!probe.cell) return [];
      const row = probe.frame.rows.find(r => r.index === probe.cell?.row);
      if (!row) return [];
      const layout = terminalRowTextLayout(row, probe.surface.cols);
      const hit = detectLinks(layout.text).find(link => {
        const span = terminalTextRangeToCellSpan(layout, link.start, link.end);
        return (
          probe.cell !== null && probe.cell.col >= span.startCol && probe.cell.col < span.endCol
        );
      });
      if (!hit) return [];
      const target: LinkTarget = {
        kind: 'link',
        href: hit.href,
        text: layout.text.slice(hit.start, hit.end),
        cell: probe.cell,
      };
      return [target];
    },
  });

  // The fallback: a cell (grid) or blank space (empty). Same action set.
  registerResolver({
    id: 'grid',
    priority: 0,
    resolve(probe) {
      if (probe.cell) {
        const target: GridTarget = { kind: 'grid', cell: probe.cell };
        return [target];
      }
      return [{ kind: 'empty', cell: null }];
    },
  });

  // --- Actions ---

  registerAction<SelectionTarget>({
    id: 'copy',
    group: 'clipboard',
    order: 1,
    kinds: ['selection'],
    label: 'Copy',
    isEnabled: (_t, ctx) => ctx.clipboardWriteAvailable,
    invoke: (target, ctx) => ctx.copyText(target.text),
  });

  registerAction<SelectionTarget>({
    id: 'copy-markdown',
    group: 'clipboard',
    order: 2,
    kinds: ['selection'],
    label: 'Copy as code block',
    isEnabled: (_t, ctx) => ctx.clipboardWriteAvailable,
    invoke: (target, ctx) => ctx.copyText(`\`\`\`\n${target.text}\n\`\`\``),
  });

  registerAction({
    id: 'paste',
    group: 'clipboard',
    order: 3,
    kinds: ['selection', 'grid', 'empty'],
    label: 'Paste',
    isEnabled: (_t, ctx) => ctx.canSendInput && ctx.clipboardReadAvailable,
    invoke: (_target, ctx) => ctx.pasteFromClipboard(),
  });

  registerAction<SelectionTarget>({
    id: 'open-url',
    group: 'open',
    order: 1,
    kinds: ['selection'],
    label: 'Open link',
    isAvailable: target => target.isUrl,
    invoke: (target, ctx) => (target.url ? ctx.openUrl(target.url) : Promise.resolve()),
  });

  registerAction<SelectionTarget>({
    id: 'search-web',
    group: 'search',
    order: 1,
    kinds: ['selection'],
    label: 'Search the web',
    invoke: (target, ctx) => ctx.searchWeb(target.text),
  });

  registerAction<SelectionTarget>({
    id: 'send-to-input',
    group: 'agent',
    order: 1,
    kinds: ['selection'],
    label: 'Send to input',
    isEnabled: (_t, ctx) => ctx.canSendInput,
    invoke: (target, ctx) => ctx.sendToInput(target.text),
  });

  registerAction<SelectionTarget>({
    id: 'ask-agent',
    group: 'agent',
    order: 2,
    kinds: ['selection'],
    label: 'Ask an agent about this',
    invoke: (target, ctx) => ctx.askAgent(target.text),
  });

  registerAction({
    id: 'select-all',
    group: 'select',
    order: 1,
    kinds: ['selection', 'grid', 'empty'],
    label: 'Select all',
    invoke: (_target, ctx) => ctx.selectAll(),
  });

  // --- Link actions ---

  registerAction<LinkTarget>({
    id: 'open-link',
    group: 'open',
    order: 1,
    kinds: ['link'],
    label: 'Open link',
    invoke: (target, ctx) => ctx.openUrl(target.href),
  });

  registerAction<LinkTarget>({
    id: 'copy-link-address',
    group: 'clipboard',
    order: 1,
    kinds: ['link'],
    label: 'Copy link address',
    isEnabled: (_t, ctx) => ctx.clipboardWriteAvailable,
    invoke: (target, ctx) => ctx.copyText(target.href),
  });

  registerAction<LinkTarget>({
    id: 'copy-link-text',
    group: 'clipboard',
    order: 2,
    kinds: ['link'],
    label: 'Copy link text',
    // Only meaningful when the visible text differs from the href (OSC 8); for a
    // bare URL the text equals the address, so this is hidden.
    isAvailable: target => target.text.trim() !== target.href,
    isEnabled: (_t, ctx) => ctx.clipboardWriteAvailable,
    invoke: (target, ctx) => ctx.copyText(target.text.trim()),
  });

  registerAction<LinkTarget>({
    id: 'search-web-link',
    group: 'search',
    order: 1,
    kinds: ['link'],
    label: 'Search the web',
    invoke: (target, ctx) => ctx.searchWeb(target.href),
  });

  registerAction<LinkTarget>({
    id: 'ask-agent-link',
    group: 'agent',
    order: 2,
    kinds: ['link'],
    label: 'Ask an agent about this link',
    invoke: (target, ctx) => ctx.askAgent(target.href),
  });
}
