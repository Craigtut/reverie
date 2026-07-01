import type { ThemeMode } from './tokens';

// The terminal's default foreground/background per theme. Reverie owns these:
// the Canvas renderer paints them as the default cell colors, and the backend
// mirrors them into libghostty's embedder defaults so the VT model and any CLI
// that queries its colors agree.
//
// Values track the shell's `--bg` / `--text` tokens in themes/appShell.ts so the
// terminal reads as a solid panel of the same surface, not a black box. Keep
// these in sync with that file.
export interface TerminalThemeColors {
  background: string;
  foreground: string;
}

export const TERMINAL_THEME: Record<ThemeMode, TerminalThemeColors> = {
  dark: { background: '#0B0A09', foreground: '#EFE9DF' },
  light: { background: '#F4F1EB', foreground: '#1B1814' },
};
