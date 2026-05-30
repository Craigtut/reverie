import { createContext, useContext } from 'react';

import type { NavDragKind } from './navDnd';

// Live drag state shared down the nav tree so a topic (often a collapsed one)
// can light up as the place a dragged session will land. Updated on every
// drag-over by the NavDndProvider.
export interface NavDragState {
  activeKind: NavDragKind | null;
  sourceFocusId: string | null;
  dropTargetFocusId: string | null;
}

const NavDragContext = createContext<NavDragState>({
  activeKind: null,
  sourceFocusId: null,
  dropTargetFocusId: null,
});

export const NavDragStateProvider = NavDragContext.Provider;

// True when a session is being dragged and would drop into THIS topic from a
// different one. Same-topic reordering returns false (the reflowing gap is the
// cue there, not a whole-topic highlight).
export function useNavDropTarget(focusId: string): boolean {
  const { activeKind, sourceFocusId, dropTargetFocusId } = useContext(NavDragContext);
  return activeKind === 'session' && dropTargetFocusId === focusId && sourceFocusId !== focusId;
}
