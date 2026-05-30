import type { ThemeMode } from './tokens';

// The terminal's default foreground/background per theme. libghostty-vt has no
// color config and reports a hardwired white-on-black default, so Reverie owns
// these: the Canvas renderer paints them as the default cell colors (B) and the
// backend feeds them into Ghostty as OSC 10/11 so the VT model + any CLI that
// queries its colors agree (D).
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
