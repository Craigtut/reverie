import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { CircleDashed, MagnifyingGlass } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { agentTabLabel, buildPaletteEntries, filterPalette } from '../../domain';
import type { ShellSession } from '../../domain';
import { useActivityStore, usePaletteStore, useShellStore } from '../../store';
import { AgentGlyph } from '../glyphs';
import { Kbd } from '../primitives/Kbd';
import { Typography } from '../primitives/Typography';

// Cmd/Ctrl+K command palette: fuzzy-jump to any focus or session in the
// workspace. Reads its query + the shell snapshot + activity from the stores;
// callers supply only what to do on close / pick.
export function CommandPalette({
  onClose,
  onPickSession,
  onPickFocus,
}: {
  onClose: () => void;
  onPickSession: (session: ShellSession) => void;
  onPickFocus: (projectId: string | null, focusId: string) => void;
}) {
  const query = usePaletteStore(s => s.paletteQuery);
  const setQuery = usePaletteStore(s => s.setPaletteQuery);
  const shell = useShellStore(s => s.shell);
  const cortexActivity = useActivityStore(s => s.cortexActivity);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const entries = useMemo(
    () => buildPaletteEntries(shell, cortexActivity),
    [shell, cortexActivity],
  );
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
            placeholder="Jump to a topic or session…"
            aria-label="Command palette query"
            data-testid="command-palette-input"
            onChange={event => setQuery(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
          <Kbd keys={['⌘', 'K']} />
        </div>
        <ul className={paletteListClass} data-testid="command-palette-results">
          {filtered.length === 0 ? (
            <Typography
              as="li"
              variant="caption"
              tone="faint"
              align="center"
              className={paletteEmptyClass}
            >
              No matches
            </Typography>
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
                      <Typography as="strong" variant="smallBody" tone="inherit" truncate>
                        {entry.title}
                      </Typography>
                      <Typography as="small" variant="caption" tone="faint" truncate>
                        {entry.projectName ? `${entry.projectName} · ` : ''}Focus ·{' '}
                        {entry.sessionCount} session{entry.sessionCount === 1 ? '' : 's'}
                      </Typography>
                    </span>
                  </>
                ) : (
                  <>
                    <AgentGlyph kind={entry.session.agentKind} />
                    <span className={paletteItemLabelClass}>
                      <Typography as="strong" variant="smallBody" tone="inherit" truncate>
                        {agentTabLabel(entry.session)}
                      </Typography>
                      <Typography as="small" variant="caption" tone="faint" truncate>
                        {entry.breadcrumb} · {entry.session.cwd}
                      </Typography>
                    </span>
                    {entry.activity ? (
                      <Typography
                        as="span"
                        variant="tiny"
                        tone="inherit"
                        uppercase
                        className={paletteItemStatusClass}
                        data-status={entry.activity.status}
                        style={{ letterSpacing: '0.06em' }}
                      >
                        {entry.activity.status.replace(/_/g, ' ')}
                      </Typography>
                    ) : null}
                  </>
                )}
              </li>
            ))
          )}
        </ul>
        <div className={paletteFooterClass}>
          <span className={paletteFooterHintClass}>
            <Kbd keys={['↑']} />
            <Kbd keys={['↓']} />
            <Typography as="span" variant="tiny" tone="faint">
              Move
            </Typography>
          </span>
          <span className={paletteFooterHintClass}>
            <Kbd keys={['⏎']} />
            <Typography as="span" variant="tiny" tone="faint">
              Open
            </Typography>
          </span>
          <span className={paletteFooterHintClass}>
            <Kbd keys={['Esc']} />
            <Typography as="span" variant="tiny" tone="faint">
              Close
            </Typography>
          </span>
        </div>
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

const paletteFooterClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '16px',
  padding: '8px 14px',
  borderTop: '1px solid var(--line)',
  color: 'var(--text-3)',
});

const paletteFooterHintClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
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
});

const paletteItemStatusClass = css({
  color: 'var(--text-3)',
  '&[data-status="working"]': { color: 'var(--good)' },
  '&[data-status="awaiting_permission"]': { color: 'var(--warn)' },
  '&[data-status="awaiting_response"]': { color: 'var(--warn)' },
  '&[data-status="error"]': { color: 'var(--bad)' },
});

const paletteEmptyClass = css({
  padding: '14px 10px',
});
