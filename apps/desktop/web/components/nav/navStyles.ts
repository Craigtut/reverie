import { css } from '../../styled-system/css';

// Shared nav-row atoms used by both ProjectGroup and FocusRow: the row action
// wrapper (with its hover-revealed remove/history buttons), the action button
// itself, and the label/meta text.

export const navRowActionWrapClass = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto auto',
  alignItems: 'center',
  gap: '2px',
  width: '100%',
  '&:not(:hover) [data-testid="remove-project-button"], &:not(:hover) [data-testid="remove-focus-button"]':
    { opacity: 0 },
});

export const navRowActionClass = css({
  width: '24px',
  height: '24px',
  border: '0',
  borderRadius: '7px',
  display: 'grid',
  placeItems: 'center',
  color: 'var(--text-3)',
  background: 'transparent',
  cursor: 'pointer',
  _hover: { color: 'var(--text)', background: 'var(--surface-2)' },
});

// Layout only; size/weight come from the Typography variant the row renders.
export const rowLabelClass = css({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

// Residual only (tabular figures); size + color come from the variant + tone.
export const rowMetaClass = css({
  fontVariantNumeric: 'tabular-nums',
});
