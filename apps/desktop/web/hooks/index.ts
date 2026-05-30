// Hooks barrel: effectful shell behaviors extracted from the App component.
// Each hook owns its own store wiring, so the shell just calls them.

export { useAppFocus } from './useAppFocus';
export { useCommandPalette } from './useCommandPalette';
export { useSessionTabShortcuts } from './useSessionTabShortcuts';
export { useSessionActivity } from './useSessionActivity';
export { useSessionTitle } from './useSessionTitle';
export { useAgentClis } from './useAgentClis';
export { useTerminalSession } from './useTerminalSession';
export type { TerminalSession } from './useTerminalSession';
export { useWorkspaceModel } from './useWorkspaceModel';
export type { WorkspaceModel } from './useWorkspaceModel';
export { useNavPersistence } from './useNavPersistence';
export { useShellNavigation } from './useShellNavigation';
export type { ShellNavigation } from './useShellNavigation';
export { useCreationForm } from './useCreationForm';
export type { CreationForm } from './useCreationForm';
export { useWorkspaceMutations } from './useWorkspaceMutations';
export type { WorkspaceMutations } from './useWorkspaceMutations';
export { useFileDrop } from './useFileDrop';
export type {
  FileDropModel,
  FileDropPhase,
  FileDropTarget,
  UseFileDropOptions,
} from './useFileDrop';
export {
  useTerminalFileDrop,
  TERMINAL_DROP_ZONE,
  TERMINAL_TAB_DROP_ZONE,
} from './useTerminalFileDrop';
