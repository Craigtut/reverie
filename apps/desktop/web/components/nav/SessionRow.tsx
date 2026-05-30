import type { MouseEvent } from 'react';

import { css, cx } from '../../styled-system/css';
import { agentTabLabel } from '../../domain';
import type { CellSessionState, ShellSession } from '../../domain';
import { AgentGlyph, CloseGlyph, StateCell } from '../glyphs';
import { Typography } from '../primitives/Typography';
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
// gutter when this is the session on stage.
export function SessionRow({
  session,
  active,
  cellState,
  onOpen,
  onClose,
}: {
  session: ShellSession;
  active: boolean;
  cellState: CellSessionState;
  onOpen: () => void;
  onClose: (event: MouseEvent<HTMLElement>) => void;
}) {
  const label = agentTabLabel(session);
  return (
    <div className={rowShellClass} data-active={active ? 'true' : 'false'}>
      {active ? <span className={rowAccentClass} aria-hidden="true" /> : null}
      <button
        className={cx(rowPrimaryClass, sessionPrimaryClass)}
        type="button"
        onClick={onOpen}
        data-testid="nav-session-row"
        data-session-id={session.id}
        data-session-state={cellState}
      >
        <AgentGlyph kind={session.agentKind} />
        <Typography as="span" variant="smallBody" tone="inherit" className={rowLabelClass}>
          {label}
        </Typography>
      </button>
      <div className={rowTrailingClass}>
        <span className={rowTrailingCapClass}>
          <span className={cellWrapClass} data-row-meta="true">
            <StateCell state={cellState} size={16} />
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
    </div>
  );
}

// Sessions have no caret, so nudge the primary in to roughly align its glyph
// under the parent focus label.
const sessionPrimaryClass = css({
  paddingLeft: '6px',
});

// The live cell shares the trailing slot with the close action and crossfades
// out as the action fades in (the shell hover rule toggles [data-row-meta]).
const cellWrapClass = css({
  display: 'grid',
  placeItems: 'center',
  transition: 'opacity 120ms ease',
});
