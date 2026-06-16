import type { MouseEvent, ReactNode } from 'react';
import { CaretRight, Plus } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import type { SessionRollup, ShellFocus } from '../../domain';
import { Typography } from '../primitives/Typography';
import { InlineRename } from './InlineRename';
import {
  caretIconClass,
  rowAccentClass,
  rowActionClass,
  rowAttentionBadgeClass,
  rowCaretButtonClass,
  rowLabelClass,
  rowMetaClass,
  rowPrimaryClass,
  rowReadyBadgeClass,
  rowShellClass,
  rowTrailingCapClass,
  rowTrailingClass,
} from './navStyles';

// A focus in the left nav, rendered as an accordion. The caret toggles its
// nested sessions; the row body opens the focus dashboard. The leading dot is the
// topic's ambient liveness mark, matching the project folder and Home house: it
// breathes a slow green halo while any session inside is working, falls back to a
// steady amber only when nothing is live but something needs you, and otherwise
// rests ambient. The trailing slot counts the demands (a warn "needs you" badge,
// a neutral "ready" badge) plus the total, all crossfading on hover to a plus
// that adds a session to this topic. When the focus is the active surface a short
// accent lights its left gutter, clear of the caret.
export function FocusRow({
  focus,
  rollup,
  active,
  expanded,
  renaming,
  onToggle,
  onOpen,
  onAddSession,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onContextMenu,
  children,
}: {
  focus: ShellFocus;
  rollup: SessionRollup;
  active: boolean;
  expanded: boolean;
  renaming: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onAddSession: (event: MouseEvent<HTMLElement>) => void;
  onStartRename: () => void;
  onCommitRename: (value: string) => void;
  onCancelRename: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  children: ReactNode;
}) {
  return (
    <div className={focusGroupClass}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: right-click opens the nav context menu; the row's real targets are its inner buttons */}
      <div
        className={rowShellClass}
        data-active={active ? 'true' : 'false'}
        onContextMenu={onContextMenu}
      >
        {active ? <span className={rowAccentClass} aria-hidden="true" /> : null}
        <button
          className={rowCaretButtonClass}
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          title={expanded ? `Collapse ${focus.title}` : `Expand ${focus.title}`}
          data-testid="focus-toggle-button"
          data-expanded={expanded ? 'true' : 'false'}
        >
          <span className={caretIconClass(expanded)}>
            <CaretRight size={10} weight="bold" />
          </span>
        </button>
        {renaming ? (
          <div className={rowPrimaryClass}>
            <span
              className={focusDotBaseClass}
              data-live={rollup.active > 0 ? 'true' : undefined}
              style={focusDotStyle(rollup)}
              aria-hidden="true"
            />
            <InlineRename
              initialValue={focus.title}
              ariaLabel={`Rename topic ${focus.title}`}
              onCommit={onCommitRename}
              onCancel={onCancelRename}
            />
          </div>
        ) : (
          <button
            className={rowPrimaryClass}
            type="button"
            onClick={onOpen}
            onDoubleClick={onStartRename}
            data-testid="nav-focus-open"
            data-focus-title={focus.title}
          >
            <span
              className={focusDotBaseClass}
              data-live={rollup.active > 0 ? 'true' : undefined}
              style={focusDotStyle(rollup)}
              aria-hidden="true"
            />
            <Typography as="span" variant="smallBody" tone="inherit" className={rowLabelClass}>
              {focus.title}
            </Typography>
          </button>
        )}
        <div className={rowTrailingClass}>
          {rollup.attention > 0 ? (
            <Typography
              as="span"
              variant="caption"
              tone="warn"
              className={rowAttentionBadgeClass}
              data-row-meta="true"
              title={`${rollup.attention} need${rollup.attention === 1 ? 's' : ''} you`}
            >
              {rollup.attention}
            </Typography>
          ) : null}
          {rollup.finished > 0 ? (
            <Typography
              as="span"
              variant="caption"
              tone="muted"
              className={rowReadyBadgeClass}
              data-row-meta="true"
              title={`${rollup.finished} ready for you`}
            >
              {rollup.finished}
            </Typography>
          ) : null}
          <span className={rowTrailingCapClass}>
            {rollup.total ? (
              <Typography
                as="span"
                variant="caption"
                tone="ghost"
                className={rowMetaClass}
                data-row-meta="true"
              >
                {rollup.total}
              </Typography>
            ) : null}
            <button
              className={rowActionClass}
              type="button"
              onClick={onAddSession}
              title={`New session in ${focus.title}`}
              data-testid="focus-add-session-button"
              data-row-action="true"
            >
              <Plus size={13} weight="bold" />
            </button>
          </span>
        </div>
      </div>
      {expanded ? <div className={focusChildrenClass}>{children}</div> : null}
    </div>
  );
}

const focusGroupClass = css({
  display: 'grid',
  // See ProjectGroup: a shrinkable single column so long titles truncate inside
  // the row rather than widening the track past the rail.
  gridTemplateColumns: 'minmax(0, 1fr)',
  gap: '1px',
});

// The rollup dot. Color and resting ring ride an inline style over this static
// base; when live, the data-live rule swaps the ring for the slow breathing halo
// (its keyframe's box-shadow overrides the inline one while it plays, then the
// inline value resumes if work stops). Liveness wins the dot over attention so a
// working topic still reads as alive even while a session needs you.
const focusDotBaseClass = css({
  width: '6px',
  height: '6px',
  borderRadius: '50%',
  flexShrink: 0,
  transition: 'background 160ms ease, box-shadow 160ms ease',
  '&[data-live="true"]': { animation: 'reverie-live-ring 4s ease-in-out infinite' },
});

function focusDotStyle(rollup: SessionRollup): { background: string; boxShadow: string } {
  if (rollup.active > 0) {
    // Solid green; the breathing halo comes from the data-live class rule, so
    // this resting ring is just its low point (shown if motion is reduced).
    return {
      background: 'var(--good)',
      boxShadow: '0 0 0 2px color-mix(in srgb, var(--good) 9%, transparent)',
    };
  }
  if (rollup.attention > 0) {
    return { background: 'var(--warn)', boxShadow: '0 0 0 3px rgba(229,162,78,0.13)' };
  }
  return { background: 'var(--dot-ambient)', boxShadow: 'none' };
}

const focusChildrenClass = css({
  marginLeft: '9px',
  paddingLeft: '8px',
  borderLeft: '1px solid var(--line-faint)',
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gap: '1px',
});
