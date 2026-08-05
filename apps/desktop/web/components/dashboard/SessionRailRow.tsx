import type { MouseEvent } from 'react';
import { BookmarkSimple } from '@phosphor-icons/react';

import { css, cx } from '../../styled-system/css';
import { liveHaloClass } from '../glyphs';
import {
  agentTabLabel,
  isFollowingUp,
  plainLanguageStatus,
  relativeTimeFromSeconds,
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
  lastActiveAt,
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
  // When the agent was last active, as epoch ms. When set, the row shows a
  // far-right "x ago" sticker so an at-rest session carries how stale it is.
  lastActiveAt?: number | null;
  renaming: boolean;
  onOpen: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onCommitRename: (value: string) => void;
  onCancelRename: () => void;
}) {
  const { project, topic } = sessionContext(session, shell);
  const followingUp = isFollowingUp(session, activity);
  const statusText = showStatus ? plainLanguageStatus(session, isBound, activity) : null;
  const lastActiveLabel =
    typeof lastActiveAt === 'number' ? relativeTimeFromSeconds(lastActiveAt / 1000) : null;

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
        className={cx(rowDotClass, liveHaloClass)}
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
      {lastActiveLabel ? (
        <Typography
          as="span"
          variant="caption"
          tone="ghost"
          className={rowAgeClass}
          title={`Last active ${lastActiveLabel}`}
        >
          {lastActiveLabel}
        </Typography>
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
  // Scope this row's layout and style invalidation to itself, so one session
  // changing status or title cannot make WebKit re-check the whole rail. Only
  // `layout style`, never `paint`: paint containment would clip the live halo
  // that overhangs the 6px status dot. Layout containment also makes the row a
  // containing block for positioned descendants, which is safe here because the
  // only position:fixed element in this tree is NavContextMenu, and that renders
  // as a sibling of the rail rather than inside a row.
  contain: 'layout style',
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

// The breathing halo itself lives in liveHaloClass (composited transform +
// opacity on a ::after ring); this class is just the solid dot under it.
const rowDotClass = css({
  flexShrink: 0,
  width: '6px',
  height: '6px',
  borderRadius: '50%',
  display: 'inline-block',
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

// A quiet far-right sticker: how long since the agent was last active, so an
// at-rest row carries how stale it is at a glance. Monochrome by design; the
// pill chrome (border + surface tint) keeps it legible over the row's hover
// tint, and tabular figures stop the width from jittering as the label ticks.
const rowAgeClass = css({
  flexShrink: 0,
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
  padding: '1px 7px',
  borderRadius: '999px',
  border: '1px solid var(--line)',
  background: 'color-mix(in srgb, var(--surface-1) 70%, transparent)',
});
