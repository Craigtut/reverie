import { motion } from 'motion/react';
import { Warning } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { activityForSession, classifyForDashboard } from '../../domain';
import type {
  ActivityState,
  AgentCliDetection,
  SessionTerminalBinding,
  ShellSession,
  WorkspaceShellSnapshot,
} from '../../domain';
import { EmptyState } from '../onboarding';
import { Typography } from '../primitives/Typography';
import { DashboardRail } from './DashboardRail';

// The default surface: partitions visible sessions across attention / live /
// recent rails (activity-state wins, persisted status is the fallback), or
// shows the onboarding panel when the workspace has no sessions yet.
export function DashboardSurface({
  shell,
  sessionTerminalBindings,
  cortexActivity,
  onOpenSession,
  onCreateProject,
  onCreateFocus,
  cliDetections,
  onSetWorkspaceDefaultDangerousMode,
}: {
  shell: WorkspaceShellSnapshot;
  sessionTerminalBindings: Record<string, SessionTerminalBinding>;
  cortexActivity: Record<string, ActivityState>;
  onOpenSession: (session: ShellSession) => void;
  onCreateProject: () => void;
  onCreateFocus: () => void;
  cliDetections: AgentCliDetection[];
  onSetWorkspaceDefaultDangerousMode: (next: boolean) => void;
}) {
  // Partition visible sessions across the three rails. Activity-state drives
  // classification when available; the persisted record status is the fallback
  // for sessions on CLIs without an activity surface yet.
  const visible = shell.sessions.filter(s => s.tabVisible !== false);
  const attention: ShellSession[] = [];
  const live: ShellSession[] = [];
  const recent: ShellSession[] = [];
  for (const session of visible) {
    const isBound = Boolean(sessionTerminalBindings[session.id]);
    const activity = activityForSession(session, cortexActivity);
    const tone = classifyForDashboard(session, isBound, activity);
    if (tone === 'attention') attention.push(session);
    else if (tone === 'live') live.push(session);
    else recent.push(session);
  }

  const totalVisible = visible.length;
  const isEmptyWorkspace = totalVisible === 0;

  if (isEmptyWorkspace) {
    return (
      <EmptyState
        cliDetections={cliDetections}
        createFocus={onCreateFocus}
        createProject={onCreateProject}
        openSettings={() => undefined}
        workspaceDefaultDangerousMode={shell.workspace.defaultDangerousMode}
        onSetWorkspaceDefaultDangerousMode={onSetWorkspaceDefaultDangerousMode}
      />
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
              data-tone={live.length > 0 ? 'live' : 'idle'}
              data-testid="dashboard-live-count"
            >
              <i style={{ background: live.length > 0 ? 'var(--good)' : 'var(--text-4)' }} />
              {live.length} live
            </Typography>
            <Typography
              as="span"
              variant="caption"
              tone="muted"
              data-tone={attention.length > 0 ? 'attention' : 'idle'}
              data-testid="dashboard-attention-count"
            >
              <i style={{ background: attention.length > 0 ? 'var(--warn)' : 'var(--text-4)' }} />
              {attention.length} need attention
            </Typography>
            <Typography
              as="span"
              variant="caption"
              tone="muted"
              data-tone="recent"
              data-testid="dashboard-recent-count"
            >
              <i style={{ background: 'var(--text-4)' }} />
              {recent.length} recent
            </Typography>
          </div>
        </header>

        {attention.length > 0 ? (
          <DashboardRail
            title="Needs your attention"
            icon={<Warning size={13} weight="fill" />}
            tone="attention"
            sessions={attention}
            shell={shell}
            bindings={sessionTerminalBindings}
            cortexActivity={cortexActivity}
            onOpenSession={onOpenSession}
          />
        ) : null}

        {live.length > 0 ? (
          <DashboardRail
            title="Live now"
            tone="live"
            sessions={live}
            shell={shell}
            bindings={sessionTerminalBindings}
            cortexActivity={cortexActivity}
            onOpenSession={onOpenSession}
          />
        ) : null}

        {recent.length > 0 ? (
          <DashboardRail
            title="Recent"
            tone="recent"
            sessions={recent}
            shell={shell}
            bindings={sessionTerminalBindings}
            cortexActivity={cortexActivity}
            onOpenSession={onOpenSession}
          />
        ) : null}
      </motion.div>
    </div>
  );
}

const dashboardSurfaceClass = css({
  position: 'relative',
  flex: 1,
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
  '&::-webkit-scrollbar': { width: '10px' },
  '&::-webkit-scrollbar-thumb': {
    background: 'var(--line)',
    borderRadius: '8px',
    border: '2px solid transparent',
    backgroundClip: 'padding-box',
  },
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
