import type { ReactNode } from 'react';

import { css } from '../../styled-system/css';
import { activityForSession } from '../../domain';
import type { ActivityState, DashboardStatus, SessionTerminalBinding, ShellSession, WorkspaceShellSnapshot } from '../../domain';
import { SessionDashboardCard } from './SessionDashboardCard';

// One labelled rail of dashboard cards (attention / live / recent).
export function DashboardRail({
  title,
  icon,
  tone,
  sessions,
  shell,
  bindings,
  cortexActivity,
  onOpenSession,
}: {
  title: string;
  icon?: ReactNode;
  tone: DashboardStatus;
  sessions: ShellSession[];
  shell: WorkspaceShellSnapshot;
  bindings: Record<string, SessionTerminalBinding>;
  cortexActivity: Record<string, ActivityState>;
  onOpenSession: (session: ShellSession) => void;
}) {
  return (
    <section className={dashboardRailClass} data-tone={tone} data-testid={`dashboard-rail-${tone}`}>
      <header className={dashboardRailHeaderClass}>
        {icon ? <span data-testid={`dashboard-rail-icon-${tone}`}>{icon}</span> : null}
        <h2 style={tone === 'attention' ? { color: 'var(--warn)' } : undefined}>{title}</h2>
        <span className={dashboardRailCountClass}>{sessions.length}</span>
      </header>
      <div className={dashboardCardsClass}>
        {sessions.map(session => (
          <SessionDashboardCard
            key={session.id}
            session={session}
            shell={shell}
            isBound={Boolean(bindings[session.id])}
            activity={activityForSession(session, cortexActivity)}
            tone={tone}
            onOpen={() => onOpenSession(session)}
          />
        ))}
      </div>
    </section>
  );
}

const dashboardRailClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
});

const dashboardRailHeaderClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  color: 'var(--text-3)',
  '& > span': {
    display: 'inline-flex',
    color: 'var(--warn)',
  },
  '& h2': {
    margin: 0,
    fontSize: '11px',
    fontWeight: 500,
    letterSpacing: '0.10em',
    textTransform: 'uppercase',
    color: 'var(--text-3)',
  },
});

const dashboardRailCountClass = css({
  fontSize: '11px',
  color: 'var(--text-4)',
  fontVariantNumeric: 'tabular-nums',
});

const dashboardCardsClass = css({
  display: 'grid',
  gap: '12px',
  gridTemplateColumns: 'repeat(auto-fill, minmax(228px, 1fr))',
});
