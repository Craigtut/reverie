import { invokeBrowserFixture, subscribeFixtureEvent } from './fixtures';
import {
  invokeTerminalBridge,
  listenTerminalBridge,
  terminalBridgeEnabled,
  terminalBridgeHandlesCommand,
  terminalBridgeHandlesEvent,
} from './terminalBridge';
import type { EventHandler, RuntimeMode, UnlistenFn } from './types';

export type { UnlistenFn } from './types';

// Runtime shim: one surface for command invocation and event subscription that
// transparently routes to the real Tauri APIs when running inside the desktop
// app, or to the in-memory browser fixture (services/fixtures.ts) when running
// in a plain browser (npm run dev:harness). The Tauri API modules are imported
// lazily so the browser build never pays for them.

const realTauriRuntime =
  typeof window !== 'undefined' &&
  Boolean(window.__TAURI_INTERNALS__ || (window.__TAURI__ && !window.__REVERIE_BROWSER_FIXTURE__));

if (typeof window !== 'undefined' && !realTauriRuntime) {
  window.__REVERIE_BROWSER_FIXTURE__ = true;
}

export function appRuntimeMode(): RuntimeMode {
  if (!realTauriRuntime && terminalBridgeEnabled()) return 'terminal-bridge';
  return realTauriRuntime ? 'tauri' : 'browser-fixture';
}

export async function invoke<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (realTauriRuntime) {
    const tauriCore = await import('@tauri-apps/api/core');
    return tauriCore.invoke<T>(command, args);
  }

  if (terminalBridgeEnabled() && terminalBridgeHandlesCommand(command)) {
    return invokeTerminalBridge<T>(command, args);
  }

  return invokeBrowserFixture<T>(command, args);
}

export async function listen<T>(eventName: string, handler: EventHandler<T>): Promise<UnlistenFn> {
  if (realTauriRuntime) {
    const tauriEvent = await import('@tauri-apps/api/event');
    return tauriEvent.listen<T>(eventName, handler);
  }

  if (terminalBridgeEnabled() && terminalBridgeHandlesEvent(eventName)) {
    return listenTerminalBridge<T>(eventName, handler);
  }

  return subscribeFixtureEvent<T>(eventName, handler);
}

// A native OS file drag-drop, normalized for the shell. `paths` are absolute
// filesystem paths (only on enter/drop); `position` is in CSS px relative to
// the webview viewport (clientX/clientY space), or null on leave.
export interface FileDropEvent {
  type: 'enter' | 'over' | 'drop' | 'leave';
  paths: string[];
  position: { x: number; y: number } | null;
}

// Subscribe to native file drag-drop over the window. In the desktop app this
// wraps Tauri's webview drag-drop (which, with dragDropEnabled on, hands us
// absolute paths + a physical position that the HTML5 DnD API never would). In
// the browser harness there is no native bridge, so this is a no-op; the harness
// driver in useTerminalFileDrop synthesizes events from HTML5 drag events.
// Sticky per session: Tauri's drag-drop position is typed PhysicalPosition, but
// in practice it can already be in CSS px. We auto-detect rather than assume:
// only once we observe a coordinate beyond the CSS viewport (which can only
// happen if it is physical, on a >1x display) do we start dividing by the device
// pixel ratio. So logical coordinates are used as-is (the common case) and
// physical ones are corrected as soon as the cursor moves off the top-left.
let dropPositionIsPhysical = false;

export async function onFileDrop(handler: (event: FileDropEvent) => void): Promise<UnlistenFn> {
  if (realTauriRuntime) {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    return getCurrentWebview().onDragDropEvent(({ payload }) => {
      let position: { x: number; y: number } | null = null;
      if ('position' in payload && payload.position) {
        const raw = payload.position;
        const ratio = window.devicePixelRatio || 1;
        if (ratio > 1 && (raw.x > window.innerWidth + 2 || raw.y > window.innerHeight + 2)) {
          dropPositionIsPhysical = true;
        }
        position = dropPositionIsPhysical
          ? { x: raw.x / ratio, y: raw.y / ratio }
          : { x: raw.x, y: raw.y };
        // Temporary diagnostic (dev only): compare against where you actually
        // dropped to confirm the coordinate space. Remove once alignment is set.
        if (import.meta.env?.DEV && (payload.type === 'enter' || payload.type === 'drop')) {
          // eslint-disable-next-line no-console
          console.log(
            '[reverie drop]',
            payload.type,
            'raw',
            raw,
            'dpr',
            ratio,
            'viewport',
            {
              w: window.innerWidth,
              h: window.innerHeight,
            },
            '-> css',
            position,
          );
        }
      }
      const paths = 'paths' in payload ? payload.paths : [];
      handler({ type: payload.type, paths, position });
    });
  }

  return () => {};
}
