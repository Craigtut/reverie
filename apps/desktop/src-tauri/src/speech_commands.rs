//! Tauri command surface for the on-device speech foundation.
//!
//! This is the seam that future voice features (a dispatch global shortcut, an
//! in-terminal voice button) build on. The contract is intentionally narrow:
//! start a capture, stop it to get a [`TranscriptResult`], read/observe engine
//! state. Nothing here routes the transcript anywhere; a consumer decides.
//!
//! Engine lifecycle is pushed to the frontend via the `speech_engine_state`
//! event (see `main.rs`, where the [`reverie_speech::EventSink`] is wired to
//! `app.emit`). Per-capture live signal (RMS level, later partial transcripts)
//! flows over an optional `Channel<CaptureSignal>`, kept off the JSON event bus
//! the same way terminal frames are.

use std::sync::Arc;

use reverie_core::{
    CaptureId, EngineState, MicPermission, TranscriptResult, WorkspaceService, WorkspaceSnapshot,
};
use reverie_speech::{CaptureSignal, SignalSink, SpeechEngine};
use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

/// Payload for the `speech_error` event: a non-fatal error, optionally tied to
/// the capture it occurred during.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechErrorPayload {
    pub message: String,
    pub capture_id: Option<CaptureId>,
}

/// Current engine state, for the frontend's initial paint. Subsequent changes
/// arrive via the `speech_engine_state` event.
#[tauri::command]
pub(crate) fn speech_engine_status(engine: State<'_, SpeechEngine>) -> EngineState {
    engine.state()
}

/// Re-kick provisioning (e.g. a retry after an error). Idempotent.
#[tauri::command]
pub(crate) fn speech_provision(engine: State<'_, SpeechEngine>) -> EngineState {
    engine.provision();
    engine.state()
}

/// Current microphone authorization, for the permission affordance.
#[tauri::command]
pub(crate) fn speech_mic_permission_status(engine: State<'_, SpeechEngine>) -> MicPermission {
    engine.mic_permission()
}

/// The available microphone input device names, for the device picker.
#[tauri::command]
pub(crate) fn list_audio_input_devices() -> Vec<String> {
    reverie_speech::list_input_devices()
}

/// Choose the microphone input device for voice capture (`null`/empty = system
/// default): persist it and push it to the live engine for the next capture.
#[tauri::command]
pub(crate) fn set_voice_input_device(
    service: State<'_, WorkspaceService>,
    engine: State<'_, SpeechEngine>,
    device: Option<String>,
) -> Result<WorkspaceSnapshot, String> {
    let snapshot = service
        .set_voice_input_device(device)
        .map_err(|err| err.to_string())?;
    engine.set_input_device(snapshot.workspace.voice_input_device.clone());
    Ok(snapshot)
}

/// Begin a capture. `on_signal` receives the live RMS level (and, later, partial
/// transcripts) for a UI listening meter; callers that only want the final text
/// can simply not read it. Returns the capture id used to stop or cancel. Errors
/// fast if the engine is not ready or the mic is denied.
#[tauri::command]
pub(crate) fn speech_start_capture(
    engine: State<'_, SpeechEngine>,
    on_signal: Channel<CaptureSignal>,
) -> Result<CaptureId, String> {
    let sink: SignalSink = Arc::new(move |sig: CaptureSignal| {
        let _ = on_signal.send(sig);
    });
    engine.start_capture(Some(sink))
}

/// Finish a capture and transcribe. Async + `spawn_blocking` because it waits on
/// the engine worker's ANE reply (the same pattern as `read_terminal_rows`).
/// Returns the final transcript; the caller routes it.
#[tauri::command]
pub(crate) async fn speech_stop_capture(
    engine: State<'_, SpeechEngine>,
    capture_id: CaptureId,
) -> Result<TranscriptResult, String> {
    let handle = engine.handle();
    tauri::async_runtime::spawn_blocking(move || handle.stop_capture(capture_id))
        .await
        .map_err(|err| err.to_string())?
}

/// Abort a capture: drop the audio, return no transcript. Fast (just signals the
/// worker).
#[tauri::command]
pub(crate) fn speech_cancel_capture(engine: State<'_, SpeechEngine>, capture_id: CaptureId) {
    engine.handle().cancel_capture(capture_id);
}
