//! Login-shell `PATH` hydration for GUI launches.
//!
//! A macOS app launched from Finder, the Dock, or Spotlight inherits launchd's
//! minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), not the user's shell `PATH`.
//! That breaks Reverie two ways: `find_executable` (agent detection) walks the
//! process `PATH` and finds none of `claude` / `codex` / `cortex`, and even if it
//! did, the PTY child inherits this process's env (no `env_clear`), so a
//! node-shebang CLI (`#!/usr/bin/env node`) fails with `env: node: No such file
//! or directory` because `node` lives in Homebrew / nvm / fnm dirs that are not
//! on launchd's `PATH`. Launching from a terminal (`npm run dev`) masks all of
//! this because the dev process already carries the shell `PATH`.
//!
//! The fix, used by every macOS GUI dev tool (VS Code's `fix-path`, Hammerspoon,
//! etc.): ask the user's login + interactive shell for its `PATH` once at
//! startup and merge it into this process's `PATH`. Running the shell as both
//! login (`-l`, sources `.zprofile` where Homebrew's shellenv usually lives) and
//! interactive (`-i`, sources `.zshrc` where nvm/fnm/asdf init usually lives)
//! catches both common setups. We resolve `PATH` via `printenv` rather than
//! `$PATH` so the result is colon-joined regardless of shell (fish expands
//! `$PATH` as a list). Because we set the process-wide `PATH`, both the detection
//! read and the inherited PTY child env are corrected in one move, which also
//! gives the spawned CLIs `node`, `git`, `ripgrep`, etc. on their own `PATH`.

#[cfg(target_os = "macos")]
mod imp {
    use std::collections::HashSet;
    use std::env;
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    const MARKER_BEGIN: &str = "__REVERIE_PATH_BEGIN__";
    const MARKER_END: &str = "__REVERIE_PATH_END__";

    /// Cap on how long we wait for the login shell to print its `PATH`. Typical
    /// resolution is well under 300ms; this only guards a pathological rc file.
    const SHELL_TIMEOUT: Duration = Duration::from_secs(5);

    /// Resolve the user's login-shell `PATH`, merge it into the current process
    /// `PATH`, and write the result back via `set_var`. No-op (leaves `PATH`
    /// untouched) if resolution fails. Returns the new `PATH` when it changed.
    ///
    /// MUST be called from the very start of `main()`, before any threads spawn:
    /// `set_var` is `unsafe` (edition 2024) and is only sound while this is the
    /// sole thread touching the environment.
    pub fn hydrate() -> Option<String> {
        let current = env::var("PATH").unwrap_or_default();
        let resolved = resolve_login_shell_path().or_else(|| fallback_path(&current));
        let resolved = resolved?;

        let merged = merge_paths(&resolved, &current);
        if merged == current {
            return None;
        }

        // SAFETY: called as the first statement in `main()`, before Tauri (or
        // anything else) spawns a thread, so no other thread can be reading or
        // writing the environment concurrently.
        unsafe {
            env::set_var("PATH", &merged);
        }
        Some(merged)
    }

    /// Spawn the user's shell as login + interactive and read back its `PATH`.
    /// Falls back through fewer flags so an exotic shell that rejects `-i` or
    /// `-l` still yields something. Returns `None` if every attempt fails.
    fn resolve_login_shell_path() -> Option<String> {
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned());
        // Print unambiguous markers around the colon-joined env `PATH`. Using
        // `printenv` (an external command) keeps the value colon-joined in every
        // shell, including fish, whose `$PATH` would otherwise expand as a list.
        let command =
            format!("printf %s '{MARKER_BEGIN}'; printenv PATH; printf %s '{MARKER_END}'");

        // Most complete first; degrade if a shell chokes on a flag.
        for flags in [
            ["-i", "-l", "-c"].as_slice(),
            ["-l", "-c"].as_slice(),
            ["-c"].as_slice(),
        ] {
            if let Some(path) = run_shell(&shell, flags, &command) {
                return Some(path);
            }
        }
        None
    }

    /// Run `<shell> <flags...> <command>` with stdin closed, capture stdout under
    /// a timeout, and parse the marked `PATH` out of it.
    fn run_shell(shell: &str, flags: &[&str], command: &str) -> Option<String> {
        let mut child = Command::new(shell)
            .args(flags)
            .arg(command)
            // A closed stdin makes an interactive shell read EOF instead of
            // blocking on a prompt; stderr is rc-file noise we never parse.
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;

        let mut stdout = child.stdout.take()?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout.read_to_end(&mut buf);
            let _ = tx.send(buf);
        });

        let result = rx.recv_timeout(SHELL_TIMEOUT);
        // Reap the shell either way: a no-op `kill` on an already-exited child is
        // harmless, and on timeout it unblocks the reader thread and stops a
        // lingering process.
        let _ = child.kill();
        let _ = child.wait();

        let buf = result.ok()?;
        parse_marked_path(&String::from_utf8_lossy(&buf))
    }

    /// Extract the value between the begin/end markers, trimmed. Resilient to rc
    /// files that print banners before or after the markers. Returns `None` if
    /// either marker is absent or the captured value is empty.
    fn parse_marked_path(output: &str) -> Option<String> {
        let start = output.find(MARKER_BEGIN)? + MARKER_BEGIN.len();
        let rest = &output[start..];
        let end = rest.find(MARKER_END)?;
        let path = rest[..end].trim();
        if path.is_empty() {
            None
        } else {
            Some(path.to_owned())
        }
    }

    /// Last-ditch `PATH` when the shell can't be queried at all: the common
    /// install dirs that actually exist on this machine and are not already in
    /// `current`. Keeps Reverie functional even with a broken `$SHELL`.
    fn fallback_path(current: &str) -> Option<String> {
        let home = env::var("HOME").unwrap_or_default();
        let candidates = [
            "/opt/homebrew/bin".to_owned(),
            "/usr/local/bin".to_owned(),
            format!("{home}/.local/bin"),
        ];
        let existing: Vec<String> = candidates
            .into_iter()
            .filter(|dir| std::path::Path::new(dir).is_dir())
            .collect();
        if existing.is_empty() {
            return None;
        }
        // Prepend the discovered dirs ahead of the current minimal PATH.
        Some(merge_paths(&existing.join(":"), current))
    }

    /// Union of two colon-joined `PATH`s, `primary` entries first, deduplicated,
    /// preserving first-seen order and dropping empty segments.
    fn merge_paths(primary: &str, secondary: &str) -> String {
        let mut seen = HashSet::new();
        let mut out: Vec<&str> = Vec::new();
        for entry in primary.split(':').chain(secondary.split(':')) {
            if entry.is_empty() {
                continue;
            }
            if seen.insert(entry) {
                out.push(entry);
            }
        }
        out.join(":")
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parses_path_between_markers() {
            let out = format!(
                "rc banner noise\n{MARKER_BEGIN}/opt/homebrew/bin:/usr/bin\n{MARKER_END}trailing"
            );
            assert_eq!(
                parse_marked_path(&out).as_deref(),
                Some("/opt/homebrew/bin:/usr/bin")
            );
        }

        #[test]
        fn returns_none_without_markers() {
            assert_eq!(parse_marked_path("no markers here"), None);
            assert_eq!(parse_marked_path(MARKER_BEGIN), None); // begin but no end
        }

        #[test]
        fn returns_none_for_empty_value() {
            let out = format!("{MARKER_BEGIN}   {MARKER_END}");
            assert_eq!(parse_marked_path(&out), None);
        }

        #[test]
        fn merge_prefers_primary_order_and_dedups() {
            assert_eq!(
                merge_paths("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin:/sbin"),
                "/opt/homebrew/bin:/usr/bin:/bin:/sbin"
            );
        }

        #[test]
        fn merge_handles_empty_sides_and_segments() {
            assert_eq!(merge_paths("", "/usr/bin:/bin"), "/usr/bin:/bin");
            assert_eq!(merge_paths("/usr/bin:/bin", ""), "/usr/bin:/bin");
            assert_eq!(merge_paths("/a::/b:", ":/b:/c:"), "/a:/b:/c");
        }
    }
}

/// Resolve the login-shell `PATH` and merge it into this process's `PATH`.
///
/// Call this as the first statement in `main()`, before any threads spawn. On
/// non-macOS targets it is a no-op (Reverie ships macOS only, and only macOS GUI
/// launches strip the shell `PATH`).
pub fn hydrate_path_from_login_shell() {
    #[cfg(target_os = "macos")]
    {
        if let Some(_path) = imp::hydrate() {
            #[cfg(debug_assertions)]
            eprintln!("[reverie] hydrated PATH from login shell: {_path}");
        }
    }
}
