import { useEffect, useRef } from 'react';

import { errorMessage, parseNavState, reconcilePersistedView, serializeNavState } from '../domain';
import { invoke } from '../services/runtime';
import { useNavigationStore, useShellStore, useUiStore } from '../store';

// Persisted navigation so a reload or relaunch reopens the last view instead of
// resetting to the dashboard. The durable copy lives in the backend (the
// workspace `navState` column); this hook hydrates the navigation store from it
// on load and debounce-writes changes back.
//
// The catch: a Rust recompile or a quit/reopen relaunches the whole process, so
// we cannot tell "the user came back" from "the dev's backend rebuilt" at the
// process level. The product call (see the design discussion) is:
//   - soft reload (Vite HMR / page reload, same JS session): restore everything,
//     including dropping back into the terminal surface, which the auto-launch
//     net then resumes.
//   - cold open / relaunch (new JS session): restore the selection and sidebar
//     accordion but land on the calm dashboard; one click resumes.
// We separate the two with a sessionStorage sentinel: it survives a same-context
// page reload but is gone on a fresh WebView (a new process). localStorage would
// not work here, it survives both.

const NAV_SESSION_KEY = 'reverie:nav-alive';

// Captured once at module load, before React renders, so a fresh JS context
// (cold open / relaunch) reads `false` and a same-context reload reads `true`.
// Doing it here (not in an effect) also makes it immune to StrictMode's
// double-invoked effects, which would otherwise set the sentinel before we read.
const wasSoftReload = readAndArmSessionSentinel();

function readAndArmSessionSentinel(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const alive = window.sessionStorage.getItem(NAV_SESSION_KEY) === '1';
    window.sessionStorage.setItem(NAV_SESSION_KEY, '1');
    return alive;
  } catch {
    // Private mode or storage disabled: treat as a cold open (the safe default).
    return false;
  }
}

// How long to coalesce a burst of navigation (rapid tab clicks, accordion
// toggles) before a single backend write. Human-paced, so this stays invisible.
const NAV_WRITE_DEBOUNCE_MS = 400;

// The fallback snapshot's marker id, before the real workspace has loaded. We do
// not hydrate or persist against it.
const FALLBACK_WORKSPACE_ID = 'fallback-workspace';

export function useNavPersistence() {
  const shell = useShellStore(s => s.shell);
  const hydrate = useNavigationStore(s => s.hydrate);
  const hydrated = useNavigationStore(s => s.hydrated);
  const appendLog = useUiStore(s => s.appendLog);

  const selectedProjectId = useNavigationStore(s => s.selectedProjectId);
  const selectedFocusId = useNavigationStore(s => s.selectedFocusId);
  const selectedSessionId = useNavigationStore(s => s.selectedSessionId);
  const surfaceMode = useNavigationStore(s => s.surfaceMode);
  const collapsedProjectIds = useNavigationStore(s => s.collapsedProjectIds);
  const expandedFocusIds = useNavigationStore(s => s.expandedFocusIds);
  const generalCollapsed = useNavigationStore(s => s.generalCollapsed);

  // Guards across renders (and StrictMode's double-invoked effects).
  const hydratedRef = useRef(false);
  const lastWrittenRef = useRef<string | null>(null);
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hydrate once, as soon as the real workspace snapshot has arrived.
  useEffect(() => {
    if (hydratedRef.current) return;
    if (shell.workspace.id === FALLBACK_WORKSPACE_ID) return;
    hydratedRef.current = true;

    const persisted = parseNavState(shell.workspace.navState);
    if (!persisted) {
      // Nothing saved (fresh workspace): release the default-seeding effect and
      // let the first real navigation be the first write.
      lastWrittenRef.current = null;
      hydrate();
      return;
    }

    const view = reconcilePersistedView(persisted, shell, { isSoftReload: wasSoftReload });
    // Seed lastWritten with exactly what the store will hold, so the writer does
    // not immediately echo the restored view back to the backend.
    lastWrittenRef.current = serializeNavState(view);
    hydrate({
      selectedProjectId: view.selectedProjectId,
      selectedFocusId: view.selectedFocusId,
      selectedSessionId: view.selectedSessionId,
      surfaceMode: view.surfaceMode,
      collapsedProjectIds: new Set(view.collapsedProjectIds),
      expandedFocusIds: new Set(view.expandedFocusIds),
      generalCollapsed: view.generalCollapsed,
    });
  }, [shell, hydrate]);

  // Persist navigation changes (debounced) once hydrated.
  useEffect(() => {
    if (!hydrated) return;
    if (shell.workspace.id === FALLBACK_WORKSPACE_ID) return;

    const serialized = serializeNavState({
      selectedProjectId,
      selectedFocusId,
      selectedSessionId,
      surfaceMode,
      collapsedProjectIds: [...collapsedProjectIds],
      expandedFocusIds: [...expandedFocusIds],
      generalCollapsed,
    });
    if (serialized === lastWrittenRef.current) return;

    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      lastWrittenRef.current = serialized;
      void invoke('set_workspace_nav_state', { request: { navState: serialized } }).catch(error => {
        appendLog(`Persist navigation failed: ${errorMessage(error)}`);
      });
    }, NAV_WRITE_DEBOUNCE_MS);

    return () => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    };
  }, [
    hydrated,
    shell.workspace.id,
    selectedProjectId,
    selectedFocusId,
    selectedSessionId,
    surfaceMode,
    collapsedProjectIds,
    expandedFocusIds,
    generalCollapsed,
    appendLog,
  ]);
}
