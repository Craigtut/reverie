import type { DashboardStatus, SessionState } from '../../domain';

// How a rail renders its sessions. The home is an attention router: visual weight
// follows the tier, and the tier is objective state, so the sizing is always
// defensible. Tiers that need you are large and carry context; tiers that do not
// shrink (an ambient one-line strip for working) or collapse away (idle).
export type DashboardRailVariant =
  // Large cards with full context and inline actions: the agent is stuck or
  // blocked and needs you now.
  | 'prominent'
  // Standard cards with a one-line summary: a result to look at, or a flag you set.
  | 'card'
  // An ambient one-line-per-session strip: working agents need nothing from you,
  // so they stay glanceable instead of becoming a second wall of cards.
  | 'strip'
  // Thin rows behind a disclosure: already-seen, at-rest sessions, collapsed by
  // default so they do not spend attention.
  | 'compact';

export interface DashboardSection {
  key: SessionState;
  title: string;
  tone: DashboardStatus;
  variant: DashboardRailVariant;
  // Marks the two "act now" tiers (errored / blocked) for the warn-toned header.
  attention?: boolean;
  // Whether the rail collapses behind a disclosure, and its default state.
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  // Whether the Home surface shows this section. `fresh` is off the home (it lives
  // in the nav) but still appears on the project and topic dashboards, which
  // render every section.
  home: boolean;
}

// The state sections every dashboard partitions sessions into, ordered top (most
// demanding of the user) to bottom. Shared by Home, the project dashboard, and
// the topic view so all three classify and order identically. The Home surface
// filters to `home: true`; the others render the full list.
export const DASHBOARD_SECTIONS: DashboardSection[] = [
  {
    key: 'errored',
    title: 'Errored',
    tone: 'attention',
    variant: 'prominent',
    attention: true,
    home: true,
  },
  {
    key: 'blocked',
    title: 'Needs your input',
    tone: 'attention',
    variant: 'prominent',
    attention: true,
    home: true,
  },
  { key: 'finished', title: 'Ready for you', tone: 'recent', variant: 'card', home: true },
  { key: 'followup', title: 'Follow up', tone: 'recent', variant: 'card', home: true },
  // Working renders as full cards (not a one-line strip) so a workspace of busy
  // agents reads as alive, "your agents are doing something right now," with each
  // card's live "now doing X" caption and animated state cell carrying the motion.
  { key: 'active', title: 'Working', tone: 'live', variant: 'card', home: true },
  {
    key: 'idle',
    title: 'Idle',
    tone: 'recent',
    variant: 'compact',
    collapsible: true,
    defaultCollapsed: true,
    home: true,
  },
  { key: 'fresh', title: 'Fresh', tone: 'recent', variant: 'compact', home: false },
];
