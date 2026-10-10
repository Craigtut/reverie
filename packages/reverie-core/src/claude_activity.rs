//! Read-only status recovery for Claude's supported `agents --json` surface.
//! Hooks retain completion and permission details. A snapshot only repairs a
//! changed status; an absent session or unknown value carries no evidence.

use crate::activity::{ActivityState, ActivityStatus};
use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionStatus {
    #[serde(default)]
    pub session_id: String,
    kind: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    waiting_for: Option<String>,
}

impl ClaudeSessionStatus {
    pub fn reconcile(&self, previous: &ActivityState, observed_at: &str) -> Option<ActivityState> {
        if self.kind != "interactive" || self.session_id != previous.session_id {
            return None;
        }
        let status = match self.status.as_str() {
            "busy" => ActivityStatus::Working,
            // Claude does not distinguish interruption from completion here.
            // Only Stop certifies a new result ready for review.
            "idle" => {
                if matches!(
                    previous.status,
                    ActivityStatus::Idle
                        | ActivityStatus::AwaitingInput
                        | ActivityStatus::Done
                        | ActivityStatus::Error
                ) {
                    return None;
                }
                ActivityStatus::Idle
            }
            "waiting" => match self.waiting_for.as_deref() {
                Some("permission prompt" | "sandbox request") => ActivityStatus::AwaitingPermission,
                Some("input needed" | "worker request" | "dialog open") => {
                    ActivityStatus::AwaitingResponse
                }
                _ if matches!(
                    previous.status,
                    ActivityStatus::AwaitingPermission | ActivityStatus::AwaitingResponse
                ) =>
                {
                    return None;
                }
                _ => ActivityStatus::AwaitingResponse,
            },
            _ => return None,
        };
        if status == previous.status {
            return None;
        }
        Some(ActivityState {
            version: 1,
            session_id: self.session_id.clone(),
            status,
            updated_at: observed_at.to_owned(),
            sequence: previous.sequence + 1,
            cwd: previous.cwd.clone(),
            turn: None,
            active_tools: Vec::new(),
            awaiting_permission: None,
            last_error: None,
            final_exit: None,
        })
    }
}

/// Claude reports process exit and generic idle independently of turn completion.
/// Preserve an existing result and its review timestamp across those signals.
pub fn normalize_rest(
    previous: Option<&ActivityState>,
    mut state: ActivityState,
    boundary: bool,
) -> ActivityState {
    // Rest notifications and process exit must not invent a completed turn
    // or move the timestamp of a result the user has already reviewed.
    if !boundary && matches!(state.status, ActivityStatus::Idle | ActivityStatus::Done) {
        if let Some(old) = previous {
            if matches!(
                old.status,
                ActivityStatus::Idle | ActivityStatus::AwaitingInput | ActivityStatus::Error
            ) {
                let exit = state.final_exit.take();
                state = old.clone();
                if exit.is_some() {
                    state.final_exit = exit;
                }
            } else {
                state.status = ActivityStatus::Idle;
            }
        } else {
            state.status = ActivityStatus::Idle;
        }
    }
    state
}

/// Capability check first: older CLIs must never interpret `agents` as a prompt.
pub fn supports_status_query(executable: &Path) -> Result<bool> {
    Ok(read_command(executable, &["--help"])?.lines().any(|line| {
        line.trim_start()
            .strip_prefix("agents")
            .is_some_and(|rest| rest.starts_with(char::is_whitespace))
    }))
}

pub fn read_statuses(executable: &Path) -> Result<Vec<ClaudeSessionStatus>> {
    serde_json::from_str(&read_command(executable, &["agents", "--json"])?)
        .context("parse Claude session statuses")
}

fn read_command(executable: &Path, args: &[&str]) -> Result<String> {
    // A private temporary file avoids a full pipe blocking child exit. Output
    // and runtime are bounded, and no session content is logged or retained.
    const MAX_BYTES: u64 = 512 * 1024;
    let mut output = tempfile::tempfile()?;
    let mut child = Command::new(executable)
        .args(args)
        .stdin(Stdio::null())
        .stdout(output.try_clone()?)
        .stderr(Stdio::null())
        .spawn()?;
    let started = Instant::now();
    loop {
        if started.elapsed() > Duration::from_secs(2) || output.metadata()?.len() > MAX_BYTES {
            let _ = child.kill();
            let _ = child.wait();
            bail!("Claude status query exceeded its time or output limit");
        }
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                bail!("Claude status query failed");
            }
            use std::io::{Seek, SeekFrom};
            output.seek(SeekFrom::Start(0))?;
            let mut text = String::new();
            output.take(MAX_BYTES + 1).read_to_string(&mut text)?;
            if text.len() as u64 > MAX_BYTES {
                bail!("Claude status query output too large");
            }
            return Ok(text);
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::PermissionRequest;

    fn previous(status: ActivityStatus) -> ActivityState {
        ActivityState {
            version: 1,
            session_id: "root".into(),
            status,
            updated_at: "2026-10-10T12:00:01.000Z".into(),
            sequence: 1,
            cwd: "/tmp".into(),
            turn: None,
            active_tools: Vec::new(),
            awaiting_permission: None,
            last_error: None,
            final_exit: None,
        }
    }
    fn snapshot(status: &str, waiting_for: Option<&str>) -> ClaudeSessionStatus {
        ClaudeSessionStatus {
            session_id: "root".into(),
            kind: "interactive".into(),
            status: status.into(),
            waiting_for: waiting_for.map(str::to_owned),
        }
    }
    #[test]
    fn missed_interrupt_recovers_to_neutral_idle() {
        let update = snapshot("idle", None)
            .reconcile(
                &previous(ActivityStatus::Working),
                "2026-10-10T12:00:02.000Z",
            )
            .unwrap();
        assert_eq!(update.status, ActivityStatus::Idle);
        assert!(snapshot("idle", None).reconcile(&update, "later").is_none());
    }
    #[test]
    fn idle_poll_preserves_a_completed_result() {
        assert!(
            snapshot("idle", None)
                .reconcile(&previous(ActivityStatus::AwaitingInput), "later")
                .is_none()
        );
    }
    #[test]
    fn supported_wait_reasons_keep_permission_and_question_distinct() {
        let previous = previous(ActivityStatus::Working);
        assert_eq!(
            snapshot("waiting", Some("permission prompt"))
                .reconcile(&previous, "later")
                .unwrap()
                .status,
            ActivityStatus::AwaitingPermission
        );
        assert_eq!(
            snapshot("waiting", Some("input needed"))
                .reconcile(&previous, "later")
                .unwrap()
                .status,
            ActivityStatus::AwaitingResponse
        );
    }
    #[test]
    fn same_status_leaves_hook_permission_payload_intact() {
        let mut previous = previous(ActivityStatus::AwaitingPermission);
        previous.awaiting_permission = Some(PermissionRequest {
            id: "p".into(),
            tool_name: "Bash".into(),
            display_summary: "Run tests".into(),
            args: None,
            requested_at: "t".into(),
        });
        assert!(
            snapshot("waiting", Some("permission prompt"))
                .reconcile(&previous, "later")
                .is_none()
        );
    }
    #[test]
    fn unsupported_or_unrelated_sessions_have_no_effect() {
        let mut snapshot = snapshot("unknown", None);
        assert!(
            snapshot
                .reconcile(&previous(ActivityStatus::Working), "later")
                .is_none()
        );
        snapshot.status = "idle".into();
        snapshot.session_id = "sibling".into();
        assert!(
            snapshot
                .reconcile(&previous(ActivityStatus::Working), "later")
                .is_none()
        );
        snapshot.session_id = "root".into();
        snapshot.kind = "background".into();
        assert!(
            snapshot
                .reconcile(&previous(ActivityStatus::Working), "later")
                .is_none()
        );
    }
    #[test]
    fn optional_fields_on_background_entries_do_not_break_interactive_parsing() {
        let parsed: Vec<ClaudeSessionStatus> = serde_json::from_value(serde_json::json!([
            {"kind":"background", "id":"job", "state":"done"},
            {"kind":"interactive", "sessionId":"root", "status":"busy", "pid":123}
        ]))
        .unwrap();
        assert!(
            parsed[0]
                .reconcile(&previous(ActivityStatus::Working), "later")
                .is_none()
        );
        assert_eq!(
            parsed[1]
                .reconcile(&previous(ActivityStatus::Idle), "later")
                .unwrap()
                .status,
            ActivityStatus::Working
        );
    }
}
