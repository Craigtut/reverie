import type {
  ActivityState,
  DashboardStatus,
  GlyphState,
  ReentrySummary,
  SessionState,
  SessionStateTimeline,
  SessionTerminalBinding,
  ShellSession,
} from './types';

// Pure mapping from raw agent activity + session record onto the dashboard's
// rails, plain-language status text, status-dot color, and glyph state.

// Whether `next` is a newer activity snapshot than `prior` and should replace
// it. Ordering is by wall-clock `updatedAt` first: a CLI can restart its own
// process mid-session (a crash-resume or post-error continuation) and reset its
// per-run `sequence` to 1, so a sequence-only guard would drop every
// post-restart update and strand the session showing its pre-restart state.
// Real time only moves forward across the restart, so the timestamp separates a
// restarted stream (newer time, lower sequence: keep) from a true straggler
// (older time: drop). `sequence` only breaks ties within one run, where the
// timestamps match or are unparseable (a missing stamp, or a hand-built
// fixture). Mirrors the backend's `activity_is_out_of_order`.
export function activitySupersedes(next: ActivityState, prior: ActivityState): boolean {
  const a = Date.parse(next.updatedAt);
  const b = Date.parse(prior.updatedAt);
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a > b;
  return next.sequence > prior.sequence;
}

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
    if (activity.status === 'awaiting_permission' || activity.status === 'awaiting_response')
      return 'attention';
    if (activity.lastError && !activity.lastError.recoverable) return 'attention';
    if (activity.status === 'working') return 'live';
    if (activity.status === 'awaiting_input') return isBound ? 'live' : 'recent';
    return 'recent'; // done | error (recoverable)
  }
  if (session.status === 'restore_failed') return 'attention';
  if (session.status === 'running' || isBound) return 'live';
  return 'recent';
}

// The moment an agent last came to rest after working: a turn finished (`done`)
// or it paused for your input (`awaiting_input`). Returned as epoch ms, or null
// when there is no such moment (working / blocked / never had a feed). Prefer the
// turn's own end time; fall back to when the activity state last changed. A
// recoverable error is deliberately excluded: it is not a "come look, I made you
// something" moment, so it stays plain idle.
export function lastTurnCompletedAtMs(activity: ActivityState | null): number | null {
  if (!activity) return null;
  if (activity.status !== 'done' && activity.status !== 'awaiting_input') return null;
  const stamp = activity.turn?.endedAt ?? activity.updatedAt;
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? null : ms;
}

// The moment a session came to rest, for the unseen-completion check, in epoch ms
// (or null). For most states this is the activity's own timestamp. The exception
// is `done`: a Claude session emits `done` (a SessionEnd hook) the instant its
// process exits, which is exactly what quitting Reverie does to every running
// agent. That `done` carries a fresh `updatedAt` stamped at the quit moment, so
// reading it as a turn-completion would resurface every session you already
// opened as "Ready for you" on the next launch. The genuine turn rest is the
// persisted `restingSince` marker, which the backend deliberately never restamps
// on the same-class `awaiting_input` -> `done` transition, so for `done` we trust
// that instead (falling back to the activity time only when no marker exists, as
// in hand-built fixtures or pre-timeline records).
function restedAtMs(activity: ActivityState | null, restingSince?: string | null): number | null {
  if (activity?.status === 'done') {
    return parseMs(restingSince) ?? lastTurnCompletedAtMs(activity);
  }
  return lastTurnCompletedAtMs(activity);
}

// Whether a session has a turn-completion the user has not seen yet: it came to
// rest after `session.lastViewedAt` and is not the session currently on screen.
// Viewing is the acknowledgement, so the session you are looking at is never
// "unseen" (handled by `isViewed`), and once you open it `lastViewedAt` advances
// past the completion. A missing `lastViewedAt` reads as the epoch (unseen).
function hasUnseenCompletion(
  session: ShellSession,
  activity: ActivityState | null,
  isViewed: boolean,
): boolean {
  if (isViewed) return false;
  const completedMs = restedAtMs(activity, session.stateTimeline?.restingSince);
  if (completedMs == null) return false;
  const seenMs = session.lastViewedAt ? Date.parse(session.lastViewedAt) : 0;
  return completedMs > (Number.isNaN(seenMs) ? 0 : seenMs);
}

// The session's re-entry ("where we left off") summary, but only while it still
// describes the session's current rest and the user has not dismissed it. A new
// turn advances `restingSince` and supersedes the summary; this returns null then
// (the record is kept for resume, but no longer shown). Shared by the re-entry
// header and the dashboard card so both gate identically. See ReentrySummary.
export function activeReentrySummary(
  session: ShellSession,
  timeline?: SessionStateTimeline | null,
): ReentrySummary | null {
  const summary = session.reentrySummary;
  if (!summary || summary.dismissed) return null;
  // Gate on the freshest known rest. The live-merged timeline (via
  // timelineForSession) advances restingSince the moment a newer turn comes to
  // rest, so the summary supersedes itself immediately even when no snapshot
  // refetch has landed yet (a session the user watched finish another turn emits
  // no session_record_changed, leaving the persisted stateTimeline stale). Fall
  // back to the persisted snapshot only when no timeline arg is supplied.
  const resolved = timeline === undefined ? session.stateTimeline : timeline;
  const restingSince = resolved?.restingSince ?? null;
  if (!summary.generatedForRestingSince || summary.generatedForRestingSince !== restingSince)
    return null;
  return summary;
}

// One line answering "what does this agent need from you next?", picked from the
// re-entry summary: the explicit ask if there is one, else what changed, else the
// goal. `isAsk` is true only for an explicit pending decision, so the surface can
// accent a genuine question differently from informational catch-up. Null when no
// field has usable text.
export function reentryNeedsLine(summary: ReentrySummary): { text: string; isAsk: boolean } | null {
  const fields = summary.fields;
  const pending = fields.pendingDecision?.trim();
  if (pending) return { text: pending, isAsk: true };
  const changed = fields.whatChanged?.trim();
  if (changed) return { text: changed, isAsk: false };
  const goal = fields.currentGoal?.trim();
  if (goal) return { text: goal, isAsk: false };
  return null;
}

// The moment this session last started working, in epoch ms, from whichever
// signal is freshest: the live activity's current/last turn start (a reply kicks
// off a new turn, so this is effectively "when you last replied") combined with
// the persisted workingSince marker (the only source between snapshot refetches).
// Null when the session has never been observed working.
function workedSinceMs(session: ShellSession, activity: ActivityState | null): number | null {
  return maxMs(parseMs(activity?.turn?.startedAt), parseMs(session.stateTimeline?.workingSince));
}

// Whether the user has a live follow-up flag on this session: they marked it to
// come back to and have not replied since. A reply restarts work, so any working
// turn that began after the flag was placed supersedes it. This is derived (not a
// stored clear), mirroring how `finished` compares restingSince vs lastViewedAt.
// Unlike `finished`, viewing the session never clears it; that is the whole point
// of the flag, so this deliberately takes no `isViewed`.
export function isFollowingUp(session: ShellSession, activity: ActivityState | null): boolean {
  const flaggedMs = parseMs(session.flaggedAt);
  if (flaggedMs == null) return false;
  const workedMs = workedSinceMs(session, activity);
  return workedMs == null || workedMs <= flaggedMs;
}

// Group a session into one of the user-facing states the dashboard and focus
// view partition by. Live activity wins; the persisted record status is the
// fallback. Key distinctions:
//   - active   = a positive "working" signal (the agent is mid-turn).
//   - finished = the agent came to rest (turn done / paused for input) while you
//                were NOT viewing it, and you have not opened it since: an unseen
//                result. The quieter, invitational counterpart to attention.
//   - idle     = the session is at rest and already seen. This covers both a live
//                process (turn done / awaiting your next prompt / running with no
//                activity feed) AND an exited-but-resumable session: opening
//                either reopens the same conversation, so we deliberately do not
//                split them. We also do NOT call a bare running process "active":
//                without a working signal we cannot know it is working, and
//                showing every live CLI as active misrepresents an agent that is
//                just waiting for you.
//   - followup  = the user hand-flagged this session to come back to it. Derived
//                from the flag (see isFollowingUp), not the agent lifecycle, but
//                returned as its own bucket. Ranks below `finished` so a genuinely
//                unseen result still surfaces first, and below `active`/`working`
//                so an in-progress reply reads truthfully; it clears once the user
//                replies. Surfaces only for at-rest sessions.
//   - errored  = an unrecoverable error or a failed restore: the agent is stuck.
//   - blocked  = a blocking ask the agent raised (a permission gate, or a
//                question / plan approval), not the everyday "waiting for input"
//                rest state. Both errored and blocked mean "act now".
//   - fresh    = never launched, so there is no conversation to reopen yet.
// `isViewed` is true when this session is the one currently on screen (the
// selected terminal); a viewed session is never `finished` (but can be `followup`,
// since the flag deliberately survives viewing).
export function deriveSessionState(
  session: ShellSession,
  isBound: boolean,
  activity: ActivityState | null,
  isViewed = false,
): SessionState {
  if (activity) {
    // An unrecoverable error means the agent is stuck and cannot continue on its
    // own: the loudest tier, ranked above a blocking ask. Checked even while the
    // status still reads `working`, because the error is the truth of the session.
    if (activity.lastError && !activity.lastError.recoverable) return 'errored';
    // A blocking ask the agent raised mid-turn (permission gate, or a question /
    // plan approval) is `blocked`: it cannot proceed without you. This is NOT the
    // everyday awaiting_input rest state, and it must win over `working` so an
    // AskUserQuestion pause stops reading as a green, busy agent.
    if (activity.status === 'awaiting_permission' || activity.status === 'awaiting_response')
      return 'blocked';
    if (activity.status === 'working') return 'active';
    // awaiting_input | done | recoverable error: alive, waiting on you. If the
    // rest happened off-screen and is unseen, surface it as finished.
    if (hasUnseenCompletion(session, activity, isViewed)) return 'finished';
    // A seen-but-held session the user flagged for follow-up (and hasn't replied
    // to since). Ranks under `finished` so a fresh unseen result wins.
    if (isFollowingUp(session, activity)) return 'followup';
    return 'idle';
  }
  if (session.status === 'restore_failed') return 'errored';
  // A follow-up flag stands even for a session with no live activity feed.
  if (isFollowingUp(session, null)) return 'followup';
  // fresh = never launched, not currently bound, and no resume handle: there is
  // genuinely no conversation to reopen. A bound not_started session is mid
  // launch, so it is already alive (idle), not fresh.
  if (session.status === 'not_started' && !isBound && !session.nativeSessionRef) return 'fresh';
  // Alive (running / bound) and exited-but-resumable both rest here: open
  // re-attaches or resumes transparently, so a user need not tell them apart.
  return 'idle';
}

// Map a session state onto the existing card/rail tone so the card's color
// matches the section it sits under. `finished` carries no status hue of its own
// (the design is monochrome plus amber/green only); it reads as a neutral
// "recent" tone and is distinguished by the StateCell's brighter resting look.
export function dashboardToneForState(state: SessionState): DashboardStatus {
  if (state === 'errored' || state === 'blocked') return 'attention';
  if (state === 'active') return 'live';
  return 'recent'; // finished | followup | idle | fresh
}

// What the left nav surfaces about a group of sessions (a focus, a project, or
// General): the worst state present drives the rollup tone, while the counts let
// a row say "2 need you" instead of a flat total. This is how state flows
// upward from sessions to their containers in the rail.
export interface SessionRollup {
  total: number;
  attention: number;
  active: number;
  // Sessions that finished a turn off-screen and are unseen ("Ready for you").
  // Lets a row say "2 ready"; does not raise the rollup tone (it is invitational,
  // not blocking), so it never reads as the amber attention alarm.
  finished: number;
  // Sessions the user hand-flagged for follow-up ("Following up"). Like finished,
  // a personal/invitational count that never raises the rollup tone.
  followup: number;
  // The highest-priority tone among the sessions: 'attention' wins over 'live'
  // wins over 'recent' (finished / followup / idle / fresh / empty).
  tone: DashboardStatus;
}

// `viewedSessionId` is the session currently on screen (selected terminal); it is
// never counted as finished. Pass null when no terminal is in view.
export function rollupSessionStates(
  sessions: ShellSession[],
  bindings: Record<string, SessionTerminalBinding>,
  cortexActivity: Record<string, ActivityState>,
  viewedSessionId: string | null = null,
): SessionRollup {
  let attention = 0;
  let active = 0;
  let finished = 0;
  let followup = 0;
  for (const session of sessions) {
    const isBound = Boolean(bindings[session.id]);
    const activity = activityForSession(session, cortexActivity);
    const state = deriveSessionState(session, isBound, activity, session.id === viewedSessionId);
    // The nav rolls "needs you" up as one number: errored and blocked both count
    // toward attention so a container row can say "2 need you" without splitting
    // stuck-vs-blocked, which only the home's tiers distinguish.
    if (state === 'errored' || state === 'blocked') attention += 1;
    else if (state === 'active') active += 1;
    else if (state === 'finished') finished += 1;
    else if (state === 'followup') followup += 1;
  }
  const tone: DashboardStatus = attention > 0 ? 'attention' : active > 0 ? 'live' : 'recent';
  return { total: sessions.length, attention, active, finished, followup, tone };
}

// The state the live WebGL StateCell renders. A superset of SessionState that
// splits out a hard (unrecoverable) error so it can ping red rather than amber.
export type CellSessionState = 'fresh' | 'active' | 'idle' | 'attention' | 'error' | 'finished';

export function cellStateFor(
  session: ShellSession,
  isBound: boolean,
  activity: ActivityState | null,
  isViewed = false,
): CellSessionState {
  if (activity?.lastError && !activity.lastError.recoverable) return 'error';
  const state = deriveSessionState(session, isBound, activity, isViewed);
  // Map the home's tier states onto the dot's narrower vocabulary: a hard error
  // pings red (`error`), a blocking ask pings amber (`attention`). The follow-up
  // flag is an orthogonal user marker shown by a separate bookmark, not the dot,
  // so a flagged at-rest session keeps rendering as idle and the dot never
  // invents a state.
  if (state === 'errored') return 'error';
  if (state === 'blocked') return 'attention';
  if (state === 'followup') return 'idle';
  return state;
}

export type GroupedSessions = Record<SessionState, ShellSession[]>;

// Partition a set of sessions into the user-facing state buckets the Home
// dashboard and focus view render as sections. Shared so both surfaces classify
// identically.
// `viewedSessionId` is the session currently on screen (selected terminal); it
// never lands in the `finished` bucket. Pass null when no terminal is in view.
export function groupSessionsByState(
  sessions: ShellSession[],
  bindings: Record<string, SessionTerminalBinding>,
  cortexActivity: Record<string, ActivityState>,
  viewedSessionId: string | null = null,
): GroupedSessions {
  const groups: GroupedSessions = {
    errored: [],
    blocked: [],
    active: [],
    finished: [],
    followup: [],
    idle: [],
    fresh: [],
  };
  for (const session of sessions) {
    const isBound = Boolean(bindings[session.id]);
    const activity = activityForSession(session, cortexActivity);
    groups[deriveSessionState(session, isBound, activity, session.id === viewedSessionId)].push(
      session,
    );
  }
  return groups;
}

// --- Transition-recency ordering -------------------------------------------
// The dashboards order each status group by when its sessions entered that
// state, most recent first, so the session that just became "Ready for you"
// (or just went idle, or just started working) sits at the top of its group.
// The "entered at" times come from the backend's SessionStateTimeline: the
// persisted copy rides the snapshot, and live updates arrive on the activity
// event (held in the activity store, keyed by native id). We prefer the live
// copy but merge per-field with the snapshot, because some markers (exitedAt,
// createdAt) only ever arrive via the snapshot.

function parseMs(value?: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function maxMs(...values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value != null);
  return present.length > 0 ? Math.max(...present) : null;
}

// The later of two ISO timestamps (by parsed time), tolerant of either being
// absent or unparseable. Used to reconcile the live and snapshot timelines:
// every marker only moves forward, so taking the later value is always correct.
function laterOf(a?: string | null, b?: string | null): string | null {
  const am = parseMs(a);
  const bm = parseMs(b);
  if (am == null) return b ?? null;
  if (bm == null) return a ?? null;
  return am >= bm ? (a ?? null) : (b ?? null);
}

function mergeTimeline(
  live: SessionStateTimeline,
  snapshot: SessionStateTimeline,
): SessionStateTimeline {
  return {
    createdAt: laterOf(live.createdAt, snapshot.createdAt),
    workingSince: laterOf(live.workingSince, snapshot.workingSince),
    restingSince: laterOf(live.restingSince, snapshot.restingSince),
    blockedSince: laterOf(live.blockedSince, snapshot.blockedSince),
    exitedAt: laterOf(live.exitedAt, snapshot.exitedAt),
  };
}

// The most complete state timeline for a session: the live copy from the
// activity store (freshest for activity-driven markers) merged with the
// persisted snapshot copy (the only source of lifecycle markers between
// refetches). Returns null only when neither exists (hand-built fixtures).
export function timelineForSession(
  session: ShellSession,
  liveTimelines: Record<string, SessionStateTimeline>,
): SessionStateTimeline | null {
  const snapshot = session.stateTimeline ?? null;
  const nativeId = session.nativeSessionRef?.sessionId;
  const live = nativeId ? liveTimelines[nativeId] : undefined;
  if (!live) return snapshot;
  if (!snapshot) return live;
  return mergeTimeline(live, snapshot);
}

// When a session entered the state its group represents, as epoch ms, or null
// when unknown. Each group keys off a different timeline marker; `idle` is the
// most recent of came-to-rest, process exit, and when you last looked at it.
export function enteredCurrentStateAt(
  groupState: SessionState,
  session: ShellSession,
  timeline: SessionStateTimeline | null,
  activity: ActivityState | null,
): number | null {
  const tl = timeline ?? {};
  switch (groupState) {
    case 'errored':
      // The error moment, or the block marker when the timeline lacks one (a
      // restore_failed has no activity feed, so it falls back to blockedSince).
      return parseMs(activity?.lastError?.occurredAt) ?? parseMs(tl.blockedSince);
    case 'blocked':
      return parseMs(tl.blockedSince);
    case 'active':
      return parseMs(tl.workingSince);
    case 'finished':
      // The off-screen rest moment. `restedAtMs` already prefers the persisted
      // rest marker over a `done` state's exit-stamped timestamp; fall back to the
      // marker alone when there is no activity feed at all.
      return restedAtMs(activity, tl.restingSince) ?? parseMs(tl.restingSince);
    case 'followup':
      // When the user flagged it: most-recently-flagged sits at the top of the rail.
      return parseMs(session.flaggedAt);
    case 'idle':
      return maxMs(parseMs(tl.restingSince), parseMs(tl.exitedAt), parseMs(session.lastViewedAt));
    case 'fresh':
      return parseMs(tl.createdAt);
    default:
      return null;
  }
}

// Order one status group's sessions by transition recency (most recent first).
// Sessions with no known transition time sort last, preserving their manual
// drag order (`sortOrder`) as the tiebreak so a deliberate arrangement and a
// stable id still decide ties.
export function sortGroupByRecency(
  sessions: ShellSession[],
  groupState: SessionState,
  liveTimelines: Record<string, SessionStateTimeline>,
  cortexActivity: Record<string, ActivityState>,
): ShellSession[] {
  return sessions
    .map(session => ({
      session,
      key: enteredCurrentStateAt(
        groupState,
        session,
        timelineForSession(session, liveTimelines),
        activityForSession(session, cortexActivity),
      ),
    }))
    .sort((a, b) => {
      const ak = a.key ?? Number.NEGATIVE_INFINITY;
      const bk = b.key ?? Number.NEGATIVE_INFINITY;
      if (ak !== bk) return bk - ak;
      const ao = a.session.sortOrder ?? 0;
      const bo = b.session.sortOrder ?? 0;
      if (ao !== bo) return ao - bo;
      return a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0;
    })
    .map(entry => entry.session);
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
  isViewed = false,
): string {
  if (activity) {
    switch (activity.status) {
      case 'awaiting_permission':
        return 'Needs your approval';
      case 'awaiting_response':
        return 'Needs your answer';
      case 'working': {
        const tool = activity.activeTools?.[0];
        if (tool?.displaySummary) return tool.displaySummary;
        if (tool?.toolName) return `Running ${tool.toolName}`;
        return 'Working';
      }
      case 'awaiting_input':
      case 'done':
        // A turn that came to rest off-screen and unseen reads as an invitation,
        // distinct from idle's "you already looked" rest state.
        return hasUnseenCompletion(session, activity, isViewed)
          ? 'Ready for you'
          : 'Waiting for you';
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
  if (
    activity?.status === 'awaiting_permission' ||
    activity?.status === 'awaiting_response' ||
    tone === 'attention'
  )
    return 'attention';
  if (activity?.status === 'working') return 'working';
  if (activity?.status === 'error' && activity.lastError && !activity.lastError.recoverable)
    return 'error';
  return 'idle';
}
