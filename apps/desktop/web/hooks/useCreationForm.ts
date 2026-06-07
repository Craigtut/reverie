import { useEffect, useState } from 'react';

import { invoke } from '../services/runtime';
import { agentLabel, defaultCwdForFocus, errorMessage, folderNameFromPath } from '../domain';
import type {
  AgentKind,
  CreateFocusRequest,
  CreateProjectRequest,
  CreateSessionRecordRequest,
  CreationMode,
  ProjectFolderSelection,
  ShellFocus,
  WorkspaceShellSnapshot,
} from '../domain';
import { useNavigationStore, useOverlayStore, useShellStore, useUiStore } from '../store';
import type { TerminalSession } from './useTerminalSession';
import type { WorkspaceModel } from './useWorkspaceModel';

const canUseAppServices = true;

interface CreationFormOptions {
  model: WorkspaceModel;
  terminal: TerminalSession;
}

// The dangerous (auto-approve) mode a brand-new session in `focus` inherits when
// it carries no override of its own: the topic default, else the workspace
// default.
function inheritedDangerousMode(focus: ShellFocus | null, shell: WorkspaceShellSnapshot): boolean {
  return focus?.defaultDangerousMode ?? shell.workspace.defaultDangerousMode;
}

// Owns the new-project / new-topic / new-session form state and the actions that
// open the composer and submit it. Creating a topic now starts its first session
// in the same step: the user picks an agent and we create the focus, create a
// session in it, and hand off to the terminal. Sessions are no longer named by
// hand; the title defaults to the chosen CLI and tracks the agent's own terminal
// title later.
export function useCreationForm({ model, terminal }: CreationFormOptions) {
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectPath, setNewProjectPath] = useState('');
  // Inline feedback when a dropped path can't be used as a project folder (e.g.
  // it no longer exists). Cleared when a valid folder lands or the composer
  // reopens.
  const [projectDropError, setProjectDropError] = useState<string | null>(null);
  const [newFocusTitle, setNewFocusTitle] = useState('');
  // Topic-wide auto-approve, seeded from the workspace default and persisted onto
  // the focus so every session in the topic inherits it.
  const [newFocusDangerousMode, setNewFocusDangerousMode] = useState(
    model.shell.workspace.defaultDangerousMode,
  );
  const [newSessionAgentKind, setNewSessionAgentKind] = useState<AgentKind>(
    model.shell.workspace.defaultAgentKind,
  );
  // The per-session auto-approve shown in the session composer's Options. Seeded
  // to the inherited default, so leaving it untouched inherits and changing it
  // sends an explicit override. (Re-seeded from the selected topic on every
  // composer open; this initial value covers the first render before then.)
  const [newSessionDangerousMode, setNewSessionDangerousMode] = useState(
    model.shell.workspace.defaultDangerousMode,
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

  const { shell, selectedProject, selectedFocus } = model;

  // Re-seed the topic auto-approve from the workspace default whenever it moves
  // (a Settings change or reload). The composer toggle stays a per-topic tweak
  // after this seed.
  const workspaceDefaultDangerous = shell.workspace.defaultDangerousMode;
  useEffect(() => {
    setNewFocusDangerousMode(workspaceDefaultDangerous);
  }, [workspaceDefaultDangerous]);

  function openCreation(mode: NonNullable<CreationMode>, projectId = selectedProjectId) {
    setCreationMode(mode);
    setSurfaceMode('terminal');
    if (mode === 'project') {
      setNewProjectName('');
      setNewProjectPath('');
      setProjectDropError(null);
    }
    if (mode === 'focus') {
      setSelectedProjectId(projectId);
      setNewFocusTitle('');
      setNewFocusDangerousMode(shell.workspace.defaultDangerousMode);
      setNewSessionAgentKind(shell.workspace.defaultAgentKind);
    }
    if (mode === 'session') {
      setNewSessionDangerousMode(inheritedDangerousMode(selectedFocus, shell));
      setNewSessionAgentKind(shell.workspace.defaultAgentKind);
    }
  }

  // Open the new-session composer pointed at a specific topic (the sidebar's
  // per-topic and General "New session" buttons, and the empty-state action).
  // Selects the topic first so the composer's submit targets it.
  function createSessionInFocus(projectId: string | null, focusId: string) {
    setSelectedProjectId(projectId);
    setSelectedFocusId(focusId);
    setSelectedSessionId(null);
    setCreationMode('session');
    setSurfaceMode('terminal');
    const focus = shell.focuses.find(item => item.id === focusId) ?? null;
    setNewSessionDangerousMode(inheritedDangerousMode(focus, shell));
    setNewSessionAgentKind(shell.workspace.defaultAgentKind);
  }

  // Record a chosen project folder (from the OS picker or a drag-drop) into the
  // composer. The user still confirms with "Add project"; the folder name
  // becomes the project name verbatim. Sessions opened in the project later
  // default their cwd to this folder via `defaultCwdForFocus`.
  function applyProjectFolder(selection: ProjectFolderSelection) {
    setProjectDropError(null);
    setNewProjectPath(selection.path);
    setNewProjectName(selection.name || folderNameFromPath(selection.path) || 'New project');
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
      applyProjectFolder(selection);
      appendLog(`Selected project folder: ${selection.path}.`);
    } catch (error) {
      appendLog(`Choose project folder failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  // Drag-drop entry point: a path dropped anywhere on the project composer is
  // resolved by the backend before it fills the selection. The backend verifies
  // the path exists and maps it to a real folder (a dropped folder is used as-is;
  // a dropped file resolves to its containing folder), so a project is always a
  // valid directory. A path that can't be resolved surfaces an inline error.
  async function selectDroppedProjectFolder(path: string) {
    if (!canUseAppServices) return;
    const trimmed = path.trim();
    if (!trimmed) return;
    try {
      const selection = await invoke<ProjectFolderSelection>('resolve_project_folder', {
        path: trimmed,
      });
      applyProjectFolder(selection);
      appendLog(`Selected project folder: ${selection.path}.`);
    } catch (error) {
      const message = errorMessage(error);
      setProjectDropError(message);
      appendLog(`Dropped path rejected: ${message}`);
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
      const before = new Set(shell.projects.map(project => project.id));
      const archivedBefore = new Set(
        shell.projects.filter(project => project.archived).map(project => project.id),
      );
      const snapshot = await invoke<WorkspaceShellSnapshot>('create_project', { request });
      // A folder Reverie already knew (archived) reconnects rather than creating a
      // new row: the same id is active again. Detect that so we land the user on
      // the restored project instead of forcing a first-topic creation.
      const reconnected =
        snapshot.projects.find(project => archivedBefore.has(project.id) && !project.archived) ??
        null;
      const created =
        reconnected ??
        snapshot.projects.find(project => !before.has(project.id)) ??
        snapshot.projects[snapshot.projects.length - 1];
      const nextProjectId = created?.id ?? selectedProjectId;
      setShell(snapshot);
      setSelectedProjectId(nextProjectId);
      setSelectedFocusId(null);
      setSelectedSessionId(null);
      setNewProjectName('');
      setNewProjectPath('');
      setNewFocusTitle('');
      setNewFocusDangerousMode(snapshot.workspace.defaultDangerousMode);
      setNewSessionAgentKind(snapshot.workspace.defaultAgentKind);
      if (reconnected) {
        const topicCount = snapshot.focuses.filter(
          focus => focus.projectId === reconnected.id && !focus.archived,
        ).length;
        setCreationMode(null);
        setSurfaceMode('project-dashboard');
        useOverlayStore.getState().pushToast({
          message:
            topicCount > 0
              ? `Reconnected “${reconnected.name}” with ${topicCount} ${topicCount === 1 ? 'topic' : 'topics'}`
              : `Reconnected “${reconnected.name}”`,
        });
        appendLog(`Reconnected archived project: ${reconnected.name}.`);
      } else {
        // A fresh project has no topics yet, so go straight to creating the first.
        setCreationMode('focus');
        appendLog(`Created project: ${created?.name ?? request.name}.`);
      }
    } catch (error) {
      appendLog(`Create project failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  // Create a session in `focus` with `agentKind` and open it. The title defaults
  // to the CLI name (no manual naming); auto-approve inherits the topic default
  // unless the Options toggle was changed to differ from it. Returns the updated
  // snapshot so chained callers can keep working from fresh state.
  async function startSessionInFocus(
    focus: ShellFocus,
    agentKind: AgentKind,
    shellSnapshot: WorkspaceShellSnapshot,
    dangerousModeOverride: boolean | null,
  ) {
    // No manual naming: default the title to the chosen CLI's display name. It
    // must be non-empty (the backend rejects blank titles) and the agent's live
    // terminal title overwrites it later.
    const title = agentLabel(agentKind);
    // The cwd is never user-chosen: a project session runs in its project
    // folder; a General session sends '' and the backend provisions (and
    // trusts) a fresh scratch workspace for it.
    const cwd = defaultCwdForFocus(focus, shellSnapshot);
    const request: CreateSessionRecordRequest = {
      focusId: focus.id,
      title,
      agentKind,
      cwd,
      dangerousModeOverride,
    };
    const before = new Set(shellSnapshot.sessions.map(session => session.id));
    const snapshot = await invoke<WorkspaceShellSnapshot>('create_session', { request });
    const created =
      snapshot.sessions.find(session => !before.has(session.id)) ??
      snapshot.sessions[snapshot.sessions.length - 1];
    setShell(snapshot);
    setSelectedSessionId(created?.id ?? null);
    setNewSessionAgentKind(agentKind);
    setCreationMode(null);
    setSurfaceMode('terminal');
    appendLog(`Created session: ${created?.title ?? title}. Preparing terminal handoff.`);
    if (created) terminal.autostartSession(created);
  }

  // Topic composer: create the focus (carrying its topic-wide auto-approve) and
  // immediately start its first session with the chosen agent. The first session
  // inherits the topic default, so it carries no per-session override.
  async function createTopicAndStartSession(agentKind: AgentKind) {
    if (!canUseAppServices) return;
    setBusy(true);
    try {
      const targetProject = selectedProject;
      const title =
        newFocusTitle.trim() || (targetProject ? `${targetProject.name} topic` : 'New topic');
      const request: CreateFocusRequest = {
        projectId: selectedProjectId,
        title,
        description: targetProject
          ? `Topic under ${targetProject.name}.`
          : 'Unprojected topic that can become project-backed later.',
        defaultDangerousMode: newFocusDangerousMode,
      };
      const before = new Set(shell.focuses.map(focus => focus.id));
      const snapshot = await invoke<WorkspaceShellSnapshot>('create_focus', { request });
      const created =
        snapshot.focuses.find(focus => !before.has(focus.id)) ??
        snapshot.focuses[snapshot.focuses.length - 1];
      if (!created) {
        appendLog('Create topic failed: no topic was returned.');
        return;
      }
      setShell(snapshot);
      setSelectedFocusId(created.id);
      setSelectedSessionId(null);
      setNewFocusTitle('');
      await startSessionInFocus(created, agentKind, snapshot, null);
    } catch (error) {
      appendLog(`Create topic failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  // Session composer (existing topic): create + open a session with the chosen
  // agent, sending an explicit override only when the Options toggle differs from
  // what the topic would otherwise inherit.
  async function createSessionWithAgent(agentKind: AgentKind) {
    if (!canUseAppServices || !selectedFocus) return;
    setBusy(true);
    try {
      const inherited = inheritedDangerousMode(selectedFocus, shell);
      const dangerousModeOverride =
        newSessionDangerousMode === inherited ? null : newSessionDangerousMode;
      await startSessionInFocus(selectedFocus, agentKind, shell, dangerousModeOverride);
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
    projectDropError,
    newFocusTitle,
    setNewFocusTitle,
    newFocusDangerousMode,
    setNewFocusDangerousMode,
    newSessionAgentKind,
    setNewSessionAgentKind,
    newSessionDangerousMode,
    setNewSessionDangerousMode,
    openCreation,
    createSessionInFocus,
    chooseProjectFolder,
    selectDroppedProjectFolder,
    createProjectFromComposer,
    createTopicAndStartSession,
    createSessionWithAgent,
  };
}

export type CreationForm = ReturnType<typeof useCreationForm>;
