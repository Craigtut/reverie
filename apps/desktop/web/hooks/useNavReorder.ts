import { errorMessage } from '../domain';
import type { WorkspaceShellSnapshot } from '../domain';
import { invoke } from '../services/runtime';
import { useShellStore, useUiStore } from '../store';

// The persistence layer behind the left-nav drag-and-drop. Each operation patches
// the shell store OPTIMISTICALLY (so the rows settle into place instantly and
// dnd-kit never snaps them back), then writes through to the backend and
// reconciles from the returned snapshot. On failure it rolls back to the
// pre-drag shell. Order is encoded purely as `sortOrder` (spaced by 10, matching
// the backend), so the views re-sort themselves the moment these values change.
export function useNavReorder() {
  const appendLog = useUiStore(s => s.appendLog);

  async function persist(
    patch: (shell: WorkspaceShellSnapshot) => WorkspaceShellSnapshot,
    command: string,
    args: Record<string, unknown>,
  ) {
    const previous = useShellStore.getState().shell;
    useShellStore.getState().setShell(patch(previous));
    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>(command, args);
      useShellStore.getState().setShell(snapshot);
    } catch (error) {
      useShellStore.getState().setShell(previous);
      appendLog(`Reorder failed (${command}): ${errorMessage(error)}`);
    }
  }

  function reorderProjects(orderedIds: string[]) {
    void persist(
      shell => ({
        ...shell,
        projects: shell.projects.map(project => {
          const index = orderedIds.indexOf(project.id);
          return index === -1 ? project : { ...project, sortOrder: index * 10 };
        }),
      }),
      'reorder_projects',
      { orderedProjectIds: orderedIds },
    );
  }

  function reorderTopics(orderedFocusIds: string[]) {
    void persist(
      shell => ({
        ...shell,
        focuses: shell.focuses.map(focus => {
          const index = orderedFocusIds.indexOf(focus.id);
          return index === -1 ? focus : { ...focus, sortOrder: index * 10 };
        }),
      }),
      'reorder_focuses',
      { orderedFocusIds },
    );
  }

  function reorderSessions(orderedSessionIds: string[]) {
    void persist(
      shell => ({
        ...shell,
        sessions: shell.sessions.map(session => {
          const index = orderedSessionIds.indexOf(session.id);
          return index === -1 ? session : { ...session, sortOrder: index * 10 };
        }),
      }),
      'reorder_sessions',
      { orderedSessionIds },
    );
  }

  function moveSession(sessionId: string, targetFocusId: string, targetIndex: number) {
    void persist(
      shell => {
        // Build the destination order (sorted), minus the moved session, with it
        // spliced back in at the drop index. Then renumber that order and
        // reparent the moved session. The source topic just keeps its gap.
        const order = shell.sessions
          .filter(
            session =>
              session.focusId === targetFocusId && !session.archived && session.id !== sessionId,
          )
          .slice()
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
          .map(session => session.id);
        order.splice(Math.max(0, Math.min(targetIndex, order.length)), 0, sessionId);
        return {
          ...shell,
          sessions: shell.sessions.map(session => {
            if (session.id === sessionId) {
              return {
                ...session,
                focusId: targetFocusId,
                sortOrder: order.indexOf(sessionId) * 10,
              };
            }
            const index = order.indexOf(session.id);
            return index === -1 ? session : { ...session, sortOrder: index * 10 };
          }),
        };
      },
      'move_session',
      { sessionId, targetFocusId, targetIndex },
    );
  }

  return { reorderProjects, reorderTopics, reorderSessions, moveSession };
}
