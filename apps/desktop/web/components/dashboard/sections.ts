import type { DashboardStatus, SessionState } from '../../domain';

// The state sections every dashboard partitions sessions into, ordered top
// (most demanding of the user) to bottom. Shared by Home, the project
// dashboard, and the topic view so all three classify and order identically.
export const DASHBOARD_SECTIONS: {
  key: SessionState;
  title: string;
  tone: DashboardStatus;
  attention?: boolean;
}[] = [
  { key: 'attention', title: 'Needs your attention', tone: 'attention', attention: true },
  { key: 'finished', title: 'Ready for you', tone: 'recent' },
  { key: 'followup', title: 'Following up', tone: 'recent' },
  { key: 'active', title: 'Working', tone: 'live' },
  { key: 'idle', title: 'Idle', tone: 'recent' },
  { key: 'fresh', title: 'Fresh', tone: 'recent' },
];
