use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};

use anyhow::{Result, anyhow};
use reverie_core::{
    CompletionRequest, WorkspaceService,
    activity::ActivityStatus,
    codex_rollout::{read_codex_rollout_state, read_codex_title_context},
    complete_structured, string_object_schema,
};
use reverie_core::{domain::AgentKind, domain::SessionId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

const TITLE_CHANGED_EVENT: &str = "terminal_title_changed";
const SESSION_RECORD_CHANGED_EVENT: &str = "session_record_changed";
const TITLE_FIELD: &str = "title";
const TITLE_SOURCE: &str = "codex_completion";
const MAX_TITLE_CHARS: usize = 64;
const MAX_TITLE_CONTEXT_MESSAGES: usize = 4;
const MAX_TITLE_CONTEXT_CHARS: usize = 6_000;
const GENERATED_REFRESH_MESSAGE_DELTA: u64 = 3;
const CAPTURE_POLL_DELAYS: &[Duration] = &[
    Duration::from_secs(1),
    Duration::from_secs(3),
    Duration::from_secs(8),
    Duration::from_secs(20),
];

static IN_FLIGHT: OnceLock<Mutex<HashSet<SessionId>>> = OnceLock::new();
static CAPTURE_POLL_IN_FLIGHT: OnceLock<Mutex<HashSet<SessionId>>> = OnceLock::new();

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

pub(crate) fn maybe_schedule_codex_title(
    app: &AppHandle,
    native_session_id: &str,
    status: ActivityStatus,
) {
    if status != ActivityStatus::AwaitingInput {
        return;
    }
    let app = app.clone();
    let native_session_id = native_session_id.to_owned();
    let Some(target) = find_target(&app, &native_session_id) else {
        return;
    };
    schedule_target(app, target);
}

pub(crate) fn maybe_schedule_codex_title_after_capture(app: &AppHandle, session_id: SessionId) {
    let Some(target) = find_target_by_session(app, session_id) else {
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
                break;
            };
            if rollout_is_at_rest(&target) {
                schedule_target(app.clone(), target);
                break;
            }
        }
        clear_capture_poll_in_flight(session_id);
    });
}

fn schedule_target(app: AppHandle, target: CodexTitleTarget) {
    if !mark_in_flight(target.session_id) {
        return;
    }

    thread::spawn(move || {
        let session_id = target.session_id;
        if let Err(error) = run_title_generation(&app, target) {
            eprintln!("[reverie] Codex title generation failed: {error:#}");
        }
        clear_in_flight(session_id);
    });
}

fn find_target(app: &AppHandle, native_session_id: &str) -> Option<CodexTitleTarget> {
    let service = app.try_state::<WorkspaceService>()?;
    let snapshot = service.snapshot().ok()?;
    let session = snapshot.sessions.iter().find(|session| {
        session.agent_kind == AgentKind::CodexCli
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
    let session = snapshot
        .sessions
        .iter()
        .find(|session| session.id == session_id && session.agent_kind == AgentKind::CodexCli)?;
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

fn run_title_generation(app: &AppHandle, target: CodexTitleTarget) -> Result<()> {
    let Some(context) = read_codex_title_context(
        &target.rollout_path,
        MAX_TITLE_CONTEXT_MESSAGES,
        MAX_TITLE_CONTEXT_CHARS,
    )?
    else {
        return Ok(());
    };
    if context.user_messages.is_empty()
        || !should_generate_title(
            &target.current_title,
            target.marker.as_ref(),
            context.user_message_count,
        )
    {
        return Ok(());
    }

    let schema = string_object_schema(TITLE_FIELD, "A short title for this agent session.");
    let prompt = build_title_prompt(&context.user_messages);
    let request = CompletionRequest::structured(AgentKind::CodexCli, target.cwd, prompt, schema)
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
    emit_title_changed(app, target.session_id, title);
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(!should_generate_title("Fix Parser", Some(&marker), 4));
        assert!(should_generate_title("Fix Parser", Some(&marker), 5));
        assert!(!should_generate_title("User Renamed", Some(&marker), 8));
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
