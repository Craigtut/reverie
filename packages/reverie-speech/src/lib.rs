//! On-device speech-to-text engine for Reverie (macOS, Apple Silicon).
//!
//! This crate is the native half of the speech foundation: it owns microphone
//! capture, resampling to the engine's 16 kHz mono format, and transcription via
//! NVIDIA Parakeet on the Apple Neural Engine (through `fluidaudio-rs`). It is
//! deliberately **Tauri-agnostic**: the host wires an [`EventSink`] closure to
//! receive state transitions, and per-capture a [`SignalSink`] for the live
//! level/partial signal. The desktop app adapts those to Tauri `emit`/`Channel`.
//!
//! The contract is the same one the whole foundation promises: microphone audio
//! in, [`TranscriptResult`] out, plus [`EngineState`]. Nothing here routes the
//! transcript; the caller decides what to do with it.
//!
//! The heavy native pieces are feature-gated (`capture` = cpal/rubato, `asr` =
//! fluidaudio) so a build without them still compiles to an honest engine that
//! reports [`EngineState::Unavailable`]. The pure command/event plumbing is the
//! same either way, which is the seam features build on.

#[cfg(feature = "capture")]
mod capture;
mod engine;

pub use engine::{EventSink, SignalSink, SpeechEngine, SpeechEvent, SpeechHandle};

/// The available microphone input device names, for the device picker. Empty in
/// a build without the `capture` feature.
pub fn list_input_devices() -> Vec<String> {
    #[cfg(feature = "capture")]
    {
        capture::list_input_devices()
    }
    #[cfg(not(feature = "capture"))]
    {
        Vec::new()
    }
}

// Re-export the shared wire types so consumers can depend on `reverie-speech`
// alone without also naming `reverie-core` for the speech contracts.
pub use reverie_core::{CaptureId, CaptureSignal, EngineState, MicPermission, TranscriptResult};
