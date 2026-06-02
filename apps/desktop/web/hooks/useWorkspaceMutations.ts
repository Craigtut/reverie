import {
  activityForSession,
  agentLabel,
  errorMessage,
  rollupSessionStates,
  shortId,
} from '../domain';
import type {
  ShellFocus,
  ShellProject,
  ShellSession,
  ShellWorkspace,
  WorkspaceShellSnapshot,
} from '../domain';
import { invoke } from '../services/runtime';
import { terminateSession } from '../services/terminalApi';
import {
  useActivityStore,
  useNavigationStore,
  useOverlayStore,
  useShellStore,
  useTerminalStore,
  useUiStore,
} from '../store';
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
export function useWorkspaceMutations({
  model,
  terminal,
  selectSessionTab,
}: WorkspaceMutationsOptions) {
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
      const snapshot = await invoke<WorkspaceShellSnapshot>(
        'set_workspace_default_dangerous_mode',
        {
          request: { defaultDangerousMode: next },
        },
      );
      setShell(snapshot);
      appendLog(`Default auto-approve set to ${next ? 'on' : 'off'} for this workspace.`);
    } catch (error) {
      appendLog(`Update workspace default auto-approve failed: ${errorMessage(error)}`);
    }
  }

  // Persist the workspace appearance (light/dark). The caller also flips the
  // live uiStore theme so the UI changes immediately; this write makes the
  // choice survive restarts by seeding it back on the next shell load.
  async function setWorkspaceTheme(next: ShellWorkspace['theme']) {
    if (shell.workspace.theme === next) return;
    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>('set_workspace_theme', {
        request: { theme: next },
      });
      setShell(snapshot);
      appendLog(`Theme set to ${next} for this workspace.`);
    } catch (error) {
      appendLog(`Update workspace theme failed: ${errorMessage(error)}`);
    }
  }

  // Persist the default agent kind seeded into the new-session composer. Only a
  // starting value for future new-session forms; it does not touch any existing
  // session. The caller also seeds the live composer state.
  async function setWorkspaceDefaultAgentKind(next: ShellWorkspace['defaultAgentKind']) {
    if (shell.workspace.defaultAgentKind === next) return;
    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>('set_workspace_default_agent_kind', {
        request: { defaultAgentKind: next },
      });
      setShell(snapshot);
      appendLog(`Default agent for new sessions set to ${agentLabel(next)}.`);
    } catch (error) {
      appendLog(`Update default agent for new sessions failed: ${errorMessage(error)}`);
    }
  }

  // Persist the terminal font size. The terminal hook reads it from the shell
  // snapshot and re-derives the cell from the font, so the change live-applies to
  // open terminals (the renderer remeasures and the backend PTY is resized).
  async function setWorkspaceTerminalFontSize(next: number) {
    if (shell.workspace.terminalFontSize === next) return;
    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>('set_terminal_font_size', {
        request: { terminalFontSize: next },
      });
      setShell(snapshot);
      appendLog(`Terminal font size set to ${next}px.`);
    } catch (error) {
      appendLog(`Update terminal font size failed: ${errorMessage(error)}`);
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

  async function setSessionArchived(session: ShellSession, archived: boolean) {
    const snapshot = await invoke<WorkspaceShellSnapshot>('set_session_archived', {
      request: { shellSessionId: session.id, archived },
    });
    setShell(snapshot);
    return snapshot;
  }

  // Closing a session archives it: the CLI process tree is terminated, its tab
  // is dropped, and it leaves Home and the sidebar for the focus's archived
  // list. The record (title, focus, cwd, native session ref) stays, so restore
  // can resume it later with `--resume <id>` and the current dangerous-mode
  // override. Invoked from the tab bar X and the sidebar session row X.
  //
  // Closing an idle/dormant session stays quiet and instant (with an Undo
  // toast), since archival is reversible and stopping a resting process is
  // harmless. But if the agent is mid-work or waiting on a permission decision,
  // closing throws away the in-progress step, so we confirm first.
  async function archiveSession(session: ShellSession) {
    const cortexActivity = useActivityStore.getState().cortexActivity;
    const status = activityForSession(session, cortexActivity)?.status;
    const isBound = Boolean(useTerminalStore.getState().sessionTerminalBindings[session.id]);
    if (isBound && (status === 'working' || status === 'awaiting_permission')) {
      const awaitingPermission = status === 'awaiting_permission';
      useOverlayStore.getState().requestConfirm({
        title: awaitingPermission
          ? `“${session.title}” is waiting for your approval`
          : `“${session.title}” is still working`,
        body: awaitingPermission
          ? 'Closing it stops the agent now without finishing. The conversation is saved and you can resume it later.'
          : 'Closing it stops the agent now. The conversation is saved and you can resume it later, but the current step won’t finish.',
        confirmLabel: 'Close and stop',
        danger: true,
        onConfirm: () => void performArchiveSession(session),
      });
      return;
    }
    await performArchiveSession(session);
  }

  async function performArchiveSession(session: ShellSession) {
    const binding = useTerminalStore.getState().sessionTerminalBindings[session.id];
    if (binding) {
      try {
        await terminateSession(binding.terminalId);
      } catch (error) {
        appendLog(
          `Close requested terminal stop first; stop failed for ${shortId(binding.terminalId)}: ${errorMessage(error)}`,
        );
      }
    }
    const nextVisibleSession =
      visibleSessions.find(candidate => candidate.id !== session.id) ?? null;
    const snapshot = await setSessionArchived(session, true);
    if (selectedSessionId === session.id) {
      if (nextVisibleSession) {
        selectSessionTab(nextVisibleSession);
      } else {
        setSelectedSessionId(null);
        terminal.clearSurface();
        const stillHasActive = snapshot.sessions.some(
          candidate => candidate.focusId === session.focusId && !candidate.archived,
        );
        setSurfaceMode(stillHasActive ? 'dashboard' : 'session-history');
      }
    }
    appendLog(`Closed ${session.title}; archived to the focus history.`);
    useOverlayStore.getState().pushToast({
      message: `Closed “${session.title}”`,
      actionLabel: 'Undo',
      onAction: () => {
        void setSessionArchived(session, false).then(() =>
          appendLog(`Restored ${session.title} from history.`),
        );
      },
    });
  }

  async function restoreSessionTab(session: ShellSession) {
    await setSessionArchived(session, false);
    setSurfaceMode('terminal');
    selectSessionTab({ ...session, tabVisible: true, archived: false });
    appendLog(`Restored ${session.title} to active tabs.`);
  }

  // Permanently delete a session from the focus history (not reversible), so
  // this always asks first via the confirm sheet.
  async function removeSessionRecord(session: ShellSession) {
    useOverlayStore.getState().requestConfirm({
      title: `Delete “${session.title}”?`,
      body: 'This permanently removes the session from the focus history and cannot be undone.',
      confirmLabel: 'Delete session',
      danger: true,
      onConfirm: () => void performRemoveSession(session),
    });
  }

  async function performRemoveSession(session: ShellSession) {
    const binding = useTerminalStore.getState().sessionTerminalBindings[session.id];
    if (binding) {
      await terminateSession(binding.terminalId).catch(error => {
        appendLog(
          `Delete requested terminal stop first; stop failed for ${shortId(binding.terminalId)}: ${errorMessage(error)}`,
        );
      });
    }
    const snapshot = await invoke<WorkspaceShellSnapshot>('remove_session', {
      sessionId: session.id,
    });
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

  // Removing a focus or project hides several sessions at once (a cascade), so
  // these always confirm first and describe what is at stake.
  async function archiveFocusRecord(focus: ShellFocus) {
    const focusSessions = shell.sessions.filter(
      session => session.focusId === focus.id && !session.archived,
    );
    const rollup = rollupSessionStates(
      focusSessions,
      useTerminalStore.getState().sessionTerminalBindings,
      useActivityStore.getState().cortexActivity,
    );
    useOverlayStore.getState().requestConfirm({
      title: `Remove focus “${focus.title}”?`,
      body: describeRemoval('focus', focusSessions.length, rollup.attention),
      confirmLabel: 'Remove focus',
      danger: true,
      onConfirm: () => void performArchiveFocus(focus),
    });
  }

  async function performArchiveFocus(focus: ShellFocus) {
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
    const projectFocusIds = new Set(
      shell.focuses.filter(focus => focus.projectId === project.id).map(focus => focus.id),
    );
    const projectSessions = shell.sessions.filter(
      session => projectFocusIds.has(session.focusId) && !session.archived,
    );
    const rollup = rollupSessionStates(
      projectSessions,
      useTerminalStore.getState().sessionTerminalBindings,
      useActivityStore.getState().cortexActivity,
    );
    useOverlayStore.getState().requestConfirm({
      title: `Remove project “${project.name}”?`,
      body: describeRemoval('project', projectSessions.length, rollup.attention),
      confirmLabel: 'Remove project',
      danger: true,
      onConfirm: () => void performArchiveProject(project),
    });
  }

  async function performArchiveProject(project: ShellProject) {
    const projectFocusIds = new Set(
      shell.focuses.filter(focus => focus.projectId === project.id).map(focus => focus.id),
    );
    await terminateBoundSessions(
      shell.sessions.filter(session => projectFocusIds.has(session.focusId)),
    );
    const snapshot = await invoke<WorkspaceShellSnapshot>('archive_project', {
      projectId: project.id,
    });
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
    setWorkspaceTheme,
    setWorkspaceDefaultAgentKind,
    setWorkspaceTerminalFontSize,
    toggleSelectedSessionYolo,
    archiveSession,
    restoreSessionTab,
    removeSessionRecord,
    archiveFocusRecord,
    archiveProjectRecord,
  };
}

// Plain-language summary of what removing a focus or project takes off the
// board, used in the confirm sheet so the user knows the stakes before acting.
function describeRemoval(
  kind: 'focus' | 'project',
  sessionCount: number,
  attention: number,
): string {
  if (sessionCount === 0) {
    return `This ${kind} is empty. Removing it hides it from the workspace; nothing is deleted.`;
  }
  const sessions = `${sessionCount} session${sessionCount === 1 ? '' : 's'}`;
  const needs = attention > 0 ? ` (${attention} waiting on you)` : '';
  return `${sessions}${needs} live under this ${kind}. Removing it hides them from the workspace; they stay resumable.`;
}

export type WorkspaceMutations = ReturnType<typeof useWorkspaceMutations>;
