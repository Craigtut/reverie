import { create } from 'zustand';

import type { EngineState, MicPermission } from '../domain';
import { preserveStoreAcrossHmr } from './hmr';

// Live state of the on-device speech engine, fed by the `speech_engine_state`
// event (see hooks/useSpeechEngine). Kept out of the shell store so engine churn
// (provisioning -> ready) never re-renders the workspace tree. Future voice
// features read engine readiness and mic permission from here.

interface SpeechEngineStore {
  engine: EngineState;
  micPermission: MicPermission;
  setEngine: (engine: EngineState) => void;
  setMicPermission: (permission: MicPermission) => void;
}

export const useSpeechEngineStore = create<SpeechEngineStore>(set => ({
  // Default until the backend reports in. Unavailable is the safe assumption (the
  // browser harness and non-Apple-Silicon builds never leave it).
  engine: { kind: 'unavailable', reason: 'speech engine not yet reported' },
  micPermission: 'undetermined',
  setEngine: engine => set({ engine }),
  setMicPermission: micPermission => set({ micPermission }),
}));

preserveStoreAcrossHmr(useSpeechEngineStore, import.meta.hot, s => ({
  engine: s.engine,
  micPermission: s.micPermission,
}));
