import { useEffect } from 'react';

import { setStateFieldBatteryMode } from '../stateField';
import { fetchPowerStatus } from '../services/shellApi';
import { appRuntimeMode } from '../services/runtime';

const POWER_STATUS_INTERVAL_MS = 60_000;

export function usePowerStatus() {
  useEffect(() => {
    if (appRuntimeMode() !== 'tauri') {
      setStateFieldBatteryMode(false);
      return;
    }

    let stopped = false;
    let interval = 0;

    const refresh = () => {
      void fetchPowerStatus()
        .then(status => {
          if (!stopped) setStateFieldBatteryMode(status.onBattery);
        })
        .catch(() => {
          if (!stopped) setStateFieldBatteryMode(false);
        });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'hidden') return;
      refresh();
    };

    refresh();
    interval = window.setInterval(refresh, POWER_STATUS_INTERVAL_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () => {
      stopped = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      setStateFieldBatteryMode(false);
    };
  }, []);
}
