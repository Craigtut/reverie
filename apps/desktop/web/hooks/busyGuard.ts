import { activeWorkspaceSessions, activityForSession } from '../domain';
import type { ShellSession } from '../domain';
import { useActivityStore, useShellStore, useTerminalStore } from '../store';

// Sessions with live, in-flight agent work that a teardown (quit or an updater
// relaunch) would interrupt. Only a session with a LIVE terminal binding can
// have work worth warning about; a dormant session has nothing running to stop.
// Shared by the quit confirmation (useAppQuit) and the relaunch-to-update flow
// so both gate on the exact same definition of "busy".
export function collectBusySessions(): ShellSession[] {
  const sessions = activeWorkspaceSessions(useShellStore.getState().shell);
  const bindings = useTerminalStore.getState().sessionTerminalBindings;
  const cortexActivity = useActivityStore.getState().cortexActivity;
  return sessions.filter(session => {
    if (!bindings[session.id]) return false;
    const status = activityForSession(session, cortexActivity)?.status;
    return (
      status === 'working' || status === 'awaiting_permission' || status === 'awaiting_response'
    );
  });
}
