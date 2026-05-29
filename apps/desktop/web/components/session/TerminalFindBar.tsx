import { useEffect, useRef, type KeyboardEvent } from 'react';

import { css } from '../../styled-system/css';
import { Typography } from '../primitives/Typography';

export interface TerminalFindBarProps {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  current: number; // 1-based; 0 when there are no matches
  total: number;
  capped: boolean;
  busy: boolean;
  onQueryChange: (query: string) => void;
  onToggleCase: () => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

// The terminal find bar: a calm, monochrome strip pinned to the top-right of the
// terminal viewport. Dumb component driven by the terminal hook; Enter = next,
// Shift-Enter = prev, Esc = close. The count reads "3 / 12" (or "3 / 2000+" when
// capped, "0 / 0" when empty).
export function TerminalFindBar({
  open,
  query,
  caseSensitive,
  current,
  total,
  capped,
  busy,
  onQueryChange,
  onToggleCase,
  onNext,
  onPrev,
  onClose,
}: TerminalFindBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus + select the query whenever the bar opens, so re-opening with a
  // prefill lets the user immediately type over it.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);

  if (!open) return null;

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) onPrev();
      else onNext();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  const countLabel = `${current} / ${capped ? `${total}+` : total}`;
  const hasMatches = total > 0;

  return (
    <div className={barClass} data-testid="terminal-find-bar" role="search">
      <input
        ref={inputRef}
        type="text"
        className={inputClass}
        data-testid="terminal-find-input"
        placeholder="Find"
        aria-label="Find in terminal"
        value={query}
        onChange={event => onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <Typography
        as="span"
        variant="caption"
        tone={hasMatches ? 'muted' : 'faint'}
        data-testid="terminal-find-count"
        className={countClass}
      >
        {busy ? '…' : countLabel}
      </Typography>
      <button
        type="button"
        className={toggleClass}
        data-testid="terminal-find-case-toggle"
        aria-pressed={caseSensitive}
        data-active={caseSensitive ? 'true' : undefined}
        title="Match case"
        onClick={onToggleCase}
      >
        <Typography as="span" variant="caption" tone="inherit">
          Aa
        </Typography>
      </button>
      <button
        type="button"
        className={iconButtonClass}
        data-testid="terminal-find-prev"
        title="Previous match"
        disabled={!hasMatches}
        onClick={onPrev}
      >
        <Typography as="span" variant="caption" tone="inherit">
          ↑
        </Typography>
      </button>
      <button
        type="button"
        className={iconButtonClass}
        data-testid="terminal-find-next"
        title="Next match"
        disabled={!hasMatches}
        onClick={onNext}
      >
        <Typography as="span" variant="caption" tone="inherit">
          ↓
        </Typography>
      </button>
      <button
        type="button"
        className={iconButtonClass}
        data-testid="terminal-find-close"
        title="Close (Esc)"
        onClick={onClose}
      >
        <Typography as="span" variant="caption" tone="inherit">
          ✕
        </Typography>
      </button>
    </div>
  );
}

const barClass = css({
  position: 'absolute',
  top: '8px',
  right: '12px',
  zIndex: 40,
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '5px 7px',
  background: 'color-mix(in srgb, var(--surface-1) 96%, transparent)',
  border: '1px solid var(--line-strong)',
  borderRadius: '10px',
  boxShadow: '0 18px 44px -18px rgba(0,0,0,0.5)',
  backdropFilter: 'blur(10px)',
});

const inputClass = css({
  width: '180px',
  padding: '3px 6px',
  border: '1px solid var(--line)',
  borderRadius: '6px',
  background: 'var(--surface-2)',
  color: 'var(--text)',
  fontSize: '12px',
  outline: 'none',
  _focus: { borderColor: 'var(--line-strong)' },
});

const countClass = css({
  minWidth: '54px',
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
});

const toggleClass = css({
  display: 'flex',
  alignItems: 'center',
  padding: '2px 6px',
  border: '1px solid var(--line)',
  borderRadius: '6px',
  background: 'transparent',
  color: 'var(--text-3)',
  cursor: 'pointer',
  transition: 'color 120ms ease, border-color 120ms ease',
  _hover: { color: 'var(--text)' },
  '&[data-active="true"]': { color: 'var(--text)', borderColor: 'var(--line-strong)' },
});

const iconButtonClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '22px',
  height: '22px',
  border: 0,
  borderRadius: '6px',
  background: 'transparent',
  color: 'var(--text-3)',
  cursor: 'pointer',
  transition: 'background 120ms ease, color 120ms ease',
  _hover: { background: 'var(--surface-3)', color: 'var(--text)' },
  '&:disabled': { opacity: 0.4, cursor: 'default', _hover: { background: 'transparent' } },
});
