import { useEffect, useRef } from 'react';

import { focusMainWindow, onDispatchLaunch } from '../services/dispatchApi';
import type { DispatchLaunchPayload } from '../domain';

// Main-window listener for confirmed dispatches. The popup window emits
// `dispatch:launch`; here we bring the main window forward and hand the routing
// + prompt to the workspace (create + select + launch). Subscribes once and
// always calls the latest handler via a ref, so it never goes stale.
export function useDispatchLaunch(
  handler: (payload: DispatchLaunchPayload) => void | Promise<void>,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onDispatchLaunch(async payload => {
      await focusMainWindow();
      await handlerRef.current(payload);
    }).then(fn => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);
}
