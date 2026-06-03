export type WindowControlAction = 'close' | 'minimize' | 'toggleFullscreen';

// Drive the native window (close / minimize / maximize). Lazy-imports the Tauri
// window module so the browser harness (no Tauri APIs) never pays for it and a
// missing module can't break the React shell; a no-op outside the real desktop
// runtime.
export async function invokeWindowControl(action: WindowControlAction) {
  try {
    const tauriGlobals = window as Window & {
      __TAURI_INTERNALS__?: unknown;
      __TAURI__?: unknown;
      __REVERIE_BROWSER_FIXTURE__?: unknown;
    };
    if (!tauriGlobals.__TAURI_INTERNALS__ && !tauriGlobals.__TAURI__) return;
    if (tauriGlobals.__REVERIE_BROWSER_FIXTURE__) return;
    const mod = await import('@tauri-apps/api/window');
    const win = mod.getCurrentWindow();
    if (action === 'close') await win.close();
    else if (action === 'minimize') await win.minimize();
    else {
      const isFullscreen = await win.isFullscreen();
      await win.setFullscreen(!isFullscreen);
    }
  } catch (error) {
    console.warn('[reverie] window control failed', action, error);
  }
}
