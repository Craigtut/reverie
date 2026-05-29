import { css } from '../../styled-system/css';

// Shared pill-button styles used across the composer, session-history, and
// settings surfaces. Kept as named classes (rather than a <Button> wrapper) so
// existing call sites compose them directly; a component wrapper can layer on
// top later if needed. Names retain the original *Composer* prefix for
// continuity with their call sites.

export const primaryComposerButtonClass = css({
  height: '34px',
  border: '1px solid var(--line-strong)',
  borderRadius: '999px',
  color: 'var(--bg)',
  background: 'var(--text)',
  cursor: 'pointer',
  fontWeight: 650,
  _disabled: { opacity: 0.45, cursor: 'not-allowed' },
});

export const secondaryComposerButtonClass = css({
  height: '34px',
  border: '1px solid var(--line)',
  borderRadius: '999px',
  color: 'var(--text)',
  background: 'color-mix(in srgb, var(--surface-2) 72%, transparent)',
  cursor: 'pointer',
  fontWeight: 600,
  _hover: { borderColor: 'var(--line-strong)' },
  _disabled: { opacity: 0.45, cursor: 'not-allowed' },
});

export const dangerComposerButtonClass = css({
  height: '34px',
  border: '1px solid color-mix(in srgb, var(--bad, #ff7a7a) 45%, var(--line))',
  borderRadius: '999px',
  color: 'var(--text)',
  background: 'rgba(255, 95, 95, 0.09)',
  cursor: 'pointer',
  fontWeight: 650,
  padding: '0 14px',
  _hover: { borderColor: 'rgba(255, 120, 120, 0.65)' },
  _disabled: { opacity: 0.45, cursor: 'not-allowed' },
});
