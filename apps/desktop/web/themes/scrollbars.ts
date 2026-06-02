import { css } from '../styled-system/css';

// Shared scrollbar treatment for the app's scroll containers, paired with the
// useScrollbarFade hook. The thumb is invisible at rest and fades in over ~200ms
// when the container is engaged (hover, wheel/trackpad, or keyboard scroll),
// holds while the cursor is inside, then fades back out four seconds after the
// cursor leaves. The reveal/hold/hide timing lives in the hook; this class only
// renders the two looks and keys them off a `data-scrollbar` attribute the hook
// toggles between "visible" and "idle".
//
// Only the thumb COLOR animates, never its width: the styled native scrollbar
// reserves its gutter whenever content overflows, so the fade never reflows
// content. Honors the monochrome palette (neutral --line-strong, no hue). The
// ~200ms transition is dropped under prefers-reduced-motion, leaving an instant
// show/hide that still respects the 4s hold.
//
// Note: we deliberately do NOT set the standard `scrollbar-width`/`scrollbar-color`
// here. In Chromium (and Safari 18.2+) setting `scrollbar-width` disables the
// `::-webkit-scrollbar` pseudo-elements we rely on for the fade, so the WebKit
// pseudo-element path stays the single styling surface.
export const scrollFadeClass = css({
  '&::-webkit-scrollbar': { width: '10px', height: '10px' },
  '&::-webkit-scrollbar-track': { background: 'transparent' },
  '&::-webkit-scrollbar-thumb': {
    background: 'transparent',
    borderRadius: '8px',
    border: '2px solid transparent',
    backgroundClip: 'padding-box',
    transition: 'background-color 200ms ease',
  },
  '&[data-scrollbar="visible"]::-webkit-scrollbar-thumb': {
    background: 'var(--line-strong)',
  },
  '&[data-scrollbar="visible"]::-webkit-scrollbar-thumb:hover': {
    background: 'var(--text-4)',
  },
  '@media (prefers-reduced-motion: reduce)': {
    '&::-webkit-scrollbar-thumb': { transition: 'none' },
  },
});
