import { errorMessage } from '../domain';
import type { WorkspaceShellSnapshot } from '../domain';
import { invoke } from '../services/runtime';
import { useShellStore, useUiStore } from '../store';

// Persist a new focus order after a drag-and-drop in the left nav. The caller
// passes the full ordered id list for one project (or General); the backend
// reassigns each focus's sort_order to match. The drag UI updates optimistically
// on drop, so this just writes through and reconciles from the returned
// snapshot.
export function useReorderFocuses() {
  const setShell = useShellStore(s => s.setShell);
  const appendLog = useUiStore(s => s.appendLog);

  return async function reorderFocuses(orderedFocusIds: string[]) {
    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>('reorder_focuses', {
        orderedFocusIds,
      });
      setShell(snapshot);
    } catch (error) {
      appendLog(`Reorder focuses failed: ${errorMessage(error)}`);
    }
  };
}
