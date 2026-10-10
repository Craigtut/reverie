use super::*;
use std::{
    io::{Read, Write},
    net::{Shutdown, TcpStream},
    time::Duration,
};

fn post_hook(port: u16, path: &str, body: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connects to hook server");
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .expect("set read timeout");
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).expect("write request");
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    let _ = stream.shutdown(Shutdown::Both);
    response
}

fn wait_for_update(handle: &HookServerHandle) -> ActivityUpdate {
    handle
        .events
        .recv_timeout(Duration::from_secs(3))
        .expect("hook update arrived")
}

const TEST_TOKEN: &str = "tok-test-001";

fn claude_path() -> String {
    format!("/hooks/claude/{TEST_TOKEN}")
}

fn codex_path() -> String {
    format!("/hooks/codex/{TEST_TOKEN}")
}

/// A stable, valid Reverie session id (a UUID) used across the tests. The
/// hook auth map stores `SessionId`, so registration takes one of these.
fn test_reverie_session_id() -> SessionId {
    uuid::Uuid::from_bytes([0x11; 16])
}

fn started_with_token(source: HookSource) -> HookServerHandle {
    let handle = start_hook_server().expect("server starts");
    handle
        .control
        .register_session(source, TEST_TOKEN.to_owned(), test_reverie_session_id());
    handle
}

/// Spin until `key` is parked in the registry (the waiter thread has
/// registered), so a test can resolve it without racing the spawn. Panics if
/// it never appears within a short budget.
fn await_pending(handle: &HookServerHandle, key: &crate::approval::ApprovalKey) {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !handle.control.approvals.is_pending(key) {
        assert!(
            std::time::Instant::now() < deadline,
            "approval waiter never registered for {key:?}"
        );
        std::thread::yield_now();
    }
}

#[test]
fn claude_permission_request_translates_and_answers_from_the_card() {
    let handle = started_with_token(HookSource::ClaudeCode);
    let body = serde_json::json!({
        "hook_event_name": "PermissionRequest",
        "session_id": "claude-sess-1",
        "cwd": "/repo",
        "timestamp": "2026-05-28T12:34:56.000Z",
        "tool_name": "Bash",
        "tool_input": { "command": "rm -rf foo/" }
    })
    .to_string();

    // The hook now blocks for a decision, so post on a background thread.
    let port = handle.port();
    let path = claude_path();
    let poster = std::thread::spawn(move || post_hook(port, &path, &body));

    // The activity update still flows immediately, carrying the permission id.
    let perm_id = match wait_for_update(&handle) {
        ActivityUpdate::State {
            source,
            key,
            fidelity,
            state,
            ..
        } => {
            assert_eq!(source, ActivitySourceKind::ClaudeCode);
            assert_eq!(key, SessionKey::Reverie(test_reverie_session_id()));
            assert_eq!(fidelity, Fidelity::Definitive);
            assert_eq!(state.session_id, "claude-sess-1");
            assert_eq!(state.status, ActivityStatus::AwaitingPermission);
            let perm = state.awaiting_permission.expect("permission set");
            assert_eq!(perm.tool_name, "Bash");
            assert_eq!(perm.display_summary, "Run shell: rm -rf foo/");
            perm.id
        }
        other => panic!("expected State, got {other:?}"),
    };

    // Approve from the card: the held hook responds 200 with the allow body.
    let key = (test_reverie_session_id(), perm_id);
    await_pending(&handle, &key);
    assert!(
        handle
            .control
            .approvals
            .resolve(&key, ApprovalDecision::Allow)
    );

    let response = poster.join().expect("poster thread");
    assert!(response.starts_with("HTTP/1.1 200"), "response: {response}");
    assert!(
        response.contains("\"behavior\":\"allow\""),
        "response: {response}"
    );
}

#[test]
fn claude_permission_request_for_an_asking_tool_is_a_question_not_an_approval() {
    let handle = started_with_token(HookSource::ClaudeCode);
    let body = serde_json::json!({
        "hook_event_name": "PermissionRequest",
        "session_id": "claude-sess-ask",
        "cwd": "/repo",
        "timestamp": "2026-05-28T12:34:56.000Z",
        "tool_name": "AskUserQuestion",
        "tool_input": { "questions": [] }
    })
    .to_string();

    // An asking tool is answered in the session, not via Approve/Deny, so the
    // hook is NOT held open: the reply comes back immediately with no decision,
    // and there is no awaitingPermission payload to render buttons against.
    let response = post_hook(handle.port(), &claude_path(), &body);
    assert!(response.starts_with("HTTP/1.1 204"), "response: {response}");

    match wait_for_update(&handle) {
        ActivityUpdate::State { state, .. } => {
            assert_eq!(state.status, ActivityStatus::AwaitingResponse);
            assert!(
                state.awaiting_permission.is_none(),
                "an asking tool must not surface an approvable permission"
            );
        }
        other => panic!("expected State, got {other:?}"),
    }
}

#[test]
fn permission_request_without_a_decision_times_out_to_no_decision() {
    // Use a registry path with a tiny window by resolving deny and asserting
    // the deny body; the timeout path itself is covered in approval.rs.
    let handle = started_with_token(HookSource::CodexCli);
    let body = serde_json::json!({
        "hook_event_name": "PermissionRequest",
        "session_id": "codex-sess-1",
        "cwd": "/repo",
        "timestamp": "2026-05-28T12:34:56.000Z",
        "tool_name": "Bash",
        "tool_input": { "command": "ls" }
    })
    .to_string();

    let port = handle.port();
    let path = codex_path();
    let poster = std::thread::spawn(move || post_hook(port, &path, &body));

    let perm_id = match wait_for_update(&handle) {
        ActivityUpdate::State { state, .. } => {
            assert_eq!(state.status, ActivityStatus::AwaitingPermission);
            state.awaiting_permission.expect("permission set").id
        }
        other => panic!("expected State, got {other:?}"),
    };

    let key = (test_reverie_session_id(), perm_id);
    await_pending(&handle, &key);
    assert!(
        handle
            .control
            .approvals
            .resolve(&key, ApprovalDecision::Deny)
    );

    let response = poster.join().expect("poster thread");
    assert!(response.starts_with("HTTP/1.1 200"), "response: {response}");
    assert!(
        response.contains("\"behavior\":\"deny\""),
        "response: {response}"
    );
}

#[test]
fn claude_pre_tool_use_surfaces_active_tool_with_summary() {
    let handle = started_with_token(HookSource::ClaudeCode);
    let body = serde_json::json!({
        "hook_event_name": "PreToolUse",
        "session_id": "claude-sess-2",
        "cwd": "/repo",
        "tool_name": "Bash",
        "tool_input": { "command": "npm test" }
    })
    .to_string();

    let response = post_hook(handle.port(), &claude_path(), &body);
    assert!(response.starts_with("HTTP/1.1 204"), "response: {response}");

    match wait_for_update(&handle) {
        ActivityUpdate::State { state, .. } => {
            assert_eq!(state.status, ActivityStatus::Working);
            assert_eq!(
                state.active_tools.len(),
                1,
                "PreToolUse should set one active tool"
            );
            let tool = &state.active_tools[0];
            assert_eq!(tool.tool_name, "Bash");
            assert_eq!(tool.display_summary.as_deref(), Some("Run shell: npm test"));
        }
        other => panic!("expected State, got {other:?}"),
    }
}

#[test]
fn claude_post_tool_use_clears_active_tool_but_stays_working() {
    let handle = started_with_token(HookSource::ClaudeCode);
    let body = serde_json::json!({
        "hook_event_name": "PostToolUse",
        "session_id": "claude-sess-3",
        "cwd": "/repo",
        "tool_name": "Bash"
    })
    .to_string();

    let _ = post_hook(handle.port(), &claude_path(), &body);
    match wait_for_update(&handle) {
        ActivityUpdate::State { state, .. } => {
            assert_eq!(state.status, ActivityStatus::Working);
            assert!(
                state.active_tools.is_empty(),
                "PostToolUse should clear active tools"
            );
        }
        other => panic!("expected State, got {other:?}"),
    }
}

#[test]
fn claude_ask_user_question_pre_tool_use_marks_awaiting_response() {
    // AskUserQuestion blocks the turn on the user but, unlike a Stop, leaves
    // the turn live (no Stop fires). Surfacing it as Working would read as a
    // busy green agent; it must be AwaitingResponse so the dashboard shows it
    // needs you.
    let handle = started_with_token(HookSource::ClaudeCode);
    let body = serde_json::json!({
        "hook_event_name": "PreToolUse",
        "session_id": "claude-ask-1",
        "cwd": "/repo",
        "tool_name": "AskUserQuestion",
        "tool_input": { "questions": [] }
    })
    .to_string();

    let response = post_hook(handle.port(), &claude_path(), &body);
    assert!(response.starts_with("HTTP/1.1 204"), "response: {response}");

    match wait_for_update(&handle) {
        ActivityUpdate::State { state, .. } => {
            assert_eq!(state.status, ActivityStatus::AwaitingResponse);
            assert!(
                state.active_tools.is_empty(),
                "an asking tool is not a running work tool"
            );
        }
        other => panic!("expected State, got {other:?}"),
    }
}

#[test]
fn claude_notification_elicitation_marks_awaiting_response() {
    let handle = started_with_token(HookSource::ClaudeCode);
    let body = serde_json::json!({
        "hook_event_name": "Notification",
        "session_id": "claude-note-1",
        "cwd": "/repo",
        "notification_type": "elicitation_dialog",
        "message": "An MCP server is asking for input"
    })
    .to_string();

    let response = post_hook(handle.port(), &claude_path(), &body);
    assert!(response.starts_with("HTTP/1.1 204"), "response: {response}");

    match wait_for_update(&handle) {
        ActivityUpdate::State { state, .. } => {
            assert_eq!(state.status, ActivityStatus::AwaitingResponse);
        }
        other => panic!("expected State, got {other:?}"),
    }
}

#[test]
fn claude_notification_idle_prompt_recovers_idle_without_claiming_completion() {
    let handle = started_with_token(HookSource::ClaudeCode);
    let response = post_hook(
        handle.port(),
        &claude_path(),
        &serde_json::json!({
            "hook_event_name": "Notification", "session_id": "claude-note-2",
            "notification_type": "idle_prompt"
        })
        .to_string(),
    );
    assert!(response.starts_with("HTTP/1.1 204"));
    let ActivityUpdate::State { state, .. } = wait_for_update(&handle) else {
        panic!("state")
    };
    assert_eq!(state.status, ActivityStatus::Idle);
}

#[test]
fn asking_tool_and_notification_mapping_units() {
    assert!(is_asking_tool("AskUserQuestion"));
    assert!(is_asking_tool("ExitPlanMode"));
    assert!(!is_asking_tool("Bash"));

    assert_eq!(
        claude_notification_status(Some("elicitation_dialog")),
        Some(ActivityStatus::AwaitingResponse)
    );
    assert_eq!(
        claude_notification_status(Some("elicitation_complete")),
        Some(ActivityStatus::Working)
    );
    assert_eq!(
        claude_notification_status(Some("idle_prompt")),
        Some(ActivityStatus::Idle)
    );
    assert_eq!(claude_notification_status(Some("permission_prompt")), None);
    assert_eq!(claude_notification_status(None), None);
}

#[test]
fn codex_turn_complete_notification_marks_session_awaiting_input() {
    let handle = started_with_token(HookSource::CodexCli);
    let body = serde_json::json!({
        "type": "agent-turn-complete",
        "thread-id": "codex-sess-1",
        "turn-id": "turn-v4-or-v7",
        "cwd": "/repo",
        "input-messages": ["private prompt"],
        "last-assistant-message": "private response"
    })
    .to_string();

    let response = post_hook(handle.port(), &codex_path(), &body);
    assert!(response.starts_with("HTTP/1.1 204"), "response: {response}");

    match wait_for_update(&handle) {
        ActivityUpdate::State {
            source, key, state, ..
        } => {
            assert_eq!(source, ActivitySourceKind::CodexCli);
            assert_eq!(key, SessionKey::Reverie(test_reverie_session_id()));
            assert_eq!(state.session_id, "codex-sess-1");
            assert_eq!(state.status, ActivityStatus::AwaitingInput);
            assert_eq!(state.sequence, 1);
            assert_eq!(
                state.turn.as_ref().map(|turn| turn.id.as_str()),
                Some("turn-v4-or-v7")
            );
        }
        other => panic!("expected State, got {other:?}"),
    }
}

#[test]
fn codex_stop_hook_emits_no_state_change() {
    let handle = started_with_token(HookSource::CodexCli);
    let body = serde_json::json!({
        "hook_event_name": "Stop",
        "session_id": "codex-sess-1",
        "turn_id": "turn-1",
        "cwd": "/repo"
    })
    .to_string();

    let response = post_hook(handle.port(), &codex_path(), &body);
    assert!(response.starts_with("HTTP/1.1 204"), "response: {response}");
    assert!(
        handle
            .events
            .recv_timeout(Duration::from_millis(400))
            .is_err(),
        "Stop must not produce a Codex activity update"
    );
}

#[test]
fn sequence_increments_per_session() {
    let handle = started_with_token(HookSource::ClaudeCode);
    let body_one = serde_json::json!({
        "hook_event_name": "SessionStart",
        "session_id": "s-1",
        "cwd": "/repo"
    })
    .to_string();
    let body_two = serde_json::json!({
        "hook_event_name": "Stop",
        "session_id": "s-1",
        "cwd": "/repo"
    })
    .to_string();

    let _ = post_hook(handle.port(), &claude_path(), &body_one);
    let _ = post_hook(handle.port(), &claude_path(), &body_two);

    let first = wait_for_update(&handle);
    let second = wait_for_update(&handle);
    let seqs = [first, second]
        .into_iter()
        .map(|update| match update {
            ActivityUpdate::State { state, .. } => state.sequence,
            other => panic!("unexpected update {other:?}"),
        })
        .collect::<Vec<_>>();
    assert_eq!(seqs, vec![1, 2]);
}

#[test]
fn session_start_is_flagged_as_a_boundary_other_events_are_not() {
    // The correlator re-points a session's native id only on a boundary edge,
    // so SessionStart must carry the flag and ordinary turn events must not.
    let handle = started_with_token(HookSource::ClaudeCode);
    let _ = post_hook(
        handle.port(),
        &claude_path(),
        r#"{"hook_event_name":"SessionStart","session_id":"s","cwd":"/repo"}"#,
    );
    match wait_for_update(&handle) {
        ActivityUpdate::State {
            session_boundary, ..
        } => assert!(session_boundary, "SessionStart is a boundary"),
        other => panic!("expected State, got {other:?}"),
    }

    let _ = post_hook(
        handle.port(),
        &claude_path(),
        r#"{"hook_event_name":"Stop","session_id":"s","cwd":"/repo"}"#,
    );
    match wait_for_update(&handle) {
        ActivityUpdate::State {
            session_boundary, ..
        } => assert!(!session_boundary, "Stop is not a boundary"),
        other => panic!("expected State, got {other:?}"),
    }
}

#[test]
fn unknown_paths_404_without_emitting() {
    let handle = start_hook_server().expect("server starts");
    let response = post_hook(handle.port(), "/hooks/unknown/whatever", r#"{}"#);
    assert!(response.starts_with("HTTP/1.1 404"), "response: {response}");
    assert!(handle.events.try_recv().is_err());
}

#[test]
fn invalid_json_returns_400() {
    let handle = started_with_token(HookSource::ClaudeCode);
    let response = post_hook(handle.port(), &claude_path(), "not json");
    assert!(response.starts_with("HTTP/1.1 400"), "response: {response}");
    assert!(handle.events.try_recv().is_err());
}

#[test]
fn unregistered_token_returns_401() {
    let handle = start_hook_server().expect("server starts");
    let body = serde_json::json!({"hook_event_name":"Stop","session_id":"x","cwd":"/"}).to_string();
    let response = post_hook(handle.port(), "/hooks/claude/never-registered", &body);
    assert!(response.starts_with("HTTP/1.1 401"), "response: {response}");
    assert!(handle.events.try_recv().is_err());
}

#[test]
fn revoke_blocks_further_posts() {
    let handle = started_with_token(HookSource::ClaudeCode);
    let body = serde_json::json!({"hook_event_name":"Stop","session_id":"x","cwd":"/"}).to_string();
    let response = post_hook(handle.port(), &claude_path(), &body);
    assert!(
        response.starts_with("HTTP/1.1 204"),
        "first call: {response}"
    );

    handle
        .control
        .revoke_session(HookSource::ClaudeCode, TEST_TOKEN);
    let response = post_hook(handle.port(), &claude_path(), &body);
    assert!(
        response.starts_with("HTTP/1.1 401"),
        "after revoke: {response}"
    );
}

#[test]
fn oversized_body_returns_413_without_emitting() {
    let handle = started_with_token(HookSource::ClaudeCode);
    let filler = "x".repeat(MAX_HOOK_BODY_BYTES + 1024);
    let body = serde_json::json!({
        "hook_event_name": "Stop",
        "session_id": "s-big",
        "cwd": "/repo",
        "message": filler
    })
    .to_string();
    assert!(body.len() > MAX_HOOK_BODY_BYTES);

    let response = post_hook(handle.port(), &claude_path(), &body);
    assert!(response.starts_with("HTTP/1.1 413"), "response: {response}");
    assert!(handle.events.try_recv().is_err());
}

#[test]
fn unknown_claude_event_does_not_change_activity() {
    let handle = started_with_token(HookSource::ClaudeCode);
    let body = serde_json::json!({
        "hook_event_name": "NotifyCompaction",
        "session_id": "claude-unknown",
        "cwd": "/repo"
    })
    .to_string();

    let response = post_hook(handle.port(), &claude_path(), &body);
    assert!(response.starts_with("HTTP/1.1 204"), "response: {response}");

    assert!(handle.events.try_recv().is_err());
}

#[test]
fn unknown_codex_event_does_not_change_activity() {
    let handle = started_with_token(HookSource::CodexCli);
    let body = serde_json::json!({
        "hook_event_name": "NotifyCompaction",
        "session_id": "codex-unknown",
        "cwd": "/repo"
    })
    .to_string();

    let response = post_hook(handle.port(), &codex_path(), &body);
    assert!(response.starts_with("HTTP/1.1 204"), "response: {response}");

    assert!(handle.events.try_recv().is_err());
}

// -----------------------------------------------------------------
// Phase 7: UserPromptSubmit -> additionalContext push delivery
// -----------------------------------------------------------------

/// Stub push source for tests: returns a canned nudge string.
struct StubPushSource(String);
impl HookPushSource for StubPushSource {
    fn pre_turn_nudge_for(&self, _: SessionId) -> String {
        self.0.clone()
    }
}

fn started_with_push(source: HookSource, push: Arc<dyn HookPushSource>) -> HookServerHandle {
    let handle = start_hook_server_with(Some(push)).expect("server starts");
    handle
        .control
        .register_session(source, TEST_TOKEN.to_owned(), test_reverie_session_id());
    handle
}

#[test]
fn user_prompt_submit_returns_additional_context_when_push_source_has_nudge() {
    let push = Arc::new(StubPushSource("You have 1 unread message.".to_owned()));
    let handle = started_with_push(
        HookSource::ClaudeCode,
        push.clone() as Arc<dyn HookPushSource>,
    );
    let response = post_hook(
        handle.port(),
        &claude_path(),
        r#"{"hook_event_name":"UserPromptSubmit","session_id":"native-sess","cwd":"/repo"}"#,
    );
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "expected 200 OK, got {response}"
    );
    let body_start = response.rfind("\r\n\r\n").expect("response has body");
    let body = &response[body_start + 4..];
    let parsed: Value = serde_json::from_str(body).expect("body is JSON");
    assert_eq!(
        parsed["hookSpecificOutput"]["additionalContext"],
        "You have 1 unread message."
    );
    assert_eq!(
        parsed["hookSpecificOutput"]["hookEventName"],
        "UserPromptSubmit"
    );
}

#[test]
fn user_prompt_submit_falls_back_to_204_when_nudge_is_empty() {
    let push = Arc::new(StubPushSource(String::new()));
    let handle = started_with_push(
        HookSource::CodexCli,
        push.clone() as Arc<dyn HookPushSource>,
    );
    let response = post_hook(
        handle.port(),
        &codex_path(),
        r#"{"hook_event_name":"UserPromptSubmit","session_id":"native-c","cwd":"/repo"}"#,
    );
    assert!(
        response.starts_with("HTTP/1.1 204"),
        "expected 204 when nudge is empty, got {response}"
    );
}
