//! Typed model for the Cortex Code activity-state surface.
//!
//! Mirrors the shape defined in `docs/technical/cortex-activity-contract.md`.
//! That document is the single source of truth; both the producer (cortex-mono)
//! and the consumer (this crate) are built against it. If a field changes here,
//! it changes there first.
//!
//! The types are intentionally generic over which CLI wrote the file — the same
//! shape is expected to serve Claude Code's `~/.claude/jobs/{id}/state.json`
//! once that integration lands. Keep this module CLI-agnostic.
//!
//! Parsing is the only thing this module does. Filesystem watching, discovery
//! across `~/.cortex/sessions/*/activity/`, and pushing state changes to the
//! UI live elsewhere. That separation keeps these types testable in isolation
//! and reusable across the Tauri shell, harness fixtures, and future tooling.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Authoritative current state for a single agent session.
///
/// One of these is written atomically (temp file + rename) by the producer on
/// every state transition. Reverie reads this file on startup to learn the
/// current state without having to replay events.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityState {
    pub version: u32,
    pub session_id: String,
    pub status: ActivityStatus,
    pub updated_at: String,
    pub sequence: u64,
    pub cwd: String,
    #[serde(default)]
    pub turn: Option<ActivityTurn>,
    #[serde(default)]
    pub active_tools: Vec<ActiveTool>,
    #[serde(default)]
    pub awaiting_permission: Option<PermissionRequest>,
    #[serde(default)]
    pub last_error: Option<ActivityError>,
    #[serde(default)]
    pub final_exit: Option<FinalExit>,
}

/// Top-level activity status. Maps directly to the visual states Reverie shows
/// (a green dot for `Working`, an amber dot for `AwaitingPermission`, etc.).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ActivityStatus {
    Working,
    /// The turn ended and the agent is back at the prompt, waiting for your
    /// next message whenever you get to it. A resting state, not a blocking ask.
    AwaitingInput,
    /// The agent is blocked mid-turn on a tool-permission decision. Suppressed
    /// when auto-approve is on (the CLI never raises the gate).
    AwaitingPermission,
    /// The agent is blocked mid-turn waiting for you to answer a question or
    /// approve a plan (Claude's AskUserQuestion / ExitPlanMode pickers, or an
    /// MCP elicitation dialog). Unlike `AwaitingInput` the turn is still live
    /// and cannot proceed until you respond, so it reads as attention; unlike
    /// `AwaitingPermission` it is NOT suppressed by auto-approve, which is why a
    /// "yolo" session can still sit on a question.
    AwaitingResponse,
    Done,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityTurn {
    pub id: String,
    pub status: TurnStatus,
    pub started_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Running,
    Completed,
    Aborted,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTool {
    pub tool_call_id: String,
    pub tool_name: String,
    pub started_at: String,
    /// Optional human-readable summary for the currently running tool, e.g.
    /// `"Run shell: npm test"`. Producer-supplied so Reverie can render
    /// activity lines without per-tool knowledge.
    #[serde(default)]
    pub display_summary: Option<String>,
    /// Optional child-task correlation id used by Cortex when a tool spawns
    /// a tracked sub-task (e.g. a long-running background job).
    #[serde(default)]
    pub child_task_id: Option<String>,
}

/// A pending permission request. Reverie shows `display_summary` by default;
/// the raw `args` are available for tools where the full input is useful and
/// safe to show.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub id: String,
    pub tool_name: String,
    pub display_summary: String,
    #[serde(default)]
    pub args: Option<serde_json::Value>,
    pub requested_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityError {
    pub category: ErrorCategory,
    pub message: String,
    pub recoverable: bool,
    pub occurred_at: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    RateLimit,
    Authentication,
    Network,
    ContextOverflow,
    Cancelled,
    Other,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalExit {
    #[serde(default)]
    pub code: Option<i32>,
    #[serde(default)]
    pub signal: Option<String>,
    pub reason: ExitReason,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExitReason {
    UserQuit,
    ShutdownCommand,
    Eof,
    Error,
    Unknown,
}

/// One newline-delimited entry from `events.jsonl`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    pub version: u32,
    pub sequence: u64,
    pub session_id: String,
    pub timestamp: String,
    #[serde(flatten)]
    pub kind: ActivityEventKind,
}

/// Discriminated event payload. The producer writes each event as a single
/// `O_APPEND` write under `PIPE_BUF` (4 KB on macOS/Linux), so each line is a
/// complete record.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum ActivityEventKind {
    StatusChanged(StatusChangedPayload),
    TurnStarted(TurnStartedPayload),
    TurnEnded(TurnEndedPayload),
    ToolCallStarted(ToolCallStartedPayload),
    ToolCallEnded(ToolCallEndedPayload),
    PermissionRequested(PermissionRequest),
    PermissionResolved(PermissionResolvedPayload),
    Error(ActivityError),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusChangedPayload {
    pub from: ActivityStatus,
    pub to: ActivityStatus,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartedPayload {
    pub turn_id: String,
    pub trigger: TurnTrigger,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnTrigger {
    UserPrompt,
    Auto,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnEndedPayload {
    pub turn_id: String,
    pub outcome: TurnOutcome,
    pub duration_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnOutcome {
    Completed,
    Aborted,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallStartedPayload {
    pub tool_call_id: String,
    pub tool_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallEndedPayload {
    pub tool_call_id: String,
    pub tool_name: String,
    /// True when the tool execution failed or was cancelled by the agent.
    /// Cortex's wire format collapses success/error/cancelled into a single
    /// boolean; richer outcome detail can be reintroduced later if either
    /// producer starts emitting it.
    pub is_error: bool,
    /// Wall-clock duration of the tool call. Producers should fill this on
    /// completion; the field is optional so partial streams still parse.
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResolvedPayload {
    pub id: String,
    pub tool_name: String,
    pub resolution: PermissionResolution,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionResolution {
    Allowed,
    Denied,
    Cancelled,
    Expired,
    Error,
}

/// Parse a `state.json` payload.
pub fn parse_state(json: &str) -> Result<ActivityState> {
    serde_json::from_str(json).context("parsing activity state.json")
}

/// Parse a single `events.jsonl` line.
pub fn parse_event(line: &str) -> Result<ActivityEvent> {
    serde_json::from_str(line).context("parsing activity event line")
}

/// Iterate parsed events from an entire `events.jsonl` blob. Blank lines are
/// skipped. Each yielded item is an independent `Result` so a single malformed
/// line does not stop iteration (mirroring `BufRead::lines()`).
pub fn parse_events(jsonl: &str) -> impl Iterator<Item = Result<ActivityEvent>> + '_ {
    jsonl
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(parse_event)
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATE_AWAITING_PERMISSION: &str = r#"{
        "version": 1,
        "sessionId": "0193abcd-ef01-7000-8000-0123456789ab",
        "status": "awaiting_permission",
        "updatedAt": "2026-05-28T12:34:56.789Z",
        "sequence": 42,
        "cwd": "/Users/user/Code/reverie",
        "turn": {
            "id": "turn-7",
            "status": "running",
            "startedAt": "2026-05-28T12:34:10.000Z",
            "endedAt": null
        },
        "activeTools": [
            { "toolCallId": "tc-1", "toolName": "Bash", "startedAt": "2026-05-28T12:34:30.000Z" }
        ],
        "awaitingPermission": {
            "id": "perm-1",
            "toolName": "Bash",
            "displaySummary": "Run shell: rm -rf foo/",
            "args": { "command": "rm -rf foo/" },
            "requestedAt": "2026-05-28T12:34:56.789Z"
        },
        "lastError": null,
        "finalExit": null
    }"#;

    const STATE_DONE: &str = r#"{
        "version": 1,
        "sessionId": "0193abcd-ef01-7000-8000-0123456789ab",
        "status": "done",
        "updatedAt": "2026-05-28T13:01:00.000Z",
        "sequence": 130,
        "cwd": "/repo",
        "turn": null,
        "activeTools": [],
        "awaitingPermission": null,
        "lastError": null,
        "finalExit": { "code": 0, "signal": null, "reason": "user_quit" }
    }"#;

    const STATE_IDLE_MINIMAL: &str = r#"{
        "version": 1,
        "sessionId": "abc",
        "status": "awaiting_input",
        "updatedAt": "2026-05-28T12:00:00.000Z",
        "sequence": 1,
        "cwd": "/repo"
    }"#;

    const EVENTS_JSONL: &str = "\
        {\"version\":1,\"sequence\":40,\"sessionId\":\"abc\",\"timestamp\":\"2026-05-28T12:34:09.000Z\",\"type\":\"turn_started\",\"payload\":{\"turnId\":\"turn-7\",\"trigger\":\"user_prompt\"}}\n\
        {\"version\":1,\"sequence\":41,\"sessionId\":\"abc\",\"timestamp\":\"2026-05-28T12:34:30.000Z\",\"type\":\"tool_call_started\",\"payload\":{\"toolCallId\":\"tc-1\",\"toolName\":\"Bash\"}}\n\
        \n\
        {\"version\":1,\"sequence\":42,\"sessionId\":\"abc\",\"timestamp\":\"2026-05-28T12:34:56.789Z\",\"type\":\"permission_requested\",\"payload\":{\"id\":\"perm-1\",\"toolName\":\"Bash\",\"displaySummary\":\"Run shell: rm -rf foo/\",\"args\":{\"command\":\"rm -rf foo/\"},\"requestedAt\":\"2026-05-28T12:34:56.789Z\"}}\n\
        {\"version\":1,\"sequence\":43,\"sessionId\":\"abc\",\"timestamp\":\"2026-05-28T12:35:02.000Z\",\"type\":\"permission_resolved\",\"payload\":{\"id\":\"perm-1\",\"toolName\":\"Bash\",\"resolution\":\"denied\"}}\n\
        {\"version\":1,\"sequence\":44,\"sessionId\":\"abc\",\"timestamp\":\"2026-05-28T12:35:02.500Z\",\"type\":\"tool_call_ended\",\"payload\":{\"toolCallId\":\"tc-1\",\"toolName\":\"Bash\",\"isError\":true,\"durationMs\":32500}}\n\
        {\"version\":1,\"sequence\":45,\"sessionId\":\"abc\",\"timestamp\":\"2026-05-28T12:35:03.000Z\",\"type\":\"turn_ended\",\"payload\":{\"turnId\":\"turn-7\",\"outcome\":\"completed\",\"durationMs\":54000}}\n\
        {\"version\":1,\"sequence\":46,\"sessionId\":\"abc\",\"timestamp\":\"2026-05-28T12:35:03.001Z\",\"type\":\"status_changed\",\"payload\":{\"from\":\"awaiting_permission\",\"to\":\"awaiting_input\"}}\n";

    #[test]
    fn parses_awaiting_permission_state() {
        let state = parse_state(STATE_AWAITING_PERMISSION).expect("parses");
        assert_eq!(state.version, 1);
        assert_eq!(state.status, ActivityStatus::AwaitingPermission);
        assert_eq!(state.sequence, 42);
        assert_eq!(state.cwd, "/Users/user/Code/reverie");

        let turn = state.turn.expect("turn present");
        assert_eq!(turn.id, "turn-7");
        assert_eq!(turn.status, TurnStatus::Running);
        assert!(turn.ended_at.is_none());

        assert_eq!(state.active_tools.len(), 1);
        assert_eq!(state.active_tools[0].tool_name, "Bash");

        let perm = state
            .awaiting_permission
            .expect("permission request present");
        assert_eq!(perm.id, "perm-1");
        assert_eq!(perm.tool_name, "Bash");
        assert_eq!(perm.display_summary, "Run shell: rm -rf foo/");
        assert!(perm.args.is_some());
    }

    #[test]
    fn parses_done_state_with_final_exit() {
        let state = parse_state(STATE_DONE).expect("parses");
        assert_eq!(state.status, ActivityStatus::Done);
        assert!(state.turn.is_none());
        assert!(state.active_tools.is_empty());
        let exit = state.final_exit.expect("final exit set on done");
        assert_eq!(exit.reason, ExitReason::UserQuit);
        assert_eq!(exit.code, Some(0));
        assert!(exit.signal.is_none());
    }

    #[test]
    fn parses_minimal_idle_state_with_defaults() {
        let state = parse_state(STATE_IDLE_MINIMAL).expect("parses");
        assert_eq!(state.status, ActivityStatus::AwaitingInput);
        assert!(state.turn.is_none());
        assert!(state.active_tools.is_empty());
        assert!(state.awaiting_permission.is_none());
        assert!(state.last_error.is_none());
        assert!(state.final_exit.is_none());
    }

    #[test]
    fn parses_events_jsonl_round_trip() {
        let events: Vec<ActivityEvent> = parse_events(EVENTS_JSONL)
            .map(|result| result.expect("parses"))
            .collect();
        assert_eq!(events.len(), 7);

        match &events[0].kind {
            ActivityEventKind::TurnStarted(payload) => {
                assert_eq!(payload.turn_id, "turn-7");
                assert_eq!(payload.trigger, TurnTrigger::UserPrompt);
            }
            other => panic!("expected TurnStarted, got {other:?}"),
        }

        match &events[2].kind {
            ActivityEventKind::PermissionRequested(req) => {
                assert_eq!(req.id, "perm-1");
                assert_eq!(req.display_summary, "Run shell: rm -rf foo/");
            }
            other => panic!("expected PermissionRequested, got {other:?}"),
        }

        match &events[3].kind {
            ActivityEventKind::PermissionResolved(payload) => {
                assert_eq!(payload.resolution, PermissionResolution::Denied);
            }
            other => panic!("expected PermissionResolved, got {other:?}"),
        }

        match &events[4].kind {
            ActivityEventKind::ToolCallEnded(payload) => {
                assert!(payload.is_error);
                assert_eq!(payload.duration_ms, Some(32_500));
            }
            other => panic!("expected ToolCallEnded, got {other:?}"),
        }

        match &events[5].kind {
            ActivityEventKind::TurnEnded(payload) => {
                assert_eq!(payload.outcome, TurnOutcome::Completed);
                assert_eq!(payload.duration_ms, 54_000);
            }
            other => panic!("expected TurnEnded, got {other:?}"),
        }

        match &events[6].kind {
            ActivityEventKind::StatusChanged(payload) => {
                assert_eq!(payload.from, ActivityStatus::AwaitingPermission);
                assert_eq!(payload.to, ActivityStatus::AwaitingInput);
            }
            other => panic!("expected StatusChanged, got {other:?}"),
        }
    }

    #[test]
    fn unknown_event_type_returns_error_without_stopping_iteration() {
        let blob = "\
            {\"version\":1,\"sequence\":1,\"sessionId\":\"abc\",\"timestamp\":\"2026-05-28T12:00:00.000Z\",\"type\":\"future_event\",\"payload\":{}}\n\
            {\"version\":1,\"sequence\":2,\"sessionId\":\"abc\",\"timestamp\":\"2026-05-28T12:00:01.000Z\",\"type\":\"turn_started\",\"payload\":{\"turnId\":\"t\",\"trigger\":\"auto\"}}\n";
        let results: Vec<Result<ActivityEvent>> = parse_events(blob).collect();
        assert_eq!(results.len(), 2);
        assert!(
            results[0].is_err(),
            "future_event type should fail to parse"
        );
        assert!(
            results[1].is_ok(),
            "well-formed event after a bad line still parses"
        );
    }

    #[test]
    fn round_trips_state_serialization() {
        // Sanity check that our Serialize impls produce the same shape we read,
        // so the cortex-mono writer and this reader stay aligned.
        let state = parse_state(STATE_AWAITING_PERMISSION).expect("parses");
        let json = serde_json::to_string(&state).expect("serializes");
        let again = parse_state(&json).expect("re-parses after round trip");
        assert_eq!(again.status, ActivityStatus::AwaitingPermission);
        assert_eq!(again.sequence, 42);
    }
}
