// Zustand store barrel. Each store is a focused slice of app state; components
// subscribe to just the fields they read via selectors.

export { useNavigationStore } from './navigationStore';
export { useUiStore } from './uiStore';
export { usePaletteStore } from './paletteStore';
export { useActivityStore } from './activityStore';
export { useGitStatusStore } from './gitStatusStore';
export { useSpeechEngineStore } from './speechEngineStore';
export { useShellStore } from './shellStore';
export { useTerminalStore } from './terminalStore';
export { useConnectionPanelStore } from './connectionPanelStore';
export { useOverlayStore } from './overlayStore';
export type { ConfirmRequest, Toast } from './overlayStore';
export { useUpdateStore } from './updateStore';
export type { UpdatePhase } from './updateStore';
export type { SetStateAction } from './setter';
