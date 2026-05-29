import { create } from 'zustand';

import { fallbackAgentCliDetections, fallbackShellSnapshot } from '../domain';
import type { AgentCliDetection, WorkspaceShellSnapshot } from '../domain';
import { resolveSetStateAction, type SetStateAction } from './setter';

// The workspace shell snapshot (workspace + projects + focuses + sessions) and
// detected agent CLIs. For now this holds the snapshot and exposes a useState-
// style setter that the App shell already drives after each command. The shell
// mutations (create/archive/remove via shellApi) move into this store as
// actions when the call sites migrate off the App component.

interface ShellStoreState {
  shell: WorkspaceShellSnapshot;
  agentCliDetections: AgentCliDetection[];
  setShell: (action: SetStateAction<WorkspaceShellSnapshot>) => void;
  setAgentCliDetections: (action: SetStateAction<AgentCliDetection[]>) => void;
}

export const useShellStore = create<ShellStoreState>((set) => ({
  shell: fallbackShellSnapshot(),
  agentCliDetections: fallbackAgentCliDetections(),
  setShell: (action) => set((s) => ({ shell: resolveSetStateAction(action, s.shell) })),
  setAgentCliDetections: (action) => set((s) => ({ agentCliDetections: resolveSetStateAction(action, s.agentCliDetections) })),
}));
