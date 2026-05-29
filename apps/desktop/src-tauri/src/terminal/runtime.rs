use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    mpsc::{self, Receiver, RecvTimeoutError, Sender},
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use reverie_core::TerminalSpawnSpec;
use reverie_core::domain::SessionId;
use reverie_core::pty::{PtyController, PtyProcess};
use reverie_core::terminal::{TerminalFrame, TerminalId};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::terminal::ghostty::GhosttyTerminalState;
use reverie_core::WorkspaceService;

const READ_BUFFER_BYTES: usize = 4096;
const TERMINAL_FRAME_INTERVAL: Duration = Duration::from_millis(16);

#[derive(Clone, Default)]
pub struct TerminalSessionRuntime {
    sessions: Arc<Mutex<HashMap<TerminalId, TerminalSessionRecord>>>,
    controllers: Arc<Mutex<HashMap<TerminalId, PtyController>>>,
    command_senders: Arc<Mutex<HashMap<TerminalId, Sender<TerminalRuntimeCommand>>>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TerminalRuntimeCommand {
    Resize { cols: u16, rows: u16 },
    ScrollDelta(isize),
    ScrollTop,
    ScrollBottom,
}

#[derive(Debug)]
enum PtyReadEvent {
    Chunk(Vec<u8>),
    Exited { child_success: bool },
    Failed(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct TerminalViewportState {
    follow_tail: bool,
}

#[derive(Clone, Debug)]
pub struct TerminalStreamRequest {
    pub session_id: Option<SessionId>,
    pub terminal_id: TerminalId,
    pub spawn_spec: TerminalSpawnSpec,
    pub max_scrollback: usize,
    pub target_frames: Option<usize>,
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalFrameEvent {
    session_id: Option<SessionId>,
    terminal_id: TerminalId,
    seq: usize,
    bytes_read: usize,
    chunk_bytes: usize,
    rust_elapsed_ms: f64,
    frame: TerminalFrame,
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

        self.controller_for(terminal_id)?.write_input(input)
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

    pub fn scroll_terminal(&self, terminal_id: TerminalId, delta_rows: isize) -> Result<()> {
        if delta_rows == 0 {
            return Ok(());
        }

        self.command_sender_for(terminal_id)?
            .send(TerminalRuntimeCommand::ScrollDelta(delta_rows))
            .context("failed to queue terminal scroll command")
    }

    pub fn scroll_terminal_to_top(&self, terminal_id: TerminalId) -> Result<()> {
        self.command_sender_for(terminal_id)?
            .send(TerminalRuntimeCommand::ScrollTop)
            .context("failed to queue terminal scroll-to-top command")
    }

    pub fn scroll_terminal_to_bottom(&self, terminal_id: TerminalId) -> Result<()> {
        self.command_sender_for(terminal_id)?
            .send(TerminalRuntimeCommand::ScrollBottom)
            .context("failed to queue terminal scroll-to-bottom command")
    }

    pub fn terminate_session(&self, terminal_id: TerminalId) -> Result<()> {
        self.controller_for(terminal_id)?.terminate()
    }

    fn run_stream_worker(&self, app: AppHandle, request: TerminalStreamRequest) -> Result<()> {
        let spec = request.spawn_spec;
        let launch_started_ms = unix_time_millis();
        let mut terminal = GhosttyTerminalState::new(spec.cols, spec.rows, request.max_scrollback)?;
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
        let mut bytes_read = 0_usize;
        let mut bytes_rendered = 0_usize;
        let mut bytes_since_last_frame = 0_usize;
        let mut chunks_read = 0_usize;
        let mut frames_emitted = 0_usize;
        let mut total_emit_ms = 0_f64;
        let mut max_emit_ms = 0_f64;
        let mut pending_frame = false;
        let mut last_frame_emit = Instant::now()
            .checked_sub(TERMINAL_FRAME_INTERVAL)
            .unwrap_or_else(Instant::now);
        let mut viewport_state = TerminalViewportState { follow_tail: true };
        let child_success = loop {
            if apply_terminal_commands(&command_rx, &mut terminal, &mut viewport_state)? {
                pending_frame = true;
            }

            if pending_frame && last_frame_emit.elapsed() >= TERMINAL_FRAME_INTERVAL {
                let emit_ms = emit_terminal_frame_event(
                    &app,
                    request.session_id,
                    request.terminal_id,
                    frames_emitted,
                    bytes_rendered,
                    bytes_since_last_frame,
                    started,
                    &mut terminal,
                )?;
                total_emit_ms += emit_ms;
                max_emit_ms = max_emit_ms.max(emit_ms);
                frames_emitted += 1;
                self.update_progress(request.terminal_id, frames_emitted, bytes_rendered)?;
                bytes_since_last_frame = 0;
                pending_frame = false;
                last_frame_emit = Instant::now();
            }

            match read_rx.recv_timeout(Duration::from_millis(4)) {
                Ok(PtyReadEvent::Chunk(chunk)) => {
                    chunks_read += 1;
                    bytes_read += chunk.len();
                    bytes_rendered += chunk.len();
                    bytes_since_last_frame += chunk.len();

                    terminal.write(&chunk);
                    if viewport_state.follow_tail {
                        terminal.scroll_bottom();
                    }
                    pending_frame = true;
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
            if pending_frame && last_frame_emit.elapsed() >= TERMINAL_FRAME_INTERVAL {
                let emit_ms = emit_terminal_frame_event(
                    &app,
                    request.session_id,
                    request.terminal_id,
                    frames_emitted,
                    bytes_rendered,
                    bytes_since_last_frame,
                    started,
                    &mut terminal,
                )?;
                total_emit_ms += emit_ms;
                max_emit_ms = max_emit_ms.max(emit_ms);
                frames_emitted += 1;
                self.update_progress(request.terminal_id, frames_emitted, bytes_rendered)?;
                bytes_since_last_frame = 0;
                pending_frame = false;
                last_frame_emit = Instant::now();
            }
        };

        if pending_frame {
            let emit_ms = emit_terminal_frame_event(
                &app,
                request.session_id,
                request.terminal_id,
                frames_emitted,
                bytes_rendered,
                bytes_since_last_frame,
                started,
                &mut terminal,
            )?;
            total_emit_ms += emit_ms;
            max_emit_ms = max_emit_ms.max(emit_ms);
            frames_emitted += 1;
            self.update_progress(request.terminal_id, frames_emitted, bytes_rendered)?;
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
        persist_native_session_after_launch(&app, request.session_id, launch_started_ms);
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
    ) -> Result<()> {
        self.update_record(terminal_id, |record| {
            record.frames_emitted = frames_emitted;
            record.bytes_read = bytes_read;
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

fn emit_terminal_frame_event(
    app: &AppHandle,
    session_id: Option<SessionId>,
    terminal_id: TerminalId,
    seq: usize,
    bytes_read: usize,
    chunk_bytes: usize,
    started: Instant,
    terminal: &mut GhosttyTerminalState<'_, '_>,
) -> Result<f64> {
    let event = TerminalFrameEvent {
        session_id,
        terminal_id,
        seq,
        bytes_read,
        chunk_bytes,
        rust_elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        frame: terminal.frame()?,
    };

    let emit_started = Instant::now();
    app.emit("terminal_frame", event)?;

    Ok(emit_started.elapsed().as_secs_f64() * 1000.0)
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

fn apply_terminal_commands(
    receiver: &Receiver<TerminalRuntimeCommand>,
    terminal: &mut GhosttyTerminalState<'_, '_>,
    viewport_state: &mut TerminalViewportState,
) -> Result<bool> {
    let mut needs_frame = false;

    while let Ok(command) = receiver.try_recv() {
        match command {
            TerminalRuntimeCommand::Resize { cols, rows } => {
                terminal.resize(cols, rows)?;
                if viewport_state.follow_tail {
                    terminal.scroll_bottom();
                }
                needs_frame = true;
            }
            TerminalRuntimeCommand::ScrollDelta(rows) => {
                terminal.scroll_delta(rows);
                viewport_state.follow_tail = terminal.is_viewport_at_bottom()?;
                needs_frame = true;
            }
            TerminalRuntimeCommand::ScrollTop => {
                terminal.scroll_top();
                viewport_state.follow_tail = false;
                needs_frame = true;
            }
            TerminalRuntimeCommand::ScrollBottom => {
                terminal.scroll_bottom();
                viewport_state.follow_tail = true;
                needs_frame = true;
            }
        }
    }

    Ok(needs_frame)
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
    launch_started_ms: i64,
) {
    if let Some((service, session_id)) = workspace_service(app, session_id) {
        // Adapter-driven discovery: the service resolves the session's adapter
        // and attaches a native ref if one is found. `cortex_home_dir` supplies
        // the Cortex home; non-Cortex adapters ignore it (no discovery yet).
        let _ = service.discover_and_attach_native_session(
            session_id,
            Some(launch_started_ms),
            cortex_home_dir(),
        );
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
            max_scrollback: 100,
            target_frames: Some(1),
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
        let scroll_error = runtime.scroll_terminal(terminal_id, -3).unwrap_err();
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
        assert!(
            scroll_error
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
    fn terminal_commands_scroll_ghostty_viewport() {
        let (sender, receiver) = mpsc::channel();
        let mut terminal = GhosttyTerminalState::new(10, 3, 100).unwrap();
        let mut viewport_state = TerminalViewportState { follow_tail: true };

        for index in 1..=10 {
            terminal.write(format!("L{index:02}\r\n").as_bytes());
        }
        terminal.scroll_bottom();

        sender.send(TerminalRuntimeCommand::ScrollTop).unwrap();
        assert!(apply_terminal_commands(&receiver, &mut terminal, &mut viewport_state).unwrap());
        let top = terminal.frame().unwrap();
        assert!(!viewport_state.follow_tail);
        assert!(!top.scrollback.at_bottom);
        assert_eq!(top.rows[0].plain_text().trim_end(), "L01");

        sender.send(TerminalRuntimeCommand::ScrollBottom).unwrap();
        assert!(apply_terminal_commands(&receiver, &mut terminal, &mut viewport_state).unwrap());
        let bottom = terminal.frame().unwrap();
        assert!(viewport_state.follow_tail);
        assert!(bottom.scrollback.at_bottom);
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
