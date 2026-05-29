import { css } from '../../styled-system/css';
import { agentTabLabel, glyphStateFor, plainLanguageStatus, sessionBreadcrumb } from '../../domain';
import type { ActivityState, DashboardStatus, ShellSession, WorkspaceShellSnapshot } from '../../domain';
import { AgentGlyph, SessionStatusGlyph } from '../glyphs';

// A single session card on the dashboard: agent glyph + live status glyph,
// title, breadcrumb, plain-language status, and an awaiting-permission summary
// when present.
export function SessionDashboardCard({
  session,
  shell,
  isBound,
  activity,
  tone,
  onOpen,
}: {
  session: ShellSession;
  shell: WorkspaceShellSnapshot;
  isBound: boolean;
  activity: ActivityState | null;
  tone: DashboardStatus;
  onOpen: () => void;
}) {
  const breadcrumb = sessionBreadcrumb(session, shell);
  const statusLabel = plainLanguageStatus(session, isBound, activity);
  const permission = activity?.awaitingPermission ?? null;

  return (
    <button
      type="button"
      className={dashboardCardClass}
      data-tone={tone}
      data-activity-status={activity?.status ?? 'none'}
      data-testid="dashboard-session-card"
      data-session-id={session.id}
      onClick={onOpen}
    >
      <div className={dashboardCardTopClass}>
        <AgentGlyph kind={session.agentKind} />
        <SessionStatusGlyph state={glyphStateFor(activity, tone)} />
      </div>
      <div className={dashboardCardTitleClass}>{agentTabLabel(session)}</div>
      <div className={dashboardCardBreadcrumbClass}>{breadcrumb}</div>
      <div className={dashboardCardStatusClass}>{statusLabel}</div>
      {permission ? (
        <div className={dashboardCardPermissionClass} data-testid="dashboard-card-permission-summary">
          {permission.displaySummary}
        </div>
      ) : null}
    </button>
  );
}

const dashboardCardClass = css({
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '8px',
  padding: '14px 14px 13px',
  borderRadius: '14px',
  border: '1px solid var(--line)',
  background: 'color-mix(in srgb, var(--surface-1) 78%, transparent)',
  color: 'var(--text-2)',
  textAlign: 'left',
  cursor: 'pointer',
  overflow: 'hidden',
  transition: 'border-color 140ms ease, transform 140ms cubic-bezier(0.22, 1, 0.36, 1), background 140ms ease',
  _hover: {
    borderColor: 'var(--line-strong)',
    transform: 'translateY(-1px)',
    background: 'color-mix(in srgb, var(--surface-2) 78%, transparent)',
    color: 'var(--text)',
  },
  '&[data-tone="attention"]': {
    borderColor: 'color-mix(in srgb, var(--warn) 35%, var(--line) 65%)',
  },
});

const dashboardCardTopClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  color: 'var(--text-3)',
});

const dashboardCardTitleClass = css({
  fontSize: '14px',
  fontWeight: 500,
  color: 'var(--text)',
  letterSpacing: '-0.005em',
  width: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const dashboardCardBreadcrumbClass = css({
  fontSize: '11px',
  color: 'var(--text-3)',
  width: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const dashboardCardStatusClass = css({
  fontSize: '10.5px',
  fontWeight: 500,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
});

const dashboardCardPermissionClass = css({
  marginTop: '2px',
  width: '100%',
  padding: '6px 8px',
  fontSize: '11.5px',
  color: 'var(--warn)',
  background: 'color-mix(in srgb, var(--warn) 10%, transparent)',
  border: '1px solid color-mix(in srgb, var(--warn) 28%, transparent)',
  borderRadius: '8px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
