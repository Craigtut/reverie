import { useEffect } from 'react';

import { errorMessage, primaryGeneralFocus } from '../../domain';
import { refreshStateFieldColors } from '../../stateField';
import type {
  CreationForm,
  ShellNavigation,
  TerminalSession,
  WorkspaceModel,
  WorkspaceMutations,
} from '../../hooks';
import {
  TERMINAL_DROP_ZONE,
  TERMINAL_TAB_DROP_ZONE,
  useSessionTabShortcuts,
  useSidebarResize,
  useTerminalFileDrop,
} from '../../hooks';
import {
  useActivityStore,
  useNavigationStore,
  usePaletteStore,
  useShellStore,
  useTerminalStore,
  useUiStore,
} from '../../store';
import { css } from '../../styled-system/css';
import { DEFAULT_TERMINAL_FONT_SIZE } from '../../terminal/terminalMetrics';
import { appShellClass } from '../../themes/appShell';
import { CrtBootSequence } from '../../crtLoading';
import { DotField } from '../chrome';
import { Sidebar } from '../nav';
import {
  ReentryHeader,
  SessionHistorySurface,
  SessionTabsBar,
  TerminalDropOverlay,
  TerminalSurface,
} from '../session';
import { CommandPalette } from '../palette';
import { EmptyState } from '../onboarding';
import { DashboardSurface, ProjectDashboardSurface, type SessionCardActions } from '../dashboard';
import { CreationComposer } from '../creation';
import { SettingsSurface } from '../settings';
import { ConnectionPanel, ConnectionRequestBanner } from '../connections';
import { ConfirmDialog, ToastStack } from '../overlays';
import { useConnectionPanelStore } from '../../store';
import { SidebarResizeHandle } from './SidebarResizeHandle';

const canUseAppServices = true;

export interface AppLayoutProps {
  model: WorkspaceModel;
  nav: ShellNavigation;
  creation: CreationForm;
  mutations: WorkspaceMutations;
  terminal: TerminalSession;
}

// The workspace layout: navigation rail, surface router (dashboard / settings /
// history / terminal stage), and command palette. It receives the read model
// and the command layers as five grouped objects and reads its own view-state
// (chrome, navigation cursor, palette, terminal-stream fields) from the stores.
// All it does is render; logic lives in the hooks WorkspaceShell composes.
export function AppLayout({ model, nav, creation, mutations, terminal }: AppLayoutProps) {
  const theme = useUiStore(s => s.theme);
  const setTheme = useUiStore(s => s.setTheme);
  const appFocused = useUiStore(s => s.appFocused);
  const busy = useUiStore(s => s.busy);
  const writeLog = useUiStore(s => s.appendLog);
  // While the boot power-on owns the screen, hide the (still-loading) surface
  // content so the transparent boot canvas shows the ambient field, not a flash
  // of the empty state / dashboard; the content fades in once the boot clears.
  const bootSequenceActive = useUiStore(s => s.bootSequenceActive);
  const surfaceMode = useNavigationStore(s => s.surfaceMode);
  const selectedFocusId = useNavigationStore(s => s.selectedFocusId);
  const creationMode = useNavigationStore(s => s.creationMode);
  const setCreationMode = useNavigationStore(s => s.setCreationMode);
  const setSurfaceMode = useNavigationStore(s => s.setSurfaceMode);
  const paletteOpen = usePaletteStore(s => s.paletteOpen);
  const setPaletteOpen = usePaletteStore(s => s.setPaletteOpen);
  const sessionTerminalBindings = useTerminalStore(s => s.sessionTerminalBindings);
  const terminalLiveFollow = useTerminalStore(s => s.terminalLiveFollow);
  const scrollbackRowCount = useTerminalStore(s => s.scrollbackRowCount);
  const cortexActivity = useActivityStore(s => s.cortexActivity);
  const sessionTimelines = useActivityStore(s => s.sessionTimelines);
  const agentCliDetections = useShellStore(s => s.agentCliDetections);

  // Re-resolve the state cells' colors from the themed shell whenever the theme
  // flips, so their dots track light/dark like the rest of the UI.
  useEffect(() => {
    refreshStateFieldColors();
  }, [theme]);

  const {
    shell,
    selectedProject,
    selectedFocus,
    visibleSessions,
    activeFocusSessions,
    archivedFocusSessions,
    selectedSession,
    selectedTerminalBinding,
    selectedTerminalContentReady,
    isLaunchingSelectedSession,
    selectedPermissionRequest,
    effectiveDangerousMode,
    dangerousToggleLocked,
    runningLabel,
    scrollbackContract,
  } = model;
  const { selectSessionTab, goToDashboard, openSessionFromDashboard, openProject, openFocus } = nav;
  const {
    newProjectName,
    newProjectPath,
    projectDropError,
    newFocusTitle,
    setNewFocusTitle,
    newFocusDangerousMode,
    setNewFocusDangerousMode,
    // Kept for the Settings default-agent picker; the composer no longer uses it.
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
  } = creation;
  const {
    setWorkspaceDefaultDangerousMode,
    setWorkspaceTheme,
    setWorkspaceKeepAwake,
    setCrtEnabled,
    setClaudeFullscreenEnabled,
    setDispatchSettings,
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
    toggleSessionFollowUp,
    archiveSession,
    restoreSessionTab,
    removeSessionRecord,
    archiveFocusRecord,
    restoreFocusRecord,
    deleteFocusRecord,
    archiveProjectRecord,
    locateProjectFolder,
    deleteProjectRecord,
  } = mutations;

  // Theme: flip the live uiStore value for an instant UI change, then persist it
  // to the workspace so it survives restarts (the model re-seeds uiStore from the
  // saved snapshot when it returns).
  const onSetTheme = (next: typeof theme) => {
    setTheme(next);
    void setWorkspaceTheme(next);
  };
  // Default agent: persist the workspace default and seed the live composer pick
  // so the next new session starts on the chosen CLI right away.
  const onSetDefaultAgentKind = (next: typeof newSessionAgentKind) => {
    void setWorkspaceDefaultAgentKind(next);
    setNewSessionAgentKind(next);
  };

  // The session card right-click actions, shared by every dashboard so a card's
  // context menu matches the left nav's. Same mutations the sidebar wires up:
  // rename (empty resets to the automatic name), reset-to-automatic, and the
  // reversible archive. Folder utilities live on the project menu, not the session.
  const dashboardSessionActions: SessionCardActions = {
    onRename: (session, title) => void renameSession(session, title),
    onUseAutomaticName: session => void resetSessionTitleToAuto(session),
    onToggleFollowUp: session => void toggleSessionFollowUp(session),
    onArchive: session => void archiveSession(session),
  };

  // Native file drag-drop: resolves the session under the cursor (terminal body
  // or a session tab) and inserts dropped paths into it. Drives the drop overlay.
  const dropModel = useTerminalFileDrop({
    insertTextIntoSession: terminal.insertTextIntoSession,
  });

  // Drag-to-resize for the left navigation panel. The hook seeds the shell's grid
  // var from the persisted width and persists the new width once the drag ends.
  const sidebarResize = useSidebarResize(setWorkspaceSidebarWidth);
  const tabDropTargetId =
    dropModel.target?.kind === TERMINAL_TAB_DROP_ZONE &&
    (dropModel.phase === 'over' || dropModel.phase === 'confirm')
      ? dropModel.target.id
      : null;

  // Keyboard tab switching (Cmd+1..9, Ctrl+Tab) across the focus's sessions, so a
  // crowded strip is fully navigable without the pointer. Only on the terminal
  // stage, and not while the composer or palette owns the keyboard.
  useSessionTabShortcuts({
    enabled: surfaceMode === 'terminal' && !creationMode && !paletteOpen,
    sessions: visibleSessions,
    selectedSessionId: selectedSession?.id ?? null,
    onSelect: selectSessionTab,
  });

  // Starting a session in General targets its (implicit) focus; if a workspace
  // somehow has no general focus, fall back to creating one.
  const startGeneralSession = () => {
    const general = primaryGeneralFocus(shell);
    if (general) createSessionInFocus(null, general.id);
    else openCreation('focus', null);
  };

  // True when an actual terminal screen is on stage (a selected session, not the
  // creation composer). Drives the calmer terminal backdrop: solid (no gradient)
  // background, no dot field, and the top-left glow over the terminal.
  const terminalView = surfaceMode === 'terminal' && Boolean(selectedSession) && !creationMode;

  // A project dashboard with no resolvable project (the project was archived
  // while it was open) reads as Home until navigation catches up, rather than
  // falling through the surface router to the empty terminal stage.
  const effectiveSurfaceMode =
    surfaceMode === 'project-dashboard' && !selectedProject ? 'dashboard' : surfaceMode;

  return (
    <main
      ref={sidebarResize.shellRef}
      className={appShellClass}
      data-theme={theme}
      data-terminal-view={terminalView ? 'true' : 'false'}
      data-app-focused={appFocused ? 'true' : 'false'}
      data-testid="reverie-app-shell"
      onWheel={event => {
        // Edge-to-edge scroll target: forward wheels that land in the gaps around
        // the terminal (beside the sidebar, the window padding, the tabs band) to
        // the terminal, so hovering anywhere over the stage scrolls it. The
        // viewport handles its own wheel; the sidebar keeps its scroll.
        if (surfaceMode !== 'terminal' || creationMode || paletteOpen) return;
        const target = event.target as HTMLElement | null;
        if (!target) return;
        if (target.closest('[data-testid="terminal-viewport"]')) return;
        if (target.closest('[data-testid="left-panel"]')) return;
        terminal.forwardWheel(event);
      }}
    >
      <div className={windowDragStripClass} data-tauri-drag-region aria-hidden="true" />
      {/* The ambient dot field is a backdrop for the dashboard/empty views; it is
          hidden while a terminal screen is on stage so the session reads calm.
          Kept on during the boot so the transparent power-on floats over it. */}
      {!terminalView || bootSequenceActive ? <DotField variant="ambient" /> : null}

      <Sidebar
        shell={shell}
        surfaceMode={surfaceMode}
        selectedFocusId={selectedFocusId}
        sessionTerminalBindings={sessionTerminalBindings}
        cortexActivity={cortexActivity}
        busy={busy}
        canUseAppServices={canUseAppServices}
        onOpenCommandPalette={() => setPaletteOpen(true)}
        onGoToDashboard={goToDashboard}
        onOpenProject={openProject}
        onOpenFocus={openFocus}
        onOpenSession={openSessionFromDashboard}
        onCloseSession={session => void archiveSession(session)}
        onCreateSession={createSessionInFocus}
        onArchiveFocus={focus => void archiveFocusRecord(focus)}
        onArchiveProject={project => void archiveProjectRecord(project)}
        onOpenCreation={openCreation}
        onOpenSettings={() => setSurfaceMode('settings')}
        onAddProjectsFromFolders={paths => void addProjectsFromDroppedFolders(paths)}
        onRenameSession={(session, title) => void renameSession(session, title)}
        onUseAutomaticSessionTitle={session => void resetSessionTitleToAuto(session)}
        onToggleSessionFollowUp={session => void toggleSessionFollowUp(session)}
        onRenameFocus={(focus, title) => void renameFocus(focus, title)}
        onRenameProject={(project, name) => void renameProject(project, name)}
        onRevealPath={path => void revealPath(path)}
        onCopyPath={path => void copyPath(path)}
        onLocateProjectFolder={project => void locateProjectFolder(project)}
      />

      <SidebarResizeHandle
        width={sidebarResize.width}
        resizing={sidebarResize.resizing}
        onBeginResize={sidebarResize.beginResize}
        onNudge={sidebarResize.nudge}
      />

      <ConnectionPanelHost />
      <section
        className={canvasStageClass}
        style={terminalView ? STAGE_BLEED_STYLE : undefined}
        aria-label="Focus view"
        data-testid="focus-stage"
      >
        <CrtBootSequence />
        <ConnectionRequestBanner />
        <div className={stageContentClass} style={{ opacity: bootSequenceActive ? 0 : 1 }}>
          {effectiveSurfaceMode === 'dashboard' ? (
            <DashboardSurface
              shell={shell}
              sessionTerminalBindings={sessionTerminalBindings}
              cortexActivity={cortexActivity}
              sessionTimelines={sessionTimelines}
              sessionActions={dashboardSessionActions}
              onOpenSession={openSessionFromDashboard}
              onCreateProject={() => openCreation('project')}
              onCreateGeneralSession={startGeneralSession}
              onOpenSettings={() => setSurfaceMode('settings')}
              onSetWorkspaceDefaultDangerousMode={next =>
                void setWorkspaceDefaultDangerousMode(next)
              }
              keepAwakeEnabled={shell.workspace.keepAwakeEnabled ?? false}
              onSetKeepAwakeEnabled={next =>
                void setWorkspaceKeepAwake(next, shell.workspace.keepDisplayAwake ?? false)
              }
            />
          ) : effectiveSurfaceMode === 'project-dashboard' && selectedProject ? (
            <ProjectDashboardSurface
              shell={shell}
              project={selectedProject}
              sessionTerminalBindings={sessionTerminalBindings}
              cortexActivity={cortexActivity}
              sessionTimelines={sessionTimelines}
              sessionActions={dashboardSessionActions}
              onOpenSession={openSessionFromDashboard}
              onRestoreTopic={focus => void restoreFocusRecord(focus)}
              onDeleteTopic={focus => void deleteFocusRecord(focus)}
              onLocateFolder={project => void locateProjectFolder(project)}
            />
          ) : surfaceMode === 'settings' ? (
            <SettingsSurface
              theme={theme}
              onSetTheme={onSetTheme}
              defaultAgentKind={shell.workspace.defaultAgentKind}
              onSetDefaultAgentKind={onSetDefaultAgentKind}
              defaultDangerousMode={shell.workspace.defaultDangerousMode}
              onSetDefaultDangerousMode={next => {
                // Persist the single workspace auto-approve default and reflect it
                // in the live composer immediately so an open new-session form
                // picks it up at once.
                void setWorkspaceDefaultDangerousMode(next);
                setNewSessionDangerousMode(next);
              }}
              keepAwakeEnabled={shell.workspace.keepAwakeEnabled ?? false}
              keepDisplayAwake={shell.workspace.keepDisplayAwake ?? false}
              onSetKeepAwake={(enabled, keepDisplay) =>
                void setWorkspaceKeepAwake(enabled, keepDisplay)
              }
              terminalFontSize={shell.workspace.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE}
              onSetTerminalFontSize={next => void setWorkspaceTerminalFontSize(next)}
              crtEnabled={shell.workspace.crtEnabled ?? false}
              onSetCrtEnabled={next => void setCrtEnabled(next)}
              claudeFullscreenEnabled={shell.workspace.claudeFullscreenEnabled ?? false}
              onSetClaudeFullscreenEnabled={next => void setClaudeFullscreenEnabled(next)}
              dispatchShortcut={shell.workspace.dispatchShortcut ?? 'CommandOrControl+Shift+Space'}
              dispatchDefaultVoice={shell.workspace.dispatchDefaultVoice ?? true}
              dispatchWindowX={shell.workspace.dispatchWindowX ?? null}
              dispatchWindowY={shell.workspace.dispatchWindowY ?? null}
              onSetDispatchSettings={next => void setDispatchSettings(next)}
              onDeleteProject={project => void deleteProjectRecord(project)}
            />
          ) : surfaceMode === 'session-history' ? (
            <SessionHistorySurface
              focus={selectedFocus}
              shell={shell}
              activeSessions={activeFocusSessions}
              archivedSessions={archivedFocusSessions}
              sessionTerminalBindings={sessionTerminalBindings}
              cortexActivity={cortexActivity}
              sessionTimelines={sessionTimelines}
              sessionActions={dashboardSessionActions}
              onOpenSession={openSessionFromDashboard}
              onRestore={session =>
                restoreSessionTab(session).catch(error =>
                  writeLog(`Restore failed: ${errorMessage(error)}`),
                )
              }
              onDelete={session =>
                removeSessionRecord(session).catch(error =>
                  writeLog(`Delete failed: ${errorMessage(error)}`),
                )
              }
              onCreateSession={() =>
                selectedFocus
                  ? createSessionInFocus(selectedFocus.projectId ?? null, selectedFocus.id)
                  : openCreation('session')
              }
              busy={busy}
            />
          ) : (
            <div className={activeSurfaceClass} data-testid="terminal-stage">
              {!creationMode ? (
                <SessionTabsBar
                  visibleSessions={visibleSessions}
                  selectedSessionId={selectedSession?.id ?? null}
                  sessionTerminalBindings={sessionTerminalBindings}
                  cortexActivity={cortexActivity}
                  busy={busy}
                  canUseAppServices={canUseAppServices}
                  canCreateSession={Boolean(selectedFocus)}
                  hasSelectedSession={Boolean(selectedSession)}
                  hasTerminalBinding={Boolean(selectedTerminalBinding)}
                  effectiveDangerousMode={effectiveDangerousMode}
                  dangerousToggleLocked={dangerousToggleLocked}
                  dropTargetSessionId={tabDropTargetId}
                  onSelectSession={selectSessionTab}
                  onCloseSession={(event, session) => {
                    event.stopPropagation();
                    void archiveSession(session);
                  }}
                  onCreateSession={() => openCreation('session')}
                  onToggleDangerousMode={() => void toggleSelectedSessionYolo()}
                />
              ) : null}

              {selectedSession && !creationMode ? (
                <ReentryHeader session={selectedSession} cortexActivity={cortexActivity} />
              ) : null}

              {creationMode ? (
                <CreationComposer
                  mode={creationMode}
                  selectedProject={selectedProject}
                  selectedFocus={selectedFocus}
                  newProjectName={newProjectName}
                  newProjectPath={newProjectPath}
                  newFocusTitle={newFocusTitle}
                  setNewFocusTitle={setNewFocusTitle}
                  newFocusDangerousMode={newFocusDangerousMode}
                  setNewFocusDangerousMode={setNewFocusDangerousMode}
                  newSessionDangerousMode={newSessionDangerousMode}
                  setNewSessionDangerousMode={setNewSessionDangerousMode}
                  cliDetections={agentCliDetections}
                  busy={busy}
                  projectDropError={projectDropError}
                  onChooseProjectFolder={() => chooseProjectFolder().catch(() => {})}
                  onDropProjectFolder={selectDroppedProjectFolder}
                  onCreateProject={() => createProjectFromComposer().catch(() => {})}
                  onCreateTopicWithAgent={kind => createTopicAndStartSession(kind).catch(() => {})}
                  onCreateSessionWithAgent={kind => createSessionWithAgent(kind).catch(() => {})}
                  onCancel={() => setCreationMode(null)}
                />
              ) : null}

              {selectedSession && !creationMode ? (
                // The drop host marks the terminal body as a file-drop zone and
                // anchors the drop overlay over it. data-drop-id lets the drop
                // controller route a release into this session.
                <div
                  className={terminalDropHostClass}
                  data-drop-zone={TERMINAL_DROP_ZONE}
                  data-drop-id={selectedSession.id}
                >
                  <TerminalSurface
                    session={selectedSession}
                    terminalBinding={selectedTerminalBinding}
                    terminalContentReady={selectedTerminalContentReady}
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
                </div>
              ) : creationMode ? null : (
                <EmptyState
                  createProject={() => openCreation('project')}
                  createGeneralSession={startGeneralSession}
                  openSettings={() => setSurfaceMode('settings')}
                  workspaceDefaultDangerousMode={shell.workspace.defaultDangerousMode}
                  onSetWorkspaceDefaultDangerousMode={next =>
                    void setWorkspaceDefaultDangerousMode(next)
                  }
                  keepAwakeEnabled={shell.workspace.keepAwakeEnabled ?? false}
                  onSetKeepAwakeEnabled={next =>
                    void setWorkspaceKeepAwake(next, shell.workspace.keepDisplayAwake ?? false)
                  }
                />
              )}
            </div>
          )}
        </div>
        {/* Frame-level top-left glow. Mounted inside the canvas stage so it
            shares that stacking context (painting above the terminal but below
            the tabs, which are lifted); position:fixed anchors it to the whole
            window corner and keeps it from being clipped to the terminal panel. */}
        {terminalView ? <div className={terminalGlowClass} aria-hidden="true" /> : null}

        {/* The file-drop visualization. Mounted inside the canvas stage like the
            glow, so it sits at z-index 1: full-window (the dot field/dome span the
            whole app) yet rendered ABOVE the terminal and BELOW the lifted tabs
            and the sidebar. The carried-file chip portals out to ride on top. The
            drop target is still resolved by hit-testing the marked zones. */}
        {selectedSession ? (
          <TerminalDropOverlay model={dropModel} session={selectedSession} />
        ) : null}
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

      <ConfirmDialog />
      <ToastStack />
    </main>
  );
}

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
  height: '100%',
  overflow: 'hidden',
  position: 'relative',
});

// Wraps the surface router so it can fade in after the boot power-on (held at
// opacity 0 during the boot so the still-loading content never flashes through
// the transparent power-on). Fills the stage so the surfaces lay out unchanged.
const stageContentClass = css({
  position: 'absolute',
  inset: 0,
  transition: 'opacity 520ms ease',
});

// On the terminal stage, bleed past the shell padding so the terminal reaches the
// window's top, right, and bottom edges (the left keeps its gap from the floating
// sidebar); the window's rounded-corner mask + the shell's overflow:hidden clip
// it. Applied as an inline style (not a Panda selector) so it travels with the
// component and can never desync from a CSS regeneration during hot reload.
const STAGE_BLEED_STYLE = {
  marginTop: 'calc(-1 * var(--reverie-shell-pad))',
  marginRight: 'calc(-1 * var(--reverie-shell-pad))',
  height: 'calc(100% + 2 * var(--reverie-shell-pad))',
} as const;

const activeSurfaceClass = css({
  position: 'relative',
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  // Square corners: the terminal grid runs to the panel's bottom edge, so rounded
  // corners clipped the last row's ends. The window itself stays rounded.
  borderRadius: 0,
  background: 'transparent',
});

// Wraps the terminal surface so the file-drop overlay can layer over it and the
// body can be marked as a drop target. Fills the stage; the surface keeps its
// own flex sizing inside.
const terminalDropHostClass = css({
  position: 'relative',
  flex: 1,
  minHeight: 0,
  display: 'flex',
});

// A massive, soft glow anchored to the whole window's top-left corner. It lives
// in the canvas-stage stacking context (zIndex 2) at zIndex 4, which layers it
// ABOVE the terminal canvas (zIndex auto) AND the top/bottom edge fades (zIndex
// 3) so the light is cast over the gradients, yet BELOW the lifted tabs (zIndex
// 5) and the sidebar (zIndex 3, in the parent context) so the chrome stays crisp.
// position:fixed anchors it to the frame, not the terminal panel, so it is never
// clipped to the panel; the native window mask rounds the corner.
// pointer-events:none keeps the terminal fully interactive. Intentionally very
// subtle (tune via --glow); this replaces the old backdrop radial-gradient.
const terminalGlowClass = css({
  position: 'fixed',
  inset: 0,
  zIndex: 4,
  pointerEvents: 'none',
  // Span the whole window and give the falloff an EXPLICIT radius so the glow
  // fades to transparent on its own, well inside the viewport, instead of being
  // chopped by a box edge. The previous 58vw x 66vh box clipped the still-bright
  // part of the gradient on tall/portrait windows (the `transparent 70%` stop is
  // sized to the box's farthest corner, which lands outside the short axis),
  // leaving a hard line and flat black beyond it. A fixed-px circle is
  // aspect-ratio independent: same soft corner glow on any window shape. Tune the
  // radius for reach and --glow for intensity.
  background: 'radial-gradient(circle 900px at top left, var(--glow), transparent)',
});

function ConnectionPanelHost() {
  const activeSessionId = useConnectionPanelStore(s => s.activeSessionId);
  const closePanel = useConnectionPanelStore(s => s.closePanel);
  return <ConnectionPanel sessionId={activeSessionId} onClose={closePanel} />;
}
