import { css } from '../../styled-system/css';

// Shared pill-button styles used across the composer, session-history, and
// settings surfaces. Kept as named classes (rather than a <Button> wrapper) so
// existing call sites compose them directly; a component wrapper can layer on
// top later if needed. Names retain the original *Composer* prefix for
// continuity with their call sites.
//
// Every variant shares the same layout: a centered icon + label row with
// consistent height, horizontal padding, gap, and pill radius. Variants only
// differ in their color treatment, so they stay visually uniform side by side.

export const primaryComposerButtonClass = css({
  height: '34px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '7px',
  padding: '0 16px',
  borderRadius: '999px',
  border: '1px solid var(--line-strong)',
  color: 'var(--bg)',
  background: 'var(--text)',
  cursor: 'pointer',
  fontWeight: 650,
  whiteSpace: 'nowrap',
  transition: 'background 140ms ease, opacity 140ms ease',
  _hover: { background: 'color-mix(in srgb, var(--text) 88%, var(--bg))' },
  _disabled: { opacity: 0.45, cursor: 'not-allowed' },
});

export const secondaryComposerButtonClass = css({
  height: '34px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '7px',
  padding: '0 16px',
  borderRadius: '999px',
  border: '1px solid var(--line)',
  color: 'var(--text)',
  background: 'color-mix(in srgb, var(--surface-2) 72%, transparent)',
  cursor: 'pointer',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  transition: 'border-color 140ms ease, background 140ms ease',
  _hover: { borderColor: 'var(--line-strong)' },
  _disabled: { opacity: 0.45, cursor: 'not-allowed' },
});

export const dangerComposerButtonClass = css({
  height: '34px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '7px',
  padding: '0 16px',
  borderRadius: '999px',
  border: '1px solid color-mix(in srgb, var(--bad, #ff7a7a) 45%, var(--line))',
  color: 'var(--text)',
  background: 'rgba(255, 95, 95, 0.09)',
  cursor: 'pointer',
  fontWeight: 650,
  whiteSpace: 'nowrap',
  transition: 'border-color 140ms ease, background 140ms ease',
  _hover: { borderColor: 'rgba(255, 120, 120, 0.65)' },
  _disabled: { opacity: 0.45, cursor: 'not-allowed' },
});
