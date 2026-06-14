import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from '../../hooks';
import { css } from '../../styled-system/css';

export interface SidebarResizeHandleProps {
  width: number;
  resizing: boolean;
  onBeginResize: (event: ReactPointerEvent) => void;
  onNudge: (delta: number) => void;
}

// How many px each arrow-key press resizes the panel when the handle is focused.
const KEYBOARD_STEP = 16;

// The drag affordance that resizes the left navigation panel. It is anchored in
// the gap on the panel/stage boundary (via the shell's --reverie-shell-pad and
// --reverie-sidebar-width vars) rather than inside the rail, so it is not clipped
// by the panel's rounded, overflow-hidden surface and the col-resize cursor reads
// right along the whole edge. A thin guide line fades in on hover/drag; the hit
// area is wider than the line so the target is forgiving. It is exposed as a
// window-splitter (focusable, with value bounds) so the arrow keys resize it too.
export function SidebarResizeHandle({
  width,
  resizing,
  onBeginResize,
  onNudge,
}: SidebarResizeHandleProps) {
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onNudge(-KEYBOARD_STEP);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      onNudge(KEYBOARD_STEP);
    }
  };

  return (
    <div
      className={handleClass}
      data-resizing={resizing ? 'true' : 'false'}
      data-testid="sidebar-resize-handle"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize navigation panel"
      aria-valuenow={width}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      onPointerDown={onBeginResize}
      onKeyDown={onKeyDown}
    >
      <span className={guideClass} aria-hidden="true" />
    </div>
  );
}

const handleClass = css({
  position: 'absolute',
  top: 'var(--reverie-shell-pad)',
  bottom: 'var(--reverie-shell-pad)',
  // Sit in the gap just past the panel's right edge (shell pad + rail width),
  // extending into the 18px gutter. Anchored entirely outside the rail so it
  // never overlays the panel's auto-hiding scrollbar (which would swallow thumb
  // drags), while still reading as the divider line between rail and stage.
  left: 'calc(var(--reverie-shell-pad) + var(--reverie-sidebar-width, 288px))',
  width: '16px',
  zIndex: 5,
  cursor: 'col-resize',
  display: 'grid',
  placeItems: 'center',
  outline: 'none',
  // Hide on the single-column mobile breakpoint where the rail is not a column.
  mdDown: { display: 'none' },
  '&:hover span, &[data-resizing="true"] span, &:focus-visible span': {
    opacity: 1,
  },
});

const guideClass = css({
  width: '2px',
  height: '100%',
  borderRadius: '2px',
  background: 'var(--line-strong)',
  opacity: 0,
  transition: 'opacity 120ms ease',
  pointerEvents: 'none',
});
