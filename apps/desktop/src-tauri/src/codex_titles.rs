use std::{
    collections::{HashMap, HashSet},
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Result, anyhow};
use reverie_core::{
    CompletionRequest, WorkspaceService,
    activity::{ActivityState, ActivityStatus},
    codex_rollout::{read_codex_rollout_state, read_codex_title_context},
    complete_structured, string_object_schema,
};
use reverie_core::{
    domain::SessionId,
    domain::{AgentKind, SessionStatus},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

const TITLE_CHANGED_EVENT: &str = "terminal_title_changed";
const SESSION_RECORD_CHANGED_EVENT: &str = "session_record_changed";
const TITLE_DIAGNOSTICS_FILE: &str = "codex-title-diagnostics.jsonl";
const TITLE_FIELD: &str = "title";
const TITLE_SOURCE: &str = "codex_completion";
const MAX_TITLE_CHARS: usize = 64;
const MAX_TITLE_CONTEXT_MESSAGES: usize = 4;
const MAX_TITLE_CONTEXT_CHARS: usize = 6_000;
const GENERATED_REFRESH_MESSAGE_DELTA: u64 = 5;
const EARLY_TITLE_POLL_DELAYS: &[Duration] = &[
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];
const CAPTURE_POLL_DELAYS: &[Duration] = &[
    Duration::from_secs(1),
    Duration::from_secs(3),
    Duration::from_secs(8),
    Duration::from_secs(20),
];

static IN_FLIGHT: OnceLock<Mutex<HashSet<SessionId>>> = OnceLock::new();
static EARLY_POLL_IN_FLIGHT: OnceLock<Mutex<HashSet<SessionId>>> = OnceLock::new();
static CAPTURE_POLL_IN_FLIGHT: OnceLock<Mutex<HashSet<SessionId>>> = OnceLock::new();
static ATTEMPTED_MESSAGE_COUNTS: OnceLock<Mutex<HashMap<SessionId, u64>>> = OnceLock::new();

#[derive(Clone, Debug)]
struct CodexTitleTarget {
    session_id: SessionId,
    cwd: PathBuf,
    rollout_path: PathBuf,
    current_title: String,
    marker: Option<GeneratedTitleMarker>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedTitleMarker {
    source: Option<String>,
    title: Option<String>,
    user_message_count: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedTitleChangedEvent {
    session_id: SessionId,
    title: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TitleScheduleTiming {
    Early,
    Immediate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TitleReadiness {
    Ready {
        user_message_count: u64,
        sequence: u64,
    },
    PendingNoContext,
    NotEligible {
        user_message_count: u64,
        sequence: u64,
        already_attempted: bool,
    },
}

pub(crate) fn maybe_schedule_codex_title(
    app: &AppHandle,
    native_session_id: &str,
    state: &ActivityState,
) {
    let Some(timing) = title_schedule_timing(state) else {
        return;
    };
    let app = app.clone();
    let native_session_id = native_session_id.to_owned();
    let Some(target) = find_target(&app, &native_session_id) else {
        return;
    };
    match timing {
        TitleScheduleTiming::Immediate => schedule_target(app, target),
        TitleScheduleTiming::Early => schedule_early_poll(app, target.session_id),
    }
}

pub(crate) fn maybe_schedule_codex_title_after_capture(app: &AppHandle, session_id: SessionId) {
    let Some(target) = find_target_by_session(app, session_id) else {
        record_title_diagnostic(
            app,
            "target_missing_after_capture",
            None,
            json!({ "sessionId": session_id }),
        );
        return;
    };
    if rollout_is_at_rest(&target) {
        schedule_target(app.clone(), target);
        return;
    }
    if !mark_capture_poll_in_flight(session_id) {
        return;
    }

    let app = app.clone();
    thread::spawn(move || {
        for delay in CAPTURE_POLL_DELAYS {
            thread::sleep(*delay);
            let Some(target) = find_target_by_session(&app, session_id) else {
                record_title_diagnostic(
                    &app,
                    "capture_poll_target_missing",
                    None,
                    json!({ "sessionId": session_id }),
                );
                break;
            };
            if rollout_is_at_rest(&target) {
                record_title_diagnostic(&app, "capture_poll_ready", Some(&target), json!({}));
                schedule_target(app.clone(), target);
                break;
            }
        }
        clear_capture_poll_in_flight(session_id);
    });
}

fn schedule_target(app: AppHandle, target: CodexTitleTarget) {
    if !mark_in_flight(target.session_id) {
        record_title_diagnostic(&app, "skipped_in_flight", Some(&target), json!({}));
        return;
    }
    record_title_diagnostic(&app, "scheduled", Some(&target), json!({}));

    thread::spawn(move || {
        let session_id = target.session_id;
        if let Err(error) = run_title_generation(&app, &target) {
            record_title_diagnostic(
                &app,
                "failed",
                Some(&target),
                json!({ "error": format!("{error:#}") }),
            );
            eprintln!("[reverie] Codex title generation failed: {error:#}");
        }
        clear_in_flight(session_id);
    });
}

fn schedule_early_poll(app: AppHandle, session_id: SessionId) {
    if !mark_early_poll_in_flight(session_id) {
        return;
    }
    record_title_diagnostic(
        &app,
        "early_poll_scheduled",
        None,
        json!({ "sessionId": session_id }),
    );

    thread::spawn(move || {
        let mut exhausted = true;
        for delay in EARLY_TITLE_POLL_DELAYS {
            thread::sleep(*delay);
            let Some(target) = find_target_by_session(&app, session_id) else {
                record_title_diagnostic(
                    &app,
                    "early_poll_target_missing",
                    None,
                    json!({ "sessionId": session_id }),
                );
                exhausted = false;
                break;
            };
            match title_readiness(&target) {
                Ok(TitleReadiness::Ready {
                    user_message_count,
                    sequence,
                }) => {
                    record_title_diagnostic(
                        &app,
                        "early_poll_ready",
                        Some(&target),
                        json!({
                            "userMessageCount": user_message_count,
                            "sequence": sequence,
                        }),
                    );
                    schedule_target(app.clone(), target);
                    exhausted = false;
                    break;
                }
                Ok(TitleReadiness::PendingNoContext) => {
                    record_title_diagnostic(&app, "early_poll_pending", Some(&target), json!({}));
                }
                Ok(TitleReadiness::NotEligible {
                    user_message_count,
                    sequence,
                    already_attempted,
                }) => {
                    record_title_diagnostic(
                        &app,
                        "early_poll_not_eligible",
                        Some(&target),
                        json!({
                            "userMessageCount": user_message_count,
                            "sequence": sequence,
                            "alreadyAttempted": already_attempted,
                        }),
                    );
                    exhausted = false;
                    break;
                }
                Err(error) => {
                    record_title_diagnostic(
                        &app,
                        "early_poll_failed",
                        Some(&target),
                        json!({ "error": format!("{error:#}") }),
                    );
                    exhausted = false;
                    break;
                }
            }
        }
        if exhausted {
            record_title_diagnostic(
                &app,
                "early_poll_exhausted",
                None,
                json!({ "sessionId": session_id }),
            );
        }
        clear_early_poll_in_flight(session_id);
    });
}

fn find_target(app: &AppHandle, native_session_id: &str) -> Option<CodexTitleTarget> {
    let service = app.try_state::<WorkspaceService>()?;
    let snapshot = service.snapshot().ok()?;
    let session = snapshot.sessions.iter().find(|session| {
        session.agent_kind == AgentKind::CodexCli
            && session.status == SessionStatus::Running
            && session
                .native_session_ref
                .as_ref()
                .and_then(|native| native.session_id.as_deref())
                == Some(native_session_id)
    })?;
    let native = session.native_session_ref.as_ref()?;
    let rollout_path = native.metadata_path.clone()?;
    Some(CodexTitleTarget {
        session_id: session.id,
        cwd: session.cwd.clone(),
        rollout_path,
        current_title: session.title.clone(),
        marker: generated_marker(&native.adapter_payload),
    })
}

fn find_target_by_session(app: &AppHandle, session_id: SessionId) -> Option<CodexTitleTarget> {
    let service = app.try_state::<WorkspaceService>()?;
    let snapshot = service.snapshot().ok()?;
    let session = snapshot.sessions.iter().find(|session| {
        session.id == session_id
            && session.agent_kind == AgentKind::CodexCli
            && session.status == SessionStatus::Running
    })?;
    let native = session.native_session_ref.as_ref()?;
    let rollout_path = native.metadata_path.clone()?;
    Some(CodexTitleTarget {
        session_id: session.id,
        cwd: session.cwd.clone(),
        rollout_path,
        current_title: session.title.clone(),
        marker: generated_marker(&native.adapter_payload),
    })
}

fn rollout_is_at_rest(target: &CodexTitleTarget) -> bool {
    read_codex_rollout_state(&target.rollout_path)
        .ok()
        .flatten()
        .is_some_and(|state| {
            matches!(
                state.status,
                ActivityStatus::AwaitingInput | ActivityStatus::Done
            )
        })
}

fn title_schedule_timing(state: &ActivityState) -> Option<TitleScheduleTiming> {
    state.turn.as_ref()?;
    match state.status {
        ActivityStatus::Working
        | ActivityStatus::AwaitingPermission
        | ActivityStatus::AwaitingResponse => Some(TitleScheduleTiming::Early),
        ActivityStatus::AwaitingInput | ActivityStatus::Done | ActivityStatus::Error => {
            Some(TitleScheduleTiming::Immediate)
        }
    }
}

fn title_readiness(target: &CodexTitleTarget) -> Result<TitleReadiness> {
    let Some(context) = read_codex_title_context(
        &target.rollout_path,
        MAX_TITLE_CONTEXT_MESSAGES,
        MAX_TITLE_CONTEXT_CHARS,
    )?
    else {
        return Ok(TitleReadiness::PendingNoContext);
    };
    if context.user_messages.is_empty() {
        return Ok(TitleReadiness::PendingNoContext);
    }
    let already_attempted = title_attempted(target.session_id, context.user_message_count);
    if already_attempted
        || !should_generate_title(
            &target.current_title,
            target.marker.as_ref(),
            context.user_message_count,
        )
    {
        return Ok(TitleReadiness::NotEligible {
            user_message_count: context.user_message_count,
            sequence: context.sequence,
            already_attempted,
        });
    }
    Ok(TitleReadiness::Ready {
        user_message_count: context.user_message_count,
        sequence: context.sequence,
    })
}

fn run_title_generation(app: &AppHandle, target: &CodexTitleTarget) -> Result<()> {
    let Some(context) = read_codex_title_context(
        &target.rollout_path,
        MAX_TITLE_CONTEXT_MESSAGES,
        MAX_TITLE_CONTEXT_CHARS,
    )?
    else {
        record_title_diagnostic(app, "skipped_no_context", Some(target), json!({}));
        return Ok(());
    };
    if context.user_messages.is_empty()
        || !should_generate_title(
            &target.current_title,
            target.marker.as_ref(),
            context.user_message_count,
        )
    {
        record_title_diagnostic(
            app,
            "skipped_not_eligible",
            Some(target),
            json!({
                "userMessageCount": context.user_message_count,
                "sequence": context.sequence,
                "hasUserMessages": !context.user_messages.is_empty(),
            }),
        );
        return Ok(());
    }
    if !mark_title_attempt(target.session_id, context.user_message_count) {
        record_title_diagnostic(
            app,
            "skipped_already_attempted",
            Some(target),
            json!({
                "userMessageCount": context.user_message_count,
                "sequence": context.sequence,
            }),
        );
        return Ok(());
    }

    record_title_diagnostic(
        app,
        "completion_started",
        Some(target),
        json!({
            "userMessageCount": context.user_message_count,
            "sequence": context.sequence,
        }),
    );
    let schema = string_object_schema(TITLE_FIELD, "A short title for this agent session.");
    let prompt = build_title_prompt(&context.user_messages);
    let request =
        CompletionRequest::structured(AgentKind::CodexCli, target.cwd.clone(), prompt, schema)
            .with_timeout(Duration::from_secs(45));
    let value = complete_structured(&request)?;
    let title = sanitize_title(value.get(TITLE_FIELD).and_then(Value::as_str))
        .ok_or_else(|| anyhow!("completion did not return a usable title"))?;

    let service = app
        .try_state::<WorkspaceService>()
        .ok_or_else(|| anyhow!("workspace service is unavailable"))?;
    let generated_payload = json!({
        "source": TITLE_SOURCE,
        "title": title.clone(),
        "userMessageCount": context.user_message_count,
        "sequence": context.sequence,
    });
    service.set_generated_session_title(
        target.session_id,
        AgentKind::CodexCli,
        title.clone(),
        generated_payload,
    )?;
    record_title_diagnostic(
        app,
        "title_updated",
        Some(target),
        json!({
            "title": title,
            "userMessageCount": context.user_message_count,
            "sequence": context.sequence,
        }),
    );
    emit_title_changed(app, target.session_id, title);
    Ok(())
}

fn record_title_diagnostic(
    app: &AppHandle,
    event: &str,
    target: Option<&CodexTitleTarget>,
    details: Value,
) {
    if !crate::commands::is_dev_channel(app) {
        return;
    }
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join(TITLE_DIAGNOSTICS_FILE);
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };

    let mut entry = serde_json::Map::new();
    entry.insert("atMs".to_owned(), json!(unix_time_millis()));
    entry.insert("event".to_owned(), json!(event));
    if let Some(target) = target {
        entry.insert("sessionId".to_owned(), json!(target.session_id));
        entry.insert("cwd".to_owned(), json!(target.cwd.display().to_string()));
        entry.insert(
            "rolloutPath".to_owned(),
            json!(target.rollout_path.display().to_string()),
        );
        entry.insert("currentTitle".to_owned(), json!(target.current_title));
        entry.insert(
            "generatedUserMessageCount".to_owned(),
            json!(
                target
                    .marker
                    .as_ref()
                    .and_then(|marker| marker.user_message_count)
            ),
        );
    }
    entry.insert("details".to_owned(), details);

    if let Ok(encoded) = serde_json::to_string(&Value::Object(entry)) {
        let _ = writeln!(file, "{encoded}");
    }
}

fn unix_time_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn should_generate_title(
    current_title: &str,
    marker: Option<&GeneratedTitleMarker>,
    user_message_count: u64,
) -> bool {
    let Some(marker) = marker else {
        return is_default_codex_title(current_title) && user_message_count > 0;
    };
    let last_count = marker.user_message_count.unwrap_or(0);
    if user_message_count <= last_count {
        return false;
    }
    if is_default_codex_title(current_title) {
        return true;
    }
    if marker
        .title
        .as_deref()
        .is_some_and(|title| same_title(title, current_title))
    {
        return user_message_count >= last_count + GENERATED_REFRESH_MESSAGE_DELTA;
    }
    false
}

fn generated_marker(payload: &Value) -> Option<GeneratedTitleMarker> {
    let marker: GeneratedTitleMarker =
        serde_json::from_value(payload.get("generatedTitle")?.clone()).ok()?;
    if marker.source.as_deref() == Some(TITLE_SOURCE) {
        Some(marker)
    } else {
        None
    }
}

fn build_title_prompt(messages: &[String]) -> String {
    let mut prompt = String::from(
        "Generate a short Reverie session title from the user messages only.\n\
Return JSON matching the schema.\n\
Rules:\n\
- Use 2 to 6 words.\n\
- Describe the task, not the assistant.\n\
- Do not inspect files or run commands.\n\
- Do not include quotes or trailing punctuation.\n\n\
User messages:\n",
    );
    for (index, message) in messages.iter().enumerate() {
        prompt.push_str(&format!("\nMessage {}:\n{}\n", index + 1, message.trim()));
    }
    prompt
}

fn sanitize_title(value: Option<&str>) -> Option<String> {
    let raw = value?;
    let mut title = raw
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|c| matches!(c, '"' | '\'' | '`'))
        .trim()
        .to_owned();
    while title
        .chars()
        .last()
        .is_some_and(|c| matches!(c, '.' | '!' | '?' | ':' | ';'))
    {
        title.pop();
        title = title.trim().to_owned();
    }
    if title.is_empty() || is_default_codex_title(&title) {
        return None;
    }
    Some(truncate_chars(&title, MAX_TITLE_CHARS))
}

fn is_default_codex_title(title: &str) -> bool {
    let trimmed = title.trim();
    trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("codex")
        || trimmed.eq_ignore_ascii_case("codex cli")
        || trimmed.eq_ignore_ascii_case("untitled")
}

fn same_title(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    if max_chars <= 3 {
        return text.chars().take(max_chars).collect();
    }
    let mut clipped: String = text.chars().take(max_chars - 3).collect();
    clipped.push_str("...");
    clipped
}

fn emit_title_changed(app: &AppHandle, session_id: SessionId, title: String) {
    if let Err(error) = app.emit(
        TITLE_CHANGED_EVENT,
        GeneratedTitleChangedEvent { session_id, title },
    ) {
        eprintln!("[reverie] failed to emit generated title: {error}");
    }
    if let Err(error) = app.emit(SESSION_RECORD_CHANGED_EVENT, ()) {
        eprintln!("[reverie] failed to emit session record change: {error}");
    }
}

fn mark_in_flight(session_id: SessionId) -> bool {
    let mut sessions = IN_FLIGHT
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .expect("title in-flight set lock poisoned");
    sessions.insert(session_id)
}

fn clear_in_flight(session_id: SessionId) {
    let mut sessions = IN_FLIGHT
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .expect("title in-flight set lock poisoned");
    sessions.remove(&session_id);
}

fn mark_early_poll_in_flight(session_id: SessionId) -> bool {
    let mut sessions = EARLY_POLL_IN_FLIGHT
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .expect("title early-poll set lock poisoned");
    sessions.insert(session_id)
}

fn clear_early_poll_in_flight(session_id: SessionId) {
    let mut sessions = EARLY_POLL_IN_FLIGHT
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .expect("title early-poll set lock poisoned");
    sessions.remove(&session_id);
}

fn mark_capture_poll_in_flight(session_id: SessionId) -> bool {
    let mut sessions = CAPTURE_POLL_IN_FLIGHT
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .expect("title capture-poll set lock poisoned");
    sessions.insert(session_id)
}

fn clear_capture_poll_in_flight(session_id: SessionId) {
    let mut sessions = CAPTURE_POLL_IN_FLIGHT
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .expect("title capture-poll set lock poisoned");
    sessions.remove(&session_id);
}

fn title_attempted(session_id: SessionId, user_message_count: u64) -> bool {
    let counts = ATTEMPTED_MESSAGE_COUNTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("title attempt set lock poisoned");
    counts
        .get(&session_id)
        .is_some_and(|last_count| user_message_count <= *last_count)
}

fn mark_title_attempt(session_id: SessionId, user_message_count: u64) -> bool {
    let mut counts = ATTEMPTED_MESSAGE_COUNTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("title attempt set lock poisoned");
    if counts
        .get(&session_id)
        .is_some_and(|last_count| user_message_count <= *last_count)
    {
        return false;
    }
    counts.insert(session_id, user_message_count);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use reverie_core::activity::{ActivityTurn, TurnStatus};

    fn state(status: ActivityStatus, has_turn: bool) -> ActivityState {
        ActivityState {
            version: 1,
            session_id: "native".to_owned(),
            status,
            updated_at: "t".to_owned(),
            sequence: 1,
            cwd: "/tmp".to_owned(),
            turn: has_turn.then(|| ActivityTurn {
                id: "turn".to_owned(),
                status: TurnStatus::Running,
                started_at: "t".to_owned(),
                ended_at: None,
            }),
            active_tools: Vec::new(),
            awaiting_permission: None,
            last_error: None,
            final_exit: None,
        }
    }

    #[test]
    fn default_titles_generate_once_user_messages_exist() {
        assert!(should_generate_title("Codex", None, 1));
        assert!(!should_generate_title("Codex", None, 0));
    }

    #[test]
    fn generated_titles_refresh_after_message_delta() {
        let marker = GeneratedTitleMarker {
            source: Some(TITLE_SOURCE.to_owned()),
            title: Some("Fix Parser".to_owned()),
            user_message_count: Some(2),
        };
        assert!(!should_generate_title("Fix Parser", Some(&marker), 6));
        assert!(should_generate_title("Fix Parser", Some(&marker), 7));
        assert!(!should_generate_title("User Renamed", Some(&marker), 8));
    }

    #[test]
    fn scheduling_ignores_session_start_and_runs_on_turn_edges() {
        assert_eq!(
            title_schedule_timing(&state(ActivityStatus::AwaitingInput, false)),
            None
        );
        assert_eq!(
            title_schedule_timing(&state(ActivityStatus::Working, true)),
            Some(TitleScheduleTiming::Early)
        );
        assert_eq!(
            title_schedule_timing(&state(ActivityStatus::AwaitingInput, true)),
            Some(TitleScheduleTiming::Immediate)
        );
    }

    #[test]
    fn title_attempts_dedupe_by_user_message_count() {
        let session_id = SessionId::new_v4();
        assert!(!title_attempted(session_id, 1));
        assert!(mark_title_attempt(session_id, 1));
        assert!(title_attempted(session_id, 1));
        assert!(!mark_title_attempt(session_id, 1));
        assert!(!mark_title_attempt(session_id, 0));
        assert!(mark_title_attempt(session_id, 2));
    }

    #[test]
    fn sanitizes_title_shape() {
        assert_eq!(
            sanitize_title(Some("\"Fix parser tests.\"")).as_deref(),
            Some("Fix parser tests")
        );
        assert!(sanitize_title(Some("Codex")).is_none());
    }
}
