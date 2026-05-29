import type { ActionContext, AskAgentOptions } from './types';

// The dependencies the React layer (the terminal hook) injects to build an
// ActionContext. These close over the hook's internals (terminal input, the
// selection controller, services). Keeping them as plain callbacks means the
// registry/actions stay app-agnostic and a test can fake the whole context.
export interface ActionContextDeps {
  // Apply text as terminal input (bracketed-paste aware), e.g. for paste.
  pasteText(text: string): Promise<void>;
  // Send text to the active terminal's input without executing semantics beyond
  // what the bytes carry (used by "Send to input").
  sendInput(text: string): Promise<void>;
  selectAll(): void;
  clearSelection(): void;
  openExternal(href: string): Promise<void>;
  askAgent(prompt: string, opts?: AskAgentOptions): Promise<void>;
  // Whether a live terminal is attached + armed (gates paste / send-to-input).
  canSendInput(): boolean;
}

// Default web search target. The user asked for "search the web"; Google matches
// the phrasing they used and is a sensible default.
function searchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

export function buildActionContext(deps: ActionContextDeps): ActionContext {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  const clipboardWriteAvailable = Boolean(clipboard?.writeText);
  const clipboardReadAvailable = Boolean(clipboard?.readText);

  return {
    async copyText(text) {
      if (clipboardWriteAvailable && text) await clipboard?.writeText(text);
    },
    async pasteFromClipboard() {
      if (!clipboardReadAvailable) return;
      const text = (await clipboard?.readText()) ?? '';
      if (text) await deps.pasteText(text);
    },
    selectAll: deps.selectAll,
    clearSelection: deps.clearSelection,
    async searchWeb(query) {
      await deps.openExternal(searchUrl(query));
    },
    openUrl: href => deps.openExternal(href),
    sendToInput: text => deps.sendInput(text),
    askAgent: (prompt, opts) => deps.askAgent(prompt, opts),
    clipboardWriteAvailable,
    clipboardReadAvailable,
    canSendInput: deps.canSendInput(),
  };
}
