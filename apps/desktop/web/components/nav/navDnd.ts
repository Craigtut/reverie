// Shared vocabulary for the left-nav drag-and-drop (projects, topics, sessions,
// and cross-topic session moves). The sortable id carries a type prefix so the
// DndContext can tell what is being dragged from `active.id`/`over.id` alone;
// the richer `data` payload (attached via useSortable/useDroppable) carries the
// raw entity id and its container for the drop math.

export type NavDragKind = 'project' | 'topic' | 'session';

// Attached to each sortable row.
export interface NavDragData {
  kind: NavDragKind;
  // Raw entity id (project / focus / session id), un-prefixed.
  entityId: string;
  // The list this row currently lives in.
  containerId: string;
}

// Attached to a topic's session drop area, so an expanded-but-empty topic (and
// the gaps between sessions) still accept a dropped session.
export interface SessionZoneData {
  kind: 'sessionzone';
  focusId: string;
  containerId: string;
}

export const PROJECTS_CONTAINER = 'projects';
export const topicsContainer = (projectId: string) => `topics:${projectId}`;
export const sessionsContainer = (focusId: string) => `sessions:${focusId}`;

export const projectSortId = (id: string) => `project:${id}`;
export const topicSortId = (id: string) => `topic:${id}`;
export const sessionSortId = (id: string) => `session:${id}`;
export const sessionZoneId = (focusId: string) => `zone:${focusId}`;

// Narrow an over/active `data.current` (which is `unknown`-ish at the dnd-kit
// boundary) into our payloads.
export function asNavDragData(data: unknown): NavDragData | null {
  if (
    data &&
    typeof data === 'object' &&
    'kind' in data &&
    (data.kind === 'project' || data.kind === 'topic' || data.kind === 'session')
  ) {
    return data as NavDragData;
  }
  return null;
}

export function asSessionZoneData(data: unknown): SessionZoneData | null {
  if (data && typeof data === 'object' && 'kind' in data && data.kind === 'sessionzone') {
    return data as SessionZoneData;
  }
  return null;
}
