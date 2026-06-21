import { create } from 'zustand';

import { fallbackAgentCliDetections, fallbackShellSnapshot } from '../domain';
import type { AgentCliDetection, WorkspaceShellSnapshot } from '../domain';
import { preserveStoreAcrossHmr } from './hmr';
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
  // Patch a single session's title in place (driven by live OSC title events)
  // so every display site re-renders without refetching the whole snapshot.
  patchSessionTitle: (sessionId: string, title: string) => void;
  // Optimistically record that a session was viewed (ISO timestamp), clearing
  // its "finished" / unseen marker immediately. The backend persists the same
  // value via shellApi.markSessionViewed; this in-place patch avoids a snapshot
  // round-trip so the badge clears the instant the user opens the session. See
  // useSessionViewed.
  markSessionViewed: (sessionId: string, viewedAt: string) => void;
  // Optimistically dismiss a session's re-entry header (mark its summary
  // dismissed) so it hides immediately. The backend persists the same via
  // shellApi.dismissSessionReentry. No-op if there is no summary. See
  // useReentryHeader.
  dismissSessionReentry: (sessionId: string) => void;
}

export const useShellStore = create<ShellStoreState>(set => ({
  shell: fallbackShellSnapshot(),
  agentCliDetections: fallbackAgentCliDetections(),
  setShell: action => set(s => ({ shell: resolveSetStateAction(action, s.shell) })),
  setAgentCliDetections: action =>
    set(s => ({ agentCliDetections: resolveSetStateAction(action, s.agentCliDetections) })),
  patchSessionTitle: (sessionId, title) =>
    set(s => {
      // OSC title events fire often and frequently repeat the current title, so
      // skip the update entirely when nothing changes: return the same state so
      // the snapshot reference is preserved and no subscriber re-renders.
      const current = s.shell.sessions.find(session => session.id === sessionId);
      if (!current || current.title === title) return s;
      return {
        shell: {
          ...s.shell,
          sessions: s.shell.sessions.map(session =>
            session.id === sessionId ? { ...session, title } : session,
          ),
        },
      };
    }),
  markSessionViewed: (sessionId, viewedAt) =>
    set(s => {
      const current = s.shell.sessions.find(session => session.id === sessionId);
      // No-op if unchanged so the snapshot reference is preserved and no
      // subscriber re-renders unnecessarily.
      if (!current || current.lastViewedAt === viewedAt) return s;
      return {
        shell: {
          ...s.shell,
          sessions: s.shell.sessions.map(session =>
            session.id === sessionId ? { ...session, lastViewedAt: viewedAt } : session,
          ),
        },
      };
    }),
  dismissSessionReentry: sessionId =>
    set(s => {
      const current = s.shell.sessions.find(session => session.id === sessionId);
      // No-op when there is no summary or it is already dismissed, so the
      // snapshot reference is preserved and no subscriber re-renders.
      if (!current?.reentrySummary || current.reentrySummary.dismissed) return s;
      return {
        shell: {
          ...s.shell,
          sessions: s.shell.sessions.map(session =>
            session.id === sessionId && session.reentrySummary
              ? {
                  ...session,
                  reentrySummary: { ...session.reentrySummary, dismissed: true },
                }
              : session,
          ),
        },
      };
    }),
}));

// Keep the loaded workspace on screen across Vite HMR. Without this, editing any
// frontend module in this store's import graph re-runs create() and resets the
// snapshot to the empty fallback while React Fast Refresh keeps the tree mounted,
// so the mount-once workspace_shell load never re-fires and the UI looks like
// total data loss until a full reload. See store/hmr.ts.
preserveStoreAcrossHmr(useShellStore, import.meta.hot, s => ({
  shell: s.shell,
  agentCliDetections: s.agentCliDetections,
}));
