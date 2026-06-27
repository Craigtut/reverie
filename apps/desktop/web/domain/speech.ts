// Wire types for the on-device speech foundation. These mirror the Rust serde
// shapes in `reverie-core::speech` (the source of truth). Pure types; no React.

// Which stage of one-time setup the engine is in (mirrors Rust ProvisionPhase).
// There is no smooth percentage: the model is one ~425MB file that lands
// atomically, so the UI shows these two honest stages instead of a fake bar.
export type ProvisionPhase = 'downloading' | 'optimizing';

// Engine lifecycle, internally tagged on `kind` to match the Rust enum.
export type EngineState =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'provisioning'; phase: ProvisionPhase }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

// Collapsed availability for voice surfaces (dispatch, settings) so each stops
// re-deriving readiness from raw engine state. `voiceEnabled` off reads as
// unavailable (the model may still be cached, but the user has opted out).
export type VoiceAvailability = 'ready' | 'provisioning' | 'unavailable' | 'error';

export function voiceAvailability(engine: EngineState, voiceEnabled = true): VoiceAvailability {
  if (!voiceEnabled) return 'unavailable';
  return engine.kind;
}

// The honest one-time-setup stage label, shared by settings and dispatch so the
// copy never drifts. Kept short; callers add their own surrounding sentence.
export function provisioningLabel(phase: ProvisionPhase): string {
  return phase === 'optimizing'
    ? 'Optimizing for the Neural Engine'
    : 'Downloading the speech model';
}

// The product of a capture: finished transcript plus light diagnostics.
export interface TranscriptResult {
  text: string;
  confidence: number;
  audioSeconds: number;
  processingSeconds: number;
}

// macOS microphone (TCC) authorization (serialized as a bare string).
export type MicPermission = 'granted' | 'denied' | 'undetermined';

// Live per-capture signal streamed over a Tauri Channel while recording.
export type CaptureSignal = { kind: 'level'; rms: number } | { kind: 'partial'; text: string };
