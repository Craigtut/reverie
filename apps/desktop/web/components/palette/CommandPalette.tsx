import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { CircleDashed, MagnifyingGlass } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { buildPaletteEntries, filterPalette } from '../../domain';
import type { ShellSession } from '../../domain';
import { useActivityStore, usePaletteStore, useShellStore } from '../../store';
import { AgentGlyph } from '../glyphs';

// Cmd/Ctrl+K command palette: fuzzy-jump to any focus or session in the
// workspace. Reads its query + the shell snapshot + activity from the stores;
// callers supply only what to do on close / pick.
export function CommandPalette({ onClose, onPickSession, onPickFocus }: {
  onClose: () => void;
  onPickSession: (session: ShellSession) => void;
  onPickFocus: (projectId: string | null, focusId: string) => void;
}) {
  const query = usePaletteStore(s => s.paletteQuery);
  const setQuery = usePaletteStore(s => s.setPaletteQuery);
  const shell = useShellStore(s => s.shell);
  const cortexActivity = useActivityStore(s => s.cortexActivity);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const entries = useMemo(() => buildPaletteEntries(shell, cortexActivity), [shell, cortexActivity]);
  const filtered = useMemo(() => filterPalette(entries, query), [entries, query]);
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  function pick(index: number) {
    const entry = filtered[index];
    if (!entry) return;
    if (entry.kind === 'focus') onPickFocus(entry.projectId, entry.id);
    else onPickSession(entry.session);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight(current => Math.min(current + 1, Math.max(filtered.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight(current => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(highlight);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div className={paletteBackdropClass} role="presentation" onMouseDown={onClose}>
      <motion.div
        className={paletteFrameClass}
        data-testid="command-palette"
        initial={{ opacity: 0, y: -8, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
        onMouseDown={event => event.stopPropagation()}
      >
        <div className={paletteInputRowClass}>
          <MagnifyingGlass size={14} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="Jump to a focus or session…"
            aria-label="Command palette query"
            data-testid="command-palette-input"
            onChange={event => setQuery(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
          <span className={paletteHintClass}>Esc</span>
        </div>
        <ul className={paletteListClass} data-testid="command-palette-results">
          {filtered.length === 0 ? (
            <li className={paletteEmptyClass}>No matches</li>
          ) : (
            filtered.map((entry, index) => (
              <li
                key={entry.kind === 'focus' ? `focus-${entry.id}` : `session-${entry.session.id}`}
                className={paletteItemClass}
                data-active={index === highlight}
                data-kind={entry.kind}
                data-testid="command-palette-item"
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={() => pick(index)}
              >
                {entry.kind === 'focus' ? (
                  <>
                    <CircleDashed size={13} />
                    <span className={paletteItemLabelClass}>
                      <strong>{entry.title}</strong>
                      <small>{entry.projectName ? `${entry.projectName} · ` : ''}Focus · {entry.sessionCount} session{entry.sessionCount === 1 ? '' : 's'}</small>
                    </span>
                  </>
                ) : (
                  <>
                    <AgentGlyph kind={entry.session.agentKind} />
                    <span className={paletteItemLabelClass}>
                      <strong>{entry.session.title}</strong>
                      <small>{entry.breadcrumb} · {entry.session.cwd}</small>
                    </span>
                    {entry.activity ? (
                      <span className={paletteItemStatusClass} data-status={entry.activity.status}>
                        {entry.activity.status.replace(/_/g, ' ')}
                      </span>
                    ) : null}
                  </>
                )}
              </li>
            ))
          )}
        </ul>
      </motion.div>
    </div>
  );
}

const paletteBackdropClass = css({
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  paddingTop: '12vh',
  background: 'color-mix(in srgb, var(--bg-deep) 70%, transparent)',
  backdropFilter: 'blur(8px)',
  zIndex: 50,
});

const paletteFrameClass = css({
  width: 'min(640px, calc(100vw - 64px))',
  background: 'color-mix(in srgb, var(--surface-1) 92%, transparent)',
  border: '1px solid var(--line-strong)',
  borderRadius: '16px',
  boxShadow: '0 30px 80px -20px rgba(0,0,0,0.55)',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
});

const paletteInputRowClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '12px 16px',
  borderBottom: '1px solid var(--line)',
  color: 'var(--text-3)',
  '& input': {
    flex: 1,
    minWidth: 0,
    background: 'transparent',
    border: 0,
    outline: 'none',
    color: 'var(--text)',
    fontSize: '14px',
    font: 'inherit',
    fontWeight: 500,
  },
});

const paletteHintClass = css({
  fontSize: '10.5px',
  color: 'var(--text-3)',
  padding: '2px 7px',
  border: '1px solid var(--line)',
  borderRadius: '4px',
  background: 'var(--surface-2)',
});

const paletteListClass = css({
  margin: 0,
  padding: '6px',
  listStyle: 'none',
  maxHeight: '48vh',
  overflowY: 'auto',
});

const paletteItemClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '8px 10px',
  borderRadius: '10px',
  cursor: 'pointer',
  color: 'var(--text-2)',
  '&[data-active="true"]': {
    background: 'var(--surface-3)',
    color: 'var(--text)',
  },
  '& svg': { color: 'var(--text-3)', flexShrink: 0 },
  '&[data-active="true"] svg': { color: 'var(--text)' },
});

const paletteItemLabelClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1px',
  minWidth: 0,
  flex: 1,
  '& strong': {
    fontWeight: 500,
    color: 'inherit',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  '& small': {
    fontSize: '11px',
    color: 'var(--text-3)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

const paletteItemStatusClass = css({
  fontSize: '10.5px',
  fontWeight: 500,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
  '&[data-status="working"]': { color: 'var(--good)' },
  '&[data-status="awaiting_permission"]': { color: 'var(--warn)' },
  '&[data-status="error"]': { color: 'var(--bad)' },
});

const paletteEmptyClass = css({
  padding: '14px 10px',
  textAlign: 'center',
  color: 'var(--text-3)',
  fontSize: '12px',
});
