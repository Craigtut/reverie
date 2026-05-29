import { css } from '../../styled-system/css';
import { agentTabLabel, glyphStateFor, plainLanguageStatus, sessionBreadcrumb } from '../../domain';
import type {
  ActivityState,
  DashboardStatus,
  ShellSession,
  WorkspaceShellSnapshot,
} from '../../domain';
import { AgentGlyph, SessionStatusGlyph } from '../glyphs';
import { ConnectionChip } from '../connections';
import { Typography } from '../primitives/Typography';
import { useConnectionPanelStore } from '../../store';

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
  const openConnectionPanel = useConnectionPanelStore(s => s.openForSession);

  // The card is a `role="button"` div rather than a native `<button>` so the
  // ConnectionChip (itself an interactive `<button>`) can be nested without
  // producing invalid HTML / ambiguous keyboard semantics.
  return (
    <div
      role="button"
      tabIndex={0}
      className={dashboardCardClass}
      data-tone={tone}
      data-activity-status={activity?.status ?? 'none'}
      data-testid="dashboard-session-card"
      data-session-id={session.id}
      onClick={onOpen}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className={dashboardCardTopClass}>
        <AgentGlyph kind={session.agentKind} />
        <SessionStatusGlyph state={glyphStateFor(activity, tone)} />
        <span className={chipSlotClass}>
          <ConnectionChip sessionId={session.id} onOpenPanel={openConnectionPanel} />
        </span>
      </div>
      <Typography as="div" variant="smallBody" tone="default" className={dashboardCardTitleClass}>
        {agentTabLabel(session)}
      </Typography>
      <Typography as="div" variant="caption" tone="faint" className={dashboardCardBreadcrumbClass}>
        {breadcrumb}
      </Typography>
      <Typography
        as="div"
        variant="tiny"
        tone="faint"
        uppercase
        style={{ letterSpacing: '0.06em' }}
      >
        {statusLabel}
      </Typography>
      {permission ? (
        <Typography
          as="div"
          variant="caption"
          tone="warn"
          className={dashboardCardPermissionClass}
          style={{
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          }}
          data-testid="dashboard-card-permission-summary"
        >
          {permission.displaySummary}
        </Typography>
      ) : null}
    </div>
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
  transition:
    'border-color 140ms ease, transform 140ms cubic-bezier(0.22, 1, 0.36, 1), background 140ms ease',
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
  gap: '8px',
  justifyContent: 'space-between',
  width: '100%',
  color: 'var(--text-3)',
});

const chipSlotClass = css({
  marginLeft: 'auto',
});

// Layout only; size/weight/color come from the Typography variant + tone.
const dashboardCardTitleClass = css({
  width: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const dashboardCardBreadcrumbClass = css({
  width: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const dashboardCardPermissionClass = css({
  marginTop: '2px',
  width: '100%',
  padding: '6px 8px',
  background: 'color-mix(in srgb, var(--warn) 10%, transparent)',
  border: '1px solid color-mix(in srgb, var(--warn) 28%, transparent)',
  borderRadius: '8px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
