import { css } from '../styled-system/css';

// Shared surface treatments.
//
// `rimLitPanelClass` is the rim-lit card treatment used by the major panels: a
// soft conic rim highlight plus a top sheen, sitting on surface-1 with the
// shell shadow. Compose it onto a panel with Panda's `cx`, layering the panel's
// own layout on top: cx(rimLitPanelClass, myPanelLayoutClass). It reads palette
// vars (--surface-1, --shadow, --rim-*) so it tracks the active theme.
//
// It is exported as a finished css() class rather than a spreadable object on
// purpose: Panda's build-time extractor resolves cross-file spreads only for
// flat objects, and silently drops nested &::before / &::after pseudo blocks
// when they are spread from another module. A whole class avoids that trap.

export const rimLitPanelClass = css({
  position: 'relative',
  background: 'var(--surface-1)',
  borderRadius: '22px',
  boxShadow: 'var(--shadow)',
  overflow: 'hidden',
  isolation: 'isolate',
  '&::before': {
    content: '""',
    position: 'absolute',
    inset: 0,
    borderRadius: 'inherit',
    padding: '1.2px',
    background:
      'conic-gradient(from 180deg at 25% 18%, var(--rim-2) 0deg, var(--rim-2) 40deg, var(--rim-1) 130deg, var(--rim-1) 175deg, var(--rim-2) 240deg, var(--rim-2) 360deg)',
    WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
    WebkitMaskComposite: 'xor',
    maskComposite: 'exclude',
    pointerEvents: 'none',
    zIndex: 3,
  },
  '&::after': {
    content: '""',
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '220px',
    background: 'radial-gradient(circle at 20% 10%, rgba(255, 250, 240, 0.08), transparent 60%)',
    pointerEvents: 'none',
    zIndex: 1,
  },
});
