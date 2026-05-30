import type { MouseEvent, ReactNode } from 'react';
import { CaretRight } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import type { DashboardStatus, SessionRollup, ShellFocus } from '../../domain';
import { CloseGlyph } from '../glyphs';
import { Typography } from '../primitives/Typography';
import {
  caretIconClass,
  rowAccentClass,
  rowActionClass,
  rowAttentionBadgeClass,
  rowCaretButtonClass,
  rowLabelClass,
  rowMetaClass,
  rowPrimaryClass,
  rowShellClass,
  rowTrailingCapClass,
  rowTrailingClass,
} from './navStyles';

// A focus in the left nav, rendered as an accordion. The caret toggles its
// nested sessions; the row body opens the focus dashboard. The leading dot rolls
// the worst session state upward (warn = needs you, good = active, ambient =
// idle); the trailing slot shows the total plus a warn "needs you" badge, both
// crossfading to the remove action on hover. When the focus is the active
// surface a short accent lights its left gutter, clear of the caret.
export function FocusRow({
  focus,
  rollup,
  active,
  expanded,
  onToggle,
  onOpen,
  onRemoveFocus,
  children,
}: {
  focus: ShellFocus;
  rollup: SessionRollup;
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onRemoveFocus: (event: MouseEvent<HTMLElement>) => void;
  children: ReactNode;
}) {
  return (
    <div className={focusGroupClass}>
      <div className={rowShellClass} data-active={active ? 'true' : 'false'}>
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
        <button
          className={rowPrimaryClass}
          type="button"
          onClick={onOpen}
          data-testid="nav-focus-open"
          data-focus-title={focus.title}
        >
          <span
            className={focusDotBaseClass}
            style={focusDotStyle(rollup.tone)}
            aria-hidden="true"
          />
          <Typography as="span" variant="smallBody" tone="inherit" className={rowLabelClass}>
            {focus.title}
          </Typography>
        </button>
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
              onClick={onRemoveFocus}
              title={`Remove focus ${focus.title}`}
              data-testid="remove-focus-button"
              data-row-action="true"
            >
              <CloseGlyph size={11} />
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
  gap: '1px',
});

// The rollup dot: colored by the worst state in the focus, with a soft ring when
// something is live or wants the user so it reads as "alive" at a glance. Color
// and ring are dynamic, so they ride an inline style over a static base class.
const focusDotBaseClass = css({
  width: '6px',
  height: '6px',
  borderRadius: '50%',
  flexShrink: 0,
  transition: 'background 160ms ease, box-shadow 160ms ease',
});

function focusDotStyle(tone: DashboardStatus): { background: string; boxShadow: string } {
  if (tone === 'attention') {
    return { background: 'var(--warn)', boxShadow: '0 0 0 3px rgba(229,162,78,0.13)' };
  }
  if (tone === 'live') {
    return { background: 'var(--good)', boxShadow: '0 0 0 3px rgba(111,184,122,0.12)' };
  }
  return { background: 'var(--dot-ambient)', boxShadow: 'none' };
}

const focusChildrenClass = css({
  marginLeft: '9px',
  paddingLeft: '8px',
  borderLeft: '1px solid var(--line-faint)',
  display: 'grid',
  gap: '1px',
});
