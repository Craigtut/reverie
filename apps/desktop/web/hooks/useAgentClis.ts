import { useEffect } from 'react';

import { errorMessage, fallbackAgentCliDetections } from '../domain';
import type { CreateSessionRecordRequest } from '../domain';
import { listAgentClis } from '../services/shellApi';
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
        const firstAvailable = detections.find(detection => detection.available);
        if (firstAvailable && !detections.some(detection => detection.kind === newSessionAgentKind && detection.available)) {
          setNewSessionAgentKind(firstAvailable.kind);
        }
      })
      .catch(error => {
        setAgentCliDetections(fallbackAgentCliDetections());
        writeLog(`CLI detection failed; using fixture choices: ${errorMessage(error)}`);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-detect only when the default agent changes (matches original behavior); setters are stable.
  }, [newSessionAgentKind]);
}
