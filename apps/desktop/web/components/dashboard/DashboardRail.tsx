import { useState, type MouseEvent, type ReactNode } from 'react';
import { CaretRight } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { activityForSession } from '../../domain';
import type {
  ActivityState,
  DashboardStatus,
  SessionState,
  SessionTerminalBinding,
  ShellSession,
  WorkspaceShellSnapshot,
} from '../../domain';
import { Typography } from '../primitives/Typography';
import { SessionDashboardCard } from './SessionDashboardCard';
import { SessionRailRow } from './SessionRailRow';
import type { DashboardRailVariant } from './sections';

// One labelled rail of sessions for a single state tier. Its visual weight
// follows the tier (see DashboardRailVariant): `prominent` and `card` render full
// cards, `strip` and `compact` render one-line rows. A `collapsible` rail folds
// behind a disclosure so already-seen sessions do not spend attention by default.
export function DashboardRail({
  sectionKey,
  title,
  icon,
  tone,
  variant,
  collapsible,
  defaultCollapsed,
  sessions,
  shell,
  bindings,
  cortexActivity,
  renamingSessionId,
  onOpenSession,
  onContextMenuSession,
  onCommitRename,
  onCancelRename,
}: {
  sectionKey: SessionState;
  title: string;
  icon?: ReactNode;
  tone: DashboardStatus;
  variant: DashboardRailVariant;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  sessions: ShellSession[];
  shell: WorkspaceShellSnapshot;
  bindings: Record<string, SessionTerminalBinding>;
  cortexActivity: Record<string, ActivityState>;
  renamingSessionId: string | null;
  onOpenSession: (session: ShellSession) => void;
  onContextMenuSession: (event: MouseEvent<HTMLElement>, session: ShellSession) => void;
  onCommitRename: (session: ShellSession, value: string) => void;
  onCancelRename: () => void;
}) {
  const [collapsed, setCollapsed] = useState(Boolean(defaultCollapsed));
  const isCollapsible = Boolean(collapsible);
  const showBody = !isCollapsible || !collapsed;
  const isRows = variant === 'strip' || variant === 'compact';

  const headerInner = (
    <>
      {isCollapsible ? (
        <CaretRight
          size={12}
          weight="bold"
          className={caretClass}
          data-open={collapsed ? undefined : 'true'}
        />
      ) : null}
      {icon ? <span data-testid={`dashboard-rail-icon-${sectionKey}`}>{icon}</span> : null}
      <Typography
        as={isCollapsible ? 'span' : 'h2'}
        variant="caption"
        tone={tone === 'attention' ? 'warn' : 'faint'}
        uppercase
        style={{ letterSpacing: '0.10em' }}
      >
        {title}
      </Typography>
      <Typography as="span" variant="caption" tone="ghost" className={dashboardRailCountClass}>
        {sessions.length}
      </Typography>
    </>
  );

  return (
    <section
      className={dashboardRailClass}
      data-tone={tone}
      data-variant={variant}
      data-testid={`dashboard-rail-${sectionKey}`}
    >
      {isCollapsible ? (
        <button
          type="button"
          className={dashboardRailToggleClass}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(value => !value)}
          data-testid={`dashboard-rail-toggle-${sectionKey}`}
        >
          {headerInner}
        </button>
      ) : (
        <header className={dashboardRailHeaderClass}>{headerInner}</header>
      )}

      {showBody ? (
        isRows ? (
          <div className={dashboardRowsClass}>
            {sessions.map(session => (
              <SessionRailRow
                key={session.id}
                session={session}
                shell={shell}
                isBound={Boolean(bindings[session.id])}
                activity={activityForSession(session, cortexActivity)}
                tone={tone}
                showStatus={variant === 'strip'}
                renaming={renamingSessionId === session.id}
                onOpen={() => onOpenSession(session)}
                onContextMenu={event => onContextMenuSession(event, session)}
                onCommitRename={value => onCommitRename(session, value)}
                onCancelRename={onCancelRename}
              />
            ))}
          </div>
        ) : (
          <div
            className={variant === 'prominent' ? dashboardProminentCardsClass : dashboardCardsClass}
          >
            {sessions.map(session => (
              <SessionDashboardCard
                key={session.id}
                session={session}
                shell={shell}
                isBound={Boolean(bindings[session.id])}
                activity={activityForSession(session, cortexActivity)}
                tone={tone}
                prominent={variant === 'prominent'}
                renaming={renamingSessionId === session.id}
                onOpen={() => onOpenSession(session)}
                onContextMenu={event => onContextMenuSession(event, session)}
                onCommitRename={value => onCommitRename(session, value)}
                onCancelRename={onCancelRename}
              />
            ))}
          </div>
        )
      ) : null}
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
});

// The collapsible header is a real button (keyboard + a11y), but reads like the
// static header: no chrome, just a hover tint and the caret that rotates open.
const dashboardRailToggleClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  alignSelf: 'flex-start',
  margin: '-4px -6px',
  padding: '4px 6px',
  borderRadius: '7px',
  border: 'none',
  background: 'transparent',
  color: 'var(--text-3)',
  cursor: 'pointer',
  transition: 'background 140ms ease',
  _hover: { background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)' },
  '& > span': {
    display: 'inline-flex',
    color: 'var(--warn)',
  },
});

const caretClass = css({
  flexShrink: 0,
  color: 'var(--text-4)',
  transition: 'transform 140ms ease',
  '&[data-open="true"]': { transform: 'rotate(90deg)' },
});

// Residual only (tabular figures); size + color come from the variant + tone.
const dashboardRailCountClass = css({
  fontVariantNumeric: 'tabular-nums',
});

const dashboardCardsClass = css({
  display: 'grid',
  gap: '12px',
  gridTemplateColumns: 'repeat(auto-fill, minmax(228px, 1fr))',
});

// The "act now" tiers get wider cards with room for context and inline actions, so
// they read as the heaviest thing on the surface.
const dashboardProminentCardsClass = css({
  display: 'grid',
  gap: '14px',
  gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
});

const dashboardRowsClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
});
