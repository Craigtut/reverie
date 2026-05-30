import { formatDroppedPaths } from '../domain';
import { useTerminalStore } from '../store';
import { useFileDrop, type FileDropModel } from './useFileDrop';

// Terminal adapter over the generic useFileDrop: it configures the reusable drop
// machinery with the terminal's policy and leaves the visual to <DropSurface>.
// A valid target is a session with a live, input-armed terminal; a drop inserts
// the shell-quoted paths into that session (see useTerminalSession). The drag
// can land on the terminal body or on a session tab (drag-to-tab routing).

// Drop-zone kinds the terminal marks in the DOM (data-drop-zone). Shared so the
// body, the tabs, and the overlay all agree on the same strings.
export const TERMINAL_DROP_ZONE = 'terminal';
export const TERMINAL_TAB_DROP_ZONE = 'terminal-tab';

export interface TerminalFileDropOptions {
  insertTextIntoSession: (sessionId: string, text: string) => Promise<boolean>;
}

export function useTerminalFileDrop({
  insertTextIntoSession,
}: TerminalFileDropOptions): FileDropModel {
  return useFileDrop({
    accepts: kind => kind === TERMINAL_DROP_ZONE || kind === TERMINAL_TAB_DROP_ZONE,
    isValidTarget: ({ id }) =>
      Boolean(useTerminalStore.getState().sessionTerminalBindings[id]?.inputArmed),
    onDrop: (target, paths) => {
      void insertTextIntoSession(target.id, formatDroppedPaths(paths));
    },
  });
}
