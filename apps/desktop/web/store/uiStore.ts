import { create } from 'zustand';

import type { ThemeMode } from '../themes/tokens';
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
  logs: string[];
  setTheme: (action: SetStateAction<ThemeMode>) => void;
  setAppFocused: (action: SetStateAction<boolean>) => void;
  setBusy: (action: SetStateAction<boolean>) => void;
  appendLog: (line: string) => void;
}

export const useUiStore = create<UiState>(set => ({
  theme: 'dark',
  appFocused: typeof document !== 'undefined' ? document.hasFocus() : true,
  busy: false,
  logs: [],
  setTheme: action => set(s => ({ theme: resolveSetStateAction(action, s.theme) })),
  setAppFocused: action => set(s => ({ appFocused: resolveSetStateAction(action, s.appFocused) })),
  setBusy: action => set(s => ({ busy: resolveSetStateAction(action, s.busy) })),
  appendLog: line =>
    set(s => ({
      logs: [`[${new Date().toLocaleTimeString()}] ${line}`, ...s.logs].slice(0, MAX_LOG_LINES),
    })),
}));
