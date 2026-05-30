import { create } from 'zustand';

import type { ActivityState } from '../domain';
import { preserveStoreAcrossHmr } from './hmr';
import { resolveSetStateAction, type SetStateAction } from './setter';

// Live agent activity, keyed by native session id. Fed by the
// `session_activity_changed` event stream (and seeded from persisted
// per-session latestActivity on load). The setter supports the functional
// form so callers can merge updates: setCortexActivity(curr => ({ ...curr }))

interface ActivityStoreState {
  cortexActivity: Record<string, ActivityState>;
  setCortexActivity: (action: SetStateAction<Record<string, ActivityState>>) => void;
}

export const useActivityStore = create<ActivityStoreState>(set => ({
  cortexActivity: {},
  setCortexActivity: action =>
    set(s => ({ cortexActivity: resolveSetStateAction(action, s.cortexActivity) })),
}));

// Preserve live agent activity across HMR so the dashboard does not blank its
// per-session status between event ticks while an edit reloads. See store/hmr.ts.
preserveStoreAcrossHmr(useActivityStore, import.meta.hot, s => ({
  cortexActivity: s.cortexActivity,
}));
