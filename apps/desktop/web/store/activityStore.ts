import { create } from 'zustand';

import { activitySupersedes } from '../domain';
import type { ActivityState, SessionActivityEventPayload, SessionStateTimeline } from '../domain';
import { preserveStoreAcrossHmr } from './hmr';
import { resolveSetStateAction, type SetStateAction } from './setter';

// Live agent activity, keyed by native session id. Fed by the
// `session_activity_changed` event stream (and seeded from persisted
// per-session latestActivity on load). The setter supports the functional
// form so callers can merge updates: setCortexActivity(curr => ({ ...curr }))
//
// `sessionTimelines` rides the same event: each update carries the session's
// current SessionStateTimeline so the dashboards can reorder a status group by
// transition recency without waiting for a snapshot refetch. Kept separate from
// the shell store's session records (like cortexActivity) so per-tick timeline
// churn never replaces the sessions array and re-renders the whole tree.

interface ActivityStoreState {
  applyActivityEvent: (event: SessionActivityEventPayload) => void;
  cortexActivity: Record<string, ActivityState>;
  setCortexActivity: (action: SetStateAction<Record<string, ActivityState>>) => void;
  sessionTimelines: Record<string, SessionStateTimeline>;
  setSessionTimelines: (action: SetStateAction<Record<string, SessionStateTimeline>>) => void;
}

export const useActivityStore = create<ActivityStoreState>(set => ({
  applyActivityEvent: event =>
    set(current => {
      const { nativeSessionId } = event.payload;
      if (event.kind === 'updated') {
        const { state, stateTimeline } = event.payload;
        const previous = current.cortexActivity[nativeSessionId];
        if (previous && !activitySupersedes(state, previous)) return current;
        return {
          cortexActivity: { ...current.cortexActivity, [nativeSessionId]: state },
          sessionTimelines: stateTimeline
            ? { ...current.sessionTimelines, [nativeSessionId]: stateTimeline }
            : current.sessionTimelines,
        };
      }
      const cortexActivity = { ...current.cortexActivity };
      const sessionTimelines = { ...current.sessionTimelines };
      delete cortexActivity[nativeSessionId];
      delete sessionTimelines[nativeSessionId];
      return { cortexActivity, sessionTimelines };
    }),
  cortexActivity: {},
  setCortexActivity: action =>
    set(s => ({ cortexActivity: resolveSetStateAction(action, s.cortexActivity) })),
  sessionTimelines: {},
  setSessionTimelines: action =>
    set(s => ({ sessionTimelines: resolveSetStateAction(action, s.sessionTimelines) })),
}));

// Preserve live agent activity across HMR so the dashboard does not blank its
// per-session status between event ticks while an edit reloads. See store/hmr.ts.
preserveStoreAcrossHmr(useActivityStore, import.meta.hot, s => ({
  cortexActivity: s.cortexActivity,
  sessionTimelines: s.sessionTimelines,
}));
