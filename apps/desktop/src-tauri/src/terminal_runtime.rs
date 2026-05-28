use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use reverie_core::TerminalSpawnSpec;
use reverie_core::domain::SessionId;
use reverie_core::pty::{PtyController, PtyProcess};
use reverie_core::terminal::{TerminalFrame, TerminalId};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::app_shell::AppShellStore;
use crate::terminal_backend::GhosttyTerminalState;

const READ_BUFFER_BYTES: usize = 4096;
const MAX_TERMINAL_FRAME_SEGMENT_BYTES: usize = 512;

#[derive(Clone, Default)]
pub struct TerminalSessionRuntime {
    sessions: Arc<Mutex<HashMap<TerminalId, TerminalSessionRecord>>>,
    controllers: Arc<Mutex<HashMap<TerminalId, PtyController>>>,
    pending_resizes: Arc<Mutex<HashMap<TerminalId, PendingTerminalResize>>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PendingTerminalResize {
    cols: u16,
    rows: u16,
}

#[derive(Clone, Debug)]
pub struct TerminalStreamRequest {
    pub session_id: Option<SessionId>,
    pub terminal_id: TerminalId,
    pub spawn_spec: TerminalSpawnSpec,
    pub max_scrollback: usize,
    pub target_frames: Option<usize>,
    pub legacy_proof_events: bool,
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
            if let Err(err) = runtime.run_stream_worker(app.clone(), request.clone()) {
                runtime.remove_controller(request.terminal_id);
                runtime.register_failed(request.terminal_id);
                persist_shell_session_failed(&app, request.session_id);
                let failure = TerminalFailedEvent {
                    session_id: request.session_id,
                    terminal_id: Some(request.terminal_id),
                    message: err.to_string(),
                };
                let _ = app.emit("terminal_failed", failure.clone());
                if request.legacy_proof_events {
                    let _ = app.emit("reverie-terminal-stream-failed", failure);
                }
            }
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
        self.queue_pending_resize(terminal_id, cols, rows)?;
        self.update_record(terminal_id, |record| {
            record.cols = cols;
            record.rows = rows;
        })
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
        let (mut reader, controller) = process.split();
        self.register_controller(request.terminal_id, controller)?;

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
        app.emit("terminal_stream_started", started_payload.clone())?;
        if request.legacy_proof_events {
            app.emit("reverie-terminal-stream-started", started_payload)?;
        }

        let started = Instant::now();
        let mut buf = [0_u8; READ_BUFFER_BYTES];
        let mut bytes_read = 0_usize;
        let mut bytes_rendered = 0_usize;
        let mut chunks_read = 0_usize;
        let mut frames_emitted = 0_usize;
        let mut total_emit_ms = 0_f64;
        let mut max_emit_ms = 0_f64;

        loop {
            let read = reader.read_chunk(&mut buf)?;
            if read == 0 {
                break;
            }

            chunks_read += 1;
            bytes_read += read;

            for segment in terminal_frame_segments(&buf[..read], MAX_TERMINAL_FRAME_SEGMENT_BYTES) {
                terminal.write(segment);
                bytes_rendered += segment.len();
                self.apply_pending_resize(request.terminal_id, &mut terminal)?;
                let event = TerminalFrameEvent {
                    session_id: request.session_id,
                    terminal_id: request.terminal_id,
                    seq: frames_emitted,
                    bytes_read: bytes_rendered,
                    chunk_bytes: segment.len(),
                    rust_elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
                    frame: terminal.frame()?,
                };

                let emit_started = Instant::now();
                app.emit("terminal_frame", event.clone())?;
                if request.legacy_proof_events {
                    app.emit("reverie-terminal-stream-frame", event)?;
                }
                let emit_ms = emit_started.elapsed().as_secs_f64() * 1000.0;
                total_emit_ms += emit_ms;
                max_emit_ms = max_emit_ms.max(emit_ms);
                frames_emitted += 1;
                self.update_progress(request.terminal_id, frames_emitted, bytes_rendered)?;
            }
        }

        let status = reader.wait()?;
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
            child_success: status.success(),
        };

        self.remove_controller(request.terminal_id);
        self.register_exited(
            request.terminal_id,
            frames_emitted,
            bytes_read,
            status.success(),
        )?;
        persist_cortex_session_after_launch(&app, request.session_id, launch_started_ms);
        persist_shell_session_finished(&app, request.session_id, status.success());
        app.emit("terminal_exit", finished.clone())?;
        app.emit("session_status_changed", finished.clone())?;
        if request.legacy_proof_events {
            app.emit("reverie-terminal-stream-finished", finished)?;
        }

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

    fn remove_controller(&self, terminal_id: TerminalId) {
        if let Ok(mut controllers) = self.controllers.lock() {
            controllers.remove(&terminal_id);
        }
        if let Ok(mut pending_resizes) = self.pending_resizes.lock() {
            pending_resizes.remove(&terminal_id);
        }
    }

    fn queue_pending_resize(&self, terminal_id: TerminalId, cols: u16, rows: u16) -> Result<()> {
        self.pending_resizes
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal runtime pending resize map is poisoned"))?
            .insert(terminal_id, PendingTerminalResize { cols, rows });
        Ok(())
    }

    fn apply_pending_resize(
        &self,
        terminal_id: TerminalId,
        terminal: &mut GhosttyTerminalState<'_, '_>,
    ) -> Result<()> {
        let resize = self
            .pending_resizes
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal runtime pending resize map is poisoned"))?
            .remove(&terminal_id);

        if let Some(resize) = resize {
            terminal.resize(resize.cols, resize.rows)?;
        }

        Ok(())
    }

    fn controller_for(&self, terminal_id: TerminalId) -> Result<PtyController> {
        self.controllers
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal runtime controller map is poisoned"))?
            .get(&terminal_id)
            .cloned()
            .with_context(|| format!("terminal session {terminal_id} has no live PTY controller"))
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

fn persist_cortex_session_after_launch(
    app: &AppHandle,
    session_id: Option<SessionId>,
    launch_started_ms: i64,
) {
    if let (Some((store, session_id)), Some(cortex_home)) = (shell_store(app, session_id), cortex_home_dir()) {
        let _ = store.capture_cortex_session_after_launch(session_id, cortex_home, launch_started_ms);
    }
}

fn persist_shell_session_running(app: &AppHandle, session_id: Option<SessionId>) {
    if let Some((store, session_id)) = shell_store(app, session_id) {
        let _ = store.mark_session_running(session_id);
    }
}

fn persist_shell_session_finished(
    app: &AppHandle,
    session_id: Option<SessionId>,
    child_success: bool,
) {
    if let Some((store, session_id)) = shell_store(app, session_id) {
        let _ = store.mark_session_finished(session_id, child_success);
    }
}

fn persist_shell_session_failed(app: &AppHandle, session_id: Option<SessionId>) {
    if let Some((store, session_id)) = shell_store(app, session_id) {
        let _ = store.mark_session_failed(session_id);
    }
}

fn shell_store(app: &AppHandle, session_id: Option<SessionId>) -> Option<(tauri::State<'_, AppShellStore>, SessionId)> {
    Some((app.try_state::<AppShellStore>()?, session_id?))
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
            legacy_proof_events: false,
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
    }

    #[test]
    fn runtime_rejects_zero_sized_resize_before_touching_controller() {
        let runtime = TerminalSessionRuntime::default();
        let terminal_id = TerminalId::new_v4();

        let error = runtime.resize_terminal(terminal_id, 0, 32).unwrap_err();

        assert!(error.to_string().contains("non-zero cols and rows"));
    }

    #[test]
    fn runtime_applies_pending_resize_to_ghostty_state_once() {
        let runtime = TerminalSessionRuntime::default();
        let terminal_id = TerminalId::new_v4();
        let mut terminal = GhosttyTerminalState::new(24, 8, 100).unwrap();

        terminal.write(b"reverie pending resize keeps ghostty aligned with the PTY\r\n");
        runtime.queue_pending_resize(terminal_id, 48, 8).unwrap();
        runtime
            .apply_pending_resize(terminal_id, &mut terminal)
            .unwrap();
        runtime
            .apply_pending_resize(terminal_id, &mut terminal)
            .unwrap();

        let rows = terminal.frame().unwrap().rows;

        assert_eq!(rows.len(), 8);
        assert_eq!(
            runtime
                .pending_resizes
                .lock()
                .expect("pending resize map should not be poisoned")
                .get(&terminal_id),
            None
        );
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
