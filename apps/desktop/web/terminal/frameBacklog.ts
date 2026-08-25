// WKWebView can suspend requestAnimationFrame while native Channel messages
// continue to queue. Keep only a tiny paint backlog. Once it grows past this
// bound, partial frames are no longer safe to coalesce, so the frontend asks the
// authoritative Rust terminal for one fresh Full seed.
export const MAX_PENDING_TERMINAL_FRAMES = 8;

export type TerminalFrameBacklogAction = 'enqueue' | 'accept_full' | 'drop' | 'resync';

export function terminalFrameBacklogAction(options: {
  pageActive: boolean;
  awaitingFull: boolean;
  isFull: boolean;
  pendingCount: number;
  limit?: number;
}): TerminalFrameBacklogAction {
  if (!options.pageActive) return 'resync';
  if (options.awaitingFull) return options.isFull ? 'accept_full' : 'drop';
  const limit = Math.max(1, options.limit ?? MAX_PENDING_TERMINAL_FRAMES);
  if (options.pendingCount >= limit) return 'resync';
  return 'enqueue';
}
