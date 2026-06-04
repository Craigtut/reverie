//! Pre-accepting the agent CLIs' per-folder "do you trust this folder?" prompt.
//!
//! Reverie runs every General (project-less) session in a fresh, app-provisioned
//! scratch workspace (see `commands::provision_general_workspace`). Because that
//! folder is brand-new each time, Claude Code and Codex would treat it as an
//! untrusted project and greet the user with their startup trust prompt on every
//! single General session. Since Reverie created the folder itself, the answer is
//! always "yes, trust it", so we pre-write that answer into the CLI's own config
//! before launching.
//!
//! This is NOT dangerous / auto-approve mode. It only pre-answers the folder
//! gate. Per-action permission prompts (Claude) and the sandboxed approval
//! posture (Codex `workspace-write` + `on-request`) are left fully intact, and
//! the workspace-wide dangerous-mode switch stays a separate, explicit opt-in.
//!
//! Where each CLI stores folder trust (both keyed by absolute path):
//! - Claude Code: `~/.claude.json` -> `projects["<dir>"].hasTrustDialogAccepted`.
//! - Codex:       `~/.codex/config.toml` -> `[projects."<dir>"] trust_level = "trusted"`.
//! - Cortex:      ours, no trust prompt, so nothing to do.
//!
//! All writes are best-effort and quiet: a failure only logs and the session
//! still launches (the user just sees the prompt once, as before). Writes are
//! atomic (temp file + rename) and merge into existing config so they never
//! clobber unrelated state. The CLI homes are shared across the dev and
//! production channels (see CLAUDE.md), matching how the CLIs themselves behave.

use std::env;
use std::path::{Path, PathBuf};

use reverie_core::domain::AgentKind;
use serde_json::{Value, json};
use toml_edit::{DocumentMut, Item, Table, value};

/// Pre-accept the folder-trust prompt for `dir` for the CLI that will run there.
/// Best-effort: logs on failure and never panics.
pub fn trust_workspace(agent_kind: AgentKind, dir: &Path) {
    let key = trust_key(dir);
    let result = match agent_kind {
        AgentKind::ClaudeCode => {
            claude_config_path().and_then(|path| set_claude_trust(&path, &key))
        }
        AgentKind::CodexCli => codex_config_path().and_then(|path| set_codex_trust(&path, &key)),
        // Cortex is Reverie's own agent and shows no folder-trust prompt.
        AgentKind::CortexCode => return,
    };
    if let Err(err) = result {
        eprintln!(
            "[reverie-trust] failed pre-trusting {} for {}: {err}",
            dir.display(),
            agent_kind.as_str()
        );
    }
}

/// Remove the trust entries Reverie seeded for `dir` from both CLIs' configs, so
/// deleted scratch workspaces don't leave dead project entries behind. We don't
/// track which CLI a scratch dir was for at delete time, so we clear both; a
/// missing entry is a harmless no-op.
pub fn untrust_workspace(dir: &Path) {
    untrust_workspaces(std::slice::from_ref(&dir.to_path_buf()));
}

/// Batch form of [`untrust_workspace`]: clears trust for many dirs while opening
/// each config file at most once. Used by the boot-time orphan sweep.
pub fn untrust_workspaces(dirs: &[PathBuf]) {
    if dirs.is_empty() {
        return;
    }
    let keys: Vec<String> = dirs.iter().map(|dir| trust_key(dir)).collect();
    if let Ok(path) = claude_config_path() {
        if let Err(err) = clear_claude_trust(&path, &keys) {
            eprintln!("[reverie-trust] failed clearing Claude trust entries: {err}");
        }
    }
    if let Ok(path) = codex_config_path() {
        if let Err(err) = clear_codex_trust(&path, &keys) {
            eprintln!("[reverie-trust] failed clearing Codex trust entries: {err}");
        }
    }
}

/// The absolute-path key a CLI uses to identify a folder. Canonicalized so it
/// matches the resolved cwd the spawned process reports (our scratch dirs live
/// under a non-symlinked app-data root, so this is normally a no-op, but
/// canonicalizing keeps us correct if home itself is symlinked). Falls back to
/// the path as-is if the dir can't be resolved.
fn trust_key(dir: &Path) -> String {
    std::fs::canonicalize(dir)
        .unwrap_or_else(|_| dir.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn claude_config_path() -> Result<PathBuf, String> {
    // Claude honors CLAUDE_CONFIG_DIR for the location of its config dir; the
    // global config lives at `<dir>/.claude.json`, else `~/.claude.json`.
    if let Some(dir) = env::var_os("CLAUDE_CONFIG_DIR") {
        return Ok(PathBuf::from(dir).join(".claude.json"));
    }
    home_dir().map(|home| home.join(".claude.json"))
}

fn codex_config_path() -> Result<PathBuf, String> {
    // Codex honors CODEX_HOME for its config home, else `~/.codex`.
    if let Some(dir) = env::var_os("CODEX_HOME") {
        return Ok(PathBuf::from(dir).join("config.toml"));
    }
    home_dir().map(|home| home.join(".codex").join("config.toml"))
}

fn home_dir() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set, so Reverie cannot locate the CLI config".to_owned())
}

// --- Claude Code (~/.claude.json) -----------------------------------------

fn set_claude_trust(config_path: &Path, key: &str) -> Result<(), String> {
    let mut root = read_json_object(config_path)?;
    {
        let obj = root
            .as_object_mut()
            .ok_or_else(|| ".claude.json is not a JSON object".to_string())?;
        let projects = obj.entry("projects").or_insert_with(|| json!({}));
        let projects = projects
            .as_object_mut()
            .ok_or_else(|| "`projects` in .claude.json is not an object".to_string())?;
        let entry = projects.entry(key).or_insert_with(|| json!({}));
        if !entry.is_object() {
            *entry = json!({});
        }
        entry
            .as_object_mut()
            .expect("entry coerced to object above")
            .insert("hasTrustDialogAccepted".to_string(), Value::Bool(true));
    }
    let serialized = serde_json::to_string_pretty(&root)
        .map_err(|err| format!("serializing .claude.json: {err}"))?;
    write_atomic(config_path, &serialized)
}

fn clear_claude_trust(config_path: &Path, keys: &[String]) -> Result<(), String> {
    if !config_path.exists() {
        return Ok(());
    }
    let mut root = read_json_object(config_path)?;
    let mut changed = false;
    if let Some(projects) = root
        .get_mut("projects")
        .and_then(|projects| projects.as_object_mut())
    {
        for key in keys {
            if projects.remove(key).is_some() {
                changed = true;
            }
        }
    }
    if !changed {
        return Ok(());
    }
    let serialized = serde_json::to_string_pretty(&root)
        .map_err(|err| format!("serializing .claude.json: {err}"))?;
    write_atomic(config_path, &serialized)
}

/// Read `.claude.json` as a JSON value, or an empty object if it does not exist.
/// A parse error is surfaced (rather than silently overwritten) so a corrupt or
/// concurrently-half-written file is never clobbered.
fn read_json_object(config_path: &Path) -> Result<Value, String> {
    if !config_path.exists() {
        return Ok(json!({}));
    }
    let raw = std::fs::read_to_string(config_path)
        .map_err(|err| format!("reading {}: {err}", config_path.display()))?;
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&raw).map_err(|err| format!("parsing {}: {err}", config_path.display()))
}

// --- Codex (~/.codex/config.toml) -----------------------------------------

fn set_codex_trust(config_path: &Path, key: &str) -> Result<(), String> {
    let mut doc = read_toml_doc(config_path)?;
    let root = doc.as_table_mut();
    if !root.contains_key("projects") {
        root.insert("projects", Item::Table(Table::new()));
    }
    let projects = root
        .get_mut("projects")
        .and_then(Item::as_table_mut)
        .ok_or_else(|| "`projects` in config.toml is not a table".to_string())?;
    // Render only the leaf `[projects."<dir>"]` headers, matching Codex's own
    // format, instead of an empty `[projects]` parent header.
    projects.set_implicit(true);
    if !projects.contains_key(key) {
        projects.insert(key, Item::Table(Table::new()));
    }
    let entry = projects
        .get_mut(key)
        .and_then(Item::as_table_mut)
        .ok_or_else(|| format!("`projects.{key}` in config.toml is not a table"))?;
    entry.insert("trust_level", value("trusted"));
    write_atomic(config_path, &doc.to_string())
}

fn clear_codex_trust(config_path: &Path, keys: &[String]) -> Result<(), String> {
    if !config_path.exists() {
        return Ok(());
    }
    let mut doc = read_toml_doc(config_path)?;
    let mut changed = false;
    if let Some(projects) = doc
        .as_table_mut()
        .get_mut("projects")
        .and_then(Item::as_table_mut)
    {
        for key in keys {
            if projects.remove(key).is_some() {
                changed = true;
            }
        }
    }
    if !changed {
        return Ok(());
    }
    write_atomic(config_path, &doc.to_string())
}

fn read_toml_doc(config_path: &Path) -> Result<DocumentMut, String> {
    if !config_path.exists() {
        return Ok(DocumentMut::new());
    }
    let raw = std::fs::read_to_string(config_path)
        .map_err(|err| format!("reading {}: {err}", config_path.display()))?;
    raw.parse::<DocumentMut>()
        .map_err(|err| format!("parsing {}: {err}", config_path.display()))
}

// --- shared write path -----------------------------------------------------

/// Write `contents` to `path` atomically (temp file in the same dir + rename),
/// creating the parent dir if needed and preserving the existing file's
/// permissions (so e.g. Codex's 0600 config stays 0600).
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|err| format!("creating {}: {err}", parent.display()))?;
    let tmp = parent.join(format!(".reverie-trust-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, contents).map_err(|err| format!("writing {}: {err}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let _ = std::fs::set_permissions(
                &tmp,
                std::fs::Permissions::from_mode(meta.permissions().mode()),
            );
        }
    }
    std::fs::rename(&tmp, path).map_err(|err| {
        let _ = std::fs::remove_file(&tmp);
        format!("replacing {}: {err}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn claude_trust_creates_file_when_missing() {
        let dir = tempdir().unwrap();
        let config = dir.path().join(".claude.json");
        set_claude_trust(&config, "/work/scratch").unwrap();

        let value: Value =
            serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(
            value["projects"]["/work/scratch"]["hasTrustDialogAccepted"],
            true
        );
    }

    #[test]
    fn claude_trust_merges_and_preserves_other_state() {
        let dir = tempdir().unwrap();
        let config = dir.path().join(".claude.json");
        std::fs::write(
            &config,
            r#"{"numStartups":7,"projects":{"/other":{"hasTrustDialogAccepted":true},"/work/scratch":{"lastCost":3}}}"#,
        )
        .unwrap();

        set_claude_trust(&config, "/work/scratch").unwrap();

        let value: Value =
            serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        // Unrelated top-level + sibling project state survives.
        assert_eq!(value["numStartups"], 7);
        assert_eq!(value["projects"]["/other"]["hasTrustDialogAccepted"], true);
        // Existing fields on the target project survive; trust is added.
        assert_eq!(value["projects"]["/work/scratch"]["lastCost"], 3);
        assert_eq!(
            value["projects"]["/work/scratch"]["hasTrustDialogAccepted"],
            true
        );
    }

    #[test]
    fn claude_clear_removes_only_named_keys() {
        let dir = tempdir().unwrap();
        let config = dir.path().join(".claude.json");
        set_claude_trust(&config, "/work/a").unwrap();
        set_claude_trust(&config, "/work/b").unwrap();

        clear_claude_trust(&config, &["/work/a".to_string()]).unwrap();

        let value: Value =
            serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert!(value["projects"].get("/work/a").is_none());
        assert_eq!(value["projects"]["/work/b"]["hasTrustDialogAccepted"], true);
    }

    #[test]
    fn codex_trust_writes_quoted_project_table() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("config.toml");
        set_codex_trust(&config, "/work/scratch dir").unwrap();

        let written = std::fs::read_to_string(&config).unwrap();
        assert!(
            written.contains("[projects.\"/work/scratch dir\"]"),
            "expected quoted leaf header, got:\n{written}"
        );
        assert!(written.contains("trust_level = \"trusted\""));
        // No empty parent header.
        assert!(!written.contains("\n[projects]\n"));

        // Re-parsing yields the expected value.
        let doc = written.parse::<DocumentMut>().unwrap();
        assert_eq!(
            doc["projects"]["/work/scratch dir"]["trust_level"].as_str(),
            Some("trusted")
        );
    }

    #[test]
    fn codex_trust_preserves_existing_config() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("config.toml");
        std::fs::write(
            &config,
            "model = \"gpt-5\"\n\n[projects.\"/other\"]\ntrust_level = \"trusted\"\n",
        )
        .unwrap();

        set_codex_trust(&config, "/work/scratch").unwrap();

        let doc = std::fs::read_to_string(&config)
            .unwrap()
            .parse::<DocumentMut>()
            .unwrap();
        assert_eq!(doc["model"].as_str(), Some("gpt-5"));
        assert_eq!(
            doc["projects"]["/other"]["trust_level"].as_str(),
            Some("trusted")
        );
        assert_eq!(
            doc["projects"]["/work/scratch"]["trust_level"].as_str(),
            Some("trusted")
        );
    }

    #[test]
    fn codex_clear_removes_only_named_keys() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("config.toml");
        set_codex_trust(&config, "/work/a").unwrap();
        set_codex_trust(&config, "/work/b").unwrap();

        clear_codex_trust(&config, &["/work/a".to_string()]).unwrap();

        let doc = std::fs::read_to_string(&config)
            .unwrap()
            .parse::<DocumentMut>()
            .unwrap();
        assert!(doc["projects"].get("/work/a").is_none());
        assert_eq!(
            doc["projects"]["/work/b"]["trust_level"].as_str(),
            Some("trusted")
        );
    }

    #[test]
    fn clear_is_a_noop_when_file_absent() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("nope.json");
        clear_claude_trust(&missing, &["/work/a".to_string()]).unwrap();
        assert!(!missing.exists());
    }
}
