import { useEffect } from 'react';

import { useSpeechEngineStore } from '../store';
import {
  onSpeechEngineState,
  speechEngineStatus,
  speechMicPermissionStatus,
} from '../services/speechApi';

// App-global subscription that keeps the speech engine store in sync: seeds the
// current engine state + mic permission on mount, then follows the
// `speech_engine_state` event. Mount once near the app root (alongside
// useGitStatus) so future voice surfaces can read live readiness from the store
// without each owning a subscription.
export function useSpeechEngine(): void {
  const setEngine = useSpeechEngineStore(s => s.setEngine);
  const setMicPermission = useSpeechEngineStore(s => s.setMicPermission);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const state = await speechEngineStatus();
        if (active) setEngine(state);
      } catch {
        // Browser harness / non-desktop: leave the default Unavailable state.
      }
      try {
        const permission = await speechMicPermissionStatus();
        if (active) setMicPermission(permission);
      } catch {
        // Ignore; permission stays undetermined.
      }
      try {
        const off = await onSpeechEngineState(state => setEngine(state));
        if (active) unlisten = off;
        else off();
      } catch {
        // No event bus in the harness.
      }
    })();

    return () => {
      active = false;
      unlisten?.();
    };
  }, [setEngine, setMicPermission]);
}
