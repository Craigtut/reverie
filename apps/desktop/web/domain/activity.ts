import type { ActivityState, DashboardStatus, GlyphState, ShellSession } from './types';

// Pure mapping from raw agent activity + session record onto the dashboard's
// rails, plain-language status text, status-dot color, and glyph state.

export function activityForSession(
  session: ShellSession,
  cortexActivity: Record<string, ActivityState>,
): ActivityState | null {
  const cortexId = session.nativeSessionRef?.sessionId;
  if (!cortexId) return null;
  return cortexActivity[cortexId] ?? null;
}

// Classify a session into one of the dashboard rails. Activity-state wins when
// present; we fall back to the persisted record status when no live signal is
// available (e.g. session was started before the activity surface existed, or
// runs on a CLI we haven't wired yet).
export function classifyForDashboard(
  session: ShellSession,
  isBound: boolean,
  activity: ActivityState | null,
): DashboardStatus {
  if (activity) {
    if (activity.status === 'awaiting_permission') return 'attention';
    if (activity.lastError && !activity.lastError.recoverable) return 'attention';
    if (activity.status === 'working') return 'live';
    if (activity.status === 'awaiting_input') return isBound ? 'live' : 'recent';
    return 'recent'; // done | error (recoverable)
  }
  if (session.status === 'restore_failed') return 'attention';
  if (session.status === 'running' || isBound) return 'live';
  return 'recent';
}

export function plainLanguageStatus(
  session: ShellSession,
  isBound: boolean,
  activity: ActivityState | null,
): string {
  if (activity) {
    switch (activity.status) {
      case 'awaiting_permission':
        return 'Needs your approval';
      case 'working': {
        const tool = activity.activeTools?.[0];
        if (tool?.displaySummary) return tool.displaySummary;
        if (tool?.toolName) return `Running ${tool.toolName}`;
        return 'Working';
      }
      case 'awaiting_input':
        return isBound ? 'Idle · ready for next prompt' : 'Resumable';
      case 'done':
        return 'Ended';
      case 'error':
        return activity.lastError?.recoverable ? 'Recovered from error' : 'Errored';
    }
  }
  if (session.status === 'restore_failed') return 'Needs your attention';
  if (session.status === 'running' || isBound) return 'Running';
  if (session.status === 'restorable' || session.nativeSessionRef) return 'Resumable';
  if (session.status === 'exited') return 'Ended';
  return 'Ready to launch';
}

export function statusDotColor(tone: DashboardStatus): string {
  if (tone === 'attention') return 'var(--warn)';
  if (tone === 'live') return 'var(--good)';
  return 'var(--text-4)';
}

export function glyphStateFor(activity: ActivityState | null, tone: DashboardStatus): GlyphState {
  if (activity?.status === 'working') return 'working';
  if (activity?.status === 'awaiting_permission' || tone === 'attention') return 'attention';
  if (activity?.status === 'error' && activity.lastError && !activity.lastError.recoverable) return 'error';
  return 'idle';
}
