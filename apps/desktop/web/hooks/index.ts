// Hooks barrel: effectful shell behaviors extracted from the App component.
// Each hook owns its own store wiring, so the shell just calls them.

export { useAppFocus } from './useAppFocus';
export { useAppQuit } from './useAppQuit';
export { useAutoUpdate, runUpdateCheck, relaunchToUpdate } from './useAutoUpdate';
export { useCommandPalette } from './useCommandPalette';
export { useSessionTabShortcuts } from './useSessionTabShortcuts';
export { useSessionActivity } from './useSessionActivity';
export { useGitStatus } from './useGitStatus';
export { useSpeechEngine } from './useSpeechEngine';
export { useSpeechCapture } from './useSpeechCapture';
export type { SpeechCapture } from './useSpeechCapture';
export { useSessionViewed } from './useSessionViewed';
export { useSessionTitle } from './useSessionTitle';
export { useAgentClis } from './useAgentClis';
export { useTerminalSession } from './useTerminalSession';
export type { TerminalSession } from './useTerminalSession';
export { useWebviewHeartbeat } from './useWebviewHeartbeat';
export { useWorkspaceModel } from './useWorkspaceModel';
export type { WorkspaceModel } from './useWorkspaceModel';
export { useNavPersistence } from './useNavPersistence';
export { useShellNavigation } from './useShellNavigation';
export type { ShellNavigation } from './useShellNavigation';
export { useCreationForm } from './useCreationForm';
export type { CreationForm } from './useCreationForm';
export { useDispatchLaunch } from './useDispatchLaunch';
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
export { useSidebarFolderDrop, SIDEBAR_PROJECT_DROP_ZONE } from './useSidebarFolderDrop';
export {
  useSidebarResize,
  clampSidebarWidth,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
} from './useSidebarResize';
export type { SidebarResize } from './useSidebarResize';
