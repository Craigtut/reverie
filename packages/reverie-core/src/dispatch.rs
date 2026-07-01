//! Dispatch request classification.
//!
//! Turns a spoken or typed task ("in Reverie, find our primary palette") into a
//! routing decision: General, or a specific project + topic (existing or new),
//! plus a short session title. It runs on the shared completion surface
//! ([`crate::completion`]) at the engine's *utility* model tier so the call
//! stays cheap and fast. The classifier proposes; the dispatch UI lets the user
//! correct before anything launches. See
//! `docs/product/core-experience/dispatch.md`.
//!
//! Projects and topics are presented to the model as short label refs ("P1",
//! "T2"), never their raw UUIDs, and resolved back locally. A model cannot
//! reliably echo a UUID, but it can pick a label; this keeps routing robust.

use std::{collections::HashMap, path::Path, time::Duration};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{CompletionRequest, Focus, Project, complete_structured, domain::AgentKind};

/// Default timeout for a dispatch classification. Kept short: this is a tiny
/// job and the UI resolves routing in the background, defaulting to General if
/// it does not return in time.
pub const DISPATCH_CLASSIFY_TIMEOUT: Duration = Duration::from_secs(20);

/// Where dispatched work should land.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DispatchScope {
    General,
    Project,
}

/// The resolved routing the confirm step renders and the launch step acts on.
/// `project_id`/`topic_id` are real workspace ids (resolved from the model's
/// label refs); `is_new_topic` + `new_topic_title` mean "create this topic under
/// `project_id` first".
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRouting {
    pub scope: DispatchScope,
    pub project_id: Option<String>,
    pub topic_id: Option<String>,
    pub is_new_topic: bool,
    pub new_topic_title: Option<String>,
    pub session_title: String,
    pub confidence: Option<f64>,
}

impl DispatchRouting {
    fn general(session_title: String, confidence: Option<f64>) -> Self {
        Self {
            scope: DispatchScope::General,
            project_id: None,
            topic_id: None,
            is_new_topic: false,
            new_topic_title: None,
            session_title,
            confidence,
        }
    }
}

/// The fast/cheap "utility" model for a CLI, used for tiny product jobs like
/// dispatch classification.
///
/// - Claude Code: the `haiku` alias, which Claude resolves to the latest Haiku.
/// - Cortex: `None`. `cortex complete` already defaults to its configured
///   utility model (`config.defaultUtilityModel`, else the inferred cheapest),
///   so passing no `--model` is exactly what we want.
/// - Codex: `None` for now, so it uses the user's configured model. The
///   completion path already forces `model_reasoning_effort=low`, so this stays
///   cheap. Codex exposes no "utility model" selector; pinning its mini tier is
///   a follow-up once the exact model id is confirmed against an install (the
///   primary is currently `gpt-5.5`; the mini sibling's id is unverified, and a
///   wrong id would make classification fail rather than just cost a little
///   more).
pub fn utility_model(kind: AgentKind) -> Option<String> {
    match kind {
        AgentKind::ClaudeCode => Some("haiku".to_owned()),
        AgentKind::CodexCli => None,
        AgentKind::CortexCode => None,
    }
}

/// Classify a dispatch request against the workspace's projects and topics.
///
/// `engine` is the CLI that runs the completion (the workspace default agent's
/// CLI). `cwd` is a working directory for the call (any readable dir). On any
/// failure to produce a usable, consistent result, this returns a General route
/// rather than erroring, so the caller always has something safe to act on.
pub fn classify_dispatch(
    engine: AgentKind,
    cwd: &Path,
    transcript: &str,
    projects: &[Project],
    focuses: &[Focus],
    general_label: &str,
) -> Result<DispatchRouting> {
    let transcript = transcript.trim();
    let fallback_title = fallback_session_title(transcript);
    if transcript.is_empty() {
        return Ok(DispatchRouting::general(fallback_title, None));
    }

    let catalog = build_catalog(projects, focuses);
    let prompt = build_prompt(transcript, &catalog, general_label);
    let schema = dispatch_schema();

    let request = CompletionRequest::structured(engine, cwd, prompt, schema)
        .with_timeout(DISPATCH_CLASSIFY_TIMEOUT);
    let request = match utility_model(engine) {
        Some(model) => CompletionRequest {
            model: Some(model),
            ..request
        },
        None => request,
    };

    let value = complete_structured(&request)?;
    let raw: RawDispatch = serde_json::from_value(value).unwrap_or_default();
    Ok(resolve(raw, &catalog, fallback_title))
}

// --- internals ---------------------------------------------------------------

/// The model's raw structured output, using label refs instead of ids.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDispatch {
    scope: Option<String>,
    project: Option<String>,
    topic: Option<String>,
    new_topic_title: Option<String>,
    session_title: Option<String>,
    confidence: Option<f64>,
}

struct ProjectEntry {
    label: String,
    id: String,
    name: String,
}

struct TopicEntry {
    label: String,
    id: String,
    project_id: String,
    title: String,
}

struct Catalog {
    /// Non-archived projects, in the order presented to the model.
    projects: Vec<ProjectEntry>,
    /// Existing non-archived topics under a listed project.
    topics: Vec<TopicEntry>,
}

impl Catalog {
    fn project_id(&self, label: &str) -> Option<&str> {
        let needle = label.trim();
        self.projects
            .iter()
            .find(|entry| entry.label.eq_ignore_ascii_case(needle))
            .map(|entry| entry.id.as_str())
    }

    fn topic(&self, label: &str) -> Option<(&str, &str)> {
        let needle = label.trim();
        self.topics
            .iter()
            .find(|entry| entry.label.eq_ignore_ascii_case(needle))
            .map(|entry| (entry.id.as_str(), entry.project_id.as_str()))
    }
}

fn build_catalog(projects: &[Project], focuses: &[Focus]) -> Catalog {
    let mut project_entries: Vec<ProjectEntry> = Vec::new();
    let mut project_label_by_id: HashMap<String, String> = HashMap::new();
    for project in projects.iter().filter(|project| !project.archived) {
        let label = format!("P{}", project_entries.len() + 1);
        let id = project.id.to_string();
        project_label_by_id.insert(id.clone(), label.clone());
        project_entries.push(ProjectEntry {
            label,
            id,
            name: project.name.clone(),
        });
    }

    let mut topic_entries: Vec<TopicEntry> = Vec::new();
    for focus in focuses.iter().filter(|focus| !focus.archived) {
        let Some(project_id) = focus.project_id.map(|id| id.to_string()) else {
            continue; // General/workspace-level focuses are not project topics.
        };
        if !project_label_by_id.contains_key(&project_id) {
            continue; // Topic belongs to an archived/absent project.
        }
        let label = format!("T{}", topic_entries.len() + 1);
        topic_entries.push(TopicEntry {
            label,
            id: focus.id.to_string(),
            project_id,
            title: focus.title.clone(),
        });
    }

    Catalog {
        projects: project_entries,
        topics: topic_entries,
    }
}

fn build_prompt(transcript: &str, catalog: &Catalog, general_label: &str) -> String {
    let mut catalog_text = String::new();
    if catalog.projects.is_empty() {
        catalog_text.push_str("(no projects yet — everything goes to General)\n");
    } else {
        for project in &catalog.projects {
            // Topics owned by this project, shown as `label "title"`.
            let topics: Vec<String> = catalog
                .topics
                .iter()
                .filter(|topic| topic.project_id == project.id)
                .map(|topic| format!("{} \"{}\"", topic.label, topic.title))
                .collect();
            let topic_hint = if topics.is_empty() {
                "no topics yet".to_owned()
            } else {
                topics.join(", ")
            };
            catalog_text.push_str(&format!(
                "- {}: \"{}\" (topics: {topic_hint})\n",
                project.label, project.name
            ));
        }
    }

    format!(
        "You route a user's task to where it belongs in their workspace.\n\
         \n\
         The task:\n\"{transcript}\"\n\
         \n\
         Projects and their existing topics (refer to them by these labels):\n\
         {catalog_text}\n\
         Decide:\n\
         - scope: \"project\" if the task clearly belongs to one of the projects \
         above (the user names it or it is obviously about it), else \"general\".\n\
         - project: the matching project label (e.g. \"P1\") when scope is \
         \"project\", else \"none\".\n\
         - topic: an existing topic label (e.g. \"T2\") if one fits, else \"new\".\n\
         - newTopicTitle: a short title (2-4 words) when topic is \"new\".\n\
         - sessionTitle: a short imperative title for this task (2-5 words).\n\
         - confidence: 0.0-1.0, your confidence in the project/topic routing.\n\
         \n\
         Prefer an existing topic over a new one. When unsure, choose \
         \"general\" (the {general_label} lane) rather than guessing a project.\n\
         Respond only with the structured fields."
    )
}

fn dispatch_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "scope": { "type": "string", "description": "\"general\" or \"project\"" },
            "project": { "type": "string", "description": "matching project label like \"P1\", or \"none\"" },
            "topic": { "type": "string", "description": "matching topic label like \"T2\", or \"new\"" },
            "newTopicTitle": { "type": "string", "description": "short title when topic is \"new\"" },
            "sessionTitle": { "type": "string", "description": "short imperative title for the task" },
            "confidence": { "type": "number", "description": "0.0-1.0 routing confidence" }
        },
        "required": ["scope", "sessionTitle"],
        "additionalProperties": false
    })
}

fn resolve(raw: RawDispatch, catalog: &Catalog, fallback_title: String) -> DispatchRouting {
    let session_title = raw
        .session_title
        .map(|title| sanitize_title(&title))
        .filter(|title| !title.is_empty())
        .unwrap_or(fallback_title);
    let confidence = raw.confidence;

    let is_project = raw
        .scope
        .as_deref()
        .map(|scope| scope.eq_ignore_ascii_case("project"))
        .unwrap_or(false);
    if !is_project {
        return DispatchRouting::general(session_title, confidence);
    }

    // scope == project: resolve the project label to a real id, else General.
    let Some(project_id) = raw
        .project
        .as_deref()
        .and_then(|label| catalog.project_id(label))
        .map(str::to_owned)
    else {
        return DispatchRouting::general(session_title, confidence);
    };

    // Resolve the topic: an existing topic under THIS project, else a new one.
    let topic_match = raw
        .topic
        .as_deref()
        .filter(|label| !label.eq_ignore_ascii_case("new"))
        .and_then(|label| catalog.topic(label))
        .filter(|(_, owner)| *owner == project_id)
        .map(|(topic_id, _)| topic_id.to_owned());

    match topic_match {
        Some(topic_id) => DispatchRouting {
            scope: DispatchScope::Project,
            project_id: Some(project_id),
            topic_id: Some(topic_id),
            is_new_topic: false,
            new_topic_title: None,
            session_title,
            confidence,
        },
        None => {
            let new_topic_title = raw
                .new_topic_title
                .map(|title| sanitize_title(&title))
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| session_title.clone());
            DispatchRouting {
                scope: DispatchScope::Project,
                project_id: Some(project_id),
                topic_id: None,
                is_new_topic: true,
                new_topic_title: Some(new_topic_title),
                session_title,
                confidence,
            }
        }
    }
}

/// Collapse whitespace, strip surrounding quotes, and cap length so a model
/// title is safe to use as a session/topic name.
fn sanitize_title(raw: &str) -> String {
    let cleaned: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = cleaned.trim_matches(|c| c == '"' || c == '\'').trim();
    cleaned.chars().take(80).collect()
}

/// A safe session title derived from the request when the model gives none: the
/// first few words of the transcript.
fn fallback_session_title(transcript: &str) -> String {
    let snippet: String = transcript
        .split_whitespace()
        .take(6)
        .collect::<Vec<_>>()
        .join(" ");
    let snippet = sanitize_title(&snippet);
    if snippet.is_empty() {
        "New task".to_owned()
    } else {
        snippet
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Catalog {
        Catalog {
            projects: vec![
                ProjectEntry {
                    label: "P1".to_owned(),
                    id: "proj-reverie".to_owned(),
                    name: "Reverie".to_owned(),
                },
                ProjectEntry {
                    label: "P2".to_owned(),
                    id: "proj-animus".to_owned(),
                    name: "Animus".to_owned(),
                },
            ],
            topics: vec![
                TopicEntry {
                    label: "T1".to_owned(),
                    id: "topic-branding".to_owned(),
                    project_id: "proj-reverie".to_owned(),
                    title: "branding".to_owned(),
                },
                TopicEntry {
                    label: "T2".to_owned(),
                    id: "topic-terminal".to_owned(),
                    project_id: "proj-reverie".to_owned(),
                    title: "terminal".to_owned(),
                },
            ],
        }
    }

    #[test]
    fn unknown_scope_routes_to_general() {
        let raw = RawDispatch {
            scope: Some("project".to_owned()),
            project: Some("P9".to_owned()),
            session_title: Some("do the thing".to_owned()),
            ..Default::default()
        };
        let routing = resolve(raw, &catalog(), "fallback".to_owned());
        assert_eq!(routing.scope, DispatchScope::General);
        assert!(routing.project_id.is_none());
    }

    #[test]
    fn existing_topic_resolves_to_ids() {
        let raw = RawDispatch {
            scope: Some("project".to_owned()),
            project: Some("P1".to_owned()),
            topic: Some("T1".to_owned()),
            session_title: Some("Find the palette".to_owned()),
            confidence: Some(0.9),
            ..Default::default()
        };
        let routing = resolve(raw, &catalog(), "fallback".to_owned());
        assert_eq!(routing.scope, DispatchScope::Project);
        assert_eq!(routing.project_id.as_deref(), Some("proj-reverie"));
        assert_eq!(routing.topic_id.as_deref(), Some("topic-branding"));
        assert!(!routing.is_new_topic);
    }

    #[test]
    fn new_topic_keeps_title_and_clears_topic_id() {
        let raw = RawDispatch {
            scope: Some("project".to_owned()),
            project: Some("P2".to_owned()),
            topic: Some("new".to_owned()),
            new_topic_title: Some("  launch   prep ".to_owned()),
            session_title: Some("Draft the launch email".to_owned()),
            ..Default::default()
        };
        let routing = resolve(raw, &catalog(), "fallback".to_owned());
        assert_eq!(routing.project_id.as_deref(), Some("proj-animus"));
        assert!(routing.is_new_topic);
        assert_eq!(routing.new_topic_title.as_deref(), Some("launch prep"));
        assert!(routing.topic_id.is_none());
    }

    #[test]
    fn topic_from_other_project_is_treated_as_new() {
        // The model named a project (P2) but a topic that lives under P1; the
        // mismatch must not leak a cross-project topic id.
        let raw = RawDispatch {
            scope: Some("project".to_owned()),
            project: Some("P2".to_owned()),
            topic: Some("T1".to_owned()),
            session_title: Some("Something".to_owned()),
            ..Default::default()
        };
        let routing = resolve(raw, &catalog(), "fallback".to_owned());
        assert_eq!(routing.project_id.as_deref(), Some("proj-animus"));
        assert!(routing.is_new_topic);
        assert!(routing.topic_id.is_none());
    }

    #[test]
    fn fallback_title_from_transcript() {
        assert_eq!(
            fallback_session_title("please go check the staging server logs now"),
            "please go check the staging server"
        );
        assert_eq!(fallback_session_title("   "), "New task");
    }
}
