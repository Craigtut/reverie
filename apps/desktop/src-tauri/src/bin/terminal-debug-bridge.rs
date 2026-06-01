use std::{
    collections::{BTreeMap, VecDeque},
    env,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver, Sender},
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, bail};
use reverie_core::{
    CommandSpec, TerminalSpawnSpec,
    pty::{PtyController, PtyProcess},
    terminal::TerminalId,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[path = "../terminal/ghostty.rs"]
#[allow(dead_code)]
mod ghostty;

#[path = "../terminal/wire.rs"]
#[allow(dead_code)]
mod wire;

use ghostty::{GhosttyTerminalState, ghostty_scrollback_bytes_for_rows};
use wire::encode_frame;

const DEFAULT_BIND: &str = "127.0.0.1:17777";
const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 32;
const DEFAULT_SCROLLBACK_ROWS: usize = 100_000;
const PTY_DRAIN_MAX_BYTES: usize = 64 * 1024;
const PTY_DRAIN_MAX_CHUNKS: usize = 64;
const FRAME_INTERVAL: Duration = Duration::from_millis(16);
const BACKGROUND_FRAME_INTERVAL: Duration = Duration::from_millis(100);
const EVENT_REPLAY_LIMIT: usize = 240;

fn main() -> Result<()> {
    let bind = env::var("REVERIE_TERMINAL_DEBUG_BRIDGE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BIND.to_owned());
    let server = Arc::new(BridgeServer::default());
    let listener = TcpListener::bind(&bind).with_context(|| format!("failed to bind {bind}"))?;
    eprintln!("Reverie terminal debug bridge listening on http://{bind}");
    eprintln!("Set REVERIE_TERMINAL_DEBUG_COMMAND='codex' or pass ?bridgeCommand=codex.");

    for stream in listener.incoming() {
        let stream = match stream {
            Ok(stream) => stream,
            Err(error) => {
                eprintln!("bridge accept failed: {error}");
                continue;
            }
        };
        let server = Arc::clone(&server);
        thread::spawn(move || {
            if let Err(error) = handle_connection(stream, server) {
                eprintln!("bridge request failed: {error:#}");
            }
        });
    }

    Ok(())
}

#[derive(Default)]
struct BridgeServer {
    session: Mutex<Option<BridgeSession>>,
    broadcaster: Arc<Broadcaster>,
}

struct BridgeSession {
    terminal_id: TerminalId,
    controller: PtyController,
    command_tx: Sender<WorkerCommand>,
}

#[derive(Default)]
struct Broadcaster {
    clients: Mutex<Vec<Sender<BridgeEvent>>>,
    replay: Mutex<VecDeque<BridgeEvent>>,
}

// A bridge event carries its already-serialized SSE `data:` body. JSON
// lifecycle events store a JSON string; the binary frame stream stores the
// base64 of the same wire bytes the Tauri Channel sends, so both transports
// exercise one shared encoder + decoder.
#[derive(Clone, Debug)]
struct BridgeEvent {
    name: String,
    data: String,
}

impl Broadcaster {
    fn subscribe(&self) -> Receiver<BridgeEvent> {
        let (tx, rx) = mpsc::channel();
        for event in self
            .replay
            .lock()
            .expect("bridge replay lock should not be poisoned")
            .iter()
            .cloned()
        {
            if tx.send(event).is_err() {
                return rx;
            }
        }
        self.clients
            .lock()
            .expect("bridge client lock should not be poisoned")
            .push(tx);
        rx
    }

    /// Emit a JSON lifecycle event (started/exit/failed). The payload is
    /// serialized to a JSON string for the SSE `data:` field.
    fn emit<T: Serialize>(&self, name: &str, payload: &T) {
        let data = match serde_json::to_string(payload) {
            Ok(data) => data,
            Err(error) => {
                eprintln!("failed to serialize bridge event {name}: {error}");
                return;
            }
        };
        self.dispatch(BridgeEvent {
            name: name.to_owned(),
            data,
        });
    }

    /// Emit a pre-serialized event body verbatim (the binary frame stream, sent
    /// as base64 of the wire bytes).
    fn emit_data(&self, name: &str, data: String) {
        self.dispatch(BridgeEvent {
            name: name.to_owned(),
            data,
        });
    }

    fn dispatch(&self, event: BridgeEvent) {
        let mut replay = self
            .replay
            .lock()
            .expect("bridge replay lock should not be poisoned");
        replay.push_back(event.clone());
        while replay.len() > EVENT_REPLAY_LIMIT {
            replay.pop_front();
        }
        drop(replay);

        let mut clients = self
            .clients
            .lock()
            .expect("bridge client lock should not be poisoned");
        clients.retain(|client| client.send(event.clone()).is_ok());
    }
}

enum WorkerCommand {
    Resize { cols: u16, rows: u16 },
    ScrollDelta(isize),
    ScrollTop,
    ScrollBottom,
    SetFrontendActive(bool),
    Terminate,
}

#[derive(Debug)]
enum PtyReadEvent {
    Chunk(Vec<u8>),
    Exited,
    Failed(String),
}

#[derive(Debug)]
enum DeferredPtyReadEvent {
    Exited,
    Failed(String),
}

#[derive(Debug)]
struct PtyReadBatch {
    bytes: Vec<u8>,
    chunks: usize,
    deferred_event: Option<DeferredPtyReadEvent>,
}

#[derive(Deserialize)]
struct BridgeStartBody {
    request: StartSessionRequest,
    #[serde(default, rename = "commandOverride")]
    command_override: Option<String>,
    #[serde(default)]
    cwd: Option<PathBuf>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartSessionRequest {
    terminal_id: Option<TerminalId>,
    cols: Option<u16>,
    rows: Option<u16>,
    spawn_spec: Option<TerminalSpawnSpec>,
    max_scrollback: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalIdBody {
    terminal_id: TerminalId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResizeBody {
    terminal_id: TerminalId,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputBody {
    terminal_id: TerminalId,
    input: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScrollBody {
    terminal_id: TerminalId,
    delta_rows: isize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveBody {
    terminal_id: TerminalId,
    active: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStreamStartedPayload {
    terminal_id: TerminalId,
    target_frames: Option<usize>,
    cols: u16,
    rows: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitPayload {
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalFailedPayload {
    terminal_id: Option<TerminalId>,
    message: String,
}

struct HttpRequest {
    method: String,
    path: String,
    body: Vec<u8>,
}

fn handle_connection(mut stream: TcpStream, server: Arc<BridgeServer>) -> Result<()> {
    let request = read_http_request(&stream)?;
    if request.method == "OPTIONS" {
        write_empty_response(&mut stream, 204)?;
        return Ok(());
    }

    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/health") => write_json_response(&mut stream, &json!({ "ok": true }))?,
        ("GET", "/events") => stream_events(stream, server.broadcaster.subscribe())?,
        ("POST", "/start") => {
            let body: BridgeStartBody = parse_json(&request.body)?;
            let terminal_id = server.start(body)?;
            write_json_response(&mut stream, &terminal_id)?;
        }
        ("POST", "/resize") => {
            let body: ResizeBody = parse_json(&request.body)?;
            server.resize(body)?;
            write_json_response(&mut stream, &json!(null))?;
        }
        ("POST", "/input") => {
            let body: InputBody = parse_json(&request.body)?;
            server.input(body)?;
            write_json_response(&mut stream, &json!(null))?;
        }
        ("POST", "/scroll") => {
            let body: ScrollBody = parse_json(&request.body)?;
            server.scroll_delta(body)?;
            write_json_response(&mut stream, &json!(null))?;
        }
        ("POST", "/scroll_top") => {
            let body: TerminalIdBody = parse_json(&request.body)?;
            server.command_for(body.terminal_id, WorkerCommand::ScrollTop)?;
            write_json_response(&mut stream, &json!(null))?;
        }
        ("POST", "/scroll_bottom") => {
            let body: TerminalIdBody = parse_json(&request.body)?;
            server.command_for(body.terminal_id, WorkerCommand::ScrollBottom)?;
            write_json_response(&mut stream, &json!(null))?;
        }
        ("POST", "/active") => {
            let body: ActiveBody = parse_json(&request.body)?;
            server.command_for(
                body.terminal_id,
                WorkerCommand::SetFrontendActive(body.active),
            )?;
            write_json_response(&mut stream, &json!(null))?;
        }
        ("POST", "/terminate") => {
            let body: TerminalIdBody = parse_json(&request.body)?;
            server.terminate(body.terminal_id)?;
            write_json_response(&mut stream, &json!(null))?;
        }
        ("POST", "/theme") => write_json_response(&mut stream, &json!(null))?,
        _ => write_text_response(&mut stream, 404, "not found")?,
    }
    Ok(())
}

impl BridgeServer {
    fn start(&self, body: BridgeStartBody) -> Result<TerminalId> {
        self.terminate_current();

        let terminal_id = body.request.terminal_id.unwrap_or_else(TerminalId::new_v4);
        let spec = terminal_spawn_spec(&body)?;
        let cols = spec.cols;
        let rows = spec.rows;
        let max_scrollback_rows = body
            .request
            .max_scrollback
            .unwrap_or(DEFAULT_SCROLLBACK_ROWS);
        let max_scrollback = ghostty_scrollback_bytes_for_rows(max_scrollback_rows, cols);
        eprintln!(
            "bridge starting terminal {terminal_id} {cols}x{rows}, commandOverride bytes={}",
            body.command_override
                .as_ref()
                .map_or(0, |value| value.len())
        );
        let (command_tx, command_rx) = mpsc::channel();
        let controller = spawn_terminal_worker(
            terminal_id,
            spec,
            max_scrollback,
            command_rx,
            Arc::clone(&self.broadcaster),
        )?;

        *self
            .session
            .lock()
            .expect("bridge session lock should not be poisoned") = Some(BridgeSession {
            terminal_id,
            controller,
            command_tx,
        });

        self.broadcaster.emit(
            "terminal_stream_started",
            &TerminalStreamStartedPayload {
                terminal_id,
                target_frames: None,
                cols,
                rows,
            },
        );

        Ok(terminal_id)
    }

    fn resize(&self, body: ResizeBody) -> Result<()> {
        if body.cols == 0 || body.rows == 0 {
            bail!("resize requires non-zero cols and rows");
        }
        let session = self.current_session(body.terminal_id)?;
        session.controller.resize(body.cols, body.rows)?;
        session.command_tx.send(WorkerCommand::Resize {
            cols: body.cols,
            rows: body.rows,
        })?;
        Ok(())
    }

    fn input(&self, body: InputBody) -> Result<()> {
        let session = self.current_session(body.terminal_id)?;
        session.controller.write_input(body.input.as_bytes())
    }

    fn scroll_delta(&self, body: ScrollBody) -> Result<()> {
        self.command_for(
            body.terminal_id,
            WorkerCommand::ScrollDelta(body.delta_rows),
        )
    }

    fn command_for(&self, terminal_id: TerminalId, command: WorkerCommand) -> Result<()> {
        let session = self.current_session(terminal_id)?;
        session.command_tx.send(command)?;
        Ok(())
    }

    fn terminate(&self, terminal_id: TerminalId) -> Result<()> {
        let mut guard = self
            .session
            .lock()
            .expect("bridge session lock should not be poisoned");
        let Some(session) = guard.take() else {
            return Ok(());
        };
        if session.terminal_id != terminal_id {
            *guard = Some(session);
            bail!("unknown terminal {terminal_id}");
        }
        let _ = session.command_tx.send(WorkerCommand::Terminate);
        let _ = session.controller.terminate();
        Ok(())
    }

    fn terminate_current(&self) {
        let Some(session) = self
            .session
            .lock()
            .expect("bridge session lock should not be poisoned")
            .take()
        else {
            return;
        };
        let _ = session.command_tx.send(WorkerCommand::Terminate);
        let _ = session.controller.terminate();
    }

    fn current_session(&self, terminal_id: TerminalId) -> Result<BridgeSessionRef> {
        let guard = self
            .session
            .lock()
            .expect("bridge session lock should not be poisoned");
        let session = guard
            .as_ref()
            .ok_or_else(|| anyhow!("no active bridge terminal"))?;
        if session.terminal_id != terminal_id {
            bail!("unknown terminal {terminal_id}");
        }
        Ok(BridgeSessionRef {
            controller: session.controller.clone(),
            command_tx: session.command_tx.clone(),
        })
    }
}

struct BridgeSessionRef {
    controller: PtyController,
    command_tx: Sender<WorkerCommand>,
}

fn spawn_terminal_worker(
    terminal_id: TerminalId,
    spec: TerminalSpawnSpec,
    max_scrollback: usize,
    command_rx: Receiver<WorkerCommand>,
    broadcaster: Arc<Broadcaster>,
) -> Result<PtyController> {
    let process = PtyProcess::spawn(terminal_id, &spec)?;
    let (mut reader, controller) = process.split();
    let controller_for_return = controller.clone();
    let (read_tx, read_rx) = mpsc::channel();

    thread::spawn(move || {
        let mut buf = vec![0_u8; 4096];
        loop {
            match reader.read_chunk(&mut buf) {
                Ok(0) => {
                    let _ = read_tx.send(PtyReadEvent::Exited);
                    break;
                }
                Ok(n) => {
                    let _ = read_tx.send(PtyReadEvent::Chunk(buf[..n].to_vec()));
                }
                Err(error) => {
                    let _ = read_tx.send(PtyReadEvent::Failed(error.to_string()));
                    break;
                }
            }
        }
    });

    thread::spawn(move || {
        if let Err(error) = terminal_worker(
            terminal_id,
            spec,
            max_scrollback,
            command_rx,
            read_rx,
            broadcaster,
        ) {
            eprintln!("terminal bridge worker failed: {error:#}");
        }
    });

    Ok(controller_for_return)
}

fn terminal_worker(
    terminal_id: TerminalId,
    spec: TerminalSpawnSpec,
    max_scrollback: usize,
    command_rx: Receiver<WorkerCommand>,
    read_rx: Receiver<PtyReadEvent>,
    broadcaster: Arc<Broadcaster>,
) -> Result<()> {
    let started = Instant::now();
    let mut terminal = GhosttyTerminalState::new(spec.cols, spec.rows, max_scrollback)?;
    let mut follow_tail = true;
    let mut frontend_active = true;
    // Per-session frame generation, bumped on resize, stamped into every encoded
    // frame, exactly as the Tauri runtime worker does. See wire-protocol.md.
    let mut generation: u32 = 1;
    let mut bytes_read = 0_usize;
    let mut chunks_read = 0_usize;
    let mut frames_emitted = 0_usize;
    let mut total_emit_ms = 0_f64;
    let mut max_emit_ms = 0_f64;
    let mut pending_frame = true;
    let mut last_frame_emit = Instant::now()
        .checked_sub(FRAME_INTERVAL)
        .unwrap_or_else(Instant::now);

    loop {
        let mut terminating = false;
        while let Ok(command) = command_rx.try_recv() {
            match command {
                WorkerCommand::Resize { cols, rows } => {
                    terminal.resize(cols, rows)?;
                    if follow_tail {
                        terminal.scroll_bottom();
                    }
                    generation = generation.saturating_add(1);
                    pending_frame = true;
                }
                WorkerCommand::ScrollDelta(rows) => {
                    terminal.scroll_delta(rows);
                    follow_tail = terminal.is_viewport_at_bottom()?;
                    pending_frame = true;
                }
                WorkerCommand::ScrollTop => {
                    terminal.scroll_top();
                    follow_tail = false;
                    pending_frame = true;
                }
                WorkerCommand::ScrollBottom => {
                    terminal.scroll_bottom();
                    follow_tail = true;
                    pending_frame = true;
                }
                WorkerCommand::SetFrontendActive(active) => {
                    frontend_active = active;
                    pending_frame = pending_frame || active;
                }
                WorkerCommand::Terminate => {
                    terminating = true;
                    break;
                }
            }
        }
        if terminating {
            break;
        }

        if bridge_frame_due(
            pending_frame,
            last_frame_emit,
            frontend_active,
            Instant::now(),
        ) {
            let emit_started = Instant::now();
            let frame = terminal.frame()?;
            // Same wire bytes the Tauri Channel sends, base64'd for the SSE
            // `data:` field. The frontend decodes both with `decodeTerminalFrame`.
            let encoded = base64_encode(&encode_frame(&frame, generation));
            broadcaster.emit_data("terminal_frame", encoded);
            let emit_ms = emit_started.elapsed().as_secs_f64() * 1000.0;
            total_emit_ms += emit_ms;
            max_emit_ms = max_emit_ms.max(emit_ms);
            frames_emitted += 1;
            pending_frame = false;
            last_frame_emit = Instant::now();
        }

        match read_rx.recv_timeout(Duration::from_millis(4)) {
            Ok(PtyReadEvent::Chunk(bytes)) => {
                let batch = drain_bridge_pty_read_batch(bytes, &read_rx)?;
                chunks_read += batch.chunks;
                bytes_read += batch.bytes.len();
                terminal.write(&batch.bytes);
                if follow_tail {
                    terminal.scroll_bottom();
                }
                pending_frame = true;
                if let Some(deferred_event) = batch.deferred_event {
                    match deferred_event {
                        DeferredPtyReadEvent::Exited => break,
                        DeferredPtyReadEvent::Failed(message) => {
                            broadcaster.emit(
                                "terminal_failed",
                                &TerminalFailedPayload {
                                    terminal_id: Some(terminal_id),
                                    message,
                                },
                            );
                            return Ok(());
                        }
                    }
                }
            }
            Ok(PtyReadEvent::Exited) => break,
            Ok(PtyReadEvent::Failed(message)) => {
                broadcaster.emit(
                    "terminal_failed",
                    &TerminalFailedPayload {
                        terminal_id: Some(terminal_id),
                        message,
                    },
                );
                return Ok(());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    broadcaster.emit(
        "terminal_exit",
        &TerminalExitPayload {
            terminal_id,
            frames_emitted,
            chunks_read,
            bytes_read,
            rust_elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            total_emit_ms,
            avg_emit_ms: total_emit_ms / frames_emitted.max(1) as f64,
            max_emit_ms,
            child_success: true,
        },
    );
    Ok(())
}

fn bridge_frame_due(
    pending_frame: bool,
    last_frame_emit: Instant,
    frontend_active: bool,
    now: Instant,
) -> bool {
    let interval = if frontend_active {
        FRAME_INTERVAL
    } else {
        BACKGROUND_FRAME_INTERVAL
    };
    pending_frame && now.saturating_duration_since(last_frame_emit) >= interval
}

fn drain_bridge_pty_read_batch(
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
            Ok(PtyReadEvent::Exited) => {
                deferred_event = Some(DeferredPtyReadEvent::Exited);
                break;
            }
            Ok(PtyReadEvent::Failed(message)) => {
                deferred_event = Some(DeferredPtyReadEvent::Failed(message));
                break;
            }
            Err(mpsc::TryRecvError::Empty) => break,
            Err(mpsc::TryRecvError::Disconnected) => {
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

fn terminal_spawn_spec(body: &BridgeStartBody) -> Result<TerminalSpawnSpec> {
    if let Some(mut spec) = body.request.spawn_spec.clone() {
        if let Some(cols) = body.request.cols {
            spec.cols = cols;
        }
        if let Some(rows) = body.request.rows {
            spec.rows = rows;
        }
        return Ok(spec);
    }

    let cols = body.request.cols.unwrap_or(DEFAULT_COLS).max(1);
    let rows = body.request.rows.unwrap_or(DEFAULT_ROWS).max(1);
    let cwd = body
        .cwd
        .clone()
        .or_else(|| env::current_dir().ok())
        .ok_or_else(|| anyhow!("failed to resolve current directory"))?;
    let command_override = body
        .command_override
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| env::var("REVERIE_TERMINAL_DEBUG_COMMAND").ok());
    let shell = env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_owned());
    let mut command = CommandSpec {
        program: PathBuf::from(shell),
        args: Vec::new(),
        cwd,
        env: BTreeMap::new(),
    };
    command
        .env
        .insert("TERM".to_owned(), "xterm-256color".to_owned());
    if let Some(command_override) = command_override {
        command.args.extend(["-lc".to_owned(), command_override]);
    } else {
        command.args.push("-l".to_owned());
    }

    Ok(TerminalSpawnSpec {
        command,
        cols,
        rows,
        title: Some("Browser terminal debug bridge".to_owned()),
    })
}

/// Standard base64 (RFC 4648, with `=` padding). Encode-only: the binary frame
/// bytes go into the SSE `data:` field as base64 because SSE is line-oriented
/// text. The frontend bridge decodes it with the browser's `atob` and feeds the
/// bytes to the same `decodeTerminalFrame` the Tauri Channel path uses. Hand
/// rolled to avoid adding a base64 crate dependency for one call site.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((triple >> 18) & 0x3F) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((triple >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(triple & 0x3F) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn read_http_request(stream: &TcpStream) -> Result<HttpRequest> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut first_line = String::new();
    reader.read_line(&mut first_line)?;
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let path = parts
        .next()
        .unwrap_or("/")
        .split('?')
        .next()
        .unwrap_or("/")
        .to_owned();
    if method.is_empty() {
        bail!("empty HTTP request");
    }

    let mut content_length = 0_usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some(value) = line.strip_prefix("Content-Length:") {
            content_length = value.trim().parse().unwrap_or(0);
        } else if let Some(value) = line.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or(0);
        }
    }

    let mut body = vec![0_u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }

    Ok(HttpRequest { method, path, body })
}

fn parse_json<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes).context("invalid bridge JSON body")
}

fn stream_events(mut stream: TcpStream, rx: Receiver<BridgeEvent>) -> Result<()> {
    write!(
        stream,
        "HTTP/1.1 200 OK\r\n\
         Content-Type: text/event-stream\r\n\
         Cache-Control: no-cache\r\n\
         Connection: keep-alive\r\n\
         Access-Control-Allow-Origin: *\r\n\r\n"
    )?;
    stream.flush()?;

    for event in rx {
        // `event.data` is already the SSE data body: a JSON string for lifecycle
        // events, base64 of the wire bytes for the binary frame stream.
        write!(stream, "event: {}\ndata: {}\n\n", event.name, event.data)?;
        if stream.flush().is_err() {
            break;
        }
    }
    Ok(())
}

fn write_json_response<T: Serialize>(stream: &mut TcpStream, value: &T) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    write_response(stream, 200, "application/json", &body)
}

fn write_text_response(stream: &mut TcpStream, status: u16, value: &str) -> Result<()> {
    write_response(
        stream,
        status,
        "text/plain; charset=utf-8",
        value.as_bytes(),
    )
}

fn write_empty_response(stream: &mut TcpStream, status: u16) -> Result<()> {
    write_response(stream, status, "text/plain; charset=utf-8", b"")
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<()> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        404 => "Not Found",
        _ => "OK",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET,POST,OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type\r\n\
         Connection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()?;
    Ok(())
}
