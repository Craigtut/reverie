//! Shared, platform-free contracts for the on-device speech-to-text foundation.
//!
//! These are the data types that cross between the native speech engine
//! (`reverie-speech`, macOS-only), the Tauri command/event layer, and the
//! frontend. They live in `reverie-core` so every layer shares one wire
//! definition and so the pure crate stays free of any audio/native dependency.
//!
//! The foundation's contract: microphone audio in, [`TranscriptResult`] out,
//! plus [`EngineState`]. It never routes the transcript anywhere; a consumer
//! (a future dispatch surface, a voice button) decides what to do with the text.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Opaque handle for a single capture, generated per `start_capture`. Carried by
/// every signal and the final result so a stale/concurrent capture can never be
/// mistaken for the active one (the same stale-guard idea the terminal runtime
/// uses for terminal ids).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CaptureId(pub Uuid);

impl CaptureId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for CaptureId {
    fn default() -> Self {
        Self::new()
    }
}

/// Lifecycle of the speech engine, surfaced to the UI to drive the one-time
/// provisioning/loading state and to gate capture. Serializes as an internally
/// tagged object (`{ "kind": "ready" }`) for the frontend.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EngineState {
    /// Not on Apple Silicon, or the speech feature was compiled out. Capture is
    /// impossible; the UI hides voice affordances and explains why.
    Unavailable { reason: String },
    /// The model is being downloaded (~500MB) and compiled for the Neural Engine.
    /// Only the first launch ever reaches this for more than ~1s.
    Provisioning,
    /// `init_asr` succeeded; transcription is ready. Independent of microphone
    /// permission (which is resolved lazily on the first capture).
    Ready,
    /// Provisioning failed (download/compile error). A later `provision` retries.
    Error { message: String },
}

/// The sole product of the foundation: a finished transcript plus light
/// diagnostics. No routing, no side effects.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptResult {
    pub text: String,
    /// Engine-reported confidence in `0.0..=1.0`.
    pub confidence: f32,
    /// Seconds of audio that were captured.
    pub audio_seconds: f32,
    /// Wall-clock seconds the engine spent transcribing (for an in-app latency
    /// readout; not the same as audio length).
    pub processing_seconds: f32,
}

/// macOS microphone (TCC) authorization, surfaced so the UI can show a
/// "grant access" affordance that deep-links System Settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MicPermission {
    /// The user has granted microphone access.
    Granted,
    /// The user has denied access; capture cannot start until they change it.
    Denied,
    /// Not yet decided; the first capture will trigger the system prompt.
    Undetermined,
}

/// Lightweight, high-frequency signal streamed over a per-capture Tauri
/// `Channel` while a capture is live (kept off the JSON event bus, the same
/// split the terminal uses for frames vs lifecycle events).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CaptureSignal {
    /// RMS level of the most recent audio chunk, for a UI listening meter.
    Level { rms: f32 },
    /// Incremental transcript. The push-to-talk foundation does not emit these;
    /// the slot is reserved so a future streaming voice mode can add partials
    /// without changing the command signature.
    Partial { text: String },
}
