import { css } from '../../styled-system/css';

// Shared atoms for the left-nav rows. Every row (project, focus, session, and
// the General group) is built from the same skeleton so the rail reads as one
// consistent family:
//
//   <rowShell>            full-width surface; owns the hover/active background
//                         and the active accent. Hovering it lights the WHOLE
//                         row as one object.
//     <rowCaretButton>    optional, generous expand/collapse target
//     <rowPrimary>        transparent button that fills the row: the main click
//                         target (open the focus/session, or toggle the group)
//     <rowTrailing>       a fixed slot holding the row's meta (count / state
//                         dot) that crossfades to the close/remove action on
//                         hover, so the action never shifts layout or needs a
//                         pixel-perfect aim
//
// The caret and the action are SIBLINGS of the primary button, never nested
// inside it: that keeps the markup valid (no button-in-button) while every
// sub-target keeps its own large hit box.

export const rowShellClass = css({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: '1px',
  width: '100%',
  minHeight: '30px',
  paddingLeft: '6px',
  borderRadius: '9px',
  color: 'var(--text-2)',
  transition: 'background 130ms ease, color 130ms ease',
  _hover: {
    background: 'var(--surface-2)',
    color: 'var(--text)',
    '& [data-row-action]': { opacity: 1, pointerEvents: 'auto' },
    '& [data-row-meta]': { opacity: 0 },
    // As the close X is revealed, its two strokes swing into the cross: the
    // lead diagonal lands first, the trail follows a beat later (see main.css).
    '& [data-x-line="lead"]': {
      animation: 'reverieCloseLead 200ms cubic-bezier(0.34, 1.45, 0.5, 1) backwards',
    },
    '& [data-x-line="trail"]': {
      animation: 'reverieCloseTrail 200ms cubic-bezier(0.34, 1.45, 0.5, 1) 170ms backwards',
    },
  },
  // Reveal the action for keyboard users too, but only on real keyboard focus
  // (:focus-visible), so a mouse click that leaves the row focused does not pin
  // the close/remove button open or hide the resting count.
  '&:has(:focus-visible)': {
    '& [data-row-action]': { opacity: 1, pointerEvents: 'auto' },
    '& [data-row-meta]': { opacity: 0 },
  },
  '&[data-active="true"]': {
    background: 'var(--surface-3)',
    color: 'var(--text)',
  },
});

// The selection accent: a short rounded bar in the row's left gutter. It lives
// in its own slot to the left of the caret, so it no longer collides with the
// expand arrow the way the old label `::before` bar did.
export const rowAccentClass = css({
  position: 'absolute',
  left: '0px',
  top: '50%',
  width: '3px',
  height: '16px',
  marginTop: '-8px',
  borderRadius: '0 2px 2px 0',
  background: 'var(--text)',
  pointerEvents: 'none',
});

export const rowCaretButtonClass = css({
  flexShrink: 0,
  width: '24px',
  alignSelf: 'stretch',
  display: 'grid',
  placeItems: 'center',
  background: 'transparent',
  border: 0,
  cursor: 'pointer',
  color: 'var(--text-3)',
  borderRadius: '7px',
  transition: 'color 120ms ease',
  _hover: { color: 'var(--text)' },
});

export function caretIconClass(expanded: boolean) {
  return css({
    display: 'grid',
    placeItems: 'center',
    color: 'inherit',
    transition: 'transform 150ms cubic-bezier(0.22, 1, 0.36, 1)',
    transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
  });
}

export const rowPrimaryClass = css({
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '9px',
  alignSelf: 'stretch',
  padding: '0 4px',
  background: 'transparent',
  border: 0,
  cursor: 'pointer',
  textAlign: 'left',
  color: 'inherit',
  font: 'inherit',
  '& svg': { color: 'var(--text-3)', flexShrink: 0 },
});

// The trailing slot. Holds the resting meta cluster (a count, a warn attention
// badge, a state cell) right-aligned. The rightmost indicator and the hover
// action share a fixed cap (rowTrailingCapClass) so they crossfade concentric,
// in place, without shifting layout.
export const rowTrailingClass = css({
  position: 'relative',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '5px',
  minWidth: '26px',
  height: '26px',
  marginRight: '2px',
  paddingRight: '2px',
});

// A small warn-toned "needs you" badge: a status dot + count, shown beside the
// total when a group has sessions waiting on the user.
export const rowAttentionBadgeClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  transition: 'opacity 120ms ease',
  '&::before': {
    content: '""',
    width: '5px',
    height: '5px',
    borderRadius: '50%',
    background: 'var(--warn)',
  },
});

// The "ready" (finished/unseen) rollup badge: "2 ready" worth of sessions that
// came to rest off-screen. Mirrors the attention badge's shape but carries no
// status hue (the design is monochrome plus amber/green only); it reads as a
// present-but-calm neutral dot, distinguishing "look when you can" from the
// amber "act now" without inventing a third color. Tabular figures keep the
// count from jittering as it changes.
export const rowReadyBadgeClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  fontVariantNumeric: 'tabular-nums',
  transition: 'opacity 120ms ease',
  '&::before': {
    content: '""',
    width: '5px',
    height: '5px',
    borderRadius: '50%',
    background: 'var(--text-2)',
  },
});

// A fixed square at the right end of the trailing slot. The rightmost status
// indicator (a session's state cell, or a group's count) sits centered inside it,
// and the hover close/remove action overlays it edge-to-edge, so the revealed X
// is concentric with the indicator it replaces instead of offset to one side.
export const rowTrailingCapClass = css({
  position: 'relative',
  flexShrink: 0,
  display: 'grid',
  placeItems: 'center',
  width: '26px',
  height: '26px',
});

export const rowActionClass = css({
  // Fills its trailing cap so the close X lands concentric with the status
  // indicator it crossfades from, not anchored a few px to its side.
  position: 'absolute',
  inset: 0,
  border: 0,
  borderRadius: '7px',
  display: 'grid',
  placeItems: 'center',
  color: 'var(--text-3)',
  background: 'transparent',
  cursor: 'pointer',
  opacity: 0,
  pointerEvents: 'none',
  transition: 'opacity 120ms ease, color 120ms ease, background 120ms ease',
  _hover: { color: 'var(--text)', background: 'var(--surface-hi)' },
});

// Layout only; size/weight come from the Typography variant the row renders.
export const rowLabelClass = css({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

// Residual only (tabular figures + the crossfade with the hover action); size
// and color come from the variant + tone.
export const rowMetaClass = css({
  fontVariantNumeric: 'tabular-nums',
  transition: 'opacity 120ms ease',
});

// A flush in-row "add" affordance (New session / New focus), styled to sit
// quietly under its group while still reading as a real row-wide target.
export const rowAddClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '9px',
  width: '100%',
  minHeight: '28px',
  padding: '0 8px 0 10px',
  borderRadius: '8px',
  border: 0,
  background: 'transparent',
  color: 'var(--text-3)',
  cursor: 'pointer',
  textAlign: 'left',
  transition: 'background 130ms ease, color 130ms ease',
  _hover: { background: 'var(--surface-2)', color: 'var(--text)' },
  _disabled: { opacity: 0.4, cursor: 'default', _hover: { background: 'transparent' } },
  '& svg': { color: 'var(--text-3)', flexShrink: 0 },
});
