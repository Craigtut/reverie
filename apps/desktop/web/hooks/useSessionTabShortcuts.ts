import { useEffect, useRef } from 'react';

import type { ShellSession } from '../domain';

interface SessionTabShortcutOptions {
  // Only active on the terminal stage; off while a dialog/composer/palette owns
  // the keyboard.
  enabled: boolean;
  sessions: ShellSession[];
  selectedSessionId: string | null;
  onSelect: (session: ShellSession) => void;
}

// Keyboard switching for the session tabs, so a focus full of tabs never needs a
// pointer (or a horizontal-scroll mouse) to traverse:
//   Cmd+1..8  jump to that tab,  Cmd+9 jumps to the last (Safari/browser muscle memory)
//   Ctrl+Tab / Ctrl+Shift+Tab  cycle to the next / previous tab, wrapping around
// Registered in the capture phase so it runs before the terminal canvas can claim
// the keystroke, and only stops propagation for the combos it actually handles.
export function useSessionTabShortcuts(options: SessionTabShortcutOptions) {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    function handleKey(event: globalThis.KeyboardEvent) {
      const { enabled, sessions, selectedSessionId, onSelect } = latest.current;
      if (!enabled || sessions.length === 0) return;

      if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (event.key >= '1' && event.key <= '9') {
          const slot = Number(event.key);
          const target = slot === 9 ? sessions[sessions.length - 1] : sessions[slot - 1];
          if (!target) return;
          event.preventDefault();
          event.stopPropagation();
          onSelect(target);
        }
        return;
      }

      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        const current = sessions.findIndex(session => session.id === selectedSessionId);
        const from = current === -1 ? 0 : current;
        const delta = event.shiftKey ? -1 : 1;
        const next = sessions[(from + delta + sessions.length) % sessions.length];
        if (next) onSelect(next);
      }
    }

    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, []);
}
