// Wire types for the on-device speech foundation. These mirror the Rust serde
// shapes in `reverie-core::speech` (the source of truth). Pure types; no React.

// Engine lifecycle, internally tagged on `kind` to match the Rust enum.
export type EngineState =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'provisioning' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

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
