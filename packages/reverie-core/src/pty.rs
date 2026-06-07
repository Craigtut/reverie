use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
    /// OS process id of the spawned child. Because the child is a `setsid`
    /// session leader (portable-pty), this id is also its process-group id, so
    /// signalling the group reaches the agent and everything it spawned.
    pid: Option<u32>,
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
    pid: Option<u32>,
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
        // Snapshot the pid now, while we still own the child directly, so the
        // controller can signal the whole process group on termination.
        let pid = child.process_id();
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
            pid,
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

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Split blocking output reads from command/control operations.
    pub fn split(self) -> (PtyReader, PtyController) {
        let controller = PtyController {
            terminal_id: self.terminal_id,
            size: Arc::clone(&self.size),
            master: Arc::clone(&self.master),
            child: Arc::clone(&self.child),
            pid: self.pid,
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
        terminate_tree_graceful(&self.child, self.pid)
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

    /// Gracefully terminate the session's entire process tree: SIGTERM the
    /// process group, allow a brief grace period to exit cleanly, then SIGKILL
    /// the group if anything is still alive. The child is a `setsid` session
    /// leader (portable-pty), so its pid is the process-group id and a group
    /// signal reaches the agent plus anything it spawned (dev servers, `&`
    /// jobs) instead of orphaning them.
    pub fn terminate(&self) -> Result<()> {
        terminate_tree_graceful(&self.child, self.pid)
    }

    /// Immediately SIGKILL the whole process group with no grace period. Used by
    /// the app-exit backstop, where blocking is not an option.
    pub fn terminate_now(&self) -> Result<()> {
        terminate_tree_now(&self.child, self.pid)
    }

    /// SIGTERM the whole process group without waiting. Batch shutdown signals
    /// every session first, then waits once, then SIGKILLs any stragglers via
    /// [`terminate_now`].
    pub fn request_terminate(&self) {
        group_term(&self.child, self.pid);
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

/// How long a graceful tree-kill waits for SIGTERM to take effect before
/// escalating to SIGKILL.
const TERMINATE_GRACE: Duration = Duration::from_millis(400);
/// How often the grace loop polls the child for exit.
const TERMINATE_POLL: Duration = Duration::from_millis(20);

/// SIGTERM the child's whole process group. Falls back to killing just the
/// direct child if the pid is unknown or the group signal fails.
#[cfg(unix)]
fn group_term(child: &SharedChild, pid: Option<u32>) {
    if let Some(pid) = pid {
        // SAFETY: killpg targets the process group whose id is the setsid
        // leader's pid; it is async-signal-safe and never dereferences memory.
        if unsafe { libc::killpg(pid as libc::pid_t, libc::SIGTERM) } == 0 {
            return;
        }
    }
    let _ = terminate_child(child);
}

/// SIGKILL the child's whole process group. Falls back to killing just the
/// direct child if the pid is unknown or the group signal fails.
#[cfg(unix)]
fn group_kill(child: &SharedChild, pid: Option<u32>) {
    if let Some(pid) = pid {
        if unsafe { libc::killpg(pid as libc::pid_t, libc::SIGKILL) } == 0 {
            return;
        }
    }
    let _ = terminate_child(child);
}

#[cfg(not(unix))]
fn group_term(child: &SharedChild, _pid: Option<u32>) {
    let _ = terminate_child(child);
}

#[cfg(not(unix))]
fn group_kill(child: &SharedChild, _pid: Option<u32>) {
    let _ = terminate_child(child);
}

/// SIGTERM the process group, wait briefly for a clean exit, then SIGKILL the
/// group if it is still alive. Always reaps so the child does not linger as a
/// zombie.
fn terminate_tree_graceful(child: &SharedChild, pid: Option<u32>) -> Result<()> {
    group_term(child, pid);
    let deadline = Instant::now() + TERMINATE_GRACE;
    loop {
        match try_wait_child(child) {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => {}
            // If we can no longer poll the child, fall through to SIGKILL.
            Err(_) => break,
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(TERMINATE_POLL);
    }
    group_kill(child, pid);
    let _ = try_wait_child(child);
    Ok(())
}

/// SIGKILL the whole process group immediately, then reap.
fn terminate_tree_now(child: &SharedChild, pid: Option<u32>) -> Result<()> {
    group_kill(child, pid);
    let _ = try_wait_child(child);
    Ok(())
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

    /// A graceful terminate must take down the agent's entire process group,
    /// not just the direct child. We spawn a shell that backgrounds a
    /// long-lived grandchild (in the shell's process group, since job control
    /// is off for non-interactive shells), confirm the grandchild is alive,
    /// terminate the session, then confirm the grandchild is gone.
    #[cfg(unix)]
    #[test]
    fn terminate_kills_whole_process_group() {
        let command =
            CommandSpec::new("/bin/sh", "/tmp").with_args(["-c", "sleep 600 & echo gc:$!; wait"]);
        let mut spec = TerminalSpawnSpec::new(command);
        spec.cols = 80;
        spec.rows = 24;

        let process = PtyProcess::spawn(TerminalId::new_v4(), &spec).expect("PTY should spawn");
        let (mut reader, controller) = process.split();

        // Read until the shell reports the backgrounded grandchild's pid.
        let mut output = Vec::new();
        let mut buf = [0_u8; 512];
        let read_deadline = Instant::now() + Duration::from_secs(3);
        let grandchild_pid = loop {
            if Instant::now() >= read_deadline {
                let _ = controller.terminate();
                panic!(
                    "never saw grandchild pid; output={:?}",
                    String::from_utf8_lossy(&output)
                );
            }
            let read = reader
                .read_chunk(&mut buf)
                .expect("PTY read should succeed");
            if read == 0 {
                let _ = controller.terminate();
                panic!("PTY closed before reporting grandchild pid");
            }
            output.extend_from_slice(&buf[..read]);
            let text = String::from_utf8_lossy(&output);
            if let Some(rest) = text.split("gc:").nth(1) {
                let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if !digits.is_empty()
                    && (text.contains('\n') || rest.len() > digits.len())
                    && let Ok(pid) = digits.parse::<libc::pid_t>()
                {
                    break pid;
                }
            }
        };

        // Sanity: the grandchild should be alive right now.
        assert_eq!(
            unsafe { libc::kill(grandchild_pid, 0) },
            0,
            "grandchild {grandchild_pid} should be alive before terminate"
        );

        controller
            .terminate()
            .expect("graceful terminate should succeed");

        // After a graceful tree-kill the grandchild must be gone. Poll briefly
        // to allow signal delivery + reaping by launchd after reparenting.
        let dead_deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if unsafe { libc::kill(grandchild_pid, 0) } != 0 {
                break;
            }
            if Instant::now() >= dead_deadline {
                panic!("grandchild {grandchild_pid} survived the tree-kill");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
