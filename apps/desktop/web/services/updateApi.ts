import { invoke } from './runtime';

// Auto-update service. Mirrors the lazy-import guard pattern in
// windowControls.ts: the Tauri updater/process modules are imported only inside
// the real desktop runtime, so the browser harness (and the dev channel) never
// load them and never reach out to the network. The live `Update` handle from
// `check()` carries non-serializable download/install methods, so it is kept in
// module scope here while the serializable status lives in store/updateStore.ts.

type UpdaterStatus = { version: string; enabled: boolean };

// The Update object returned by @tauri-apps/plugin-updater. Typed loosely so we
// do not need the plugin's types in the browser build.
interface PendingUpdate {
  version: string;
  body?: string | null;
  download: (onEvent: (event: UpdateDownloadEvent) => void) => Promise<void>;
  install: () => Promise<void>;
}

type UpdateDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

let pendingUpdate: PendingUpdate | null = null;

function isDesktopRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const globals = window as Window & {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
    __REVERIE_BROWSER_FIXTURE__?: unknown;
  };
  if (globals.__REVERIE_BROWSER_FIXTURE__) return false;
  return Boolean(globals.__TAURI_INTERNALS__ || globals.__TAURI__);
}

// The running app version + whether updates are enabled for this build. Returns
// a disabled status outside the desktop runtime so the UI can render the
// current version without ever arming the updater.
export async function fetchUpdaterStatus(): Promise<UpdaterStatus> {
  if (!isDesktopRuntime()) return { version: '', enabled: false };
  try {
    const status = await invoke<UpdaterStatus>('updater_status');
    return status;
  } catch {
    return { version: '', enabled: false };
  }
}

export type UpdateCheckResult =
  | { kind: 'none' }
  | { kind: 'update'; version: string; notes: string | null }
  | { kind: 'unavailable' };

// Ask the configured endpoint whether a newer build exists. On a hit, the live
// handle is stashed for a later download/install. `unavailable` means the
// updater could not run at all (wrong runtime), distinct from `none` (ran, but
// already current).
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  if (!isDesktopRuntime()) return { kind: 'unavailable' };
  const mod = await import('@tauri-apps/plugin-updater');
  const update = (await mod.check()) as PendingUpdate | null;
  if (!update) {
    pendingUpdate = null;
    return { kind: 'none' };
  }
  pendingUpdate = update;
  return { kind: 'update', version: update.version, notes: update.body ?? null };
}

export function hasPendingUpdate(): boolean {
  return pendingUpdate !== null;
}

// Download the staged update, reporting progress as a 0..1 fraction. The bundle
// is written to a temp location; it is not applied until install() runs. Safe to
// call only after a `checkForUpdate()` that returned an update.
export async function downloadPendingUpdate(
  onProgress?: (fraction: number) => void,
): Promise<void> {
  if (!pendingUpdate) throw new Error('No update has been checked for download.');
  let contentLength = 0;
  let downloaded = 0;
  await pendingUpdate.download(event => {
    switch (event.event) {
      case 'Started':
        contentLength = event.data.contentLength ?? 0;
        onProgress?.(0);
        break;
      case 'Progress':
        downloaded += event.data.chunkLength;
        if (contentLength > 0) onProgress?.(downloaded / contentLength);
        break;
      case 'Finished':
        onProgress?.(1);
        break;
    }
  });
}

// Apply the downloaded update in place without relaunching. Used by the
// install-on-quit path: the swapped bundle is picked up on the next launch.
export async function installPendingUpdate(): Promise<void> {
  if (!pendingUpdate) throw new Error('No update has been downloaded to install.');
  await pendingUpdate.install();
}

// Relaunch into the freshly installed version. Call only after
// installPendingUpdate() has swapped the bundle and the Rust side has stopped
// sessions + marked shutdown begun (so the quit guard lets the restart through).
export async function relaunchNow(): Promise<void> {
  const process = await import('@tauri-apps/plugin-process');
  await process.relaunch();
}
