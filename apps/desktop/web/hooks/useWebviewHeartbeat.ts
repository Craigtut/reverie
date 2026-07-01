import { useEffect } from 'react';

import { appRuntimeMode } from '../services/runtime';
import { recordWebviewHeartbeat } from '../services/shellApi';

const HEARTBEAT_INTERVAL_MS = 1000;

// Native liveness signal for the main WKWebView. Rust watches this timestamp on
// app focus/resume; if the window comes back but JavaScript does not, it reloads
// the webview instead of leaving the user with a dead native shell.
export function useWebviewHeartbeat() {
  useEffect(() => {
    if (appRuntimeMode() !== 'tauri') return;

    let stopped = false;
    let inFlight = false;

    const beat = () => {
      if (stopped || inFlight) return;
      inFlight = true;
      void recordWebviewHeartbeat()
        .catch(() => {
          /* A failed heartbeat is itself the signal native recovery needs. */
        })
        .finally(() => {
          inFlight = false;
        });
    };
    const beatWhenVisible = () => {
      if (document.visibilityState === 'hidden') return;
      beat();
    };

    beat();
    const interval = window.setInterval(beat, HEARTBEAT_INTERVAL_MS);
    window.addEventListener('focus', beat);
    window.addEventListener('pageshow', beat);
    document.addEventListener('visibilitychange', beatWhenVisible);

    return () => {
      stopped = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', beat);
      window.removeEventListener('pageshow', beat);
      document.removeEventListener('visibilitychange', beatWhenVisible);
    };
  }, []);
}
