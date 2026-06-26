// Typed client for the on-device speech foundation: thin wrappers over the
// Tauri commands/events in `speech_commands.rs`, consistent with terminalApi.ts.
// This is the seam future voice features (dispatch, a voice button) consume.

import type {
  CaptureSignal,
  EngineState,
  MicPermission,
  TranscriptResult,
  WorkspaceShellSnapshot,
} from '../domain';
import { appRuntimeMode, invoke, listen, type UnlistenFn } from './runtime';

// The available microphone input device names, for the device picker.
export function listAudioInputDevices(): Promise<string[]> {
  return invoke<string[]>('list_audio_input_devices');
}

// Choose the microphone input device (null = system default): persists it and
// pushes it to the live engine. Returns the refreshed workspace snapshot.
export function setVoiceInputDevice(device: string | null): Promise<WorkspaceShellSnapshot> {
  return invoke<WorkspaceShellSnapshot>('set_voice_input_device', { device });
}

// Current engine state, for an initial paint. Live changes arrive via the
// `speech_engine_state` event (see onSpeechEngineState).
export function speechEngineStatus(): Promise<EngineState> {
  return invoke<EngineState>('speech_engine_status');
}

// Re-kick provisioning (a retry after an error). Idempotent.
export function speechProvision(): Promise<EngineState> {
  return invoke<EngineState>('speech_provision');
}

// Current microphone authorization, for the permission affordance.
export function speechMicPermissionStatus(): Promise<MicPermission> {
  return invoke<MicPermission>('speech_mic_permission_status');
}

// Begin a capture. `onSignal` receives the live RMS level (and, later, partial
// transcripts) for a UI listening meter. Returns the capture id used to stop or
// cancel. The transcript is NOT routed anywhere here; the caller decides what to
// do with the result of speechStopCapture.
export async function speechStartCapture(
  onSignal: (signal: CaptureSignal) => void,
): Promise<string> {
  // The live signal flows over a Tauri Channel (kept off the JSON event bus, the
  // same split the terminal uses for frames). Only the real desktop runtime has
  // Channels; in the browser harness the engine is Unavailable anyway.
  let channel: unknown;
  if (appRuntimeMode() === 'tauri') {
    const { Channel } = await import('@tauri-apps/api/core');
    const live = new Channel<CaptureSignal>();
    live.onmessage = onSignal;
    channel = live;
  }
  return invoke<string>('speech_start_capture', { onSignal: channel });
}

// Finish a capture and transcribe. Returns the final transcript.
export function speechStopCapture(captureId: string): Promise<TranscriptResult> {
  return invoke<TranscriptResult>('speech_stop_capture', { captureId });
}

// Abort a capture: drop the audio, no transcript.
export function speechCancelCapture(captureId: string): Promise<void> {
  return invoke<void>('speech_cancel_capture', { captureId });
}

// Subscribe to engine lifecycle changes (provisioning -> ready, errors, etc).
export function onSpeechEngineState(handler: (state: EngineState) => void): Promise<UnlistenFn> {
  return listen<EngineState>('speech_engine_state', event => handler(event.payload));
}

// Subscribe to non-fatal capture errors (e.g. the mic failed to open: denied
// permission, missing/locked device). These fire mid-capture and are otherwise
// invisible, since `speech_start_capture` returns before the worker opens the
// mic. `captureId` ties the error to a capture when known.
export function onSpeechError(
  handler: (payload: { message: string; captureId: string | null }) => void,
): Promise<UnlistenFn> {
  return listen<{ message: string; captureId: string | null }>('speech_error', event =>
    handler(event.payload),
  );
}
