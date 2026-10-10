//! CLI lifecycle translation. Transport and authentication stay in the parent
//! server; this module owns the interpretation of hook envelopes.

use super::HookSource;
use crate::activity::{
    ActiveTool, ActivityError, ActivityState, ActivityStatus, ActivityTurn, ErrorCategory,
    ExitReason, FinalExit, PermissionRequest, TurnStatus,
};
use crate::activity_source::{ActivityUpdate, Fidelity, SessionKey};
use crate::domain::SessionId;
use crate::time::now_iso8601;
use serde::Deserialize;
use serde_json::Value;
use std::{collections::HashMap, sync::Mutex};

const ACTIVITY_VERSION: u32 = 1;

fn next_sequence(sequences: &Mutex<HashMap<String, u64>>, session_id: &str) -> u64 {
    let mut guard = sequences.lock().unwrap_or_else(|err| err.into_inner());
    let counter = guard.entry(session_id.to_owned()).or_insert(0);
    *counter += 1;
    *counter
}

pub(super) fn translate(
    source: HookSource,
    reverie_session_id: SessionId,
    payload: &Value,
    sequences: &Mutex<HashMap<String, u64>>,
) -> Option<ActivityUpdate> {
    match source {
        HookSource::ClaudeCode => translate_claude(reverie_session_id, payload, sequences),
        HookSource::CodexCli => translate_codex(reverie_session_id, payload, sequences),
    }
}

/// Claude Code and Codex CLI both share a generic hook envelope: a top-level
/// `hook_event_name` discriminator plus a `session_id`, `cwd`, and event
/// payload fields. The exact set differs, but both honor this skeleton.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct HookEnvelope {
    /// Lifecycle hooks use `hook_event_name`; Codex's external notifier uses
    /// `type` with the value `agent-turn-complete`.
    #[serde(alias = "type")]
    hook_event_name: String,
    #[serde(default, alias = "thread-id")]
    session_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    tool_input: Option<Value>,
    /// The turn this event belongs to. Codex lifecycle hooks use `turn_id`; its
    /// notifier uses `turn-id`. The value is opaque and is not assumed to be
    /// ordered. Absent on non-turn events such as SessionStart.
    #[serde(default, alias = "turn-id")]
    turn_id: Option<String>,
    #[serde(default, alias = "error")]
    error_type: Option<String>,
    #[serde(default, alias = "error_details")]
    message: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    is_interrupt: bool,
    /// The kind of `Notification` event (`permission_prompt`, `idle_prompt`,
    /// `elicitation_dialog`, …). Only present on Notification payloads; it is
    /// how we tell a blocking ask apart from a benign toast.
    #[serde(default)]
    notification_type: Option<String>,
}

fn parse_envelope(payload: &Value) -> Option<HookEnvelope> {
    serde_json::from_value(payload.clone()).ok()
}

/// Build the [`ActivityUpdate`] a translated hook event produces: keyed by the
/// owning Reverie session (so it binds without a native-id lookup), tagged with
/// the source CLI, and definitive (a push hook is a first-class lifecycle
/// signal). The native CLI session id rides along in `state.session_id`.
fn hook_state_update(
    source: HookSource,
    reverie_session_id: SessionId,
    state: ActivityState,
    session_boundary: bool,
) -> ActivityUpdate {
    ActivityUpdate::State {
        source: source.activity_source_kind(),
        key: SessionKey::Reverie(reverie_session_id),
        fidelity: Fidelity::Definitive,
        state,
        session_boundary,
    }
}

/// Drop a native session's sequence counter once its session has ended, so the
/// per-process `sequences` map does not grow without bound across a long-running
/// app that opens and closes many sessions. A later event for the same id (rare
/// after `SessionEnd`) simply restarts the counter, which the launch-time
/// sequence reset already tolerates.
fn forget_sequence(sequences: &Mutex<HashMap<String, u64>>, session_id: &str) {
    sequences
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .remove(session_id);
}

/// Built-in Claude tools that block the turn on a user response rather than
/// doing work: a multiple-choice question (`AskUserQuestion`) or a plan
/// approval (`ExitPlanMode`). They emit a `PreToolUse` like any tool but no
/// `PostToolUse` until the user answers, and no `Stop` (the turn is still
/// live), so without special-casing them the session sits on its last
/// `Working` state and reads as green while it is really waiting for you.
const CLAUDE_ASKING_TOOLS: &[&str] = &["AskUserQuestion", "ExitPlanMode"];

pub(super) fn is_asking_tool(tool_name: &str) -> bool {
    CLAUDE_ASKING_TOOLS.contains(&tool_name)
}

/// Resolve a Claude `Notification` to a status change, or `None` when it
/// carries no turn-state meaning. `elicitation_dialog` (an MCP server asking
/// the user) blocks the turn, so it is an `AwaitingResponse`; its completion
/// resumes work. `idle_prompt` recovers a missed interruption as neutral Idle,
/// without claiming a completed result. `permission_prompt` is already covered
/// by the dedicated `PermissionRequest` hook, and `auth_success` is a toast.
pub(super) fn claude_notification_status(
    notification_type: Option<&str>,
) -> Option<ActivityStatus> {
    match notification_type? {
        "idle_prompt" => Some(ActivityStatus::Idle),
        "elicitation_dialog" => Some(ActivityStatus::AwaitingResponse),
        "elicitation_complete" | "elicitation_response" => Some(ActivityStatus::Working),
        _ => None,
    }
}

fn translate_claude(
    reverie_session_id: SessionId,
    payload: &Value,
    sequences: &Mutex<HashMap<String, u64>>,
) -> Option<ActivityUpdate> {
    let envelope = parse_envelope(payload)?;
    // Background/subagent tools must not reopen the parent after it has rested.
    if envelope.agent_id.is_some() {
        return None;
    }
    let session_id = envelope.session_id.clone()?;
    let timestamp = envelope.timestamp.clone().unwrap_or_else(now_iso8601);
    let sequence = next_sequence(sequences, &session_id);
    let cwd = envelope.cwd.clone().unwrap_or_default();

    // Notification is the one event that can resolve to "no state change", so it
    // is handled apart from the match below (which always yields a state). The
    // trace line is the ground truth for what Claude actually sends here, which
    // the hook docs leave unspecified.
    if envelope.hook_event_name == "Notification" {
        let kind = envelope.notification_type.as_deref().unwrap_or("?");
        eprintln!(
            "[reverie] claude notification session={session_id} type={kind} message={:?}",
            envelope.message.as_deref().unwrap_or("")
        );
        let status = claude_notification_status(envelope.notification_type.as_deref())?;
        let state = build_simple_state(&session_id, timestamp, sequence, cwd, status);
        // A Notification is never a session-start boundary.
        return Some(hook_state_update(
            HookSource::ClaudeCode,
            reverie_session_id,
            state,
            false,
        ));
    }

    let state = match envelope.hook_event_name.as_str() {
        "PermissionRequest" => {
            let tool = envelope.tool_name.as_deref().unwrap_or("tool");
            // An asking tool (AskUserQuestion / ExitPlanMode) routes its prompt
            // through PermissionRequest too, but it is a question / plan for the
            // user to ANSWER in the session, not an allow/deny tool gate. It must
            // be AwaitingResponse, not AwaitingPermission: that keeps the native
            // card a "needs your answer" signpost instead of meaningless
            // Approve/Deny buttons, and (because the hold-open keys off the
            // permission payload) stops the hook server from parking the
            // connection for a decision two buttons can't express, which would
            // also delay the CLI's own picker. Mirrors the PreToolUse arm below.
            if is_asking_tool(tool) {
                build_simple_state(
                    &session_id,
                    timestamp,
                    sequence,
                    cwd,
                    ActivityStatus::AwaitingResponse,
                )
            } else {
                build_state_awaiting_permission(
                    &session_id,
                    timestamp,
                    sequence,
                    cwd,
                    tool,
                    envelope.tool_input.as_ref(),
                )
            }
        }
        // A tool is starting. A genuine work tool surfaces as the active tool so
        // the dashboard can show "Run shell: npm test" instead of a bare
        // "Working". An *asking* tool (AskUserQuestion / ExitPlanMode) instead
        // blocks the turn on the user: there is no PostToolUse and no Stop until
        // you answer, so we hold AwaitingResponse rather than leave it green.
        "PreToolUse" => {
            let tool = envelope.tool_name.as_deref().unwrap_or("tool");
            if is_asking_tool(tool) {
                eprintln!(
                    "[reverie] claude session={session_id} awaiting user response (PreToolUse:{tool})"
                );
                build_simple_state(
                    &session_id,
                    timestamp,
                    sequence,
                    cwd,
                    ActivityStatus::AwaitingResponse,
                )
            } else {
                build_state_working_tool(
                    &session_id,
                    timestamp,
                    sequence,
                    cwd,
                    tool,
                    envelope.tool_input.as_ref(),
                )
            }
        }
        // The tool finished; clear the active tool but stay Working until the
        // turn's Stop arrives. (For an asking tool this is the answer landing,
        // which correctly moves us off AwaitingResponse back to Working.)
        "SessionStart" => build_simple_state(
            &session_id,
            timestamp,
            sequence,
            cwd,
            if envelope.source.as_deref() == Some("compact") {
                ActivityStatus::Working
            } else {
                ActivityStatus::Idle
            },
        ),
        "Elicitation" => build_simple_state(
            &session_id,
            timestamp,
            sequence,
            cwd,
            ActivityStatus::AwaitingResponse,
        ),
        "PostToolUseFailure" if envelope.is_interrupt => {
            build_simple_state(&session_id, timestamp, sequence, cwd, ActivityStatus::Idle)
        }
        "PostToolUse" | "PostToolUseFailure" | "ElicitationResult" | "UserPromptSubmit" => {
            build_simple_state(
                &session_id,
                timestamp,
                sequence,
                cwd,
                ActivityStatus::Working,
            )
        }
        "Stop" => build_simple_state(
            &session_id,
            timestamp,
            sequence,
            cwd,
            ActivityStatus::AwaitingInput,
        ),
        "StopFailure" => build_state_error(
            &session_id,
            timestamp,
            sequence,
            cwd,
            envelope
                .error_type
                .as_deref()
                .map(error_category_from_claude_label)
                .unwrap_or(ErrorCategory::Other),
            envelope
                .message
                .clone()
                .unwrap_or_else(|| "Claude Code reported an error".to_owned()),
        ),
        "SessionEnd" => build_state_done(&session_id, timestamp, sequence, cwd, ExitReason::Eof),
        // New CLI events are not evidence that a turn is running.
        _ => return None,
    };

    // SessionStart is the boundary at which a resumed/cleared conversation can
    // arrive under a new native id; the correlator uses it to re-point identity.
    let session_boundary =
        envelope.hook_event_name == "SessionStart" && envelope.source.as_deref() != Some("compact");

    // A finished session's counter can be reclaimed, bounding the sequences map.
    if envelope.hook_event_name == "SessionEnd" {
        forget_sequence(sequences, &session_id);
    }

    Some(hook_state_update(
        HookSource::ClaudeCode,
        reverie_session_id,
        state,
        session_boundary,
    ))
}

fn translate_codex(
    reverie_session_id: SessionId,
    payload: &Value,
    sequences: &Mutex<HashMap<String, u64>>,
) -> Option<ActivityUpdate> {
    let envelope = parse_envelope(payload)?;
    let session_id = envelope.session_id.clone()?;

    // Stop is a continuation gate, not a completion signal. A matching Stop
    // hook can tell Codex to keep going with a new prompt, so it must never
    // lower a live session to AwaitingInput. Older Reverie-launched processes
    // may still have this hook installed, hence the server-side ignore even
    // though new launches no longer subscribe to it.
    if envelope.hook_event_name == "Stop" {
        return None;
    }

    let timestamp = envelope.timestamp.clone().unwrap_or_else(now_iso8601);
    let sequence = next_sequence(sequences, &session_id);
    let cwd = envelope.cwd.clone().unwrap_or_default();

    let turn_id = envelope.turn_id.as_deref();
    let state = match envelope.hook_event_name.as_str() {
        // Blocked on an approval for this turn.
        "PermissionRequest" => {
            let mut state = build_state_awaiting_permission(
                &session_id,
                timestamp.clone(),
                sequence,
                cwd,
                envelope.tool_name.as_deref().unwrap_or("tool"),
                envelope.tool_input.as_ref(),
            );
            state.turn = codex_turn(turn_id, &timestamp, ActivityStatus::AwaitingPermission);
            state
        }
        // Turn start, and (defensively) the tool edges we don't normally install:
        // the agent is working on `turn_id`.
        "UserPromptSubmit" | "PreToolUse" | "PostToolUse" => build_codex_turn_state(
            &session_id,
            timestamp,
            sequence,
            cwd,
            ActivityStatus::Working,
            turn_id,
        ),
        // Codex's external notifier is the definitive clean completion edge.
        // It fires only once the agent turn has actually completed and carries
        // the native thread and turn ids in its hyphenated envelope fields.
        "agent-turn-complete" => build_codex_turn_state(
            &session_id,
            timestamp,
            sequence,
            cwd,
            ActivityStatus::AwaitingInput,
            turn_id,
        ),
        // Session (re)start: not a turn. Its job is to capture the native id the
        // instant the session starts; the resting state is idle-at-the-prompt,
        // NOT working (a fresh/just-resumed session has no turn yet).
        "SessionStart" => build_codex_turn_state(
            &session_id,
            timestamp,
            sequence,
            cwd,
            if envelope.source.as_deref() == Some("compact") {
                ActivityStatus::Working
            } else {
                ActivityStatus::Idle
            },
            None,
        ),
        "Interrupt" => {
            let mut state = build_codex_turn_state(
                &session_id,
                timestamp,
                sequence,
                cwd,
                ActivityStatus::Idle,
                turn_id,
            );
            if let Some(turn) = &mut state.turn {
                turn.status = TurnStatus::Aborted;
            }
            state
        }
        "SessionEnd" => build_codex_turn_state(
            &session_id,
            timestamp,
            sequence,
            cwd,
            ActivityStatus::Idle,
            turn_id,
        ),
        _ => return None,
    };

    // Same boundary contract as Claude: SessionStart is where a (re)started Codex
    // conversation can present a new native id for the correlator to re-point.
    let session_boundary =
        envelope.hook_event_name == "SessionStart" && envelope.source.as_deref() != Some("compact");

    Some(hook_state_update(
        HookSource::CodexCli,
        reverie_session_id,
        state,
        session_boundary,
    ))
}

fn build_simple_state(
    session_id: &str,
    timestamp: String,
    sequence: u64,
    cwd: String,
    status: ActivityStatus,
) -> ActivityState {
    ActivityState {
        version: ACTIVITY_VERSION,
        session_id: session_id.to_owned(),
        status,
        updated_at: timestamp,
        sequence,
        cwd,
        turn: None,
        active_tools: Vec::new(),
        awaiting_permission: None,
        last_error: None,
        final_exit: None,
    }
}

/// The turn descriptor for a Codex turn-scoped event, or `None` for a turn-less
/// event (SessionStart). The reconciler keys turn lifecycle off `turn.id`, so
/// carrying it is what lets a stale end edge be told apart from a current one.
fn codex_turn(
    turn_id: Option<&str>,
    timestamp: &str,
    status: ActivityStatus,
) -> Option<ActivityTurn> {
    turn_id.map(|id| ActivityTurn {
        id: id.to_owned(),
        status: match status {
            ActivityStatus::AwaitingInput | ActivityStatus::Done | ActivityStatus::Error => {
                TurnStatus::Completed
            }
            _ => TurnStatus::Running,
        },
        started_at: timestamp.to_owned(),
        ended_at: matches!(
            status,
            ActivityStatus::AwaitingInput | ActivityStatus::Idle | ActivityStatus::Done
        )
        .then(|| timestamp.to_owned()),
    })
}

/// A Codex status state stamped with its turn, so the reconciler can order it.
fn build_codex_turn_state(
    session_id: &str,
    timestamp: String,
    sequence: u64,
    cwd: String,
    status: ActivityStatus,
    turn_id: Option<&str>,
) -> ActivityState {
    let turn = codex_turn(turn_id, &timestamp, status);
    ActivityState {
        version: ACTIVITY_VERSION,
        session_id: session_id.to_owned(),
        status,
        updated_at: timestamp,
        sequence,
        cwd,
        turn,
        active_tools: Vec::new(),
        awaiting_permission: None,
        last_error: None,
        final_exit: None,
    }
}

/// Human-readable one-liner for a tool call, used both for the permission
/// prompt summary and the active-tool line. Keeps per-tool phrasing in one
/// place so "Run shell: …" reads the same whether the tool is pending approval
/// or already running.
fn tool_display_summary(tool_name: &str, tool_input: Option<&Value>) -> String {
    match tool_name {
        "Bash" => tool_input
            .and_then(|value| value.get("command").and_then(Value::as_str))
            .map(|cmd| format!("Run shell: {cmd}"))
            .unwrap_or_else(|| "Run a shell command".to_owned()),
        "Edit" | "Write" => tool_input
            .and_then(|value| value.get("file_path").and_then(Value::as_str))
            .map(|path| format!("Edit {path}"))
            .unwrap_or_else(|| format!("Use {tool_name}")),
        "Read" => tool_input
            .and_then(|value| value.get("file_path").and_then(Value::as_str))
            .map(|path| format!("Read {path}"))
            .unwrap_or_else(|| "Read a file".to_owned()),
        other => format!("Use {other}"),
    }
}

/// Working state carrying the single tool that just started, so the dashboard
/// can render the active-tool line. The model is intentionally one-tool-deep:
/// `PostToolUse` clears it back to a bare Working heartbeat.
fn build_state_working_tool(
    session_id: &str,
    timestamp: String,
    sequence: u64,
    cwd: String,
    tool_name: &str,
    tool_input: Option<&Value>,
) -> ActivityState {
    ActivityState {
        version: ACTIVITY_VERSION,
        session_id: session_id.to_owned(),
        status: ActivityStatus::Working,
        updated_at: timestamp.clone(),
        sequence,
        cwd,
        turn: None,
        active_tools: vec![ActiveTool {
            tool_call_id: format!("tool-{sequence}"),
            tool_name: tool_name.to_owned(),
            started_at: timestamp,
            display_summary: Some(tool_display_summary(tool_name, tool_input)),
            child_task_id: None,
        }],
        awaiting_permission: None,
        last_error: None,
        final_exit: None,
    }
}

fn build_state_awaiting_permission(
    session_id: &str,
    timestamp: String,
    sequence: u64,
    cwd: String,
    tool_name: &str,
    tool_input: Option<&Value>,
) -> ActivityState {
    let display_summary = tool_display_summary(tool_name, tool_input);

    ActivityState {
        version: ACTIVITY_VERSION,
        session_id: session_id.to_owned(),
        status: ActivityStatus::AwaitingPermission,
        updated_at: timestamp.clone(),
        sequence,
        cwd,
        turn: None,
        active_tools: Vec::new(),
        awaiting_permission: Some(PermissionRequest {
            id: format!("perm-{sequence}"),
            tool_name: tool_name.to_owned(),
            display_summary,
            args: tool_input.cloned(),
            requested_at: timestamp,
        }),
        last_error: None,
        final_exit: None,
    }
}

fn build_state_error(
    session_id: &str,
    timestamp: String,
    sequence: u64,
    cwd: String,
    category: ErrorCategory,
    message: String,
) -> ActivityState {
    ActivityState {
        version: ACTIVITY_VERSION,
        session_id: session_id.to_owned(),
        status: ActivityStatus::Error,
        updated_at: timestamp.clone(),
        sequence,
        cwd,
        turn: None,
        active_tools: Vec::new(),
        awaiting_permission: None,
        last_error: Some(ActivityError {
            category,
            message,
            recoverable: !matches!(category, ErrorCategory::Authentication),
            occurred_at: timestamp,
        }),
        final_exit: None,
    }
}

fn build_state_done(
    session_id: &str,
    timestamp: String,
    sequence: u64,
    cwd: String,
    reason: ExitReason,
) -> ActivityState {
    ActivityState {
        version: ACTIVITY_VERSION,
        session_id: session_id.to_owned(),
        status: ActivityStatus::Done,
        updated_at: timestamp,
        sequence,
        cwd,
        turn: None,
        active_tools: Vec::new(),
        awaiting_permission: None,
        last_error: None,
        final_exit: Some(FinalExit {
            code: Some(0),
            signal: None,
            reason,
        }),
    }
}

fn error_category_from_claude_label(label: &str) -> ErrorCategory {
    match label {
        "rate_limit" => ErrorCategory::RateLimit,
        "auth_failed" | "authentication" => ErrorCategory::Authentication,
        "network" => ErrorCategory::Network,
        "context_overflow" => ErrorCategory::ContextOverflow,
        "billing_error" => ErrorCategory::Other,
        "cancelled" => ErrorCategory::Cancelled,
        _ => ErrorCategory::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state(payload: Value) -> ActivityState {
        let update = translate_claude(
            SessionId::from_bytes([1; 16]),
            &payload,
            &Mutex::new(HashMap::new()),
        )
        .unwrap();
        let ActivityUpdate::State { state, .. } = update else {
            panic!("state")
        };
        state
    }

    #[test]
    fn startup_and_resume_are_idle_but_compaction_is_not_a_restart() {
        for source in ["startup", "resume", "clear"] {
            assert_eq!(
                state(json!({"session_id":"s", "hook_event_name":"SessionStart", "source":source}))
                    .status,
                ActivityStatus::Idle
            );
        }
        let update = translate_claude(
            SessionId::from_bytes([1; 16]),
            &json!({"session_id":"s", "hook_event_name":"SessionStart", "source":"compact"}),
            &Mutex::new(HashMap::new()),
        )
        .unwrap();
        let ActivityUpdate::State {
            state,
            session_boundary,
            ..
        } = update
        else {
            panic!("state")
        };
        assert_eq!(state.status, ActivityStatus::Working);
        assert!(!session_boundary);
    }

    #[test]
    fn stop_failure_uses_current_error_fields() {
        let state = state(
            json!({"session_id":"s", "hook_event_name":"StopFailure", "error":"rate_limit", "error_details":"Rate limited"}),
        );
        assert_eq!(state.status, ActivityStatus::Error);
        let error = state.last_error.unwrap();
        assert_eq!(error.category, ErrorCategory::RateLimit);
        assert_eq!(error.message, "Rate limited");
    }

    #[test]
    fn subagent_events_cannot_reopen_parent_state() {
        let update = translate_claude(
            SessionId::from_bytes([1; 16]),
            &json!({"session_id":"s", "hook_event_name":"PreToolUse", "agent_id":"child", "tool_name":"Bash"}),
            &Mutex::new(HashMap::new()),
        );
        assert!(update.is_none());
    }

    #[test]
    fn elicitation_is_a_question_and_interrupt_is_neutral_idle() {
        assert_eq!(
            state(json!({"session_id":"s", "hook_event_name":"Elicitation"})).status,
            ActivityStatus::AwaitingResponse
        );
        assert_eq!(
            state(json!({"session_id":"s", "hook_event_name":"ElicitationResult"})).status,
            ActivityStatus::Working
        );
        assert_eq!(state(json!({"session_id":"s", "hook_event_name":"PostToolUseFailure", "is_interrupt":true})).status, ActivityStatus::Idle);
    }
}
