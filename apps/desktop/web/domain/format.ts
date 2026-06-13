import { getUserHome } from './constants';

// Small pure formatting/string helpers shared across the shell.

// Compact a cwd for display: replace the home directory with `~` and elide
// long middle segments so the meta strip stays scannable. Keeps the final
// folder name intact so the user can always tell which project they're in.
export function shortenCwd(cwd: string): string {
  if (!cwd) return '';
  // Only substitute `~` when we actually know the OS home; an empty home (not
  // yet resolved) must not turn every path into `~...`.
  const home = getUserHome();
  const path = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
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

// A compact "x ago" label from a Unix timestamp in seconds, for the project
// page's last-commit line. Coarse on purpose (no live ticking): the git context
// refreshes every few seconds, so minute/hour/day granularity is plenty.
export function relativeTimeFromSeconds(timeSeconds: number): string {
  const deltaSeconds = Math.max(0, Math.floor(Date.now() / 1000 - timeSeconds));
  if (deltaSeconds < 45) return 'just now';
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}
