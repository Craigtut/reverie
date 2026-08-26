// WKWebView can suspend requestAnimationFrame while native Channel messages
// continue to queue. Keep only a tiny paint backlog. Once it grows past this
// bound, partial frames are no longer safe to coalesce, so the frontend asks the
// authoritative Rust terminal for one fresh Full seed.
export const MAX_PENDING_TERMINAL_FRAMES = 8;

export type TerminalFrameBacklogAction =
  | 'enqueue'
  | 'accept_full'
  | 'drop'
  | 'resync'
  | 'resync_preserve_full';

export function terminalFrameBacklogAction(options: {
  pageActive: boolean;
  awaitingFull: boolean;
  isFull: boolean;
  hasPendingFull?: boolean;
  pendingCount: number;
  limit?: number;
}): TerminalFrameBacklogAction {
  // A Full frame is an authoritative recovery point. Accept it even during the
  // brief native-focus/WebKit-focus ordering gap, and even if the queue is
  // already at its limit. Dropping that one seed can leave the frontend waiting
  // forever because the backend already considers the app foregrounded.
  if (options.isFull) return 'accept_full';
  if (options.awaitingFull) return 'drop';
  if (!options.pageActive) {
    return options.hasPendingFull ? 'resync_preserve_full' : 'resync';
  }
  const limit = Math.max(1, options.limit ?? MAX_PENDING_TERMINAL_FRAMES);
  if (options.pendingCount >= limit) {
    // Never throw away a recovery seed that is already scheduled to paint. Keep
    // it as a safe baseline while requesting a newer Full frame, and drop diffs
    // until that newer seed arrives.
    return options.hasPendingFull ? 'resync_preserve_full' : 'resync';
  }
  return 'enqueue';
}
