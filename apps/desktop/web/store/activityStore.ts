import { create } from 'zustand';

import type { ActivityState } from '../domain';
import { resolveSetStateAction, type SetStateAction } from './setter';

// Live agent activity, keyed by native session id. Fed by the
// `session_activity_changed` event stream (and seeded from persisted
// per-session latestActivity on load). The setter supports the functional
// form so callers can merge updates: setCortexActivity(curr => ({ ...curr }))

interface ActivityStoreState {
  cortexActivity: Record<string, ActivityState>;
  setCortexActivity: (action: SetStateAction<Record<string, ActivityState>>) => void;
}

export const useActivityStore = create<ActivityStoreState>((set) => ({
  cortexActivity: {},
  setCortexActivity: (action) => set((s) => ({ cortexActivity: resolveSetStateAction(action, s.cortexActivity) })),
}));
