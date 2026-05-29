import type { MouseEvent } from 'react';
import { TerminalWindow, X } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import type { ShellFocus } from '../../domain';
import { navRowActionClass, navRowActionWrapClass, rowLabelClass, rowMetaClass } from './navStyles';

// A focus row in the left nav: live dot + title + session count, with
// hover-revealed history and remove actions.
export function FocusRow({ focus, count, active, live, onClick, onHistory, onRemoveFocus }: {
  focus: ShellFocus;
  count: number;
  active: boolean;
  live: boolean;
  onClick: () => void;
  onHistory: (event: MouseEvent<HTMLElement>) => void;
  onRemoveFocus: (event: MouseEvent<HTMLElement>) => void;
}) {
  return (
    <div className={navRowActionWrapClass}>
      <button className={focusRowClass({ active })} type="button" onClick={onClick}>
        <span className={focusDotClass({ live })} />
        <span className={rowLabelClass}>{focus.title}</span>
        <span className={rowMetaClass}>{count || ''}</span>
      </button>
      <button className={navRowActionClass} type="button" onClick={onHistory} title={`View session history for ${focus.title}`} data-testid="focus-session-history-button">
        <TerminalWindow size={12} />
      </button>
      <button className={navRowActionClass} type="button" onClick={onRemoveFocus} title={`Remove focus ${focus.title}`} data-testid="remove-focus-button">
        <X size={11} />
      </button>
    </div>
  );
}

function focusRowClass({ active }: { active: boolean }) {
  return css({
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    padding: '5px 10px',
    borderRadius: '8px',
    color: active ? 'var(--text)' : 'var(--text-2)',
    background: active ? 'var(--surface-3)' : 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    position: 'relative',
    _hover: { background: 'var(--surface-2)', color: 'var(--text)' },
    '&::before': active ? {
      content: '""',
      position: 'absolute',
      left: '-8px',
      top: '50%',
      transform: 'translateY(-50%)',
      width: '3px',
      height: '16px',
      background: 'var(--text)',
      borderRadius: '2px',
    } : {},
  });
}

function focusDotClass({ live }: { live: boolean }) {
  return css({
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: live ? 'var(--good)' : 'var(--dot-ambient)',
    boxShadow: live ? '0 0 0 3px rgba(111,184,122,0.12)' : 'none',
    flexShrink: 0,
  });
}
