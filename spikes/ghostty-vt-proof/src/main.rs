use std::io::{Read, Write};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use libghostty_vt::render::{CellIterator, CursorVisualStyle, Dirty, RowIterator};
use libghostty_vt::style::{RgbColor, Style, Underline as GhosttyUnderline};
use libghostty_vt::{RenderState, Terminal, TerminalOptions};
use portable_pty::{CommandBuilder, ExitStatus, PtySize, native_pty_system};
use reverie_core::terminal::{
    TerminalCell, TerminalCellStyle, TerminalColor, TerminalColors, TerminalCursor,
    TerminalCursorStyle, TerminalDirtyState, TerminalFrame, TerminalPosition, TerminalRow,
    TerminalUnderline,
};

const COLS: u16 = 64;
const ROWS: u16 = 12;
const LIVE_COLS: u16 = 72;
const LIVE_ROWS: u16 = 14;
const INPUT_COLS: u16 = 72;
const INPUT_ROWS: u16 = 14;
const RESIZE_INITIAL_COLS: u16 = 24;
const RESIZE_WIDE_COLS: u16 = 48;
const RESIZE_ROWS: u16 = 8;
const SUSTAINED_COLS: u16 = 96;
const SUSTAINED_ROWS: u16 = 18;
const SUSTAINED_LINE_COUNT: usize = 2_000;
const CELL_WIDTH_PX: u32 = 9;
const CELL_HEIGHT_PX: u32 = 18;

#[derive(Debug)]
struct SustainedOutputProof {
    child_success: bool,
    output_bytes: usize,
    read_events: usize,
    max_chunk_bytes: usize,
    line_count: usize,
    pty_size: PtySize,
    frame: ProofFrame,
}

#[derive(Debug)]
struct ProofFrame {
    label: &'static str,
    cols: u16,
    rows: u16,
    frame: TerminalFrame,
}

#[derive(Debug)]
struct LivePtyProof {
    child_success: bool,
    output_bytes: usize,
    pty_size: PtySize,
    frame: ProofFrame,
}

#[derive(Debug)]
struct InputPtyProof {
    child_success: bool,
    input_bytes: usize,
    output_bytes: usize,
    pty_size: PtySize,
    frame: ProofFrame,
}

#[derive(Debug)]
struct ResizeReflowProof {
    child_success: bool,
    output_bytes: usize,
    initial_pty_size: PtySize,
    resized_pty_size: PtySize,
    initial_non_empty_rows: usize,
    resized_non_empty_rows: usize,
    initial_frame: ProofFrame,
    resized_frame: ProofFrame,
}

fn main() -> Result<()> {
    let mut static_terminal = Terminal::new(TerminalOptions {
        cols: COLS,
        rows: ROWS,
        max_scrollback: 1_000,
    })?;
    let mut static_render_state = RenderState::new()?;

    feed_static_vt(&mut static_terminal);

    let static_frame = extract_frame(
        "Ghostty VT static render proof",
        &mut static_render_state,
        &static_terminal,
    )?;
    print_frame(&static_frame);

    let live = run_live_pty_proof()?;
    println!(
        "\nLive PTY proof: success={} bytes={} pty={}x{}",
        live.child_success, live.output_bytes, live.pty_size.cols, live.pty_size.rows
    );
    print_frame(&live.frame);

    let input = run_interactive_pty_input_proof()?;
    println!(
        "\nInteractive PTY input proof: success={} input_bytes={} output_bytes={} pty={}x{}",
        input.child_success,
        input.input_bytes,
        input.output_bytes,
        input.pty_size.cols,
        input.pty_size.rows
    );
    print_frame(&input.frame);

    let resize = run_resize_reflow_proof()?;
    println!(
        "\nResize/reflow proof: success={} bytes={} pty {}x{} -> {}x{} non_empty_rows {} -> {}",
        resize.child_success,
        resize.output_bytes,
        resize.initial_pty_size.cols,
        resize.initial_pty_size.rows,
        resize.resized_pty_size.cols,
        resize.resized_pty_size.rows,
        resize.initial_non_empty_rows,
        resize.resized_non_empty_rows
    );
    print_frame(&resize.initial_frame);
    print_frame(&resize.resized_frame);

    run_long_lived_process_lifecycle_proof()?;

    let sustained = run_sustained_output_backpressure_proof()?;
    println!(
        "\nSustained output/backpressure proof: success={} bytes={} events={} max_chunk={} lines={} pty={}x{}",
        sustained.child_success,
        sustained.output_bytes,
        sustained.read_events,
        sustained.max_chunk_bytes,
        sustained.line_count,
        sustained.pty_size.cols,
        sustained.pty_size.rows
    );
    print_frame(&sustained.frame);

    Ok(())
}

fn feed_static_vt(terminal: &mut Terminal<'_, '_>) {
    terminal.vt_write(b"Reverie Ghostty VT proof\r\n");
    terminal.vt_write(b"plain text before ");
    terminal.vt_write(b"\x1b[1;32mbold green\x1b[0m");
    terminal.vt_write(b" and ");
    terminal.vt_write(b"\x1b[38;2;255;128;0mtruecolor orange\x1b[0m\r\n");
    terminal.vt_write("unicode: cafe\u{0301}, rocket 🚀, emdash —\r\n".as_bytes());
    terminal.vt_write(b"\x1b[4munderlined\x1b[0m plus normal text\r\n");
    terminal.vt_write(b"\x1b[6;10Hcursor landing zone");
    terminal.vt_write(b"\x1b[5 q");
}

fn run_live_pty_proof() -> Result<LivePtyProof> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: LIVE_ROWS,
        cols: LIVE_COLS,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    pair.master.resize(PtySize {
        rows: LIVE_ROWS,
        cols: LIVE_COLS,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let reader = pair.master.try_clone_reader()?;
    let read_events = spawn_pty_reader(reader);

    let mut command = CommandBuilder::new("/bin/sh");
    command.arg("-lc");
    command.arg(
        r#"printf 'live pty start\r\n'; printf '\033[1;35mghostty colored pty\033[0m\r\n'; printf 'unicode: café 🚀 —\r\n'; printf '\033[4mpty complete\033[0m\r\n'; printf '\033[5 q'"#,
    );

    let mut child = pair.slave.spawn_command(command)?;
    drop(pair.slave);

    let mut output = Vec::new();
    let status = wait_for_child(
        &mut child,
        &read_events,
        &mut output,
        Duration::from_secs(3),
    )
    .context("live PTY child did not exit cleanly")?;
    drain_reader_after_exit(&read_events, &mut output, Duration::from_millis(500))?;

    if output.is_empty() {
        bail!("live PTY process exited without producing output");
    }

    let pty_size = pair.master.get_size()?;
    let mut terminal = Terminal::new(TerminalOptions {
        cols: LIVE_COLS,
        rows: LIVE_ROWS,
        max_scrollback: 1_000,
    })?;
    terminal.vt_write(&output);

    let mut render_state = RenderState::new()?;
    let frame = extract_frame(
        "Ghostty VT live PTY render proof",
        &mut render_state,
        &terminal,
    )?;

    Ok(LivePtyProof {
        child_success: status.success(),
        output_bytes: output.len(),
        pty_size,
        frame,
    })
}

fn run_interactive_pty_input_proof() -> Result<InputPtyProof> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: INPUT_ROWS,
        cols: INPUT_COLS,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    pair.master.resize(PtySize {
        rows: INPUT_ROWS,
        cols: INPUT_COLS,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let reader = pair.master.try_clone_reader()?;
    let read_events = spawn_pty_reader(reader);
    let mut writer = pair.master.take_writer()?;

    let command = CommandBuilder::new("/bin/cat");
    let mut child = pair.slave.spawn_command(command)?;
    drop(pair.slave);

    let input = b"reverie input echo proof\r\ninteractive bytes crossed the PTY boundary\r\n";
    writer.write_all(input)?;
    writer.write_all(&[0x04])?;
    writer.flush()?;
    drop(writer);

    let mut output = Vec::new();
    let status = wait_for_child(
        &mut child,
        &read_events,
        &mut output,
        Duration::from_secs(3),
    )
    .context("interactive PTY input child did not exit cleanly")?;
    drain_reader_after_exit(&read_events, &mut output, Duration::from_millis(500))?;

    let output_text = String::from_utf8_lossy(&output);
    if !output_text.contains("reverie input echo proof") {
        bail!("interactive PTY output did not include the first input line: {output_text:?}");
    }
    if !output_text.contains("interactive bytes crossed the PTY boundary") {
        bail!("interactive PTY output did not include the second input line: {output_text:?}");
    }

    let pty_size = pair.master.get_size()?;
    let mut terminal = Terminal::new(TerminalOptions {
        cols: INPUT_COLS,
        rows: INPUT_ROWS,
        max_scrollback: 1_000,
    })?;
    terminal.vt_write(&output);

    let mut render_state = RenderState::new()?;
    let frame = extract_frame(
        "Ghostty VT interactive PTY input proof",
        &mut render_state,
        &terminal,
    )?;

    Ok(InputPtyProof {
        child_success: status.success(),
        input_bytes: input.len() + 1,
        output_bytes: output.len(),
        pty_size,
        frame,
    })
}

fn run_resize_reflow_proof() -> Result<ResizeReflowProof> {
    let line = "reverie resize reflow proof keeps wrapped text intact across terminal shape change";
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: RESIZE_ROWS,
        cols: RESIZE_INITIAL_COLS,
        pixel_width: RESIZE_INITIAL_COLS as u16 * CELL_WIDTH_PX as u16,
        pixel_height: RESIZE_ROWS as u16 * CELL_HEIGHT_PX as u16,
    })?;

    pair.master.resize(PtySize {
        rows: RESIZE_ROWS,
        cols: RESIZE_INITIAL_COLS,
        pixel_width: RESIZE_INITIAL_COLS as u16 * CELL_WIDTH_PX as u16,
        pixel_height: RESIZE_ROWS as u16 * CELL_HEIGHT_PX as u16,
    })?;

    let reader = pair.master.try_clone_reader()?;
    let read_events = spawn_pty_reader(reader);

    let mut command = CommandBuilder::new("/bin/sh");
    command.arg("-lc");
    command.arg(format!("printf '%s' {}", shell_quote(line)));

    let mut child = pair.slave.spawn_command(command)?;
    drop(pair.slave);

    let mut output = Vec::new();
    let status = wait_for_child(
        &mut child,
        &read_events,
        &mut output,
        Duration::from_secs(3),
    )
    .context("resize/reflow PTY child did not exit cleanly")?;
    drain_reader_after_exit(&read_events, &mut output, Duration::from_millis(500))?;

    if output.is_empty() {
        bail!("resize/reflow PTY process exited without producing output");
    }

    let initial_pty_size = pair.master.get_size()?;
    let mut terminal = Terminal::new(TerminalOptions {
        cols: RESIZE_INITIAL_COLS,
        rows: RESIZE_ROWS,
        max_scrollback: 1_000,
    })?;
    terminal.vt_write(&output);

    let mut render_state = RenderState::new()?;
    let initial_frame = extract_frame(
        "Ghostty VT resize/reflow proof before resize",
        &mut render_state,
        &terminal,
    )?;
    let initial_non_empty_rows = count_non_empty_rows(&initial_frame);

    pair.master.resize(PtySize {
        rows: RESIZE_ROWS,
        cols: RESIZE_WIDE_COLS,
        pixel_width: RESIZE_WIDE_COLS as u16 * CELL_WIDTH_PX as u16,
        pixel_height: RESIZE_ROWS as u16 * CELL_HEIGHT_PX as u16,
    })?;
    terminal.resize(RESIZE_WIDE_COLS, RESIZE_ROWS, CELL_WIDTH_PX, CELL_HEIGHT_PX)?;

    let resized_pty_size = pair.master.get_size()?;
    let resized_frame = extract_frame(
        "Ghostty VT resize/reflow proof after resize",
        &mut render_state,
        &terminal,
    )?;
    let resized_non_empty_rows = count_non_empty_rows(&resized_frame);

    let compact_output = compact_text(line);
    let initial_text = compact_text(&frame_text(&initial_frame));
    let resized_text = compact_text(&frame_text(&resized_frame));

    if !initial_text.contains(&compact_output) {
        bail!("initial resized proof frame lost wrapped text: {initial_text:?}");
    }
    if !resized_text.contains(&compact_output) {
        bail!("resized proof frame lost wrapped text: {resized_text:?}");
    }
    if initial_non_empty_rows <= resized_non_empty_rows {
        bail!(
            "expected wider resize to reduce wrapped rows, but rows were {initial_non_empty_rows} -> {resized_non_empty_rows}"
        );
    }
    if resized_pty_size.cols != RESIZE_WIDE_COLS || resized_pty_size.rows != RESIZE_ROWS {
        bail!(
            "PTY did not report resized shape: got {}x{}",
            resized_pty_size.cols,
            resized_pty_size.rows
        );
    }

    Ok(ResizeReflowProof {
        child_success: status.success(),
        output_bytes: output.len(),
        initial_pty_size,
        resized_pty_size,
        initial_non_empty_rows,
        resized_non_empty_rows,
        initial_frame,
        resized_frame,
    })
}

fn run_long_lived_process_lifecycle_proof() -> Result<()> {
    let cols = 72;
    let rows = 14;
    let first_marker = "long lived process first write";
    let second_marker = "long lived process second write before eof";
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    pair.master.resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let reader = pair.master.try_clone_reader()?;
    let read_events = spawn_pty_reader(reader);
    let mut writer = pair.master.take_writer()?;
    let command = CommandBuilder::new("/bin/cat");
    let mut child = pair.slave.spawn_command(command)?;
    drop(pair.slave);

    let mut terminal = Terminal::new(TerminalOptions {
        cols,
        rows,
        max_scrollback: 1_000,
    })?;
    let mut render_state = RenderState::new()?;

    let first_input = format!("{first_marker}\r\n");
    writer.write_all(first_input.as_bytes())?;
    writer.flush()?;

    let mut first_output = Vec::new();
    wait_for_output_contains(
        &read_events,
        &mut first_output,
        first_marker,
        Duration::from_secs(3),
    )?;
    terminal.vt_write(&first_output);

    let first_frame = extract_frame(
        "Ghostty VT long-lived process proof after first write",
        &mut render_state,
        &terminal,
    )?;

    if child.try_wait()?.is_some() {
        bail!("long-lived PTY child exited before second write");
    }

    let second_input = format!("{second_marker}\r\n");
    writer.write_all(second_input.as_bytes())?;
    writer.write_all(&[0x04])?;
    writer.flush()?;
    drop(writer);

    let mut remaining_output = Vec::new();
    let status = wait_for_child(
        &mut child,
        &read_events,
        &mut remaining_output,
        Duration::from_secs(3),
    )
    .context("long-lived PTY child did not exit cleanly")?;
    drain_reader_after_exit(
        &read_events,
        &mut remaining_output,
        Duration::from_millis(500),
    )?;
    terminal.vt_write(&remaining_output);

    let final_frame = extract_frame(
        "Ghostty VT long-lived process proof after EOF",
        &mut render_state,
        &terminal,
    )?;
    let final_text = frame_text(&final_frame);

    if !status.success() {
        bail!("long-lived PTY child exited unsuccessfully");
    }
    if !final_text.contains(first_marker) || !final_text.contains(second_marker) {
        bail!("long-lived process frame lost expected text: {final_text:?}");
    }

    println!(
        "\nLong-lived process proof: success={} first_bytes={} remaining_bytes={} pty={}x{}",
        status.success(),
        first_output.len(),
        remaining_output.len(),
        cols,
        rows
    );
    print_frame(&first_frame);
    print_frame(&final_frame);

    Ok(())
}

fn run_sustained_output_backpressure_proof() -> Result<SustainedOutputProof> {
    let start_marker = "sustained-output-start";
    let middle_marker = format!("sustained-output-line-{:04}", SUSTAINED_LINE_COUNT / 2);
    let end_marker = format!("sustained-output-line-{SUSTAINED_LINE_COUNT:04}");
    let complete_marker = "sustained-output-complete";
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: SUSTAINED_ROWS,
        cols: SUSTAINED_COLS,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    pair.master.resize(PtySize {
        rows: SUSTAINED_ROWS,
        cols: SUSTAINED_COLS,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let reader = pair.master.try_clone_reader()?;
    let read_events = spawn_pty_reader(reader);

    let script = format!(
        "printf '{start_marker}\\r\\n'; i=1; while [ $i -le {SUSTAINED_LINE_COUNT} ]; do printf 'sustained-output-line-%04d payload abcdefghijklmnopqrstuvwxyz 0123456789\\r\\n' \"$i\"; i=$((i + 1)); done; printf '{complete_marker}\\r\\n'"
    );
    let mut command = CommandBuilder::new("/bin/sh");
    command.arg("-lc");
    command.arg(script);

    let mut child = pair.slave.spawn_command(command)?;
    drop(pair.slave);

    let mut output = Vec::new();
    let mut read_events_count = 0_usize;
    let mut max_chunk_bytes = 0_usize;
    let status = wait_for_child_with_read_stats(
        &mut child,
        &read_events,
        &mut output,
        &mut read_events_count,
        &mut max_chunk_bytes,
        Duration::from_secs(10),
    )
    .context("sustained output PTY child did not exit cleanly")?;
    drain_reader_after_exit_with_stats(
        &read_events,
        &mut output,
        &mut read_events_count,
        &mut max_chunk_bytes,
        Duration::from_millis(500),
    )?;

    if output.is_empty() {
        bail!("sustained output PTY process exited without producing output");
    }

    let output_text = String::from_utf8_lossy(&output);
    if !output_text.contains(start_marker) {
        bail!("sustained output missed start marker");
    }
    if !output_text.contains(&middle_marker) {
        bail!("sustained output missed middle marker {middle_marker:?}");
    }
    if !output_text.contains(&end_marker) {
        bail!("sustained output missed final numbered marker {end_marker:?}");
    }
    if !output_text.contains(complete_marker) {
        bail!("sustained output missed completion marker");
    }

    let line_count = output_text
        .lines()
        .filter(|line| line.contains("sustained-output-line-"))
        .count();
    if line_count != SUSTAINED_LINE_COUNT {
        bail!(
            "sustained output line count mismatch: expected {SUSTAINED_LINE_COUNT}, got {line_count}"
        );
    }
    if read_events_count < 2 {
        bail!("sustained output arrived in too few read events to exercise reader draining");
    }

    let pty_size = pair.master.get_size()?;
    let mut terminal = Terminal::new(TerminalOptions {
        cols: SUSTAINED_COLS,
        rows: SUSTAINED_ROWS,
        max_scrollback: SUSTAINED_LINE_COUNT + SUSTAINED_ROWS as usize + 100,
    })?;
    terminal.vt_write(&output);

    let mut render_state = RenderState::new()?;
    let frame = extract_frame(
        "Ghostty VT sustained output/backpressure proof",
        &mut render_state,
        &terminal,
    )?;
    let frame_text = frame_text(&frame);

    if !frame_text.contains(complete_marker) {
        bail!("sustained output completion marker did not render in final frame: {frame_text:?}");
    }

    Ok(SustainedOutputProof {
        child_success: status.success(),
        output_bytes: output.len(),
        read_events: read_events_count,
        max_chunk_bytes,
        line_count,
        pty_size,
        frame,
    })
}

fn wait_for_output_contains(
    read_events: &Receiver<PtyReadEvent>,
    output: &mut Vec<u8>,
    marker: &str,
    timeout: Duration,
) -> Result<()> {
    let started = Instant::now();

    loop {
        let text = String::from_utf8_lossy(output);
        if text.contains(marker) {
            return Ok(());
        }

        if started.elapsed() > timeout {
            bail!("timed out waiting for PTY output marker {marker:?}; got {text:?}");
        }

        match read_events.recv_timeout(Duration::from_millis(10)) {
            Ok(PtyReadEvent::Data(bytes)) => output.extend(bytes),
            Ok(PtyReadEvent::Eof) => bail!("PTY reader reached EOF before marker {marker:?}"),
            Ok(PtyReadEvent::Error(err)) => bail!("PTY reader failed: {err}"),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                bail!("PTY reader disconnected before marker {marker:?}")
            }
        }
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r#"'\''"#))
}

#[derive(Debug)]
enum PtyReadEvent {
    Data(Vec<u8>),
    Eof,
    Error(String),
}

fn spawn_pty_reader(mut reader: Box<dyn Read + Send>) -> Receiver<PtyReadEvent> {
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let mut buf = [0_u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.send(PtyReadEvent::Eof);
                    break;
                }
                Ok(n) => {
                    if tx.send(PtyReadEvent::Data(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(err) => {
                    let _ = tx.send(PtyReadEvent::Error(err.to_string()));
                    break;
                }
            }
        }
    });

    rx
}

fn wait_for_child(
    child: &mut Box<dyn portable_pty::Child + Send + Sync>,
    read_events: &Receiver<PtyReadEvent>,
    output: &mut Vec<u8>,
    timeout: Duration,
) -> Result<ExitStatus> {
    let started = Instant::now();

    loop {
        drain_available_reader_events(read_events, output)?;

        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }

        if started.elapsed() > timeout {
            let _ = child.kill();
            bail!("timed out waiting for live PTY child to exit");
        }

        thread::sleep(Duration::from_millis(10));
    }
}

fn drain_reader_after_exit(
    read_events: &Receiver<PtyReadEvent>,
    output: &mut Vec<u8>,
    idle_timeout: Duration,
) -> Result<()> {
    loop {
        match read_events.recv_timeout(idle_timeout) {
            Ok(PtyReadEvent::Data(bytes)) => output.extend(bytes),
            Ok(PtyReadEvent::Eof) => return Ok(()),
            Ok(PtyReadEvent::Error(err)) => bail!("PTY reader failed: {err}"),
            Err(mpsc::RecvTimeoutError::Timeout) => return Ok(()),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

fn wait_for_child_with_read_stats(
    child: &mut Box<dyn portable_pty::Child + Send + Sync>,
    read_events: &Receiver<PtyReadEvent>,
    output: &mut Vec<u8>,
    read_events_count: &mut usize,
    max_chunk_bytes: &mut usize,
    timeout: Duration,
) -> Result<ExitStatus> {
    let started = Instant::now();

    loop {
        drain_available_reader_events_with_stats(
            read_events,
            output,
            read_events_count,
            max_chunk_bytes,
        )?;

        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }

        if started.elapsed() > timeout {
            let _ = child.kill();
            bail!("timed out waiting for sustained output PTY child to exit");
        }

        thread::sleep(Duration::from_millis(10));
    }
}

fn drain_reader_after_exit_with_stats(
    read_events: &Receiver<PtyReadEvent>,
    output: &mut Vec<u8>,
    read_events_count: &mut usize,
    max_chunk_bytes: &mut usize,
    idle_timeout: Duration,
) -> Result<()> {
    loop {
        match read_events.recv_timeout(idle_timeout) {
            Ok(PtyReadEvent::Data(bytes)) => {
                *read_events_count += 1;
                *max_chunk_bytes = (*max_chunk_bytes).max(bytes.len());
                output.extend(bytes);
            }
            Ok(PtyReadEvent::Eof) => return Ok(()),
            Ok(PtyReadEvent::Error(err)) => bail!("PTY reader failed: {err}"),
            Err(mpsc::RecvTimeoutError::Timeout) => return Ok(()),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

fn drain_available_reader_events(
    read_events: &Receiver<PtyReadEvent>,
    output: &mut Vec<u8>,
) -> Result<()> {
    loop {
        match read_events.try_recv() {
            Ok(PtyReadEvent::Data(bytes)) => output.extend(bytes),
            Ok(PtyReadEvent::Eof) => return Ok(()),
            Ok(PtyReadEvent::Error(err)) => bail!("PTY reader failed: {err}"),
            Err(mpsc::TryRecvError::Empty) => return Ok(()),
            Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
        }
    }
}

fn drain_available_reader_events_with_stats(
    read_events: &Receiver<PtyReadEvent>,
    output: &mut Vec<u8>,
    read_events_count: &mut usize,
    max_chunk_bytes: &mut usize,
) -> Result<()> {
    loop {
        match read_events.try_recv() {
            Ok(PtyReadEvent::Data(bytes)) => {
                *read_events_count += 1;
                *max_chunk_bytes = (*max_chunk_bytes).max(bytes.len());
                output.extend(bytes);
            }
            Ok(PtyReadEvent::Eof) => return Ok(()),
            Ok(PtyReadEvent::Error(err)) => bail!("PTY reader failed: {err}"),
            Err(mpsc::TryRecvError::Empty) => return Ok(()),
            Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
        }
    }
}

fn extract_frame<'alloc, 'cb>(
    label: &'static str,
    render_state: &mut RenderState<'alloc>,
    terminal: &Terminal<'alloc, 'cb>,
) -> Result<ProofFrame> {
    let snapshot = render_state.update(terminal)?;
    let colors = snapshot.colors()?;
    let cursor_viewport = snapshot.cursor_viewport()?;

    let cursor = TerminalCursor {
        visible: snapshot.cursor_visible()?,
        blinking: snapshot.cursor_blinking()?,
        style: map_cursor_style(snapshot.cursor_visual_style()?),
        position: cursor_viewport
            .filter(|cursor| !cursor.at_wide_tail)
            .map(|cursor| TerminalPosition {
                col: cursor.x,
                row: cursor.y,
            }),
    };

    let mut row_iter = RowIterator::new()?;
    let mut cell_iter = CellIterator::new()?;
    let mut row_iteration = row_iter.update(&snapshot)?;
    let mut rows = Vec::new();
    let mut row_index = 0_u16;

    while let Some(row) = row_iteration.next() {
        let dirty = row.dirty()?;
        let mut cell_iteration = cell_iter.update(row)?;
        let mut cells = Vec::new();
        let mut col = 0_u16;

        while let Some(cell) = cell_iteration.next() {
            let text = cell_text(cell)?;
            let style = cell.style()?;

            cells.push(TerminalCell {
                col,
                text,
                fg: cell.fg_color()?.map(map_color),
                bg: cell.bg_color()?.map(map_color),
                style: map_cell_style(style),
            });

            col = col.saturating_add(1);
        }

        rows.push(TerminalRow {
            index: row_index,
            dirty,
            cells,
        });
        row_index = row_index.saturating_add(1);
    }

    Ok(ProofFrame {
        label,
        cols: snapshot.cols()?,
        rows: snapshot.rows()?,
        frame: TerminalFrame {
            dirty: map_dirty(snapshot.dirty()?),
            colors: TerminalColors {
                foreground: map_color(colors.foreground),
                background: map_color(colors.background),
                cursor: colors.cursor.map(map_color),
            },
            cursor,
            rows,
        },
    })
}

fn cell_text(cell: &libghostty_vt::render::CellIteration<'_, '_>) -> Result<String> {
    if cell.graphemes_len()? == 0 {
        return Ok(" ".to_string());
    }

    Ok(cell.graphemes()?.into_iter().collect())
}

fn map_dirty(dirty: Dirty) -> TerminalDirtyState {
    match dirty {
        Dirty::Clean => TerminalDirtyState::Clean,
        Dirty::Partial => TerminalDirtyState::Partial,
        Dirty::Full => TerminalDirtyState::Full,
    }
}

fn map_color(color: RgbColor) -> TerminalColor {
    TerminalColor {
        r: color.r,
        g: color.g,
        b: color.b,
    }
}

fn map_cursor_style(style: CursorVisualStyle) -> TerminalCursorStyle {
    match style {
        CursorVisualStyle::Block => TerminalCursorStyle::Block,
        CursorVisualStyle::BlockHollow => TerminalCursorStyle::BlockHollow,
        CursorVisualStyle::Bar => TerminalCursorStyle::Bar,
        CursorVisualStyle::Underline => TerminalCursorStyle::Underline,
        _ => TerminalCursorStyle::Block,
    }
}

fn map_cell_style(style: Style) -> TerminalCellStyle {
    TerminalCellStyle {
        bold: style.bold,
        italic: style.italic,
        underline: map_underline(style.underline),
    }
}

fn map_underline(underline: GhosttyUnderline) -> TerminalUnderline {
    match underline {
        GhosttyUnderline::None => TerminalUnderline::None,
        GhosttyUnderline::Single => TerminalUnderline::Single,
        GhosttyUnderline::Double => TerminalUnderline::Double,
        GhosttyUnderline::Curly => TerminalUnderline::Curly,
        GhosttyUnderline::Dotted => TerminalUnderline::Dotted,
        GhosttyUnderline::Dashed => TerminalUnderline::Dashed,
        _ => TerminalUnderline::None,
    }
}

fn count_non_empty_rows(proof: &ProofFrame) -> usize {
    proof
        .frame
        .rows
        .iter()
        .filter(|row| !row.plain_text().trim().is_empty())
        .count()
}

fn frame_text(proof: &ProofFrame) -> String {
    proof
        .frame
        .rows
        .iter()
        .map(|row| row.plain_text())
        .collect::<Vec<_>>()
        .join("\n")
}

fn compact_text(value: &str) -> String {
    value.chars().filter(|ch| !ch.is_whitespace()).collect()
}

fn is_interesting_cell(cell: &TerminalCell) -> bool {
    cell.text.trim().len() > 0
        && (cell.fg.is_some()
            || cell.bg.is_some()
            || cell.style.bold
            || cell.style.italic
            || cell.style.underline != TerminalUnderline::None)
}

fn print_frame(proof: &ProofFrame) {
    let frame = &proof.frame;

    println!("{}", proof.label);
    println!(
        "viewport: {}x{} dirty={:?}",
        proof.cols, proof.rows, frame.dirty
    );
    println!(
        "colors: fg={} bg={} cursor={}",
        rgb(frame.colors.foreground),
        rgb(frame.colors.background),
        frame
            .colors
            .cursor
            .map(rgb)
            .unwrap_or_else(|| "none".to_string())
    );
    println!(
        "cursor: visible={} blinking={} style={:?} position={:?}",
        frame.cursor.visible, frame.cursor.blinking, frame.cursor.style, frame.cursor.position
    );
    println!("\nvisible text:");

    for row in &frame.rows {
        println!(
            "{:02} [{}] {}",
            row.index,
            if row.dirty { "dirty" } else { "clean" },
            row.plain_text().trim_end()
        );
    }

    println!("\nstyled cells:");
    for row in &frame.rows {
        for cell in &row.cells {
            if !is_interesting_cell(cell) {
                continue;
            }

            println!(
                "row={:02} col={:02} text={:?} fg={} bg={} bold={} italic={} underline={:?}",
                row.index,
                cell.col,
                cell.text,
                cell.fg.map(rgb).unwrap_or_else(|| "default".to_string()),
                cell.bg.map(rgb).unwrap_or_else(|| "default".to_string()),
                cell.style.bold,
                cell.style.italic,
                cell.style.underline
            );
        }
    }
}

fn rgb(color: TerminalColor) -> String {
    format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b)
}
