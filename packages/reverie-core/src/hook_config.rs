//! Per-session hook config writers for Claude Code and Codex CLI.
//!
//! Each launched Claude or Codex session gets a private config directory
//! (under Reverie's cache root, never the user's `~/.claude` or `~/.codex`)
//! containing a file that points the CLI's lifecycle hooks at Reverie's
//! localhost hook HTTP server. The session launch path sets
//! `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in the spawn env so the CLI reads our
//! file in addition to (or instead of) the user's own config, depending on
//! the CLI's resolution order.
//!
//! This module only writes the files; minting tokens, registering them with
//! the hook server, and wiring env vars onto the spawn live in the Tauri
//! shell so this module stays trivially unit-testable against a tempdir.

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
    "PostToolUse",
    "Stop",
    "StopFailure",
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
];

const CODEX_HOOK_EVENTS: &[&str] = &[
    "PermissionRequest",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SessionStart",
    "UserPromptSubmit",
];

/// Outcome of a successful config write. The launch path uses the returned
/// path to set the appropriate env var on the spawn (`CLAUDE_CONFIG_DIR` or
/// `CODEX_HOME`).
#[derive(Clone, Debug)]
pub struct WrittenHookConfig {
    pub config_dir: PathBuf,
    pub config_file: PathBuf,
    pub env_var: &'static str,
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

/// Write the Claude Code config for one session into `config_dir`. The
/// directory is created (with restrictive permissions on Unix) if it doesn't
/// exist. The resulting `settings.json` is what Claude Code will read when
/// `CLAUDE_CONFIG_DIR` is set to `config_dir`.
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
        env_var: "CLAUDE_CONFIG_DIR",
    })
}

/// Write the Codex CLI config for one session into `config_dir`. Codex reads
/// `config.toml` under `CODEX_HOME`; we don't need to mirror the rest of the
/// user's Codex config because the CLI will fall back to defaults for keys we
/// don't set.
pub fn write_codex_config(config_dir: &Path, hook_url: &str) -> Result<WrittenHookConfig> {
    ensure_private_dir(config_dir)?;
    let toml = build_codex_config_toml(hook_url);
    let target = config_dir.join("config.toml");
    write_private_file(&target, toml.as_bytes())
        .with_context(|| format!("writing {}", target.display()))?;
    Ok(WrittenHookConfig {
        config_dir: config_dir.to_path_buf(),
        config_file: target,
        env_var: "CODEX_HOME",
    })
}

#[derive(Debug, Serialize)]
struct ClaudeSettings<'a> {
    hooks: ClaudeHookMap<'a>,
}

#[derive(Debug, Serialize)]
struct ClaudeHookMap<'a> {
    #[serde(flatten)]
    events: std::collections::BTreeMap<&'static str, Vec<ClaudeHookEntry<'a>>>,
}

#[derive(Debug, Serialize)]
struct ClaudeHookEntry<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    url: &'a str,
}

fn build_claude_settings<'a>(hook_url: &'a str) -> ClaudeSettings<'a> {
    let mut events = std::collections::BTreeMap::new();
    for event in CLAUDE_HOOK_EVENTS {
        events.insert(
            *event,
            vec![ClaudeHookEntry {
                kind: "http",
                url: hook_url,
            }],
        );
    }
    ClaudeSettings {
        hooks: ClaudeHookMap { events },
    }
}

fn build_codex_config_toml(hook_url: &str) -> String {
    // Codex's hook syntax (per its config-advanced docs at this writing) uses
    // a `[[hooks.<event>]]` array-of-tables with `type` + `url`. The exact
    // schema is version-sensitive; this is the conservative shape known to
    // work for the codex-cli 0.133.x line we ship against. Add/move events
    // here together with new translator arms in hook_server.rs.
    let mut out = String::new();
    out.push_str("# Reverie-managed Codex hook config (per-session).\n");
    out.push_str("# Do not edit by hand; this file is rewritten on every launch.\n\n");
    for event in CODEX_HOOK_EVENTS {
        out.push_str(&format!("[[hooks.{event}]]\n"));
        out.push_str("type = \"http\"\n");
        out.push_str(&format!("url  = \"{hook_url}\"\n\n"));
    }
    out
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
    fn write_claude_settings_produces_http_hooks_for_every_listed_event() {
        let dir = TempDir::new().unwrap();
        let url = "http://127.0.0.1:9000/hooks/claude/tok-1";
        let written = write_claude_settings(dir.path(), url).expect("writes");
        assert_eq!(written.env_var, "CLAUDE_CONFIG_DIR");
        assert_eq!(written.config_file, dir.path().join("settings.json"));

        let body = fs::read_to_string(&written.config_file).expect("read settings.json");
        let parsed: serde_json::Value = serde_json::from_str(&body).expect("valid json");
        let hooks = parsed
            .get("hooks")
            .and_then(|h| h.as_object())
            .expect("hooks object");
        for event in CLAUDE_HOOK_EVENTS {
            let entries = hooks
                .get(*event)
                .and_then(|v| v.as_array())
                .unwrap_or_else(|| panic!("missing hook entry for {event}"));
            assert_eq!(entries.len(), 1, "{event} should have one HTTP hook");
            let entry = &entries[0];
            assert_eq!(entry["type"], "http");
            assert_eq!(entry["url"], url);
        }
    }

    #[test]
    fn write_codex_config_emits_one_http_entry_per_event() {
        let dir = TempDir::new().unwrap();
        let url = "http://127.0.0.1:9000/hooks/codex/tok-2";
        let written = write_codex_config(dir.path(), url).expect("writes");
        assert_eq!(written.env_var, "CODEX_HOME");
        assert_eq!(written.config_file, dir.path().join("config.toml"));

        let body = fs::read_to_string(&written.config_file).expect("read config.toml");
        for event in CODEX_HOOK_EVENTS {
            let needle = format!("[[hooks.{event}]]");
            assert!(
                body.contains(&needle),
                "config.toml missing section for {event}: {body}"
            );
        }
        let url_occurrences = body.matches(url).count();
        assert_eq!(
            url_occurrences,
            CODEX_HOOK_EVENTS.len(),
            "every event should reference the hook URL: {body}"
        );
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
