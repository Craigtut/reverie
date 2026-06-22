//! Generation of the re-entry ("where we left off") summary.
//!
//! When a session comes to rest (a turn finishes, it pauses for input, or it
//! hits a recoverable error) *while the user is away*, this generates a small
//! catch-up summary from the session's own transcript, using the session's own
//! CLI completion engine, and persists it. The frontend shows it as a closable
//! header when the user returns. It is generated once per rest, never per turn
//! and never while the agent is active; everything keys off the session's
//! `state_timeline.resting_since`.
//!
//! Modeled on [`crate::codex_titles`]: the trigger fires from the activity
//! correlator on every CLI, the work runs on a spawned thread (the completion
//! call blocks), and failures are best-effort with dev-only diagnostics.

use std::{
    collections::HashSet,
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Result, anyhow};
use reverie_core::{
    CompletionRequest, ReentryBudget, WorkspaceService,
    activity::ActivityStatus,
    agents::{find_claude_transcript_by_native_id, read_claude_reentry_context},
    codex_rollout::read_codex_reentry_context,
    complete_structured,
    cortex_transcript::{cortex_transcript_path, read_cortex_reentry_context},
    domain::{AgentKind, ReentrySummary, ReentrySummaryFields, Session, SessionId, SessionStatus},
    reentry_context::ReentryContext,
};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

const SESSION_RECORD_CHANGED_EVENT: &str = "session_record_changed";
const REENTRY_DIAGNOSTICS_FILE: &str = "reentry-summary-diagnostics.jsonl";
const SCHEMA_VERSION: u32 = 1;
/// Let the transcript flush its final record and give the frontend a beat to
/// stamp `last_viewed_at` if the user is actually watching, so the run-time
/// unseen check lets a view during this window win.
const SETTLE_DELAY: Duration = Duration::from_millis(2500);
const COMPLETION_TIMEOUT: Duration = Duration::from_secs(60);
/// Cap on concurrent completion subprocesses across all sessions, so a burst of
/// sessions coming to rest at once cannot spawn an unbounded fleet of CLIs.
const MAX_CONCURRENT: usize = 6;

static SCHEDULE_IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static ATTEMPTED_REST: OnceLock<Mutex<HashSet<(SessionId, String)>>> = OnceLock::new();
static ACTIVE_COMPLETIONS: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Debug)]
struct ReentryTarget {
    session_id: SessionId,
    agent_kind: AgentKind,
    cwd: PathBuf,
    native_id: String,
    /// The native ref's `metadata_path`: the rollout for Codex, `meta.json` for
    /// Cortex, usually absent for Claude (the reader derives the path by id).
    metadata_path: Option<PathBuf>,
    resting_since: String,
}

/// Trigger point, called from the activity correlator for every CLI on each
/// state update. Schedules a delayed generation when the session has come to
/// rest; the actual eligibility (unseen, still at rest, not already generated)
/// is re-checked at run time after the settle delay.
pub(crate) fn maybe_schedule_reentry_summary(
    app: &AppHandle,
    native_session_id: &str,
    state: &reverie_core::activity::ActivityState,
) {
    // Gate on the rest status alone. Do NOT require `state.turn` to be present:
    // that field is Codex-rollout-specific (the Codex title scheduler can rely on
    // it), but Claude's hook states and Cortex's snapshot states always carry
    // `turn: None`, so requiring it silently disabled the feature for every
    // non-Codex CLI. The "is this a real finish vs a bare SessionStart" concern
    // is handled downstream: SessionStart maps to `working` (not resting) for
    // Claude, and the run-time checks (unseen, dedup by restingSince, empty
    // transcript window) drop any session that has not actually done work.
    if !is_resting(state) {
        return;
    }
    // One in-flight schedule per native id at a time, so repeated rest updates
    // for the same session do not pile up threads. A later rest (a new turn that
    // finishes) reschedules once this clears; same-rest dedup happens at run time.
    if !mark_schedule_in_flight(native_session_id) {
        return;
    }
    record_diagnostic(
        app,
        "scheduled",
        None,
        json!({
            "nativeSessionId": native_session_id,
            "status": format!("{:?}", state.status),
        }),
    );
    let app = app.clone();
    let native_session_id = native_session_id.to_owned();
    thread::spawn(move || {
        thread::sleep(SETTLE_DELAY);
        if let Err(error) = try_generate(&app, &native_session_id) {
            record_diagnostic(
                &app,
                "failed",
                None,
                json!({ "nativeSessionId": native_session_id, "error": format!("{error:#}") }),
            );
            eprintln!("[reverie] re-entry summary generation failed: {error:#}");
        }
        clear_schedule_in_flight(&native_session_id);
    });
}

fn try_generate(app: &AppHandle, native_session_id: &str) -> Result<()> {
    let Some(target) = find_target(app, native_session_id) else {
        record_diagnostic(
            app,
            "skipped_no_target",
            None,
            json!({ "nativeSessionId": native_session_id }),
        );
        return Ok(());
    };

    // Still at rest? A new turn may have started during the settle delay.
    if !target_still_at_rest(app, &target) {
        record_diagnostic(app, "skipped_not_resting", Some(&target), json!({}));
        return Ok(());
    }
    // Finished while away? If the user viewed it (during the delay or before),
    // there is nothing to catch up on.
    if target_was_seen(app, &target) {
        let last_viewed = current_session(app, target.session_id).and_then(|s| s.last_viewed_at);
        record_diagnostic(
            app,
            "skipped_already_seen",
            Some(&target),
            json!({ "lastViewedAt": last_viewed }),
        );
        return Ok(());
    }
    // Already have a summary for this rest? Skip; this is the cross-restart dedup.
    if target_already_summarized(app, &target) {
        record_diagnostic(app, "skipped_already_summarized", Some(&target), json!({}));
        return Ok(());
    }
    // In-memory same-run dedup keyed on the exact rest.
    if !mark_rest_attempt(target.session_id, &target.resting_since) {
        record_diagnostic(app, "skipped_rest_attempted", Some(&target), json!({}));
        return Ok(());
    }

    let Some(_permit) = ConcurrencyPermit::try_acquire() else {
        record_diagnostic(app, "skipped_concurrency_cap", Some(&target), json!({}));
        return Ok(());
    };

    let Some(context) = read_window(&target)? else {
        record_diagnostic(app, "skipped_no_window", Some(&target), json!({}));
        return Ok(());
    };

    record_diagnostic(app, "completion_started", Some(&target), json!({}));
    let request = CompletionRequest::structured(
        target.agent_kind,
        target.cwd.clone(),
        build_prompt(&context),
        reentry_schema(),
    )
    .with_timeout(COMPLETION_TIMEOUT);
    let value = complete_structured(&request)?;
    let Some(fields) = parse_fields(value) else {
        record_diagnostic(app, "skipped_unusable_fields", Some(&target), json!({}));
        return Ok(());
    };

    let service = app
        .try_state::<WorkspaceService>()
        .ok_or_else(|| anyhow!("workspace service is unavailable"))?;
    let summary = ReentrySummary {
        fields,
        generated_for_resting_since: target.resting_since.clone(),
        cli: target.agent_kind,
        dismissed: false,
        schema_version: SCHEMA_VERSION,
    };
    service.set_session_reentry_summary(target.session_id, summary)?;
    record_diagnostic(app, "summary_updated", Some(&target), json!({}));
    if let Err(error) = app.emit(SESSION_RECORD_CHANGED_EVENT, ()) {
        eprintln!("[reverie] failed to emit session record change: {error}");
    }
    Ok(())
}

/// A session is "at rest" when a turn has finished, it is awaiting input, or it
/// hit a recoverable error (which the dashboards classify as rest). A hard error
/// is attention, not rest, so it does not get a catch-up header.
fn is_resting(state: &reverie_core::activity::ActivityState) -> bool {
    match state.status {
        ActivityStatus::AwaitingInput | ActivityStatus::Done => true,
        ActivityStatus::Error => state
            .last_error
            .as_ref()
            .map(|error| error.recoverable)
            .unwrap_or(false),
        _ => false,
    }
}

fn find_target(app: &AppHandle, native_session_id: &str) -> Option<ReentryTarget> {
    let service = app.try_state::<WorkspaceService>()?;
    let snapshot = service.snapshot().ok()?;
    let session = snapshot.sessions.iter().find(|session| {
        !session.archived
            && session.status == SessionStatus::Running
            && session
                .native_session_ref
                .as_ref()
                .and_then(|native| native.session_id.as_deref())
                == Some(native_session_id)
    })?;
    let native = session.native_session_ref.as_ref()?;
    let resting_since = session.state_timeline.resting_since.clone()?;
    Some(ReentryTarget {
        session_id: session.id,
        agent_kind: session.agent_kind,
        cwd: session.cwd.clone(),
        native_id: native_session_id.to_owned(),
        metadata_path: native.metadata_path.clone(),
        resting_since,
    })
}

/// Re-read the session and confirm its latest activity is still a rest status and
/// the rest marker is unchanged from what we scheduled for (a new turn would have
/// advanced `resting_since`).
fn target_still_at_rest(app: &AppHandle, target: &ReentryTarget) -> bool {
    let Some(session) = current_session(app, target.session_id) else {
        return false;
    };
    if session.state_timeline.resting_since.as_deref() != Some(target.resting_since.as_str()) {
        return false;
    }
    session
        .latest_activity
        .as_ref()
        .map(is_resting)
        .unwrap_or(false)
}

fn target_was_seen(app: &AppHandle, target: &ReentryTarget) -> bool {
    current_session(app, target.session_id)
        .map(|session| !session.rested_unseen())
        .unwrap_or(true)
}

fn target_already_summarized(app: &AppHandle, target: &ReentryTarget) -> bool {
    current_session(app, target.session_id)
        .and_then(|session| session.reentry_summary)
        .map(|summary| summary.generated_for_resting_since == target.resting_since)
        .unwrap_or(false)
}

fn current_session(app: &AppHandle, session_id: SessionId) -> Option<Session> {
    let service = app.try_state::<WorkspaceService>()?;
    let snapshot = service.snapshot().ok()?;
    snapshot
        .sessions
        .into_iter()
        .find(|session| session.id == session_id)
}

fn read_window(target: &ReentryTarget) -> Result<Option<ReentryContext>> {
    let budget = ReentryBudget::default();
    match target.agent_kind {
        AgentKind::CodexCli => match target.metadata_path.as_deref() {
            Some(path) => read_codex_reentry_context(path, budget),
            None => Ok(None),
        },
        AgentKind::ClaudeCode => {
            let Some(home) = claude_home_dir() else {
                return Ok(None);
            };
            match find_claude_transcript_by_native_id(&home, &target.cwd, &target.native_id) {
                Some(path) => read_claude_reentry_context(&path, budget),
                None => Ok(None),
            }
        }
        AgentKind::CortexCode => {
            let Some(meta) = target.metadata_path.as_deref() else {
                return Ok(None);
            };
            match cortex_transcript_path(meta) {
                Some(path) => read_cortex_reentry_context(&path, budget),
                None => Ok(None),
            }
        }
    }
}

fn reentry_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "currentGoal": {
                "type": "string",
                "description": "The thread of work in one short line."
            },
            "whereWeLeftOff": {
                "type": "array",
                "items": { "type": "string" },
                "description": "The last 2-3 meaningful actions, newest last, each a short phrase."
            },
            "whatChanged": {
                "type": "string",
                "description": "What is new since the user last looked, one short line. Empty string if nothing notable."
            },
            "pendingDecision": {
                "type": "string",
                "description": "The exact thing the agent is asking the user to decide, if it is waiting. Empty string if it is not waiting on the user."
            }
        },
        "required": ["currentGoal"],
        "additionalProperties": false
    })
}

fn build_prompt(context: &ReentryContext) -> String {
    format!(
        "You are writing a short \"where we left off\" note for someone returning to an AI \
agent session they stepped away from. Summarize ONLY from the transcript below and return JSON \
matching the schema.\n\
Rules:\n\
- currentGoal: one line naming the task being worked on.\n\
- whereWeLeftOff: 2 to 3 short phrases for the most recent meaningful actions, newest last.\n\
- whatChanged: one line on what is new since the user last looked; empty string if nothing notable.\n\
- pendingDecision: the exact question if the agent is waiting on the user; empty string otherwise.\n\
- Be concise and concrete. Do not invent anything that is not in the transcript.\n\n\
Transcript:\n{}",
        context.render()
    )
}

fn parse_fields(value: Value) -> Option<ReentrySummaryFields> {
    let mut fields: ReentrySummaryFields = serde_json::from_value(value).ok()?;
    fields.current_goal = fields.current_goal.trim().to_owned();
    if fields.current_goal.is_empty() {
        return None;
    }
    fields.where_we_left_off = fields
        .where_we_left_off
        .into_iter()
        .map(|entry| entry.trim().to_owned())
        .filter(|entry| !entry.is_empty())
        .collect();
    fields.what_changed = fields.what_changed.and_then(non_empty);
    fields.pending_decision = fields.pending_decision.and_then(non_empty);
    Some(fields)
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

/// Mirror of `terminal::runtime::claude_home_dir` (private there); honors
/// `CLAUDE_CONFIG_DIR`, falling back to `~/.claude`.
fn claude_home_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude")))
}

struct ConcurrencyPermit;

impl ConcurrencyPermit {
    fn try_acquire() -> Option<Self> {
        let mut current = ACTIVE_COMPLETIONS.load(Ordering::Acquire);
        loop {
            if current >= MAX_CONCURRENT {
                return None;
            }
            match ACTIVE_COMPLETIONS.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(Self),
                Err(observed) => current = observed,
            }
        }
    }
}

impl Drop for ConcurrencyPermit {
    fn drop(&mut self) {
        ACTIVE_COMPLETIONS.fetch_sub(1, Ordering::AcqRel);
    }
}

fn mark_schedule_in_flight(native_session_id: &str) -> bool {
    SCHEDULE_IN_FLIGHT
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .expect("re-entry schedule set lock poisoned")
        .insert(native_session_id.to_owned())
}

fn clear_schedule_in_flight(native_session_id: &str) {
    SCHEDULE_IN_FLIGHT
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .expect("re-entry schedule set lock poisoned")
        .remove(native_session_id);
}

fn mark_rest_attempt(session_id: SessionId, resting_since: &str) -> bool {
    ATTEMPTED_REST
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .expect("re-entry attempt set lock poisoned")
        .insert((session_id, resting_since.to_owned()))
}

fn record_diagnostic(app: &AppHandle, event: &str, target: Option<&ReentryTarget>, details: Value) {
    if !crate::commands::is_dev_channel(app) {
        return;
    }
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join(REENTRY_DIAGNOSTICS_FILE);
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };

    let mut entry = serde_json::Map::new();
    entry.insert("atMs".to_owned(), json!(unix_time_millis()));
    entry.insert("event".to_owned(), json!(event));
    if let Some(target) = target {
        entry.insert("sessionId".to_owned(), json!(target.session_id));
        entry.insert("agentKind".to_owned(), json!(format!("{:?}", target.agent_kind)));
        entry.insert("cwd".to_owned(), json!(target.cwd.display().to_string()));
        entry.insert("restingSince".to_owned(), json!(target.resting_since));
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

#[cfg(test)]
mod tests {
    use super::*;
    use reverie_core::activity::{ActivityError, ActivityState, ActivityTurn, ErrorCategory, TurnStatus};

    fn state(status: ActivityStatus, has_turn: bool, recoverable: Option<bool>) -> ActivityState {
        ActivityState {
            version: 1,
            session_id: "native".to_owned(),
            status,
            updated_at: "t".to_owned(),
            sequence: 1,
            cwd: "/tmp".to_owned(),
            turn: has_turn.then(|| ActivityTurn {
                id: "turn".to_owned(),
                status: TurnStatus::Completed,
                started_at: "t".to_owned(),
                ended_at: Some("t".to_owned()),
            }),
            active_tools: Vec::new(),
            awaiting_permission: None,
            last_error: recoverable.map(|recoverable| ActivityError {
                category: ErrorCategory::Other,
                message: "boom".to_owned(),
                recoverable,
                occurred_at: "t".to_owned(),
            }),
            final_exit: None,
        }
    }

    #[test]
    fn rest_detection_matches_dashboard_classification() {
        assert!(is_resting(&state(ActivityStatus::Done, true, None)));
        assert!(is_resting(&state(ActivityStatus::AwaitingInput, true, None)));
        assert!(is_resting(&state(ActivityStatus::Error, true, Some(true))));
        assert!(!is_resting(&state(ActivityStatus::Error, true, Some(false))));
        assert!(!is_resting(&state(ActivityStatus::Working, true, None)));
        assert!(!is_resting(&state(ActivityStatus::AwaitingPermission, true, None)));
    }

    #[test]
    fn parse_fields_drops_empty_optionals_and_requires_goal() {
        let value = json!({
            "currentGoal": "  Fix the parser  ",
            "whereWeLeftOff": ["ran tests", "   ", "edited file"],
            "whatChanged": "   ",
            "pendingDecision": "Approve the migration?"
        });
        let fields = parse_fields(value).expect("usable fields");
        assert_eq!(fields.current_goal, "Fix the parser");
        assert_eq!(fields.where_we_left_off, vec!["ran tests", "edited file"]);
        assert_eq!(fields.what_changed, None);
        assert_eq!(fields.pending_decision.as_deref(), Some("Approve the migration?"));

        assert!(parse_fields(json!({ "currentGoal": "   " })).is_none());
    }

    #[test]
    fn rest_attempt_dedupes_per_rest() {
        let session = SessionId::new_v4();
        assert!(mark_rest_attempt(session, "2026-06-19T00:00:00.000Z"));
        assert!(!mark_rest_attempt(session, "2026-06-19T00:00:00.000Z"));
        assert!(mark_rest_attempt(session, "2026-06-19T00:05:00.000Z"));
    }

    #[test]
    fn concurrency_permit_caps_active_completions() {
        let mut permits = Vec::new();
        for _ in 0..MAX_CONCURRENT {
            permits.push(ConcurrencyPermit::try_acquire().expect("under cap"));
        }
        assert!(ConcurrencyPermit::try_acquire().is_none(), "at cap");
        drop(permits);
        assert!(ConcurrencyPermit::try_acquire().is_some(), "slot freed");
    }
}
