import { create } from 'zustand';

import type { CreationMode, ProjectFilter, SurfaceMode } from '../domain';
import { resolveSetStateAction, type SetStateAction } from './setter';

// Navigation is app state, not a URL: which surface is showing and what the
// user has selected. This store is Reverie's "router". For now it mirrors the
// useState API the App shell already used (value + setter); intent-named
// actions (openSession, openSettings, ...) get added as components adopt the
// store directly in the component-breakout phase.

interface NavigationState {
  selectedProjectId: ProjectFilter;
  selectedFocusId: string | null;
  selectedSessionId: string | null;
  surfaceMode: SurfaceMode;
  creationMode: CreationMode;
  // Sidebar accordion state. Projects are expanded by default, so we track the
  // ones the user has collapsed; focuses are collapsed by default, so we track
  // the ones the user (or a navigation intent) has expanded. General is a single
  // top-level group, tracked by its own flag.
  collapsedProjectIds: Set<string>;
  expandedFocusIds: Set<string>;
  generalCollapsed: boolean;
  // Whether the navigation has been hydrated from persisted state yet (or marked
  // hydrated because there was nothing to restore). Effects that seed or persist
  // navigation gate on this so they never run against the pre-hydration defaults
  // and clobber the saved view. See useNavPersistence.
  hydrated: boolean;
  setSelectedProjectId: (action: SetStateAction<ProjectFilter>) => void;
  setSelectedFocusId: (action: SetStateAction<string | null>) => void;
  setSelectedSessionId: (action: SetStateAction<string | null>) => void;
  setSurfaceMode: (action: SetStateAction<SurfaceMode>) => void;
  setCreationMode: (action: SetStateAction<CreationMode>) => void;
  toggleProjectCollapsed: (projectId: string) => void;
  toggleFocusExpanded: (focusId: string) => void;
  toggleGeneralCollapsed: () => void;
  // Force a focus (and its project) open, e.g. when navigating to one of its
  // sessions, so the active item is always visible in the tree.
  revealFocus: (projectId: string | null, focusId: string) => void;
  // Apply a restored view in one atomic write and mark navigation hydrated.
  // Only the provided fields are set; the rest keep their defaults. Used once on
  // load by useNavPersistence. Passing nothing just marks hydrated (e.g. a fresh
  // workspace with no saved view), which releases the default-seeding effect.
  hydrate: (restored?: Partial<HydratableNavState>) => void;
}

// The subset of navigation that hydrate() may restore. Mirrors PersistedNavState
// but with the runtime Set shapes the store holds.
interface HydratableNavState {
  selectedProjectId: ProjectFilter;
  selectedFocusId: string | null;
  selectedSessionId: string | null;
  surfaceMode: SurfaceMode;
  collapsedProjectIds: Set<string>;
  expandedFocusIds: Set<string>;
  generalCollapsed: boolean;
}

function withToggled(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export const useNavigationStore = create<NavigationState>(set => ({
  selectedProjectId: null,
  selectedFocusId: null,
  selectedSessionId: null,
  surfaceMode: 'dashboard',
  creationMode: null,
  collapsedProjectIds: new Set<string>(),
  expandedFocusIds: new Set<string>(),
  generalCollapsed: false,
  hydrated: false,
  setSelectedProjectId: action =>
    set(s => ({ selectedProjectId: resolveSetStateAction(action, s.selectedProjectId) })),
  setSelectedFocusId: action =>
    set(s => ({ selectedFocusId: resolveSetStateAction(action, s.selectedFocusId) })),
  setSelectedSessionId: action =>
    set(s => ({ selectedSessionId: resolveSetStateAction(action, s.selectedSessionId) })),
  setSurfaceMode: action =>
    set(s => ({ surfaceMode: resolveSetStateAction(action, s.surfaceMode) })),
  setCreationMode: action =>
    set(s => ({ creationMode: resolveSetStateAction(action, s.creationMode) })),
  toggleProjectCollapsed: projectId =>
    set(s => ({ collapsedProjectIds: withToggled(s.collapsedProjectIds, projectId) })),
  toggleFocusExpanded: focusId =>
    set(s => ({ expandedFocusIds: withToggled(s.expandedFocusIds, focusId) })),
  toggleGeneralCollapsed: () => set(s => ({ generalCollapsed: !s.generalCollapsed })),
  revealFocus: (projectId, focusId) =>
    set(s => {
      const expandedFocusIds = s.expandedFocusIds.has(focusId)
        ? s.expandedFocusIds
        : new Set(s.expandedFocusIds).add(focusId);
      let collapsedProjectIds = s.collapsedProjectIds;
      let generalCollapsed = s.generalCollapsed;
      if (projectId === null) {
        generalCollapsed = false;
      } else if (collapsedProjectIds.has(projectId)) {
        collapsedProjectIds = new Set(collapsedProjectIds);
        collapsedProjectIds.delete(projectId);
      }
      return { expandedFocusIds, collapsedProjectIds, generalCollapsed };
    }),
  hydrate: restored => set(() => ({ ...restored, hydrated: true })),
}));
