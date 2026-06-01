import { Fragment } from 'react';

import { css, cx } from '../../styled-system/css';
import { Typography } from './Typography';

// A small row of keyboard key caps, e.g. ⌘ K. The glyphs are display-only
// (authored mac-style in the shortcuts catalog); the actual handlers live in the
// hooks that own each behavior. Text still renders through Typography so the cap
// only owns the chrome (border, fill, size), never the type metrics.
export function Kbd({
  keys,
  tone = 'muted',
  className,
}: {
  keys: string[];
  tone?: 'muted' | 'faint';
  className?: string;
}) {
  return (
    <span className={cx(rowClass, className)} aria-label={spokenLabel(keys)} role="img">
      {keys.map(key => (
        <Typography
          // A combo never presses the same key twice, so the glyph is a stable key.
          key={key}
          as="kbd"
          variant="caption"
          tone={tone}
          className={capClass}
          aria-hidden="true"
        >
          {key}
        </Typography>
      ))}
    </span>
  );
}

// Renders one or more alternative combos joined by a faint separator, e.g.
// "⌘ C / ⌃ ⇧ C". Used by the shortcuts list and inline hints.
export function ShortcutKeys({ chords, className }: { chords: string[][]; className?: string }) {
  return (
    <span className={cx(chordsClass, className)}>
      {chords.map((chord, index) => (
        <Fragment key={chord.join('+')}>
          {index > 0 ? (
            <Typography as="span" variant="tiny" tone="ghost" aria-hidden="true">
              /
            </Typography>
          ) : null}
          <Kbd keys={chord} />
        </Fragment>
      ))}
    </span>
  );
}

// A spoken form for assistive tech: maps the cap glyphs to words.
const SPOKEN: Record<string, string> = {
  '⌘': 'Command',
  '⌃': 'Control',
  '⇧': 'Shift',
  '⌥': 'Option',
  '⏎': 'Return',
  '⇥': 'Tab',
  '↑': 'Up',
  '↓': 'Down',
  '←': 'Left',
  '→': 'Right',
};

function spokenLabel(keys: string[]): string {
  return keys.map(key => SPOKEN[key] ?? key).join(' ');
}

const rowClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '3px',
  flexShrink: 0,
});

const capClass = css({
  display: 'inline-grid',
  placeItems: 'center',
  minWidth: '20px',
  height: '20px',
  padding: '0 6px',
  borderRadius: '5px',
  border: '1px solid var(--line)',
  background: 'var(--surface-2)',
  // A faint bottom edge gives the cap a touch of physical depth without noise.
  boxShadow: '0 1px 0 color-mix(in srgb, var(--line-strong) 55%, transparent)',
});

const chordsClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  flexShrink: 0,
});
