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

/// Which stage of one-time setup the engine is in, so the UI can show an honest
/// two-stage indicator ("Downloading the speech model" -> "Optimizing for the
/// Neural Engine") instead of a single opaque spinner. There is no smooth
/// percentage: the model is one ~425MB file (92% of the download) that lands
/// atomically, so byte progress isn't observable without the dependency's
/// progress callback. The phases are the boundaries we *can* detect on disk.
/// Serializes as a bare string (`"downloading"` / `"optimizing"`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProvisionPhase {
    /// Model files are still downloading (the one-time ~460MB pull).
    Downloading,
    /// The files are on disk; CoreML is compiling them for the Neural Engine.
    /// The dominant model file is present and `init_asr` is still working.
    Optimizing,
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
    /// The model is being downloaded (~460MB) and compiled for the Neural Engine.
    /// Only the first launch ever reaches this for more than ~1s. `phase` lets
    /// the UI distinguish the download from the post-download ANE compile.
    Provisioning { phase: ProvisionPhase },
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

#[cfg(test)]
mod tests {
    use super::*;

    // The frontend `EngineState` union (apps/desktop/web/domain/speech.ts) is hand
    // mirrored from this enum, so pin the wire shape: `kind` tag + a bare-string
    // `phase`. A change here without the matching TS edit would silently break the
    // provisioning UI.
    #[test]
    fn provisioning_serializes_with_phase() {
        let downloading = serde_json::to_value(EngineState::Provisioning {
            phase: ProvisionPhase::Downloading,
        })
        .unwrap();
        assert_eq!(downloading["kind"], "provisioning");
        assert_eq!(downloading["phase"], "downloading");

        let optimizing = serde_json::to_value(EngineState::Provisioning {
            phase: ProvisionPhase::Optimizing,
        })
        .unwrap();
        assert_eq!(optimizing["phase"], "optimizing");
    }

    #[test]
    fn ready_stays_a_bare_tag() {
        let ready = serde_json::to_value(EngineState::Ready).unwrap();
        assert_eq!(ready["kind"], "ready");
    }
}
