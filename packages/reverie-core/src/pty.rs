use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, bail};
use portable_pty::{Child, CommandBuilder, ExitStatus, MasterPty, PtySize, native_pty_system};

use crate::agents::CommandSpec;
use crate::terminal::{TerminalId, TerminalSpawnSpec};

/// Runtime-owned PTY process handle.
///
/// This intentionally stays below Reverie's product/session model: it knows how
/// to run bytes through a PTY, but it does not know what an agent session means,
/// how native CLI restore works, or how terminal frames are rendered.
pub struct PtyProcess {
    terminal_id: TerminalId,
    size: Arc<Mutex<PtySize>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child: SharedChild,
    reader: Box<dyn Read + Send>,
    writer: SharedWriter,
}

type SharedChild = Arc<Mutex<Box<dyn Child + Send + Sync>>>;
type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// Read-side PTY ownership for the runtime output loop.
///
/// The reader is intentionally separate from [`PtyController`] so the app layer
/// can keep a blocking read loop alive while UI commands still write input,
/// resize, or terminate the process through the controller.
pub struct PtyReader {
    terminal_id: TerminalId,
    reader: Box<dyn Read + Send>,
    child: SharedChild,
}

/// Control-side PTY ownership for app/session commands.
#[derive(Clone)]
pub struct PtyController {
    terminal_id: TerminalId,
    size: Arc<Mutex<PtySize>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child: SharedChild,
    writer: SharedWriter,
}

impl PtyProcess {
    pub fn spawn(terminal_id: TerminalId, spec: &TerminalSpawnSpec) -> Result<Self> {
        let size = pty_size(spec.cols, spec.rows);
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(size)
            .context("failed to open PTY pair")?;

        let command = command_builder(&spec.command);
        let child = pair.slave.spawn_command(command).with_context(|| {
            format!("failed to spawn PTY command for {:?}", spec.command.program)
        })?;
        let reader = pair
            .master
            .try_clone_reader()
            .context("failed to clone PTY reader")?;
        let writer = pair
            .master
            .take_writer()
            .context("failed to take PTY writer")?;

        Ok(Self {
            terminal_id,
            size: Arc::new(Mutex::new(size)),
            master: Arc::new(Mutex::new(pair.master)),
            child: Arc::new(Mutex::new(child)),
            reader,
            writer: Arc::new(Mutex::new(writer)),
        })
    }

    pub fn terminal_id(&self) -> TerminalId {
        self.terminal_id
    }

    pub fn size(&self) -> PtySize {
        *self
            .size
            .lock()
            .expect("PTY size lock should not be poisoned")
    }

    /// Split blocking output reads from command/control operations.
    pub fn split(self) -> (PtyReader, PtyController) {
        let controller = PtyController {
            terminal_id: self.terminal_id,
            size: Arc::clone(&self.size),
            master: Arc::clone(&self.master),
            child: Arc::clone(&self.child),
            writer: Arc::clone(&self.writer),
        };
        let reader = PtyReader {
            terminal_id: self.terminal_id,
            reader: self.reader,
            child: self.child,
        };

        (reader, controller)
    }

    /// Blocking read from the PTY output stream.
    ///
    /// App-layer runtimes should call this from a dedicated reader task/thread
    /// and feed the bytes into the terminal renderer backend.
    pub fn read_chunk(&mut self, buf: &mut [u8]) -> Result<usize> {
        self.reader.read(buf).context("failed to read from PTY")
    }

    pub fn write_input(&mut self, bytes: &[u8]) -> Result<()> {
        write_input(&self.writer, bytes)
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        resize_pty(&self.master, &self.size, cols, rows)
    }

    pub fn try_wait(&mut self) -> Result<Option<ExitStatus>> {
        try_wait_child(&self.child)
    }

    pub fn wait(&mut self) -> Result<ExitStatus> {
        wait_child(&self.child)
    }

    pub fn terminate(&mut self) -> Result<()> {
        terminate_child(&self.child)
    }
}

impl PtyReader {
    pub fn terminal_id(&self) -> TerminalId {
        self.terminal_id
    }

    pub fn read_chunk(&mut self, buf: &mut [u8]) -> Result<usize> {
        self.reader.read(buf).context("failed to read from PTY")
    }

    pub fn wait(&mut self) -> Result<ExitStatus> {
        wait_child(&self.child)
    }
}

impl PtyController {
    pub fn terminal_id(&self) -> TerminalId {
        self.terminal_id
    }

    pub fn size(&self) -> PtySize {
        *self
            .size
            .lock()
            .expect("PTY size lock should not be poisoned")
    }

    pub fn write_input(&self, bytes: &[u8]) -> Result<()> {
        write_input(&self.writer, bytes)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        resize_pty(&self.master, &self.size, cols, rows)
    }

    pub fn try_wait(&self) -> Result<Option<ExitStatus>> {
        try_wait_child(&self.child)
    }

    pub fn terminate(&self) -> Result<()> {
        terminate_child(&self.child)
    }
}

fn write_input(writer: &SharedWriter, bytes: &[u8]) -> Result<()> {
    let mut writer = writer
        .lock()
        .map_err(|_| anyhow::anyhow!("PTY writer lock is poisoned"))?;
    writer
        .write_all(bytes)
        .context("failed to write input to PTY")?;
    writer.flush().context("failed to flush PTY input")
}

fn resize_pty(
    master: &Arc<Mutex<Box<dyn MasterPty + Send>>>,
    size: &Arc<Mutex<PtySize>>,
    cols: u16,
    rows: u16,
) -> Result<()> {
    if cols == 0 || rows == 0 {
        bail!("PTY resize requires non-zero cols and rows");
    }

    let next_size = pty_size(cols, rows);
    master
        .lock()
        .map_err(|_| anyhow::anyhow!("PTY master lock is poisoned"))?
        .resize(next_size)
        .context("failed to resize PTY")?;
    *size
        .lock()
        .map_err(|_| anyhow::anyhow!("PTY size lock is poisoned"))? = next_size;
    Ok(())
}

fn try_wait_child(child: &SharedChild) -> Result<Option<ExitStatus>> {
    child
        .lock()
        .map_err(|_| anyhow::anyhow!("PTY child lock is poisoned"))?
        .try_wait()
        .context("failed to poll PTY child")
}

fn wait_child(child: &SharedChild) -> Result<ExitStatus> {
    child
        .lock()
        .map_err(|_| anyhow::anyhow!("PTY child lock is poisoned"))?
        .wait()
        .context("failed waiting for PTY child")
}

fn terminate_child(child: &SharedChild) -> Result<()> {
    child
        .lock()
        .map_err(|_| anyhow::anyhow!("PTY child lock is poisoned"))?
        .kill()
        .context("failed to terminate PTY child")
}

pub fn command_builder(spec: &CommandSpec) -> CommandBuilder {
    let mut command = CommandBuilder::new(spec.program.as_os_str());
    command.args(spec.args.iter().map(String::as_str));
    command.cwd(spec.cwd.as_os_str());
    apply_terminal_env_defaults(&mut command, spec);

    for (key, value) in &spec.env {
        command.env(key, value);
    }

    command
}

fn apply_terminal_env_defaults(command: &mut CommandBuilder, spec: &CommandSpec) {
    if !spec.env.contains_key("TERM") {
        command.env("TERM", "xterm-256color");
    }
    if !spec.env.contains_key("COLORTERM") {
        command.env("COLORTERM", "truecolor");
    }
    if !spec.env.contains_key("TERM_PROGRAM") {
        command.env("TERM_PROGRAM", "Reverie");
    }
}

pub fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn command_builder_preserves_program_args_cwd_and_env() {
        let command = CommandSpec::new("cortex", "/tmp/reverie").with_args(["--resume", "abc-123"]);
        let mut command = command;
        command
            .env
            .insert("REVERIE_SESSION_ID".to_owned(), "session-1".to_owned());

        let builder = command_builder(&command);
        let argv = builder.get_argv();

        assert_eq!(argv[0], PathBuf::from("cortex").into_os_string());
        assert_eq!(argv[1], "--resume");
        assert_eq!(argv[2], "abc-123");
        assert_eq!(
            builder.get_cwd(),
            Some(&PathBuf::from("/tmp/reverie").into_os_string())
        );
        assert_eq!(
            builder.get_env("REVERIE_SESSION_ID"),
            Some("session-1".as_ref())
        );
    }

    #[test]
    fn command_builder_advertises_color_capable_terminal_by_default() {
        let command = CommandSpec::new("cortex", "/tmp/reverie");
        let builder = command_builder(&command);

        assert_eq!(builder.get_env("TERM"), Some("xterm-256color".as_ref()));
        assert_eq!(builder.get_env("COLORTERM"), Some("truecolor".as_ref()));
        assert_eq!(builder.get_env("TERM_PROGRAM"), Some("Reverie".as_ref()));
    }

    #[test]
    fn command_builder_preserves_explicit_terminal_env_overrides() {
        let mut command = CommandSpec::new("cortex", "/tmp/reverie");
        command.env.insert("TERM".to_owned(), "vt100".to_owned());
        command
            .env
            .insert("COLORTERM".to_owned(), "false".to_owned());
        command
            .env
            .insert("TERM_PROGRAM".to_owned(), "CustomTerm".to_owned());
        let builder = command_builder(&command);

        assert_eq!(builder.get_env("TERM"), Some("vt100".as_ref()));
        assert_eq!(builder.get_env("COLORTERM"), Some("false".as_ref()));
        assert_eq!(builder.get_env("TERM_PROGRAM"), Some("CustomTerm".as_ref()));
    }

    #[test]
    fn pty_size_uses_terminal_cells_not_pixels() {
        let size = pty_size(132, 43);

        assert_eq!(size.cols, 132);
        assert_eq!(size.rows, 43);
        assert_eq!(size.pixel_width, 0);
        assert_eq!(size.pixel_height, 0);
    }

    #[test]
    fn split_reader_accepts_control_input_and_resize() {
        let command = CommandSpec::new("/bin/sh", "/tmp").with_args([
            "-lc",
            "printf 'ready\\n'; IFS= read line; printf 'got:%s\\n' \"$line\"",
        ]);
        let mut spec = TerminalSpawnSpec::new(command);
        spec.cols = 80;
        spec.rows = 24;

        let process =
            PtyProcess::spawn(TerminalId::new_v4(), &spec).expect("PTY process should spawn");
        let (mut reader, controller) = process.split();
        let (tx, rx) = mpsc::channel();

        let handle = std::thread::spawn(move || {
            let mut output = Vec::new();
            let mut buf = [0_u8; 512];
            while !String::from_utf8_lossy(&output).contains("got:hello from canvas") {
                let bytes_read = reader
                    .read_chunk(&mut buf)
                    .expect("PTY read should succeed");
                if bytes_read == 0 {
                    break;
                }
                output.extend_from_slice(&buf[..bytes_read]);
            }
            let output = String::from_utf8_lossy(&output).into_owned();
            tx.send(output)
                .expect("test receiver should still be waiting");
            let _ = reader.wait();
        });

        std::thread::sleep(Duration::from_millis(50));
        controller
            .resize(100, 30)
            .expect("PTY resize should succeed");
        assert_eq!(controller.size().cols, 100);
        assert_eq!(controller.size().rows, 30);
        controller
            .write_input(b"hello from canvas\r")
            .expect("PTY controller should write input");

        let output = match rx.recv_timeout(Duration::from_secs(3)) {
            Ok(output) => output,
            Err(error) => {
                let _ = controller.terminate();
                panic!("timed out waiting for PTY output: {error}");
            }
        };

        assert!(output.contains("ready"), "output was: {output:?}");
        assert!(
            output.contains("got:hello from canvas"),
            "output was: {output:?}"
        );
        handle.join().expect("PTY reader thread should finish");
    }
}
