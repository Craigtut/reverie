import { create } from 'zustand';

import { TERMINAL_SURFACE } from '../terminal-canvas-renderer';
import type { TerminalScrollMetrics, TerminalSurface } from '../terminalScrollback';
import type { SessionTerminalBinding } from '../domain';
import { preserveStoreAcrossHmr } from './hmr';
import { resolveSetStateAction, type SetStateAction } from './setter';

// Terminal-island reactive state: which session→terminal bindings are live,
// the active terminal, launch/run status, the live surface dimensions, and
// scroll/follow state. Kept in a store (not hook-local) because the dashboard
// reads bindings to classify sessions and the shell chrome reads run state.
// useState-compatible setters so call sites migrate unchanged.

interface TerminalStoreState {
  sessionTerminalBindings: Record<string, SessionTerminalBinding>;
  activeTerminalId: string | null;
  runningSessionId: string | null;
  launchingSessionId: string | null;
  terminalInputArmed: boolean;
  terminalSurface: TerminalSurface;
  scrollbackRowCount: number;
  terminalLiveFollow: boolean;
  terminalScroll: TerminalScrollMetrics | null;
  setSessionTerminalBindings: (
    action: SetStateAction<Record<string, SessionTerminalBinding>>,
  ) => void;
  setActiveTerminalId: (action: SetStateAction<string | null>) => void;
  setRunningSessionId: (action: SetStateAction<string | null>) => void;
  setLaunchingSessionId: (action: SetStateAction<string | null>) => void;
  setTerminalInputArmed: (action: SetStateAction<boolean>) => void;
  setTerminalSurface: (action: SetStateAction<TerminalSurface>) => void;
  setScrollbackRowCount: (action: SetStateAction<number>) => void;
  setTerminalLiveFollow: (action: SetStateAction<boolean>) => void;
  setTerminalScroll: (action: SetStateAction<TerminalScrollMetrics | null>) => void;
}

export const useTerminalStore = create<TerminalStoreState>(set => ({
  sessionTerminalBindings: {},
  activeTerminalId: null,
  runningSessionId: null,
  launchingSessionId: null,
  terminalInputArmed: false,
  terminalSurface: TERMINAL_SURFACE,
  scrollbackRowCount: 0,
  terminalLiveFollow: true,
  terminalScroll: null,
  setSessionTerminalBindings: action =>
    set(s => ({
      sessionTerminalBindings: resolveSetStateAction(action, s.sessionTerminalBindings),
    })),
  setActiveTerminalId: action =>
    set(s => ({ activeTerminalId: resolveSetStateAction(action, s.activeTerminalId) })),
  setRunningSessionId: action =>
    set(s => ({ runningSessionId: resolveSetStateAction(action, s.runningSessionId) })),
  setLaunchingSessionId: action =>
    set(s => ({ launchingSessionId: resolveSetStateAction(action, s.launchingSessionId) })),
  setTerminalInputArmed: action =>
    set(s => ({ terminalInputArmed: resolveSetStateAction(action, s.terminalInputArmed) })),
  setTerminalSurface: action =>
    set(s => ({ terminalSurface: resolveSetStateAction(action, s.terminalSurface) })),
  setScrollbackRowCount: action =>
    set(s => ({ scrollbackRowCount: resolveSetStateAction(action, s.scrollbackRowCount) })),
  setTerminalLiveFollow: action =>
    set(s => ({ terminalLiveFollow: resolveSetStateAction(action, s.terminalLiveFollow) })),
  setTerminalScroll: action =>
    set(s => ({ terminalScroll: resolveSetStateAction(action, s.terminalScroll) })),
}));

// Keep live terminal bindings and surface state across HMR. The backend PTYs
// survive a partial Fast Refresh untouched, so dropping the bindings would make
// running terminals vanish from the UI until a full reload. See store/hmr.ts.
preserveStoreAcrossHmr(useTerminalStore, import.meta.hot, s => ({
  sessionTerminalBindings: s.sessionTerminalBindings,
  activeTerminalId: s.activeTerminalId,
  runningSessionId: s.runningSessionId,
  launchingSessionId: s.launchingSessionId,
  terminalInputArmed: s.terminalInputArmed,
  terminalSurface: s.terminalSurface,
  scrollbackRowCount: s.scrollbackRowCount,
  terminalLiveFollow: s.terminalLiveFollow,
  terminalScroll: s.terminalScroll,
}));
