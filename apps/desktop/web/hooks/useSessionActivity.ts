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
export function useSessionActivity(writeLog: (line: string) => void, reloadShell: () => void) {
  const sessions = useShellStore(s => s.shell.sessions);
  const setCortexActivity = useActivityStore(s => s.setCortexActivity);

  // Keep the latest logger reachable without resubscribing the event stream.
  const writeLogRef = useRef(writeLog);
  writeLogRef.current = writeLog;
  const reloadShellRef = useRef(reloadShell);
  reloadShellRef.current = reloadShell;

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
        if (!cancelled)
          writeLogRef.current(`Activity event bus unavailable: ${errorMessage(error)}`);
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setCortexActivity]);

  // When the backend captures a CLI's native session id for the first time, the
  // session record only then gains the `nativeSessionRef` this feed binds
  // activity against (and the session becomes resumable). Refetch the snapshot
  // so the seeding effect above can bind the now-live session; without this the
  // dashboard would not show it as live until some unrelated refresh happened.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    // Coalesce bursts: several sessions launched at once each capture their
    // native id on their first hook, so the event can arrive N times in a tick.
    // One refetch reflects all of them, so collapse a burst into a single
    // reload instead of firing N redundant snapshot reads.
    let pending: ReturnType<typeof setTimeout> | null = null;
    void (async () => {
      try {
        const fn = await listen('session_record_changed', () => {
          if (cancelled || pending) return;
          pending = setTimeout(() => {
            pending = null;
            if (!cancelled) reloadShellRef.current();
          }, 50);
        });
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      } catch {
        // The browser harness has no Tauri event bus; quietly skip.
      }
    })();
    return () => {
      cancelled = true;
      if (pending) clearTimeout(pending);
      unlisten?.();
    };
  }, []);
}
