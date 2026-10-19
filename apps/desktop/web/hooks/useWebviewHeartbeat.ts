import { useEffect } from 'react';

import { appRuntimeMode } from '../services/runtime';
import { recordWebviewHeartbeat } from '../services/shellApi';

const HEARTBEAT_INTERVAL_MS = 3000;
// A beat whose invoke never settles must not stop the heartbeat for good. Past
// this, the next tick sends a fresh beat and counts the stuck one as lost.
const HEARTBEAT_STALL_MS = 10_000;

// What native recovery reads (through its page probe) to tell a stuck heartbeat
// from a stuck page. Ages are relative to the probe, so clocks never mix.
interface HeartbeatSnapshot {
  sent: number;
  acked: number;
  failed: number;
  stalled: number;
  sinceLastSentMs: number | null;
  sinceLastAckMs: number | null;
  inFlightForMs: number | null;
}

declare global {
  interface Window {
    __reverieHeartbeat?: { snapshot(): HeartbeatSnapshot };
  }
}

// Native liveness signal for the main WKWebView. Rust watches this timestamp on
// app focus/resume; if the window comes back but JavaScript does not, it probes
// the page and recovers it instead of leaving the user with a dead native shell.
export function useWebviewHeartbeat() {
  useEffect(() => {
    if (appRuntimeMode() !== 'tauri') return;

    let stopped = false;
    let inFlightSince: number | null = null;
    let interval: number | null = null;
    const stats = { sent: 0, acked: 0, failed: 0, stalled: 0 };
    let lastSentAt: number | null = null;
    let lastAckAt: number | null = null;

    const isVisible = () => document.visibilityState !== 'hidden';

    const beat = () => {
      if (stopped || !isVisible()) return;
      const now = performance.now();
      if (inFlightSince !== null) {
        if (now - inFlightSince < HEARTBEAT_STALL_MS) return;
        stats.stalled += 1;
      }
      const startedAt = now;
      inFlightSince = startedAt;
      lastSentAt = startedAt;
      stats.sent += 1;
      void recordWebviewHeartbeat()
        .then(
          () => {
            stats.acked += 1;
            lastAckAt = performance.now();
          },
          () => {
            /* A failed heartbeat is itself the signal native recovery needs. */
            stats.failed += 1;
          },
        )
        .finally(() => {
          // A stalled beat that settles late must not clear a newer one.
          if (inFlightSince === startedAt) inFlightSince = null;
        });
    };

    const stop = () => {
      if (interval === null) return;
      window.clearInterval(interval);
      interval = null;
    };

    const start = () => {
      if (stopped || !isVisible()) return;
      // A focus event is a native recovery handshake. Send it even when the
      // repeating interval already exists because WebKit may have throttled
      // that interval without changing Page Visibility while the app was away.
      beat();
      if (interval === null) interval = window.setInterval(beat, HEARTBEAT_INTERVAL_MS);
    };

    const handleVisibilityChange = () => {
      if (isVisible()) {
        start();
      } else {
        stop();
      }
    };

    const ageOf = (at: number | null, now: number) => (at === null ? null : Math.round(now - at));
    window.__reverieHeartbeat = {
      snapshot() {
        const now = performance.now();
        return {
          ...stats,
          sinceLastSentMs: ageOf(lastSentAt, now),
          sinceLastAckMs: ageOf(lastAckAt, now),
          inFlightForMs: ageOf(inFlightSince, now),
        };
      },
    };

    start();
    window.addEventListener('focus', start);
    window.addEventListener('pageshow', start);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopped = true;
      stop();
      delete window.__reverieHeartbeat;
      window.removeEventListener('focus', start);
      window.removeEventListener('pageshow', start);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);
}
