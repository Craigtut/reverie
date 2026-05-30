import { useEffect, useState } from 'react';

import { invoke } from '../services/runtime';
import {
  USER_HOME,
  agentLabel,
  defaultCwdForFocus,
  errorMessage,
  folderNameFromPath,
} from '../domain';
import type {
  CreateFocusRequest,
  CreateProjectRequest,
  CreateSessionRecordRequest,
  CreationMode,
  ProjectFolderSelection,
  WorkspaceShellSnapshot,
} from '../domain';
import { useNavigationStore, useShellStore, useUiStore } from '../store';
import type { TerminalSession } from './useTerminalSession';
import type { WorkspaceModel } from './useWorkspaceModel';

const canUseAppServices = true;

interface CreationFormOptions {
  model: WorkspaceModel;
  terminal: TerminalSession;
}

// Owns the new-project / new-focus / new-session form state and the actions
// that open the composer and submit it. Submits optimistically reconcile the
// navigation selection and (for sessions) hand off to the terminal autostart.
// Reads the current selection from the model/stores at submit time, which is
// always a later interaction than the store write that set it.
export function useCreationForm({ model, terminal }: CreationFormOptions) {
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newFocusTitle, setNewFocusTitle] = useState('');
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [newSessionCwd, setNewSessionCwd] = useState(USER_HOME);
  const [newSessionAgentKind, setNewSessionAgentKind] = useState<
    CreateSessionRecordRequest['agentKind']
  >(model.shell.workspace.defaultAgentKind);
  const [newSessionDangerousMode, setNewSessionDangerousMode] = useState(
    model.shell.workspace.defaultNewSessionDangerous,
  );

  const setShell = useShellStore(s => s.setShell);
  const selectedProjectId = useNavigationStore(s => s.selectedProjectId);
  const setSelectedProjectId = useNavigationStore(s => s.setSelectedProjectId);
  const setSelectedFocusId = useNavigationStore(s => s.setSelectedFocusId);
  const setSelectedSessionId = useNavigationStore(s => s.setSelectedSessionId);
  const setCreationMode = useNavigationStore(s => s.setCreationMode);
  const setSurfaceMode = useNavigationStore(s => s.setSurfaceMode);
  const setBusy = useUiStore(s => s.setBusy);
  const appendLog = useUiStore(s => s.appendLog);

  const { shell, selectedProject, selectedFocus, selectedFocusDefaultCwd } = model;

  // Keep the new-session cwd defaulted to the selected focus's project folder
  // until the user edits it.
  useEffect(() => {
    setNewSessionCwd(selectedFocusDefaultCwd);
  }, [selectedFocusDefaultCwd]);

  // Re-seed the composer's YOLO toggle from the persisted workspace default
  // whenever that default changes (a Settings change or an app reload). The
  // composer checkbox stays a per-session tweak after this seed: toggling it
  // there does not persist, so it is only overwritten when the persisted
  // default itself moves.
  const persistedNewSessionDangerous = shell.workspace.defaultNewSessionDangerous;
  useEffect(() => {
    setNewSessionDangerousMode(persistedNewSessionDangerous);
  }, [persistedNewSessionDangerous]);

  // Re-seed the composer's agent picker from the persisted workspace default
  // whenever that default changes (a Settings change or an app reload). This is
  // only a starting value: useAgentClis may still narrow it to an available
  // CLI, and a per-session pick via setNewSessionAgentKind sticks until the
  // persisted default itself moves.
  const persistedDefaultAgentKind = shell.workspace.defaultAgentKind;
  useEffect(() => {
    setNewSessionAgentKind(persistedDefaultAgentKind);
  }, [persistedDefaultAgentKind]);

  function openCreation(mode: NonNullable<CreationMode>, projectId = selectedProjectId) {
    setCreationMode(mode);
    setSurfaceMode('terminal');
    if (mode === 'focus') {
      setSelectedProjectId(projectId);
    }
    if (mode === 'session') {
      setNewSessionCwd(defaultCwdForFocus(selectedFocus, shell));
    }
  }

  // Open the new-session composer pointed at a specific focus (the sidebar's
  // per-focus and General "New session" buttons, and the empty-state action).
  // Selects the focus first so the composer's submit targets it.
  function createSessionInFocus(projectId: string | null, focusId: string) {
    setSelectedProjectId(projectId);
    setSelectedFocusId(focusId);
    setSelectedSessionId(null);
    setCreationMode('session');
    setSurfaceMode('terminal');
    const focus = shell.focuses.find(item => item.id === focusId) ?? null;
    setNewSessionCwd(defaultCwdForFocus(focus, shell));
  }

  async function chooseProjectFolder() {
    if (!canUseAppServices) return;
    setBusy(true);
    try {
      const selection = await invoke<ProjectFolderSelection | null>('choose_project_folder');
      if (!selection) {
        appendLog('Project folder selection cancelled.');
        return;
      }
      setNewProjectPath(selection.path);
      setNewProjectName(selection.name || folderNameFromPath(selection.path) || 'New project');
      setNewSessionCwd(selection.path);
      appendLog(`Selected project folder: ${selection.path}.`);
    } catch (error) {
      appendLog(`Choose project folder failed: ${errorMessage(error)}`);
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
      setShell(snapshot);
      setSelectedProjectId(nextProjectId);
      setSelectedFocusId(null);
      setSelectedSessionId(null);
      setNewProjectName('');
      setNewProjectPath('');
      setCreationMode('focus');
      appendLog(`Created project: ${created?.name ?? request.name}.`);
    } catch (error) {
      appendLog(`Create project failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function createFocusForSelection() {
    if (!canUseAppServices) return;
    setBusy(true);
    try {
      const targetProjectId = selectedProjectId;
      const targetProject = selectedProject;
      const title =
        newFocusTitle.trim() || (targetProject ? `${targetProject.name} focus` : 'New focus');
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
      appendLog(`Created focus: ${created?.title ?? request.title}.`);
    } catch (error) {
      appendLog(`Create focus failed: ${errorMessage(error)}`);
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
      const defaultCwd = defaultCwdForFocus(selectedFocus, shell);
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
      appendLog(
        `Created session: ${created?.title ?? request.title}. Preparing terminal handoff for the selected CLI.`,
      );
      if (created) {
        terminal.autostartSession(created);
      }
    } catch (error) {
      appendLog(`Create session failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  return {
    newProjectName,
    setNewProjectName,
    newProjectPath,
    setNewProjectPath,
    newFocusTitle,
    setNewFocusTitle,
    newSessionTitle,
    setNewSessionTitle,
    newSessionCwd,
    setNewSessionCwd,
    newSessionAgentKind,
    setNewSessionAgentKind,
    newSessionDangerousMode,
    setNewSessionDangerousMode,
    openCreation,
    createSessionInFocus,
    chooseProjectFolder,
    createProjectFromComposer,
    createFocusForSelection,
    createSessionForSelection,
  };
}

export type CreationForm = ReturnType<typeof useCreationForm>;
