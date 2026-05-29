import { create } from 'zustand';

import type { ThemeMode } from '../themes/tokens';
import { resolveSetStateAction, type SetStateAction } from './setter';

// Shell-chrome UI state: the active theme and whether Reverie is the focused
// app (used to pause shell motion when backgrounded). Theme defaults to dark;
// appFocused seeds from the current document focus.

interface UiState {
  theme: ThemeMode;
  appFocused: boolean;
  setTheme: (action: SetStateAction<ThemeMode>) => void;
  setAppFocused: (action: SetStateAction<boolean>) => void;
}

export const useUiStore = create<UiState>((set) => ({
  theme: 'dark',
  appFocused: typeof document !== 'undefined' ? document.hasFocus() : true,
  setTheme: (action) => set((s) => ({ theme: resolveSetStateAction(action, s.theme) })),
  setAppFocused: (action) => set((s) => ({ appFocused: resolveSetStateAction(action, s.appFocused) })),
}));
