import {
  activityForSession,
  agentLabel,
  errorMessage,
  folderNameFromPath,
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
  openFocus: (projectId: string | null, focusId: string) => void;
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
  openFocus,
}: WorkspaceMutationsOptions) {
  const { shell, selectedSession } = model;
  const setShell = useShellStore(s => s.setShell);
  const selectedProjectId = useNavigationStore(s => s.selectedProjectId);
  const setSelectedProjectId = useNavigationStore(s => s.setSelectedProjectId);
  const selectedFocusId = useNavigationStore(s => s.selectedFocusId);
  const setSelectedFocusId = useNavigationStore(s => s.setSelectedFocusId);
  const selectedSessionId = useNavigationStore(s => s.selectedSessionId);
  const setSelectedSessionId = useNavigationStore(s => s.setSelectedSessionId);
  const setSurfaceMode = useNavigationStore(s => s.setSurfaceMode);
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

  // Persist the "keep my Mac awake while tasks run" toggles. The backend reads
  // these back and manages the native macOS power assertion (held only while a
  // session is alive), so the frontend just records intent. `keepDisplay` is the
  // secondary screen-on sub-toggle and is meaningless unless `enabled` is on.
  async function setWorkspaceKeepAwake(enabled: boolean, keepDisplay: boolean) {
    if (
      shell.workspace.keepAwakeEnabled === enabled &&
      shell.workspace.keepDisplayAwake === keepDisplay
    ) {
      return;
    }
    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>('set_workspace_keep_awake', {
        request: { keepAwakeEnabled: enabled, keepDisplayAwake: keepDisplay },
      });
      setShell(snapshot);
      appendLog(
        enabled
          ? `Keep awake on${keepDisplay ? ' (screen stays on)' : ''} while tasks run.`
          : 'Keep awake off.',
      );
    } catch (error) {
      appendLog(`Update keep awake failed: ${errorMessage(error)}`);
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

  // Persist the left navigation panel's width after a drag ends. The shell seeds
  // the layout grid's first column from the snapshot, so the rail reopens at this
  // width on the next load. The backend clamps to a sane range.
  async function setWorkspaceSidebarWidth(next: number) {
    const width = Math.round(next);
    if (shell.workspace.sidebarWidth === width) return;
    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>('set_sidebar_width', {
        request: { sidebarWidth: width },
      });
      setShell(snapshot);
    } catch (error) {
      appendLog(`Update sidebar width failed: ${errorMessage(error)}`);
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

  // Folders dropped onto the left panel each become a new project, silently: the
  // rail just gains the projects, with no surface change. Each path is resolved
  // and created on the backend, which enforces the folder-only rule (a dropped
  // file or missing path is rejected). Creates run sequentially so each sees the
  // previous one persisted and the final snapshot reflects them all; a clean
  // summary toast confirms, and the first failure (if any) surfaces its message.
  async function addProjectsFromDroppedFolders(paths: string[]) {
    const cleaned = paths.map(path => path.trim()).filter(Boolean);
    if (cleaned.length === 0) return;
    setBusy(true);
    // Dropping a folder Reverie already knew (archived) reconnects that project
    // with its topics and sessions instead of making a duplicate; track those
    // separately from genuinely new projects so the toast reads right. The set is
    // captured once and pruned as each reconnect is detected, so a second drop in
    // the same batch can't re-count the same project.
    const archivedBefore = new Set(
      shell.projects.filter(project => project.archived).map(project => project.id),
    );
    const created: string[] = [];
    const reconnected: string[] = [];
    const failures: string[] = [];
    try {
      for (const path of cleaned) {
        try {
          const snapshot = await invoke<WorkspaceShellSnapshot>('create_project_from_folder', {
            path,
          });
          setShell(snapshot);
          const reconnectedProject = snapshot.projects.find(
            project => archivedBefore.has(project.id) && !project.archived,
          );
          if (reconnectedProject) {
            archivedBefore.delete(reconnectedProject.id);
            reconnected.push(reconnectedProject.name);
            appendLog(`Reconnected archived project from dropped folder: ${path}.`);
          } else {
            created.push(folderNameFromPath(path) || 'project');
            appendLog(`Added project from dropped folder: ${path}.`);
          }
        } catch (error) {
          const message = errorMessage(error);
          failures.push(message);
          appendLog(`Add project from dropped folder failed (${path}): ${message}`);
        }
      }
    } finally {
      setBusy(false);
    }
    const { pushToast } = useOverlayStore.getState();
    if (created.length === 1) {
      pushToast({ message: `Added project “${created[0]}”` });
    } else if (created.length > 1) {
      pushToast({ message: `Added ${created.length} projects` });
    }
    if (reconnected.length === 1) {
      pushToast({ message: `Reconnected “${reconnected[0]}” with its topics and sessions` });
    } else if (reconnected.length > 1) {
      pushToast({ message: `Reconnected ${reconnected.length} projects` });
    }
    if (failures.length > 0) {
      // Most drops are a single folder, so surface the first problem; the rest
      // (a rare multi-folder drop with several bad paths) stay in the log.
      pushToast({ message: failures[0] });
    }
  }

  // Rename a session: pin a user-chosen display name. An empty/blank name clears
  // the pin so the session falls back to its automatic OSC-derived title. The
  // live OSC title keeps tracking underneath either way. No-ops when unchanged.
  async function renameSession(session: ShellSession, title: string) {
    const next = title.trim();
    if (next === (session.customTitle ?? '').trim()) return;
    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>('rename_session', {
        request: { sessionId: session.id, title: next },
      });
      setShell(snapshot);
    } catch (error) {
      appendLog(`Rename session failed: ${errorMessage(error)}`);
    }
  }

  // Drop a session's pinned name and return to its automatic title (which has
  // kept updating from the CLI all along). No-op if there is no pin to clear.
  async function resetSessionTitleToAuto(session: ShellSession) {
    if (!session.customTitle) return;
    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>('rename_session', {
        request: { sessionId: session.id, title: '' },
      });
      setShell(snapshot);
    } catch (error) {
      appendLog(`Reset session name failed: ${errorMessage(error)}`);
    }
  }

  // Rename a topic. A topic must keep a name, so a blank rename is ignored.
  async function renameFocus(focus: ShellFocus, title: string) {
    const next = title.trim();
    if (!next || next === focus.title.trim()) return;
    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>('rename_focus', {
        request: { focusId: focus.id, title: next },
      });
      setShell(snapshot);
    } catch (error) {
      appendLog(`Rename topic failed: ${errorMessage(error)}`);
    }
  }

  // Rename a project's display label only; the folder on disk is left untouched.
  async function renameProject(project: ShellProject, name: string) {
    const next = name.trim();
    if (!next || next === project.name.trim()) return;
    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>('rename_project', {
        request: { projectId: project.id, name: next },
      });
      setShell(snapshot);
    } catch (error) {
      appendLog(`Rename project failed: ${errorMessage(error)}`);
    }
  }

  // Reveal a session's working directory or a project's folder in Finder.
  async function revealPath(path: string) {
    if (!path) return;
    try {
      await invoke('reveal_path', { path });
    } catch (error) {
      appendLog(`Reveal in Finder failed: ${errorMessage(error)}`);
    }
  }

  // Copy a folder path to the clipboard, confirming with a quiet toast.
  async function copyPath(path: string) {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      useOverlayStore.getState().pushToast({ message: 'Copied folder path' });
    } catch (error) {
      appendLog(`Copy path failed: ${errorMessage(error)}`);
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
    if (
      isBound &&
      (status === 'working' || status === 'awaiting_permission' || status === 'awaiting_response')
    ) {
      // A permission gate or a raised question is a blocking ask: the agent is
      // paused on you, so closing abandons that ask rather than a running step.
      const blockingAsk = status === 'awaiting_permission' || status === 'awaiting_response';
      useOverlayStore.getState().requestConfirm({
        title: blockingAsk
          ? `“${session.title}” is waiting for you`
          : `“${session.title}” is still working`,
        body: blockingAsk
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
    // Release this session's terminal binding + active-terminal claim and forget
    // its cached buffer synchronously, so the canvas/keyboard cannot keep driving
    // the just-closed process while we re-point the view below (the async
    // terminal_exit cleanup otherwise races this re-selection).
    terminal.detachSession(session.id);
    await setSessionArchived(session, true);
    if (selectedSessionId === session.id) {
      // Closing the session you're viewing returns you to its topic's dashboard
      // (the topic's own session overview), not to another session in the topic.
      const focus = shell.focuses.find(candidate => candidate.id === session.focusId);
      openFocus(focus?.projectId ?? null, session.focusId);
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
    selectSessionTab({ ...session, archived: false });
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
    terminal.detachSession(session.id);
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

  // Restore an archived topic: flip its bit back so it (and its sessions, by
  // ancestry) returns to the project. Safe and reversible, so no confirm.
  async function restoreFocusRecord(focus: ShellFocus) {
    const snapshot = await invoke<WorkspaceShellSnapshot>('restore_focus', { focusId: focus.id });
    setShell(snapshot);
    appendLog(`Restored topic: ${focus.title}.`);
    useOverlayStore.getState().pushToast({ message: `Restored “${focus.title}”` });
  }

  // Permanently delete an archived topic and its sessions. Always confirms.
  async function deleteFocusRecord(focus: ShellFocus) {
    const count = shell.sessions.filter(session => session.focusId === focus.id).length;
    useOverlayStore.getState().requestConfirm({
      title: `Delete topic “${focus.title}”?`,
      body: `This permanently deletes the topic and its ${count} ${count === 1 ? 'session' : 'sessions'} and cannot be undone.`,
      confirmLabel: 'Delete topic',
      danger: true,
      onConfirm: () => void performDeleteFocus(focus),
    });
  }

  async function performDeleteFocus(focus: ShellFocus) {
    await terminateBoundSessions(shell.sessions.filter(session => session.focusId === focus.id));
    const snapshot = await invoke<WorkspaceShellSnapshot>('delete_focus', { focusId: focus.id });
    setShell(snapshot);
    if (selectedFocusId === focus.id) {
      setSelectedFocusId(null);
      setSelectedSessionId(null);
      terminal.clearSurface();
    }
    appendLog(`Deleted topic: ${focus.title}.`);
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

  // Permanently purge an archived project and everything under it. Used by the
  // Settings "Archived projects" list; there is no restore button there because
  // re-adding the folder reconnects, so this is the one destructive action.
  async function deleteProjectRecord(project: ShellProject) {
    const projectFocusIds = new Set(
      shell.focuses.filter(focus => focus.projectId === project.id).map(focus => focus.id),
    );
    const topicCount = projectFocusIds.size;
    const sessionCount = shell.sessions.filter(session =>
      projectFocusIds.has(session.focusId),
    ).length;
    useOverlayStore.getState().requestConfirm({
      title: `Delete “${project.name}” and its data?`,
      body: `This permanently deletes ${topicCount} ${topicCount === 1 ? 'topic' : 'topics'} and ${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'}. The folder on disk is left untouched. This cannot be undone.`,
      confirmLabel: 'Delete project data',
      danger: true,
      onConfirm: () => void performDeleteProject(project),
    });
  }

  async function performDeleteProject(project: ShellProject) {
    const projectFocusIds = new Set(
      shell.focuses.filter(focus => focus.projectId === project.id).map(focus => focus.id),
    );
    await terminateBoundSessions(
      shell.sessions.filter(session => projectFocusIds.has(session.focusId)),
    );
    const snapshot = await invoke<WorkspaceShellSnapshot>('delete_project', {
      projectId: project.id,
    });
    setShell(snapshot);
    if (selectedProjectId === project.id) {
      setSelectedProjectId(null);
      setSelectedFocusId(null);
      setSelectedSessionId(null);
      terminal.clearSurface();
    }
    appendLog(`Deleted project data: ${project.name}.`);
  }

  return {
    setWorkspaceDefaultDangerousMode,
    setWorkspaceTheme,
    setWorkspaceKeepAwake,
    setWorkspaceDefaultAgentKind,
    setWorkspaceTerminalFontSize,
    setWorkspaceSidebarWidth,
    toggleSelectedSessionYolo,
    addProjectsFromDroppedFolders,
    renameSession,
    resetSessionTitleToAuto,
    renameFocus,
    renameProject,
    revealPath,
    copyPath,
    archiveSession,
    restoreSessionTab,
    removeSessionRecord,
    archiveFocusRecord,
    restoreFocusRecord,
    deleteFocusRecord,
    archiveProjectRecord,
    deleteProjectRecord,
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
