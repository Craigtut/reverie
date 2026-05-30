import type { ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';

import { sessionSortId, sessionZoneId, sessionsContainer } from './navDnd';

// The sortable + droppable area for one topic's sessions. The SortableContext
// drives in-topic reordering; the surrounding droppable lets a session be
// dropped into this topic even when it is empty or when the cursor lands on the
// padding / the "New session" row rather than on a sibling session. Keep the
// "New session" button inside `children` so an empty topic still has real drop
// height.
export function SessionDropZone({
  focusId,
  sessionIds,
  children,
}: {
  focusId: string;
  sessionIds: string[];
  children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({
    id: sessionZoneId(focusId),
    data: { kind: 'sessionzone', focusId, containerId: sessionsContainer(focusId) },
  });

  return (
    <SortableContext items={sessionIds.map(sessionSortId)} strategy={verticalListSortingStrategy}>
      <div ref={setNodeRef}>{children}</div>
    </SortableContext>
  );
}
