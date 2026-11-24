//! Panic logging: the one owner of the process panic hook.
//!
//! A GUI launch sends stderr nowhere, so without this a production panic leaves
//! only a macOS crash report, which records where the process aborted but not
//! the panic message. Two channels, two destinations:
//!
//! - Dev builds append to `reverie-dev-crashes.log` in the working directory,
//!   installed before the Tauri builder so even startup panics are kept.
//! - Release builds append to a bounded `crash.log` in the app-data folder,
//!   installed at the top of `setup` (the first point Tauri can resolve that
//!   folder). Panics before `setup` still reach stderr through the default hook.
//!
//! Both chain to the previous hook, so the standard stderr report is unchanged.
//! The hook never touches Tauri state: the destination is resolved up front.
//!
//! A foreign exception (for example an Objective-C exception thrown inside
//! AppKit) that unwinds into an `extern "C"` frame shows up here as "panic in a
//! function that cannot unwind". The original exception is already gone by
//! then; check the macOS unified log for an assertion just before the entry.

use std::backtrace::Backtrace;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::panic::PanicHookInfo;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::state::unix_time_millis;

const CRASH_LOG_FILE: &str = "crash.log";
const PREVIOUS_CRASH_LOG_FILE: &str = "crash.previous.log";
const MAX_CRASH_LOG_BYTES: u64 = 256 * 1024;
static CRASH_LOG_LOCK: Mutex<()> = Mutex::new(());

/// Dev builds: log panics to the working directory from the first line of
/// `main`. A no-op in release, which installs from `setup` instead.
pub(crate) fn install_dev() {
    #[cfg(debug_assertions)]
    {
        let log_path = std::env::current_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("reverie-dev-crashes.log");
        eprintln!("[reverie] development panic log: {}", log_path.display());
        chain_hook(move |info| {
            let entry = format_entry(info, "dev");
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log_path) {
                let _ = file.write_all(entry.as_bytes());
            }
        });
    }
}

/// Release builds: log panics to `<app-data>/crash.log`, rotating to
/// `crash.previous.log` once it passes 256 KiB. A no-op in dev builds, which
/// already log through [`install_dev`].
pub(crate) fn install_release(app_data_dir: PathBuf, version: String) {
    if cfg!(debug_assertions) {
        return;
    }
    if let Err(error) = fs::create_dir_all(&app_data_dir) {
        eprintln!("[reverie] crash log disabled: {error}");
        return;
    }
    chain_hook(move |info| {
        let entry = format_entry(info, &version);
        let _guard = CRASH_LOG_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = append_entry(
            &app_data_dir.join(CRASH_LOG_FILE),
            &app_data_dir.join(PREVIOUS_CRASH_LOG_FILE),
            MAX_CRASH_LOG_BYTES,
            &entry,
        );
    });
}

fn chain_hook(write: impl Fn(&PanicHookInfo<'_>) + Send + Sync + 'static) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write(info);
        previous(info);
    }));
}

fn format_entry(info: &PanicHookInfo<'_>, version: &str) -> String {
    let thread = std::thread::current();
    let thread_name = thread.name().unwrap_or("<unnamed>");
    let backtrace = Backtrace::force_capture();
    format!(
        "\n=== Reverie panic ===\nwhen: {}\nversion: {version}\nthread: {thread_name}\ninfo: {info}\nbacktrace:\n{backtrace}\n",
        unix_time_millis(),
    )
}

fn append_entry(path: &Path, previous_path: &Path, max_bytes: u64, entry: &str) -> io::Result<()> {
    if fs::metadata(path).is_ok_and(|metadata| metadata.len() >= max_bytes) {
        match fs::remove_file(previous_path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        fs::rename(path, previous_path)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(entry.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_entries_and_rotates_past_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CRASH_LOG_FILE);
        let previous_path = dir.path().join(PREVIOUS_CRASH_LOG_FILE);

        append_entry(&path, &previous_path, 1024, "first\n").unwrap();
        append_entry(&path, &previous_path, 1024, "second\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "first\nsecond\n");
        assert!(!previous_path.exists());

        append_entry(&path, &previous_path, 1, "third\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "third\n");
        assert_eq!(
            fs::read_to_string(&previous_path).unwrap(),
            "first\nsecond\n"
        );
    }
}
