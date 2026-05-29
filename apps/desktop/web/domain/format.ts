import { USER_HOME } from './constants';

// Small pure formatting/string helpers shared across the shell.

// Compact a cwd for display: replace the home directory with `~` and elide
// long middle segments so the meta strip stays scannable. Keeps the final
// folder name intact so the user can always tell which project they're in.
export function shortenCwd(cwd: string): string {
  if (!cwd) return '';
  const home = USER_HOME;
  const path = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  if (path.length <= 48) return path;
  const segments = path.split('/');
  if (segments.length <= 3) return path;
  return `${segments[0]}/…/${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}

export function shortId(value: string | undefined | null) {
  return value ? value.slice(0, 8) : undefined;
}

export function folderNameFromPath(path: string | undefined | null) {
  if (!path) return '';
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

export function average(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
