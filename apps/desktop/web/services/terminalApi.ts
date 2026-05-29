import { invoke } from './runtime';
import type { GhosttyFrameSequencePayload, RenderMetrics, StartSessionRequest } from '../domain';

// Typed wrappers over the terminal/session-runtime commands: launching and
// terminating native sessions, writing input, resizing, scrolling the
// viewport, and the synthetic benchmark frame sequence. The event side
// (terminal_frame, terminal_exit, ...) is subscribed via runtime.listen.

export function startSession(request: StartSessionRequest) {
  return invoke<string>('start_session', { request });
}

export function terminateSession(terminalId: string) {
  return invoke('terminate_session', { terminalId });
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

export function fetchGhosttyFrameSequence() {
  return invoke<GhosttyFrameSequencePayload>('ghostty_frame_sequence');
}

export function recordRenderMetrics(metrics: RenderMetrics) {
  return invoke('record_render_metrics', { metrics });
}
