import { useState, type MouseEvent } from 'react';
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
import { NavContextMenu, type NavMenuModel } from '../nav/NavContextMenu';
import { buildSessionMenuItems } from '../nav/sessionMenu';
import { DashboardRail } from './DashboardRail';
import { DASHBOARD_SECTIONS } from './sections';

// The per-session actions a dashboard card's right-click menu drives. They mirror
// the left-nav session menu so a session reads the same wherever its card lives:
// rename (commits the inline editor's value; empty resets to the automatic name),
// reset to the automatic name, the folder utilities, and the reversible archive.
export interface SessionCardActions {
  onRename: (session: ShellSession, title: string) => void;
  onUseAutomaticName: (session: ShellSession) => void;
  onRevealPath: (path: string) => void;
  onCopyPath: (path: string) => void;
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
}: {
  groups: GroupedSessions;
  shell: WorkspaceShellSnapshot;
  bindings: Record<string, SessionTerminalBinding>;
  cortexActivity: Record<string, ActivityState>;
  sessionTimelines: Record<string, SessionStateTimeline>;
  sessionActions: SessionCardActions;
  onOpenSession: (session: ShellSession) => void;
}) {
  // The right-click menu model and the id of the card whose title is being edited
  // inline. Both live here, the common parent of every card in a surface, so a
  // single floating menu and one rename cursor serve all the rails at once.
  const [menu, setMenu] = useState<NavMenuModel | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);

  function openSessionMenu(event: MouseEvent<HTMLElement>, session: ShellSession) {
    event.preventDefault();
    const items = buildSessionMenuItems(session, {
      onRename: () => setRenamingSessionId(session.id),
      onUseAutomaticName: () => sessionActions.onUseAutomaticName(session),
      onRevealPath: sessionActions.onRevealPath,
      onCopyPath: sessionActions.onCopyPath,
      onArchive: () => sessionActions.onArchive(session),
    });
    setMenu({ x: event.clientX, y: event.clientY, items });
  }

  function commitRename(session: ShellSession, value: string) {
    setRenamingSessionId(null);
    sessionActions.onRename(session, value);
  }

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
