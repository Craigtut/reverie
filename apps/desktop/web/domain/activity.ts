import type {
  ActivityState,
  DashboardStatus,
  GlyphState,
  SessionState,
  SessionTerminalBinding,
  ShellSession,
} from './types';

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

// Group a session into one of the four user-facing states the dashboard and
// focus view partition by. Live activity wins; the persisted record status is
// the fallback. "Needs you" (attention) folds in awaiting-permission, awaiting-
// input, unrecoverable errors, and a failed restore: anything that wants the
// user. Distinct from `classifyForDashboard`, which keeps the older three-tone
// rail split used for card coloring.
export function deriveSessionState(
  session: ShellSession,
  isBound: boolean,
  activity: ActivityState | null,
): SessionState {
  if (activity) {
    if (activity.status === 'awaiting_permission') return 'attention';
    if (activity.lastError && !activity.lastError.recoverable) return 'attention';
    if (activity.status === 'awaiting_input') return 'attention';
    if (activity.status === 'working') return 'active';
    return 'finished'; // done | recoverable error
  }
  if (session.status === 'restore_failed') return 'attention';
  if (session.status === 'running' || isBound) return 'active';
  if (session.status === 'not_started' && !session.nativeSessionRef) return 'fresh';
  return 'finished'; // exited | restorable
}

// Map a session state onto the existing card/rail tone so the card's color
// matches the section it sits under.
export function dashboardToneForState(state: SessionState): DashboardStatus {
  if (state === 'attention') return 'attention';
  if (state === 'active') return 'live';
  return 'recent'; // fresh | finished
}

// What the left nav surfaces about a group of sessions (a focus, a project, or
// General): the worst state present drives the rollup tone, while the counts let
// a row say "2 need you" instead of a flat total. This is how state flows
// upward from sessions to their containers in the rail.
export interface SessionRollup {
  total: number;
  attention: number;
  active: number;
  // The highest-priority tone among the sessions: 'attention' wins over 'live'
  // wins over 'recent' (idle / finished / empty).
  tone: DashboardStatus;
}

export function rollupSessionStates(
  sessions: ShellSession[],
  bindings: Record<string, SessionTerminalBinding>,
  cortexActivity: Record<string, ActivityState>,
): SessionRollup {
  let attention = 0;
  let active = 0;
  for (const session of sessions) {
    const isBound = Boolean(bindings[session.id]);
    const activity = activityForSession(session, cortexActivity);
    const state = deriveSessionState(session, isBound, activity);
    if (state === 'attention') attention += 1;
    else if (state === 'active') active += 1;
  }
  const tone: DashboardStatus = attention > 0 ? 'attention' : active > 0 ? 'live' : 'recent';
  return { total: sessions.length, attention, active, tone };
}

// The state the live WebGL StateCell renders. A superset of SessionState that
// splits out a hard (unrecoverable) error so it can ping red rather than amber.
export type CellSessionState = 'fresh' | 'active' | 'attention' | 'error' | 'finished';

export function cellStateFor(
  session: ShellSession,
  isBound: boolean,
  activity: ActivityState | null,
): CellSessionState {
  if (activity?.lastError && !activity.lastError.recoverable) return 'error';
  return deriveSessionState(session, isBound, activity);
}

export type GroupedSessions = Record<SessionState, ShellSession[]>;

// Partition a set of sessions into the four user-facing state buckets the Home
// dashboard and focus view render as sections. Shared so both surfaces classify
// identically.
export function groupSessionsByState(
  sessions: ShellSession[],
  bindings: Record<string, SessionTerminalBinding>,
  cortexActivity: Record<string, ActivityState>,
): GroupedSessions {
  const groups: GroupedSessions = { attention: [], active: [], fresh: [], finished: [] };
  for (const session of sessions) {
    const isBound = Boolean(bindings[session.id]);
    const activity = activityForSession(session, cortexActivity);
    groups[deriveSessionState(session, isBound, activity)].push(session);
  }
  return groups;
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
  if (activity?.status === 'error' && activity.lastError && !activity.lastError.recoverable)
    return 'error';
  return 'idle';
}
