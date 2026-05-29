import { useEffect, useMemo } from 'react';

import { invoke } from '../services/runtime';
import {
  USER_HOME,
  activityForSession,
  dangerousLabel,
  errorMessage,
} from '../domain';
import type {
  ActivityPermissionRequest,
  ActivityState,
  ShellProject,
  ShellSession,
  WorkspaceShellSnapshot,
} from '../domain';
import { terminalScrollbackContract } from '../terminalScrollback';
import { useActivityStore, useNavigationStore, useShellStore, useTerminalStore, useUiStore } from '../store';

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
  const runningSessionId = useTerminalStore(s => s.runningSessionId);
  const cortexActivity = useActivityStore(s => s.cortexActivity);
  const busy = useUiStore(s => s.busy);
  const appendLog = useUiStore(s => s.appendLog);

  const scrollbackContract = useMemo(() => terminalScrollbackContract(terminalSurface), [terminalSurface]);

  const selectedProject: ShellProject | null = selectedProjectId
    ? shell.projects.find(project => project.id === selectedProjectId) ?? null
    : null;
  const visibleFocuses = useMemo(() => {
    return shell.focuses
      .filter(focus => !focus.archived)
      .filter(focus => selectedProjectId === null ? !focus.projectId : focus.projectId === selectedProjectId)
      .sort((left, right) => left.sortOrder - right.sortOrder);
  }, [selectedProjectId, shell.focuses]);
  const selectedFocus = visibleFocuses.find(focus => focus.id === selectedFocusId) ?? visibleFocuses[0] ?? null;
  const selectedFocusProject = selectedFocus?.projectId
    ? shell.projects.find(project => project.id === selectedFocus.projectId) ?? null
    : null;
  const selectedFocusDefaultCwd = selectedFocusProject?.path ?? USER_HOME;
  const focusSessions = useMemo(() => {
    if (!selectedFocus) return [];
    return shell.sessions.filter(session => session.focusId === selectedFocus.id);
  }, [selectedFocus, shell.sessions]);
  const visibleSessions = useMemo(() => focusSessions.filter(session => session.tabVisible !== false), [focusSessions]);
  const hiddenFocusSessions = useMemo(() => focusSessions.filter(session => session.tabVisible === false), [focusSessions]);
  const selectedSession = creationMode || surfaceMode === 'session-history' || surfaceMode === 'dashboard'
    ? null
    : visibleSessions.find(session => session.id === selectedSessionId) ?? visibleSessions[0] ?? null;
  const selectedTerminalBinding = selectedSession ? sessionTerminalBindings[selectedSession.id] ?? null : null;
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
    () => shell.sessions.filter(s => {
      if (s.tabVisible === false) return false;
      if (s.status === 'running' || sessionTerminalBindings[s.id]) return true;
      const cortexId = s.nativeSessionRef?.sessionId;
      const activity = cortexId ? cortexActivity[cortexId] : null;
      return activity?.status === 'working' || activity?.status === 'awaiting_permission';
    }).length,
    [shell.sessions, sessionTerminalBindings, cortexActivity],
  );
  const effectiveDangerousMode = dangerousLabel(selectedSession, shell.workspace.defaultDangerousMode) !== 'Off';
  // Plain-language status shown in the terminal meta strip. We deliberately omit
  // terminal-internal details (cols×rows, scrollback row counts) from the
  // primary surface; they're available behind diagnostics if needed.
  const runningLabel = selectedTerminalBinding
    ? (selectedTerminalBinding.inputArmed ? 'Running' : 'Starting')
    : busy ? 'Working' : selectedSession ? 'Ready to launch' : 'Ready';

  async function loadWorkspaceShell() {
    if (!canUseAppServices) return null;
    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>('workspace_shell');
      setShell(snapshot);
      appendLog(`Loaded persisted workspace shell: ${snapshot.projects.length} project, ${snapshot.focuses.length} focuses, ${snapshot.sessions.length} sessions.`);
      return snapshot;
    } catch (error) {
      appendLog(`Workspace shell command failed; using browser fallback data: ${errorMessage(error)}`);
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
  // selected yet (first load, or the selected focus was archived/removed).
  useEffect(() => {
    if (shell.focuses.length === 0) return;
    if (selectedFocusId && shell.focuses.some(focus => focus.id === selectedFocusId && !focus.archived)) return;

    const firstFocus = shell.focuses
      .filter(focus => !focus.archived)
      .sort((left, right) => left.sortOrder - right.sortOrder)[0];
    if (!firstFocus) return;

    const firstSession = shell.sessions.find(session => session.focusId === firstFocus.id) ?? null;
    setSelectedProjectId(firstFocus.projectId ?? null);
    setSelectedFocusId(firstFocus.id);
    setSelectedSessionId(firstSession?.id ?? null);
  }, [selectedFocusId, shell.focuses, shell.sessions]);

  return {
    shell,
    selectedProject,
    selectedFocus,
    selectedFocusDefaultCwd,
    focusSessions,
    visibleSessions,
    hiddenFocusSessions,
    selectedSession,
    selectedTerminalBinding,
    isLaunchingSelectedSession,
    selectedPermissionRequest,
    liveSessionCount,
    effectiveDangerousMode,
    runningLabel,
    scrollbackContract,
    loadWorkspaceShell,
  };
}

export type WorkspaceModel = ReturnType<typeof useWorkspaceModel>;
