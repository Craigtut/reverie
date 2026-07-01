import { invoke, listen, type UnlistenFn } from './runtime';
import type { DispatchLaunchPayload, DispatchRouting, WorkspaceShellSnapshot } from '../domain';

// Service surface for the dispatch popup. Window control (hide/show/position)
// goes straight to the Tauri window module (lazy-imported, no-op in the browser
// harness, mirroring services/windowControls.ts). Classification and settings
// are backend commands; the launch handoff rides the shared event bus.

function isTauriRuntime(): boolean {
  const globals = window as Window & {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
    __REVERIE_BROWSER_FIXTURE__?: unknown;
  };
  if (globals.__REVERIE_BROWSER_FIXTURE__) return false;
  return Boolean(globals.__TAURI_INTERNALS__ || globals.__TAURI__);
}

// Dismiss the dispatch window (Escape, blur, or after a dispatch). Hides rather
// than closes so the pre-warmed bundle survives for the next invocation.
export async function hideDispatchWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const mod = await import('@tauri-apps/api/window');
    await mod.getCurrentWindow().hide();
  } catch (error) {
    console.warn('[reverie] hide dispatch window failed', error);
  }
}

// Fired by the backend on every global-shortcut press (the window is shown
// first). The overlay owns the state machine and decides what the press means:
// idle -> start a fresh capture; recording -> stop + transcribe; transcribing ->
// ignore. The backend no longer guesses open-vs-stop from native visibility.
export function onDispatchTrigger(handler: () => void): Promise<UnlistenFn> {
  return listen<void>('dispatch:trigger', () => handler());
}

// Fire when the dispatch window loses key focus (the user clicked away). The
// overlay uses this to dismiss Spotlight-style (cancelling any capture). No-op
// outside the desktop runtime.
export async function onDispatchWindowBlur(handler: () => void): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  try {
    const mod = await import('@tauri-apps/api/window');
    return await mod.getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) handler();
    });
  } catch (error) {
    console.warn('[reverie] dispatch blur subscription failed', error);
    return () => {};
  }
}

// The macOS event tap (modifier-tap shortcuts) reports whether it is installed
// (Input Monitoring granted). Emitted when a tap shortcut is configured.
export function onDispatchTapStatus(handler: (available: boolean) => void): Promise<UnlistenFn> {
  return listen<{ available: boolean }>('dispatch_tap_status', event =>
    handler(event.payload.available),
  );
}

// Open the macOS Input Monitoring privacy pane so the user can grant the tap.
export function openInputMonitoringSettings(): Promise<void> {
  return invoke<void>('open_input_monitoring_settings');
}

// Classify a request into a routing suggestion (runs the default agent's CLI at
// its utility-model tier on the backend). Throws on hard failure; the overlay
// then defaults the destination to General.
export function classifyDispatch(transcript: string): Promise<DispatchRouting> {
  return invoke<DispatchRouting>('classify_dispatch', { request: { transcript } });
}

// Persist the dispatch settings (shortcut, default-voice, saved window position)
// and re-register the accelerator. Returns the refreshed workspace snapshot.
export function setDispatchSettings(settings: {
  dispatchShortcut: string;
  dispatchDefaultVoice: boolean;
  dispatchWindowX: number | null;
  dispatchWindowY: number | null;
}): Promise<WorkspaceShellSnapshot> {
  return invoke<WorkspaceShellSnapshot>('set_dispatch_settings', { request: settings });
}

// Emit the confirmed dispatch to the main window (which owns workspace mutation
// and the terminal). Cross-window via the Tauri global event bus.
export async function emitDispatchLaunch(payload: DispatchLaunchPayload): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const mod = await import('@tauri-apps/api/event');
    await mod.emit('dispatch:launch', payload);
  } catch (error) {
    console.warn('[reverie] emit dispatch launch failed', error);
  }
}

// Subscribe (in the main window) to confirmed dispatches.
export function onDispatchLaunch(
  handler: (payload: DispatchLaunchPayload) => void,
): Promise<UnlistenFn> {
  return listen<DispatchLaunchPayload>('dispatch:launch', event => handler(event.payload));
}

// Save the dispatch window's current screen position so it reopens there. Reads
// the live outer position (physical px) and persists it alongside the other
// dispatch settings (which the caller passes through unchanged).
export async function saveDispatchWindowPosition(current: {
  dispatchShortcut: string;
  dispatchDefaultVoice: boolean;
}): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const mod = await import('@tauri-apps/api/window');
    const position = await mod.getCurrentWindow().outerPosition();
    await setDispatchSettings({
      dispatchShortcut: current.dispatchShortcut,
      dispatchDefaultVoice: current.dispatchDefaultVoice,
      dispatchWindowX: position.x,
      dispatchWindowY: position.y,
    });
  } catch (error) {
    console.warn('[reverie] save dispatch window position failed', error);
  }
}

// Size the dispatch window's height to fit its content (the panel grows with the
// input and dropdowns open into the space below). Width is fixed; the top-left
// position is unchanged, so this never disturbs the saved position. Clamped to a
// sane range.
export async function setDispatchWindowHeight(height: number): Promise<void> {
  if (!isTauriRuntime()) return;
  const clamped = Math.round(Math.min(640, Math.max(120, height)));
  try {
    const mod = await import('@tauri-apps/api/window');
    const { LogicalSize } = await import('@tauri-apps/api/dpi');
    await mod.getCurrentWindow().setSize(new LogicalSize(600, clamped));
  } catch (error) {
    console.warn('[reverie] resize dispatch window failed', error);
  }
}

// Bring the main window to the front after a dispatch (the user triggered the
// popup from another app). Called from the main window's launch handler.
export async function focusMainWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const mod = await import('@tauri-apps/api/window');
    const main = await mod.Window.getByLabel('main');
    if (!main) return;
    if (await main.isMinimized()) await main.unminimize();
    await main.show();
    await main.setFocus();
  } catch (error) {
    console.warn('[reverie] focus main window failed', error);
  }
}
