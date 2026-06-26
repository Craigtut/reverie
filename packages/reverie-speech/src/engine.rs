//! The speech engine runtime: a single worker thread that owns the native,
//! non-`Send` resources (the Parakeet handle, the microphone stream) and a thin
//! `Send`-safe handle (`SpeechEngine`) held in Tauri managed state.
//!
//! This mirrors how the terminal runtime and `KeepAwakeManager` are structured:
//! the heavy/native work lives on a dedicated thread, the managed-state handle
//! holds only a command `Sender`, a shared state cell, and the join handle.

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use reverie_core::{CaptureId, CaptureSignal, EngineState, MicPermission, TranscriptResult};

/// Sink the engine calls to surface lifecycle transitions and non-fatal errors
/// to the host. The desktop layer adapts these to `app.emit`.
pub type EventSink = Arc<dyn Fn(SpeechEvent) + Send + Sync>;

/// Sink for the per-capture live signal (RMS level now; partial transcripts
/// later). The desktop layer adapts this to a `Channel<CaptureSignal>`.
pub type SignalSink = Arc<dyn Fn(CaptureSignal) + Send + Sync>;

/// What the engine reports to the host out of band (i.e. not as a command
/// reply). Engine-state changes drive the provisioning UI; errors toast.
#[derive(Clone, Debug)]
pub enum SpeechEvent {
    /// The engine lifecycle state changed (e.g. Provisioning -> Ready).
    State(EngineState),
    /// A non-fatal error worth surfacing without flipping the engine state
    /// (e.g. a device hiccup mid-capture). `capture_id` ties it to a capture
    /// when applicable.
    Error {
        message: String,
        capture_id: Option<CaptureId>,
    },
}

/// Messages from the handle to the worker thread.
enum Command {
    /// Provision the model (download + ANE-compile on first run). Idempotent.
    Provision,
    /// Begin a capture. The worker opens the mic and starts accumulating.
    StartCapture {
        id: CaptureId,
        signal: Option<SignalSink>,
    },
    /// Finish a capture and transcribe; the result is sent back over `reply`.
    StopCapture {
        id: CaptureId,
        reply: Sender<Result<TranscriptResult, String>>,
    },
    /// Abort a capture: drop the audio, no transcript.
    CancelCapture { id: CaptureId },
    /// Choose the microphone input device by name (`None` = system default).
    /// Applies to the next capture.
    SetInputDevice(Option<String>),
    /// Stop the worker (on engine drop / app shutdown).
    Shutdown,
}

/// Thin, `Send`-safe handle to the speech engine, held in Tauri managed state.
/// All native state lives behind the worker thread; this owns only a cloneable
/// [`SpeechHandle`] and the worker's join handle (so drop stops + joins it).
pub struct SpeechEngine {
    handle: SpeechHandle,
    worker: Option<JoinHandle<()>>,
}

/// Cloneable client for the engine: just the command channel and a shared
/// snapshot of the engine state. `Send + 'static`, so it can be cloned out of
/// Tauri managed state and moved into a `spawn_blocking` for the blocking
/// stop/transcribe path (the same shape as the terminal runtime's handle).
#[derive(Clone)]
pub struct SpeechHandle {
    commands: Sender<Command>,
    state: Arc<Mutex<EngineState>>,
}

impl SpeechEngine {
    /// Spawn the engine worker. `events` receives lifecycle/error events. The
    /// caller should follow with [`SpeechEngine::provision`] to kick the
    /// (eager, on first launch) model download.
    pub fn new(events: EventSink) -> Self {
        let state = Arc::new(Mutex::new(initial_state()));
        let (tx, rx) = channel::<Command>();
        let worker = {
            let state = Arc::clone(&state);
            std::thread::Builder::new()
                .name("reverie-speech".to_owned())
                .spawn(move || run_worker(rx, state, events))
                .ok()
        };
        Self {
            handle: SpeechHandle { commands: tx, state },
            worker,
        }
    }

    /// A cloneable client for use off the main thread (async commands).
    pub fn handle(&self) -> SpeechHandle {
        self.handle.clone()
    }

    /// Current engine state (for initial paint; events drive updates after).
    pub fn state(&self) -> EngineState {
        self.handle.state()
    }

    /// Kick provisioning. Idempotent; a no-op if already `Ready`/`Provisioning`.
    pub fn provision(&self) {
        self.handle.provision();
    }

    /// Begin a capture. See [`SpeechHandle::start_capture`].
    pub fn start_capture(&self, signal: Option<SignalSink>) -> Result<CaptureId, String> {
        self.handle.start_capture(signal)
    }

    /// Current microphone (TCC) authorization, for the UI permission affordance.
    pub fn mic_permission(&self) -> MicPermission {
        mic_permission()
    }

    /// Choose the microphone input device (`None` = system default). Applies to
    /// the next capture.
    pub fn set_input_device(&self, name: Option<String>) {
        self.handle.set_input_device(name);
    }
}

impl SpeechHandle {
    /// Current engine state.
    pub fn state(&self) -> EngineState {
        self.state.lock().expect("speech state poisoned").clone()
    }

    /// Kick provisioning. Idempotent.
    pub fn provision(&self) {
        let _ = self.commands.send(Command::Provision);
    }

    /// Begin a capture. Fails fast if the engine is not `Ready`. Returns a
    /// [`CaptureId`] the caller uses to stop or cancel.
    pub fn start_capture(&self, signal: Option<SignalSink>) -> Result<CaptureId, String> {
        if !matches!(self.state(), EngineState::Ready) {
            return Err("speech engine is not ready".to_owned());
        }
        let id = CaptureId::new();
        self.commands
            .send(Command::StartCapture { id, signal })
            .map_err(|_| "speech engine stopped".to_owned())?;
        Ok(id)
    }

    /// Finish a capture and transcribe. Blocks on the worker's reply, so the
    /// caller should run this off the main thread (the desktop command uses
    /// `spawn_blocking`).
    pub fn stop_capture(&self, id: CaptureId) -> Result<TranscriptResult, String> {
        let (reply_tx, reply_rx) = channel();
        self.commands
            .send(Command::StopCapture {
                id,
                reply: reply_tx,
            })
            .map_err(|_| "speech engine stopped".to_owned())?;
        reply_rx
            .recv()
            .map_err(|_| "speech engine stopped before replying".to_owned())?
    }

    /// Abort a capture: drop the audio, return no transcript.
    pub fn cancel_capture(&self, id: CaptureId) {
        let _ = self.commands.send(Command::CancelCapture { id });
    }

    /// Choose the microphone input device (`None` = system default).
    pub fn set_input_device(&self, name: Option<String>) {
        let _ = self.commands.send(Command::SetInputDevice(name));
    }
}

impl Drop for SpeechEngine {
    fn drop(&mut self) {
        // Tell the worker to stop, but do NOT join it. The worker may be
        // mid-provisioning (`init_asr` blocks for 20-30s on first launch while it
        // downloads and ANE-compiles the model), and joining there would hang app
        // quit behind that download. Dropping the join handle detaches the thread;
        // it is only ever blocked on a channel recv or a one-shot model load, owns
        // nothing that needs flushing, and the OS reclaims it at process exit.
        let _ = self.handle.commands.send(Command::Shutdown);
        self.worker = None;
    }
}

/// The engine state a fresh worker starts in, before any provisioning. The
/// engine can only become `Ready` on Apple Silicon with a native feature
/// (`capture` and/or `asr`) compiled in; otherwise it is honestly `Unavailable`.
fn initial_state() -> EngineState {
    let apple_silicon = cfg!(all(target_os = "macos", target_arch = "aarch64"));
    let has_native = cfg!(any(feature = "capture", feature = "asr"));
    if apple_silicon && has_native {
        EngineState::Provisioning
    } else if !apple_silicon {
        EngineState::Unavailable {
            reason: "on-device speech requires an Apple Silicon Mac".to_owned(),
        }
    } else {
        EngineState::Unavailable {
            reason: "on-device speech is not enabled in this build".to_owned(),
        }
    }
}

/// Microphone (TCC) authorization. Without an AVFoundation probe we cannot
/// cheaply know the status before asking; denial surfaces as a failed capture
/// start, so we report `Undetermined` here. A precise tri-state is a future
/// refinement.
fn mic_permission() -> MicPermission {
    MicPermission::Undetermined
}

/// The worker loop. Owns all native resources (the `Session`); communicates only
/// via the command channel (in) and the event/signal sinks + reply channels
/// (out). While a capture is live it polls so it can drain the mic ring and emit
/// the level meter; otherwise it blocks on the next command.
fn run_worker(rx: Receiver<Command>, state: Arc<Mutex<EngineState>>, events: EventSink) {
    let set_state = {
        let state = Arc::clone(&state);
        let events = Arc::clone(&events);
        move |next: EngineState| {
            *state.lock().expect("speech state poisoned") = next.clone();
            events(SpeechEvent::State(next));
        }
    };
    let mut session = Session::new(events);

    loop {
        let command = if session.is_capturing() {
            match rx.recv_timeout(std::time::Duration::from_millis(40)) {
                Ok(command) => Some(command),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    session.tick();
                    None
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match rx.recv() {
                Ok(command) => Some(command),
                Err(_) => break,
            }
        };
        let Some(command) = command else { continue };
        match command {
            Command::Provision => session.provision(&set_state),
            Command::StartCapture { id, signal } => session.start_capture(id, signal),
            Command::StopCapture { id, reply } => {
                let _ = reply.send(session.stop_capture(id));
            }
            Command::CancelCapture { id } => session.cancel_capture(id),
            Command::SetInputDevice(name) => session.set_input_device(name),
            Command::Shutdown => break,
        }
    }
}

/// The worker's owned, thread-confined state. Encapsulates the feature-gated
/// native pieces (a live microphone capture, and in the asr phase the Parakeet
/// handle) so the loop above stays the same across feature sets.
struct Session {
    events: EventSink,
    #[cfg(feature = "capture")]
    active: Option<ActiveCapture>,
    /// Chosen microphone input device name (`None` = system default), applied to
    /// the next capture.
    #[cfg(feature = "capture")]
    device: Option<String>,
    // The Parakeet/ANE handle (fluidaudio). `!Send`, so it stays on this worker
    // thread. `None` until provisioning succeeds. Only read from `transcribe`,
    // which exists only with `capture`; an asr-only build (e.g. the smoke-test
    // command) populates but never reads it, so allow dead_code there.
    #[cfg(feature = "asr")]
    #[cfg_attr(not(feature = "capture"), allow(dead_code))]
    asr: Option<fluidaudio_rs::FluidAudio>,
}

#[cfg(feature = "capture")]
struct ActiveCapture {
    id: CaptureId,
    capture: crate::capture::Capture,
    signal: Option<SignalSink>,
}

impl Session {
    fn new(events: EventSink) -> Self {
        Self {
            events,
            #[cfg(feature = "capture")]
            active: None,
            #[cfg(feature = "capture")]
            device: None,
            #[cfg(feature = "asr")]
            asr: None,
        }
    }

    /// Choose the input device used for the next capture.
    fn set_input_device(&mut self, name: Option<String>) {
        #[cfg(feature = "capture")]
        {
            self.device = name;
        }
        #[cfg(not(feature = "capture"))]
        {
            let _ = name;
        }
    }

    fn is_capturing(&self) -> bool {
        #[cfg(feature = "capture")]
        {
            self.active.is_some()
        }
        #[cfg(not(feature = "capture"))]
        {
            false
        }
    }

    /// Drain the mic ring and emit the live level (only while capturing).
    fn tick(&mut self) {
        #[cfg(feature = "capture")]
        if let Some(active) = self.active.as_mut() {
            let rms = active.capture.drain_rms();
            if let Some(sink) = active.signal.as_ref() {
                sink(CaptureSignal::Level { rms });
            }
        }
    }

    /// Provision the engine. With `asr`, this downloads + ANE-compiles the
    /// Parakeet model on first run (blocking, 20-30s cold / ~1s cached), so the
    /// state goes Provisioning -> Ready/Error. With only `capture`, the engine is
    /// `Ready` so the mic + meter are testable (stop returns an empty transcript).
    /// With neither, `Unavailable`. Idempotent: re-provisioning when already
    /// Ready just re-confirms.
    fn provision(&mut self, set_state: &impl Fn(EngineState)) {
        #[cfg(feature = "asr")]
        {
            if self.asr.is_some() {
                set_state(EngineState::Ready);
                return;
            }
            set_state(EngineState::Provisioning);
            match init_asr_engine() {
                Ok(engine) => {
                    self.asr = Some(engine);
                    set_state(EngineState::Ready);
                }
                Err(message) => set_state(EngineState::Error { message }),
            }
        }
        #[cfg(all(feature = "capture", not(feature = "asr")))]
        {
            set_state(EngineState::Ready);
        }
        #[cfg(not(any(feature = "capture", feature = "asr")))]
        {
            set_state(EngineState::Unavailable {
                reason: "on-device speech is not enabled in this build".to_owned(),
            });
        }
    }

    fn start_capture(&mut self, id: CaptureId, signal: Option<SignalSink>) {
        #[cfg(feature = "capture")]
        {
            // Supersede any prior capture.
            self.active = None;
            match crate::capture::Capture::start(self.device.as_deref()) {
                Ok(capture) => {
                    self.active = Some(ActiveCapture {
                        id,
                        capture,
                        signal,
                    });
                }
                Err(message) => {
                    (self.events)(SpeechEvent::Error {
                        message,
                        capture_id: Some(id),
                    });
                }
            }
        }
        #[cfg(not(feature = "capture"))]
        {
            let _ = signal;
            (self.events)(SpeechEvent::Error {
                message: "microphone capture is not enabled in this build".to_owned(),
                capture_id: Some(id),
            });
        }
    }

    fn stop_capture(&mut self, id: CaptureId) -> Result<TranscriptResult, String> {
        #[cfg(feature = "capture")]
        {
            let active = match self.active.take() {
                Some(active) if active.id == id => active,
                Some(other) => {
                    self.active = Some(other);
                    return Err("no matching active capture".to_owned());
                }
                None => return Err("no active capture".to_owned()),
            };
            let audio_seconds = active.capture.audio_seconds();
            let samples = active.capture.finish()?;
            self.transcribe(samples, audio_seconds)
        }
        #[cfg(not(feature = "capture"))]
        {
            let _ = id;
            Err("microphone capture is not enabled in this build".to_owned())
        }
    }

    fn cancel_capture(&mut self, id: CaptureId) {
        #[cfg(feature = "capture")]
        {
            if matches!(self.active.as_ref(), Some(active) if active.id == id) {
                self.active = None;
            }
        }
        #[cfg(not(feature = "capture"))]
        {
            let _ = id;
        }
    }

    /// Transcribe captured 16 kHz mono samples. With `asr`, runs Parakeet on the
    /// ANE; without it (capture-only dev builds), returns an empty transcript
    /// with the real audio length so the capture pipeline is verifiable.
    #[cfg(feature = "capture")]
    fn transcribe(
        &mut self,
        samples: Vec<f32>,
        audio_seconds: f32,
    ) -> Result<TranscriptResult, String> {
        #[cfg(feature = "asr")]
        {
            let asr = self
                .asr
                .as_ref()
                .ok_or_else(|| "speech engine is not provisioned".to_owned())?;
            let result = asr
                .transcribe_samples(&samples)
                .map_err(|err| err.to_string())?;
            Ok(TranscriptResult {
                text: result.text,
                confidence: result.confidence,
                audio_seconds,
                processing_seconds: result.processing_time as f32,
            })
        }
        #[cfg(not(feature = "asr"))]
        {
            let _ = samples;
            Ok(TranscriptResult {
                text: String::new(),
                confidence: 0.0,
                audio_seconds,
                processing_seconds: 0.0,
            })
        }
    }
}

/// Create and provision a Parakeet/ANE engine (downloads + compiles the model on
/// first run). Runs only on the worker thread.
#[cfg(feature = "asr")]
fn init_asr_engine() -> Result<fluidaudio_rs::FluidAudio, String> {
    let audio = fluidaudio_rs::FluidAudio::new().map_err(|err| err.to_string())?;
    if audio.is_intel_mac() {
        return Err("on-device speech requires an Apple Silicon Mac".to_owned());
    }
    audio.init_asr().map_err(|err| err.to_string())?;
    Ok(audio)
}
