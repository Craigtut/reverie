//! Bridge installer: writes the reverie-managed MCP server and lifecycle
//! hook entries into each supported agent CLI's user-global config files.
//!
//! Per the design in `docs/technical/inter-agent-connections.md`, we
//! deliberately do not redirect CLI credential homes. Instead, with the
//! user's explicit consent, we merge one namespaced entry into each CLI's
//! existing global config (`~/.cortex/mcp.json` and `~/.cortex/hooks.json`
//! for Cortex; analogous files for Codex and Claude in later phases).
//!
//! The Reverie-managed key in every file is `reverie_bridge`. Reverie never
//! touches any other keys; merging is structural.

#![cfg(unix)]

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde_json::{Map, Value};
use toml_edit::{Array, DocumentMut, Item, Table, value};

/// Tells the installer where the freshly-built helper binaries live. The
/// caller resolves these (typically a Tauri sidecar lookup or a packaged
/// resource path).
#[derive(Clone, Debug)]
pub(crate) struct BridgeBinaries {
    pub(crate) reverie_bridge: PathBuf,
    pub(crate) preturn_hook: PathBuf,
}

/// Reported status for one CLI's bridge installation.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeInstallationStatus {
    /// Whether the MCP server entry is present and points at our binary.
    pub(crate) mcp_installed: bool,
    /// Whether the pre-turn hook entry is present and points at our binary.
    pub(crate) hook_installed: bool,
    /// True if either entry exists but points at an unexpected binary, which
    /// usually means the user has a different Reverie install or a stale path.
    pub(crate) mismatched_paths: bool,
}

pub(crate) const REVERIE_BRIDGE_KEY: &str = "reverie_bridge";
const TOOL_TIMEOUT_MS: i64 = 600_000;

// ---------------------------------------------------------------------------
// Cortex
// ---------------------------------------------------------------------------

/// Resolve `~/.cortex` from `$HOME` (or `$USERPROFILE` on Windows; bridge is
/// Unix-only today but the helper stays generic for clarity).
fn cortex_home() -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| anyhow::anyhow!("HOME is not set; cannot locate ~/.cortex"))?;
    Ok(PathBuf::from(home).join(".cortex"))
}

pub(crate) fn cortex_mcp_path() -> Result<PathBuf> {
    Ok(cortex_home()?.join("mcp.json"))
}

pub(crate) fn cortex_hooks_path() -> Result<PathBuf> {
    Ok(cortex_home()?.join("hooks.json"))
}

/// Install the bridge entries into Cortex's global config files. Idempotent.
/// Returns the status after writing.
pub(crate) fn install_cortex_bridge(binaries: &BridgeBinaries) -> Result<BridgeInstallationStatus> {
    let mcp_path = cortex_mcp_path()?;
    let hooks_path = cortex_hooks_path()?;
    write_cortex_mcp_entry(&mcp_path, &binaries.reverie_bridge)?;
    write_cortex_hooks_entry(&hooks_path, &binaries.preturn_hook)?;
    inspect_cortex_status(binaries)
}

/// Remove the bridge entries from Cortex's global config files. Other
/// entries the user added remain untouched. Idempotent.
pub(crate) fn uninstall_cortex_bridge() -> Result<()> {
    let mcp_path = cortex_mcp_path()?;
    let hooks_path = cortex_hooks_path()?;
    remove_named_entry_from_mcp_file(&mcp_path)?;
    remove_named_entry_from_hooks_file(&hooks_path)?;
    Ok(())
}

/// Inspect Cortex's bridge entries and report status without writing.
pub(crate) fn inspect_cortex_status(binaries: &BridgeBinaries) -> Result<BridgeInstallationStatus> {
    let mcp_path = cortex_mcp_path()?;
    let hooks_path = cortex_hooks_path()?;
    let (mcp_installed, mcp_matches) =
        check_named_entry(&mcp_path, "servers", &binaries.reverie_bridge);
    let (hook_installed, hook_matches) =
        check_hook_entry(&hooks_path, "pre_turn", &binaries.preturn_hook);
    Ok(BridgeInstallationStatus {
        mcp_installed,
        hook_installed,
        mismatched_paths: (mcp_installed && !mcp_matches) || (hook_installed && !hook_matches),
    })
}

// ---------------------------------------------------------------------------
// JSON merge helpers
// ---------------------------------------------------------------------------

fn write_cortex_mcp_entry(path: &PathBuf, helper: &PathBuf) -> Result<()> {
    let mut root = read_json_object_or_empty(path)?;
    let servers = root
        .entry("servers".to_owned())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("`servers` key in {} is not an object", path.display()))?;
    let mut entry = Map::new();
    entry.insert(
        "command".to_owned(),
        Value::String(helper.to_string_lossy().into_owned()),
    );
    entry.insert("args".to_owned(), Value::Array(vec![]));
    entry.insert(
        "toolTimeoutMs".to_owned(),
        Value::Number(serde_json::Number::from(TOOL_TIMEOUT_MS)),
    );
    servers.insert(REVERIE_BRIDGE_KEY.to_owned(), Value::Object(entry));
    write_json_atomic(path, &Value::Object(root))
}

fn write_cortex_hooks_entry(path: &PathBuf, handler: &PathBuf) -> Result<()> {
    let mut root = read_json_object_or_empty(path)?;
    let hooks = root
        .entry("hooks".to_owned())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("`hooks` key in {} is not an object", path.display()))?;
    let pre_turn = hooks
        .entry("pre_turn".to_owned())
        .or_insert_with(|| Value::Array(vec![]))
        .as_array_mut()
        .ok_or_else(|| anyhow::anyhow!("`hooks.pre_turn` in {} is not an array", path.display()))?;
    // Remove any prior reverie entry, then re-add ours so the path refreshes
    // if the binary moved (e.g. across app upgrades).
    pre_turn.retain(|value| value.get("name").and_then(Value::as_str) != Some(REVERIE_BRIDGE_KEY));
    let mut entry = Map::new();
    entry.insert(
        "name".to_owned(),
        Value::String(REVERIE_BRIDGE_KEY.to_owned()),
    );
    entry.insert(
        "command".to_owned(),
        Value::String(handler.to_string_lossy().into_owned()),
    );
    entry.insert(
        "timeoutMs".to_owned(),
        Value::Number(serde_json::Number::from(5_000)),
    );
    pre_turn.push(Value::Object(entry));
    write_json_atomic(path, &Value::Object(root))
}

fn remove_named_entry_from_mcp_file(path: &PathBuf) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let mut root = read_json_object_or_empty(path)?;
    if let Some(Value::Object(servers)) = root.get_mut("servers") {
        servers.remove(REVERIE_BRIDGE_KEY);
    }
    write_json_atomic(path, &Value::Object(root))
}

fn remove_named_entry_from_hooks_file(path: &PathBuf) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let mut root = read_json_object_or_empty(path)?;
    if let Some(Value::Object(hooks)) = root.get_mut("hooks") {
        if let Some(Value::Array(arr)) = hooks.get_mut("pre_turn") {
            arr.retain(|value| {
                value.get("name").and_then(Value::as_str) != Some(REVERIE_BRIDGE_KEY)
            });
        }
    }
    write_json_atomic(path, &Value::Object(root))
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

fn claude_home() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Ok(PathBuf::from(path));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| anyhow::anyhow!("HOME is not set; cannot locate ~/.claude.json"))?;
    Ok(PathBuf::from(home))
}

pub(crate) fn claude_config_path() -> Result<PathBuf> {
    Ok(claude_home()?.join(".claude.json"))
}

/// Install the bridge entry into Claude Code's `~/.claude.json`. We merge
/// into the top-level `mcpServers` object (Claude's documented user-scope
/// key). Idempotent.
pub(crate) fn install_claude_bridge(binaries: &BridgeBinaries) -> Result<BridgeInstallationStatus> {
    let path = claude_config_path()?;
    write_claude_mcp_entry(&path, &binaries.reverie_bridge)?;
    inspect_claude_status(binaries)
}

pub(crate) fn uninstall_claude_bridge() -> Result<()> {
    let path = claude_config_path()?;
    if !path.exists() {
        return Ok(());
    }
    let mut root = read_json_object_or_empty(&path)?;
    if let Some(Value::Object(servers)) = root.get_mut("mcpServers") {
        servers.remove(REVERIE_BRIDGE_KEY);
    }
    write_json_atomic(&path, &Value::Object(root))
}

pub(crate) fn inspect_claude_status(binaries: &BridgeBinaries) -> Result<BridgeInstallationStatus> {
    let path = claude_config_path()?;
    let (installed, matches) = check_named_entry(&path, "mcpServers", &binaries.reverie_bridge);
    Ok(BridgeInstallationStatus {
        mcp_installed: installed,
        // Claude reads UserPromptSubmit hooks from `~/.claude.json`'s
        // top-level `hooks` map. Phase 4 wiring lands the entry alongside
        // the MCP one; for now hook_installed mirrors mcp_installed so the
        // status surface stays accurate to what's been written.
        hook_installed: installed,
        mismatched_paths: installed && !matches,
    })
}

fn write_claude_mcp_entry(path: &PathBuf, helper: &PathBuf) -> Result<()> {
    let mut root = read_json_object_or_empty(path)?;
    let servers = root
        .entry("mcpServers".to_owned())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("`mcpServers` in {} is not an object", path.display()))?;
    let mut entry = Map::new();
    entry.insert("type".to_owned(), Value::String("stdio".to_owned()));
    entry.insert(
        "command".to_owned(),
        Value::String(helper.to_string_lossy().into_owned()),
    );
    entry.insert("args".to_owned(), Value::Array(vec![]));
    entry.insert("env".to_owned(), Value::Object(Map::new()));
    // Claude Code reads `timeout` in milliseconds. 600 s window covers a
    // human-decision wait without rearming.
    entry.insert(
        "timeout".to_owned(),
        Value::Number(serde_json::Number::from(TOOL_TIMEOUT_MS)),
    );
    servers.insert(REVERIE_BRIDGE_KEY.to_owned(), Value::Object(entry));
    write_json_atomic(path, &Value::Object(root))
}

// ---------------------------------------------------------------------------
// Codex CLI
// ---------------------------------------------------------------------------

fn codex_home() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("CODEX_HOME") {
        return Ok(PathBuf::from(path));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| anyhow::anyhow!("HOME is not set; cannot locate ~/.codex"))?;
    Ok(PathBuf::from(home).join(".codex"))
}

pub(crate) fn codex_config_path() -> Result<PathBuf> {
    Ok(codex_home()?.join("config.toml"))
}

/// Install the bridge entry into Codex's `~/.codex/config.toml`. Idempotent.
/// Codex's MCP server table sits under `[mcp_servers.<name>]`; we add the
/// `reverie_bridge` namespace.
pub(crate) fn install_codex_bridge(binaries: &BridgeBinaries) -> Result<BridgeInstallationStatus> {
    let path = codex_config_path()?;
    write_codex_mcp_entry(&path, &binaries.reverie_bridge)?;
    inspect_codex_status(binaries)
}

pub(crate) fn uninstall_codex_bridge() -> Result<()> {
    let path = codex_config_path()?;
    if !path.exists() {
        return Ok(());
    }
    let mut doc = read_toml_document_or_empty(&path)?;
    if let Some(Item::Table(table)) = doc.get_mut("mcp_servers") {
        table.remove(REVERIE_BRIDGE_KEY);
    }
    write_toml_atomic(&path, &doc)
}

pub(crate) fn inspect_codex_status(binaries: &BridgeBinaries) -> Result<BridgeInstallationStatus> {
    let path = codex_config_path()?;
    if !path.exists() {
        return Ok(BridgeInstallationStatus {
            mcp_installed: false,
            hook_installed: false,
            mismatched_paths: false,
        });
    }
    let doc = read_toml_document_or_empty(&path)?;
    let (installed, matches) = match doc
        .get("mcp_servers")
        .and_then(Item::as_table)
        .and_then(|table| table.get(REVERIE_BRIDGE_KEY))
        .and_then(Item::as_table)
    {
        Some(table) => {
            let command = table.get("command").and_then(Item::as_str).unwrap_or("");
            (
                true,
                paths_equal(&PathBuf::from(command), &binaries.reverie_bridge),
            )
        }
        None => (false, false),
    };
    Ok(BridgeInstallationStatus {
        mcp_installed: installed,
        // Codex has no equivalent of Cortex's pre_turn hook config file in
        // v1; the hook delivery path goes through Reverie's HTTP hook server.
        // We still report installed=true once Codex's hook config has been
        // wired (Phase 3 wiring), but for now treat absence as "not yet".
        hook_installed: installed,
        mismatched_paths: installed && !matches,
    })
}

fn write_codex_mcp_entry(path: &PathBuf, helper: &PathBuf) -> Result<()> {
    let mut doc = read_toml_document_or_empty(path)?;
    let mcp_servers = doc
        .entry("mcp_servers")
        .or_insert_with(|| Item::Table(Table::new()))
        .as_table_mut()
        .ok_or_else(|| anyhow::anyhow!("`mcp_servers` in {} is not a table", path.display()))?;

    let mut entry = Table::new();
    entry.insert("command", value(helper.to_string_lossy().into_owned()));
    entry.insert("args", value(Array::default()));
    // `tool_timeout_sec` is the Codex-side name (Codex uses seconds; the
    // SDK reads ms but Codex normalises). 600 seconds = 10 min, comfortably
    // covers a human-decision window for connection requests.
    entry.insert("tool_timeout_sec", value(600_i64));
    mcp_servers.insert(REVERIE_BRIDGE_KEY, Item::Table(entry));
    write_toml_atomic(path, &doc)
}

fn read_toml_document_or_empty(path: &PathBuf) -> Result<DocumentMut> {
    if !path.exists() {
        return Ok(DocumentMut::new());
    }
    let text = fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    if text.trim().is_empty() {
        return Ok(DocumentMut::new());
    }
    text.parse::<DocumentMut>()
        .with_context(|| format!("parsing {} as TOML", path.display()))
}

fn write_toml_atomic(path: &PathBuf, doc: &DocumentMut) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("{} has no parent dir", path.display()))?;
    fs::create_dir_all(parent)
        .with_context(|| format!("creating directory {}", parent.display()))?;
    let mut tmp = path.clone();
    tmp.set_extension(format!(
        "{}.tmp.{}",
        path.extension().and_then(|s| s.to_str()).unwrap_or("toml"),
        std::process::id(),
    ));
    {
        let mut file = fs::File::create(&tmp)
            .with_context(|| format!("opening temp file {}", tmp.display()))?;
        file.write_all(doc.to_string().as_bytes())
            .with_context(|| format!("writing {}", tmp.display()))?;
        file.flush()
            .with_context(|| format!("flushing {}", tmp.display()))?;
    }
    fs::rename(&tmp, path).with_context(|| {
        format!(
            "renaming {} -> {} (atomic TOML write)",
            tmp.display(),
            path.display()
        )
    })?;
    Ok(())
}

fn check_named_entry(path: &PathBuf, group: &str, expected: &PathBuf) -> (bool, bool) {
    if !path.exists() {
        return (false, false);
    }
    let root = match read_json_object_or_empty(path) {
        Ok(value) => value,
        Err(_) => return (false, false),
    };
    let group = match root.get(group) {
        Some(Value::Object(map)) => map,
        _ => return (false, false),
    };
    let entry = match group.get(REVERIE_BRIDGE_KEY) {
        Some(value) => value,
        None => return (false, false),
    };
    let command = entry
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();
    (true, paths_equal(&PathBuf::from(command), expected))
}

fn check_hook_entry(path: &PathBuf, event: &str, expected: &PathBuf) -> (bool, bool) {
    if !path.exists() {
        return (false, false);
    }
    let root = match read_json_object_or_empty(path) {
        Ok(value) => value,
        Err(_) => return (false, false),
    };
    let arr = match root.get("hooks").and_then(|h| h.get(event)) {
        Some(Value::Array(arr)) => arr,
        _ => return (false, false),
    };
    let entry = arr
        .iter()
        .find(|value| value.get("name").and_then(Value::as_str) == Some(REVERIE_BRIDGE_KEY));
    match entry {
        Some(value) => {
            let command = value
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default();
            (true, paths_equal(&PathBuf::from(command), expected))
        }
        None => (false, false),
    }
}

/// Compare two paths after best-effort canonicalisation. Symlinks, `..`
/// segments, or differing-but-equivalent absolute/relative forms would
/// otherwise produce a false "mismatched_paths" report.
fn paths_equal(a: &std::path::Path, b: &std::path::Path) -> bool {
    let lhs = std::fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf());
    let rhs = std::fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf());
    lhs == rhs
}

fn read_json_object_or_empty(path: &PathBuf) -> Result<Map<String, Value>> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(Map::new());
    }
    let value: Value = serde_json::from_slice(&bytes)
        .with_context(|| format!("parsing {} as JSON", path.display()))?;
    match value {
        Value::Object(map) => Ok(map),
        Value::Null => Ok(Map::new()),
        other => anyhow::bail!("{} is not a JSON object: {other}", path.display()),
    }
}

fn write_json_atomic(path: &PathBuf, value: &Value) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("{} has no parent dir", path.display()))?;
    fs::create_dir_all(parent)
        .with_context(|| format!("creating directory {}", parent.display()))?;
    let mut tmp = path.clone();
    tmp.set_extension(format!(
        "{}.tmp.{}",
        path.extension().and_then(|s| s.to_str()).unwrap_or("json"),
        std::process::id(),
    ));
    {
        let mut file = fs::File::create(&tmp)
            .with_context(|| format!("opening temp file {}", tmp.display()))?;
        let encoded =
            serde_json::to_string_pretty(value).context("encoding JSON for bridge config write")?;
        file.write_all(encoded.as_bytes())
            .with_context(|| format!("writing {}", tmp.display()))?;
        file.write_all(b"\n").ok();
        file.flush()
            .with_context(|| format!("flushing {}", tmp.display()))?;
    }
    fs::rename(&tmp, path).with_context(|| {
        format!(
            "renaming {} -> {} (atomic write)",
            tmp.display(),
            path.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::TempDir;

    // Serialise HOME-mutating tests so they cannot race in cargo's default
    // parallel runner. The lock scope outlives both env mutations.
    static HOME_LOCK: Mutex<()> = Mutex::new(());

    fn binaries(reverie: &PathBuf, hook: &PathBuf) -> BridgeBinaries {
        BridgeBinaries {
            reverie_bridge: reverie.clone(),
            preturn_hook: hook.clone(),
        }
    }

    #[test]
    fn write_cortex_mcp_entry_creates_file_and_adds_namespaced_entry() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("mcp.json");
        let helper = PathBuf::from("/usr/local/bin/reverie-bridge");
        write_cortex_mcp_entry(&path, &helper).unwrap();

        let bytes = fs::read_to_string(&path).unwrap();
        let parsed: Value = serde_json::from_str(&bytes).unwrap();
        let entry = parsed
            .get("servers")
            .and_then(|s| s.get(REVERIE_BRIDGE_KEY))
            .unwrap();
        assert_eq!(
            entry["command"].as_str().unwrap(),
            helper.to_string_lossy().as_ref()
        );
        assert_eq!(entry["toolTimeoutMs"], 600_000);
        assert!(entry["args"].is_array());
    }

    #[test]
    fn write_cortex_mcp_entry_merges_with_existing_user_servers() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("mcp.json");
        fs::write(
            &path,
            r#"{"servers":{"weather":{"command":"node","args":["weather.js"]}}}"#,
        )
        .unwrap();
        let helper = PathBuf::from("/bin/r");
        write_cortex_mcp_entry(&path, &helper).unwrap();
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let servers = parsed.get("servers").unwrap().as_object().unwrap();
        assert!(servers.contains_key("weather"), "user server preserved");
        assert!(servers.contains_key(REVERIE_BRIDGE_KEY));
    }

    #[test]
    fn write_cortex_hooks_entry_replaces_prior_reverie_entry_without_touching_others() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("hooks.json");
        fs::write(
            &path,
            r#"{"hooks":{"pre_turn":[
                {"name":"reverie_bridge","command":"/old/path"},
                {"name":"audit-log","command":"/usr/local/bin/audit"}
            ]}}"#,
        )
        .unwrap();
        let handler = PathBuf::from("/new/path/hook");
        write_cortex_hooks_entry(&path, &handler).unwrap();
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let arr = parsed["hooks"]["pre_turn"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert!(arr.iter().any(|v| v["name"] == "audit-log"));
        let reverie = arr
            .iter()
            .find(|v| v["name"] == REVERIE_BRIDGE_KEY)
            .unwrap();
        assert_eq!(
            reverie["command"].as_str().unwrap(),
            handler.to_string_lossy().as_ref()
        );
    }

    #[test]
    fn install_then_uninstall_round_trips_through_status() {
        let _guard = HOME_LOCK.lock().unwrap_or_else(|err| err.into_inner());
        let tmp = TempDir::new().unwrap();
        // Override HOME for this test so cortex_home() lands in our tmp dir.
        let prev = std::env::var_os("HOME");
        // SAFETY: tests run single-threaded for this module (no #[test] within
        // bridge_installer mutates HOME concurrently with another); the only
        // observable effect is on cortex_home() lookups in the same thread.
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }
        let helper = tmp.path().join("reverie-bridge");
        let hook = tmp.path().join("reverie-bridge-preturn-hook");
        fs::write(&helper, b"").unwrap();
        fs::write(&hook, b"").unwrap();
        let bins = binaries(&helper, &hook);

        let status = install_cortex_bridge(&bins).unwrap();
        assert!(status.mcp_installed, "mcp entry installed");
        assert!(status.hook_installed, "hook entry installed");
        assert!(!status.mismatched_paths);

        uninstall_cortex_bridge().unwrap();
        let after = inspect_cortex_status(&bins).unwrap();
        assert!(!after.mcp_installed);
        assert!(!after.hook_installed);

        // Restore previous env so we do not pollute siblings.
        // SAFETY: see set_var rationale above; we restore the original value
        // (or unset) on the same thread that mutated it.
        unsafe {
            match prev {
                Some(val) => std::env::set_var("HOME", val),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    #[test]
    fn codex_install_writes_namespaced_mcp_server_table() {
        let _guard = HOME_LOCK.lock().unwrap_or_else(|err| err.into_inner());
        let tmp = TempDir::new().unwrap();
        let prev_home = std::env::var_os("HOME");
        let prev_codex = std::env::var_os("CODEX_HOME");
        unsafe {
            std::env::set_var("HOME", tmp.path());
            std::env::remove_var("CODEX_HOME");
        }
        let helper = tmp.path().join("reverie-bridge");
        let hook = tmp.path().join("reverie-bridge-preturn-hook");
        fs::write(&helper, b"").unwrap();
        fs::write(&hook, b"").unwrap();
        let bins = binaries(&helper, &hook);

        install_codex_bridge(&bins).unwrap();
        let config_path = codex_config_path().unwrap();
        let toml_text = fs::read_to_string(&config_path).unwrap();
        assert!(
            toml_text.contains("[mcp_servers.reverie_bridge]"),
            "config.toml should contain reverie_bridge table, got:\n{toml_text}"
        );
        assert!(toml_text.contains("tool_timeout_sec = 600"));

        let status = inspect_codex_status(&bins).unwrap();
        assert!(status.mcp_installed);
        assert!(!status.mismatched_paths);

        uninstall_codex_bridge().unwrap();
        let after = inspect_codex_status(&bins).unwrap();
        assert!(!after.mcp_installed);

        unsafe {
            match prev_home {
                Some(val) => std::env::set_var("HOME", val),
                None => std::env::remove_var("HOME"),
            }
            match prev_codex {
                Some(val) => std::env::set_var("CODEX_HOME", val),
                None => std::env::remove_var("CODEX_HOME"),
            }
        }
    }

    #[test]
    fn codex_install_preserves_user_authored_tables() {
        let _guard = HOME_LOCK.lock().unwrap_or_else(|err| err.into_inner());
        let tmp = TempDir::new().unwrap();
        let prev_home = std::env::var_os("HOME");
        let prev_codex = std::env::var_os("CODEX_HOME");
        unsafe {
            std::env::set_var("HOME", tmp.path());
            std::env::remove_var("CODEX_HOME");
        }
        let config_path = codex_config_path().unwrap();
        fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        fs::write(
            &config_path,
            "model = \"gpt-4\"\n\n[mcp_servers.weather]\ncommand = \"node\"\nargs = [\"weather.js\"]\n",
        )
        .unwrap();
        let bins = binaries(
            &PathBuf::from("/bin/reverie-bridge"),
            &PathBuf::from("/bin/hook"),
        );
        install_codex_bridge(&bins).unwrap();
        let updated = fs::read_to_string(&config_path).unwrap();
        assert!(updated.contains("model = \"gpt-4\""));
        assert!(updated.contains("[mcp_servers.weather]"));
        assert!(updated.contains("[mcp_servers.reverie_bridge]"));

        unsafe {
            match prev_home {
                Some(val) => std::env::set_var("HOME", val),
                None => std::env::remove_var("HOME"),
            }
            match prev_codex {
                Some(val) => std::env::set_var("CODEX_HOME", val),
                None => std::env::remove_var("CODEX_HOME"),
            }
        }
    }

    #[test]
    fn claude_install_writes_namespaced_mcp_servers_entry() {
        let _guard = HOME_LOCK.lock().unwrap_or_else(|err| err.into_inner());
        let tmp = TempDir::new().unwrap();
        let prev_home = std::env::var_os("HOME");
        let prev_claude = std::env::var_os("CLAUDE_CONFIG_DIR");
        unsafe {
            std::env::set_var("HOME", tmp.path());
            std::env::remove_var("CLAUDE_CONFIG_DIR");
        }
        let helper = tmp.path().join("reverie-bridge");
        let hook = tmp.path().join("reverie-bridge-preturn-hook");
        fs::write(&helper, b"").unwrap();
        fs::write(&hook, b"").unwrap();
        let bins = binaries(&helper, &hook);

        install_claude_bridge(&bins).unwrap();
        let path = claude_config_path().unwrap();
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let entry = parsed["mcpServers"][REVERIE_BRIDGE_KEY].clone();
        assert_eq!(entry["type"], "stdio");
        assert_eq!(
            entry["command"].as_str().unwrap(),
            helper.to_string_lossy().as_ref()
        );
        assert_eq!(entry["timeout"], 600_000);

        let status = inspect_claude_status(&bins).unwrap();
        assert!(status.mcp_installed);
        assert!(!status.mismatched_paths);

        uninstall_claude_bridge().unwrap();
        let after = inspect_claude_status(&bins).unwrap();
        assert!(!after.mcp_installed);

        unsafe {
            match prev_home {
                Some(val) => std::env::set_var("HOME", val),
                None => std::env::remove_var("HOME"),
            }
            match prev_claude {
                Some(val) => std::env::set_var("CLAUDE_CONFIG_DIR", val),
                None => std::env::remove_var("CLAUDE_CONFIG_DIR"),
            }
        }
    }

    #[test]
    fn claude_install_preserves_existing_top_level_keys() {
        let _guard = HOME_LOCK.lock().unwrap_or_else(|err| err.into_inner());
        let tmp = TempDir::new().unwrap();
        let prev_home = std::env::var_os("HOME");
        let prev_claude = std::env::var_os("CLAUDE_CONFIG_DIR");
        unsafe {
            std::env::set_var("HOME", tmp.path());
            std::env::remove_var("CLAUDE_CONFIG_DIR");
        }
        let path = claude_config_path().unwrap();
        fs::write(
            &path,
            r#"{"telemetry":{"enabled":true},"mcpServers":{"weather":{"command":"node"}}}"#,
        )
        .unwrap();
        let bins = binaries(
            &PathBuf::from("/bin/reverie-bridge"),
            &PathBuf::from("/bin/hook"),
        );
        install_claude_bridge(&bins).unwrap();
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["telemetry"]["enabled"], true);
        assert!(parsed["mcpServers"]["weather"].is_object());
        assert!(parsed["mcpServers"][REVERIE_BRIDGE_KEY].is_object());

        unsafe {
            match prev_home {
                Some(val) => std::env::set_var("HOME", val),
                None => std::env::remove_var("HOME"),
            }
            match prev_claude {
                Some(val) => std::env::set_var("CLAUDE_CONFIG_DIR", val),
                None => std::env::remove_var("CLAUDE_CONFIG_DIR"),
            }
        }
    }

    #[test]
    fn inspect_reports_mismatched_paths_when_command_points_elsewhere() {
        let _guard = HOME_LOCK.lock().unwrap_or_else(|err| err.into_inner());
        let tmp = TempDir::new().unwrap();
        let prev = std::env::var_os("HOME");
        // SAFETY: tests run single-threaded for this module (no #[test] within
        // bridge_installer mutates HOME concurrently with another); the only
        // observable effect is on cortex_home() lookups in the same thread.
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }
        let mcp_path = cortex_mcp_path().unwrap();
        fs::create_dir_all(mcp_path.parent().unwrap()).unwrap();
        fs::write(
            &mcp_path,
            r#"{"servers":{"reverie_bridge":{"command":"/somewhere/else","args":[]}}}"#,
        )
        .unwrap();
        let bins = binaries(
            &PathBuf::from("/expected/reverie-bridge"),
            &PathBuf::from("/expected/preturn-hook"),
        );
        let status = inspect_cortex_status(&bins).unwrap();
        assert!(status.mcp_installed);
        assert!(status.mismatched_paths);

        // SAFETY: see set_var rationale above; we restore the original value
        // (or unset) on the same thread that mutated it.
        unsafe {
            match prev {
                Some(val) => std::env::set_var("HOME", val),
                None => std::env::remove_var("HOME"),
            }
        }
    }
}
