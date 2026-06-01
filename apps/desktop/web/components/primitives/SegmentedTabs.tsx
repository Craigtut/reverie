import type { ReactNode } from 'react';

import { css } from '../../styled-system/css';
import { Typography } from './Typography';

export interface SegmentedTabItem<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
}

// A reusable segmented control for switching between sibling views (e.g. the
// Settings sections). Shares the app's "active = filled --surface-3 pill" language
// with the theme toggle, so the page reads as one family. Presentational: the
// caller owns the selected id.
export function SegmentedTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  idBase,
  className,
}: {
  tabs: SegmentedTabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  // When set, wires aria so each tab points at `${idBase}-panel-${id}`.
  idBase?: string;
  className?: string;
}) {
  return (
    <div
      className={className ? `${groupClass} ${className}` : groupClass}
      role="tablist"
      aria-label={ariaLabel}
    >
      {tabs.map(tab => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={idBase ? `${idBase}-tab-${tab.id}` : undefined}
            aria-selected={active}
            aria-controls={idBase ? `${idBase}-panel-${tab.id}` : undefined}
            data-active={active}
            data-testid={`segmented-tab-${tab.id}`}
            className={tabClass}
            onClick={() => onChange(tab.id)}
          >
            {tab.icon}
            <Typography as="span" variant="caption" tone="inherit">
              {tab.label}
            </Typography>
          </button>
        );
      })}
    </div>
  );
}

const groupClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '2px',
  padding: '3px',
  borderRadius: '999px',
  border: '1px solid var(--line)',
  background: 'color-mix(in srgb, var(--surface-1) 80%, transparent)',
});

const tabClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  height: '28px',
  padding: '0 14px',
  borderRadius: '999px',
  border: '0',
  background: 'transparent',
  color: 'var(--text-3)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'color 140ms ease, background 140ms ease, box-shadow 140ms ease',
  '& svg': { color: 'currentcolor' },
  _hover: { color: 'var(--text-2)' },
  '&[data-active="true"]': {
    color: 'var(--text)',
    background: 'var(--surface-3)',
    boxShadow: 'inset 0 0 0 1px var(--line-strong)',
  },
});
