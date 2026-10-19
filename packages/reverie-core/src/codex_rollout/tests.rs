use super::*;
use std::io::Write;
use tempfile::TempDir;

// Empirical check of the live watcher path (not just the pure fold): start the
// real session-log watcher, register a rollout file as the launch path does,
// then append `turn_aborted` and assert the watcher folds the explicit
// interruption through to `Idle`.
#[test]
fn watcher_detects_appended_turn_aborted() {
    use crate::activity_source::ActivityUpdate;
    use crate::session_log::start_session_log_watcher;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    let dir = TempDir::new().unwrap();
    // Deliberately the raw (possibly symlinked, e.g. /tmp -> /private/tmp)
    // path: the watcher must canonicalize internally so its keys match the
    // resolved paths FSEvents reports, or every append event is dropped.
    let path = dir.path().join("rollout-live.jsonl");
    {
        let mut f = fs::File::create(&path).unwrap();
        writeln!(f, "{META}").unwrap();
        writeln!(
            f,
            r#"{{"type":"event_msg","payload":{{"type":"task_started"}}}}"#
        )
        .unwrap();
        f.flush().unwrap();
    }

    let watcher = start_session_log_watcher(Arc::new(CodexLogSource)).unwrap();
    watcher.control.register(path.clone());

    // Registration triggers an immediate read: we should see Working.
    let first = watcher
        .events
        .recv_timeout(Duration::from_secs(2))
        .expect("initial state on register");
    match first {
        ActivityUpdate::State { state, .. } => {
            assert_eq!(state.status, ActivityStatus::Working)
        }
        other => panic!("unexpected first update: {other:?}"),
    }

    // Append the explicit interruption record, then wait for the watcher to
    // deliver the Idle fold.
    {
        let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            f,
            r#"{{"type":"event_msg","payload":{{"type":"turn_aborted"}}}}"#
        )
        .unwrap();
        f.flush().unwrap();
    }

    let deadline = Instant::now() + Duration::from_secs(6);
    let mut got_awaiting = false;
    while Instant::now() < deadline {
        match watcher.events.recv_timeout(Duration::from_millis(500)) {
            Ok(ActivityUpdate::State { state, .. }) => {
                if state.status == ActivityStatus::Idle {
                    got_awaiting = true;
                    break;
                }
            }
            Ok(_) => {}
            Err(_) => {}
        }
    }
    assert!(
        got_awaiting,
        "watcher never delivered Idle after turn_aborted was appended"
    );
}

fn write_rollout(dir: &Path, name: &str, lines: &[&str]) -> PathBuf {
    let path = dir.join(name);
    let mut file = fs::File::create(&path).unwrap();
    for line in lines {
        writeln!(file, "{line}").unwrap();
    }
    path
}

const META: &str = r#"{"timestamp":"2026-05-30T02:35:54.030Z","type":"session_meta","payload":{"id":"019e-codex","cwd":"/Users/dev/proj","cli_version":"0.135.0"}}"#;

#[test]
fn title_context_reads_recent_user_messages_and_skips_context_injections() {
    let dir = TempDir::new().unwrap();
    let path = write_rollout(
        dir.path(),
        "rollout-title.jsonl",
        &[
            META,
            r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\n<INSTRUCTIONS>ignore</INSTRUCTIONS>"},{"type":"input_text","text":"<environment_context>\n<cwd>/tmp</cwd>"}]}}"##,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fix the parser tests"}]}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","text_elements":[{"text":"Add Codex title generation"}]}}"#,
        ],
    );

    let context = read_codex_title_context(&path, 4, 10_000)
        .unwrap()
        .expect("title context");
    assert_eq!(context.user_message_count, 2);
    assert_eq!(
        context.user_messages,
        vec![
            "Fix the parser tests".to_owned(),
            "Add Codex title generation".to_owned(),
        ]
    );
    assert_eq!(context.sequence, 4);
}

#[test]
fn reentry_context_keeps_users_assistants_and_tools_in_order() {
    let dir = TempDir::new().unwrap();
    let path = write_rollout(
        dir.path(),
        "rollout-reentry.jsonl",
        &[
            META,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fix the failing parser test"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"c1","arguments":"{\"command\":[\"bash\",\"-lc\",\"npm test\"]}"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"The parser test passes now."}]}}"#,
        ],
    );

    let context = read_codex_reentry_context(&path, ReentryBudget::default())
        .unwrap()
        .expect("reentry context");
    assert_eq!(context.entries.len(), 3);
    assert_eq!(
        context.entries[0].role,
        crate::reentry_context::ReentryRole::User
    );
    assert_eq!(context.entries[0].text, "Fix the failing parser test");
    assert_eq!(
        context.entries[1].role,
        crate::reentry_context::ReentryRole::Tool
    );
    assert_eq!(context.entries[1].text, "Run shell: bash -lc npm test");
    assert_eq!(
        context.entries[2].role,
        crate::reentry_context::ReentryRole::Assistant
    );
    assert_eq!(context.entries[2].text, "The parser test passes now.");
}

#[test]
fn reentry_context_is_none_for_an_empty_rollout() {
    let dir = TempDir::new().unwrap();
    let path = write_rollout(dir.path(), "rollout-empty.jsonl", &[META]);
    let context = read_codex_reentry_context(&path, ReentryBudget::default()).unwrap();
    assert!(context.is_none());
}

#[test]
fn title_context_applies_message_and_char_budgets_from_the_end() {
    let dir = TempDir::new().unwrap();
    let path = write_rollout(
        dir.path(),
        "rollout-title-budget.jsonl",
        &[
            META,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"first message"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"second message"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"third message with extra detail"}]}}"#,
        ],
    );

    let context = read_codex_title_context(&path, 2, 20)
        .unwrap()
        .expect("title context");
    assert_eq!(context.user_message_count, 3);
    assert_eq!(
        context.user_messages,
        vec!["third message wit...".to_owned()]
    );
}

#[test]
fn task_complete_finishes_without_notification() {
    let dir = TempDir::new().unwrap();
    let path = write_rollout(
        dir.path(),
        "rollout-x.jsonl",
        &[
            META,
            r#"{"timestamp":"t1","type":"event_msg","payload":{"type":"task_started","turn_id":"a"}}"#,
            r#"{"timestamp":"t2","type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"c1","arguments":"{\"command\":[\"bash\",\"-lc\",\"npm test\"]}"}}"#,
        ],
    );

    let state = read_codex_rollout_state(&path).unwrap().expect("state");
    assert_eq!(state.session_id, "019e-codex");
    assert_eq!(state.cwd, "/Users/dev/proj");
    assert_eq!(state.status, ActivityStatus::Working);
    assert_eq!(state.active_tools.len(), 1);
    assert_eq!(
        state.active_tools[0].display_summary.as_deref(),
        Some("Run shell: bash -lc npm test")
    );
    let working_seq = state.sequence;

    // Append the tool output + task_complete. The tool clears and sequence
    // advances, and the completed turn is ready even without its notifier.
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(
        file,
        r#"{{"timestamp":"t3","type":"response_item","payload":{{"type":"function_call_output","call_id":"c1","output":"ok"}}}}"#
    )
    .unwrap();
    writeln!(
        file,
        r#"{{"timestamp":"t4","type":"event_msg","payload":{{"type":"task_complete","turn_id":"a"}}}}"#
    )
    .unwrap();

    let state = read_codex_rollout_state(&path).unwrap().expect("state");
    assert_eq!(state.status, ActivityStatus::AwaitingInput);
    assert!(state.active_tools.is_empty());
    assert!(state.sequence > working_seq);
}

#[test]
fn escalated_call_surfaces_awaiting_permission_until_resolved() {
    let dir = TempDir::new().unwrap();
    let path = write_rollout(
        dir.path(),
        "rollout-esc.jsonl",
        &[
            META,
            r#"{"type":"event_msg","payload":{"type":"task_started"}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"e1","arguments":"{\"command\":[\"bash\",\"-lc\",\"npm i\"],\"with_escalated_permissions\":true,\"justification\":\"network\"}"}}"#,
        ],
    );

    let state = read_codex_rollout_state(&path).unwrap().expect("state");
    assert_eq!(state.status, ActivityStatus::AwaitingPermission);
    let perm = state.awaiting_permission.expect("approval detail");
    assert_eq!(perm.id, "e1");
    assert_eq!(perm.tool_name, "shell");

    // Once the call resolves, the approval clears and we are working again.
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(
        file,
        r#"{{"type":"response_item","payload":{{"type":"function_call_output","call_id":"e1","output":"ok"}}}}"#
    )
    .unwrap();
    let state = read_codex_rollout_state(&path).unwrap().expect("state");
    assert_eq!(state.status, ActivityStatus::Working);
    assert!(state.awaiting_permission.is_none());
}

#[test]
fn resume_marker_after_a_finished_turn_reads_idle() {
    let dir = TempDir::new().unwrap();
    let path = write_rollout(
        dir.path(),
        "rollout-resumed-idle.jsonl",
        &[
            META,
            r#"{"timestamp":"t1","type":"event_msg","payload":{"type":"task_started","turn_id":"a"}}"#,
            r#"{"timestamp":"t2","type":"event_msg","payload":{"type":"task_complete","turn_id":"a"}}"#,
            r#"{"timestamp":"t3","type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":"thread-1"}}"#,
        ],
    );

    let state = read_codex_rollout_state(&path).unwrap().expect("state");
    assert_eq!(state.status, ActivityStatus::Idle);
    assert_eq!(
        state.turn.as_ref().map(|turn| turn.status).expect("turn"),
        TurnStatus::Completed
    );
}

#[test]
fn resume_marker_does_not_end_an_open_turn_or_active_goal() {
    let dir = TempDir::new().unwrap();
    let open_turn = write_rollout(
        dir.path(),
        "rollout-open-turn.jsonl",
        &[
            META,
            r#"{"timestamp":"t1","type":"event_msg","payload":{"type":"task_started","turn_id":"a"}}"#,
            r#"{"timestamp":"t2","type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":"thread-1"}}"#,
        ],
    );
    let state = read_codex_rollout_state(&open_turn)
        .unwrap()
        .expect("state");
    assert_eq!(state.status, ActivityStatus::Working);

    let goal = write_rollout(
        dir.path(),
        "rollout-goal-resume.jsonl",
        &[
            META,
            r#"{"timestamp":"t1","type":"event_msg","payload":{"type":"thread_goal_updated","turnId":"g","goal":{"status":"active"}}}"#,
            r#"{"timestamp":"t2","type":"event_msg","payload":{"type":"task_complete","turn_id":"g"}}"#,
            r#"{"timestamp":"t3","type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":"thread-1"}}"#,
        ],
    );
    let state = read_codex_rollout_state(&goal).unwrap().expect("state");
    assert_eq!(state.status, ActivityStatus::Working);
}

#[test]
fn active_goal_update_keeps_resumed_goal_working_after_turn_complete() {
    let dir = TempDir::new().unwrap();
    let path = write_rollout(
        dir.path(),
        "rollout-goal-active.jsonl",
        &[
            META,
            r#"{"timestamp":"t1","type":"event_msg","payload":{"type":"task_started","turn_id":"a"}}"#,
            r#"{"timestamp":"t2","type":"event_msg","payload":{"type":"task_complete","turn_id":"a"}}"#,
            r#"{"timestamp":"t3","type":"event_msg","payload":{"type":"thread_goal_updated","turnId":"b","threadId":"thread-1","goal":{"status":"active","objective":"private","createdAt":"t0","updatedAt":"t3","tokensUsed":10,"timeUsedSeconds":1}}}"#,
        ],
    );

    let state = read_codex_rollout_state(&path).unwrap().expect("state");
    assert_eq!(state.status, ActivityStatus::Working);
    assert_eq!(state.turn.as_ref().map(|turn| turn.id.as_str()), Some("b"));
    assert_eq!(
        state.turn.as_ref().map(|turn| turn.status).expect("turn"),
        TurnStatus::Completed
    );
}

#[test]
fn active_goal_stays_working_across_an_intermediate_task_complete() {
    let dir = TempDir::new().unwrap();
    let path = write_rollout(
        dir.path(),
        "rollout-goal-latched.jsonl",
        &[
            META,
            r#"{"timestamp":"t1","type":"event_msg","payload":{"type":"thread_goal_updated","turnId":"goal-turn","goal":{"status":"active"}}}"#,
            r#"{"timestamp":"t2","type":"event_msg","payload":{"type":"task_complete","turn_id":"goal-turn"}}"#,
        ],
    );

    let state = read_codex_rollout_state(&path).unwrap().expect("state");
    assert_eq!(state.status, ActivityStatus::Working);
    assert_eq!(
        state.turn.as_ref().map(|turn| turn.status).expect("turn"),
        TurnStatus::Completed
    );
}

#[test]
fn terminal_goal_update_returns_to_input_waiting() {
    let dir = TempDir::new().unwrap();
    let path = write_rollout(
        dir.path(),
        "rollout-goal-complete.jsonl",
        &[
            META,
            r#"{"timestamp":"t1","type":"event_msg","payload":{"type":"thread_goal_updated","turnId":"a","threadId":"thread-1","goal":{"status":"active","objective":"private","createdAt":"t0","updatedAt":"t1","tokensUsed":10,"timeUsedSeconds":1}}}"#,
            r#"{"timestamp":"t2","type":"event_msg","payload":{"type":"thread_goal_updated","turnId":"a","threadId":"thread-1","goal":{"status":"complete","objective":"private","createdAt":"t0","updatedAt":"t2","tokensUsed":20,"timeUsedSeconds":2}}}"#,
        ],
    );

    let state = read_codex_rollout_state(&path).unwrap().expect("state");
    assert_eq!(state.status, ActivityStatus::AwaitingInput);
    assert_eq!(state.turn.as_ref().map(|turn| turn.id.as_str()), Some("a"));
    assert_eq!(
        state.turn.as_ref().map(|turn| turn.status).expect("turn"),
        TurnStatus::Completed
    );
}

#[test]
fn every_current_terminal_goal_status_returns_to_input_waiting() {
    for terminal in [
        "complete",
        "usageLimited",
        "budgetLimited",
        "paused",
        "blocked",
    ] {
        let mut fold = CodexRolloutFold::new();
        let input = format!(
            "{META}\n{{\"timestamp\":\"t1\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"thread_goal_updated\",\"turnId\":\"a\",\"goal\":{{\"status\":\"active\"}}}}}}\n{{\"timestamp\":\"t2\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"thread_goal_updated\",\"turnId\":\"a\",\"goal\":{{\"status\":\"{terminal}\"}}}}}}\n"
        );
        let state = fold.push(&input).expect("state");
        assert_eq!(
            state.status,
            ActivityStatus::AwaitingInput,
            "terminal goal status {terminal}"
        );
    }
}

#[test]
fn incremental_fold_handles_chunks_split_mid_line_and_only_folds_new_records() {
    let mut fold = CodexRolloutFold::new();
    // task_started before any session_meta: processed, but no id to bind yet.
    assert!(
        fold.push("{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n")
            .is_none()
    );

    // session_meta arrives split mid-line across two pushes (an appended tail
    // can end anywhere). The partial line must buffer until its newline.
    let meta = r#"{"type":"session_meta","payload":{"id":"c9","cwd":"/p"}}"#;
    let (head, rest) = meta.split_at(24);
    assert!(
        fold.push(head).is_none(),
        "partial line: nothing to emit yet"
    );
    let state = fold.push(&format!("{rest}\n")).expect("id now known");
    assert_eq!(state.session_id, "c9");
    assert_eq!(state.status, ActivityStatus::Working);
    let seq_after_meta = state.sequence;

    // An incomplete trailing record (no newline yet) buffers without being
    // folded: status and sequence are unchanged from the last complete line.
    let state = fold
        .push(r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#)
        .expect("id known");
    assert_eq!(state.status, ActivityStatus::Working);
    assert_eq!(state.sequence, seq_after_meta);

    // The newline completes it; only the one new record is folded (we never
    // re-read history), and the sequence advances so the consumer applies it.
    let state = fold
        .push("\n")
        .expect("newline completes the buffered record");
    assert_eq!(state.status, ActivityStatus::AwaitingInput);
    assert_eq!(state.sequence, seq_after_meta + 1);
}

#[test]
fn one_large_chunk_folds_like_line_by_line_and_stays_linear() {
    const TURNS: usize = 200_000;
    let meta = r#"{"type":"session_meta","payload":{"id":"big","cwd":"/p"}}"#;
    let started = r#"{"type":"event_msg","payload":{"type":"task_started"}}"#;
    let complete = r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#;
    let mut body = format!("{meta}\n");
    for _ in 0..TURNS {
        body.push_str(started);
        body.push('\n');
        body.push_str(complete);
        body.push('\n');
    }

    // Line by line, the way an appending tail is usually fed.
    let mut incremental = CodexRolloutFold::new();
    let mut expected = None;
    for line in body.split_inclusive('\n').take(201) {
        expected = incremental.push(line);
    }

    // The watcher's initial read hands the whole file over as one chunk, plus a
    // record still being written. Draining this line by line used to shift the
    // remaining buffer each time, so the budget here is far above the linear
    // cost and far below the quadratic one.
    let mut whole = CodexRolloutFold::new();
    let clock = std::time::Instant::now();
    let state = whole
        .push(&format!("{body}{started}"))
        .expect("session id known");
    assert!(
        clock.elapsed() < std::time::Duration::from_secs(30),
        "folding {TURNS} turns in one chunk took {:?}",
        clock.elapsed()
    );
    assert_eq!(state.status, ActivityStatus::AwaitingInput);
    // Every record counts, session_meta included.
    assert_eq!(state.sequence, (TURNS * 2 + 1) as u64);

    // The trailing partial record stayed buffered and folds once completed.
    let state = whole.push("\n").expect("completed record folds");
    assert_eq!(state.status, ActivityStatus::Working);
    assert_eq!(state.sequence, (TURNS * 2 + 2) as u64);

    // The first 200 lines agree with the line-by-line fold.
    let mut prefix = CodexRolloutFold::new();
    let prefix_state = prefix
        .push(&body.split_inclusive('\n').take(201).collect::<String>())
        .expect("session id known");
    let expected = expected.expect("session id known");
    assert_eq!(prefix_state.status, expected.status);
    assert_eq!(prefix_state.sequence, expected.sequence);
}

#[test]
fn returns_none_without_session_meta() {
    let dir = TempDir::new().unwrap();
    let path = write_rollout(
        dir.path(),
        "rollout-y.jsonl",
        &[r#"{"type":"event_msg","payload":{"type":"task_started"}}"#],
    );
    assert!(read_codex_rollout_state(&path).unwrap().is_none());
}

#[test]
fn exact_lookup_rejects_subagent_rollouts() {
    let home = TempDir::new().unwrap();
    let day = home
        .path()
        .join("sessions")
        .join("2026")
        .join("08")
        .join("16");
    fs::create_dir_all(&day).unwrap();
    let native_id = "01a00-subagent";
    let path = write_rollout(
        &day,
        &format!("rollout-2026-08-16T17-00-00-{native_id}.jsonl"),
        &[
            r#"{"type":"session_meta","payload":{"id":"01a00-subagent","cwd":"/Users/dev/proj","source":{"subagent":{"thread_spawn":{"parent_thread_id":"01a00-parent","depth":1}}}}}"#,
        ],
    );

    let meta = read_codex_rollout_meta(&path).expect("session meta");
    assert!(!meta.is_root_cli_session);
    assert!(
        find_codex_rollout_by_native_id(home.path(), native_id).is_none(),
        "exact-id path enrichment must also require a root CLI rollout"
    );
}

#[test]
fn current_cli_source_is_an_eligible_root_rollout() {
    let home = TempDir::new().unwrap();
    let day = home.path().join("sessions/2026/08/16");
    fs::create_dir_all(&day).unwrap();
    let native_id = "01a00-root";
    let path = write_rollout(
        &day,
        &format!("rollout-2026-08-16T17-00-00-{native_id}.jsonl"),
        &[
            r#"{"type":"session_meta","payload":{"id":"01a00-root","cwd":"/Users/dev/proj","originator":"codex-tui","source":"cli"}}"#,
        ],
    );

    let meta = read_codex_rollout_meta(&path).expect("session meta");
    assert!(meta.is_root_cli_session);
    assert_eq!(
        find_codex_rollout_by_native_id(home.path(), native_id).as_deref(),
        Some(path.as_path())
    );
}

#[test]
fn finds_rollout_by_native_id_across_sibling_sessions_in_one_cwd() {
    let home = TempDir::new().unwrap();
    let day = home
        .path()
        .join("sessions")
        .join("2026")
        .join("06")
        .join("16");
    fs::create_dir_all(&day).unwrap();

    // Two sessions in the SAME cwd: the cwd scan cannot tell them apart, but an
    // id lookup must return the file whose `session_meta` carries that id.
    write_rollout(
        &day,
        "rollout-2026-06-16T10-00-00-019ec4f2-aaaa.jsonl",
        &[r#"{"type":"session_meta","payload":{"id":"019ec4f2-aaaa","cwd":"/Users/dev/proj"}}"#],
    );
    write_rollout(
        &day,
        "rollout-2026-06-16T11-00-00-019ed136-bbbb.jsonl",
        &[r#"{"type":"session_meta","payload":{"id":"019ed136-bbbb","cwd":"/Users/dev/proj"}}"#],
    );

    let found = find_codex_rollout_by_native_id(home.path(), "019ec4f2-aaaa")
        .expect("rollout for the requested id");
    assert!(
        found
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap()
            .ends_with("019ec4f2-aaaa.jsonl")
    );

    assert!(find_codex_rollout_by_native_id(home.path(), "missing-id").is_none());
}

#[test]
fn request_user_input_waits_for_an_answer_and_turn_times_are_stable() {
    let mut fold = CodexRolloutFold::new();
    for line in [
        r#"{"timestamp":"2026-10-10T12:00:00.000Z","type":"session_meta","payload":{"id":"s","cwd":"/tmp"}}"#,
        r#"{"timestamp":"2026-10-10T12:00:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t"}}"#,
        r#"{"timestamp":"2026-10-10T12:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"request_user_input","call_id":"q","arguments":"{}"}}"#,
    ] {
        fold.process_line(line);
    }
    let question = fold.current_state().unwrap();
    assert_eq!(question.status, ActivityStatus::AwaitingResponse);
    assert_eq!(
        question.turn.as_ref().unwrap().started_at,
        "2026-10-10T12:00:01.000Z"
    );
    fold.process_line(r#"{"timestamp":"2026-10-10T12:00:03.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"q","output":"answer"}}"#);
    assert_eq!(
        fold.current_state().unwrap().status,
        ActivityStatus::Working
    );
    fold.process_line(r#"{"timestamp":"2026-10-10T12:00:04.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t"}}"#);
    let complete = fold.current_state().unwrap();
    assert_eq!(complete.status, ActivityStatus::AwaitingInput);
    let turn = complete.turn.unwrap();
    assert_eq!(turn.started_at, "2026-10-10T12:00:01.000Z");
    assert_eq!(turn.ended_at.as_deref(), Some("2026-10-10T12:00:04.000Z"));
}

#[test]
fn late_tool_records_do_not_masquerade_as_goal_continuation() {
    let mut fold = CodexRolloutFold::new();
    for line in [
        r#"{"type":"session_meta","payload":{"id":"s"}}"#,
        r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"t"}}"#,
        r#"{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t"}}"#,
        r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"late","arguments":"{}"}}"#,
    ] {
        fold.process_line(line);
    }
    let state = fold.current_state().unwrap();
    assert_eq!(state.status, ActivityStatus::AwaitingInput);
    assert!(state.active_tools.is_empty());
}
