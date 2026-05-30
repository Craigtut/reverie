import { useState, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';

import type { WorkspaceShellSnapshot } from '../../domain';
import { useNavReorder } from '../../hooks/useNavReorder';
import { css, cx } from '../../styled-system/css';
import { rimLitPanelClass } from '../../themes/surfaces';
import { Typography } from '../primitives/Typography';
import { asNavDragData, asSessionZoneData, type NavDragKind } from './navDnd';

// The single drag-and-drop context over the whole nav tree, so a session can be
// dragged from one topic into another. We resolve everything on drop (drag-over
// does no live reparenting): read what is being dragged and what it landed on,
// then dispatch the matching reorder/move. Every branch is defensive: an invalid
// pairing (a topic dropped on a project, a session dropped on a project header,
// a cross-project topic move) is simply a no-op.
export function NavDndProvider({
  shell,
  children,
}: {
  shell: WorkspaceShellSnapshot;
  children: ReactNode;
}) {
  const { reorderProjects, reorderTopics, reorderSessions, moveSession } = useNavReorder();
  const [activeLabel, setActiveLabel] = useState<string | null>(null);

  // Under 8px of movement stays a click (open / expand / close still fire); past
  // it, a drag begins. This is what lets "grab anywhere" coexist with the row's
  // own buttons.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  function onDragStart(event: DragStartEvent) {
    const data = asNavDragData(event.active.data.current);
    setActiveLabel(data ? labelForActive(shell, data.kind, data.entityId) : null);
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveLabel(null);
    const { active, over } = event;
    if (!over) return;

    const activeData = asNavDragData(active.data.current);
    if (!activeData) return;
    const overItem = asNavDragData(over.data.current);
    const overZone = asSessionZoneData(over.data.current);

    if (activeData.kind === 'project') {
      if (overItem?.kind !== 'project') return;
      const ids = orderedProjectIds(shell);
      const from = ids.indexOf(activeData.entityId);
      const to = ids.indexOf(overItem.entityId);
      if (from === -1 || to === -1 || from === to) return;
      reorderProjects(arrayMove(ids, from, to));
      return;
    }

    if (activeData.kind === 'topic') {
      // Topics never leave their project: only reorder within the same list.
      if (overItem?.kind !== 'topic' || overItem.containerId !== activeData.containerId) return;
      const ids = orderedTopicIds(shell, activeData.containerId);
      const from = ids.indexOf(activeData.entityId);
      const to = ids.indexOf(overItem.entityId);
      if (from === -1 || to === -1 || from === to) return;
      reorderTopics(arrayMove(ids, from, to));
      return;
    }

    // Sessions: reorder within a topic, or move to another topic.
    const sourceFocusId = focusIdOf(shell, activeData.entityId);
    if (!sourceFocusId) return;

    let targetFocusId: string | null = null;
    if (overItem?.kind === 'session') {
      targetFocusId = focusIdOf(shell, overItem.entityId);
    } else if (overItem?.kind === 'topic') {
      // Dropped on a topic header (e.g. a collapsed topic) → drop into it.
      targetFocusId = overItem.entityId;
    } else if (overZone) {
      targetFocusId = overZone.focusId;
    }
    if (!targetFocusId) return;

    if (targetFocusId === sourceFocusId) {
      const ids = orderedSessionIds(shell, sourceFocusId);
      const from = ids.indexOf(activeData.entityId);
      const to = overItem?.kind === 'session' ? ids.indexOf(overItem.entityId) : ids.length - 1;
      if (from === -1 || to === -1 || from === to) return;
      reorderSessions(arrayMove(ids, from, to));
      return;
    }

    // Cross-topic move: index = position of the session we dropped on, or the
    // end when dropped on a header / empty area.
    const targetIds = orderedSessionIds(shell, targetFocusId);
    const targetIndex =
      overItem?.kind === 'session' ? targetIds.indexOf(overItem.entityId) : targetIds.length;
    moveSession(activeData.entityId, targetFocusId, Math.max(0, targetIndex));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveLabel(null)}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {activeLabel ? (
          <div className={cx(rimLitPanelClass, overlayClass)}>
            <Typography as="span" variant="smallBody" tone="default">
              {activeLabel}
            </Typography>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function orderedProjectIds(shell: WorkspaceShellSnapshot): string[] {
  return shell.projects
    .filter(project => !project.archived)
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map(project => project.id);
}

function orderedTopicIds(shell: WorkspaceShellSnapshot, containerId: string): string[] {
  const projectId = containerId.slice('topics:'.length);
  return shell.focuses
    .filter(focus => !focus.archived && focus.projectId === projectId)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(focus => focus.id);
}

function orderedSessionIds(shell: WorkspaceShellSnapshot, focusId: string): string[] {
  return shell.sessions
    .filter(session => session.focusId === focusId && !session.archived)
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map(session => session.id);
}

function focusIdOf(shell: WorkspaceShellSnapshot, sessionId: string): string | null {
  return shell.sessions.find(session => session.id === sessionId)?.focusId ?? null;
}

function labelForActive(
  shell: WorkspaceShellSnapshot,
  kind: NavDragKind,
  entityId: string,
): string {
  if (kind === 'project') {
    return shell.projects.find(project => project.id === entityId)?.name ?? 'Project';
  }
  if (kind === 'topic') {
    return shell.focuses.find(focus => focus.id === entityId)?.title ?? 'Topic';
  }
  return shell.sessions.find(session => session.id === entityId)?.title?.trim() || 'Session';
}

const overlayClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  padding: '6px 12px',
  borderRadius: '9px',
  cursor: 'grabbing',
  maxWidth: '220px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});
