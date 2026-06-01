import { invokeBrowserFixture } from './fixtures';
import type { TerminalFrame } from '../terminalTypes';
import type { EventHandler, UnlistenFn } from './types';

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:17777';
const HISTORY_BRIDGE_TIMEOUT_MS = 8_000;
const TERMINAL_BRIDGE_COMMANDS = new Set([
  'start_session',
  'terminate_session',
  'write_terminal_input',
  'resize_terminal',
  'scroll_terminal_viewport',
  'scroll_terminal_viewport_to_top',
  'scroll_terminal_viewport_to_bottom',
  'set_terminal_frontend_active',
  'set_terminal_theme',
  'terminal_history_info',
  'terminal_history_window',
]);
const TERMINAL_BRIDGE_EVENTS = new Set([
  'terminal_stream_started',
  'terminal_frame',
  'terminal_exit',
  'terminal_failed',
]);

let bridgeEventSource: EventSource | null = null;
const sessionTerminalIds = new Map<string, string>();

export interface TerminalBridgeStartOptions {
  terminalId: string;
  cols: number;
  rows: number;
  maxScrollback?: number;
  commandOverride?: string;
  cwd?: string;
}

export interface TerminalBridgeFramePayload {
  terminalId: string;
  seq: number;
  bytesRead: number;
  chunkBytes: number;
  rustElapsedMs: number;
  frame: TerminalFrame;
}

export interface TerminalBridgeStartedPayload {
  terminalId: string;
  targetFrames: number | null;
  cols: number;
  rows: number;
}

export interface TerminalBridgeExitPayload {
  terminalId: string;
  framesEmitted: number;
  chunksRead: number;
  bytesRead: number;
  rustElapsedMs: number;
  totalEmitMs: number;
  avgEmitMs: number;
  maxEmitMs: number;
  childSuccess: boolean;
}

export interface TerminalBridgeFailedPayload {
  terminalId?: string | null;
  message: string;
}

export interface TerminalBridgeHistoryInfo {
  totalRows: number;
}

export interface TerminalBridgeHistoryWindow {
  startRow: number;
  frame: TerminalFrame;
}

export function terminalBridgeEnabled() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return (
    import.meta.env.VITE_REVERIE_TERMINAL_BRIDGE === '1' ||
    params.get('terminalBridge') === '1' ||
    window.localStorage.getItem('reverie.terminalBridge.enabled') === '1'
  );
}

export function terminalBridgeHandlesCommand(command: string) {
  return TERMINAL_BRIDGE_COMMANDS.has(command);
}

export function terminalBridgeHandlesEvent(eventName: string) {
  return TERMINAL_BRIDGE_EVENTS.has(eventName);
}

export async function invokeTerminalBridge<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  switch (command) {
    case 'start_session': {
      await invokeBrowserFixture(command, args);
      const terminalId = await bridgePost<string>('/start', {
        ...(args ?? {}),
        commandOverride: bridgeCommandOverride(),
        cwd: bridgeWorkingDirectory(),
      });
      const request = args?.request as Record<string, unknown> | undefined;
      const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : null;
      if (sessionId) sessionTerminalIds.set(sessionId, terminalId);
      return terminalId as T;
    }
    case 'terminate_session': {
      const terminalId = args?.terminalId;
      if (typeof terminalId === 'string') {
        for (const [sessionId, mappedTerminalId] of sessionTerminalIds) {
          if (mappedTerminalId === terminalId) sessionTerminalIds.delete(sessionId);
        }
      }
      return bridgePost<T>('/terminate', { terminalId });
    }
    case 'write_terminal_input':
      return bridgePost<T>('/input', { terminalId: args?.terminalId, input: args?.input ?? '' });
    case 'resize_terminal':
      return bridgePost<T>('/resize', {
        terminalId: args?.terminalId,
        cols: args?.cols,
        rows: args?.rows,
      });
    case 'scroll_terminal_viewport':
      return bridgePost<T>('/scroll', {
        terminalId: args?.terminalId,
        deltaRows: args?.deltaRows,
      });
    case 'scroll_terminal_viewport_to_top':
      return bridgePost<T>('/scroll_top', { terminalId: args?.terminalId });
    case 'scroll_terminal_viewport_to_bottom':
      return bridgePost<T>('/scroll_bottom', { terminalId: args?.terminalId });
    case 'set_terminal_frontend_active':
      return bridgePost<T>('/active', {
        terminalId: args?.terminalId,
        active: args?.active,
      });
    case 'set_terminal_theme':
      return bridgePost<T>('/theme', args ?? {});
    case 'terminal_history_info':
      return bridgePost<T>('/history_info', {
        terminalId: terminalIdForHistoryArgs(args),
        cols: args?.cols,
        rows: args?.rows,
      });
    case 'terminal_history_window':
      return bridgePost<T>('/history_window', {
        terminalId: terminalIdForHistoryArgs(args),
        startRow: args?.startRow,
        cols: args?.cols,
        surfaceRows: args?.surfaceRows,
        rowCount: args?.rowCount,
      });
    default:
      throw new Error(`Terminal bridge does not implement command: ${command}`);
  }
}

function terminalIdForHistoryArgs(args?: Record<string, unknown>) {
  const terminalId = args?.terminalId;
  if (typeof terminalId === 'string' && terminalId.length > 0) return terminalId;
  const sessionId = args?.sessionId;
  if (typeof sessionId === 'string') return sessionTerminalIds.get(sessionId) ?? sessionId;
  return sessionId;
}

export function listenTerminalBridge<T>(eventName: string, handler: EventHandler<T>): UnlistenFn {
  const source = terminalBridgeSource();
  const listener = (event: Event) => {
    handler({ payload: JSON.parse((event as MessageEvent<string>).data) as T });
  };
  source.addEventListener(eventName, listener);
  return () => source.removeEventListener(eventName, listener);
}

export async function startTerminalBridgeSession(options: TerminalBridgeStartOptions) {
  return bridgePost<string>('/start', {
    request: {
      terminalId: options.terminalId,
      cols: options.cols,
      rows: options.rows,
      maxScrollback: options.maxScrollback,
    },
    commandOverride: options.commandOverride ?? bridgeCommandOverride(),
    cwd: options.cwd ?? bridgeWorkingDirectory(),
  });
}

export function resizeTerminalBridgeSession(terminalId: string, cols: number, rows: number) {
  return bridgePost<null>('/resize', { terminalId, cols, rows });
}

export function writeTerminalBridgeInput(terminalId: string, input: string) {
  return bridgePost<null>('/input', { terminalId, input });
}

export function scrollTerminalBridgeViewport(terminalId: string, deltaRows: number) {
  return bridgePost<null>('/scroll', { terminalId, deltaRows });
}

export function scrollTerminalBridgeViewportToBottom(terminalId: string) {
  return bridgePost<null>('/scroll_bottom', { terminalId });
}

export function scrollTerminalBridgeViewportToTop(terminalId: string) {
  return bridgePost<null>('/scroll_top', { terminalId });
}

export function terminateTerminalBridgeSession(terminalId: string) {
  return bridgePost<null>('/terminate', { terminalId });
}

export function terminalBridgeHistoryInfo(terminalId: string, cols: number, rows: number) {
  return bridgePost<TerminalBridgeHistoryInfo>(
    '/history_info',
    { terminalId, cols, rows },
    { timeoutMs: HISTORY_BRIDGE_TIMEOUT_MS },
  );
}

export function terminalBridgeHistoryWindow(
  terminalId: string,
  startRow: number,
  cols: number,
  surfaceRows: number,
  rowCount: number,
) {
  return bridgePost<TerminalBridgeHistoryWindow>(
    '/history_window',
    {
      terminalId,
      startRow,
      cols,
      surfaceRows,
      rowCount,
    },
    { timeoutMs: HISTORY_BRIDGE_TIMEOUT_MS },
  );
}

export async function terminalBridgeHealth() {
  const response = await fetch(`${terminalBridgeBaseUrl()}/health`);
  if (!response.ok) throw new Error((await response.text()) || 'Terminal bridge is unavailable');
  return response.json() as Promise<{ ok: boolean }>;
}

function terminalBridgeSource() {
  if (!bridgeEventSource) {
    bridgeEventSource = new EventSource(`${terminalBridgeBaseUrl()}/events`);
  }
  return bridgeEventSource;
}

async function bridgePost<T>(
  path: string,
  body: unknown,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const abort = new AbortController();
  const timeout =
    options.timeoutMs === undefined ? 0 : window.setTimeout(() => abort.abort(), options.timeoutMs);
  try {
    const response = await fetch(`${terminalBridgeBaseUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: abort.signal,
    });
    if (!response.ok) {
      throw new Error((await response.text()) || `Terminal bridge request failed: ${path}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (abort.signal.aborted) {
      throw new Error(`Terminal bridge request timed out: ${path}`);
    }
    throw error;
  } finally {
    if (timeout !== 0) window.clearTimeout(timeout);
  }
}

export function terminalBridgeBaseUrl() {
  if (typeof window === 'undefined') return DEFAULT_BRIDGE_URL;
  const params = new URLSearchParams(window.location.search);
  return (
    params.get('bridgeUrl') ??
    window.localStorage.getItem('reverie.terminalBridge.url') ??
    import.meta.env.VITE_REVERIE_TERMINAL_BRIDGE_URL ??
    DEFAULT_BRIDGE_URL
  );
}

function bridgeCommandOverride() {
  if (typeof window === 'undefined') return undefined;
  const params = new URLSearchParams(window.location.search);
  return (
    params.get('bridgeCommand') ??
    window.localStorage.getItem('reverie.terminalBridge.command') ??
    undefined
  );
}

function bridgeWorkingDirectory() {
  if (typeof window === 'undefined') return undefined;
  const params = new URLSearchParams(window.location.search);
  return (
    params.get('bridgeCwd') ??
    window.localStorage.getItem('reverie.terminalBridge.cwd') ??
    undefined
  );
}
