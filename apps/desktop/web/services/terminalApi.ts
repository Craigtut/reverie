import { invoke } from './runtime';
import type { GhosttyFrameSequencePayload, RenderMetrics, StartSessionRequest } from '../domain';

// Typed wrappers over the terminal/session-runtime commands: launching and
// terminating native sessions, writing input, resizing, serving history-range
// row bands, and the synthetic benchmark frame sequence. Scrolling itself is
// fully frontend-local (no backend round-trip); the only pull from the backend
// is `readTerminalRows`. The event side (terminal_frame, terminal_exit, ...) is
// subscribed via runtime.listen.

// `onFrame` is a Tauri `Channel<ArrayBuffer>` (typed `unknown` here so this
// module stays free of a static `@tauri-apps/api` import; the hook constructs
// it lazily). The backend `start_session` command receives it as a binary
// Channel and streams each encoded `TerminalFrame` over it as an ArrayBuffer.
// In the browser harness there is no Tauri Channel, so `onFrame` is omitted and
// frames arrive over the SSE bridge instead.
export function startSession(request: StartSessionRequest, onFrame?: unknown) {
  return invoke<string>('start_session', { request, onFrame });
}

export function terminateSession(terminalId: string) {
  return invoke('terminate_session', { terminalId });
}

// Finalize a deliberate quit: the backend gracefully stops every live session's
// process tree, persists them as resumable, then exits the app. Invoked after
// the user confirms (or when there is no in-flight work to confirm). The promise
// may not resolve, since the process exits.
export function confirmQuit() {
  return invoke('confirm_quit');
}

export function writeTerminalInput(terminalId: string, input: string) {
  return invoke('write_terminal_input', { terminalId, input });
}

// Read an image off the OS clipboard, persist it as a temp PNG, and return its
// absolute path (or null when the clipboard holds no usable image). The primary
// clipboard-image paste path: it catches screenshots/TIFF the WebView clipboard
// does not reliably expose. The caller inserts the path like a dropped file.
export function readClipboardImage() {
  return invoke<string | null>('read_clipboard_image');
}

// Persist PNG bytes extracted from a DOM paste event (the fallback when the
// native pasteboard read comes up empty) and return the temp file path.
export function savePastedImage(bytes: number[]) {
  return invoke<string>('save_pasted_image', { bytes });
}

export function resizeTerminal(terminalId: string, cols: number, rows: number) {
  return invoke('resize_terminal', { terminalId, cols, rows });
}

// Serve a contiguous band of history rows for scroll-back prefetch (decisions.md
// D6/D7). The backend reads the rows straight from libghostty's live buffer and
// returns the binary row band (the same wire format the harness bridge base64s);
// Tauri hands a `Vec<u8>` response back as an ArrayBuffer. The caller decodes it
// with `decodeRowBand` and merges it into the mirror only when the generation
// still matches. This is the one place the frontend pulls from the backend.
export function readTerminalRows(
  terminalId: string,
  startId: number,
  count: number,
  generation: number,
) {
  return invoke<ArrayBuffer>('read_terminal_rows', { terminalId, startId, count, generation });
}

export function setTerminalFrontendActive(terminalId: string, active: boolean) {
  return invoke('set_terminal_frontend_active', { terminalId, active });
}

// Push the active shell theme's default terminal colors (#rrggbb) into the
// backend, which seeds Ghostty's render-state defaults via OSC 10/11 (applied at
// spawn + history replay, broadcast to live terminals). This keeps the VT model
// honest; it is NOT the paint path (the Canvas renderer paints from the frontend
// theme). See GhosttyTerminalState::set_default_colors for why it's not yet
// load-bearing.
export function setTerminalTheme(foreground: string, background: string) {
  return invoke('set_terminal_theme', { foreground, background });
}

export function fetchGhosttyFrameSequence() {
  return invoke<GhosttyFrameSequencePayload>('ghostty_frame_sequence');
}

export function recordRenderMetrics(metrics: RenderMetrics) {
  return invoke('record_render_metrics', { metrics });
}

export function recordTerminalDiagnostics(events: unknown[]) {
  return invoke('record_terminal_diagnostics', { events });
}
