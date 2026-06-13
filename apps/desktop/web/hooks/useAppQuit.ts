import { useEffect, useRef } from 'react';

import { activityForSession, errorMessage } from '../domain';
import type { ShellSession } from '../domain';
import { listen, type UnlistenFn } from '../services/runtime';
import { confirmQuit } from '../services/terminalApi';
import { hasPendingUpdate, installPendingUpdate } from '../services/updateApi';
import { useActivityStore, useOverlayStore, useUpdateStore } from '../store';
import { collectBusySessions } from './busyGuard';

// Bridges the deferred app-quit (window close button / Cmd-Q) to a humane
// confirmation. The Rust side prevents the default the first time and emits
// `app_quit_requested`; here we check for in-flight agent work and either ask
// the user to confirm or finalize the quit immediately via `confirm_quit`
// (which gracefully stops every session's process tree and exits). Reverie
// keeps idle sessions alive, so quitting is the one moment we stop them; we only
// interrupt the user when an agent is mid-work or waiting on a decision.
export function useAppQuit(writeLog: (line: string) => void) {
  // Keep the latest logger reachable without resubscribing the event listener.
  const writeLogRef = useRef(writeLog);
  writeLogRef.current = writeLog;

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    const finalizeQuit = () => {
      void (async () => {
        // Install-on-quit: if a downloaded update is staged, apply it during the
        // normal shutdown (best effort) so the next launch is already updated.
        // The user never has to relaunch explicitly to get the new version.
        if (useUpdateStore.getState().phase === 'ready' && hasPendingUpdate()) {
          try {
            await installPendingUpdate();
          } catch (error) {
            writeLogRef.current(`Update install on quit failed: ${errorMessage(error)}`);
          }
        }
        await confirmQuit().catch(error =>
          writeLogRef.current(`Quit failed: ${errorMessage(error)}`),
        );
      })();
    };

    void (async () => {
      try {
        const fn = await listen('app_quit_requested', () => {
          if (cancelled) return;
          const cortexActivity = useActivityStore.getState().cortexActivity;
          const busy = collectBusySessions();

          if (busy.length === 0) {
            finalizeQuit();
            return;
          }

          const { title, body } = quitConfirmCopy(busy, cortexActivity);
          useOverlayStore.getState().requestConfirm({
            title,
            body,
            confirmLabel: 'Quit and stop agents',
            cancelLabel: 'Keep Reverie open',
            danger: true,
            onConfirm: finalizeQuit,
          });
        });
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      } catch {
        // The browser harness has no Tauri event bus; nothing to quit.
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}

function quitConfirmCopy(
  busy: ShellSession[],
  cortexActivity: Parameters<typeof activityForSession>[1],
): { title: string; body: string } {
  if (busy.length === 1) {
    const only = busy[0];
    const status = activityForSession(only, cortexActivity)?.status;
    if (status === 'awaiting_permission' || status === 'awaiting_response') {
      return {
        title: `“${only.title}” is waiting for you`,
        body: 'If you quit now it stops without finishing. You can resume the conversation later.',
      };
    }
    return {
      title: `“${only.title}” is still working`,
      body: 'Quitting now will stop it. The conversation is saved and you can resume it later, but the current step won’t finish.',
    };
  }
  return {
    title: 'Some agents are still working',
    body: 'Quitting Reverie will stop them. Your conversations are saved, so you can pick up where you left off, but anything in progress right now won’t finish.',
  };
}
