//! Small production-safe lifecycle log for WKWebView recovery.
//!
//! Terminal renderer diagnostics remain dev-only because they are verbose. This
//! log records only native process, heartbeat, and reload decisions, with no
//! terminal content, so a production black-window report has durable evidence.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::Mutex;

use serde_json::Value;
use tauri::Manager;

use crate::state::unix_time_millis;

const HEALTH_LOG_FILE: &str = "webview-health.jsonl";
const PREVIOUS_HEALTH_LOG_FILE: &str = "webview-health.previous.jsonl";
const MAX_HEALTH_LOG_BYTES: u64 = 256 * 1024;
static HEALTH_LOG_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn record(app: &tauri::AppHandle, kind: &'static str, payload: Value) {
    let result = (|| -> Result<(), String> {
        let _guard = HEALTH_LOG_LOCK
            .lock()
            .map_err(|_| "webview health log lock is poisoned".to_owned())?;
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        append_event(
            &dir.join(HEALTH_LOG_FILE),
            &dir.join(PREVIOUS_HEALTH_LOG_FILE),
            MAX_HEALTH_LOG_BYTES,
            &serde_json::json!({
                "kind": kind,
                "wallTimeMs": unix_time_millis(),
                "payload": payload,
            }),
        )
        .map_err(|error| error.to_string())
    })();
    if let Err(error) = result {
        eprintln!("[reverie] failed to record webview health event {kind}: {error}");
    }
}

fn append_event(
    path: &Path,
    previous_path: &Path,
    max_bytes: u64,
    event: &Value,
) -> io::Result<()> {
    if fs::metadata(path).is_ok_and(|metadata| metadata.len() >= max_bytes) {
        match fs::remove_file(previous_path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        fs::rename(path, previous_path)?;
    }

    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    serde_json::to_writer(&mut file, event).map_err(io::Error::other)?;
    file.write_all(b"\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_the_bounded_health_log() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(HEALTH_LOG_FILE);
        let previous_path = dir.path().join(PREVIOUS_HEALTH_LOG_FILE);

        append_event(&path, &previous_path, 1, &serde_json::json!({ "event": 1 })).unwrap();
        append_event(&path, &previous_path, 1, &serde_json::json!({ "event": 2 })).unwrap();

        let current = fs::read_to_string(path).unwrap();
        let previous = fs::read_to_string(previous_path).unwrap();
        assert!(current.contains("\"event\":2"));
        assert!(previous.contains("\"event\":1"));
    }
}
