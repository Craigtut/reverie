// Zustand store barrel. Each store is a focused slice of app state; components
// subscribe to just the fields they read via selectors.

export { useNavigationStore } from './navigationStore';
export { useUiStore } from './uiStore';
export { usePaletteStore } from './paletteStore';
export { useActivityStore } from './activityStore';
export { useShellStore } from './shellStore';
export { useTerminalStore } from './terminalStore';
export type { SetStateAction } from './setter';
