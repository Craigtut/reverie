import { useEffect, useMemo } from 'react';

import { errorMessage } from './domain';
import {
  useAgentClis,
  useAppFocus,
  useCommandPalette,
  useCreationForm,
  useSessionActivity,
  useShellNavigation,
  useTerminalSession,
  useWorkspaceModel,
  useWorkspaceMutations,
} from './hooks';
import {
  useActivityStore,
  useNavigationStore,
  usePaletteStore,
  useShellStore,
  useTerminalStore,
  useUiStore,
} from './store';
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
import { maybeRunHarnessSmokeTest } from './harnessSmoke';

// The workspace shell: the running application. It composes the read model
// (useWorkspaceModel), the imperative terminal island (useTerminalSession), and
// the command layers (navigation, creation, mutations), then renders the
// layout. It holds no business logic itself: every handler comes from a hook,
// and every derived value from the model. App mounts this; nothing above it
// holds app logic.
export function WorkspaceShell() {
  // Store-backed values the layout reads directly (chrome, navigation cursor,
  // palette, and the terminal-stream fields the meta strip surfaces).
  const theme = useUiStore(s => s.theme);
  const appFocused = useUiStore(s => s.appFocused);
  const busy = useUiStore(s => s.busy);
  const setBusy = useUiStore(s => s.setBusy);
  const writeLog = useUiStore(s => s.appendLog);
  const surfaceMode = useNavigationStore(s => s.surfaceMode);
  const selectedProjectId = useNavigationStore(s => s.selectedProjectId);
  const setSelectedProjectId = useNavigationStore(s => s.setSelectedProjectId);
  const selectedFocusId = useNavigationStore(s => s.selectedFocusId);
  const creationMode = useNavigationStore(s => s.creationMode);
  const setCreationMode = useNavigationStore(s => s.setCreationMode);
  const setSurfaceMode = useNavigationStore(s => s.setSurfaceMode);
  const paletteOpen = usePaletteStore(s => s.paletteOpen);
  const setPaletteOpen = usePaletteStore(s => s.setPaletteOpen);
  const sessionTerminalBindings = useTerminalStore(s => s.sessionTerminalBindings);
  const runningSessionId = useTerminalStore(s => s.runningSessionId);
  const terminalLiveFollow = useTerminalStore(s => s.terminalLiveFollow);
  const scrollbackRowCount = useTerminalStore(s => s.scrollbackRowCount);
  const cortexActivity = useActivityStore(s => s.cortexActivity);
  const agentCliDetections = useShellStore(s => s.agentCliDetections);
  const isTauriRuntime = useMemo(() => Boolean(window.__TAURI_INTERNALS__ || (window.__TAURI__ && !window.__REVERIE_BROWSER_FIXTURE__)), []);

  // Composition: read model, then the imperative terminal island, then the
  // command layers that depend on both.
  const model = useWorkspaceModel();
  const terminal = useTerminalSession({
    selectedSession: model.selectedSession,
    writeLog,
    loadWorkspaceShell: model.loadWorkspaceShell,
    setBusy,
    isTauriRuntime,
  });
  const nav = useShellNavigation({ model, terminal });
  const creation = useCreationForm({ model, terminal });
  const mutations = useWorkspaceMutations({ model, terminal, selectSessionTab: nav.selectSessionTab });

  useCommandPalette();
  useSessionActivity(writeLog);
  useAgentClis(creation.newSessionAgentKind, creation.setNewSessionAgentKind, writeLog);
  useAppFocus();
  useEffect(() => {
    maybeRunHarnessSmokeTest();
  }, []);

  // Bind the model + command layers to the names the layout reads.
  const {
    shell,
    selectedProject,
    selectedFocus,
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
  } = model;
  const { selectSessionTab, goToDashboard, openSessionFromDashboard, openFocus, openSessionHistory } = nav;
  const {
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
    chooseProjectFolder,
    createProjectFromComposer,
    createFocusForSelection,
    createSessionForSelection,
  } = creation;
  const {
    setWorkspaceDefaultDangerousMode,
    toggleSelectedSessionYolo,
    hideSessionTab,
    restoreSessionTab,
    removeSessionRecord,
    archiveFocusRecord,
    archiveProjectRecord,
  } = mutations;

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
