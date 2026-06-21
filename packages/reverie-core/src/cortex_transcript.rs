//! Reader for the Cortex append-only transcript (`transcript.jsonl`).
//!
//! Cortex's `history.json` is a compacted, full-rewrite snapshot (lossy), so it
//! is not a usable conversation log. `cortex-code` additionally writes an
//! append-only `transcript.jsonl` alongside it in the session directory, one
//! record per line in the shared activity-event envelope:
//!
//! ```text
//! {"version":1,"sequence":N,"sessionId":"<id>","type":"<type>","timestamp":"<ISO>","payload":{…}}
//! ```
//!
//! with record types `session_meta`, `user_message` (`payload.text`),
//! `assistant_message` (`payload.text`), `tool_call` (`payload.name`), and
//! `tool_result` (`payload.output`). Older Cortex installs predate the writer, so
//! a missing file is treated as "no window" (the re-entry header just does not
//! appear for that session), never an error.

use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde_json::Value;

use crate::reentry_context::{ReentryBudget, ReentryContext, ReentryEntry};

/// The transcript path for a Cortex session, given the native ref's
/// `metadata_path` (which points at the session's `meta.json`). The transcript
/// is its sibling `transcript.jsonl` in the same session directory.
pub fn cortex_transcript_path(metadata_path: &Path) -> Option<PathBuf> {
    Some(metadata_path.parent()?.join("transcript.jsonl"))
}

/// Read a re-entry window from a Cortex `transcript.jsonl`, distilled into the
/// CLI-agnostic [`ReentryContext`]. Returns `None` when the file is absent (an
/// older `cortex-code` without the transcript writer) or has no usable entries.
pub fn read_cortex_reentry_context(
    path: &Path,
    budget: ReentryBudget,
) -> Result<Option<ReentryContext>> {
    if !path.exists() {
        return Ok(None);
    }
    let reader = BufReader::new(
        fs::File::open(path)
            .with_context(|| format!("open Cortex transcript {}", path.display()))?,
    );
    let mut entries = Vec::new();
    for line in reader.lines() {
        let line = line?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = record.get("payload");
        let text = |field: &str| {
            payload
                .and_then(|payload| payload.get(field))
                .and_then(Value::as_str)
        };
        match record.get("type").and_then(Value::as_str).unwrap_or("") {
            "user_message" => {
                if let Some(value) = text("text") {
                    entries.push(ReentryEntry::user(value));
                }
            }
            "assistant_message" => {
                if let Some(value) = text("text") {
                    entries.push(ReentryEntry::assistant(value));
                }
            }
            "tool_call" => {
                if let Some(name) = text("name") {
                    entries.push(ReentryEntry::tool(format!("Use {name}")));
                }
            }
            "tool_result" => {
                if let Some(value) = text("output") {
                    entries.push(ReentryEntry::tool(value));
                }
            }
            _ => {}
        }
    }

    let context = ReentryContext::from_entries(entries, budget);
    if context.is_empty() {
        Ok(None)
    } else {
        Ok(Some(context))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reentry_context::ReentryRole;
    use std::io::Write;

    #[test]
    fn transcript_path_is_a_sibling_of_meta() {
        let meta = PathBuf::from("/home/u/.cortex/sessions/abc/meta.json");
        assert_eq!(
            cortex_transcript_path(&meta).unwrap(),
            PathBuf::from("/home/u/.cortex/sessions/abc/transcript.jsonl")
        );
    }

    #[test]
    fn missing_transcript_reads_as_none() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("transcript.jsonl");
        assert!(read_cortex_reentry_context(&path, ReentryBudget::default())
            .unwrap()
            .is_none());
    }

    #[test]
    fn distills_users_assistants_and_tools_in_order() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("transcript.jsonl");
        let mut f = fs::File::create(&path).unwrap();
        writeln!(
            f,
            r#"{{"version":1,"sequence":1,"sessionId":"abc","type":"session_meta","timestamp":"t","payload":{{"id":"abc","cwd":"/repo","cliVersion":"1.0.0"}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"version":1,"sequence":2,"sessionId":"abc","type":"user_message","timestamp":"t","payload":{{"text":"Add the header"}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"version":1,"sequence":3,"sessionId":"abc","type":"tool_call","timestamp":"t","payload":{{"toolCallId":"c1","name":"shell","args":"ls"}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"version":1,"sequence":4,"sessionId":"abc","type":"tool_result","timestamp":"t","payload":{{"toolCallId":"c1","isError":false,"output":"done"}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"version":1,"sequence":5,"sessionId":"abc","type":"assistant_message","timestamp":"t","payload":{{"text":"Header added"}}}}"#
        )
        .unwrap();
        drop(f);

        let context = read_cortex_reentry_context(&path, ReentryBudget::default())
            .unwrap()
            .expect("reentry context");
        assert_eq!(context.entries.len(), 4);
        assert_eq!(context.entries[0].role, ReentryRole::User);
        assert_eq!(context.entries[0].text, "Add the header");
        assert_eq!(context.entries[1].role, ReentryRole::Tool);
        assert_eq!(context.entries[1].text, "Use shell");
        assert_eq!(context.entries[2].role, ReentryRole::Tool);
        assert_eq!(context.entries[2].text, "done");
        assert_eq!(context.entries[3].role, ReentryRole::Assistant);
        assert_eq!(context.entries[3].text, "Header added");
    }
}
