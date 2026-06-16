import type { MouseEvent } from 'react';
import { Archive } from '@phosphor-icons/react';

import { css, cx } from '../../styled-system/css';
import { agentTabLabel } from '../../domain';
import type { CellSessionState, ShellSession } from '../../domain';
import { AgentGlyph, StateCell } from '../glyphs';
import { Typography } from '../primitives/Typography';
import { InlineRename } from './InlineRename';
import {
  rowAccentClass,
  rowDangerActionClass,
  rowLabelClass,
  rowPrimaryClass,
  rowShellClass,
  rowTrailingCapClass,
  rowTrailingClass,
} from './navStyles';

// A single session nested under a focus (or directly under General). The row
// body opens the session; the live StateCell sits in the trailing slot and
// crossfades to the close (archive) action on hover. An accent lights the left
// gutter when this is the session on stage. Double-clicking the label (or
// right-click -> Rename) swaps the label for an inline editor.
export function SessionRow({
  session,
  active,
  cellState,
  renaming,
  onOpen,
  onClose,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onContextMenu,
}: {
  session: ShellSession;
  active: boolean;
  cellState: CellSessionState;
  renaming: boolean;
  onOpen: () => void;
  onClose: (event: MouseEvent<HTMLElement>) => void;
  onStartRename: () => void;
  onCommitRename: (value: string) => void;
  onCancelRename: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}) {
  const label = agentTabLabel(session);
  return (
    // The whole row is the rename target: double-clicking anywhere on it (a
    // session has no caret to collide with) starts the inline edit, which is more
    // forgiving than aiming at the text. Right-click opens the context menu.
    // biome-ignore lint/a11y/noStaticElementInteractions: double-click renames and right-click opens the menu; the row's real targets are its inner buttons
    <div
      className={cx(rowShellClass, active && sessionShellRevealedClass)}
      data-active={active ? 'true' : 'false'}
      onContextMenu={onContextMenu}
      onDoubleClick={renaming ? undefined : onStartRename}
    >
      {active ? <span className={rowAccentClass} aria-hidden="true" /> : null}
      {renaming ? (
        <div className={cx(rowPrimaryClass, sessionPrimaryClass)}>
          <AgentGlyph kind={session.agentKind} />
          {/* The ghost label reserves the row's resting height (one or two lines)
              so starting a rename never collapses an on-stage, two-line row; the
              single-line field floats centered over it. */}
          <span className={renameSlotClass}>
            <span
              className={cx(active ? sessionLabelRevealedClass : rowLabelClass, renameGhostClass)}
              aria-hidden="true"
            >
              {label || ' '}
            </span>
            <InlineRename
              initialValue={label}
              ariaLabel={`Rename ${label}`}
              onCommit={onCommitRename}
              onCancel={onCancelRename}
              fill
            />
          </span>
        </div>
      ) : (
        <button
          className={cx(rowPrimaryClass, sessionPrimaryClass)}
          type="button"
          onClick={onOpen}
          data-testid="nav-session-row"
          data-session-id={session.id}
          data-session-state={cellState}
        >
          <AgentGlyph kind={session.agentKind} />
          <Typography
            as="span"
            variant="smallBody"
            tone="inherit"
            className={active ? sessionLabelRevealedClass : rowLabelClass}
          >
            {label}
          </Typography>
        </button>
      )}
      {renaming ? null : (
        <div className={rowTrailingClass}>
          <span className={rowTrailingCapClass}>
            <span className={cellWrapClass} data-row-meta="true">
              <StateCell state={cellState} size={24} />
            </span>
            <button
              className={rowDangerActionClass}
              type="button"
              onClick={onClose}
              title={`Close ${label}`}
              data-testid="nav-session-close-button"
              data-row-action="true"
            >
              <Archive size={14} />
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

// Sessions have no caret, so nudge the primary in to roughly align its glyph
// under the parent focus label.
const sessionPrimaryClass = css({
  paddingLeft: '6px',
});

// The session on stage reveals its full title in the rail: instead of a single
// truncated line it wraps and clamps to two lines, so a long name is legible in
// place without a hover tooltip. Every other row stays single-line (rowLabelClass).
const sessionLabelRevealedClass = css({
  flex: 1,
  minWidth: 0,
  lineClamp: 2,
  userSelect: 'none',
});

// The revealed row is taller (two lines); a little vertical padding keeps the
// title off the active background's rounded edges.
const sessionShellRevealedClass = css({
  paddingTop: '4px',
  paddingBottom: '4px',
});

// The live cell shares the trailing slot with the close action and crossfades
// out as the action fades in (the shell hover rule toggles [data-row-meta]).
const cellWrapClass = css({
  display: 'grid',
  placeItems: 'center',
  transition: 'opacity 120ms ease',
});

// The rename field's slot: a relative box the floating input centers in. It takes
// its height from the ghost label inside it, so the row keeps its resting height.
const renameSlotClass = css({
  position: 'relative',
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
});

// The height-reserving stand-in for the label while editing: laid out like the
// real label (so it wraps to the same one or two lines) but invisible and inert.
const renameGhostClass = css({
  visibility: 'hidden',
  pointerEvents: 'none',
});
