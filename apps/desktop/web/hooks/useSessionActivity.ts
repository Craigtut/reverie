import { useEffect, useRef } from 'react';

import { errorMessage } from '../domain';
import type { SessionActivityEventPayload } from '../domain';
import { listen, type UnlistenFn } from '../services/runtime';
import { useActivityStore, useShellStore } from '../store';

// Owns the dashboard's live agent-activity feed:
//  - seeds activity from each session's persisted latestActivity whenever the
//    shell snapshot changes (covers the gap before the first live event, and
//    surfaces last-known state when Reverie restarts), and
//  - subscribes to the `session_activity_changed` event stream for the app's
//    lifetime, applying sequence-ordered updates and removals.
export function useSessionActivity(writeLog: (line: string) => void) {
  const sessions = useShellStore(s => s.shell.sessions);
  const setCortexActivity = useActivityStore(s => s.setCortexActivity);

  // Keep the latest logger reachable without resubscribing the event stream.
  const writeLogRef = useRef(writeLog);
  writeLogRef.current = writeLog;

  useEffect(() => {
    setCortexActivity(current => {
      let next = current;
      let dirty = false;
      for (const session of sessions) {
        const cortexId = session.nativeSessionRef?.sessionId;
        if (!cortexId || !session.latestActivity) continue;
        const existing = next[cortexId];
        if (existing && existing.sequence >= session.latestActivity.sequence) continue;
        if (!dirty) {
          next = { ...current };
          dirty = true;
        }
        next[cortexId] = session.latestActivity;
      }
      return dirty ? next : current;
    });
  }, [sessions, setCortexActivity]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    void (async () => {
      try {
        const fn = await listen<SessionActivityEventPayload>('session_activity_changed', event => {
          if (cancelled) return;
          const message = event.payload;
          if (message.kind === 'updated') {
            const { nativeSessionId, state } = message.payload;
            setCortexActivity(current => {
              // Drop strictly-older updates by sequence so events that race
              // across threads can't roll us backwards.
              const prior = current[nativeSessionId];
              if (prior && prior.sequence > state.sequence) return current;
              return { ...current, [nativeSessionId]: state };
            });
          } else {
            const { nativeSessionId } = message.payload;
            setCortexActivity(current => {
              if (!(nativeSessionId in current)) return current;
              const next = { ...current };
              delete next[nativeSessionId];
              return next;
            });
          }
        });
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      } catch (error) {
        // The browser harness has no Tauri event bus; quietly skip.
        if (!cancelled) writeLogRef.current(`Activity event bus unavailable: ${errorMessage(error)}`);
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setCortexActivity]);
}
