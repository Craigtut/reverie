import { useEffect, useMemo } from 'react';

import { invoke } from '../services/runtime';
import { USER_HOME, activityForSession, dangerousLabel, errorMessage } from '../domain';
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
  const sessionTerminalBindings = useTerminalStore(s => s.sessionTerminalBindings);
  const terminalSurface = useTerminalStore(s => s.terminalSurface);
  const launchingSessionId = useTerminalStore(s => s.launchingSessionId);
  const setLaunchingSessionId = useTerminalStore(s => s.setLaunchingSessionId);
  const cortexActivity = useActivityStore(s => s.cortexActivity);
  const busy = useUiStore(s => s.busy);
  const appendLog = useUiStore(s => s.appendLog);
  const setTheme = useUiStore(s => s.setTheme);

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
  const selectedFocusDefaultCwd = selectedFocusProject?.path ?? USER_HOME;
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
  const effectiveDangerousMode =
    dangerousLabel(selectedSession, shell.workspace.defaultDangerousMode) !== 'Off';
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

  async function loadWorkspaceShell() {
    if (!canUseAppServices) return null;
    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>('workspace_shell');
      setShell(snapshot);
      appendLog(
        `Loaded persisted workspace shell: ${snapshot.projects.length} project, ${snapshot.focuses.length} focuses, ${snapshot.sessions.length} sessions.`,
      );
      return snapshot;
    } catch (error) {
      // A load failure here leaves the shell at its empty initial state, which
      // looks exactly like total data loss even though the database is intact.
      // Surface it loudly (console + in-app log) so a transient backend error
      // is never silently mistaken for vanished projects and sessions.
      console.error('[reverie] workspace_shell load failed; keeping prior shell state.', error);
      appendLog(
        `Workspace shell command failed; using browser fallback data: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  // Load the persisted workspace shell once on mount (isTauriRuntime never
  // changes after first render, so the original [isTauriRuntime] dep was a
  // mount-once effect).
  useEffect(() => {
    loadWorkspaceShell().catch(error => {
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
  }, [creationMode, selectedFocusId, shell.focuses, shell.sessions]);

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
  };
}

export type WorkspaceModel = ReturnType<typeof useWorkspaceModel>;
