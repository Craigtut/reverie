//! The normalized "recent window" of a session's transcript that the re-entry
//! header summarizes.
//!
//! Each CLI writes its conversation to disk in a different shape (Codex rollout
//! JSONL, Claude projects JSONL, Cortex transcript JSONL). The per-CLI readers
//! distill those into this one bounded, plain shape so the completion prompt is
//! identical no matter which agent produced the session. The header only needs
//! the last few turns to reconstruct "where we left off", so the window is kept
//! small and cheap on purpose.

use std::fmt::Write;

/// How much of the recent tail a re-entry window keeps. Small by design: the
/// summary reads the recent turns plus the pending question, not the whole
/// history (see `docs/product/core-experience/completions-and-reentry.md`).
#[derive(Clone, Copy, Debug)]
pub struct ReentryBudget {
    /// Most recent entries to keep.
    pub max_entries: usize,
    /// Hard cap on the rendered window across all entries.
    pub max_total_chars: usize,
    /// Per-entry cap; longer entries are truncated with an ellipsis.
    pub max_entry_chars: usize,
}

impl Default for ReentryBudget {
    fn default() -> Self {
        Self {
            max_entries: 24,
            max_total_chars: 6000,
            max_entry_chars: 800,
        }
    }
}

/// Who produced a given entry in the window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReentryRole {
    User,
    Assistant,
    Tool,
}

impl ReentryRole {
    fn label(self) -> &'static str {
        match self {
            ReentryRole::User => "User",
            ReentryRole::Assistant => "Assistant",
            ReentryRole::Tool => "Tool",
        }
    }
}

/// One line of the window: a role and its (already plain-text) content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReentryEntry {
    pub role: ReentryRole,
    pub text: String,
}

impl ReentryEntry {
    pub fn user(text: impl Into<String>) -> Self {
        Self {
            role: ReentryRole::User,
            text: text.into(),
        }
    }

    pub fn assistant(text: impl Into<String>) -> Self {
        Self {
            role: ReentryRole::Assistant,
            text: text.into(),
        }
    }

    pub fn tool(text: impl Into<String>) -> Self {
        Self {
            role: ReentryRole::Tool,
            text: text.into(),
        }
    }
}

/// A bounded, CLI-agnostic transcript window ready to render into a prompt.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReentryContext {
    /// Recent entries, oldest first.
    pub entries: Vec<ReentryEntry>,
}

impl ReentryContext {
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Build a window from raw entries (oldest first), applying the budget:
    /// truncate each entry, keep only the most recent `max_entries`, then drop
    /// from the front until the total fits `max_total_chars`.
    pub fn from_entries(mut entries: Vec<ReentryEntry>, budget: ReentryBudget) -> Self {
        entries.retain(|entry| !entry.text.trim().is_empty());
        for entry in &mut entries {
            entry.text = truncate_chars(entry.text.trim(), budget.max_entry_chars);
        }
        if entries.len() > budget.max_entries {
            let drop = entries.len() - budget.max_entries;
            entries.drain(0..drop);
        }
        while entries.len() > 1 && total_chars(&entries) > budget.max_total_chars {
            entries.remove(0);
        }
        Self { entries }
    }

    /// Render the window as a plain-text transcript for the completion prompt.
    pub fn render(&self) -> String {
        let mut out = String::new();
        for entry in &self.entries {
            let _ = writeln!(out, "{}: {}", entry.role.label(), entry.text);
        }
        out.trim_end().to_owned()
    }
}

fn total_chars(entries: &[ReentryEntry]) -> usize {
    entries.iter().map(|entry| entry.text.chars().count()).sum()
}

/// Truncate to `max` characters (not bytes), appending an ellipsis when cut, so a
/// multibyte transcript is never split mid-codepoint.
fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let kept: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{}\u{2026}", kept.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_most_recent_entries() {
        let entries = (0..10)
            .map(|i| ReentryEntry::user(format!("message {i}")))
            .collect();
        let budget = ReentryBudget {
            max_entries: 3,
            ..ReentryBudget::default()
        };
        let context = ReentryContext::from_entries(entries, budget);
        assert_eq!(context.entries.len(), 3);
        assert_eq!(context.entries[0].text, "message 7");
        assert_eq!(context.entries[2].text, "message 9");
    }

    #[test]
    fn truncates_long_entries_at_char_boundary() {
        let entries = vec![ReentryEntry::assistant("x".repeat(100))];
        let budget = ReentryBudget {
            max_entry_chars: 10,
            ..ReentryBudget::default()
        };
        let context = ReentryContext::from_entries(entries, budget);
        assert_eq!(context.entries[0].text.chars().count(), 10);
        assert!(context.entries[0].text.ends_with('\u{2026}'));
    }

    #[test]
    fn drops_from_the_front_to_fit_total_budget() {
        let entries = vec![
            ReentryEntry::user("a".repeat(50)),
            ReentryEntry::user("b".repeat(50)),
            ReentryEntry::user("c".repeat(50)),
        ];
        let budget = ReentryBudget {
            max_entries: 10,
            max_total_chars: 120,
            max_entry_chars: 800,
        };
        let context = ReentryContext::from_entries(entries, budget);
        assert_eq!(context.entries.len(), 2);
        assert_eq!(context.entries[0].text.chars().next(), Some('b'));
    }

    #[test]
    fn render_labels_each_role() {
        let context = ReentryContext {
            entries: vec![
                ReentryEntry::user("hi"),
                ReentryEntry::assistant("hello"),
                ReentryEntry::tool("Run shell: ls"),
            ],
        };
        assert_eq!(context.render(), "User: hi\nAssistant: hello\nTool: Run shell: ls");
    }
}
