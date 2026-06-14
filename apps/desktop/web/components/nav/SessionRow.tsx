import type { MouseEvent } from 'react';

import { css, cx } from '../../styled-system/css';
import { agentTabLabel } from '../../domain';
import type { CellSessionState, ShellSession } from '../../domain';
import { AgentGlyph, CloseGlyph, StateCell } from '../glyphs';
import { Typography } from '../primitives/Typography';
import { InlineRename } from './InlineRename';
import {
  rowAccentClass,
  rowActionClass,
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
    // biome-ignore lint/a11y/noStaticElementInteractions: right-click opens the nav context menu; the row's real targets are its inner buttons
    <div
      className={cx(rowShellClass, active && sessionShellRevealedClass)}
      data-active={active ? 'true' : 'false'}
      onContextMenu={onContextMenu}
    >
      {active ? <span className={rowAccentClass} aria-hidden="true" /> : null}
      {renaming ? (
        <div className={cx(rowPrimaryClass, sessionPrimaryClass)}>
          <AgentGlyph kind={session.agentKind} />
          <InlineRename
            initialValue={label}
            ariaLabel={`Rename ${label}`}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        </div>
      ) : (
        <button
          className={cx(rowPrimaryClass, sessionPrimaryClass)}
          type="button"
          onClick={onOpen}
          onDoubleClick={onStartRename}
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
              className={rowActionClass}
              type="button"
              onClick={onClose}
              title={`Close ${label}`}
              data-testid="nav-session-close-button"
              data-row-action="true"
            >
              <CloseGlyph size={11} />
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
