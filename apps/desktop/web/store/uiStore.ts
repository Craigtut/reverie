import { create } from 'zustand';

import type { ThemeMode } from '../themes/tokens';
import { preserveStoreAcrossHmr } from './hmr';
import { resolveSetStateAction, type SetStateAction } from './setter';

// Shell-chrome UI state: the active theme, whether Reverie is the focused app
// (used to pause shell motion when backgrounded), a global busy flag that gates
// service-backed actions, and a bounded diagnostic log buffer. Theme defaults
// to dark; appFocused seeds from the current document focus. Busy + the log
// live here so any hook can read/append them without prop-threading.

const MAX_LOG_LINES = 80;

interface UiState {
  theme: ThemeMode;
  appFocused: boolean;
  busy: boolean;
  // True only after the initial workspace load has exhausted its retries. The
  // shell renders a visible error/retry surface instead of the empty fallback
  // snapshot (which looks exactly like total data loss). Cleared the moment any
  // load succeeds.
  workspaceLoadFailed: boolean;
  logs: string[];
  setTheme: (action: SetStateAction<ThemeMode>) => void;
  setAppFocused: (action: SetStateAction<boolean>) => void;
  setBusy: (action: SetStateAction<boolean>) => void;
  setWorkspaceLoadFailed: (action: SetStateAction<boolean>) => void;
  appendLog: (line: string) => void;
}

export const useUiStore = create<UiState>(set => ({
  theme: 'dark',
  appFocused: typeof document !== 'undefined' ? document.hasFocus() : true,
  busy: false,
  workspaceLoadFailed: false,
  logs: [],
  setTheme: action => set(s => ({ theme: resolveSetStateAction(action, s.theme) })),
  setAppFocused: action => set(s => ({ appFocused: resolveSetStateAction(action, s.appFocused) })),
  setBusy: action => set(s => ({ busy: resolveSetStateAction(action, s.busy) })),
  setWorkspaceLoadFailed: action =>
    set(s => ({ workspaceLoadFailed: resolveSetStateAction(action, s.workspaceLoadFailed) })),
  appendLog: line =>
    set(s => ({
      logs: [`[${new Date().toLocaleTimeString()}] ${line}`, ...s.logs].slice(0, MAX_LOG_LINES),
    })),
}));

// Preserve theme and the diagnostic log across HMR so an edit does not flash the
// shell back to the dark default (theme re-seeds from the shell only when it
// changes) or wipe the log buffer. See store/hmr.ts.
preserveStoreAcrossHmr(useUiStore, import.meta.hot, s => ({
  theme: s.theme,
  logs: s.logs,
}));
