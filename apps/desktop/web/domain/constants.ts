// Shared domain constants.

// The current user's real OS home directory. The backend reports it once at
// startup (the `system_home_dir` command) and the shell installs it via
// `setUserHome`; until then it is empty. Callers must treat an empty home as
// "unknown" and fall back safely (no `~` substitution, no home-based default).
// This replaces a path that used to be hardcoded to one developer's machine,
// which silently broke cwd display and the default working directory for
// everyone else.
let userHome = '';

// Install the OS home reported by the backend. Idempotent; null/undefined clear it.
export function setUserHome(home: string | null | undefined): void {
  userHome = home ?? '';
}

// The resolved OS home, or '' if not yet known. Synchronous so pure formatters
// (shortenCwd) and any caller can read it without threading it through props.
export function getUserHome(): string {
  return userHome;
}
