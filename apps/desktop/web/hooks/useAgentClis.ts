import { useCallback, useState } from 'react';
import { useEffect } from 'react';

import { errorMessage, fallbackAgentCliDetections } from '../domain';
import type { AgentCliDetection, AgentKind, CreateSessionRecordRequest } from '../domain';
import { listAgentClis, setAgentCliEnabled } from '../services/shellApi';
import { useShellStore } from '../store';

// A CLI is a valid agent only when it is both detected on the machine and
// switched on in settings. The detection list arrives in the backend's agent
// priority order (Claude Code, then Codex, then Cortex, then any later
// additions), so the first usable entry is the highest-priority fallback.
const isUsable = (detection: AgentCliDetection) => detection.available && detection.enabled;

// Detects the installed agent CLIs into the shell store on mount and whenever
// the composer pick changes, nudging that pick to a usable CLI when it is not.
// Separately keeps the persisted workspace default off any CLI that is switched
// off or missing. Falls back to the fixture set if detection fails (e.g. the
// browser harness).
export function useAgentClis(
  newSessionAgentKind: CreateSessionRecordRequest['agentKind'],
  setNewSessionAgentKind: (value: CreateSessionRecordRequest['agentKind']) => void,
  defaultAgentKind: AgentKind,
  setDefaultAgentKind: (value: AgentKind) => void,
  writeLog: (line: string) => void,
) {
  const setAgentCliDetections = useShellStore(s => s.setAgentCliDetections);
  const detections = useShellStore(s => s.agentCliDetections);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-detect only when the composer pick changes (matches original behavior); setters are stable.
  useEffect(() => {
    listAgentClis()
      .then(result => {
        setAgentCliDetections(result);
        // If the live composer pick is no longer usable, fall back to the
        // highest-priority usable CLI.
        const firstUsable = result.find(isUsable);
        if (
          firstUsable &&
          !result.some(detection => detection.kind === newSessionAgentKind && isUsable(detection))
        ) {
          setNewSessionAgentKind(firstUsable.kind);
        }
      })
      .catch(error => {
        setAgentCliDetections(fallbackAgentCliDetections());
        writeLog(`CLI detection failed; using fixture choices: ${errorMessage(error)}`);
      });
  }, [newSessionAgentKind]);

  // Keep the persisted workspace default (what Settings shows and new sessions
  // seed from) pointing at a usable CLI. Reacts to the detection store, so
  // switching off the default CLI in Settings, or a default that is no longer
  // installed, re-points it to the next usable CLI in priority order instead of
  // leaving it stuck on a disabled/missing agent. We leave an existing usable
  // default alone, so a user's explicit choice survives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-point only when detections or the saved default change; the persist setter is recreated each render and is intentionally not a trigger.
  useEffect(() => {
    if (detections.length === 0) return;
    if (detections.some(detection => detection.kind === defaultAgentKind && isUsable(detection))) {
      return;
    }
    const firstUsable = detections.find(isUsable);
    if (firstUsable) setDefaultAgentKind(firstUsable.kind);
  }, [detections, defaultAgentKind]);
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
