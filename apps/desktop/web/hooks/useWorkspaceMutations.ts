import { agentLabel, errorMessage, shortId } from '../domain';
import type { ShellFocus, ShellProject, ShellSession, WorkspaceShellSnapshot } from '../domain';
import { invoke } from '../services/runtime';
import { terminateSession } from '../services/terminalApi';
import { useNavigationStore, useShellStore, useTerminalStore, useUiStore } from '../store';
import type { TerminalSession } from './useTerminalSession';
import type { WorkspaceModel } from './useWorkspaceModel';

interface WorkspaceMutationsOptions {
  model: WorkspaceModel;
  terminal: TerminalSession;
  selectSessionTab: (session: ShellSession) => void;
}

// Workspace-record mutations that persist a change and reconcile the navigation
// selection: the workspace auto-approve default, per-session auto-approve
// (terminate + relaunch), tab show/hide, session deletion, and focus/project
// archival (terminating any bound CLIs first). Each reads the live terminal
// bindings via getState so it sees processes started after this render.
export function useWorkspaceMutations({ model, terminal, selectSessionTab }: WorkspaceMutationsOptions) {
  const { shell, selectedSession, visibleSessions } = model;
  const setShell = useShellStore(s => s.setShell);
  const selectedProjectId = useNavigationStore(s => s.selectedProjectId);
  const setSelectedProjectId = useNavigationStore(s => s.setSelectedProjectId);
  const selectedFocusId = useNavigationStore(s => s.selectedFocusId);
  const setSelectedFocusId = useNavigationStore(s => s.setSelectedFocusId);
  const selectedSessionId = useNavigationStore(s => s.selectedSessionId);
  const setSelectedSessionId = useNavigationStore(s => s.setSelectedSessionId);
  const setSurfaceMode = useNavigationStore(s => s.setSurfaceMode);
  const setSessionTerminalBindings = useTerminalStore(s => s.setSessionTerminalBindings);
  const setBusy = useUiStore(s => s.setBusy);
  const appendLog = useUiStore(s => s.appendLog);

  async function setWorkspaceDefaultDangerousMode(next: boolean) {
    if (shell.workspace.defaultDangerousMode === next) return;
    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>('set_workspace_default_dangerous_mode', {
        request: { defaultDangerousMode: next },
      });
      setShell(snapshot);
      appendLog(`Default auto-approve set to ${next ? 'on' : 'off'} for this workspace.`);
    } catch (error) {
      appendLog(`Update workspace default auto-approve failed: ${errorMessage(error)}`);
    }
  }

  async function toggleSelectedSessionYolo() {
    // The CLIs read their auto-approve flag at process start, so changing the
    // setting on a live session means terminate + relaunch with --resume +
    // the new flag. The adapter contract handles the right flag per CLI
    // (Cortex `--yolo`, Claude `--dangerously-skip-permissions`, Codex
    // `--dangerously-bypass-approvals-and-sandbox`). If the session has no
    // live binding we just update the override and the next launch picks it
    // up.
    if (!selectedSession) return;
    const current = selectedSession.dangerousModeOverride ?? shell.workspace.defaultDangerousMode;
    const next = !current;
    const binding = useTerminalStore.getState().sessionTerminalBindings[selectedSession.id];
    if (binding) {
      const confirmed = window.confirm(
        `Restart this session with auto-approve ${next ? 'on' : 'off'}? The current ${agentLabel(selectedSession.agentKind)} process will terminate and resume with the new mode.`,
      );
      if (!confirmed) return;
    }

    setBusy(true);
    try {
      if (binding) {
        await terminateSession(binding.terminalId).catch(error => {
          appendLog(`Restart terminate failed: ${errorMessage(error)}`);
        });
      }
      const snapshot = await invoke<WorkspaceShellSnapshot>('set_session_dangerous_mode', {
        request: { sessionId: selectedSession.id, dangerousModeOverride: next },
      });
      setShell(snapshot);
      const updated = snapshot.sessions.find(s => s.id === selectedSession.id);
      appendLog(`Auto-approve ${next ? 'on' : 'off'} for ${selectedSession.title}.`);
      if (updated && binding) {
        // Relaunch through the same path as a tab-click: launchSession rebuilds
        // the spawn spec from the persisted session, which now sees the updated
        // override and will include the right dangerous flag.
        void terminal.launchSession(updated).catch(error => {
          appendLog(`Restart with new auto-approve failed: ${errorMessage(error)}`);
        });
      }
    } catch (error) {
      appendLog(`Toggle auto-approve failed: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function setSessionTabVisibility(session: ShellSession, tabVisible: boolean) {
    const snapshot = await invoke<WorkspaceShellSnapshot>('update_session_tab_visibility', {
      request: { shellSessionId: session.id, tabVisible },
    });
    setShell(snapshot);
    return snapshot;
  }

  async function hideSessionTab(event: { stopPropagation: () => void }, session: ShellSession) {
    event.stopPropagation();
    // Closing a tab terminates the underlying CLI process. The session record
    // (title, focus, cwd, native session ref) stays in the store so the user
    // can resume it later; reopening will call the adapter's resume path
    // with the captured native session id, which restarts the CLI with
    // `--resume <id>` and the session's current dangerous-mode override.
    const binding = useTerminalStore.getState().sessionTerminalBindings[session.id];
    if (binding) {
      try {
        await terminateSession(binding.terminalId);
      } catch (error) {
        appendLog(`Close requested terminal stop first; stop failed for ${shortId(binding.terminalId)}: ${errorMessage(error)}`);
      }
    }
    const nextVisibleSession = visibleSessions.find(candidate => candidate.id !== session.id) ?? null;
    const snapshot = await setSessionTabVisibility(session, false);
    if (selectedSessionId === session.id) {
      if (nextVisibleSession) {
        selectSessionTab(nextVisibleSession);
      } else {
        setSelectedSessionId(null);
        terminal.clearSurface();
        const stillHasHistory = snapshot.sessions.some(candidate => candidate.focusId === session.focusId);
        if (stillHasHistory) setSurfaceMode('session-history');
      }
    }
    appendLog(`Closed ${session.title}; CLI process terminated. Reopen to resume.`);
  }

  async function restoreSessionTab(session: ShellSession) {
    await setSessionTabVisibility(session, true);
    setSurfaceMode('terminal');
    selectSessionTab({ ...session, tabVisible: true });
    appendLog(`Restored ${session.title} to active tabs.`);
  }

  async function removeSessionRecord(session: ShellSession) {
    if (!window.confirm(`Delete session “${session.title}”? This removes it from the focus history.`)) return;
    const binding = useTerminalStore.getState().sessionTerminalBindings[session.id];
    if (binding) {
      await terminateSession(binding.terminalId).catch(error => {
        appendLog(`Delete requested terminal stop first; stop failed for ${shortId(binding.terminalId)}: ${errorMessage(error)}`);
      });
    }
    const snapshot = await invoke<WorkspaceShellSnapshot>('remove_session', { sessionId: session.id });
    setShell(snapshot);
    setSessionTerminalBindings(bindings => {
      const next = { ...bindings };
      delete next[session.id];
      return next;
    });
    terminal.dropSession(session.id);
    if (selectedSessionId === session.id) {
      setSelectedSessionId(null);
      terminal.clearSurface();
    }
    appendLog(`Deleted session record: ${session.title}.`);
  }

  async function terminateBoundSessions(sessions: ShellSession[]) {
    for (const session of sessions) {
      const binding = useTerminalStore.getState().sessionTerminalBindings[session.id];
      if (!binding) continue;
      await terminateSession(binding.terminalId).catch(error => {
        appendLog(`Stop before removal failed for ${session.title}: ${errorMessage(error)}`);
      });
    }
  }

  async function archiveFocusRecord(focus: ShellFocus) {
    if (!window.confirm(`Remove focus “${focus.title}” from navigation? Sessions under it will no longer be shown in this workspace view.`)) return;
    await terminateBoundSessions(shell.sessions.filter(session => session.focusId === focus.id));
    const snapshot = await invoke<WorkspaceShellSnapshot>('archive_focus', { focusId: focus.id });
    setShell(snapshot);
    if (selectedFocusId === focus.id) {
      setSelectedFocusId(null);
      setSelectedSessionId(null);
      terminal.clearSurface();
    }
    appendLog(`Removed focus from navigation: ${focus.title}.`);
  }

  async function archiveProjectRecord(project: ShellProject) {
    if (!window.confirm(`Remove project “${project.name}” from navigation? Its focuses and session tabs will be hidden.`)) return;
    const projectFocusIds = new Set(shell.focuses.filter(focus => focus.projectId === project.id).map(focus => focus.id));
    await terminateBoundSessions(shell.sessions.filter(session => projectFocusIds.has(session.focusId)));
    const snapshot = await invoke<WorkspaceShellSnapshot>('archive_project', { projectId: project.id });
    setShell(snapshot);
    if (selectedProjectId === project.id) {
      setSelectedProjectId(null);
      setSelectedFocusId(null);
      setSelectedSessionId(null);
      terminal.clearSurface();
    }
    appendLog(`Removed project from navigation: ${project.name}.`);
  }

  return {
    setWorkspaceDefaultDangerousMode,
    toggleSelectedSessionYolo,
    hideSessionTab,
    restoreSessionTab,
    removeSessionRecord,
    archiveFocusRecord,
    archiveProjectRecord,
  };
}
