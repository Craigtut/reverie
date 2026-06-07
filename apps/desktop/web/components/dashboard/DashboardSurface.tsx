import { motion } from 'motion/react';
import { CheckCircle, Plus, Warning } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { groupSessionsByState, sortGroupByRecency } from '../../domain';
import type {
  ActivityState,
  DashboardStatus,
  SessionState,
  SessionStateTimeline,
  SessionTerminalBinding,
  ShellSession,
  WorkspaceShellSnapshot,
} from '../../domain';
import { EmptyState } from '../onboarding';
import { Typography } from '../primitives/Typography';
import { DashboardRail } from './DashboardRail';

// Order and presentation of the state sections, top (most demanding of the user)
// to bottom.
const SECTIONS: { key: SessionState; title: string; tone: DashboardStatus; attention?: boolean }[] =
  [
    { key: 'attention', title: 'Needs your attention', tone: 'attention', attention: true },
    { key: 'finished', title: 'Ready for you', tone: 'recent' },
    { key: 'active', title: 'Working', tone: 'live' },
    { key: 'idle', title: 'Idle', tone: 'recent' },
    { key: 'fresh', title: 'Fresh', tone: 'recent' },
  ];

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
  const active = shell.sessions.filter(s => !s.archived);
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
          <div className={dashboardCountsClass}>
            <Typography
              as="span"
              variant="caption"
              tone="muted"
              data-tone={groups.active.length > 0 ? 'live' : 'idle'}
              data-testid="dashboard-live-count"
            >
              <i
                style={{ background: groups.active.length > 0 ? 'var(--good)' : 'var(--text-4)' }}
              />
              {groups.active.length} working
            </Typography>
            <Typography
              as="span"
              variant="caption"
              tone="muted"
              data-tone={groups.attention.length > 0 ? 'attention' : 'idle'}
              data-testid="dashboard-attention-count"
            >
              <i
                style={{
                  background: groups.attention.length > 0 ? 'var(--warn)' : 'var(--text-4)',
                }}
              />
              {groups.attention.length} need attention
            </Typography>
            <Typography
              as="span"
              variant="caption"
              tone="muted"
              data-tone="recent"
              data-testid="dashboard-ready-count"
            >
              <i
                style={{
                  background: groups.finished.length > 0 ? 'var(--text-2)' : 'var(--text-4)',
                }}
              />
              {groups.finished.length} ready
            </Typography>
            <Typography
              as="span"
              variant="caption"
              tone="muted"
              data-tone="recent"
              data-testid="dashboard-recent-count"
            >
              <i style={{ background: 'var(--text-4)' }} />
              {groups.idle.length} idle
            </Typography>
          </div>
        </header>

        {SECTIONS.map(section =>
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
              bindings={sessionTerminalBindings}
              cortexActivity={cortexActivity}
              onOpenSession={onOpenSession}
            />
          ) : null,
        )}
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

const dashboardCountsClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  flexWrap: 'wrap',
  '& span': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '7px',
    padding: '5px 11px',
    background: 'color-mix(in srgb, var(--surface-1) 70%, transparent)',
    border: '1px solid var(--line)',
    borderRadius: '999px',
    fontVariantNumeric: 'tabular-nums',
  },
  '& span i': {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    display: 'inline-block',
  },
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
