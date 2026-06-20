# Voice input and the STT primitive

> Part of the [core experience](README.md). Defines the on-device speech-to-text primitive (shared with [dispatch](dispatch.md)) and the floating voice button.

This doc has two parts: the shared STT engine, and the one in-session voice surface we are keeping.

## What we are not building

We explored a "redirect / talk-over" surface: an input field, overlaid on a running session, that lets you queue or interrupt with new direction. **Dropped.** The CLIs already own an input field in their TUI, and floating a second input box over the top of it is awkward and confusing. We do not own an input layer, and we should not pretend to.

The surviving idea is much smaller and clearly good: a way to **speak into the TUI's own input field**.

## The floating voice button

A floating button in the terminal view starts voice capture. On release, the transcript is written into the **CLI's own input field** via the PTY (`packages/reverie-core/src/pty.rs`, `write_input`, with bracketed paste). The user then edits and sends inside the TUI as normal.

This is the right shape for two reasons:

- It honors the I/O asymmetry: speaking is the fast way to get intent out (~150 wpm vs ~40-75 typing), so let the user talk; reading and editing the result is fast and visual.
- It respects the "confirm before acting" rule: the text lands in the input field, not into a committed prompt, so the user reviews and corrects by eye before sending. We fill their field; we never send for them.

No new input box, no ownership of the prompt, no fighting the TUI. Just dictation into the field that is already there.

## The STT primitive: Parakeet V3 (shared)

Both this button and [dispatch](dispatch.md) use one on-device speech-to-text engine. The choice is **NVIDIA Parakeet V3** (`parakeet-tdt-0.6b-v3`): fast, accurate, multilingual, and licensed (CC-BY-4.0) for commercial bundling with attribution.

### Interaction model

Parakeet is an offline/batch model, which fits push-to-talk perfectly: **record while held, transcribe on release.** No streaming needed; the real-time factor is high enough that a normal utterance returns effectively instantly.

### Implementation (built foundation)

Because Reverie is Apple-Silicon-only, we went straight to **Parakeet on the Apple Neural Engine via `fluidaudio-rs`** (the CoreML path), skipping the planned pure-Rust ONNX de-risk stage. On Apple Silicon, ANE is exactly the speed/footprint win we want, and the cross-platform advantage of a pure-Rust ONNX runtime is worthless to a Mac-only app. The Swift build step is in our wheelhouse (we already build libghostty through a non-Rust toolchain).

The engine is a foundation, separate from the features above:

- **`packages/reverie-speech`** (macOS, feature-gated `capture` + `asr`): a worker-thread engine that owns native microphone capture (`cpal`), resampling to 16 kHz mono (`rubato`), and transcription (`fluidaudio-rs` → Parakeet on the ANE). `cpal`/`fluidaudio` handles are `!Send`, so they live on the one worker thread; a `Send`-safe handle sits in Tauri managed state. The crate is a path dep of the desktop app only, so the root `cargo test` never triggers the Swift build.
- **The seam features consume**: Tauri commands (`speech_start_capture`, `speech_stop_capture`, `speech_cancel_capture`, `speech_provision`, `speech_engine_status`, `speech_mic_permission_status`), a `speech_engine_state` event, and a per-capture `Channel<CaptureSignal>` (RMS level now, partial transcripts reserved). The foundation returns the transcript and routes it nowhere; the floating button sends it through `write_input`, dispatch sends it to the completion surface. Frontend client: `services/speechApi.ts`, `store/speechEngineStore.ts`, `hooks/useSpeechEngine` + `useSpeechCapture`.
- **Model is downloaded at runtime, not bundled**, and provisioned **eagerly on first launch** (a one-time ~500MB background download + ANE compile; cached ~1s after). It is not gated on the voice-enabled setting; the download happens once for everyone. The UI dwell-gates the provisioning screen so warm starts never flash it.

`fluidaudio-rs` is young; it is pinned and wrapped behind the `reverie-speech` facade so a future swap (or a vendored copy) does not ripple. Streaming (`streaming_asr_*`) and VAD endpointing are wired as seams in the worker but not exposed as commands; a future voice mode turns them on without re-architecting.

### Local-first

STT runs entirely on-device. No audio leaves the machine. This matches the local-first guardrail and is a real differentiator over cloud dictation, and it is why voice is safe even for confidential prompts.

## Builds on

- `packages/reverie-core/src/pty.rs` (`write_input`, bracketed paste) for injecting the transcript into the TUI field.
- The same STT engine instance serves the dispatch capture window.

## Open questions

- Bundle the ~670 MB INT8 model in the app vs download on first run (CC-BY-4.0 allows either).
- The push-to-talk trigger for the in-session button (click-and-hold, a hotkey, or both) and whether it shares the dispatch global shortcut.
- When to invest in the CoreML/ANE upgrade (only if CPU latency tests poorly on target hardware).
- Multi-language handling and whether to expose a language setting or auto-detect.
- Where the model files live on disk and how they are versioned/updated.
