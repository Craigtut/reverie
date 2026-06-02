import { useEffect } from 'react';

import { activityForSession, lastTurnCompletedAtMs } from '../domain';
import { markSessionViewed as persistSessionViewed } from '../services/shellApi';
import { useActivityStore, useNavigationStore, useShellStore } from '../store';

// Clears the "finished" / unseen marker for the session the user is viewing.
//
// A session is `finished` when it came to rest (turn done / paused for input)
// off-screen and you have not opened it since (lastTurnCompletedAt >
// session.lastViewedAt). This hook owns the one event that marks a session seen:
// while you are viewing a session's terminal, if it has an unseen completion,
// stamp lastViewedAt = now (optimistically in the store for an instant clear,
// and persisted via the backend so it survives relaunch).
//
// That single rule covers both moments the ticket calls out:
//   - it finishes while you are watching  -> stamped at completion, so it never
//     raises a "come look" marker once you navigate away, and
//   - you open a session that already finished -> stamped on view, so it clears.
// Sessions with no completion are never stamped, and "viewing" means the terminal
// surface specifically: on the dashboard or focus view nothing is being viewed,
// so a result that lands there still surfaces as finished.
export function useSessionViewed() {
  const viewedSessionId = useNavigationStore(s =>
    s.surfaceMode === 'terminal' ? s.selectedSessionId : null,
  );
  const sessions = useShellStore(s => s.shell.sessions);
  const cortexActivity = useActivityStore(s => s.cortexActivity);
  const markViewed = useShellStore(s => s.markSessionViewed);

  const viewed = viewedSessionId
    ? (sessions.find(session => session.id === viewedSessionId) ?? null)
    : null;
  const activity = viewed ? activityForSession(viewed, cortexActivity) : null;
  const completedMs = lastTurnCompletedAtMs(activity);
  const seenMs = viewed?.lastViewedAt ? Date.parse(viewed.lastViewedAt) : 0;

  useEffect(() => {
    if (!viewed || completedMs == null) return;
    if (completedMs <= (Number.isNaN(seenMs) ? 0 : seenMs)) return;
    const nowIso = new Date().toISOString();
    markViewed(viewed.id, nowIso); // instant, optimistic
    void persistSessionViewed(viewed.id, nowIso).catch(() => {
      // The browser harness has no backend; the optimistic update still holds
      // for this session, and the value re-derives correctly on next real load.
    });
    // Re-runs when the viewed session changes or it reaches a newer completion;
    // after stamping, seenMs advances past completedMs so it will not re-fire.
  }, [viewed, completedMs, seenMs, markViewed]);
}
