import type { MouseEvent } from 'react';

import { css } from '../../styled-system/css';
import { agentTabLabel, cellStateFor, plainLanguageStatus, sessionContext } from '../../domain';
import type {
  ActivityState,
  DashboardStatus,
  ShellSession,
  WorkspaceShellSnapshot,
} from '../../domain';
import { AgentGlyph, StateCell } from '../glyphs';
import { InlineRename } from '../nav/InlineRename';
import { ConnectionChip } from '../connections';
import { Typography } from '../primitives/Typography';
import { useConnectionPanelStore } from '../../store';

// A single session card on the dashboard. The session reads first: its title
// leads (with the agent glyph inline, so the wrapping title forms a clean column
// beside it) and the live StateCell anchors the top-right corner. Project · topic
// sits right beneath as the cross-project key. The card lives inside a status
// rail (attention / live / fresh), so the only status text we add is the live
// activity of a *working* session — what the agent is actually doing, which the
// rail and the cell can't say. Idle/fresh cards would just echo their rail.
export function SessionDashboardCard({
  session,
  shell,
  isBound,
  activity,
  tone,
  renaming,
  onOpen,
  onContextMenu,
  onCommitRename,
  onCancelRename,
}: {
  session: ShellSession;
  shell: WorkspaceShellSnapshot;
  isBound: boolean;
  activity: ActivityState | null;
  tone: DashboardStatus;
  renaming: boolean;
  onOpen: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onCommitRename: (value: string) => void;
  onCancelRename: () => void;
}) {
  const { project, topic } = sessionContext(session, shell);
  const permission = activity?.awaitingPermission ?? null;
  const liveActivity =
    activity?.status === 'working' || activity?.status === 'awaiting_response'
      ? plainLanguageStatus(session, isBound, activity)
      : null;
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
      onClick={renaming ? undefined : onOpen}
      onContextMenu={onContextMenu}
      onKeyDown={event => {
        // While the inline editor is open it owns the keyboard (it stops its own
        // keys from bubbling); the card only opens on Enter/Space at rest.
        if (renaming) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className={cardTopClass}>
        <div className={cardMainClass}>
          <div className={cardEyebrowClass} data-testid="dashboard-card-context">
            <span className={eyebrowGlyphClass}>
              <AgentGlyph kind={session.agentKind} />
            </span>
            <span className={metaContextClass}>
              <Typography as="span" variant="caption" tone="muted">
                {project ?? topic}
              </Typography>
              {project ? (
                <Typography as="span" variant="caption" tone="faint">
                  {` · ${topic}`}
                </Typography>
              ) : null}
            </span>
            <ConnectionChip sessionId={session.id} onOpenPanel={openConnectionPanel} />
          </div>
          {renaming ? (
            <InlineRename
              initialValue={agentTabLabel(session)}
              ariaLabel={`Rename ${agentTabLabel(session)}`}
              onCommit={onCommitRename}
              onCancel={onCancelRename}
            />
          ) : (
            <Typography
              as="div"
              variant="smallBody"
              tone="default"
              className={dashboardCardTitleClass}
            >
              {agentTabLabel(session)}
            </Typography>
          )}
        </div>
        <StateCell state={cellStateFor(session, isBound, activity)} size={32} />
      </div>

      {liveActivity ? (
        <Typography as="div" variant="caption" tone="faint" className={dashboardCardStatusClass}>
          {liveActivity}
        </Typography>
      ) : null}

      {permission ? (
        <Typography
          as="div"
          variant="caption"
          tone="warn"
          selectable
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
  gap: '10px',
  padding: '13px 14px',
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

// The content stacks in a left column (context eyebrow, then the session title);
// the status cell anchors its own column on the far right, top-aligned with the
// eyebrow so it never crowds the text.
const cardTopClass = css({
  display: 'flex',
  alignItems: 'flex-start',
  gap: '10px',
});

const cardMainClass = css({
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '5px',
});

// The eyebrow row: the CLI glyph leads, then project · focus, then the (usually
// absent) connection chip. The glyph centers on the caption line.
const cardEyebrowClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '7px',
});

const eyebrowGlyphClass = css({
  flexShrink: 0,
  display: 'inline-flex',
});

// Layout only; size/weight/color come from the Typography variant + tone. The
// card is the full title's home: it wraps to as many lines as the title needs
// (the rail only ever truncates). overflowWrap keeps a pathologically long
// unbroken token from spilling the card.
const dashboardCardTitleClass = css({
  width: '100%',
  overflowWrap: 'anywhere',
});

// Project leads (muted); the topic trails in a fainter tone. One nowrap line that
// ellipsizes from the end so the project survives.
const metaContextClass = css({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const dashboardCardStatusClass = css({
  width: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const dashboardCardPermissionClass = css({
  width: '100%',
  padding: '6px 8px',
  background: 'color-mix(in srgb, var(--warn) 10%, transparent)',
  border: '1px solid color-mix(in srgb, var(--warn) 28%, transparent)',
  borderRadius: '8px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
