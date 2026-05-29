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
  setSelectedProjectId: (action: SetStateAction<ProjectFilter>) => void;
  setSelectedFocusId: (action: SetStateAction<string | null>) => void;
  setSelectedSessionId: (action: SetStateAction<string | null>) => void;
  setSurfaceMode: (action: SetStateAction<SurfaceMode>) => void;
  setCreationMode: (action: SetStateAction<CreationMode>) => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  selectedProjectId: null,
  selectedFocusId: null,
  selectedSessionId: null,
  surfaceMode: 'dashboard',
  creationMode: null,
  setSelectedProjectId: (action) => set((s) => ({ selectedProjectId: resolveSetStateAction(action, s.selectedProjectId) })),
  setSelectedFocusId: (action) => set((s) => ({ selectedFocusId: resolveSetStateAction(action, s.selectedFocusId) })),
  setSelectedSessionId: (action) => set((s) => ({ selectedSessionId: resolveSetStateAction(action, s.selectedSessionId) })),
  setSurfaceMode: (action) => set((s) => ({ surfaceMode: resolveSetStateAction(action, s.surfaceMode) })),
  setCreationMode: (action) => set((s) => ({ creationMode: resolveSetStateAction(action, s.creationMode) })),
}));
