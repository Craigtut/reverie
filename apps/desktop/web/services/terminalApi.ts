import { invoke } from './runtime';
import type { GhosttyFrameSequencePayload, RenderMetrics, StartSessionRequest } from '../domain';

// Typed wrappers over the terminal/session-runtime commands: launching and
// terminating native sessions, writing input, resizing, scrolling the
// viewport, and the synthetic benchmark frame sequence. The event side
// (terminal_frame, terminal_exit, ...) is subscribed via runtime.listen.

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

export function resizeTerminal(terminalId: string, cols: number, rows: number) {
  return invoke('resize_terminal', { terminalId, cols, rows });
}

export function scrollTerminalViewport(terminalId: string, deltaRows: number) {
  return invoke('scroll_terminal_viewport', { terminalId, deltaRows });
}

export function scrollTerminalViewportToTop(terminalId: string) {
  return invoke('scroll_terminal_viewport_to_top', { terminalId });
}

export function scrollTerminalViewportToBottom(terminalId: string) {
  return invoke('scroll_terminal_viewport_to_bottom', { terminalId });
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
