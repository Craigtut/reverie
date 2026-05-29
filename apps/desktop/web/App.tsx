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
import { AgentGlyph, SessionStatusGlyph } from './components/glyphs';
import { TrafficLights, DotField } from './components/chrome';
import { Sidebar } from './components/nav';
import { SessionLaunchOverlay, SessionHistorySurface } from './components/session';
import { CommandPalette } from './components/palette';
import { EmptyState } from './components/onboarding';
import { DashboardSurface } from './components/dashboard';
import { CreationComposer } from './components/creation';
import { SettingsSurface } from './components/settings';
import { motion } from 'motion/react';
import {
  CaretRight,
  CircleDashed,
  Folder,
  GearSix,
  House,
  MagnifyingGlass,
  Moon,
  Play,
  Plus,
  ShieldWarning,
  Sun,
  TerminalWindow,
  Warning,
  X,
} from '@phosphor-icons/react';

import { css, cx } from './styled-system/css';
import { appShellClass } from './themes/appShell';
import { rimLitPanelClass } from './themes/surfaces';
import {
  USER_HOME,
  sessionBreadcrumb,
  sessionsForProject,
  shortenCwd,
  shortId,
  folderNameFromPath,
  agentLabel,
  agentTabLabel,
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
              <div className={topBandClass}>
                <div className={tabsClass} data-testid="session-tabs">
                  {visibleSessions.map(session => (
                    <button
                      key={session.id}
                      className={tabClass({ active: session.id === selectedSession?.id })}
                      type="button"
                      data-testid="session-tab"
                      data-session-id={session.id}
                      data-active={session.id === selectedSession?.id ? 'true' : 'false'}
                      onClick={() => selectSessionTab(session)}
                    >
                      <AgentGlyph kind={session.agentKind} />
                      <span>{agentTabLabel(session)}</span>
                      {session.status === 'running' || session.id === runningSessionId ? <i className={runningDotClass} /> : null}
                      <span
                        className={tabCloseClass}
                        role="button"
                        tabIndex={0}
                        data-testid="close-session-tab-button"
                        aria-label={`Close ${session.title} tab`}
                        onClick={event => void hideSessionTab(event, session)}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') void hideSessionTab(event, session);
                        }}
                      >
                        <X size={12} />
                      </span>
                    </button>
                  ))}
                  {visibleSessions.length === 0 ? (
                    <div className={emptyTabsHintClass} data-testid="empty-session-tabs">No sessions in this focus</div>
                  ) : null}
                  <span className={tabDividerClass} />
                  <button className={newTabClass} type="button" data-testid="create-session-button" disabled={busy || !canUseAppServices || !selectedFocus} onClick={() => openCreation('session')} title="New session">
                    <Plus size={14} />
                  </button>
                </div>

                <div className={topControlsClass} data-testid="terminal-controls">
                  <button
                    type="button"
                    className={autoApproveChipClass({ warn: effectiveDangerousMode })}
                    data-testid="auto-approve-chip"
                    aria-pressed={effectiveDangerousMode}
                    disabled={!selectedSession || busy}
                    title={
                      selectedTerminalBinding
                        ? `Click to restart this session with auto-approve ${effectiveDangerousMode ? 'off' : 'on'}.`
                        : `Click to set auto-approve ${effectiveDangerousMode ? 'off' : 'on'} for the next launch.`
                    }
                    onClick={() => void toggleSelectedSessionYolo()}
                  >
                    <ShieldWarning size={14} />
                    {effectiveDangerousMode ? 'Auto-approve · on' : 'Auto-approve · off'}
                  </button>
                </div>
              </div>
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
              <div className={terminalBodyClass} data-testid="terminal-body" data-session-id={selectedSession.id} data-terminal-id={selectedTerminalBinding?.terminalId ?? ''}>
                <div className={terminalMetaStripClass} data-testid="terminal-meta-strip" data-session-id={selectedSession.id} data-terminal-id={selectedTerminalBinding?.terminalId ?? ''}>
                  <span className={metaStripBreadcrumbClass}>{sessionBreadcrumb(selectedSession, shell)} · {selectedSession.title}</span>
                  <span data-testid="terminal-status-label" className={metaStripStatusClass}>{runningLabel}</span>
                  <span className={metaStripCwdClass} title={selectedSession.cwd}>{shortenCwd(selectedSession.cwd)}</span>
                  {!terminalLiveFollow ? (
                    <button type="button" className={followLiveButtonClass} data-testid="follow-live-button" onClick={terminal.followLiveTerminalOutput}>Jump to latest</button>
                  ) : null}
                  <span data-testid="scrollback-row-count" hidden>{scrollbackRowCount.toLocaleString()} / {scrollbackContract.maxRenderedHistoryRows.toLocaleString()}</span>
                  <span data-testid="follow-live-state" hidden>{terminalLiveFollow ? 'live' : 'history'}</span>
                </div>
                {selectedPermissionRequest ? (
                  <div
                    className={permissionBannerClass}
                    data-testid="session-permission-banner"
                    role="status"
                  >
                    <ShieldWarning size={14} weight="fill" />
                    <div className={permissionBannerBodyClass}>
                      <strong>{agentLabel(selectedSession?.agentKind ?? '')} wants to {selectedPermissionRequest.toolName}</strong>
                      <span data-testid="session-permission-banner-summary">{selectedPermissionRequest.displaySummary}</span>
                    </div>
                    <span className={permissionBannerHintClass}>Respond in the terminal</span>
                  </div>
                ) : null}
                <div ref={terminal.surfaceViewportRef} className={surfaceViewportClass} data-testid="terminal-viewport" onScroll={terminal.handleTerminalScroll} onWheel={terminal.handleTerminalWheel} onMouseDown={terminal.focusTerminalCanvas}>
                  <div ref={terminal.terminalScrollSpacerRef} className={terminalScrollSpacerClass} data-testid="terminal-scroll-spacer">
                    <canvas
                      ref={terminal.canvasRef}
                      className="terminal-canvas"
                      data-testid="terminal-canvas"
                      aria-label="Terminal runtime surface"
                      tabIndex={0}
                      onKeyDown={terminal.handleTerminalKeyDown}
                      onPaste={terminal.handleTerminalPaste}
                      onMouseDown={terminal.focusTerminalCanvas}
                    />
                  </div>
                  {!selectedTerminalBinding ? (
                    <SessionLaunchOverlay
                      session={selectedSession}
                      launching={isLaunchingSelectedSession}
                      disabled={busy && !isLaunchingSelectedSession}
                      onLaunch={() => {
                        void terminal.launchSession(selectedSession).catch(error => {
                          writeLog(`Launch failed: ${errorMessage(error)}`);
                        });
                      }}
                    />
                  ) : null}
                </div>
              </div>
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

const topBandClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '16px',
  padding: '4px 4px 12px',
  flexShrink: 0,
});

const tabsClass = css({
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0',
  overflowX: 'auto',
  padding: '4px',
  borderRadius: '12px',
  border: '1px solid var(--line)',
  background: 'var(--surface-1)',
  boxShadow: 'var(--shadow)',
});

function tabClass({ active }: { active: boolean }) {
  return css({
    height: '28px',
    minWidth: 'auto',
    maxWidth: '174px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '7px',
    padding: '0 11px',
    borderRadius: '8px',
    color: active ? 'var(--text)' : 'var(--text-2)',
    background: active ? 'var(--surface-3)' : 'transparent',
    border: '0',
    boxShadow: active ? 'inset 0 1px 0 rgba(255,255,255,0.035)' : 'none',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    fontSize: '12px',
    fontWeight: 500,
    transition: 'background 0.15s ease, color 0.15s ease',
    _hover: { color: 'var(--text)' },
    '& > span:nth-child(2)': { overflow: 'hidden', textOverflow: 'ellipsis' },
  });
}

const runningDotClass = css({
  width: '5px',
  height: '5px',
  borderRadius: '50%',
  background: 'var(--good)',
  boxShadow: '0 0 0 3px rgba(111,184,122,0.14)',
  marginLeft: '2px',
});

const tabCloseClass = css({
  opacity: 0.45,
  flexShrink: 0,
  width: '14px',
  height: '14px',
  padding: '1px',
  borderRadius: '3px',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  _hover: { opacity: 1, background: 'var(--surface-hi)' },
});

const emptyTabsHintClass = css({
  color: 'var(--text-3)',
  padding: '0 8px',
  fontSize: '12px',
});

const tabDividerClass = css({
  width: '1px',
  height: '18px',
  background: 'var(--line)',
  margin: '0 2px',
  flexShrink: 0,
});

const newTabClass = css({
  width: '26px',
  height: '26px',
  display: 'grid',
  placeItems: 'center',
  borderRadius: '8px',
  border: '0',
  color: 'var(--text-3)',
  background: 'transparent',
  cursor: 'pointer',
  _hover: { background: 'var(--surface-3)', color: 'var(--text)' },
  _disabled: { opacity: 0.45, cursor: 'not-allowed' },
});

const topControlsClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '10px',
  flexShrink: 0,
});

function autoApproveChipClass({ warn }: { warn: boolean }) {
  return css({
    height: '28px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '0 10px 0 8px',
    borderRadius: '999px',
    border: `1px solid ${warn ? 'color-mix(in srgb, var(--warn) 38%, transparent)' : 'var(--line)'}`,
    color: warn ? 'var(--warn)' : 'var(--text-2)',
    background: 'var(--surface-1)',
    boxShadow: 'var(--shadow)',
    fontSize: '11.5px',
    fontWeight: 500,
    whiteSpace: 'nowrap',
  });
}

const launchButtonClass = css({
  height: '28px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '7px',
  padding: '0 10px',
  borderRadius: '999px',
  border: '1px solid var(--line)',
  color: 'var(--text)',
  background: 'var(--surface-1)',
  boxShadow: 'var(--shadow)',
  cursor: 'pointer',
  fontSize: '11.5px',
  fontWeight: 500,
  _disabled: { opacity: 0.45, cursor: 'not-allowed' },
});

const terminateButtonClass = css({
  height: '28px',
  padding: '0 10px',
  borderRadius: '999px',
  border: '1px solid var(--line)',
  color: 'var(--text-2)',
  background: 'var(--surface-1)',
  boxShadow: 'var(--shadow)',
  cursor: 'pointer',
  fontSize: '11.5px',
  fontWeight: 500,
  _disabled: { opacity: 0.4, cursor: 'not-allowed' },
});

const terminalBodyClass = css({
  position: 'relative',
  flex: 1,
  minHeight: 0,
  display: 'grid',
  // meta strip | optional permission banner | viewport
  gridTemplateRows: 'auto auto minmax(0, 1fr)',
  overflow: 'hidden',
  borderRadius: '0 0 22px 22px',
  background: 'transparent',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.025)',
});

const permissionBannerClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '8px 14px',
  background: 'color-mix(in srgb, var(--warn) 12%, transparent)',
  borderBottom: '1px solid color-mix(in srgb, var(--warn) 28%, transparent)',
  color: 'var(--text)',
  fontSize: '12px',
  '& > svg': { color: 'var(--warn)', flexShrink: 0 },
});

const permissionBannerBodyClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  minWidth: 0,
  flex: 1,
  '& strong': { fontWeight: 500, color: 'var(--text)' },
  '& span': {
    fontSize: '11.5px',
    color: 'var(--text-2)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

const permissionBannerHintClass = css({
  fontSize: '10.5px',
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--warn)',
  flexShrink: 0,
});

const terminalMetaStripClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '8px 14px',
  borderBottom: '1px solid color-mix(in srgb, var(--line) 60%, transparent)',
  color: 'var(--text-3)',
  fontSize: '11.5px',
  whiteSpace: 'nowrap',
  overflowX: 'auto',
  '& [hidden]': { display: 'none' },
});

const metaStripBreadcrumbClass = css({
  color: 'var(--text-2)',
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  minWidth: 0,
  flex: '0 1 auto',
});

const metaStripStatusClass = css({
  color: 'var(--text-3)',
  fontSize: '10.5px',
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  flexShrink: 0,
});

const metaStripCwdClass = css({
  color: 'var(--text-3)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: '10.5px',
  marginLeft: 'auto',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

const followLiveButtonClass = css({
  color: 'var(--text-2)',
  border: '1px solid var(--line)',
  background: 'transparent',
  borderRadius: '999px',
  padding: '3px 9px',
  cursor: 'pointer',
  fontSize: '10.5px',
  fontWeight: 500,
  flexShrink: 0,
  transition: 'color 140ms ease, border-color 140ms ease',
  _hover: { color: 'var(--text)', borderColor: 'var(--line-strong)' },
});

const surfaceViewportClass = css({
  position: 'relative',
  minHeight: 0,
  height: '100%',
  overflow: 'auto',
  background: 'transparent',
});

const terminalScrollSpacerClass = css({
  position: 'relative',
  minHeight: '100%',
  overflow: 'hidden',
});





