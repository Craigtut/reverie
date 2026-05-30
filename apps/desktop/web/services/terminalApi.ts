import { invoke } from './runtime';
import type { GhosttyFrameSequencePayload, RenderMetrics, StartSessionRequest } from '../domain';
import type { TerminalFrame } from '../terminalTypes';

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

// Push the active shell theme's default terminal colors (#rrggbb) into the
// backend. Applied to future spawns + history replay and broadcast to every
// live terminal, so Ghostty's reported default fg/bg (and any CLI that queries
// OSC 10/11 to pick a light/dark theme) match the shell.
export function setTerminalTheme(foreground: string, background: string) {
  return invoke('set_terminal_theme', { foreground, background });
}

// Deep history (the full persisted transcript), keyed by SESSION id so it works
// for live, exited, and restored sessions.
export interface TerminalHistoryInfo {
  totalRows: number;
}

export interface TerminalHistoryWindow {
  startRow: number;
  frame: TerminalFrame;
}

export function terminalHistoryInfo(sessionId: string, cols: number, rows: number) {
  return invoke<TerminalHistoryInfo>('terminal_history_info', { sessionId, cols, rows });
}

export function terminalHistoryWindow(
  sessionId: string,
  startRow: number,
  cols: number,
  rows: number,
) {
  return invoke<TerminalHistoryWindow>('terminal_history_window', {
    sessionId,
    startRow,
    cols,
    rows,
  });
}

export function fetchGhosttyFrameSequence() {
  return invoke<GhosttyFrameSequencePayload>('ghostty_frame_sequence');
}

export function recordRenderMetrics(metrics: RenderMetrics) {
  return invoke('record_render_metrics', { metrics });
}
