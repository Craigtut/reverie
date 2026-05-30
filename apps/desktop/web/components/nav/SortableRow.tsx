import type { PointerEvent, ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { css } from '../../styled-system/css';
import type { NavDragData } from './navDnd';

// One draggable row in the nav tree (a project, a topic, or a session). The
// whole row is the grab affordance; the sensor's 8px activation distance lets a
// real click still reach the buttons inside. We attach only `listeners` (pointer
// drag), NOT dnd-kit's `attributes`, so we don't add a second tab stop / nested
// `role="button"` on top of the row's real buttons. The pointerdown is stopped
// from bubbling so the INNERMOST row wins: grabbing a session drags the session,
// not its enclosing topic or project.
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

  const onPointerDown = (event: PointerEvent) => {
    event.stopPropagation();
    listeners?.onPointerDown?.(event);
  };

  return (
    // The row is a drag affordance, not a click target: the real click targets
    // are the buttons rendered inside, reached when the pointer moves under the
    // sensor's activation distance.
    <div
      ref={setNodeRef}
      className={rowClass}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        // The source row dims in place while its DragOverlay clone follows the
        // cursor.
        opacity: isDragging ? 0.4 : undefined,
        zIndex: isDragging ? 2 : undefined,
      }}
      onPointerDown={onPointerDown}
    >
      {children}
    </div>
  );
}

const rowClass = css({
  position: 'relative',
  // Let the pointer sensor own vertical gestures on the row (no effect on
  // trackpad wheel scrolling, which the nav still handles).
  touchAction: 'none',
});
