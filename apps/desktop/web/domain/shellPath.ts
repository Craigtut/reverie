// Pure formatting of dropped filesystem paths into the text we insert at a
// session's prompt. Mirrors what Terminal.app / iTerm do on a file drop: leave
// shell-safe paths bare, single-quote anything else (spaces, glob characters,
// quotes), and separate multiple paths with spaces. No DOM, no I/O.

// Characters that survive unquoted in every shell we target. Anything outside
// this set forces single-quoting so the CLI receives one intact argument.
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function quoteShellPath(path: string): string {
  if (path.length === 0) return "''";
  if (SHELL_SAFE.test(path)) return path;
  // Single-quote, escaping embedded single quotes as the classic '\'' dance:
  // close the quote, emit an escaped quote, reopen.
  return `'${path.replaceAll("'", "'\\''")}'`;
}

// Join dropped paths into prompt-ready text. Returns a trailing space so the
// caret lands clear of the inserted argument, ready for the next keystroke.
// Empty input yields an empty string (nothing to insert).
export function formatDroppedPaths(paths: string[]): string {
  const usable = paths.filter(path => path.length > 0);
  if (usable.length === 0) return '';
  return `${usable.map(quoteShellPath).join(' ')} `;
}

// The display name for a dropped path: the final path segment, trimmed of any
// trailing separator. Used by the carried chip in the drop overlay.
export function droppedPathLabel(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}
