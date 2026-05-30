import { useState, type ReactNode } from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Over,
} from '@dnd-kit/core';
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { arrayMove } from '@dnd-kit/sortable';

import type { WorkspaceShellSnapshot } from '../../domain';
import { useNavReorder } from '../../hooks/useNavReorder';
import { asNavDragData, asSessionZoneData } from './navDnd';
import { NavDragStateProvider, type NavDragState } from './navDragContext';

const EMPTY_DRAG: NavDragState = {
  activeKind: null,
  sourceFocusId: null,
  dropTargetFocusId: null,
};

// The single drag-and-drop context over the whole nav tree, so a session can be
// dragged from one topic into another. There is no drag overlay: the real row
// lifts and moves in place (constrained to the vertical axis and to the
// scrollable nav, so it can't leave the panel), and neighbours reflow to open a
// gap. We resolve everything on drop; drag-over only tracks which topic a
// dragged session would land in, so that topic (often a collapsed one) can light
// up. Every branch is defensive: an invalid pairing is simply a no-op.
export function NavDndProvider({
  shell,
  children,
}: {
  shell: WorkspaceShellSnapshot;
  children: ReactNode;
}) {
  const { reorderProjects, reorderTopics, reorderSessions, moveSession } = useNavReorder();
  const [drag, setDrag] = useState<NavDragState>(EMPTY_DRAG);

  // Under 8px of movement stays a click (open / expand / close still fire); past
  // it, a drag begins. This is what lets "grab anywhere" coexist with the row's
  // own buttons.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  function onDragStart(event: DragStartEvent) {
    const data = asNavDragData(event.active.data.current);
    if (!data) return;
    setDrag({
      activeKind: data.kind,
      sourceFocusId: data.kind === 'session' ? focusIdOf(shell, data.entityId) : null,
      dropTargetFocusId: null,
    });
  }

  function onDragOver(event: DragOverEvent) {
    const activeData = asNavDragData(event.active.data.current);
    if (!activeData || activeData.kind !== 'session') return;
    const target = sessionDropTarget(shell, event.over);
    setDrag(prev =>
      prev.dropTargetFocusId === (target?.focusId ?? null)
        ? prev
        : { ...prev, dropTargetFocusId: target?.focusId ?? null },
    );
  }

  function onDragEnd(event: DragEndEvent) {
    setDrag(EMPTY_DRAG);
    const { active, over } = event;
    if (!over) return;

    const activeData = asNavDragData(active.data.current);
    if (!activeData) return;
    const overItem = asNavDragData(over.data.current);

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
    const target = sessionDropTarget(shell, over);
    if (!sourceFocusId || !target) return;

    if (target.focusId === sourceFocusId) {
      const ids = orderedSessionIds(shell, sourceFocusId);
      const from = ids.indexOf(activeData.entityId);
      const to = overItem?.kind === 'session' ? ids.indexOf(overItem.entityId) : ids.length - 1;
      if (from === -1 || to === -1 || from === to) return;
      reorderSessions(arrayMove(ids, from, to));
      return;
    }
    moveSession(activeData.entityId, target.focusId, Math.max(0, target.index));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDrag(EMPTY_DRAG)}
    >
      <NavDragStateProvider value={drag}>{children}</NavDragStateProvider>
    </DndContext>
  );
}

// Where a dragged session would land: the focus it drops into and the index
// within that focus's ordered sessions. Used both to dispatch the move and to
// highlight the target topic during the drag.
function sessionDropTarget(
  shell: WorkspaceShellSnapshot,
  over: Over | null,
): { focusId: string; index: number } | null {
  if (!over) return null;
  const overItem = asNavDragData(over.data.current);
  const overZone = asSessionZoneData(over.data.current);
  if (overItem?.kind === 'session') {
    const focusId = focusIdOf(shell, overItem.entityId);
    if (!focusId) return null;
    return { focusId, index: orderedSessionIds(shell, focusId).indexOf(overItem.entityId) };
  }
  if (overItem?.kind === 'topic') {
    // Dropped on a topic header (e.g. a collapsed topic) → append into it.
    return {
      focusId: overItem.entityId,
      index: orderedSessionIds(shell, overItem.entityId).length,
    };
  }
  if (overZone) {
    return { focusId: overZone.focusId, index: orderedSessionIds(shell, overZone.focusId).length };
  }
  return null;
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
