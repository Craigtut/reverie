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
  minWidth: '28px',
  height: '28px',
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
  width: '28px',
  height: '28px',
});

export const rowActionClass = css({
  // Fills its trailing cap so the revealed action (a plus that adds a child, or
  // a session's archive control) lands concentric with the status indicator it
  // crossfades from, not anchored a few px to its side.
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

// The destructive sibling of rowActionClass, used by the session row's archive
// control. It sits one row below a topic's "add session" plus, so it warms to
// red on hover to read clearly as the away-from-additive, consequential action
// (closing a session stops its agent). A full class rather than a composed
// modifier so its hover color/background reliably win over the base.
export const rowDangerActionClass = css({
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
  _hover: {
    color: 'var(--bad)',
    background: 'color-mix(in srgb, var(--bad) 14%, transparent)',
  },
});

// A leading status icon (the project folder, the Home house) that doubles as its
// container's ambient liveness mark. At rest it inherits the row's muted icon
// color. When an agent inside is actively working it tints --good and breathes
// the slow reverie-live-breathe pulse: a calm sign of life, not an alert. When
// nothing is live but something needs the user it holds a steady --warn, so a
// collapsed row still signals a pending ask while the amber count badge beside it
// carries the actual tally. Liveness deliberately wins the icon over attention:
// "needs you" is already counted in the trailing badge, while "alive" has no
// other home, so the green breath is never masked by a concurrent ask. The two
// data attributes are set mutually exclusively by the row, so their equal-weight
// selectors never collide.
export const liveStatusIconClass = css({
  display: 'inline-flex',
  flexShrink: 0,
  '& svg': { transition: 'color 180ms ease' },
  '&[data-tone="attention"] svg': { color: 'var(--warn)' },
  '&[data-live="true"] svg': {
    color: 'var(--good)',
    animation: 'reverie-live-breathe 4s ease-in-out infinite',
  },
});

// Layout only; size/weight come from the Typography variant the row renders.
// Selection is off so a double-click (which starts a rename) doesn't also
// highlight the word under the cursor.
export const rowLabelClass = css({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  userSelect: 'none',
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
