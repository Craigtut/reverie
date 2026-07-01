import type { MouseEvent } from 'react';
import { BookmarkSimple } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import {
  agentTabLabel,
  isFollowingUp,
  plainLanguageStatus,
  sessionContext,
  statusDotColor,
} from '../../domain';
import type {
  ActivityState,
  DashboardStatus,
  ShellSession,
  WorkspaceShellSnapshot,
} from '../../domain';
import { AgentGlyph } from '../glyphs';
import { InlineRename } from '../nav/InlineRename';
import { Typography } from '../primitives/Typography';

// A single-line session row for the low-weight tiers: the ambient "working"
// strip and the collapsed "idle" rows. These tiers need nothing from the user,
// so a row stays glanceable instead of spending a full card. The status dot is a
// plain CSS mark (not the WebGL StateCell) to keep the densest tiers cheap; the
// cell's animated presence is reserved for the cards that actually want it.
export function SessionRailRow({
  session,
  shell,
  isBound,
  activity,
  tone,
  showStatus,
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
  // Whether to show the live "now doing X" line. On for the working strip; off
  // for idle, where the status would only echo the rail ("Waiting for you").
  showStatus: boolean;
  renaming: boolean;
  onOpen: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onCommitRename: (value: string) => void;
  onCancelRename: () => void;
}) {
  const { project, topic } = sessionContext(session, shell);
  const followingUp = isFollowingUp(session, activity);
  const statusText = showStatus ? plainLanguageStatus(session, isBound, activity) : null;

  return (
    <div
      role="button"
      tabIndex={0}
      className={rowClass}
      data-tone={tone}
      data-activity-status={activity?.status ?? 'none'}
      data-testid="dashboard-session-row"
      data-session-id={session.id}
      onClick={renaming ? undefined : onOpen}
      onContextMenu={onContextMenu}
      onKeyDown={event => {
        if (renaming) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <i
        className={rowDotClass}
        data-live={tone === 'live' ? 'true' : undefined}
        style={{ background: statusDotColor(tone) }}
      />
      <span className={rowGlyphClass}>
        <AgentGlyph kind={session.agentKind} />
      </span>
      {renaming ? (
        <InlineRename
          initialValue={agentTabLabel(session)}
          ariaLabel={`Rename ${agentTabLabel(session)}`}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      ) : (
        <Typography as="span" variant="smallBody" tone="default" className={rowTitleClass}>
          {agentTabLabel(session)}
        </Typography>
      )}
      <Typography as="span" variant="caption" tone="faint" className={rowContextClass}>
        {project ? `${project} · ${topic}` : topic}
      </Typography>
      {statusText ? (
        <Typography as="span" variant="caption" tone="faint" className={rowStatusClass}>
          {statusText}
        </Typography>
      ) : null}
      {followingUp ? (
        <BookmarkSimple
          size={13}
          weight="fill"
          className={rowMarkClass}
          aria-label="Following up"
        />
      ) : null}
    </div>
  );
}

const rowClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  minWidth: 0,
  height: '34px',
  padding: '0 12px',
  borderRadius: '9px',
  border: '1px solid transparent',
  color: 'var(--text-2)',
  textAlign: 'left',
  cursor: 'pointer',
  transition: 'background 140ms ease, border-color 140ms ease',
  _hover: {
    background: 'color-mix(in srgb, var(--surface-2) 70%, transparent)',
    borderColor: 'var(--line)',
    color: 'var(--text)',
  },
});

const rowDotClass = css({
  flexShrink: 0,
  width: '6px',
  height: '6px',
  borderRadius: '50%',
  display: 'inline-block',
  '&[data-live="true"]': { animation: 'reverie-live-ring 4s ease-in-out infinite' },
});

const rowGlyphClass = css({
  flexShrink: 0,
  display: 'inline-flex',
});

// The title takes the row's slack but yields to the trailing context/status; it
// ellipsizes rather than wrapping so every row is exactly one line tall.
const rowTitleClass = css({
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const rowContextClass = css({
  flexShrink: 1,
  minWidth: 0,
  maxWidth: '40%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const rowStatusClass = css({
  flexShrink: 0,
  maxWidth: '45%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const rowMarkClass = css({
  flexShrink: 0,
  color: 'var(--text-3)',
});
