// Hooks barrel: effectful shell behaviors extracted from the App component.
// Each hook owns its own store wiring, so the shell just calls them.

export { useAppFocus } from './useAppFocus';
export { useCommandPalette } from './useCommandPalette';
export { useSessionActivity } from './useSessionActivity';
export { useAgentClis } from './useAgentClis';
export { useTerminalSession } from './useTerminalSession';
export type { TerminalSession } from './useTerminalSession';
export { useWorkspaceModel } from './useWorkspaceModel';
export type { WorkspaceModel } from './useWorkspaceModel';
export { useShellNavigation } from './useShellNavigation';
export type { ShellNavigation } from './useShellNavigation';
export { useCreationForm } from './useCreationForm';
export type { CreationForm } from './useCreationForm';
export { useWorkspaceMutations } from './useWorkspaceMutations';
export type { WorkspaceMutations } from './useWorkspaceMutations';
