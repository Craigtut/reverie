//! Per-session hook config writer for Claude Code.
//!
//! Each launched Claude session gets a private settings file (under Reverie's
//! cache root, never the user's `~/.claude`) declaring HTTP lifecycle hooks
//! that point at Reverie's localhost hook server. The launch path attaches it
//! with `claude --settings <file>`, which merges additively on top of the
//! user's own settings and leaves `~/.claude` (credentials/auth) untouched, so
//! no credential-home redirect is needed and the CLI never re-prompts to sign
//! in. We deliberately do NOT set `CLAUDE_CONFIG_DIR`: that would redirect the
//! whole config + credential tree and force a fresh login.
//!
//! Codex is intentionally different: it has no HTTP hook type (command-only)
//! and its command hooks are trust-gated, so it is instrumented entirely through
//! `-c` overrides rather than a written file. That lives in
//! [`crate::codex_hooks`]; this module is Claude-only.
//!
//! This module only writes the files; minting tokens, registering them with
//! the hook server, and attaching them onto the spawn live in the Tauri shell
//! so this module stays trivially unit-testable against a tempdir.

use std::{
    fs::{self, OpenOptions},
    io::Write as _,
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use anyhow::{Context, Result};
use serde::Serialize;

use crate::hook_server::HookSource;

/// Hook events we ask each CLI to forward. The translators in
/// [`crate::hook_server`] understand all of these; adding new events here
/// should go together with a new arm in `translate_claude` / `translate_codex`.
const CLAUDE_HOOK_EVENTS: &[&str] = &[
    "PermissionRequest",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "StopFailure",
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    // Fires when Claude blocks on the user: a permission dialog, an MCP
    // elicitation, or the idle prompt. It is the only hook that signals "the
    // turn is live but the agent is waiting for you" for asks that do NOT cross
    // a tool boundary, so without it a session that pops a question reads as
    // still-working (green) until something else moves it. No matcher: the
    // matcher key is the notification type, not a tool name, and a tool-style
    // `"*"` matcher would suppress it.
    "Notification",
];

/// Claude hook events that key off a tool name and therefore take a `matcher`.
/// Every other event uses the bare `{ hooks: [...] }` group with no matcher.
/// `SessionStart` deliberately stays out of this list: giving it a matcher
/// like `"startup"` would suppress the hook on `resume`, and Reverie resumes
/// sessions constantly, so it must fire for every start source.
const CLAUDE_TOOL_MATCHED_EVENTS: &[&str] = &["PermissionRequest", "PreToolUse", "PostToolUse"];

/// Outcome of a successful config write. The launch path attaches
/// `config_file` to the spawn (Claude: `--settings <config_file>`). We do not
/// return an env var to set: redirecting the credential home is exactly what
/// this design avoids.
#[derive(Clone, Debug)]
pub struct WrittenHookConfig {
    pub config_dir: PathBuf,
    pub config_file: PathBuf,
}

/// Compose the URL that hook payloads should be POSTed to. Always
/// `http://127.0.0.1:<port>/hooks/<cli>/<token>` so the server can route by
/// source and authorize by token in a single pass.
pub fn hook_url(source: HookSource, port: u16, token: &str) -> String {
    let cli = match source {
        HookSource::ClaudeCode => "claude",
        HookSource::CodexCli => "codex",
    };
    format!("http://127.0.0.1:{port}/hooks/{cli}/{token}")
}

/// Write the Claude Code settings file for one session into `config_dir`. The
/// directory is created (with restrictive permissions on Unix) if it doesn't
/// exist. The resulting `settings.json` is attached at launch with
/// `claude --settings <config_file>`; Claude merges it on top of the user's
/// own settings, so this only adds Reverie's hooks and never replaces or
/// relocates the user's config or credentials.
pub fn write_claude_settings(config_dir: &Path, hook_url: &str) -> Result<WrittenHookConfig> {
    ensure_private_dir(config_dir)?;
    let settings = build_claude_settings(hook_url);
    let json =
        serde_json::to_string_pretty(&settings).context("serializing Claude Code settings.json")?;
    let target = config_dir.join("settings.json");
    write_private_file(&target, json.as_bytes())
        .with_context(|| format!("writing {}", target.display()))?;
    Ok(WrittenHookConfig {
        config_dir: config_dir.to_path_buf(),
        config_file: target,
    })
}

#[derive(Debug, Serialize)]
struct ClaudeSettings<'a> {
    hooks: std::collections::BTreeMap<&'static str, Vec<ClaudeMatcherGroup<'a>>>,
}

/// One entry under an event in Claude's `hooks` map. Claude requires this
/// `{ matcher?, hooks: [...] }` grouping; a flat list of hook entries is
/// silently ignored. `matcher` is present only for tool-keyed events.
#[derive(Debug, Serialize)]
struct ClaudeMatcherGroup<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    matcher: Option<&'static str>,
    hooks: Vec<ClaudeHookEntry<'a>>,
}

#[derive(Debug, Serialize)]
struct ClaudeHookEntry<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    url: &'a str,
}

fn build_claude_settings(hook_url: &str) -> ClaudeSettings<'_> {
    let mut hooks = std::collections::BTreeMap::new();
    for event in CLAUDE_HOOK_EVENTS {
        let matcher = if CLAUDE_TOOL_MATCHED_EVENTS.contains(event) {
            Some("*")
        } else {
            None
        };
        hooks.insert(
            *event,
            vec![ClaudeMatcherGroup {
                matcher,
                hooks: vec![ClaudeHookEntry {
                    kind: "http",
                    url: hook_url,
                }],
            }],
        );
    }
    ClaudeSettings { hooks }
}

fn ensure_private_dir(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = fs::metadata(dir).with_context(|| format!("stat {}", dir.display()))?;
        let mut perms = metadata.permissions();
        perms.set_mode(0o700);
        fs::set_permissions(dir, perms).with_context(|| format!("chmod 0700 {}", dir.display()))?;
    }
    Ok(())
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn hook_url_formats_claude_and_codex_paths() {
        assert_eq!(
            hook_url(HookSource::ClaudeCode, 42_111, "tok-abc"),
            "http://127.0.0.1:42111/hooks/claude/tok-abc"
        );
        assert_eq!(
            hook_url(HookSource::CodexCli, 42_111, "tok-abc"),
            "http://127.0.0.1:42111/hooks/codex/tok-abc"
        );
    }

    #[test]
    fn write_claude_settings_produces_matcher_wrapped_http_hooks_for_every_event() {
        let dir = TempDir::new().unwrap();
        let url = "http://127.0.0.1:9000/hooks/claude/tok-1";
        let written = write_claude_settings(dir.path(), url).expect("writes");
        assert_eq!(written.config_file, dir.path().join("settings.json"));

        let body = fs::read_to_string(&written.config_file).expect("read settings.json");
        let parsed: serde_json::Value = serde_json::from_str(&body).expect("valid json");
        let hooks = parsed
            .get("hooks")
            .and_then(|h| h.as_object())
            .expect("hooks object");
        for event in CLAUDE_HOOK_EVENTS {
            let groups = hooks
                .get(*event)
                .and_then(|v| v.as_array())
                .unwrap_or_else(|| panic!("missing hook group for {event}"));
            assert_eq!(groups.len(), 1, "{event} should have one matcher group");
            let group = &groups[0];

            // The HTTP hook lives in the nested `hooks` array, NOT flat on the
            // group: Claude ignores a flat hook entry.
            let entries = group
                .get("hooks")
                .and_then(|v| v.as_array())
                .unwrap_or_else(|| panic!("{event} group missing nested hooks array"));
            assert_eq!(entries.len(), 1, "{event} should declare one HTTP hook");
            assert_eq!(entries[0]["type"], "http");
            assert_eq!(entries[0]["url"], url);

            // Tool-keyed events carry a matcher; lifecycle events must not, and
            // SessionStart in particular must stay matcher-free so it fires on
            // resume as well as startup.
            if CLAUDE_TOOL_MATCHED_EVENTS.contains(event) {
                assert_eq!(group["matcher"], "*", "{event} should match all tools");
            } else {
                assert!(
                    group.get("matcher").is_none(),
                    "{event} must not carry a matcher (would suppress resume/lifecycle)"
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn config_files_get_owner_only_permissions_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let written = write_claude_settings(dir.path(), "http://localhost/h").expect("writes");

        let dir_mode = fs::metadata(&written.config_dir)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let file_mode = fs::metadata(&written.config_file)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700, "config dir should be private");
        assert_eq!(
            file_mode, 0o600,
            "config file should be owner read/write only"
        );
    }
}
