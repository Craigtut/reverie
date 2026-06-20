//! End-to-end smoke test for the Parakeet/ANE path.
//!
//! Ignored by default: the first run downloads ~500MB and ANE-compiles the model,
//! which is too heavy for every CI run. Run it explicitly on an Apple Silicon
//! Mac with:
//!
//! ```sh
//! cargo test -p reverie-speech --features asr -- --ignored
//! ```
//!
//! It proves the Swift bridge links, the model loads, and `transcribe_samples`
//! runs without panicking. It does not assert specific text: a real-speech WAV
//! fixture for an accuracy assertion is a follow-on (the captured audio in the
//! app is the true source of speech).

#![cfg(all(target_os = "macos", target_arch = "aarch64", feature = "asr"))]

use fluidaudio_rs::FluidAudio;

#[test]
#[ignore = "downloads ~500MB and compiles the model on first run"]
fn transcribe_runs_end_to_end() {
    let audio = FluidAudio::new().expect("create FluidAudio bridge");
    assert!(!audio.is_intel_mac(), "this test requires Apple Silicon");
    audio
        .init_asr()
        .expect("init_asr should download + compile the model");

    // One second of 16 kHz mono audio. Silence is enough to exercise the full
    // path (new -> init -> transcribe) end to end.
    let samples = vec![0.0f32; 16_000];
    let result = audio
        .transcribe_samples(&samples)
        .expect("transcribe_samples should return a result");

    // A (possibly empty) transcript came back with sane diagnostics.
    assert!(result.confidence >= 0.0 && result.confidence <= 1.0);
    let _ = result.text;
}
