import { invokeBrowserFixture } from './fixtures';
import { decodeTerminalFrameBase64 } from '../terminal/wireDecode';
import type { TerminalFrame } from '../terminalTypes';
import type { EventHandler, UnlistenFn } from './types';

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:17777';
const TERMINAL_BRIDGE_COMMANDS = new Set([
  'start_session',
  'terminate_session',
  'write_terminal_input',
  'paste_terminal_text',
  'resize_terminal',
  'read_terminal_rows',
  'set_terminal_frontend_active',
  'set_terminal_theme',
]);
const TERMINAL_BRIDGE_EVENTS = new Set([
  'terminal_stream_started',
  'terminal_frame',
  'terminal_exit',
  'terminal_failed',
]);

let bridgeEventSource: EventSource | null = null;
const sessionTerminalIds = new Map<string, string>();
// The bridge serves exactly one session at a time (each /start terminates the
// previous), so the most recent `terminal_stream_started` identifies which
// terminal the (terminalId-less) binary frame stream belongs to. We also count
// frames per stream to give the dev debug surface a `seq`, resetting on start.
let currentBridgeTerminalId: string | null = null;
let currentBridgeFrameSeq = 0;

export interface TerminalBridgeStartOptions {
  terminalId: string;
  cols: number;
  rows: number;
  commandOverride?: string;
  cwd?: string;
}

export interface TerminalBridgeFramePayload {
  terminalId: string;
  seq: number;
  // Per-session generation marker decoded from the binary frame (bumped on
  // resize, adopted by a Full frame). Mirrors the Tauri Channel path.
  generation: number;
  dirty: 'clean' | 'partial' | 'full';
  frame: TerminalFrame;
  // Retained for the dev bridge-debug surface. The binary frame stream no
  // longer carries per-frame byte/timing metadata (that was JSON-payload only),
  // so these are 0 over the bridge now; lifecycle metrics still come via JSON.
  bytesRead: number;
  chunkBytes: number;
  rustElapsedMs: number;
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
      // The binary frame stream carries no terminalId; bind it now, before any
      // frame SSE can arrive, so the per-session frame guard is never inert.
      currentBridgeTerminalId = terminalId;
      currentBridgeFrameSeq = 0;
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
    case 'paste_terminal_text':
      return bridgePost<T>('/input', { terminalId: args?.terminalId, input: args?.text ?? '' });
    case 'resize_terminal':
      return bridgePost<T>('/resize', {
        terminalId: args?.terminalId,
        cols: args?.cols,
        rows: args?.rows,
      });
    case 'read_terminal_rows': {
      // The bridge returns the row band as base64 of the SAME wire bytes the
      // Tauri command returns; decode it to an ArrayBuffer so callers get the
      // uniform binary shape and decode it with the same `decodeRowBand`.
      const base64 = await bridgePost<string>('/read_rows', {
        terminalId: args?.terminalId,
        startId: args?.startId,
        count: args?.count,
        generation: args?.generation,
      });
      return base64ToArrayBuffer(base64) as T;
    }
    case 'set_terminal_frontend_active':
      return bridgePost<T>('/active', {
        terminalId: args?.terminalId,
        active: args?.active,
      });
    case 'set_terminal_theme':
      return bridgePost<T>('/theme', args ?? {});
    default:
      throw new Error(`Terminal bridge does not implement command: ${command}`);
  }
}

export function listenTerminalBridge<T>(eventName: string, handler: EventHandler<T>): UnlistenFn {
  const source = terminalBridgeSource();

  // The frame stream is binary: the bridge base64s the SAME wire bytes the
  // Tauri Channel sends, and we decode them with the SAME `decodeTerminalFrame`.
  // We attach the terminalId from the current stream (the frame bytes carry
  // none) and a local seq, so the payload matches `TerminalBridgeFramePayload`.
  if (eventName === 'terminal_frame') {
    const listener = (event: Event) => {
      const decoded = decodeTerminalFrameBase64((event as MessageEvent<string>).data);
      const payload: TerminalBridgeFramePayload = {
        terminalId: currentBridgeTerminalId ?? '',
        seq: currentBridgeFrameSeq,
        generation: decoded.generation,
        dirty: decoded.dirty,
        frame: decoded.frame,
        bytesRead: 0,
        chunkBytes: 0,
        rustElapsedMs: 0,
      };
      currentBridgeFrameSeq += 1;
      handler({ payload: payload as T });
    };
    source.addEventListener(eventName, listener);
    return () => source.removeEventListener(eventName, listener);
  }

  const listener = (event: Event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as T;
    // Track which terminal the binary frame stream belongs to, and reset the
    // per-stream frame counter, whenever a new stream starts.
    if (eventName === 'terminal_stream_started') {
      const started = payload as { terminalId?: string };
      currentBridgeTerminalId = started.terminalId ?? null;
      currentBridgeFrameSeq = 0;
    }
    handler({ payload });
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

export function terminateTerminalBridgeSession(terminalId: string) {
  return bridgePost<null>('/terminate', { terminalId });
}

// Decode the bridge's base64 row-band response into an ArrayBuffer, so the
// caller decodes it with the same `decodeRowBand` the Tauri path uses.
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
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
