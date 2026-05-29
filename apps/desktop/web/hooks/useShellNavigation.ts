import { useEffect, useRef } from 'react';

import { errorMessage } from '../domain';
import type { ShellSession } from '../domain';
import { useNavigationStore, useShellStore, useUiStore } from '../store';
import type { TerminalSession } from './useTerminalSession';
import type { WorkspaceModel } from './useWorkspaceModel';

interface ShellNavigationOptions {
  model: WorkspaceModel;
  terminal: TerminalSession;
}

// Navigation intents: selecting/opening a session (which launches or resumes
// it), opening a focus or its history, and jumping home. Also the safety-net
// effect that auto-launches a selected-but-idle session once. Reads the current
// selection straight from the navigation store; the shell snapshot from the
// shell store. No selection refs: opens always run on a later interaction than
// the store write that set the selection, so the store is already current.
export function useShellNavigation({ model, terminal }: ShellNavigationOptions) {
  const setSelectedProjectId = useNavigationStore(s => s.setSelectedProjectId);
  const setSelectedFocusId = useNavigationStore(s => s.setSelectedFocusId);
  const setSelectedSessionId = useNavigationStore(s => s.setSelectedSessionId);
  const setCreationMode = useNavigationStore(s => s.setCreationMode);
  const setSurfaceMode = useNavigationStore(s => s.setSurfaceMode);
  const appendLog = useUiStore(s => s.appendLog);

  // The session id we've already auto-launched for the current selection.
  // Opening a session in the terminal surface starts it once; if that launch
  // fails the idle overlay's Run/Resume button is the manual fallback.
  const autoLaunchedSessionIdRef = useRef<string | null>(null);

  function selectSessionTab(session: ShellSession) {
    // Selecting a tab is an "open this session" intent. If it's already bound
    // to a live PTY we just re-focus it; otherwise we launch (or resume, if
    // there's a native session ref). The user shouldn't have to also click a
    // separate Run button just to start a session they meant to open.
    const attached = terminal.activateSession(session);
    if (attached) return;
    void terminal.launchSession(session).catch(error => {
      const verb = session.nativeSessionRef ? 'Resume' : 'Launch';
      appendLog(`${verb} failed for ${session.title}: ${errorMessage(error)}`);
    });
  }

  function goToDashboard() {
    setCreationMode(null);
    setSurfaceMode('dashboard');
  }

  function openSessionFromDashboard(session: ShellSession) {
    const shell = useShellStore.getState().shell;
    const focus = shell.focuses.find(f => f.id === session.focusId);
    if (!focus) return;
    setSelectedProjectId(focus.projectId ?? null);
    setSelectedFocusId(session.focusId);
    setSelectedSessionId(session.id);
    setCreationMode(null);
    setSurfaceMode('terminal');
    selectSessionTab(session);
  }

  function openFocus(projectId: string | null, focusId: string) {
    const shell = useShellStore.getState().shell;
    setSelectedProjectId(projectId);
    setSelectedFocusId(focusId);
    const firstSession = shell.sessions.find(session => session.focusId === focusId && session.tabVisible !== false) ?? null;
    if (firstSession) {
      selectSessionTab(firstSession);
    } else {
      setSelectedSessionId(null);
      terminal.clearSurface();
    }
    setCreationMode(null);
    setSurfaceMode('terminal');
  }

  function openSessionHistory(projectId: string | null, focusId: string) {
    setSelectedProjectId(projectId);
    setSelectedFocusId(focusId);
    setSelectedSessionId(null);
    setCreationMode(null);
    setSurfaceMode('session-history');
    terminal.clearSurface();
  }

  // A terminal session you're looking at should be running, not parked behind a
  // Run button. Opening a focus, clicking a tab, or creating a session already
  // launches directly; this is the safety net for the remaining ways the
  // terminal surface can land on an idle session (opening a project or the
  // General group, falling back to the first visible tab). We auto-launch a
  // selection once: a restore_failed session waits for an explicit retry, and a
  // launch that fails falls back to the overlay's manual Run/Resume button.
  const { selectedSession, selectedTerminalBinding, isLaunchingSelectedSession } = model;
  const surfaceMode = useNavigationStore(s => s.surfaceMode);
  const creationMode = useNavigationStore(s => s.creationMode);
  useEffect(() => {
    if (surfaceMode !== 'terminal' || creationMode || !selectedSession) return;
    if (selectedTerminalBinding || isLaunchingSelectedSession) return;
    if (selectedSession.status === 'restore_failed') return;
    if (autoLaunchedSessionIdRef.current === selectedSession.id) return;
    terminal.autostartSession(selectedSession);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mirrors the original effect deps.
  }, [surfaceMode, creationMode, selectedSession?.id, selectedSession?.status, selectedTerminalBinding, isLaunchingSelectedSession]);

  return { selectSessionTab, goToDashboard, openSessionFromDashboard, openFocus, openSessionHistory };
}

export type ShellNavigation = ReturnType<typeof useShellNavigation>;
