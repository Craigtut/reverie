import { invokeBrowserFixture, subscribeFixtureEvent } from './fixtures';
import type { EventHandler, RuntimeMode, UnlistenFn } from './types';

export type { UnlistenFn } from './types';

// Runtime shim: one surface for command invocation and event subscription that
// transparently routes to the real Tauri APIs when running inside the desktop
// app, or to the in-memory browser fixture (services/fixtures.ts) when running
// in a plain browser (npm run dev:harness). The Tauri API modules are imported
// lazily so the browser build never pays for them.

const realTauriRuntime = typeof window !== 'undefined'
  && Boolean(window.__TAURI_INTERNALS__ || (window.__TAURI__ && !window.__REVERIE_BROWSER_FIXTURE__));

if (typeof window !== 'undefined' && !realTauriRuntime) {
  window.__REVERIE_BROWSER_FIXTURE__ = true;
}

export function appRuntimeMode(): RuntimeMode {
  return realTauriRuntime ? 'tauri' : 'browser-fixture';
}

export async function invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (realTauriRuntime) {
    const tauriCore = await import('@tauri-apps/api/core');
    return tauriCore.invoke<T>(command, args);
  }

  return invokeBrowserFixture<T>(command, args);
}

export async function listen<T>(eventName: string, handler: EventHandler<T>): Promise<UnlistenFn> {
  if (realTauriRuntime) {
    const tauriEvent = await import('@tauri-apps/api/event');
    return tauriEvent.listen<T>(eventName, handler);
  }

  return subscribeFixtureEvent<T>(eventName, handler);
}
