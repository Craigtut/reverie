import { motion } from 'motion/react';
import { CheckCircle, Plus } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { activeWorkspaceSessions, groupSessionsByState } from '../../domain';
import type {
  ActivityState,
  SessionStateTimeline,
  SessionTerminalBinding,
  ShellSession,
  WorkspaceShellSnapshot,
} from '../../domain';
import { EmptyState } from '../onboarding';
import { Typography } from '../primitives/Typography';
import { DashboardCountPills } from './DashboardCountPills';
import { DashboardStateRails } from './DashboardStateRails';

// The default surface (Home): every non-archived session across the workspace,
// grouped by state. Archived sessions are excluded here and live in each focus's
// history. Shows first-run onboarding when there are no sessions at all, and a
// calm "all caught up" panel once everything has been archived.
export function DashboardSurface({
  shell,
  sessionTerminalBindings,
  cortexActivity,
  sessionTimelines,
  onOpenSession,
  onCreateProject,
  onCreateGeneralSession,
  onOpenSettings,
  onSetWorkspaceDefaultDangerousMode,
}: {
  shell: WorkspaceShellSnapshot;
  sessionTerminalBindings: Record<string, SessionTerminalBinding>;
  cortexActivity: Record<string, ActivityState>;
  sessionTimelines: Record<string, SessionStateTimeline>;
  onOpenSession: (session: ShellSession) => void;
  onCreateProject: () => void;
  onCreateGeneralSession: () => void;
  onOpenSettings: () => void;
  onSetWorkspaceDefaultDangerousMode: (next: boolean) => void;
}) {
  // Home shows every *effectively* active session: not archived, and not inside
  // an archived topic or project (see activeWorkspaceSessions). Filtering on the
  // session's own bit alone is what used to leak a deleted project's sessions
  // onto Home, since archiving a project hides its sessions by ancestry.
  const active = activeWorkspaceSessions(shell);
  const groups = groupSessionsByState(active, sessionTerminalBindings, cortexActivity);

  if (shell.sessions.length === 0) {
    return (
      <EmptyState
        createProject={onCreateProject}
        createGeneralSession={onCreateGeneralSession}
        openSettings={onOpenSettings}
        workspaceDefaultDangerousMode={shell.workspace.defaultDangerousMode}
        onSetWorkspaceDefaultDangerousMode={onSetWorkspaceDefaultDangerousMode}
      />
    );
  }

  if (active.length === 0) {
    return (
      <div className={caughtUpClass} data-testid="dashboard-caught-up">
        <motion.div
          className={caughtUpCenterClass}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <CheckCircle size={26} weight="duotone" />
          <Typography as="h1" variant="subtitle" tone="default">
            You're all caught up
          </Typography>
          <Typography as="p" variant="smallBody" tone="faint" align="center">
            Nothing open right now. Closed sessions are kept in each focus's history, where you can
            restore them anytime.
          </Typography>
          <button
            type="button"
            className={caughtUpActionClass}
            data-testid="caught-up-new-session-button"
            onClick={onCreateGeneralSession}
          >
            <Plus size={14} />
            <Typography as="span" variant="smallBody" tone="inherit">
              New session
            </Typography>
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className={dashboardSurfaceClass} data-testid="dashboard-surface">
      <motion.div
        className={dashboardContentClass}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      >
        <header className={dashboardHeaderClass}>
          <div>
            <Typography
              as="p"
              variant="tiny"
              tone="faint"
              uppercase
              style={{ letterSpacing: '0.12em' }}
            >
              Workspace
            </Typography>
            <Typography as="h1" variant="subtitle" tone="default" className={dashboardTitleClass}>
              {shell.workspace.name}
            </Typography>
          </div>
          <DashboardCountPills groups={groups} />
        </header>

        <DashboardStateRails
          groups={groups}
          shell={shell}
          bindings={sessionTerminalBindings}
          cortexActivity={cortexActivity}
          sessionTimelines={sessionTimelines}
          onOpenSession={onOpenSession}
        />
      </motion.div>
    </div>
  );
}

const dashboardSurfaceClass = css({
  position: 'relative',
  // height (not flex: 1): the parent canvas stage is a block, not a flex
  // container, so flex: 1 collapses to auto/content height and the inner
  // overflowY: auto never gets a bounded height to scroll within. A definite
  // 100% height fills the stage and lets the content rail scroll on overflow.
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: 'transparent',
});

const dashboardContentClass = css({
  position: 'relative',
  zIndex: 2,
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '28px 32px 40px',
  display: 'flex',
  flexDirection: 'column',
  gap: '28px',
});

const dashboardHeaderClass = css({
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: '16px',
  flexWrap: 'wrap',
});

// Layout only; the title's size + color come from the Typography variant + tone.
const dashboardTitleClass = css({
  margin: '4px 0 0',
});

const caughtUpClass = css({
  position: 'relative',
  // height (not flex: 1): see dashboardSurfaceClass. The parent stage is a block,
  // so a definite height is needed to fill it and center the panel in the stage.
  height: '100%',
  minHeight: 0,
  display: 'grid',
  placeItems: 'center',
  overflow: 'hidden',
  background: 'transparent',
});

const caughtUpCenterClass = css({
  position: 'relative',
  zIndex: 2,
  display: 'grid',
  justifyItems: 'center',
  gap: '12px',
  width: 'min(400px, calc(100vw - 360px))',
  textAlign: 'center',
  color: 'var(--text-3)',
  '& > svg': { color: 'var(--good)' },
  '& p': { margin: 0 },
});

const caughtUpActionClass = css({
  marginTop: '6px',
  height: '34px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '7px',
  padding: '0 14px',
  borderRadius: '999px',
  border: '1px solid var(--line-strong)',
  color: 'var(--text)',
  background: 'var(--surface-3)',
  boxShadow: 'var(--shadow)',
  cursor: 'pointer',
  transition: 'background 140ms ease',
  _hover: { background: 'var(--surface-hi)' },
});
