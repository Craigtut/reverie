import { useState, type MouseEvent, type ReactNode } from 'react';
import { BookmarkSimple, Warning, WarningOctagon } from '@phosphor-icons/react';

import { activityForSession, isFollowingUp, sortGroupByRecency } from '../../domain';
import type {
  ActivityState,
  GroupedSessions,
  SessionState,
  SessionStateTimeline,
  SessionTerminalBinding,
  ShellSession,
  WorkspaceShellSnapshot,
} from '../../domain';
import { NavContextMenu, type NavMenuModel } from '../nav/NavContextMenu';
import { buildSessionMenuItems } from '../nav/sessionMenu';
import { DashboardRail } from './DashboardRail';
import { DASHBOARD_SECTIONS, type DashboardSection } from './sections';

// The header glyph for a tier: errored and blocked both warn, but read as
// distinct severities (a hard stop vs a question), so they carry different marks.
function iconForSection(key: SessionState): ReactNode {
  if (key === 'errored') return <WarningOctagon size={13} weight="fill" />;
  if (key === 'blocked') return <Warning size={13} weight="fill" />;
  if (key === 'followup') return <BookmarkSimple size={12} weight="fill" />;
  return undefined;
}

// The per-session actions a dashboard card's right-click menu drives. They mirror
// the left-nav session menu so a session reads the same wherever its card lives:
// rename (commits the inline editor's value; empty resets to the automatic name),
// reset to the automatic name, and the reversible archive.
export interface SessionCardActions {
  onRename: (session: ShellSession, title: string) => void;
  onUseAutomaticName: (session: ShellSession) => void;
  onToggleFollowUp: (session: ShellSession) => void;
  onArchive: (session: ShellSession) => void;
}

// The body shared by every dashboard (Home, project, topic): one rail per
// non-empty state section, each ordered by transition recency. Pulling it out of
// the three surfaces keeps their classification and ordering identical and lets
// each surface own only its own header and empty states. It also owns the shared
// right-click menu and inline-rename cursor for the cards, so the same session
// context menu the left nav offers is available on every dashboard card.
export function DashboardStateRails({
  groups,
  shell,
  bindings,
  cortexActivity,
  sessionTimelines,
  sessionActions,
  onOpenSession,
  sections = DASHBOARD_SECTIONS,
}: {
  groups: GroupedSessions;
  shell: WorkspaceShellSnapshot;
  bindings: Record<string, SessionTerminalBinding>;
  cortexActivity: Record<string, ActivityState>;
  sessionTimelines: Record<string, SessionStateTimeline>;
  sessionActions: SessionCardActions;
  onOpenSession: (session: ShellSession) => void;
  // Which sections to render, in order. Defaults to every section; Home passes a
  // filtered list (fresh off the home, into the nav).
  sections?: DashboardSection[];
}) {
  // The right-click menu model and the id of the card whose title is being edited
  // inline. Both live here, the common parent of every card in a surface, so a
  // single floating menu and one rename cursor serve all the rails at once.
  const [menu, setMenu] = useState<NavMenuModel | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);

  function openSessionMenu(event: MouseEvent<HTMLElement>, session: ShellSession) {
    event.preventDefault();
    const followingUp = isFollowingUp(session, activityForSession(session, cortexActivity));
    const items = buildSessionMenuItems(
      session,
      { followingUp },
      {
        onRename: () => setRenamingSessionId(session.id),
        onUseAutomaticName: () => sessionActions.onUseAutomaticName(session),
        onToggleFollowUp: () => sessionActions.onToggleFollowUp(session),
        onArchive: () => sessionActions.onArchive(session),
      },
    );
    setMenu({ x: event.clientX, y: event.clientY, items });
  }

  function commitRename(session: ShellSession, value: string) {
    setRenamingSessionId(null);
    sessionActions.onRename(session, value);
  }

  return (
    <>
      {sections.map(section =>
        groups[section.key].length > 0 ? (
          <DashboardRail
            key={section.key}
            sectionKey={section.key}
            title={section.title}
            icon={iconForSection(section.key)}
            tone={section.tone}
            variant={section.variant}
            collapsible={section.collapsible}
            defaultCollapsed={section.defaultCollapsed}
            sessions={sortGroupByRecency(
              groups[section.key],
              section.key,
              sessionTimelines,
              cortexActivity,
            )}
            shell={shell}
            bindings={bindings}
            cortexActivity={cortexActivity}
            sessionTimelines={sessionTimelines}
            renamingSessionId={renamingSessionId}
            onOpenSession={onOpenSession}
            onContextMenuSession={openSessionMenu}
            onCommitRename={commitRename}
            onCancelRename={() => setRenamingSessionId(null)}
          />
        ) : null,
      )}
      <NavContextMenu model={menu} onClose={() => setMenu(null)} />
    </>
  );
}
