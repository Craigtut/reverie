/// <reference types="vite/client" />

// Injected by Vite's `define` from the root package.json version.
declare const __APP_VERSION__: string;

interface Window {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
}
