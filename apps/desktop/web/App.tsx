import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type UIEvent,
  type WheelEvent,
} from 'react';
import { invoke } from './services/runtime';
import { terminateSession } from './services/terminalApi';
import { useActivityStore, useNavigationStore, usePaletteStore, useShellStore, useTerminalStore, useUiStore } from './store';
import { useAgentClis, useAppFocus, useCommandPalette, useSessionActivity, useTerminalSession } from './hooks';
import { DotField } from './components/chrome';
import { Sidebar } from './components/nav';
import { SessionHistorySurface, SessionTabsBar, TerminalSurface } from './components/session';
import { CommandPalette } from './components/palette';
import { EmptyState } from './components/onboarding';
import { DashboardSurface } from './components/dashboard';
import { CreationComposer } from './components/creation';
import { SettingsSurface } from './components/settings';

import { css } from './styled-system/css';
import { appShellClass } from './themes/appShell';
import {
  USER_HOME,
  shortId,
  folderNameFromPath,
  agentLabel,
  dangerousLabel,
  activityForSession,
  errorMessage,
} from './domain';
import type {
  CreationMode,
  WorkspaceShellSnapshot,
  ShellProject,
  ShellFocus,
  ShellSession,
  ActivityPermissionRequest,
  ActivityState,
  CreateProjectRequest,
  ProjectFolderSelection,
  CreateFocusRequest,
  CreateSessionRecordRequest,
} from './domain';
import { terminalScrollbackContract } from './terminalScrollback';
import { maybeRunHarnessSmokeTest } from './harnessSmoke';



export function App() {
  const shell = useShellStore(s => s.shell);
  const setShell = useShellStore(s => s.setShell);
  const selectedProjectId = useNavigationStore(s => s.selectedProjectId);
  const setSelectedProjectId = useNavigationStore(s => s.setSelectedProjectId);
  const selectedFocusId = useNavigationStore(s => s.selectedFocusId);
  const setSelectedFocusId = useNavigationStore(s => s.setSelectedFocusId);
  const selectedSessionId = useNavigationStore(s => s.selectedSessionId);
  const setSelectedSessionId = useNavigationStore(s => s.setSelectedSessionId);
  const creationMode = useNavigationStore(s => s.creationMode);
  const setCreationMode = useNavigationStore(s => s.setCreationMode);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newFocusTitle, setNewFocusTitle] = useState('');
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [newSessionCwd, setNewSessionCwd] = useState(USER_HOME);
  const [newSessionAgentKind, setNewSessionAgentKind] = useState<CreateSessionRecordRequest['agentKind']>('cortex_code');
  const [newSessionDangerousMode, setNewSessionDangerousMode] = useState(false);
  const agentCliDetections = useShellStore(s => s.agentCliDetections);
  const runningSessionId = useTerminalStore(s => s.runningSessionId);
  // Tracks which session is mid-launch so the terminal surface can show the
  // breathing launch animation. Cleared automatically when the live terminal
  // binding arrives, or on launch failure.
  const launchingSessionId = useTerminalStore(s => s.launchingSessionId);
  const setLaunchingSessionId = useTerminalStore(s => s.setLaunchingSessionId);
  // Command palette visibility + current query. The palette filters across
  // focuses and sessions in the whole workspace; bound to ⌘K (Ctrl+K on
  // non-mac) and to clicking the search bar.
  const paletteOpen = usePaletteStore(s => s.paletteOpen);
  const setPaletteOpen = usePaletteStore(s => s.setPaletteOpen);
  const paletteQuery = usePaletteStore(s => s.paletteQuery);
  const setPaletteQuery = usePaletteStore(s => s.setPaletteQuery);
  // Map from Cortex session id → live ActivityState. Reverie sessions look up
  // their entry by `nativeSessionRef.sessionId`. Sessions Reverie doesn't own
  // still land in the map but stay invisible until correlation succeeds.
  const cortexActivity = useActivityStore(s => s.cortexActivity);
  const sessionTerminalBindings = useTerminalStore(s => s.sessionTerminalBindings);
  const setSessionTerminalBindings = useTerminalStore(s => s.setSessionTerminalBindings);
  const terminalSurface = useTerminalStore(s => s.terminalSurface);
  const scrollbackRowCount = useTerminalStore(s => s.scrollbackRowCount);
  const terminalLiveFollow = useTerminalStore(s => s.terminalLiveFollow);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const theme = useUiStore(s => s.theme);
  const setTheme = useUiStore(s => s.setTheme);
  const surfaceMode = useNavigationStore(s => s.surfaceMode);
  const setSurfaceMode = useNavigationStore(s => s.setSurfaceMode);
  const appFocused = useUiStore(s => s.appFocused);
  const isTauriRuntime = useMemo(() => Boolean(window.__TAURI_INTERNALS__ || (window.__TAURI__ && !window.__REVERIE_BROWSER_FIXTURE__)), []);
  const canUseAppServices = true;
  const scrollbackContract = useMemo(() => terminalScrollbackContract(terminalSurface), [terminalSurface]);

  const selectedProject = selectedProjectId ? shell.projects.find(project => project.id === selectedProjectId) ?? null : null;
  const selectedProjectIdRef = useRef<string | null>(selectedProjectId);
  const selectedProjectRef = useRef<ShellProject | null>(selectedProject);
  // The session id we've already auto-launched for the current selection. Opening
  // a session in the terminal surface starts it once; if that launch fails the
  // idle overlay's Run/Resume button is the manual fallback, so we don't retry.
  const autoLaunchedSessionIdRef = useRef<string | null>(null);
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
  const selectedSession = creationMode || surfaceMode === 'session-history' || surfaceMode === 'dashboard' ? null : visibleSessions.find(session => session.id === selectedSessionId) ?? visibleSessions[0] ?? null;
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

  // Clean up the launchingSessionId once the live binding arrives (the breathing
  // overlay disappears as soon as the real terminal surface takes over).
  useEffect(() => {
    if (launchingSessionId && sessionTerminalBindings[launchingSessionId]) {
      setLaunchingSessionId(null);
    }
  }, [launchingSessionId, sessionTerminalBindings]);
  const runningSession = runningSessionId ? shell.sessions.find(session => session.id === runningSessionId) ?? null : null;
  const effectiveDangerousMode = dangerousLabel(selectedSession, shell.workspace.defaultDangerousMode) !== 'Off';
  // Plain-language status shown in the terminal meta strip. We deliberately
  // omit terminal-internal details (cols×rows, scrollback row counts) from
  // the primary surface; they're available behind diagnostics if needed.
  const runningLabel = selectedTerminalBinding
    ? (selectedTerminalBinding.inputArmed ? 'Running' : 'Starting')
    : busy ? 'Working' : selectedSession ? 'Ready to launch' : 'Ready';

  const writeLog = (line: string) => {
    const stamped = `[${new Date().toLocaleTimeString()}] ${line}`;
    setLogs(current => [stamped, ...current].slice(0, 80));
  };

  const terminal = useTerminalSession({ selectedSession, writeLog, loadWorkspaceShell, setBusy, isTauriRuntime });

  // A terminal session you're looking at should be running, not parked behind a
  // Run button. Opening a focus, clicking a tab, or creating a session already
  // launches directly; this is the safety net for the remaining ways the
  // terminal surface can land on an idle session (opening a project or the
  // General group, falling back to the first visible tab). We auto-launch a
  // selection once: a restore_failed session waits for an explicit retry, and a
  // launch that fails falls back to the overlay's manual Run/Resume button.
  useEffect(() => {
    if (surfaceMode !== 'terminal' || creationMode || !selectedSession) return;
    if (selectedTerminalBinding || isLaunchingSelectedSession) return;
    if (selectedSession.status === 'restore_failed') return;
    if (autoLaunchedSessionIdRef.current === selectedSession.id) return;
    terminal.autostartSession(selectedSession);
  }, [surfaceMode, creationMode, selectedSession?.id, selectedSession?.status, selectedTerminalBinding, isLaunchingSelectedSession]);

  // Global ⌘K / Ctrl+K opens the command palette from any surface, and Esc
  // closes it. We swallow the default browser behavior for the shortcut so
  // it doesn't trigger find-in-page when the focus is inside the terminal.
  useCommandPalette();

  useSessionActivity(writeLog);

  async function loadWorkspaceShell() {
    if (!canUseAppServices) return null;

    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>('workspace_shell');
      setShell(snapshot);
      writeLog(`Loaded persisted workspace shell: ${snapshot.projects.length} project, ${snapshot.focuses.length} focuses, ${snapshot.sessions.length} sessions.`);
      return snapshot;
    } catch (error) {
      writeLog(`Workspace shell command failed; using browser fallback data: ${errorMessage(error)}`);
      return null;
    }
  }

  useEffect(() => {
    loadWorkspaceShell().catch(error => {
      writeLog(`Workspace shell load failed: ${errorMessage(error)}`);
    });
  }, [isTauriRuntime]);

  useAgentClis(newSessionAgentKind, setNewSessionAgentKind, writeLog);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
    selectedProjectRef.current = selectedProject;
  }, [selectedProject, selectedProjectId]);

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

  useEffect(() => {
    setNewSessionCwd(selectedFocusDefaultCwd);
  }, [selectedFocusDefaultCwd]);

  useEffect(() => {
    maybeRunHarnessSmokeTest();
  }, []);

  useAppFocus();

  function defaultCwdForFocus(focus: ShellFocus | null, snapshot: WorkspaceShellSnapshot = shell) {
    if (!focus?.projectId) return USER_HOME;
    return snapshot.projects.find(project => project.id === focus.projectId)?.path ?? USER_HOME;
  }

  async function chooseProjectFolder() {
    if (!canUseAppServices) return;
    setBusy(true);
    try {
      const selection = await invoke<ProjectFolderSelection | null>('choose_project_folder');
      if (!selection) {
        writeLog('Project folder selection cancelled.');
        return;
      }
      setNewProjectPath(selection.path);
      setNewProjectName(selection.name || folderNameFromPath(selection.path) || 'New project');
      setNewSessionCwd(selection.path);
      writeLog(`Selected project folder: ${selection.path}.`);
    } catch (error) {
      writeLog(`Choose project folder failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function createProjectFromComposer() {
    if (!canUseAppServices) return;
    setBusy(true);
    try {
      const request: CreateProjectRequest = {
        name: newProjectName.trim() || folderNameFromPath(newProjectPath) || 'New project',
        path: newProjectPath.trim(),
      };
      const snapshot = await invoke<WorkspaceShellSnapshot>('create_project', { request });
      const created = snapshot.projects[snapshot.projects.length - 1];
      const nextProjectId = created?.id ?? selectedProjectId;
      selectedProjectIdRef.current = nextProjectId;
      selectedProjectRef.current = created ?? selectedProjectRef.current;
      setShell(snapshot);
      setSelectedProjectId(nextProjectId);
      setSelectedFocusId(null);
      setSelectedSessionId(null);
      setNewProjectName('');
      setNewProjectPath('');
      setCreationMode('focus');
      writeLog(`Created project: ${created?.name ?? request.name}.`);
    } catch (error) {
      writeLog(`Create project failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function createFocusForSelection() {
    if (!canUseAppServices) return;
    setBusy(true);
    try {
      const targetProjectId = selectedProjectIdRef.current;
      const targetProject = selectedProjectRef.current;
      const title = newFocusTitle.trim() || (targetProject ? `${targetProject.name} focus` : 'New focus');
      const request: CreateFocusRequest = {
        projectId: targetProjectId,
        title,
        description: targetProject
          ? `Focused work under ${targetProject.name}.`
          : 'Unprojected work that can become project-backed later.',
      };
      const snapshot = await invoke<WorkspaceShellSnapshot>('create_focus', { request });
      const created = snapshot.focuses[snapshot.focuses.length - 1];
      setShell(snapshot);
      setSelectedFocusId(created?.id ?? null);
      setSelectedSessionId(null);
      setNewFocusTitle('');
      setNewSessionCwd(defaultCwdForFocus(created ?? null, snapshot));
      setCreationMode('session');
      setSurfaceMode('terminal');
      writeLog(`Created focus: ${created?.title ?? request.title}.`);
    } catch (error) {
      writeLog(`Create focus failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function createSessionForSelection() {
    if (!canUseAppServices || !selectedFocus) return;
    setBusy(true);
    try {
      const title = newSessionTitle.trim() || `${agentLabel(newSessionAgentKind)} session`;
      const defaultCwd = defaultCwdForFocus(selectedFocus);
      const enteredCwd = newSessionCwd.trim();
      const cwd = enteredCwd || defaultCwd;
      const request: CreateSessionRecordRequest = {
        focusId: selectedFocus.id,
        title,
        agentKind: newSessionAgentKind,
        cwd,
        dangerousModeOverride: newSessionDangerousMode,
      };
      const snapshot = await invoke<WorkspaceShellSnapshot>('create_session', { request });
      const created = snapshot.sessions[snapshot.sessions.length - 1];
      setShell(snapshot);
      setSelectedSessionId(created?.id ?? null);
      setNewSessionTitle('');
      setCreationMode(null);
      setSurfaceMode('terminal');
      writeLog(`Created session: ${created?.title ?? request.title}. Preparing terminal handoff for the selected CLI.`);
      if (created) {
        terminal.autostartSession(created);
      }
    } catch (error) {
      writeLog(`Create session failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  function selectSessionTab(session: ShellSession) {
    // Selecting a tab is an "open this session" intent. If it's already bound
    // to a live PTY we just re-focus it; otherwise we launch (or resume, if
    // there's a native session ref). The user shouldn't have to also click a
    // separate Run button just to start a session they meant to open.
    const attached = terminal.activateSession(session);
    if (attached) return;
    void terminal.launchSession(session).catch(error => {
      const verb = session.nativeSessionRef ? 'Resume' : 'Launch';
      writeLog(`${verb} failed for ${session.title}: ${errorMessage(error)}`);
    });
  }

  function goToDashboard() {
    setCreationMode(null);
    setSurfaceMode('dashboard');
  }

  function openSessionFromDashboard(session: ShellSession) {
    const focus = shell.focuses.find(f => f.id === session.focusId);
    if (!focus) return;
    const projectId = focus.projectId ?? null;
    selectedProjectIdRef.current = projectId;
    selectedProjectRef.current = projectId
      ? shell.projects.find(p => p.id === projectId) ?? null
      : null;
    setSelectedProjectId(projectId);
    setSelectedFocusId(session.focusId);
    setSelectedSessionId(session.id);
    setCreationMode(null);
    setSurfaceMode('terminal');
    selectSessionTab(session);
  }

  function openFocus(projectId: string | null, focusId: string) {
    selectedProjectIdRef.current = projectId;
    selectedProjectRef.current = projectId ? shell.projects.find(project => project.id === projectId) ?? null : null;
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
    selectedProjectIdRef.current = projectId;
    selectedProjectRef.current = projectId ? shell.projects.find(project => project.id === projectId) ?? null : null;
    setSelectedProjectId(projectId);
    setSelectedFocusId(focusId);
    setSelectedSessionId(null);
    setCreationMode(null);
    setSurfaceMode('session-history');
    terminal.clearSurface();
  }

  async function setWorkspaceDefaultDangerousMode(next: boolean) {
    if (shell.workspace.defaultDangerousMode === next) return;
    try {
      const snapshot = await invoke<WorkspaceShellSnapshot>('set_workspace_default_dangerous_mode', {
        request: { defaultDangerousMode: next },
      });
      setShell(snapshot);
      writeLog(`Default auto-approve set to ${next ? 'on' : 'off'} for this workspace.`);
    } catch (error) {
      writeLog(`Update workspace default auto-approve failed: ${errorMessage(error)}`);
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
          writeLog(`Restart terminate failed: ${errorMessage(error)}`);
        });
      }
      const snapshot = await invoke<WorkspaceShellSnapshot>('set_session_dangerous_mode', {
        request: { sessionId: selectedSession.id, dangerousModeOverride: next },
      });
      setShell(snapshot);
      const updated = snapshot.sessions.find(s => s.id === selectedSession.id);
      writeLog(`Auto-approve ${next ? 'on' : 'off'} for ${selectedSession.title}.`);
      if (updated && binding) {
        // Relaunch through the same path as a tab-click: launchRuntimeSession
        // rebuilds the spawn spec from the persisted session, which now sees
        // the updated override and will include the right dangerous flag.
        void terminal.launchSession(updated).catch(error => {
          writeLog(`Restart with new auto-approve failed: ${errorMessage(error)}`);
        });
      }
    } catch (error) {
      writeLog(`Toggle auto-approve failed: ${errorMessage(error)}`);
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
    // with the captured native session id (Cortex today, Claude/Codex once
    // their capture lands), which restarts the CLI with `--resume <id>` and
    // the session's current dangerous-mode override.
    const binding = useTerminalStore.getState().sessionTerminalBindings[session.id];
    if (binding) {
      try {
        await terminateSession(binding.terminalId);
      } catch (error) {
        writeLog(`Close requested terminal stop first; stop failed for ${shortId(binding.terminalId)}: ${errorMessage(error)}`);
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
    writeLog(`Closed ${session.title}; CLI process terminated. Reopen to resume.`);
  }

  async function restoreSessionTab(session: ShellSession) {
    await setSessionTabVisibility(session, true);
    setSurfaceMode('terminal');
    selectSessionTab({ ...session, tabVisible: true });
    writeLog(`Restored ${session.title} to active tabs.`);
  }

  async function removeSessionRecord(session: ShellSession) {
    if (!window.confirm(`Delete session “${session.title}”? This removes it from the focus history.`)) return;
    const binding = useTerminalStore.getState().sessionTerminalBindings[session.id];
    if (binding) {
      await terminateSession(binding.terminalId).catch(error => {
        writeLog(`Delete requested terminal stop first; stop failed for ${shortId(binding.terminalId)}: ${errorMessage(error)}`);
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
    writeLog(`Deleted session record: ${session.title}.`);
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
    writeLog(`Removed focus from navigation: ${focus.title}.`);
  }

  async function terminateBoundSessions(sessions: ShellSession[]) {
    for (const session of sessions) {
      const binding = useTerminalStore.getState().sessionTerminalBindings[session.id];
      if (!binding) continue;
      await terminateSession(binding.terminalId).catch(error => {
        writeLog(`Stop before removal failed for ${session.title}: ${errorMessage(error)}`);
      });
    }
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
    writeLog(`Removed project from navigation: ${project.name}.`);
  }

  function openCreation(mode: NonNullable<CreationMode>, projectId = selectedProjectId) {
    setCreationMode(mode);
    setSurfaceMode('terminal');
    if (mode === 'focus') {
      selectedProjectIdRef.current = projectId;
      selectedProjectRef.current = projectId ? shell.projects.find(project => project.id === projectId) ?? null : null;
      setSelectedProjectId(projectId);
    }
    if (mode === 'session') {
      setNewSessionCwd(defaultCwdForFocus(selectedFocus));
    }
  }

  return (
    <main className={appShellClass} data-theme={theme} data-app-focused={appFocused ? 'true' : 'false'} data-testid="reverie-app-shell">
      <div className={windowDragStripClass} data-tauri-drag-region aria-hidden="true" />
      <DotField variant="ambient" />

      <Sidebar
        shell={shell}
        surfaceMode={surfaceMode}
        selectedProjectId={selectedProjectId}
        selectedFocusId={selectedFocusId}
        liveSessionCount={liveSessionCount}
        busy={busy}
        canUseAppServices={canUseAppServices}
        onOpenCommandPalette={() => setPaletteOpen(true)}
        onGoToDashboard={goToDashboard}
        onSelectProject={projectId => {
          setSelectedProjectId(projectId);
          setSurfaceMode('terminal');
        }}
        onOpenFocus={openFocus}
        onOpenSessionHistory={openSessionHistory}
        onArchiveFocus={focus => void archiveFocusRecord(focus)}
        onArchiveProject={project => void archiveProjectRecord(project)}
        onOpenCreation={openCreation}
        onOpenSettings={() => setSurfaceMode('settings')}
      />

      <section className={canvasStageClass} aria-label="Focus view" data-testid="focus-stage">
        {surfaceMode === 'dashboard' ? (
          <DashboardSurface
            shell={shell}
            sessionTerminalBindings={sessionTerminalBindings}
            cortexActivity={cortexActivity}
            onOpenSession={openSessionFromDashboard}
            onCreateProject={() => openCreation('project')}
            onCreateFocus={() => openCreation('focus')}
            cliDetections={agentCliDetections}
            onSetWorkspaceDefaultDangerousMode={next => void setWorkspaceDefaultDangerousMode(next)}
          />
        ) : surfaceMode === 'settings' ? (
          <SettingsSurface
            newSessionAgentKind={newSessionAgentKind}
            setNewSessionAgentKind={setNewSessionAgentKind}
            newSessionDangerousMode={newSessionDangerousMode}
            setNewSessionDangerousMode={setNewSessionDangerousMode}
          />
        ) : surfaceMode === 'session-history' ? (
          <SessionHistorySurface
            focus={selectedFocus}
            sessions={focusSessions}
            visibleCount={visibleSessions.length}
            hiddenCount={hiddenFocusSessions.length}
            onRestore={session => restoreSessionTab(session).catch(error => writeLog(`Restore failed: ${errorMessage(error)}`))}
            onDelete={session => removeSessionRecord(session).catch(error => writeLog(`Delete failed: ${errorMessage(error)}`))}
            onCreateSession={() => openCreation('session')}
            busy={busy}
          />
        ) : (
          <div className={activeSurfaceClass} data-testid="terminal-stage">
            {!creationMode ? (
              <SessionTabsBar
                visibleSessions={visibleSessions}
                selectedSessionId={selectedSession?.id ?? null}
                runningSessionId={runningSessionId}
                busy={busy}
                canUseAppServices={canUseAppServices}
                canCreateSession={Boolean(selectedFocus)}
                hasSelectedSession={Boolean(selectedSession)}
                hasTerminalBinding={Boolean(selectedTerminalBinding)}
                effectiveDangerousMode={effectiveDangerousMode}
                onSelectSession={selectSessionTab}
                onCloseSession={hideSessionTab}
                onCreateSession={() => openCreation('session')}
                onToggleDangerousMode={() => void toggleSelectedSessionYolo()}
              />
            ) : null}

            {creationMode ? (
              <CreationComposer
                mode={creationMode}
                selectedProject={selectedProject}
                selectedFocus={selectedFocus}
                newProjectName={newProjectName}
                setNewProjectName={setNewProjectName}
                newProjectPath={newProjectPath}
                setNewProjectPath={setNewProjectPath}
                newFocusTitle={newFocusTitle}
                setNewFocusTitle={setNewFocusTitle}
                newSessionTitle={newSessionTitle}
                setNewSessionTitle={setNewSessionTitle}
                newSessionCwd={newSessionCwd}
                setNewSessionCwd={setNewSessionCwd}
                newSessionAgentKind={newSessionAgentKind}
                setNewSessionAgentKind={setNewSessionAgentKind}
                newSessionDangerousMode={newSessionDangerousMode}
                setNewSessionDangerousMode={setNewSessionDangerousMode}
                cliDetections={agentCliDetections}
                busy={busy}
                onChooseProjectFolder={() => chooseProjectFolder().catch(() => {})}
                onCreateProject={() => createProjectFromComposer().catch(() => {})}
                onCreateFocus={() => createFocusForSelection().catch(() => {})}
                onCreateSession={() => createSessionForSelection().catch(() => {})}
                onCancel={() => setCreationMode(null)}
              />
            ) : null}

            {selectedSession && !creationMode ? (
              <TerminalSurface
                session={selectedSession}
                shell={shell}
                terminalBinding={selectedTerminalBinding}
                runningLabel={runningLabel}
                terminalLiveFollow={terminalLiveFollow}
                scrollbackRowCount={scrollbackRowCount}
                scrollbackMaxRows={scrollbackContract.maxRenderedHistoryRows}
                permissionRequest={selectedPermissionRequest}
                launching={isLaunchingSelectedSession}
                busy={busy}
                terminal={terminal}
                onLaunch={() => {
                  void terminal.launchSession(selectedSession).catch(error => {
                    writeLog(`Launch failed: ${errorMessage(error)}`);
                  });
                }}
              />
            ) : creationMode ? null : (
              <EmptyState
                cliDetections={agentCliDetections}
                createFocus={() => openCreation('focus')}
                createProject={() => openCreation('project')}
                openSettings={() => setSurfaceMode('settings')}
                workspaceDefaultDangerousMode={shell.workspace.defaultDangerousMode}
                onSetWorkspaceDefaultDangerousMode={next => void setWorkspaceDefaultDangerousMode(next)}
              />
            )}
          </div>
        )}
      </section>

      {paletteOpen ? (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onPickSession={session => {
            setPaletteOpen(false);
            openSessionFromDashboard(session);
          }}
          onPickFocus={(projectId, focusId) => {
            setPaletteOpen(false);
            openFocus(projectId, focusId);
          }}
        />
      ) : null}
    </main>
  );
}







const canUseAppServices = true;


const windowDragStripClass = css({
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  height: '22px',
  zIndex: 4,
  lgDown: { height: '14px' },
  mdDown: { display: 'none' },
});

const canvasStageClass = css({
  zIndex: 2,
  minWidth: 0,
  minHeight: 0,
  position: 'relative',
});

const activeSurfaceClass = css({
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  borderRadius: '22px',
  background: 'transparent',
});






