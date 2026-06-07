//! Persistent spawn registry for boot-time cleanup of agent process groups.
//!
//! Normal quits terminate the runtime's in-memory controllers. A crash or force
//! quit skips that path, so this registry records enough identity to find and
//! kill verified survivors on the next launch.

use std::fs;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::{Mutex, OnceLock};

use reverie_core::domain::SessionId;
use reverie_core::terminal::{TerminalId, TerminalSpawnSpec};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const REGISTRY_FILE: &str = "terminal-spawns.json";

static REGISTRY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpawnRecord {
    terminal_id: TerminalId,
    session_id: Option<SessionId>,
    pid: u32,
    program: String,
    args: Vec<String>,
    cwd: String,
    started_ms: i64,
    #[serde(default)]
    process_started: Option<String>,
    #[serde(default)]
    owner_pid: Option<u32>,
    #[serde(default)]
    owner_started: Option<String>,
}

pub(crate) fn reap_stale_spawns(app: &AppHandle) {
    let Some(path) = registry_path(app) else {
        return;
    };
    let _guard = registry_lock()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    let records = read_records(&path);
    if records.is_empty() {
        return;
    }

    let mut remaining = Vec::new();
    for record in records {
        if owner_process_still_alive(&record) {
            remaining.push(record);
            continue;
        }
        if !verified_process_matches(&record) {
            continue;
        }
        if kill_process_group(record.pid) {
            eprintln!(
                "[reverie] reaped stale agent process group {} for terminal {}",
                record.pid, record.terminal_id
            );
        }
    }

    if let Err(error) = write_records(&path, &remaining) {
        eprintln!("[reverie] failed to clear terminal spawn registry: {error:#}");
    }
}

pub(crate) fn record_spawn(
    app: &AppHandle,
    session_id: Option<SessionId>,
    terminal_id: TerminalId,
    pid: Option<u32>,
    spec: &TerminalSpawnSpec,
    started_ms: i64,
) {
    let Some(pid) = pid else {
        return;
    };
    let Some(path) = registry_path(app) else {
        return;
    };
    let _guard = registry_lock()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    let mut records = read_records(&path);
    records.retain(|record| record.terminal_id != terminal_id);
    let owner_pid = process::id();
    records.push(SpawnRecord {
        terminal_id,
        session_id,
        pid,
        program: spec.command.program.display().to_string(),
        args: spec.command.args.clone(),
        cwd: spec.command.cwd.display().to_string(),
        started_ms,
        process_started: process_start_signature(pid),
        owner_pid: Some(owner_pid),
        owner_started: process_start_signature(owner_pid),
    });
    if let Err(error) = write_records(&path, &records) {
        eprintln!("[reverie] failed to record terminal spawn: {error:#}");
    }
}

pub(crate) fn clear_spawn(app: &AppHandle, terminal_id: TerminalId) {
    let Some(path) = registry_path(app) else {
        return;
    };
    let _guard = registry_lock()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    let mut records = read_records(&path);
    let before = records.len();
    records.retain(|record| record.terminal_id != terminal_id);
    if records.len() == before {
        return;
    }
    if let Err(error) = write_records(&path, &records) {
        eprintln!("[reverie] failed to clear terminal spawn: {error:#}");
    }
}

fn registry_lock() -> &'static Mutex<()> {
    REGISTRY_LOCK.get_or_init(|| Mutex::new(()))
}

fn registry_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(REGISTRY_FILE))
}

fn read_records(path: &Path) -> Vec<SpawnRecord> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => {
            eprintln!(
                "[reverie] failed to read terminal spawn registry {}: {error:#}",
                path.display()
            );
            Vec::new()
        }
    }
}

fn write_records(path: &Path, records: &[SpawnRecord]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if records.is_empty() {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        return Ok(());
    }
    let tmp = path.with_extension("json.tmp");
    let encoded = serde_json::to_vec_pretty(records)?;
    fs::write(&tmp, encoded)?;
    fs::rename(tmp, path)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn owner_process_still_alive(record: &SpawnRecord) -> bool {
    let Some(owner_pid) = record.owner_pid else {
        return false;
    };
    let Some(owner_started) = record.owner_started.as_deref() else {
        return process_exists(owner_pid);
    };
    match process_start_signature(owner_pid) {
        Some(current) => current == owner_started,
        None => process_exists(owner_pid),
    }
}

#[cfg(not(target_os = "macos"))]
fn owner_process_still_alive(_record: &SpawnRecord) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn verified_process_matches(record: &SpawnRecord) -> bool {
    let pid = record.pid as libc::pid_t;
    if unsafe { libc::kill(pid, 0) } != 0 {
        return false;
    }
    if unsafe { libc::getpgid(pid) } != pid {
        return false;
    }
    let Some(recorded_start) = record.process_started.as_deref() else {
        return false;
    };
    if process_start_signature(record.pid).as_deref() != Some(recorded_start) {
        return false;
    }
    let Some(current_cwd) = process_cwd(record.pid) else {
        return false;
    };
    if !paths_match(Path::new(&record.cwd), &current_cwd) {
        return false;
    }
    let Some(command) = process_command(record.pid) else {
        return false;
    };
    let Some(program_name) = Path::new(&record.program)
        .file_name()
        .and_then(|name| name.to_str())
    else {
        return false;
    };
    if !command.contains(program_name) {
        return false;
    }
    record
        .args
        .iter()
        .filter(|arg| !arg.is_empty())
        .all(|arg| command.contains(arg))
}

#[cfg(not(target_os = "macos"))]
fn verified_process_matches(_record: &SpawnRecord) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn process_start_signature(pid: u32) -> Option<String> {
    let pid_arg = pid.to_string();
    let output = process::Command::new("/bin/ps")
        .args(["-p", pid_arg.as_str(), "-o", "lstart="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    nonempty_stdout(output.stdout)
}

#[cfg(target_os = "macos")]
fn process_exists(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(not(target_os = "macos"))]
fn process_exists(_pid: u32) -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
fn process_start_signature(_pid: u32) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Option<PathBuf> {
    let pid_arg = pid.to_string();
    let output = process::Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", pid_arg.as_str(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix('n').map(PathBuf::from))
}

#[cfg(not(target_os = "macos"))]
fn process_cwd(_pid: u32) -> Option<PathBuf> {
    None
}

#[cfg(target_os = "macos")]
fn process_command(pid: u32) -> Option<String> {
    let pid_arg = pid.to_string();
    let output = process::Command::new("/bin/ps")
        .args(["-ww", "-p", pid_arg.as_str(), "-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    nonempty_stdout(output.stdout)
}

fn nonempty_stdout(stdout: Vec<u8>) -> Option<String> {
    let value = String::from_utf8_lossy(&stdout).trim().to_owned();
    (!value.is_empty()).then_some(value)
}

fn paths_match(recorded: &Path, current: &Path) -> bool {
    if recorded == current {
        return true;
    }
    match (fs::canonicalize(recorded), fs::canonicalize(current)) {
        (Ok(recorded), Ok(current)) => recorded == current,
        _ => false,
    }
}

#[cfg(target_os = "macos")]
fn kill_process_group(pid: u32) -> bool {
    unsafe { libc::killpg(pid as libc::pid_t, libc::SIGKILL) == 0 }
}

#[cfg(not(target_os = "macos"))]
fn kill_process_group(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_record_decodes_legacy_shape_without_owner_identity() {
        let encoded = format!(
            r#"{{
                "terminalId":"{}",
                "sessionId":null,
                "pid":123,
                "program":"/bin/sh",
                "args":["-lc","echo hi"],
                "cwd":"/tmp",
                "startedMs":42
            }}"#,
            TerminalId::new_v4()
        );

        let record: SpawnRecord = serde_json::from_str(&encoded).unwrap();

        assert_eq!(record.pid, 123);
        assert!(record.process_started.is_none());
        assert!(record.owner_pid.is_none());
        assert!(record.owner_started.is_none());
    }

    #[test]
    fn paths_match_exact_paths() {
        assert!(paths_match(Path::new("/tmp"), Path::new("/tmp")));
        assert!(!paths_match(
            Path::new("/tmp"),
            Path::new("/definitely-not-tmp")
        ));
    }
}
