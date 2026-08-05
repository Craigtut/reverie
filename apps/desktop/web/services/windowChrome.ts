import { invoke } from './runtime';

// Push the shell's theme down to the native window frame.
//
// The window frame belongs to AppKit, not to the webview, so three things have
// to be re-applied in Rust whenever the theme flips: the window's appearance
// (left on the system's, a light frame draws a bright hairline along the top of
// the dark UI), the window and webview background color (during a fast live
// resize AppKit outruns the webview's repaint and the exposed strip flashes
// white), and the traffic light inset (AppKit re-lays out the titlebar and snaps
// the buttons back to the corner). See src-tauri/src/window_chrome.rs.
//
// Failure is swallowed on purpose: this is cosmetic, it is a no-op outside the
// desktop runtime, and nothing in the shell should break if the command is
// missing (the browser harness has no such command).
export async function setWindowChromeTheme(theme: 'dark' | 'light') {
  try {
    await invoke<void>('set_window_chrome_theme', { dark: theme === 'dark' });
  } catch {
    // Cosmetic only; the harness and any non-macOS host simply skip it.
  }
}
