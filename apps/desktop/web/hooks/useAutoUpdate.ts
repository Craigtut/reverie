import { useEffect } from 'react';

import { errorMessage } from '../domain';
import { invoke } from '../services/runtime';
import {
  checkForUpdate,
  downloadPendingUpdate,
  fetchUpdaterStatus,
  installPendingUpdate,
  relaunchNow,
} from '../services/updateApi';
import { useOverlayStore, useUpdateStore } from '../store';
import { collectBusySessions } from './busyGuard';

// How long after boot the first auto-check runs, and the steady-state re-check
// interval. The first check waits for the workspace to seed so it never competes
// with cold start; updates are never urgent.
const FIRST_CHECK_DELAY_MS = 8_000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000; // 6 hours

// Drive a check -> (auto)download cycle. `manual` adds user-facing feedback (the
// "up to date" / "check failed" toasts) that the silent background checks omit.
export async function runUpdateCheck(opts?: { manual?: boolean }): Promise<void> {
  const store = useUpdateStore.getState();
  if (!store.enabled) return;
  if (store.phase === 'checking' || store.phase === 'downloading') return;

  store.setChecking();
  try {
    const result = await checkForUpdate();
    if (result.kind !== 'update') {
      useUpdateStore.getState().setUpToDate();
      if (opts?.manual) {
        useOverlayStore.getState().pushToast({ message: 'Reverie is up to date.' });
      }
      return;
    }
    useUpdateStore.getState().setFound({ version: result.version, notes: result.notes });
    if (useUpdateStore.getState().autoDownload) {
      await downloadStagedUpdate();
    }
  } catch (error) {
    useUpdateStore.getState().setError(errorMessage(error));
    if (opts?.manual) {
      useOverlayStore.getState().pushToast({ message: 'Could not check for updates.' });
    }
  }
}

// Download the staged update and, once ready, surface the informational toast.
// The toast only informs; the persistent sidebar affordance is the place to act.
async function downloadStagedUpdate(): Promise<void> {
  useUpdateStore.getState().setDownloading();
  try {
    await downloadPendingUpdate(fraction =>
      useUpdateStore.getState().setDownloadProgress(fraction),
    );
    useUpdateStore.getState().setReady();
    const version = useUpdateStore.getState().availableVersion;
    useOverlayStore.getState().pushToast({
      message: version
        ? `Reverie ${version} is ready. It installs when you quit, or relaunch now from the sidebar.`
        : 'An update is ready. It installs when you quit, or relaunch now from the sidebar.',
      durationMs: 10_000,
    });
  } catch (error) {
    useUpdateStore.getState().setError(errorMessage(error));
  }
}

// The explicit "Relaunch to update" action. Ensures the bundle is downloaded,
// installs it, then routes the relaunch through the same in-flight-work gate the
// quit flow uses so live agent sessions are never torn down without consent.
export async function relaunchToUpdate(): Promise<void> {
  const store = useUpdateStore.getState();
  if (!store.enabled) return;

  if (store.phase === 'available') {
    await downloadStagedUpdate();
  }
  if (useUpdateStore.getState().phase !== 'ready') return; // still downloading, or it failed

  const proceed = async () => {
    try {
      // Swap the bundle first: if this fails, sessions are untouched.
      await installPendingUpdate();
      // Stop sessions gracefully + flag shutdown so restart() is not re-deferred.
      await invoke('prepare_update_relaunch');
      await relaunchNow();
    } catch (error) {
      useUpdateStore.getState().setError(errorMessage(error));
      useOverlayStore.getState().pushToast({ message: 'The update could not be installed.' });
    }
  };

  const busy = collectBusySessions();
  if (busy.length === 0) {
    await proceed();
    return;
  }

  useOverlayStore.getState().requestConfirm({
    title:
      busy.length === 1 ? `“${busy[0].title}” is still working` : 'Some agents are still working',
    body: 'Relaunching to update will stop them. Your conversations are saved, so you can pick up where you left off, but anything in progress right now won’t finish.',
    confirmLabel: 'Relaunch and stop agents',
    cancelLabel: 'Not now',
    danger: true,
    onConfirm: () => void proceed(),
  });
}

// Lifecycle: learn the build's update environment, then (production channel
// only) run a delayed first check and a periodic re-check while the app runs.
// Mounted once at the shell root. A no-op in the browser harness and dev channel
// because `fetchUpdaterStatus` reports `enabled: false` there.
export function useAutoUpdate() {
  useEffect(() => {
    let cancelled = false;
    let firstCheckTimer: number | undefined;
    let recheckTimer: number | undefined;

    void (async () => {
      const status = await fetchUpdaterStatus();
      if (cancelled) return;
      useUpdateStore
        .getState()
        .setEnvironment({ enabled: status.enabled, currentVersion: status.version });
      if (!status.enabled) return;

      firstCheckTimer = window.setTimeout(() => {
        if (useUpdateStore.getState().autoCheck) void runUpdateCheck();
      }, FIRST_CHECK_DELAY_MS);

      recheckTimer = window.setInterval(() => {
        if (useUpdateStore.getState().autoCheck) void runUpdateCheck();
      }, RECHECK_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(firstCheckTimer);
      window.clearInterval(recheckTimer);
    };
  }, []);
}
