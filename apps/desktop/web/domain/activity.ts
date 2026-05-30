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

// Group a session into one of the user-facing states the dashboard and focus
// view partition by. Live activity wins; the persisted record status is the
// fallback. Key distinctions:
//   - active  = a positive "working" signal (the agent is mid-turn).
//   - idle    = the session is at rest, waiting for you. This covers both a live
//               process (turn done / awaiting your next prompt / running with no
//               activity feed) AND an exited-but-resumable session: opening
//               either reopens the same conversation, so we deliberately do not
//               split them. We also do NOT call a bare running process "active":
//               without a working signal we cannot know it is working, and
//               showing every live CLI as active misrepresents an agent that is
//               just waiting for you.
//   - attention only means a blocking ask (permission) or a hard failure, not
//               the everyday "waiting for input" rest state.
//   - fresh   = never launched, so there is no conversation to reopen yet.
export function deriveSessionState(
  session: ShellSession,
  isBound: boolean,
  activity: ActivityState | null,
): SessionState {
  if (activity) {
    if (activity.status === 'awaiting_permission') return 'attention';
    if (activity.lastError && !activity.lastError.recoverable) return 'attention';
    if (activity.status === 'working') return 'active';
    // awaiting_input | done | recoverable error: alive, waiting on you.
    return 'idle';
  }
  if (session.status === 'restore_failed') return 'attention';
  // fresh = never launched, not currently bound, and no resume handle: there is
  // genuinely no conversation to reopen. A bound not_started session is mid
  // launch, so it is already alive (idle), not fresh.
  if (session.status === 'not_started' && !isBound && !session.nativeSessionRef) return 'fresh';
  // Alive (running / bound) and exited-but-resumable both rest here: open
  // re-attaches or resumes transparently, so a user need not tell them apart.
  return 'idle';
}

// Map a session state onto the existing card/rail tone so the card's color
// matches the section it sits under.
export function dashboardToneForState(state: SessionState): DashboardStatus {
  if (state === 'attention') return 'attention';
  if (state === 'active') return 'live';
  return 'recent'; // idle | fresh
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
  // wins over 'recent' (idle / fresh / empty).
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
export type CellSessionState = 'fresh' | 'active' | 'idle' | 'attention' | 'error' | 'finished';

export function cellStateFor(
  session: ShellSession,
  isBound: boolean,
  activity: ActivityState | null,
): CellSessionState {
  if (activity?.lastError && !activity.lastError.recoverable) return 'error';
  return deriveSessionState(session, isBound, activity);
}

export type GroupedSessions = Record<SessionState, ShellSession[]>;

// Partition a set of sessions into the user-facing state buckets the Home
// dashboard and focus view render as sections. Shared so both surfaces classify
// identically.
export function groupSessionsByState(
  sessions: ShellSession[],
  bindings: Record<string, SessionTerminalBinding>,
  cortexActivity: Record<string, ActivityState>,
): GroupedSessions {
  const groups: GroupedSessions = {
    attention: [],
    active: [],
    idle: [],
    fresh: [],
  };
  for (const session of sessions) {
    const isBound = Boolean(bindings[session.id]);
    const activity = activityForSession(session, cortexActivity);
    groups[deriveSessionState(session, isBound, activity)].push(session);
  }
  return groups;
}

// A short, product-meaningful status for a session card. Describes what the
// agent is doing or what the session needs from you, never its process
// lifecycle: a user thinks in terms of "my session", so we never surface
// "Running" / "Resumable" / "Ended". A live, an exited-but-resumable, and a
// bare-running session all read "Waiting for you" because opening any of them
// reopens the same conversation.
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
      case 'done':
        return 'Waiting for you';
      case 'error':
        return activity.lastError?.recoverable ? 'Recovered from error' : 'Errored';
    }
  }
  if (session.status === 'restore_failed') return 'Needs your attention';
  if (session.status === 'not_started' && !isBound && !session.nativeSessionRef)
    return 'Ready to start';
  return 'Waiting for you';
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
