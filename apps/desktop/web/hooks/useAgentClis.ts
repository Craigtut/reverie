import { useCallback, useState } from 'react';
import { useEffect } from 'react';

import { errorMessage, fallbackAgentCliDetections } from '../domain';
import type { AgentKind, CreateSessionRecordRequest } from '../domain';
import { listAgentClis, setAgentCliEnabled } from '../services/shellApi';
import { useShellStore } from '../store';

// Detects the installed agent CLIs into the shell store on mount and whenever
// the default agent changes, nudging the default to a detected one if the
// current pick is unavailable. Falls back to the fixture set if detection
// fails (e.g. the browser harness).
export function useAgentClis(
  newSessionAgentKind: CreateSessionRecordRequest['agentKind'],
  setNewSessionAgentKind: (value: CreateSessionRecordRequest['agentKind']) => void,
  writeLog: (line: string) => void,
) {
  const setAgentCliDetections = useShellStore(s => s.setAgentCliDetections);

  useEffect(() => {
    listAgentClis()
      .then(detections => {
        setAgentCliDetections(detections);
        // A CLI is only a valid default when it is both detected and switched
        // on. If the current pick fails either test, fall back to the first
        // usable one.
        const usable = (detection: (typeof detections)[number]) =>
          detection.available && detection.enabled;
        const firstUsable = detections.find(usable);
        if (
          firstUsable &&
          !detections.some(detection => detection.kind === newSessionAgentKind && usable(detection))
        ) {
          setNewSessionAgentKind(firstUsable.kind);
        }
      })
      .catch(error => {
        setAgentCliDetections(fallbackAgentCliDetections());
        writeLog(`CLI detection failed; using fixture choices: ${errorMessage(error)}`);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-detect only when the default agent changes (matches original behavior); setters are stable.
  }, [newSessionAgentKind]);
}

// Toggle a single CLI on or off from settings. Writes the refreshed detection
// list straight into the shell store so every consumer (creation composer,
// default-agent picker, bridge rows) re-renders from one source of truth.
// `onAfterToggle` lets the caller refresh dependent state, e.g. bridge status,
// which the backend tears down when a CLI is disabled.
export function useAgentCliEnablement(onAfterToggle?: () => void) {
  const setAgentCliDetections = useShellStore(s => s.setAgentCliDetections);
  const [pending, setPending] = useState<AgentKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback(
    async (kind: AgentKind, enabled: boolean) => {
      setPending(kind);
      setError(null);
      try {
        const next = await setAgentCliEnabled(kind, enabled);
        setAgentCliDetections(next);
        onAfterToggle?.();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setPending(null);
      }
    },
    [setAgentCliDetections, onAfterToggle],
  );

  return { toggle, pending, error };
}
