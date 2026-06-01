// Shared runtime-layer types. Kept dependency-free so both the runtime shim
// and the browser fixture can import them without a cycle.

export type RuntimeMode = 'tauri' | 'browser-fixture' | 'terminal-bridge';
export type UnlistenFn = () => void;
export type EventHandler<T> = (event: { payload: T }) => void;

declare global {
  interface Window {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
    __REVERIE_BROWSER_FIXTURE__?: boolean;
  }
}
