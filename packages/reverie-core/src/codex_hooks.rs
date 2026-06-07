//! Reverie's per-session Codex CLI lifecycle hooks, injected entirely through
//! `-c` overrides (Codex's highest-precedence "SessionFlags" config layer).
//!
//! Unlike Claude (which takes a `--settings <file>` we write to disk), Codex is
//! instrumented with **zero files written and no `CODEX_HOME` redirect**: we
//! pass the hook definitions *and* their trust state as repeated `-c` flags on
//! the launch. This is deliberate and load-bearing:
//!
//! - `-c` is the highest-precedence layer, applies to interactive `codex` and
//!   `codex resume` alike, and is **additive** to the user's own
//!   `~/.codex/config.toml` / `~/.codex/hooks.json` (their hooks still fire).
//! - The per-session token + port are delivered out of band in the spawn env
//!   (`REVERIE_HOOK_TOKEN` / `REVERIE_HOOK_PORT`), not in the command string, so
//!   the forwarder command stays byte-identical across launches. That matters
//!   because Codex's hook **trust hash is computed over the command string**: a
//!   stable string keeps the pre-seeded trust valid.
//! - SessionFlags is one of only two layers whose `[hooks.state]` Codex honors,
//!   so passing a correct `trusted_hash` here makes the hook run **Trusted**,
//!   with no interactive `/hooks` approval and without the blunt
//!   `--dangerously-bypass-hook-trust` (which would also un-gate the user's
//!   other untrusted hooks).
//!
//! The trust hash recipe below is replicated from `openai/codex` `rust-v0.137.0`
//! and verified byte-for-byte against the live CLI: a hook injected with these
//! args fires Trusted with no bypass flag. The shape is version-sensitive (the
//! state-key format has an upstream TODO to change), so it is pinned here and
//! covered by fixture tests; if a future Codex changes it, the hooks degrade to
//! the rollout watcher rather than misbehaving.

use std::path::Path;

use sha2::{Digest, Sha256};

/// The hook events Reverie installs, as `(codex_event_name, state_key_label)`.
///
/// Minimal by design. We do **not** subscribe `PreToolUse`/`PostToolUse`: Codex
/// runs command hooks synchronously inline in the turn, so a per-tool hook adds
/// latency proportional to tool count, and the rollout watcher already supplies
/// rich tool detail. These four are the lifecycle edges we actually drive state
/// from: `SessionStart` captures the native id the instant the session starts;
/// `UserPromptSubmit` = turn start; `PermissionRequest` = blocked on an approval;
/// `Stop` = turn end.
///
/// `PermissionRequest` is matcher-bearing, but with no matcher supplied Codex's
/// `matcher_pattern_for_event` passes `None` through, so its normalized identity
/// (and trust hash) has no `matcher` key, exactly like the others. The definitive
/// approval signal supersedes the rollout watcher's inferred `with_escalated_permissions`
/// heuristic via the reconciler's fidelity merge.
const CODEX_HOOK_EVENTS: &[(&str, &str)] = &[
    ("SessionStart", "session_start"),
    ("UserPromptSubmit", "user_prompt_submit"),
    ("PermissionRequest", "permission_request"),
    ("Stop", "stop"),
];

/// The synthetic config-source path Codex assigns to the SessionFlags (`-c`)
/// layer. It is the `{key_source}` half of every `[hooks.state]` key for a
/// `-c`-injected hook. Verified against codex-cli 0.137.0 (the leading slash and
/// the literal angle brackets are real).
const SESSION_FLAGS_SOURCE: &str = "/<session-flags>/config.toml";

/// Default per-command-hook timeout Codex folds in when none is given. Part of
/// the normalized identity that gets hashed, so it must match Codex exactly.
const HOOK_TIMEOUT_SECS: u32 = 600;

/// Build the `-c` arguments that install Reverie's Codex lifecycle hooks for one
/// launch, trusted via pre-computed hashes. `forwarder_path` is the absolute
/// path to the staged `reverie-bridge-codex-hook` helper; it is hashed into the
/// trust state, so it must be the exact string used in the hook command.
///
/// The returned vec is ready to append to a `codex` / `codex resume` argv (the
/// flags are global, so order relative to the subcommand does not matter). It is
/// pure: the caller still mints the token, registers it with the hook server,
/// and injects `REVERIE_HOOK_TOKEN` / `REVERIE_HOOK_PORT` into the spawn env.
pub fn codex_hook_config_args(forwarder_path: &Path) -> Vec<String> {
    let command = forwarder_path.to_string_lossy();
    let mut args: Vec<String> = Vec::with_capacity(CODEX_HOOK_EVENTS.len() * 2 + 2);
    let mut state_entries: Vec<String> = Vec::with_capacity(CODEX_HOOK_EVENTS.len());

    for (event_name, event_label) in CODEX_HOOK_EVENTS {
        // The hook definition: a single matcher-free command group.
        args.push("-c".to_owned());
        args.push(format!(
            "hooks.{event_name}=[{{ hooks=[{{ type=\"command\", command={command} }}] }}]",
            command = toml_basic_string(&command)
        ));

        // The matching trust entry so the hook runs Trusted (no bypass).
        let key = format!("{SESSION_FLAGS_SOURCE}:{event_label}:0:0");
        let hash = trusted_hash(event_label, &command);
        state_entries.push(format!(
            "{key}={{ trusted_hash={hash} }}",
            key = toml_basic_string(&key),
            hash = toml_basic_string(&hash),
        ));
    }

    // All trust entries in one `hooks.state` inline table (merges with any the
    // user has in their own config; per-key fields are merged field-by-field).
    args.push("-c".to_owned());
    args.push(format!("hooks.state={{ {} }}", state_entries.join(", ")));

    args
}

/// Compute the Codex trust hash for one matcher-free command hook.
///
/// Replicates Codex's `command_hook_hash` -> `version_for_toml` pipeline: build
/// the normalized identity (defaults folded in: `timeout=600`, `async=false`;
/// `None` fields dropped by the TOML round-trip, hence absent here), serialize
/// as **canonical JSON** (object keys sorted lexicographically, compact `,`/`:`
/// separators), SHA-256, lowercase hex, `sha256:` prefix. Built by hand so it is
/// independent of any `serde_json` map-ordering feature flags.
fn trusted_hash(event_label: &str, command: &str) -> String {
    // serde_json::to_string on a &str only quotes + escapes it (no map ordering
    // involved), so it matches Codex's JSON escaping exactly.
    let event_json = serde_json::to_string(event_label).expect("string serializes");
    let command_json = serde_json::to_string(command).expect("string serializes");

    // Keys are emitted in sorted order: top level `event_name` < `hooks`; inner
    // handler `async` < `command` < `timeout` < `type`. This is the exact byte
    // sequence Codex hashes for a matcher-free command handler.
    let canonical = format!(
        "{{\"event_name\":{event_json},\"hooks\":[{{\"async\":false,\"command\":{command_json},\"timeout\":{HOOK_TIMEOUT_SECS},\"type\":\"command\"}}]}}"
    );

    let digest = Sha256::digest(canonical.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    format!("sha256:{hex}")
}

/// Escape a string as a TOML basic string (double-quoted) for use as a `-c`
/// override value. Filesystem paths, the sha256 hashes, and the state keys we
/// emit only ever contain ASCII without quotes or backslashes, but we escape the
/// two TOML-significant characters defensively so an unusual path can never
/// break the override parse.
fn toml_basic_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Ground truth: these digests were produced by the real Codex hashing code
    /// (and reproduced live: a hook injected with them fires Trusted with no
    /// bypass on codex-cli 0.137.0). If this fails, our hash recipe drifted from
    /// Codex and the pre-seeded trust would silently stop working.
    #[test]
    fn trusted_hash_matches_codex_for_verified_commands() {
        // command = "/abs/path/forwarder" (the cross-checked fixture)
        assert_eq!(
            trusted_hash("stop", "/abs/path/forwarder"),
            "sha256:73f7087a195c4ba628ea67580a63dc5942ede9c1310fbe785db11ff01408d33c"
        );
        assert_eq!(
            trusted_hash("session_start", "/abs/path/forwarder"),
            "sha256:7052f4cf46032e30d7b56d23cd91adf72fcbdcba1d143b76d900f53e3cf84fc1"
        );

        // PermissionRequest is matcher-bearing but hashes like the rest with no
        // matcher supplied (cross-checked against rust-v0.137.0 command_hook_hash).
        assert_eq!(
            trusted_hash("permission_request", "/abs/path/forwarder"),
            "sha256:354fce909e5e514e42327261e05b9b423f9fff69cde54db155fabada5db9cfda"
        );

        // command = "/private/tmp/rev-hook.sh" (the live smoke-test fixture)
        assert_eq!(
            trusted_hash("session_start", "/private/tmp/rev-hook.sh"),
            "sha256:932ff9c435e0eb610421fc8bcb41e0de2d9a213ca6dc6fef60eaf00bd4bcdd6e"
        );
        assert_eq!(
            trusted_hash("user_prompt_submit", "/private/tmp/rev-hook.sh"),
            "sha256:901ba38dff20ca2ea2565852cba0fb4120aecd41a0051be2d59d8a063216e1a7"
        );
        assert_eq!(
            trusted_hash("stop", "/private/tmp/rev-hook.sh"),
            "sha256:80bd61d266905b1982a086a7f6552d68780350085593468a088fbd48738603e1"
        );
    }

    #[test]
    fn config_args_define_and_trust_every_enabled_event() {
        let args = codex_hook_config_args(&PathBuf::from("/opt/reverie/reverie-bridge-codex-hook"));

        // One `-c def` pair per event, plus one `-c hooks.state` pair.
        assert_eq!(args.len(), (CODEX_HOOK_EVENTS.len() + 1) * 2);
        for chunk in args.chunks(2) {
            assert_eq!(chunk[0], "-c");
        }

        let joined = args.join(" ");
        for (event_name, event_label) in CODEX_HOOK_EVENTS {
            // The hook is defined for this event...
            assert!(
                joined.contains(&format!("hooks.{event_name}=[")),
                "missing hook definition for {event_name}"
            );
            // ...and a matching trust entry keyed by the SessionFlags path exists.
            let key = format!("{SESSION_FLAGS_SOURCE}:{event_label}:0:0");
            assert!(
                joined.contains(&key),
                "missing trust state for {event_name} (key {key})"
            );
        }
        // The trust state is collected into a single hooks.state override.
        assert!(joined.contains("hooks.state={"));
    }

    #[test]
    fn config_args_embed_the_exact_forwarder_path_and_its_hash() {
        let path = PathBuf::from("/private/tmp/rev-hook.sh");
        let args = codex_hook_config_args(&path);
        let joined = args.join(" ");

        // The command string is the literal forwarder path (so the trust hash,
        // which is computed over it, stays valid).
        assert!(joined.contains("command=\"/private/tmp/rev-hook.sh\""));
        // And the Stop trust hash is the verified one for that path.
        assert!(
            joined.contains(
                "sha256:80bd61d266905b1982a086a7f6552d68780350085593468a088fbd48738603e1"
            )
        );
    }

    #[test]
    fn toml_basic_string_escapes_quotes_and_backslashes() {
        assert_eq!(toml_basic_string("/plain/path"), "\"/plain/path\"");
        assert_eq!(toml_basic_string(r#"a"b"#), r#""a\"b""#);
        assert_eq!(toml_basic_string(r"a\b"), r#""a\\b""#);
    }
}
