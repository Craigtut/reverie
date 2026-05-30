import type { PointerEvent, ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { css, cx } from '../../styled-system/css';
import type { NavDragData } from './navDnd';
import { useNavDropTarget } from './navDragContext';

// One draggable row in the nav tree (a project, a topic, or a session). There is
// no drag overlay: this wrapper IS the row, and it lifts and moves in place
// (vertical-axis + scroll-bounded by the DndContext modifiers), so it feels like
// picking up the actual line item rather than a floating clone. While it moves,
// its neighbours reflow to open the gap it will drop into. The pointerdown is
// stopped from bubbling so the INNERMOST row wins: grabbing a session drags the
// session, not its enclosing topic. Only `listeners` are attached (not dnd-kit's
// `attributes`) so we don't add a second tab stop / nested role on top of the
// row's own buttons; the 8px sensor distance keeps clicks working.
export function SortableRow({
  id,
  data,
  children,
}: {
  id: string;
  data: NavDragData;
  children: ReactNode;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id, data });
  // True only when THIS row is a topic a dragged session would drop into.
  const isDropTarget = useNavDropTarget(data.entityId);

  const onPointerDown = (event: PointerEvent) => {
    event.stopPropagation();
    listeners?.onPointerDown?.(event);
  };

  return (
    // The row is a drag affordance, not a click target: the real click targets
    // are the buttons inside, reached when the pointer moves under the sensor's
    // activation distance.
    <div
      ref={setNodeRef}
      className={cx(rowClass, isDragging && draggingClass, isDropTarget && dropTargetClass)}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? 30 : undefined,
      }}
      onPointerDown={onPointerDown}
    >
      {children}
    </div>
  );
}

const rowClass = css({
  position: 'relative',
  borderRadius: '9px',
  // Let the pointer sensor own vertical gestures on the row (no effect on
  // trackpad wheel scrolling, which the nav still handles).
  touchAction: 'none',
});

// Picked-up: opaque so it cleanly covers the rows it passes over, lifted with a
// soft shadow and a hairline edge.
const draggingClass = css({
  background: 'var(--surface-3)',
  boxShadow: '0 8px 20px rgba(0, 0, 0, 0.22), 0 0 0 1px var(--line-strong)',
  cursor: 'grabbing',
});

// A topic lit up as the place a dragged session will land (mainly for collapsed
// topics, where there is no reflowing gap to read).
const dropTargetClass = css({
  background: 'var(--surface-2)',
  boxShadow: 'inset 0 0 0 1.5px var(--line-strong)',
});
