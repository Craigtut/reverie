import { useEffect, useMemo } from 'react';

import { invoke } from '../services/runtime';
import { activityForSession, dangerousLabel, errorMessage } from '../domain';
import type {
  ActivityPermissionRequest,
  ActivityState,
  ShellProject,
  WorkspaceShellSnapshot,
} from '../domain';
import { terminalScrollbackContract } from '../terminalScrollback';
import {
  useActivityStore,
  useNavigationStore,
  useShellStore,
  useTerminalStore,
  useUiStore,
} from '../store';

const canUseAppServices = true;

// Sentinel the backend returns from `workspace_shell` while it is still opening
// and seeding the database. Mirrors `WORKSPACE_STARTING_UP` in the Tauri command
// layer; the frontend treats it (like any transient failure) as retryable.
const WORKSPACE_STARTING_UP = 'reverie:workspace-starting-up';

// Backoff schedule for the initial load, after an immediate first attempt:
// ~150ms, 300, 600, 1200, 2400. Long enough in aggregate to outlast a cold
// database open + seed, short enough that the common case (first attempt
// succeeds) feels instant.
const WORKSPACE_LOAD_RETRY_DELAYS_MS = [150, 300, 600, 1200, 2400];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Whether a rejected `workspace_shell` invoke is the expected cold-start
// "still starting" signal rather than a real failure. The error reaches the
// frontend as a string or Error depending on the runtime, so we normalize.
function isStartingUpError(error: unknown): boolean {
  const message =
    typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
  return message.includes(WORKSPACE_STARTING_UP);
}

// The workspace view-model: every value the shell and its children derive from
// store state (the selected focus/session, the visible session set, live
// counts, the meta-strip status), plus the effects that keep the navigation
// selection normalized as the shell snapshot changes, plus the workspace load.
// Pure derivation + selection bookkeeping; it owns no command handlers.
export function useWorkspaceModel() {
  const shell = useShellStore(s => s.shell);
  const setShell = useShellStore(s => s.setShell);
  const selectedProjectId = useNavigationStore(s => s.selectedProjectId);
  const setSelectedProjectId = useNavigationStore(s => s.setSelectedProjectId);
  const selectedFocusId = useNavigationStore(s => s.selectedFocusId);
  const setSelectedFocusId = useNavigationStore(s => s.setSelectedFocusId);
  const selectedSessionId = useNavigationStore(s => s.selectedSessionId);
  const setSelectedSessionId = useNavigationStore(s => s.setSelectedSessionId);
  const creationMode = useNavigationStore(s => s.creationMode);
  const surfaceMode = useNavigationStore(s => s.surfaceMode);
  const navHydrated = useNavigationStore(s => s.hydrated);
  const sessionTerminalBindings = useTerminalStore(s => s.sessionTerminalBindings);
  const terminalSurface = useTerminalStore(s => s.terminalSurface);
  const launchingSessionId = useTerminalStore(s => s.launchingSessionId);
  const setLaunchingSessionId = useTerminalStore(s => s.setLaunchingSessionId);
  const cortexActivity = useActivityStore(s => s.cortexActivity);
  const busy = useUiStore(s => s.busy);
  const appendLog = useUiStore(s => s.appendLog);
  const setTheme = useUiStore(s => s.setTheme);
  const setWorkspaceLoadFailed = useUiStore(s => s.setWorkspaceLoadFailed);

  const scrollbackContract = useMemo(
    () => terminalScrollbackContract(terminalSurface),
    [terminalSurface],
  );

  const selectedProject: ShellProject | null = selectedProjectId
    ? (shell.projects.find(project => project.id === selectedProjectId) ?? null)
    : null;
  const visibleFocuses = useMemo(() => {
    return shell.focuses
      .filter(focus => !focus.archived)
      .filter(focus =>
        selectedProjectId === null ? !focus.projectId : focus.projectId === selectedProjectId,
      )
      .sort((left, right) => left.sortOrder - right.sortOrder);
  }, [selectedProjectId, shell.focuses]);
  const selectedFocus =
    visibleFocuses.find(focus => focus.id === selectedFocusId) ?? visibleFocuses[0] ?? null;
  const selectedFocusProject = selectedFocus?.projectId
    ? (shell.projects.find(project => project.id === selectedFocus.projectId) ?? null)
    : null;
  const selectedFocusDefaultCwd = selectedFocusProject?.path ?? '';
  const focusSessions = useMemo(() => {
    if (!selectedFocus) return [];
    return shell.sessions.filter(session => session.focusId === selectedFocus.id);
  }, [selectedFocus, shell.sessions]);
  // Non-archived sessions are the focus's active set: they appear as tabs in the
  // tab bar and as cards/rows on Home and in the sidebar. Closing (archiving) a
  // session removes it from this set; the focus view lists archived ones
  // separately. `visibleSessions` and `activeFocusSessions` are the same set,
  // named for the two surfaces that read it.
  const activeFocusSessions = useMemo(
    () => focusSessions.filter(session => !session.archived),
    [focusSessions],
  );
  const visibleSessions = activeFocusSessions;
  const archivedFocusSessions = useMemo(
    () => focusSessions.filter(session => session.archived),
    [focusSessions],
  );
  const selectedSession =
    creationMode || surfaceMode === 'session-history' || surfaceMode === 'dashboard'
      ? null
      : (visibleSessions.find(session => session.id === selectedSessionId) ??
        visibleSessions[0] ??
        null);
  const selectedTerminalBinding = selectedSession
    ? (sessionTerminalBindings[selectedSession.id] ?? null)
    : null;
  const isLaunchingSelectedSession = Boolean(
    selectedSession && launchingSessionId === selectedSession.id && !selectedTerminalBinding,
  );
  const selectedSessionActivity: ActivityState | null = selectedSession
    ? activityForSession(selectedSession, cortexActivity)
    : null;
  const selectedPermissionRequest: ActivityPermissionRequest | null =
    selectedSessionActivity?.status === 'awaiting_permission'
      ? (selectedSessionActivity.awaitingPermission ?? null)
      : null;
  const liveSessionCount = useMemo(
    () =>
      shell.sessions.filter(s => {
        if (s.archived) return false;
        if (s.status === 'running' || sessionTerminalBindings[s.id]) return true;
        const cortexId = s.nativeSessionRef?.sessionId;
        const activity = cortexId ? cortexActivity[cortexId] : null;
        return activity?.status === 'working' || activity?.status === 'awaiting_permission';
      }).length,
    [shell.sessions, sessionTerminalBindings, cortexActivity],
  );
  // The selected session inherits its topic's (focus's) default when it has no
  // override of its own, then the workspace default.
  const effectiveDangerousMode =
    dangerousLabel(
      selectedSession,
      selectedFocus?.defaultDangerousMode ?? null,
      shell.workspace.defaultDangerousMode,
    ) !== 'Off';
  // Gates the auto-approve (YOLO) toggle: flipping it terminates + resumes the
  // session, which would interrupt an agent mid-thought. Locked only while the
  // selected session is actively working; awaiting permission, awaiting input,
  // done, error, no live activity, and no selected session all leave it enabled.
  const dangerousToggleLocked = selectedSessionActivity?.status === 'working';
  // Plain-language status shown in the terminal meta strip. We deliberately omit
  // terminal-internal details (cols×rows, scrollback row counts) from the
  // primary surface; they're available behind diagnostics if needed.
  const runningLabel = selectedTerminalBinding
    ? selectedTerminalBinding.inputArmed
      ? 'Running'
      : 'Starting'
    : busy
      ? 'Working'
      : selectedSession
        ? 'Ready to launch'
        : 'Ready';

  // A single load attempt. On success it installs the snapshot and clears any
  // prior load-failure state; on failure it returns null so the caller (the
  // retry loop, or a post-command reload) can decide what to do. It never
  // mutates the shell on failure, so a transient error can't wipe good data.
  async function loadWorkspaceShell() {
    if (!canUseAppServices) return null;
    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>('workspace_shell');
      setShell(snapshot);
      setWorkspaceLoadFailed(false);
      appendLog(
        `Loaded persisted workspace shell: ${snapshot.projects.length} project, ${snapshot.focuses.length} focuses, ${snapshot.sessions.length} sessions.`,
      );
      return snapshot;
    } catch (error) {
      // The backend reports a retryable "still starting" signal while it opens
      // and seeds the database; that is expected on a cold start, so we keep
      // quiet about it and let the retry loop handle it. Any other error is a
      // real failure worth surfacing (console + in-app log) so it is never
      // silently mistaken for vanished projects and sessions.
      if (!isStartingUpError(error)) {
        console.error('[reverie] workspace_shell load failed; keeping prior shell state.', error);
        appendLog(`Workspace shell command failed: ${errorMessage(error)}`);
      }
      return null;
    }
  }

  // Load with bounded backoff. The first invoke on a cold start can lose the
  // race against the backend finishing its database open + seed, and a single
  // silent failure used to strand the user on the empty fallback shell (looks
  // like total data loss) until a manual reload. We retry a handful of times
  // with increasing delays, and only after exhausting them do we flip the
  // visible error/retry state. Any success along the way clears it.
  async function loadWorkspaceShellWithRetry() {
    if (!canUseAppServices) return null;
    setWorkspaceLoadFailed(false);
    for (let attempt = 0; attempt <= WORKSPACE_LOAD_RETRY_DELAYS_MS.length; attempt += 1) {
      const snapshot = await loadWorkspaceShell();
      if (snapshot) return snapshot;
      const delay = WORKSPACE_LOAD_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await sleep(delay);
    }
    setWorkspaceLoadFailed(true);
    appendLog('Workspace shell failed to load after several attempts; showing retry.');
    return null;
  }

  // Load the persisted workspace shell once on mount (isTauriRuntime never
  // changes after first render, so the original [isTauriRuntime] dep was a
  // mount-once effect).
  useEffect(() => {
    loadWorkspaceShellWithRetry().catch(error => {
      appendLog(`Workspace shell load failed: ${errorMessage(error)}`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once load.
  }, []);

  // Seed the live uiStore theme from the persisted workspace theme whenever it
  // loads or changes. uiStore.theme stays the value the renderer reads
  // (data-theme) and the terminal-color effect depends on; this only makes the
  // persisted choice the source of truth that survives restarts. A live flip
  // from Settings updates uiStore immediately and then lands here once the
  // saved snapshot comes back, so the two never fight.
  const workspaceTheme = shell.workspace.theme;
  useEffect(() => {
    setTheme(workspaceTheme);
  }, [workspaceTheme, setTheme]);

  // Clean up the launchingSessionId once the live binding arrives (the breathing
  // overlay disappears as soon as the real terminal surface takes over).
  useEffect(() => {
    if (launchingSessionId && sessionTerminalBindings[launchingSessionId]) {
      setLaunchingSessionId(null);
    }
  }, [launchingSessionId, sessionTerminalBindings]);

  // Keep the persisted focus selection pointed at a focus that actually exists
  // in the current view, falling back to the first visible one.
  useEffect(() => {
    if (selectedFocus && selectedFocus.id !== selectedFocusId) {
      setSelectedFocusId(selectedFocus.id);
    }
  }, [selectedFocus, selectedFocusId]);

  useEffect(() => {
    if (selectedSession && selectedSession.id !== selectedSessionId) {
      setSelectedSessionId(selectedSession.id);
    } else if (!selectedSession && selectedSessionId !== null) {
      setSelectedSessionId(null);
    }
  }, [selectedSession, selectedSessionId]);

  // Seed an initial selection once the shell has focuses but nothing valid is
  // selected yet (first load, or the selected focus was archived/removed). Skip
  // during a creation flow: those deliberately clear the focus selection between
  // the project and focus steps, and re-seeding here (now that a General focus
  // always exists) would clobber the just-set project and misfile the new focus.
  useEffect(() => {
    // Wait until navigation has hydrated from persisted state, so we never seed
    // the first focus over a saved selection we are about to restore.
    if (!navHydrated) return;
    if (creationMode) return;
    if (shell.focuses.length === 0) return;
    if (
      selectedFocusId &&
      shell.focuses.some(focus => focus.id === selectedFocusId && !focus.archived)
    )
      return;

    const firstFocus = shell.focuses
      .filter(focus => !focus.archived)
      .sort((left, right) => left.sortOrder - right.sortOrder)[0];
    if (!firstFocus) return;

    const firstSession = shell.sessions.find(session => session.focusId === firstFocus.id) ?? null;
    setSelectedProjectId(firstFocus.projectId ?? null);
    setSelectedFocusId(firstFocus.id);
    setSelectedSessionId(firstSession?.id ?? null);
  }, [navHydrated, creationMode, selectedFocusId, shell.focuses, shell.sessions]);

  return {
    shell,
    selectedProject,
    selectedFocus,
    selectedFocusDefaultCwd,
    focusSessions,
    visibleSessions,
    activeFocusSessions,
    archivedFocusSessions,
    selectedSession,
    selectedTerminalBinding,
    isLaunchingSelectedSession,
    selectedPermissionRequest,
    liveSessionCount,
    effectiveDangerousMode,
    dangerousToggleLocked,
    runningLabel,
    scrollbackContract,
    loadWorkspaceShell,
    retryWorkspaceLoad: loadWorkspaceShellWithRetry,
  };
}

export type WorkspaceModel = ReturnType<typeof useWorkspaceModel>;
