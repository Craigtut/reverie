import { useEffect } from 'react';

import { appRuntimeMode } from '../services/runtime';
import { recordWebviewHeartbeat } from '../services/shellApi';

const HEARTBEAT_INTERVAL_MS = 3000;

// Native liveness signal for the main WKWebView. Rust watches this timestamp on
// app focus/resume; if the window comes back but JavaScript does not, it reloads
// the webview instead of leaving the user with a dead native shell.
export function useWebviewHeartbeat() {
  useEffect(() => {
    if (appRuntimeMode() !== 'tauri') return;

    let stopped = false;
    let inFlight = false;
    let interval: number | null = null;

    const isVisible = () => document.visibilityState !== 'hidden';

    const beat = () => {
      if (stopped || inFlight || !isVisible()) return;
      inFlight = true;
      void recordWebviewHeartbeat()
        .catch(() => {
          /* A failed heartbeat is itself the signal native recovery needs. */
        })
        .finally(() => {
          inFlight = false;
        });
    };

    const stop = () => {
      if (interval === null) return;
      window.clearInterval(interval);
      interval = null;
    };

    const start = () => {
      if (stopped || interval !== null || !isVisible()) return;
      beat();
      interval = window.setInterval(beat, HEARTBEAT_INTERVAL_MS);
    };

    const handleVisibilityChange = () => {
      if (isVisible()) {
        start();
      } else {
        stop();
      }
    };

    start();
    window.addEventListener('focus', start);
    window.addEventListener('pageshow', start);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopped = true;
      stop();
      window.removeEventListener('focus', start);
      window.removeEventListener('pageshow', start);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);
}
