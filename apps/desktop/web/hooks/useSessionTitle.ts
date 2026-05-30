import { useEffect } from 'react';

import { listen } from '../services/runtime';
import { useShellStore } from '../store/shellStore';

interface TitleChangedPayload {
  sessionId?: string;
  terminalId?: number;
  title?: string;
}

/**
 * Subscribe to live session-title updates. Agent CLIs set their terminal title
 * via OSC sequences as they work; the Rust runtime normalizes those per CLI and
 * emits `terminal_title_changed`. We patch the matching session's label in place
 * so every display site (sidebar, tabs, dashboard) re-renders without refetching
 * the workspace snapshot. App-lifetime, like `useSessionActivity`.
 */
export function useSessionTitle(writeLog?: (message: string) => void) {
  const patchSessionTitle = useShellStore(state => state.patchSessionTitle);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const attach = async () => {
      try {
        unlisten = await listen<TitleChangedPayload>('terminal_title_changed', event => {
          const { sessionId, title } = event.payload;
          if (!sessionId || !title) return;
          if (disposed) return;
          patchSessionTitle(sessionId, title);
          writeLog?.(`title:${sessionId}:${title}`);
        });
      } catch {
        // Browser/harness without the Tauri event bus: no live titles.
      }
    };

    void attach();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [patchSessionTitle, writeLog]);
}
