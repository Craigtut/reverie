import { Warning } from '@phosphor-icons/react';

import { sortGroupByRecency } from '../../domain';
import type {
  ActivityState,
  GroupedSessions,
  SessionStateTimeline,
  SessionTerminalBinding,
  ShellSession,
  WorkspaceShellSnapshot,
} from '../../domain';
import { DashboardRail } from './DashboardRail';
import { DASHBOARD_SECTIONS } from './sections';

// The body shared by every dashboard (Home, project, topic): one rail per
// non-empty state section, each ordered by transition recency. Pulling it out of
// the three surfaces keeps their classification and ordering identical and lets
// each surface own only its own header and empty states.
export function DashboardStateRails({
  groups,
  shell,
  bindings,
  cortexActivity,
  sessionTimelines,
  onOpenSession,
}: {
  groups: GroupedSessions;
  shell: WorkspaceShellSnapshot;
  bindings: Record<string, SessionTerminalBinding>;
  cortexActivity: Record<string, ActivityState>;
  sessionTimelines: Record<string, SessionStateTimeline>;
  onOpenSession: (session: ShellSession) => void;
}) {
  return (
    <>
      {DASHBOARD_SECTIONS.map(section =>
        groups[section.key].length > 0 ? (
          <DashboardRail
            key={section.key}
            title={section.title}
            icon={section.attention ? <Warning size={13} weight="fill" /> : undefined}
            tone={section.tone}
            sessions={sortGroupByRecency(
              groups[section.key],
              section.key,
              sessionTimelines,
              cortexActivity,
            )}
            shell={shell}
            bindings={bindings}
            cortexActivity={cortexActivity}
            onOpenSession={onOpenSession}
          />
        ) : null,
      )}
    </>
  );
}
