import { css } from '../../styled-system/css';

// The breathing green halo that marks "an agent is working in here" on a small
// 6px status dot: the topic rollup dot in the nav, a dashboard rail row, the
// Home "working" pill. It is the dot-shaped sibling of navStyles'
// liveStatusIconClass, which carries the same breath on a leading icon.
//
// Shared as a complete class rather than a spread object on purpose. Panda only
// extracts FLAT cross-file spreads, so a nested `&::after` block travelling
// through a spread emits no CSS at all and fails silently. Compose it at each
// call site with cx(localDotClass, liveHaloClass).
//
// Why a pseudo-element instead of the obvious `box-shadow` spread: box-shadow
// cannot be composited by any engine, so animating it marked the containing
// layer dirty every frame. These dots sit inside nav rows and dashboard rail
// rows, so the layer WebKit repainted was full of row labels, and the repaint
// re-ran Core Text shaping on all of them 60 times a second. Instead the halo is
// a ring sized to the breath's PEAK (14px outer, 4px border, leaving exactly the
// 6px hole the dot fills) that scales down to its trough, so the entire
// animation is transform + opacity on its own layer and the row never repaints.
//
// One deliberate imprecision: scaling the ring scales its border too, so at the
// trough the ring is ~2.9px thick against the old 2px and laps ~0.9px onto the
// dot's edge. At that point it is drawn at ~9% alpha, which is not perceptible
// on a 6px dot.
export const liveHaloClass = css({
  position: 'relative',
  '&::after': {
    content: '""',
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: '14px',
    height: '14px',
    borderRadius: '50%',
    border: '4px solid color-mix(in srgb, var(--good) 22%, transparent)',
    boxSizing: 'border-box',
    pointerEvents: 'none',
    // Resting state: fully out of the way. Only data-live starts the breath.
    opacity: 0,
    transform: 'translate(-50%, -50%) scale(0.714)',
  },
  '&[data-live="true"]::after': {
    animation: 'reverie-live-ring 4s ease-in-out infinite',
    // will-change ONLY while live. Putting it on the resting ::after would hand
    // every dot in the nav and the dashboard its own compositing layer whether
    // or not anything is working, and the layer count is exactly what makes
    // RenderLayerCompositor::computeCompositingRequirements expensive: that walk
    // was already a quarter of the per-frame cost this change is meant to remove.
    willChange: 'transform, opacity',
  },
});
