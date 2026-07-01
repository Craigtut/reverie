import { useEffect, useRef, useState } from 'react';

import { css } from '../../styled-system/css';
import { AgentGlyph } from '../glyphs';
import { Typography } from '../primitives/Typography';
import type { AgentCliDetection, AgentKind } from '../../domain';

// The dispatch agent picker: a compact badge showing just the chosen CLI's brand
// icon, with a custom (non-native, so it never blurs the always-on-top window)
// dropdown listing each usable CLI as icon + name. Defaults to the workspace
// default agent.

interface AgentBadgeProps {
  value: AgentKind;
  agents: AgentCliDetection[];
  onChange: (kind: AgentKind) => void;
  onOpenChange?: (open: boolean) => void;
}

export function AgentBadge({ value, agents, onChange, onOpenChange }: AgentBadgeProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const usable = agents.filter(agent => agent.available && agent.enabled);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={rootRef} className={rootClass}>
      <button
        type="button"
        className={badgeClass}
        title="Choose agent"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <AgentGlyph kind={value} />
        <span className={caretClass} aria-hidden="true">
          ▾
        </span>
      </button>
      {open && usable.length > 0 ? (
        <div className={menuClass} role="listbox">
          {usable.map(agent => (
            <button
              key={agent.kind}
              type="button"
              role="option"
              aria-selected={agent.kind === value}
              className={itemClass}
              data-active={agent.kind === value ? 'true' : 'false'}
              onClick={() => {
                onChange(agent.kind);
                setOpen(false);
              }}
            >
              <AgentGlyph kind={agent.kind} />
              <Typography variant="caption" tone={agent.kind === value ? 'default' : 'muted'}>
                {agent.displayName}
              </Typography>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const rootClass = css({ position: 'relative', flexShrink: 0 });

const badgeClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  height: '34px',
  paddingX: '10px',
  borderRadius: '10px',
  border: '1px solid var(--line)',
  background: 'var(--surface-2)',
  cursor: 'pointer',
  transition: 'background 0.15s ease, border-color 0.15s ease',
  _hover: { background: 'var(--surface-3)', borderColor: 'var(--line-strong)' },
  // Lift the brand glyph to a more legible size than its 14px default.
  '& > span:first-child': { width: '18px', height: '18px' },
});

const caretClass = css({ fontSize: '9px', color: 'var(--text-3)', lineHeight: 1 });

const menuClass = css({
  position: 'absolute',
  top: 'calc(100% + 6px)',
  left: 0,
  zIndex: 20,
  minWidth: '180px',
  padding: '4px',
  borderRadius: '10px',
  border: '1px solid var(--line-strong)',
  background: 'var(--surface-1)',
  boxShadow: 'var(--shadow)',
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
});

const itemClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  textAlign: 'left',
  width: '100%',
  height: '32px',
  paddingX: '8px',
  borderRadius: '7px',
  background: 'transparent',
  cursor: 'pointer',
  _hover: { background: 'var(--surface-3)' },
  '&[data-active="true"]': { background: 'var(--surface-3)' },
  '& > span:first-child': { width: '16px', height: '16px' },
});
