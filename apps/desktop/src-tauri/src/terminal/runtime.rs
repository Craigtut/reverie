use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError},
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use reverie_core::TerminalSpawnSpec;
use reverie_core::agents::derive_session_title;
use reverie_core::domain::{AgentKind, NativeSessionRef, SessionId};
use reverie_core::pty::{PtyController, PtyProcess};
use reverie_core::terminal::{TerminalColor, TerminalId};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};

use crate::terminal::ghostty::GhosttyTerminalState;
use crate::terminal::wire::{encode_frame, encode_row_band};
use reverie_core::WorkspaceService;
use reverie_core::session_log::SessionLogControl;

const READ_BUFFER_BYTES: usize = 4096;
const PTY_DRAIN_MAX_BYTES: usize = 64 * 1024;
const PTY_DRAIN_MAX_CHUNKS: usize = 64;
const TERMINAL_FRAME_INTERVAL: Duration = Duration::from_millis(16);
const BACKGROUND_TERMINAL_FRAME_INTERVAL: Duration = Duration::from_millis(100);
const SYNC_OUTPUT_FRAME_TIMEOUT: Duration = Duration::from_millis(1000);
/// Shared grace period for batch shutdown: SIGTERM every session, wait this
/// long once, then SIGKILL any stragglers.
const SHUTDOWN_GRACE: Duration = Duration::from_millis(500);

/// The terminal's default foreground/background. libghostty-vt has no color
/// config, so Reverie sources these from the active shell theme and feeds them
/// into each terminal as OSC 10/11 (see `GhosttyTerminalState::set_default_colors`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalThemeColors {
    pub foreground: TerminalColor,
    pub background: TerminalColor,
}

impl Default for TerminalThemeColors {
    fn default() -> Self {
        // Dark-theme values (the shell's `--text` / `--bg` tokens). The app
        // boots dark, so a terminal spawned before the frontend pushes the
        // active theme via `set_terminal_theme` already looks right.
        Self {
            foreground: TerminalColor {
                r: 0xEF,
                g: 0xE9,
                b: 0xDF,
            },
            background: TerminalColor {
                r: 0x0B,
                g: 0x0A,
                b: 0x09,
            },
        }
    }
}

#[derive(Clone, Default)]
pub struct TerminalSessionRuntime {
    sessions: Arc<Mutex<HashMap<TerminalId, TerminalSessionRecord>>>,
    controllers: Arc<Mutex<HashMap<TerminalId, PtyController>>>,
    command_senders: Arc<Mutex<HashMap<TerminalId, Sender<TerminalRuntimeCommand>>>>,
    // The active shell theme's default terminal colors, pushed from the
    // frontend. Applied to each terminal at spawn and re-broadcast on change.
    default_colors: Arc<Mutex<TerminalThemeColors>>,
    // The single terminal the user is currently viewing, mirrored from the
    // frontend's `set_frontend_active`. The idle-session reaper reads this so it
    // never reaps the session on screen, even when that session is idle.
    foreground_terminal: Arc<Mutex<Option<TerminalId>>>,
}

enum TerminalRuntimeCommand {
    Resize {
        cols: u16,
        rows: u16,
    },
    // Serve a contiguous history band straight from libghostty's live buffer
    // (decisions.md D6/D7). Scrolling is frontend-driven, so the backend never
    // moves the viewport in response to a scroll; this is the one place the
    // frontend pulls rows. The worker runs `read_rows` (which moves the pin to
    // the band, extracts it, and restores the pin to the tail) on its own thread
    // and replies with the encoded row band over the oneshot `reply` channel.
    ReadRows {
        start_id: u64,
        count: usize,
        generation: u32,
        reply: Sender<Vec<u8>>,
    },
    // Push new default fg/bg into the live terminal (theme switch).
    SetDefaultColors {
        foreground: TerminalColor,
        background: TerminalColor,
    },
    SetFrontendActive(bool),
}

#[derive(Debug)]
enum PtyReadEvent {
    Chunk(Vec<u8>),
    Exited { child_success: bool },
    Failed(String),
}

struct PtyReadBatch {
    bytes: Vec<u8>,
    chunks: usize,
    deferred_event: Option<DeferredPtyReadEvent>,
}

enum DeferredPtyReadEvent {
    Exited { child_success: bool },
    Failed(String),
}

// Worker-side view state. The backend no longer tracks follow-tail: scrolling is
// frontend-driven (decisions.md D6), so the worker always emits the active tail
// and the frontend decides whether the tail is on screen. Only the frame cadence
// (foreground vs. background) lives here now.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct TerminalViewportState {
    frontend_active: bool,
}

// No `Debug` derive: `tauri::ipc::Channel` is not `Debug`, and the request is
// never formatted. It stays `Clone` because `spawn_session_stream` clones it
// into the worker thread (the Channel is cheaply `Arc`-cloned).
#[derive(Clone)]
pub struct TerminalStreamRequest {
    pub session_id: Option<SessionId>,
    pub terminal_id: TerminalId,
    pub spawn_spec: TerminalSpawnSpec,
    pub target_frames: Option<usize>,
    /// Which CLI runs in this session, so the worker can apply that CLI's title
    /// rule to its OSC titles. `None` for the bench/proof path (no live title).
    pub agent_kind: Option<AgentKind>,
    /// The session working-folder basename, used to suppress CLIs that default
    /// their title to the folder name. `None` for the bench/proof path.
    pub folder_name: Option<String>,
    /// Per-session binary frame transport. Each encoded `TerminalFrame` is sent
    /// over this Channel as raw bytes (an `ArrayBuffer` on the JS side). `None`
    /// only in tests that register a session without driving the stream.
    pub frame_channel: Option<Channel<InvokeResponseBody>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionRecord {
    pub session_id: Option<SessionId>,
    pub terminal_id: TerminalId,
    pub title: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub status: TerminalRuntimeStatus,
    pub frames_emitted: usize,
    pub bytes_read: usize,
    pub last_exit_success: Option<bool>,
    // Reaper bookkeeping (not serialized to the frontend; `Instant` is not a
    // wall clock anyway). `last_output_at` is when the PTY last produced bytes;
    // `last_active_at` is when the user last sent input. The idle-session reaper
    // uses these to avoid reaping a session that is producing output or that the
    // user just interacted with, and as an idle-time fallback for CLIs with no
    // activity-hook integration.
    #[serde(skip)]
    pub last_output_at: Instant,
    #[serde(skip)]
    pub last_active_at: Instant,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalRuntimeStatus {
    Starting,
    Running,
    Exited,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStreamStarted {
    label: &'static str,
    session_id: Option<SessionId>,
    terminal_id: TerminalId,
    cols: u16,
    rows: u16,
    target_frames: Option<usize>,
}

/// Emitted when a session's normalized OSC title changes, so the frontend can
/// update the session's live label without refetching the whole snapshot.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalTitleChangedEvent {
    session_id: SessionId,
    terminal_id: TerminalId,
    title: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    label: &'static str,
    session_id: Option<SessionId>,
    terminal_id: TerminalId,
    frames_emitted: usize,
    chunks_read: usize,
    bytes_read: usize,
    rust_elapsed_ms: f64,
    total_emit_ms: f64,
    avg_emit_ms: f64,
    max_emit_ms: f64,
    child_success: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalFailedEvent {
    session_id: Option<SessionId>,
    terminal_id: Option<TerminalId>,
    message: String,
}

impl TerminalSessionRuntime {
    /// The active theme's default terminal colors (dark until the frontend
    /// pushes the live theme). Read at spawn so default-colored cells match the
    /// shell.
    pub fn default_colors(&self) -> TerminalThemeColors {
        self.default_colors
            .lock()
            .map(|colors| *colors)
            .unwrap_or_default()
    }

    /// Set the default terminal colors for the active theme. Stored for
    /// future spawns and broadcast to every live terminal so a theme switch
    /// repaints without respawning sessions.
    pub fn set_theme_colors(&self, foreground: TerminalColor, background: TerminalColor) {
        if let Ok(mut colors) = self.default_colors.lock() {
            *colors = TerminalThemeColors {
                foreground,
                background,
            };
        }
        if let Ok(senders) = self.command_senders.lock() {
            for sender in senders.values() {
                let _ = sender.send(TerminalRuntimeCommand::SetDefaultColors {
                    foreground,
                    background,
                });
            }
        }
    }

    pub fn spawn_session_stream(
        &self,
        app: AppHandle,
        request: TerminalStreamRequest,
    ) -> Result<TerminalId> {
        let terminal_id = request.terminal_id;
        self.register_starting(&request)?;

        let runtime = self.clone();
        thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                runtime.run_stream_worker(app.clone(), request.clone())
            }));
            let failure_message = match result {
                Ok(Ok(())) => return,
                Ok(Err(err)) => err.to_string(),
                Err(payload) => panic_payload_message(payload.as_ref()),
            };

            runtime.remove_controller(request.terminal_id);
            runtime.register_failed(request.terminal_id);
            persist_shell_session_failed(&app, request.session_id);
            eprintln!(
                "[reverie-terminal] stream failed for {}: {}",
                request.terminal_id, failure_message
            );
            let failure = TerminalFailedEvent {
                session_id: request.session_id,
                terminal_id: Some(request.terminal_id),
                message: failure_message,
            };
            let _ = app.emit("terminal_failed", failure);
        });

        Ok(terminal_id)
    }

    pub fn list_sessions(&self) -> Result<Vec<TerminalSessionRecord>> {
        let mut records = self
            .sessions
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal runtime session map is poisoned"))?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        records.sort_by_key(|record| record.terminal_id);
        Ok(records)
    }

    pub fn write_input(&self, terminal_id: TerminalId, input: &[u8]) -> Result<()> {
        if input.is_empty() {
            return Ok(());
        }

        self.controller_for(terminal_id)?.write_input(input)?;
        // Record the interaction so the reaper never reaps a session the user
        // just typed into, even on a CLI with no activity-hook integration.
        let _ = self.update_record(terminal_id, |record| {
            record.last_active_at = Instant::now();
        });
        Ok(())
    }

    pub fn resize_terminal(&self, terminal_id: TerminalId, cols: u16, rows: u16) -> Result<()> {
        if cols == 0 || rows == 0 {
            bail!("terminal resize requires non-zero cols and rows");
        }

        self.controller_for(terminal_id)?.resize(cols, rows)?;
        self.command_sender_for(terminal_id)?
            .send(TerminalRuntimeCommand::Resize { cols, rows })
            .context("failed to queue terminal resize command")?;
        self.update_record(terminal_id, |record| {
            record.cols = cols;
            record.rows = rows;
        })
    }

    /// Serve a contiguous band of history rows for the frontend's scroll-back
    /// prefetch (decisions.md D6/D7). Dispatches a `ReadRows` command to the
    /// session's worker thread (the sole owner of the VT state), which runs
    /// `read_rows` and replies with the encoded binary row band (see
    /// `wire-protocol.md`). Blocks the calling command thread on the worker's
    /// reply; the worker serializes this with live extracts, so the user never
    /// sees the pin excursion. The frontend tags each request with the
    /// generation it holds and drops a band whose generation no longer matches.
    pub fn read_terminal_rows(
        &self,
        terminal_id: TerminalId,
        start_id: u64,
        count: usize,
        generation: u32,
    ) -> Result<Vec<u8>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.command_sender_for(terminal_id)?
            .send(TerminalRuntimeCommand::ReadRows {
                start_id,
                count,
                generation,
                reply: reply_tx,
            })
            .context("failed to queue terminal history-range request")?;
        reply_rx
            .recv()
            .context("terminal worker dropped the history-range reply")
    }

    pub fn set_frontend_active(&self, terminal_id: TerminalId, active: bool) -> Result<()> {
        // Mirror the on-screen terminal into shared state so the reaper can read
        // it. Setting active marks this terminal foreground; clearing only
        // clears if this terminal is still the recorded foreground, so a stale
        // deactivate cannot wipe a newer activation.
        if let Ok(mut foreground) = self.foreground_terminal.lock() {
            if active {
                *foreground = Some(terminal_id);
            } else if *foreground == Some(terminal_id) {
                *foreground = None;
            }
        }
        self.command_sender_for(terminal_id)?
            .send(TerminalRuntimeCommand::SetFrontendActive(active))
            .context("failed to queue terminal frontend-priority command")
    }

    /// The terminal the user is currently viewing, if any. Read by the reaper to
    /// protect the on-screen session from being reaped.
    pub fn foreground_terminal(&self) -> Option<TerminalId> {
        self.foreground_terminal
            .lock()
            .ok()
            .and_then(|guard| *guard)
    }

    pub fn terminate_session(&self, terminal_id: TerminalId) -> Result<()> {
        self.controller_for(terminal_id)?.terminate()
    }

    /// Gracefully terminate every live terminal whose product session id matches,
    /// returning the terminal ids that were signalled. This is the authoritative
    /// reap path for close/archive, delete, and relaunch: the backend owns the
    /// process, so stopping it must not depend on the webview still holding a
    /// terminal id. A frontend HMR/store reset or cold reload drops those
    /// bindings, and a crash skips the graceful shutdown, both of which otherwise
    /// strand the agent (and anything it spawned) running. The stream worker's
    /// exit path then removes the controller and persists the session as finished.
    pub fn terminate_for_session(&self, session_id: SessionId) -> Vec<TerminalId> {
        let terminal_ids: Vec<TerminalId> = match self.sessions.lock() {
            Ok(sessions) => sessions
                .values()
                .filter(|record| record.session_id == Some(session_id))
                .map(|record| record.terminal_id)
                .collect(),
            Err(_) => return Vec::new(),
        };
        let mut terminated = Vec::new();
        for terminal_id in terminal_ids {
            if let Ok(controller) = self.controller_for(terminal_id) {
                if controller.terminate().is_ok() {
                    terminated.push(terminal_id);
                }
            }
        }
        terminated
    }

    /// Gracefully terminate every live session's process tree on app shutdown.
    /// SIGTERMs all groups first, waits once for a shared grace period, then
    /// SIGKILLs any stragglers, so quitting does not orphan the agents or
    /// anything they spawned. Returns the product session ids that were live so
    /// the caller can persist them as finished/restorable.
    pub fn shutdown_all(&self) -> Vec<SessionId> {
        let live: Vec<(TerminalId, PtyController)> = match self.controllers.lock() {
            Ok(map) => map.iter().map(|(id, c)| (*id, c.clone())).collect(),
            Err(_) => return Vec::new(),
        };
        if live.is_empty() {
            return Vec::new();
        }
        // Resolve product session ids before killing anything.
        let session_ids: Vec<SessionId> = match self.sessions.lock() {
            Ok(sessions) => live
                .iter()
                .filter_map(|(id, _)| sessions.get(id).and_then(|record| record.session_id))
                .collect(),
            Err(_) => Vec::new(),
        };
        for (_, controller) in &live {
            controller.request_terminate();
        }
        std::thread::sleep(SHUTDOWN_GRACE);
        for (_, controller) in &live {
            let _ = controller.terminate_now();
        }
        session_ids
    }

    /// Immediately SIGKILL every live session's process tree with no grace.
    /// Final app-exit backstop for a wedged/closed webview that never drove the
    /// graceful path.
    pub fn kill_all_now(&self) {
        let controllers: Vec<PtyController> = match self.controllers.lock() {
            Ok(map) => map.values().cloned().collect(),
            Err(_) => return,
        };
        for controller in controllers {
            let _ = controller.terminate_now();
        }
    }

    fn run_stream_worker(&self, app: AppHandle, request: TerminalStreamRequest) -> Result<()> {
        let spec = request.spawn_spec;
        let launch_started_ms = unix_time_millis();
        let mut terminal = GhosttyTerminalState::new(spec.cols, spec.rows)?;
        // Seed the terminal's default colors from the active theme before any
        // PTY output arrives, so default-colored cells + the base background
        // match the shell instead of Ghostty's hardwired white-on-black.
        let theme = self.default_colors();
        terminal.set_default_colors(theme.foreground, theme.background);
        let process = PtyProcess::spawn(request.terminal_id, &spec)
            .context("failed to spawn terminal session PTY process")?;
        let (reader, controller) = process.split();
        let (read_tx, read_rx) = mpsc::channel();
        spawn_pty_reader_thread(request.terminal_id, reader, read_tx)?;
        let (command_tx, command_rx) = mpsc::channel();
        let response_controller = controller.clone();
        terminal.on_pty_write(move |data| {
            let _ = response_controller.write_input(data);
        })?;
        self.register_controller(request.terminal_id, controller)?;
        self.register_command_sender(request.terminal_id, command_tx)?;

        self.mark_running(request.terminal_id)?;
        persist_shell_session_running(&app, request.session_id);
        // Launch-time native-session capture: poll the adapter's on-disk state
        // for a few seconds so the session binds its native ref (and its live
        // activity) as soon as the CLI has written its session file, instead of
        // only at exit. This brings file-watched adapters (Cortex, Codex) to
        // parity with the Claude hook path, which binds live immediately. Runs
        // off-thread and is best-effort; exit-time capture stays the backstop.
        spawn_launch_capture_poll(
            app.clone(),
            request.session_id,
            request.agent_kind,
            launch_started_ms,
        );
        let started_payload = TerminalStreamStarted {
            label: "PTY -> Ghostty -> Tauri terminal stream",
            session_id: request.session_id,
            terminal_id: request.terminal_id,
            cols: spec.cols,
            rows: spec.rows,
            target_frames: request.target_frames,
        };
        app.emit("session_status_changed", started_payload.clone())?;
        app.emit("terminal_stream_started", started_payload)?;

        let started = Instant::now();
        // When the PTY last produced bytes. Pushed to the session record on each
        // frame emit so the reaper can tell a busy session from an idle one.
        let mut last_output_at = Instant::now();
        let mut bytes_read = 0_usize;
        let mut bytes_rendered = 0_usize;
        let mut chunks_read = 0_usize;
        let mut frames_emitted = 0_usize;
        let mut total_emit_ms = 0_f64;
        let mut max_emit_ms = 0_f64;
        let mut pending_frame = false;
        let mut last_frame_emit = Instant::now()
            .checked_sub(TERMINAL_FRAME_INTERVAL)
            .unwrap_or_else(Instant::now);
        let mut sync_output_started_at = None;
        let mut viewport_state = TerminalViewportState {
            frontend_active: true,
        };
        // Live session title: apply this CLI's OSC-title rule and push label
        // changes up to the frontend. Only for real product sessions with a
        // known CLI (the bench/proof path has neither, so it skips this).
        let title_ctx = match (request.session_id, request.agent_kind) {
            (Some(session_id), Some(agent_kind)) => Some(TitleContext {
                session_id,
                terminal_id: request.terminal_id,
                agent_kind,
                folder_name: request.folder_name.clone().unwrap_or_default(),
            }),
            _ => None,
        };
        let mut last_raw_title: Option<String> = None;
        let mut last_emitted_title: Option<String> = None;
        // Per-session frame generation, starting at 1. A resize bumps it (the
        // VT then reflows scrollback and renumbers rows); the very next frame is
        // a Full snapshot carrying the new generation, which the frontend adopts
        // and rebuilds from. See `wire-protocol.md` (generation rules).
        let mut generation: u32 = 1;
        let frame_channel = request.frame_channel.as_ref();
        let child_success = loop {
            // Drains resize/read-rows/theme/active commands. Resizes bump the
            // shared `generation` in place (so a history-range reply drained after
            // a resize is stamped with the post-resize generation), and history
            // bands are served inline on this worker thread.
            let applied = apply_terminal_commands(
                request.terminal_id,
                &command_rx,
                &mut terminal,
                &mut viewport_state,
                &mut generation,
            )?;
            if applied.needs_frame {
                pending_frame = true;
            }

            if terminal_frame_ready(
                pending_frame,
                last_frame_emit,
                &viewport_state,
                &terminal,
                &mut sync_output_started_at,
                Instant::now(),
            )? {
                let emit_ms = send_terminal_frame(frame_channel, generation, &mut terminal)?;
                total_emit_ms += emit_ms;
                max_emit_ms = max_emit_ms.max(emit_ms);
                frames_emitted += 1;
                self.update_progress(
                    request.terminal_id,
                    frames_emitted,
                    bytes_rendered,
                    last_output_at,
                )?;
                pending_frame = false;
                last_frame_emit = Instant::now();
            }

            match read_rx.recv_timeout(Duration::from_millis(4)) {
                Ok(PtyReadEvent::Chunk(chunk)) => {
                    let PtyReadBatch {
                        bytes,
                        chunks,
                        deferred_event,
                    } = drain_pty_read_batch(chunk, &read_rx)?;
                    chunks_read += chunks;
                    bytes_read += bytes.len();
                    bytes_rendered += bytes.len();
                    last_output_at = Instant::now();

                    terminal.write(&bytes);
                    // A title only changes as a side effect of program output,
                    // so poll it right after the VT write (deduped internally).
                    if let Some(ctx) = &title_ctx {
                        poll_session_title(
                            &app,
                            ctx,
                            &terminal,
                            &mut last_raw_title,
                            &mut last_emitted_title,
                        );
                    }
                    // Always keep the pin on the active tail before the next live
                    // extract: scrolling is frontend-driven (D6), so the live
                    // stream emits the tail unconditionally and the frontend
                    // decides whether the tail is on screen. A `read_rows` serve
                    // restores the pin too, so this stays correct after a serve.
                    terminal.scroll_bottom();
                    pending_frame = true;
                    if let Some(deferred_event) = deferred_event {
                        match deferred_event {
                            DeferredPtyReadEvent::Exited { child_success } => {
                                break child_success;
                            }
                            DeferredPtyReadEvent::Failed(message) => bail!(message),
                        }
                    }
                }
                Ok(PtyReadEvent::Exited { child_success }) => break child_success,
                Ok(PtyReadEvent::Failed(message)) => bail!(message),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    bail!("terminal reader disconnected before reporting process exit")
                }
            }

            // Gate on `pending_frame` so an idle terminal (no new PTY output and
            // no applied commands) never emits. Without this guard the loop ships
            // a full grid frame every TERMINAL_FRAME_INTERVAL forever, per session.
            if terminal_frame_ready(
                pending_frame,
                last_frame_emit,
                &viewport_state,
                &terminal,
                &mut sync_output_started_at,
                Instant::now(),
            )? {
                let emit_ms = send_terminal_frame(frame_channel, generation, &mut terminal)?;
                total_emit_ms += emit_ms;
                max_emit_ms = max_emit_ms.max(emit_ms);
                frames_emitted += 1;
                self.update_progress(
                    request.terminal_id,
                    frames_emitted,
                    bytes_rendered,
                    last_output_at,
                )?;
                pending_frame = false;
                last_frame_emit = Instant::now();
            }
        };

        if pending_frame {
            let emit_ms = send_terminal_frame(frame_channel, generation, &mut terminal)?;
            total_emit_ms += emit_ms;
            max_emit_ms = max_emit_ms.max(emit_ms);
            frames_emitted += 1;
            self.update_progress(
                request.terminal_id,
                frames_emitted,
                bytes_rendered,
                last_output_at,
            )?;
        }

        let avg_emit_ms = if frames_emitted == 0 {
            0.0
        } else {
            total_emit_ms / frames_emitted as f64
        };
        let finished = TerminalExitEvent {
            label: "PTY -> Ghostty -> Tauri terminal stream",
            session_id: request.session_id,
            terminal_id: request.terminal_id,
            frames_emitted,
            chunks_read,
            bytes_read,
            rust_elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            total_emit_ms,
            avg_emit_ms,
            max_emit_ms,
            child_success,
        };

        self.remove_controller(request.terminal_id);
        self.register_exited(
            request.terminal_id,
            frames_emitted,
            bytes_read,
            child_success,
        )?;
        persist_native_session_after_launch(
            &app,
            request.session_id,
            request.agent_kind,
            launch_started_ms,
        );
        persist_shell_session_finished(&app, request.session_id, child_success);
        app.emit("terminal_exit", finished.clone())?;
        app.emit("session_status_changed", finished)?;

        Ok(())
    }

    fn register_starting(&self, request: &TerminalStreamRequest) -> Result<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal runtime session map is poisoned"))?;
        sessions.insert(
            request.terminal_id,
            TerminalSessionRecord {
                session_id: request.session_id,
                terminal_id: request.terminal_id,
                title: request.spawn_spec.title.clone(),
                cols: request.spawn_spec.cols,
                rows: request.spawn_spec.rows,
                status: TerminalRuntimeStatus::Starting,
                frames_emitted: 0,
                bytes_read: 0,
                last_exit_success: None,
                last_output_at: Instant::now(),
                last_active_at: Instant::now(),
            },
        );
        Ok(())
    }

    fn register_controller(
        &self,
        terminal_id: TerminalId,
        controller: PtyController,
    ) -> Result<()> {
        self.controllers
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal runtime controller map is poisoned"))?
            .insert(terminal_id, controller);
        Ok(())
    }

    fn register_command_sender(
        &self,
        terminal_id: TerminalId,
        sender: Sender<TerminalRuntimeCommand>,
    ) -> Result<()> {
        self.command_senders
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal runtime command map is poisoned"))?
            .insert(terminal_id, sender);
        Ok(())
    }

    fn remove_controller(&self, terminal_id: TerminalId) {
        if let Ok(mut controllers) = self.controllers.lock() {
            controllers.remove(&terminal_id);
        }
        if let Ok(mut command_senders) = self.command_senders.lock() {
            command_senders.remove(&terminal_id);
        }
        if let Ok(mut foreground) = self.foreground_terminal.lock() {
            if *foreground == Some(terminal_id) {
                *foreground = None;
            }
        }
    }

    fn controller_for(&self, terminal_id: TerminalId) -> Result<PtyController> {
        self.controllers
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal runtime controller map is poisoned"))?
            .get(&terminal_id)
            .cloned()
            .with_context(|| format!("terminal session {terminal_id} has no live PTY controller"))
    }

    fn command_sender_for(
        &self,
        terminal_id: TerminalId,
    ) -> Result<Sender<TerminalRuntimeCommand>> {
        self.command_senders
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal runtime command map is poisoned"))?
            .get(&terminal_id)
            .cloned()
            .with_context(|| {
                format!("terminal session {terminal_id} has no live terminal command channel")
            })
    }

    fn mark_running(&self, terminal_id: TerminalId) -> Result<()> {
        self.update_record(terminal_id, |record| {
            record.status = TerminalRuntimeStatus::Running;
        })
    }

    fn update_progress(
        &self,
        terminal_id: TerminalId,
        frames_emitted: usize,
        bytes_read: usize,
        last_output_at: Instant,
    ) -> Result<()> {
        self.update_record(terminal_id, |record| {
            record.frames_emitted = frames_emitted;
            record.bytes_read = bytes_read;
            record.last_output_at = last_output_at;
        })
    }

    fn register_exited(
        &self,
        terminal_id: TerminalId,
        frames_emitted: usize,
        bytes_read: usize,
        child_success: bool,
    ) -> Result<()> {
        self.update_record(terminal_id, |record| {
            record.status = TerminalRuntimeStatus::Exited;
            record.frames_emitted = frames_emitted;
            record.bytes_read = bytes_read;
            record.last_exit_success = Some(child_success);
        })
    }

    fn register_failed(&self, terminal_id: TerminalId) {
        let _ = self.update_record(terminal_id, |record| {
            record.status = TerminalRuntimeStatus::Failed;
            record.last_exit_success = Some(false);
        });
    }

    fn update_record(
        &self,
        terminal_id: TerminalId,
        update: impl FnOnce(&mut TerminalSessionRecord),
    ) -> Result<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal runtime session map is poisoned"))?;
        let record = sessions
            .get_mut(&terminal_id)
            .with_context(|| format!("terminal session {terminal_id} is not registered"))?;
        update(record);
        Ok(())
    }
}

/// Encode the terminal's current frame as binary (stamped with the session's
/// `generation`) and push it over the per-session frame Channel. Returns the
/// time spent encoding + sending, for the worker's emit-timing diagnostics.
///
/// The Channel preserves message boundaries and order, so each call delivers
/// exactly one frame message to the WebView as an `ArrayBuffer`. Lifecycle and
/// control events stay JSON `app.emit`; only the frame stream is binary here.
fn send_terminal_frame(
    frame_channel: Option<&Channel<InvokeResponseBody>>,
    generation: u32,
    terminal: &mut GhosttyTerminalState<'_, '_>,
) -> Result<f64> {
    let frame = terminal.frame()?;
    let emit_started = Instant::now();
    if let Some(channel) = frame_channel {
        let bytes = encode_frame(&frame, generation);
        channel
            .send(InvokeResponseBody::Raw(bytes))
            .context("failed to send terminal frame over channel")?;
    }
    Ok(emit_started.elapsed().as_secs_f64() * 1000.0)
}

fn drain_pty_read_batch(
    first_chunk: Vec<u8>,
    receiver: &Receiver<PtyReadEvent>,
) -> Result<PtyReadBatch> {
    let mut bytes = first_chunk;
    let mut chunks = 1;
    let mut deferred_event = None;

    while chunks < PTY_DRAIN_MAX_CHUNKS && bytes.len() < PTY_DRAIN_MAX_BYTES {
        match receiver.try_recv() {
            Ok(PtyReadEvent::Chunk(chunk)) => {
                chunks += 1;
                bytes.extend_from_slice(&chunk);
            }
            Ok(PtyReadEvent::Exited { child_success }) => {
                deferred_event = Some(DeferredPtyReadEvent::Exited { child_success });
                break;
            }
            Ok(PtyReadEvent::Failed(message)) => {
                deferred_event = Some(DeferredPtyReadEvent::Failed(message));
                break;
            }
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => {
                bail!("terminal reader disconnected before reporting process exit")
            }
        }
    }

    Ok(PtyReadBatch {
        bytes,
        chunks,
        deferred_event,
    })
}

fn spawn_pty_reader_thread(
    terminal_id: TerminalId,
    mut reader: reverie_core::pty::PtyReader,
    sender: Sender<PtyReadEvent>,
) -> Result<()> {
    thread::Builder::new()
        .name(format!("reverie-pty-reader-{terminal_id}"))
        .spawn(move || {
            let result = (|| -> Result<()> {
                let mut buf = [0_u8; READ_BUFFER_BYTES];
                loop {
                    let read = reader.read_chunk(&mut buf)?;
                    if read == 0 {
                        break;
                    }
                    if sender
                        .send(PtyReadEvent::Chunk(buf[..read].to_vec()))
                        .is_err()
                    {
                        return Ok(());
                    }
                }

                let status = reader.wait()?;
                let _ = sender.send(PtyReadEvent::Exited {
                    child_success: status.success(),
                });
                Ok(())
            })();

            if let Err(error) = result {
                let _ = sender.send(PtyReadEvent::Failed(error.to_string()));
            }
        })
        .context("failed to spawn terminal reader thread")?;
    Ok(())
}

/// Result of draining the worker's command queue for one loop iteration. The
/// session generation is bumped in place on resize (see `apply_terminal_commands`),
/// so this only reports whether a frame should be emitted afterward.
#[derive(Clone, Copy, Debug, Default)]
struct AppliedCommands {
    needs_frame: bool,
}

fn apply_terminal_commands(
    terminal_id: TerminalId,
    receiver: &Receiver<TerminalRuntimeCommand>,
    terminal: &mut GhosttyTerminalState<'_, '_>,
    viewport_state: &mut TerminalViewportState,
    generation: &mut u32,
) -> Result<AppliedCommands> {
    let mut applied = AppliedCommands::default();

    while let Ok(command) = receiver.try_recv() {
        match command {
            TerminalRuntimeCommand::Resize { cols, rows } => {
                terminal.resize(cols, rows)?;
                // Reflow renumbers rows, so bump the generation immediately; the
                // forced Full frame that follows carries the new generation, and
                // a history-range request drained after this resize is served at
                // (and tagged with) the post-resize generation.
                *generation = generation.saturating_add(1);
                applied.needs_frame = true;
            }
            TerminalRuntimeCommand::ReadRows {
                start_id,
                count,
                generation: requested_generation,
                reply,
            } => {
                // Map the requested stable id to a buffer position using the live
                // floor (oldest_id = lines_evicted): below the cap oldest_id is 0
                // so id == position; a requested id below the floor (its row has
                // evicted) clamps to position 0, the oldest still-buffered row.
                let oldest_id = terminal.oldest_id();
                let start = start_id.saturating_sub(oldest_id) as usize;
                // Serve the band only if the frontend's generation still matches
                // the live one; a resize the frontend has not seen yet renumbers
                // rows, so an old-generation request is answered with an empty
                // band (the frontend re-seeds and re-requests against the new
                // generation). The reply is always stamped with the live
                // generation so the frontend can re-check on receipt.
                let rows = if requested_generation == *generation {
                    // A read error must NOT kill the worker (that would take the
                    // whole session down over a transient scroll-back read). Log
                    // it and serve an empty band, which the `read_terminal_rows`
                    // caller receives normally and the frontend re-requests.
                    // `read_rows` already restores the viewport pin even on error.
                    match terminal.read_rows(start, count) {
                        Ok(rows) => rows,
                        Err(error) => {
                            eprintln!(
                                "[reverie-terminal] read_rows failed for terminal {terminal_id} \
                                 (start_id={start_id}, count={count}): {error}"
                            );
                            Vec::new()
                        }
                    }
                } else {
                    Vec::new()
                };
                // Echo the ACTUAL served start id (= served position + floor): a
                // request whose id fell below the floor is keyed by the frontend
                // at the floor, not at its (now evicted) requested id.
                let served_start_id = oldest_id.saturating_add(start as u64);
                let band = encode_row_band(&rows, *generation, served_start_id);
                // The requester may have given up (dropped the receiver); ignore
                // a send error rather than failing the worker.
                let _ = reply.send(band);
            }
            TerminalRuntimeCommand::SetDefaultColors {
                foreground,
                background,
            } => {
                terminal.set_default_colors(foreground, background);
                applied.needs_frame = true;
            }
            TerminalRuntimeCommand::SetFrontendActive(active) => {
                viewport_state.frontend_active = active;
            }
        }
    }

    Ok(applied)
}

fn terminal_frame_interval(state: &TerminalViewportState) -> Duration {
    if state.frontend_active {
        TERMINAL_FRAME_INTERVAL
    } else {
        BACKGROUND_TERMINAL_FRAME_INTERVAL
    }
}

fn terminal_frame_due(
    pending_frame: bool,
    last_frame_emit: Instant,
    state: &TerminalViewportState,
    now: Instant,
) -> bool {
    pending_frame
        && now.saturating_duration_since(last_frame_emit) >= terminal_frame_interval(state)
}

fn terminal_frame_ready(
    pending_frame: bool,
    last_frame_emit: Instant,
    state: &TerminalViewportState,
    terminal: &GhosttyTerminalState<'_, '_>,
    sync_output_started_at: &mut Option<Instant>,
    now: Instant,
) -> Result<bool> {
    if !terminal_frame_due(pending_frame, last_frame_emit, state, now) {
        return Ok(false);
    }

    if terminal.sync_output_mode()? {
        let started_at = sync_output_started_at.get_or_insert(now);
        if now.saturating_duration_since(*started_at) < SYNC_OUTPUT_FRAME_TIMEOUT {
            return Ok(false);
        }
        *sync_output_started_at = Some(now);
        return Ok(true);
    }

    *sync_output_started_at = None;
    Ok(true)
}

fn panic_payload_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        format!("terminal worker panicked: {message}")
    } else if let Some(message) = payload.downcast_ref::<String>() {
        format!("terminal worker panicked: {message}")
    } else {
        "terminal worker panicked".to_owned()
    }
}

fn persist_native_session_after_launch(
    app: &AppHandle,
    session_id: Option<SessionId>,
    agent_kind: Option<AgentKind>,
    launch_started_ms: i64,
) {
    if let Some((service, session_id)) = workspace_service(app, session_id) {
        // Adapter-driven discovery: the service resolves the session's adapter
        // and attaches a native ref if one is found. We pass the CLI home that
        // matches this session's adapter so each scanner looks in the right
        // place (Cortex `~/.cortex`, Claude `~/.claude`, Codex `~/.codex`). This
        // is the exit-time backstop; the launch-time poll usually wins first.
        let _ = service.discover_and_attach_native_session(
            session_id,
            Some(launch_started_ms),
            agent_home_dir(agent_kind),
        );
        // A file-transport session's live-state file stops changing once the
        // process exits, so stop tailing it (the launch poll re-registers it on
        // resume). Claude uses hooks, so it has nothing registered to drop.
        if agent_kind.is_some_and(is_file_transport) {
            unregister_active_file_watch(app, &service, session_id);
        }
    }
}

/// Register a file-transport session's live-state file with the session-log
/// watcher so its changes are folded into activity. Codex (rollout) and Cortex
/// (snapshot) both flow through the one engine; Claude uses hooks, not a file.
/// No-op when the watcher control or the session's watch path is not available.
fn register_active_file_watch(
    app: &AppHandle,
    service: &WorkspaceService,
    session_id: SessionId,
    agent_kind: AgentKind,
) {
    if !is_file_transport(agent_kind) {
        return;
    }
    let Some(control) = app.try_state::<SessionLogControl>() else {
        return;
    };
    if let Some(path) = session_watch_path(service, session_id) {
        control.register(path);
    }
}

/// Stop tailing a file-transport session's live-state file.
fn unregister_active_file_watch(
    app: &AppHandle,
    service: &WorkspaceService,
    session_id: SessionId,
) {
    let Some(control) = app.try_state::<SessionLogControl>() else {
        return;
    };
    if let Some(path) = session_watch_path(service, session_id) {
        control.unregister(path);
    }
}

/// Whether a CLI reports live state through a watched file (vs. push hooks).
fn is_file_transport(agent_kind: AgentKind) -> bool {
    matches!(agent_kind, AgentKind::CodexCli | AgentKind::CortexCode)
}

/// The on-disk file the session-log engine should watch for a session, if any.
fn session_watch_path(service: &WorkspaceService, session_id: SessionId) -> Option<PathBuf> {
    let reference = service
        .snapshot()
        .ok()?
        .sessions
        .into_iter()
        .find(|session| session.id == session_id)?
        .native_session_ref?;
    watch_path_for_ref(&reference)
}

/// Derive the live-state file to watch from a session's native ref. Codex points
/// its `metadata_path` straight at the rollout file; Cortex's points at
/// `meta.json`, so we derive the sibling `activity/state.json` snapshot. Claude
/// uses hooks, so it has no watched file.
pub(crate) fn watch_path_for_ref(reference: &NativeSessionRef) -> Option<PathBuf> {
    let metadata_path = reference.metadata_path.as_ref()?;
    match reference.kind {
        AgentKind::CodexCli => Some(metadata_path.clone()),
        AgentKind::CortexCode => Some(metadata_path.parent()?.join("activity").join("state.json")),
        AgentKind::ClaudeCode => None,
    }
}

/// Launch-time native-session capture timing. We poll frequently at first
/// (Cortex writes its `state.json` and Claude fires its SessionStart hook
/// immediately), then back off and keep trying for several minutes, because
/// Codex flushes its rollout file lazily: often a minute or more into the
/// session, when its first turn completes (observed gaps of 3s to 20min between
/// session start and the `session_meta` record being written). A short fixed
/// window would miss Codex entirely, so its native ref would never be captured
/// and resume would fall back to a brand-new session. We stop early once
/// captured; the exit-time backstop is the final catch.
const LAUNCH_CAPTURE_INITIAL_INTERVAL: Duration = Duration::from_millis(500);
const LAUNCH_CAPTURE_MAX_INTERVAL: Duration = Duration::from_secs(5);
const LAUNCH_CAPTURE_TOTAL_WAIT: Duration = Duration::from_secs(300);

/// Poll adapter-driven native-session discovery for a short window after launch
/// so a session binds its native ref (and the dashboard binds its live activity)
/// as soon as the CLI has written its session file, rather than only at exit.
///
/// No-op for the bench/proof path (no session) and for adapters without
/// filesystem discovery. Best-effort and off the worker thread. The capture is
/// idempotent: whoever wins first (this poll, the Claude hook, or exit-time
/// discovery) attaches the ref, and the rest become no-ops.
fn spawn_launch_capture_poll(
    app: AppHandle,
    session_id: Option<SessionId>,
    agent_kind: Option<AgentKind>,
    launch_started_ms: i64,
) {
    let (Some(session_id), Some(agent_kind)) = (session_id, agent_kind) else {
        return;
    };
    let Some(agent_home) = agent_home_dir(Some(agent_kind)) else {
        return;
    };

    thread::spawn(move || {
        let mut waited = Duration::ZERO;
        let mut interval = LAUNCH_CAPTURE_INITIAL_INTERVAL;
        while waited < LAUNCH_CAPTURE_TOTAL_WAIT {
            thread::sleep(interval);
            waited += interval;
            // Back off after the initial burst so a long-lived ref-less session
            // costs only an occasional cheap discovery scan.
            interval = interval.saturating_mul(2).min(LAUNCH_CAPTURE_MAX_INTERVAL);

            let Some((service, session_id)) = workspace_service(&app, Some(session_id)) else {
                return;
            };
            match service.discover_and_attach_native_session(
                session_id,
                Some(launch_started_ms),
                Some(agent_home.clone()),
            ) {
                // Captured this iteration: tell the frontend to refetch so it
                // binds the now-live session, register the live-state watch, then
                // stop polling.
                Ok(true) => {
                    let _ = app.emit("session_record_changed", ());
                    register_active_file_watch(&app, &service, session_id, agent_kind);
                    return;
                }
                // The ref already exists (a resume, or a prior poll iteration
                // won). Still ensure the live-state watch is attached, then stop.
                // Otherwise the CLI has not written its file yet -> keep waiting.
                Ok(false) => {
                    if session_native_ref_present(&service, session_id) {
                        register_active_file_watch(&app, &service, session_id, agent_kind);
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });
}

/// Whether the session already carries a native ref (so launch-capture polling
/// should stop). A missing session also stops the poll.
fn session_native_ref_present(service: &WorkspaceService, session_id: SessionId) -> bool {
    service
        .snapshot()
        .ok()
        .and_then(|snapshot| {
            snapshot
                .sessions
                .into_iter()
                .find(|session| session.id == session_id)
        })
        .map(|session| session.native_session_ref.is_some())
        .unwrap_or(true)
}

/// Resolve the CLI home directory whose on-disk session records the adapter for
/// `agent_kind` knows how to scan. Returns `None` when the kind has no
/// filesystem discovery wired (Codex capture lands with the rollout watcher).
fn agent_home_dir(agent_kind: Option<AgentKind>) -> Option<PathBuf> {
    match agent_kind {
        Some(AgentKind::CortexCode) => cortex_home_dir(),
        Some(AgentKind::ClaudeCode) => claude_home_dir(),
        Some(AgentKind::CodexCli) => codex_home_dir(),
        None => None,
    }
}

fn persist_shell_session_running(app: &AppHandle, session_id: Option<SessionId>) {
    if let Some((service, session_id)) = workspace_service(app, session_id) {
        let _ = service.mark_session_running(session_id);
    }
}

fn persist_shell_session_finished(
    app: &AppHandle,
    session_id: Option<SessionId>,
    child_success: bool,
) {
    if let Some((service, session_id)) = workspace_service(app, session_id) {
        let _ = service.mark_session_finished(session_id, child_success);
    }
}

fn persist_shell_session_failed(app: &AppHandle, session_id: Option<SessionId>) {
    if let Some((service, session_id)) = workspace_service(app, session_id) {
        let _ = service.mark_session_failed(session_id);
    }
}

/// The per-session context the worker needs to turn raw OSC titles into live
/// session labels. Built once per launch for real product sessions only.
struct TitleContext {
    session_id: SessionId,
    terminal_id: TerminalId,
    agent_kind: AgentKind,
    folder_name: String,
}

/// Poll the terminal's current OSC title and, if it has changed into a new
/// meaningful label, persist then emit it. Deduped twice: on the raw title (it
/// re-emits with every output chunk) and on the normalized label (so a CLI's
/// spinner churn that normalizes to the same text never re-fires). A normalized
/// result of `None` (the CLI's default or pure decoration) is left as a no-op so
/// a good label is sticky and never reverts.
fn poll_session_title(
    app: &AppHandle,
    ctx: &TitleContext,
    terminal: &GhosttyTerminalState<'_, '_>,
    last_raw: &mut Option<String>,
    last_emitted: &mut Option<String>,
) {
    let Some(raw) = terminal.title() else {
        return;
    };
    if last_raw.as_deref() == Some(raw.as_str()) {
        return;
    }
    *last_raw = Some(raw.clone());

    let Some(display) = derive_session_title(ctx.agent_kind, &raw, &ctx.folder_name) else {
        return;
    };
    if last_emitted.as_deref() == Some(display.as_str()) {
        return;
    }
    *last_emitted = Some(display.clone());

    // Persist before emitting: a snapshot refetch triggered around launch then
    // can only observe the new title, never revert the live label to a stale one.
    persist_session_title(app, ctx.session_id, display.clone());
    let _ = app.emit(
        "terminal_title_changed",
        TerminalTitleChangedEvent {
            session_id: ctx.session_id,
            terminal_id: ctx.terminal_id,
            title: display,
        },
    );
}

fn persist_session_title(app: &AppHandle, session_id: SessionId, title: String) {
    if let Some((service, session_id)) = workspace_service(app, Some(session_id)) {
        // TODO(bridge): the inter-agent connection registers SessionAddress with
        // the title captured at spawn; a live title change leaves that peer-facing
        // label stale. A correct refresh needs a secret-preserving
        // ConnectionService::update_session_address (naive re-register rotates the
        // live session secret). Deferred: cosmetic, Unix-only.
        let _ = service.set_session_title(session_id, title);
    }
}

fn workspace_service(
    app: &AppHandle,
    session_id: Option<SessionId>,
) -> Option<(tauri::State<'_, WorkspaceService>, SessionId)> {
    Some((app.try_state::<WorkspaceService>()?, session_id?))
}

fn cortex_home_dir() -> Option<PathBuf> {
    env::var_os("CORTEX_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".cortex")))
}

// Locate where Claude actually stores its transcripts, mirroring `cortex_home_dir`.
// We honor `CLAUDE_CONFIG_DIR` on purpose: the PTY spawn inherits this process's
// env (no `env_clear`), so when the user has it set, the spawned `claude` writes
// its `projects/` transcripts there, and the scanner must look in the same place.
// This is discovery only; Reverie still never *sets* `CLAUDE_CONFIG_DIR` on a
// spawn (that would redirect the credential home), which `assert_safe_cli_env`
// enforces. When the var is unset, both sides fall back to `~/.claude`.
fn claude_home_dir() -> Option<PathBuf> {
    env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude")))
}

fn codex_home_dir() -> Option<PathBuf> {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))
}

fn unix_time_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

#[cfg(test)]
fn terminal_frame_segments(chunk: &[u8], max_segment_bytes: usize) -> Vec<&[u8]> {
    if chunk.is_empty() {
        return Vec::new();
    }

    let max_segment_bytes = max_segment_bytes.max(1);
    let mut segments = Vec::new();
    let mut start = 0_usize;

    for index in 0..chunk.len() {
        let byte = chunk[index];
        let line_break = byte == b'\n' || (byte == b'\r' && chunk.get(index + 1) != Some(&b'\n'));
        let too_large = index + 1 - start >= max_segment_bytes;

        if line_break || too_large {
            segments.push(&chunk[start..=index]);
            start = index + 1;
        }
    }

    if start < chunk.len() {
        segments.push(&chunk[start..]);
    }

    segments
}

#[cfg(test)]
mod tests {
    use super::*;
    use reverie_core::CommandSpec;

    #[test]
    fn runtime_registers_session_metadata_before_stream_starts() {
        let runtime = TerminalSessionRuntime::default();
        let terminal_id = TerminalId::new_v4();
        let cwd = std::env::current_dir().unwrap();
        let request = TerminalStreamRequest {
            session_id: None,
            terminal_id,
            spawn_spec: TerminalSpawnSpec {
                command: CommandSpec::new("/bin/echo", cwd),
                cols: 100,
                rows: 24,
                title: Some("Test terminal".to_owned()),
            },
            target_frames: Some(1),
            agent_kind: None,
            folder_name: None,
            frame_channel: None,
        };

        runtime.register_starting(&request).unwrap();
        let records = runtime.list_sessions().unwrap();

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].terminal_id, terminal_id);
        assert_eq!(records[0].cols, 100);
        assert_eq!(records[0].rows, 24);
        assert_eq!(records[0].status, TerminalRuntimeStatus::Starting);
    }

    #[test]
    fn runtime_rejects_control_commands_for_unknown_terminal() {
        let runtime = TerminalSessionRuntime::default();
        let terminal_id = TerminalId::new_v4();

        let input_error = runtime.write_input(terminal_id, b"hello").unwrap_err();
        let resize_error = runtime.resize_terminal(terminal_id, 120, 32).unwrap_err();
        let read_rows_error = runtime
            .read_terminal_rows(terminal_id, 0, 10, 1)
            .unwrap_err();
        let terminate_error = runtime.terminate_session(terminal_id).unwrap_err();

        assert!(
            input_error
                .to_string()
                .contains("has no live PTY controller")
        );
        assert!(
            resize_error
                .to_string()
                .contains("has no live PTY controller")
        );
        assert!(
            terminate_error
                .to_string()
                .contains("has no live PTY controller")
        );
        // A history-range request for an unknown terminal fails at the command
        // channel lookup (there is no worker to serve it).
        assert!(
            read_rows_error
                .to_string()
                .contains("has no live terminal command channel")
        );
    }

    #[test]
    fn runtime_rejects_zero_sized_resize_before_touching_controller() {
        let runtime = TerminalSessionRuntime::default();
        let terminal_id = TerminalId::new_v4();

        let error = runtime.resize_terminal(terminal_id, 0, 32).unwrap_err();

        assert!(error.to_string().contains("non-zero cols and rows"));
    }

    #[test]
    fn read_rows_command_serves_a_decodable_band_at_the_current_generation() {
        use crate::terminal::wire::decode_row_band;

        let (sender, receiver) = mpsc::channel();
        let mut terminal = GhosttyTerminalState::new(10, 3).unwrap();
        let mut viewport_state = TerminalViewportState {
            frontend_active: true,
        };
        let mut generation: u32 = 1;

        for index in 1..=20 {
            terminal.write(format!("L{index:02}\r\n").as_bytes());
        }
        terminal.scroll_bottom();
        let _ = terminal.frame().unwrap();

        let (reply_tx, reply_rx) = mpsc::channel();
        sender
            .send(TerminalRuntimeCommand::ReadRows {
                start_id: 0,
                count: 4,
                generation: 1,
                reply: reply_tx,
            })
            .unwrap();
        let applied = apply_terminal_commands(
            TerminalId::new_v4(),
            &receiver,
            &mut terminal,
            &mut viewport_state,
            &mut generation,
        )
        .unwrap();
        // Serving a band is not a paint-triggering command.
        assert!(!applied.needs_frame);

        let band_bytes = reply_rx.recv().unwrap();
        let band = decode_row_band(&band_bytes).unwrap();
        assert_eq!(band.generation, 1);
        assert_eq!(band.start_id, 0);
        let text = band
            .rows
            .iter()
            .map(|row| row.plain_text().trim_end().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(text, vec!["L01", "L02", "L03", "L04"]);

        // After the serve the next live extract still shows the tail (the worker
        // re-pins, and read_rows restores the pin too).
        let after = terminal.frame().unwrap();
        assert!(after.scrollback.at_bottom);
    }

    #[test]
    fn read_rows_command_returns_an_empty_band_for_a_stale_generation() {
        use crate::terminal::wire::decode_row_band;

        let (sender, receiver) = mpsc::channel();
        let mut terminal = GhosttyTerminalState::new(10, 3).unwrap();
        let mut viewport_state = TerminalViewportState {
            frontend_active: true,
        };
        // The live generation is 2, but the request carries the stale 1.
        let mut generation: u32 = 2;

        for index in 1..=20 {
            terminal.write(format!("L{index:02}\r\n").as_bytes());
        }
        terminal.scroll_bottom();

        let (reply_tx, reply_rx) = mpsc::channel();
        sender
            .send(TerminalRuntimeCommand::ReadRows {
                start_id: 0,
                count: 4,
                generation: 1,
                reply: reply_tx,
            })
            .unwrap();
        apply_terminal_commands(
            TerminalId::new_v4(),
            &receiver,
            &mut terminal,
            &mut viewport_state,
            &mut generation,
        )
        .unwrap();

        let band = decode_row_band(&reply_rx.recv().unwrap()).unwrap();
        // Stamped with the live generation, with no rows: the frontend drops it
        // and re-requests against the new generation.
        assert_eq!(band.generation, 2);
        assert!(band.rows.is_empty());
    }

    #[test]
    fn read_rows_command_replies_and_the_worker_keeps_draining_after_it() {
        // A ReadRows must always reply (so the `read_terminal_rows` caller never
        // hangs) and must never break the command drain: a command queued after
        // it in the same batch is still applied. This guards the worker against
        // dying on a serve (an internal read error replies an empty band instead
        // of propagating).
        use crate::terminal::wire::decode_row_band;

        let (sender, receiver) = mpsc::channel();
        let mut terminal = GhosttyTerminalState::new(10, 3).unwrap();
        let mut viewport_state = TerminalViewportState {
            frontend_active: true,
        };
        let mut generation: u32 = 1;

        for index in 1..=20 {
            terminal.write(format!("L{index:02}\r\n").as_bytes());
        }
        terminal.scroll_bottom();
        let _ = terminal.frame().unwrap();

        // A ReadRows followed by a SetFrontendActive in the same drain.
        let (reply_tx, reply_rx) = mpsc::channel();
        sender
            .send(TerminalRuntimeCommand::ReadRows {
                start_id: 0,
                count: 4,
                generation: 1,
                reply: reply_tx,
            })
            .unwrap();
        sender
            .send(TerminalRuntimeCommand::SetFrontendActive(false))
            .unwrap();

        apply_terminal_commands(
            TerminalId::new_v4(),
            &receiver,
            &mut terminal,
            &mut viewport_state,
            &mut generation,
        )
        .unwrap();

        // The reply was sent (caller never hangs)...
        let band = decode_row_band(&reply_rx.recv().unwrap()).unwrap();
        assert_eq!(band.rows.len(), 4);
        // ...and the command queued after ReadRows was still applied, proving the
        // drain (and thus the worker loop) survived the serve.
        assert!(!viewport_state.frontend_active);

        // The serve restored the pin, so the next live extract still shows the tail.
        let after = terminal.frame().unwrap();
        assert!(after.scrollback.at_bottom);
    }

    #[test]
    fn resize_command_bumps_the_generation_and_forces_a_full_frame() {
        // A resize bumps the per-session generation in place and the post-resize
        // frame is Full, which the frontend adopts as the new generation. This
        // pins both halves of that contract.
        let (sender, receiver) = mpsc::channel();
        let mut terminal = GhosttyTerminalState::new(10, 3).unwrap();
        let mut viewport_state = TerminalViewportState {
            frontend_active: true,
        };
        let mut generation: u32 = 1;

        // Drain the initial forced-full frame so the next frame reflects only
        // the resize.
        let _ = terminal.frame().unwrap();

        sender
            .send(TerminalRuntimeCommand::Resize { cols: 20, rows: 5 })
            .unwrap();
        sender
            .send(TerminalRuntimeCommand::Resize { cols: 24, rows: 6 })
            .unwrap();
        let applied = apply_terminal_commands(
            TerminalId::new_v4(),
            &receiver,
            &mut terminal,
            &mut viewport_state,
            &mut generation,
        )
        .unwrap();
        assert!(applied.needs_frame);
        assert_eq!(generation, 3);

        let frame = terminal.frame().unwrap();
        assert_eq!(
            frame.dirty,
            reverie_core::terminal::TerminalDirtyState::Full
        );
        assert_eq!(frame.cols, 24);
    }

    #[test]
    fn terminal_commands_lower_frame_cadence_when_frontend_backgrounds_terminal() {
        let (sender, receiver) = mpsc::channel();
        let mut terminal = GhosttyTerminalState::new(10, 3).unwrap();
        let mut viewport_state = TerminalViewportState {
            frontend_active: true,
        };
        let mut generation: u32 = 1;

        assert_eq!(
            terminal_frame_interval(&viewport_state),
            TERMINAL_FRAME_INTERVAL
        );

        sender
            .send(TerminalRuntimeCommand::SetFrontendActive(false))
            .unwrap();
        assert!(
            !apply_terminal_commands(
                TerminalId::new_v4(),
                &receiver,
                &mut terminal,
                &mut viewport_state,
                &mut generation,
            )
            .unwrap()
            .needs_frame
        );
        assert!(!viewport_state.frontend_active);
        assert_eq!(
            terminal_frame_interval(&viewport_state),
            BACKGROUND_TERMINAL_FRAME_INTERVAL
        );

        sender
            .send(TerminalRuntimeCommand::SetFrontendActive(true))
            .unwrap();
        assert!(
            !apply_terminal_commands(
                TerminalId::new_v4(),
                &receiver,
                &mut terminal,
                &mut viewport_state,
                &mut generation,
            )
            .unwrap()
            .needs_frame
        );
        assert!(viewport_state.frontend_active);
        assert_eq!(
            terminal_frame_interval(&viewport_state),
            TERMINAL_FRAME_INTERVAL
        );
    }

    #[test]
    fn drain_pty_read_batch_coalesces_queued_chunks() {
        let (sender, receiver) = mpsc::channel();
        sender.send(PtyReadEvent::Chunk(b"b".to_vec())).unwrap();
        sender.send(PtyReadEvent::Chunk(b"c".to_vec())).unwrap();

        let batch = drain_pty_read_batch(b"a".to_vec(), &receiver).unwrap();

        assert_eq!(batch.bytes, b"abc");
        assert_eq!(batch.chunks, 3);
        assert!(batch.deferred_event.is_none());
    }

    #[test]
    fn drain_pty_read_batch_defers_exit_until_after_chunks() {
        let (sender, receiver) = mpsc::channel();
        sender.send(PtyReadEvent::Chunk(b"b".to_vec())).unwrap();
        sender
            .send(PtyReadEvent::Exited {
                child_success: true,
            })
            .unwrap();

        let batch = drain_pty_read_batch(b"a".to_vec(), &receiver).unwrap();

        assert_eq!(batch.bytes, b"ab");
        assert_eq!(batch.chunks, 2);
        assert!(matches!(
            batch.deferred_event,
            Some(DeferredPtyReadEvent::Exited {
                child_success: true
            })
        ));
    }

    #[test]
    fn terminal_frame_due_throttles_background_sessions_under_output_pressure() {
        let active_frames = simulated_pending_frame_emits(true, 500, 4);
        let background_frames = simulated_pending_frame_emits(false, 500, 4);

        assert!(active_frames >= 30, "active frames: {active_frames}");
        assert!(
            background_frames <= 5,
            "background frames: {background_frames}"
        );
        assert!(
            active_frames >= background_frames * 5,
            "active={active_frames} background={background_frames}"
        );
    }

    #[test]
    fn terminal_frame_due_flushes_pending_background_frame_when_reactivated() {
        let start = Instant::now();
        let last_frame_emit = start;
        let mut viewport_state = TerminalViewportState {
            frontend_active: false,
        };
        let pending_frame = true;
        let next_tick = start + Duration::from_millis(80);

        assert!(!terminal_frame_due(
            pending_frame,
            last_frame_emit,
            &viewport_state,
            next_tick
        ));

        viewport_state.frontend_active = true;

        assert!(terminal_frame_due(
            pending_frame,
            last_frame_emit,
            &viewport_state,
            next_tick
        ));
    }

    #[test]
    fn terminal_frame_ready_buffers_synchronized_output_until_timeout() {
        let mut terminal = GhosttyTerminalState::new(10, 3).unwrap();
        let viewport_state = TerminalViewportState {
            frontend_active: true,
        };
        let now = Instant::now();
        let last_frame_emit = now.checked_sub(TERMINAL_FRAME_INTERVAL).unwrap_or(now);
        let mut sync_output_started_at = None;

        terminal.write(b"\x1b[?2026h");

        assert!(
            !terminal_frame_ready(
                true,
                last_frame_emit,
                &viewport_state,
                &terminal,
                &mut sync_output_started_at,
                now,
            )
            .unwrap()
        );
        assert!(sync_output_started_at.is_some());
        assert!(
            terminal_frame_ready(
                true,
                last_frame_emit,
                &viewport_state,
                &terminal,
                &mut sync_output_started_at,
                now + SYNC_OUTPUT_FRAME_TIMEOUT,
            )
            .unwrap()
        );

        terminal.write(b"\x1b[?2026l");

        assert!(
            terminal_frame_ready(
                true,
                last_frame_emit,
                &viewport_state,
                &terminal,
                &mut sync_output_started_at,
                now + SYNC_OUTPUT_FRAME_TIMEOUT + Duration::from_millis(1),
            )
            .unwrap()
        );
        assert!(sync_output_started_at.is_none());
    }

    fn simulated_pending_frame_emits(active: bool, duration_ms: u64, tick_ms: u64) -> usize {
        let start = Instant::now();
        let mut last_frame_emit = start.checked_sub(TERMINAL_FRAME_INTERVAL).unwrap_or(start);
        let viewport_state = TerminalViewportState {
            frontend_active: active,
        };
        let mut frames = 0_usize;
        let ticks = duration_ms / tick_ms;

        for tick in 0..=ticks {
            let now = start + Duration::from_millis(tick * tick_ms);
            if terminal_frame_due(true, last_frame_emit, &viewport_state, now) {
                frames += 1;
                last_frame_emit = now;
            }
        }

        frames
    }

    #[test]
    fn terminal_frame_segments_preserve_line_boundaries_for_scrollback_reconstruction() {
        let chunk = b"one\r\ntwo\r\nthree";
        let segments = terminal_frame_segments(chunk, 512)
            .iter()
            .map(|segment| std::str::from_utf8(segment).unwrap().to_owned())
            .collect::<Vec<_>>();

        assert_eq!(segments, vec!["one\r\n", "two\r\n", "three"]);
    }

    #[test]
    fn terminal_frame_segments_split_long_unbroken_output() {
        let chunk = b"abcdefghijkl";
        let segments = terminal_frame_segments(chunk, 5)
            .iter()
            .map(|segment| std::str::from_utf8(segment).unwrap().to_owned())
            .collect::<Vec<_>>();

        assert_eq!(segments, vec!["abcde", "fghij", "kl"]);
    }
}
