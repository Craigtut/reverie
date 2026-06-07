import { useRef, type MouseEvent } from 'react';
import { Folder, FolderOpen, GearSix, House, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import { css, cx } from '../../styled-system/css';
import { rimLitPanelClass } from '../../themes/surfaces';
import {
  activeGeneralSessions,
  activeSessionsInFocus,
  activeWorkspaceSessions,
  activityForSession,
  cellStateFor,
  primaryGeneralFocus,
  rollupSessionStates,
} from '../../domain';
import type {
  ActivityState,
  CreationMode,
  SessionTerminalBinding,
  ShellFocus,
  ShellProject,
  ShellSession,
  SurfaceMode,
  WorkspaceShellSnapshot,
} from '../../domain';
import { useNavigationStore } from '../../store';
import { useSidebarFolderDrop, SIDEBAR_PROJECT_DROP_ZONE } from '../../hooks';
import { ReverieMark, TrafficLights } from '../chrome';
import { Typography } from '../primitives/Typography';
import { OverlayScrollbar } from '../primitives/OverlayScrollbar';
import { ProjectGroup } from './ProjectGroup';
import { SidebarDropOverlay } from './SidebarDropOverlay';
import { FocusRow } from './FocusRow';
import { SessionRow } from './SessionRow';
import { rowAddClass, rowAttentionBadgeClass, rowReadyBadgeClass } from './navStyles';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { NavDndProvider } from './NavDndProvider';
import { SortableRow } from './SortableRow';
import { SessionDropZone } from './SessionDropZone';
import {
  PROJECTS_CONTAINER,
  projectSortId,
  sessionSortId,
  sessionsContainer,
  topicSortId,
  topicsContainer,
} from './navDnd';

export interface SidebarProps {
  shell: WorkspaceShellSnapshot;
  surfaceMode: SurfaceMode;
  selectedFocusId: string | null;
  sessionTerminalBindings: Record<string, SessionTerminalBinding>;
  cortexActivity: Record<string, ActivityState>;
  busy: boolean;
  canUseAppServices: boolean;
  onOpenCommandPalette: () => void;
  onGoToDashboard: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenFocus: (projectId: string | null, focusId: string) => void;
  onOpenSession: (session: ShellSession) => void;
  onCloseSession: (session: ShellSession) => void;
  onCreateSession: (projectId: string | null, focusId: string) => void;
  onArchiveFocus: (focus: ShellFocus) => void;
  onArchiveProject: (project: ShellProject) => void;
  onOpenCreation: (mode: NonNullable<CreationMode>, projectId?: string | null) => void;
  onOpenSettings: () => void;
  // A folder (or several) dropped onto the rail: each becomes a new project.
  onAddProjectsFromFolders: (paths: string[]) => void;
}

// The left navigation rail: workspace search, the Home row, the General group
// (sessions nested directly), the per-project focus accordions (each focus
// expands to its sessions), and the settings footer. Accordion open/close state
// lives in the navigation store; the shell owns the data and mutations.
export function Sidebar({
  shell,
  surfaceMode,
  selectedFocusId,
  sessionTerminalBindings,
  cortexActivity,
  busy,
  canUseAppServices,
  onOpenCommandPalette,
  onGoToDashboard,
  onOpenProject,
  onOpenFocus,
  onOpenSession,
  onCloseSession,
  onCreateSession,
  onArchiveFocus,
  onArchiveProject,
  onOpenCreation,
  onOpenSettings,
  onAddProjectsFromFolders,
}: SidebarProps) {
  // The whole rail is a folder drop zone (marked on the <aside> below). A folder
  // dropped anywhere on it adds a project; the visual is confined to the panel.
  const folderDrop = useSidebarFolderDrop({ onDropFolders: onAddProjectsFromFolders });
  // The nav list scroller, reflected by the auto-hiding OverlayScrollbar beside it.
  const navScrollRef = useRef<HTMLElement | null>(null);
  const selectedSessionId = useNavigationStore(s => s.selectedSessionId);
  const selectedProjectId = useNavigationStore(s => s.selectedProjectId);
  const collapsedProjectIds = useNavigationStore(s => s.collapsedProjectIds);
  const expandedFocusIds = useNavigationStore(s => s.expandedFocusIds);
  const generalCollapsed = useNavigationStore(s => s.generalCollapsed);
  const toggleProjectCollapsed = useNavigationStore(s => s.toggleProjectCollapsed);
  const toggleFocusExpanded = useNavigationStore(s => s.toggleFocusExpanded);
  const toggleGeneralCollapsed = useNavigationStore(s => s.toggleGeneralCollapsed);
  // The session whose terminal is on screen: never badged "finished" (you are
  // looking at it). Only the terminal surface counts as viewing; on other
  // surfaces nothing is being viewed, so a finished result still shows.
  const viewedSessionId = surfaceMode === 'terminal' ? selectedSessionId : null;

  // One topic's (or General's) sessions, each a sortable row, wrapped in the
  // topic's drop zone, with the "New session" button inside so an empty topic
  // still has real drop height. `projectId` is null for General.
  function renderSessionList(focusId: string, projectId: string | null, sessions: ShellSession[]) {
    const sorted = sessions.slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    return (
      <SessionDropZone focusId={focusId} sessionIds={sorted.map(session => session.id)}>
        {sorted.map(session => {
          const isBound = Boolean(sessionTerminalBindings[session.id]);
          const activity = activityForSession(session, cortexActivity);
          const cellState = cellStateFor(
            session,
            isBound,
            activity,
            session.id === viewedSessionId,
          );
          return (
            <SortableRow
              key={session.id}
              id={sessionSortId(session.id)}
              data={{
                kind: 'session',
                entityId: session.id,
                containerId: sessionsContainer(focusId),
              }}
            >
              <SessionRow
                session={session}
                active={surfaceMode === 'terminal' && selectedSessionId === session.id}
                cellState={cellState}
                onOpen={() => onOpenSession(session)}
                onClose={(event: MouseEvent<HTMLElement>) => {
                  event.stopPropagation();
                  onCloseSession(session);
                }}
              />
            </SortableRow>
          );
        })}
        <button
          className={rowAddClass}
          type="button"
          data-testid={
            projectId === null ? 'create-general-session-button' : 'create-focus-session-button'
          }
          disabled={busy || !canUseAppServices}
          onClick={() => onCreateSession(projectId, focusId)}
        >
          <Plus size={projectId === null ? 13 : 12} />
          <Typography as="span" variant="smallBody" tone="inherit">
            New session
          </Typography>
        </button>
      </SessionDropZone>
    );
  }

  const generalFocus = primaryGeneralFocus(shell);
  const generalSessions = activeGeneralSessions(shell);
  const generalRollup = rollupSessionStates(
    generalSessions,
    sessionTerminalBindings,
    cortexActivity,
    viewedSessionId,
  );
  // The Home row surfaces only the demanding states across the whole workspace:
  // how many sessions need you (a blocking ask or a hard failure) and how many
  // finished off-screen and are waiting to be seen. Working and idle are calm by
  // design and intentionally absent, so the badge reads as "look here" rather
  // than a running-process tally. When nothing needs you and nothing is ready,
  // the row carries no badge at all.
  const workspaceRollup = rollupSessionStates(
    activeWorkspaceSessions(shell),
    sessionTerminalBindings,
    cortexActivity,
    viewedSessionId,
  );
  const sortedProjects = shell.projects
    .filter(project => !project.archived)
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  return (
    <aside
      className={cx(rimLitPanelClass, leftPanelClass)}
      aria-label="Reverie navigation"
      data-testid="left-panel"
      data-drop-zone={SIDEBAR_PROJECT_DROP_ZONE}
      data-drop-id="sidebar"
    >
      <div className={titlebarClass} data-tauri-drag-region>
        <TrafficLights />
        <ReverieMark />
      </div>

      <button
        type="button"
        className={searchClass}
        data-testid="focus-search"
        aria-label="Open command palette"
        onClick={onOpenCommandPalette}
      >
        <MagnifyingGlass size={14} />
        <Typography as="span" variant="smallBody" tone="faint" className={searchPlaceholderClass}>
          Search topics, sessions…
        </Typography>
        <Typography as="span" variant="tiny" tone="faint" className={searchShortcutClass}>
          ⌘K
        </Typography>
      </button>

      <div className={navViewportClass}>
        <nav className={navClass} data-testid="workspace-nav" ref={navScrollRef}>
          <NavDndProvider shell={shell}>
            <button
              type="button"
              className={homeRowClass({ active: surfaceMode === 'dashboard' })}
              data-testid="home-nav-button"
              data-active={surfaceMode === 'dashboard' ? 'true' : 'false'}
              onClick={onGoToDashboard}
            >
              <House size={15} weight={surfaceMode === 'dashboard' ? 'fill' : 'regular'} />
              <Typography
                as="span"
                variant="smallBody"
                tone="inherit"
                className={homeRowLabelClass}
              >
                Home
              </Typography>
              {workspaceRollup.attention > 0 || workspaceRollup.finished > 0 ? (
                <span className={homeRowMetaClass}>
                  {workspaceRollup.attention > 0 ? (
                    <Typography
                      as="span"
                      variant="caption"
                      tone="warn"
                      className={rowAttentionBadgeClass}
                      data-testid="home-nav-attention-count"
                      title={`${workspaceRollup.attention} need${
                        workspaceRollup.attention === 1 ? 's' : ''
                      } you`}
                    >
                      {workspaceRollup.attention}
                    </Typography>
                  ) : null}
                  {workspaceRollup.finished > 0 ? (
                    <Typography
                      as="span"
                      variant="caption"
                      tone="muted"
                      className={rowReadyBadgeClass}
                      data-testid="home-nav-ready-count"
                      title={`${workspaceRollup.finished} ready for you`}
                    >
                      {workspaceRollup.finished}
                    </Typography>
                  ) : null}
                </span>
              ) : null}
            </button>

            <ProjectGroup
              title={shell.workspace.generalLabel}
              count={generalRollup.total}
              attention={generalRollup.attention}
              finished={generalRollup.finished}
              expanded={!generalCollapsed}
              onToggle={toggleGeneralCollapsed}
              testId="general-group-toggle"
            >
              {generalFocus ? renderSessionList(generalFocus.id, null, generalSessions) : null}
            </ProjectGroup>

            <div className={sectionLabelClass}>
              <Typography
                as="span"
                variant="tiny"
                tone="faint"
                uppercase
                style={{ letterSpacing: '0.08em' }}
              >
                Projects
              </Typography>
              <button
                type="button"
                title="Add project"
                data-testid="add-project-button"
                disabled={busy || !canUseAppServices}
                onClick={() => onOpenCreation('project')}
              >
                <Plus size={13} />
              </button>
            </div>

            <SortableContext
              items={sortedProjects.map(project => projectSortId(project.id))}
              strategy={verticalListSortingStrategy}
            >
              {sortedProjects.map(project => {
                const projectFocuses = shell.focuses
                  .filter(focus => !focus.archived && focus.projectId === project.id)
                  .sort((a, b) => a.sortOrder - b.sortOrder);
                const projectFocusIds = new Set(projectFocuses.map(focus => focus.id));
                const projectSessions = shell.sessions.filter(
                  session => projectFocusIds.has(session.focusId) && !session.archived,
                );
                const projectRollup = rollupSessionStates(
                  projectSessions,
                  sessionTerminalBindings,
                  cortexActivity,
                  viewedSessionId,
                );
                const expanded = !collapsedProjectIds.has(project.id);
                return (
                  <SortableRow
                    key={project.id}
                    id={projectSortId(project.id)}
                    data={{
                      kind: 'project',
                      entityId: project.id,
                      containerId: PROJECTS_CONTAINER,
                    }}
                  >
                    <ProjectGroup
                      icon={expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
                      title={project.name}
                      count={projectRollup.total}
                      attention={projectRollup.attention}
                      finished={projectRollup.finished}
                      tone={projectRollup.tone}
                      expanded={expanded}
                      active={
                        surfaceMode === 'project-dashboard' && selectedProjectId === project.id
                      }
                      onToggle={() => toggleProjectCollapsed(project.id)}
                      onOpen={() => onOpenProject(project.id)}
                      onRemove={(event: MouseEvent<HTMLElement>) => {
                        event.stopPropagation();
                        onArchiveProject(project);
                      }}
                      removeTitle={`Remove project ${project.name}`}
                    >
                      <SortableContext
                        items={projectFocuses.map(focus => topicSortId(focus.id))}
                        strategy={verticalListSortingStrategy}
                      >
                        {projectFocuses.map(focus => {
                          const focusSessions = activeSessionsInFocus(shell, focus.id);
                          const focusRollup = rollupSessionStates(
                            focusSessions,
                            sessionTerminalBindings,
                            cortexActivity,
                            viewedSessionId,
                          );
                          return (
                            <SortableRow
                              key={focus.id}
                              id={topicSortId(focus.id)}
                              data={{
                                kind: 'topic',
                                entityId: focus.id,
                                containerId: topicsContainer(project.id),
                              }}
                            >
                              <FocusRow
                                focus={focus}
                                rollup={focusRollup}
                                active={
                                  focus.id === selectedFocusId &&
                                  surfaceMode !== 'dashboard' &&
                                  surfaceMode !== 'project-dashboard'
                                }
                                expanded={expandedFocusIds.has(focus.id)}
                                onToggle={() => toggleFocusExpanded(focus.id)}
                                onOpen={() => onOpenFocus(project.id, focus.id)}
                                onRemoveFocus={(event: MouseEvent<HTMLElement>) => {
                                  event.stopPropagation();
                                  onArchiveFocus(focus);
                                }}
                              >
                                {renderSessionList(focus.id, project.id, focusSessions)}
                              </FocusRow>
                            </SortableRow>
                          );
                        })}
                      </SortableContext>
                      <button
                        className={rowAddClass}
                        type="button"
                        data-testid="create-project-focus-button"
                        disabled={busy || !canUseAppServices}
                        onClick={() => onOpenCreation('focus', project.id)}
                      >
                        <Plus size={13} />
                        <Typography as="span" variant="smallBody" tone="inherit">
                          New topic
                        </Typography>
                      </button>
                    </ProjectGroup>
                  </SortableRow>
                );
              })}
            </SortableContext>
          </NavDndProvider>
        </nav>
        <OverlayScrollbar scrollRef={navScrollRef} />
      </div>

      <div className={leftFooterClass}>
        <button
          type="button"
          className={settingsNavRowClass({ active: surfaceMode === 'settings' })}
          data-testid="open-settings-button"
          data-active={surfaceMode === 'settings' ? 'true' : 'false'}
          onClick={onOpenSettings}
        >
          <GearSix size={15} weight={surfaceMode === 'settings' ? 'fill' : 'regular'} />
          <Typography as="span" variant="smallBody" tone="inherit">
            Settings
          </Typography>
        </button>
      </div>

      {/* The folder-drop field, confined to the rail (contain): it rises with a
          gravity-well under the cursor and splashes on release. pointer-events
          none, so the native drop still lands on the <aside> zone beneath it. */}
      <SidebarDropOverlay model={folderDrop} />
    </aside>
  );
}

// Layout-only; the rim-lit surface treatment is composed in via cx() at the
// call site (see themes/surfaces.ts rimLitPanelClass).
const leftPanelClass = css({
  // Above the frame glow (canvas stage is zIndex 2; the glow sits inside it), so
  // the side panel reads as the top layer and the glow never washes over it.
  zIndex: 3,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
});

const titlebarClass = css({
  position: 'relative',
  zIndex: 2,
  padding: '14px 16px 10px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
});

const searchClass = css({
  margin: '6px 14px 12px',
  padding: '8px 10px',
  background: 'var(--surface-2)',
  border: '1px solid var(--line)',
  borderRadius: '10px',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  color: 'var(--text-3)',
  position: 'relative',
  zIndex: 2,
  cursor: 'pointer',
  width: 'calc(100% - 28px)',
  textAlign: 'left',
  transition: 'border-color 120ms ease, color 120ms ease',
  _hover: { borderColor: 'var(--line-strong)', color: 'var(--text-2)' },
});

const searchPlaceholderClass = css({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const searchShortcutClass = css({
  padding: '1px 5px',
  border: '1px solid var(--line)',
  borderRadius: '4px',
  background: 'var(--surface-1)',
  flexShrink: 0,
});

// The scroll viewport: a flex row holding the nav list and the auto-hiding
// OverlayScrollbar's reserved gutter beside it. Owns the flex-grow and stacking
// the nav used to carry, so the bar pins to the panel viewport (it never scrolls
// away with the content).
const navViewportClass = css({
  flex: 1,
  minHeight: 0,
  display: 'flex',
  position: 'relative',
  zIndex: 2,
});

const navClass = css({
  flex: 1,
  minWidth: 0,
  overflowY: 'auto',
  padding: '4px 8px 12px',
  position: 'relative',
  // The native scrollbar is hidden; the OverlayScrollbar sibling reflects position
  // in its own gutter and auto-hides like the terminal's custom bar.
  scrollbarWidth: 'none',
  '&::-webkit-scrollbar': { width: 0, height: 0 },
});

function homeRowClass({ active }: { active: boolean }) {
  return css({
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    padding: '7px 10px',
    marginBottom: '8px',
    borderRadius: '8px',
    border: '1px solid',
    borderColor: active ? 'var(--line-strong)' : 'transparent',
    color: active ? 'var(--text)' : 'var(--text-2)',
    background: active ? 'var(--surface-3)' : 'transparent',
    cursor: 'pointer',
    userSelect: 'none',
    textAlign: 'left',
    transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
    _hover: { background: 'var(--surface-2)', color: 'var(--text)' },
    '& svg': { color: active ? 'var(--text)' : 'var(--text-3)', flexShrink: 0 },
  });
}

const homeRowLabelClass = css({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const homeRowMetaClass = css({
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  fontVariantNumeric: 'tabular-nums',
});

const sectionLabelClass = css({
  padding: '14px 6px 4px 10px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  '& button': {
    color: 'var(--text-3)',
    width: '24px',
    height: '24px',
    display: 'grid',
    placeItems: 'center',
    borderRadius: '7px',
    cursor: 'pointer',
    transition: 'background 130ms ease, color 130ms ease',
    _hover: { background: 'var(--surface-2)', color: 'var(--text)' },
    _disabled: { opacity: 0.4, cursor: 'default', _hover: { background: 'transparent' } },
  },
});

const leftFooterClass = css({
  borderTop: '1px solid var(--line-faint)',
  padding: '8px 10px 10px',
  position: 'relative',
  zIndex: 2,
});

function settingsNavRowClass({ active }: { active: boolean }) {
  return css({
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    padding: '9px 10px',
    borderRadius: '8px',
    border: '1px solid',
    borderColor: active ? 'var(--line-strong)' : 'transparent',
    color: active ? 'var(--text)' : 'var(--text-2)',
    background: active ? 'var(--surface-3)' : 'transparent',
    cursor: 'pointer',
    userSelect: 'none',
    textAlign: 'left',
    transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
    _hover: { background: 'var(--surface-2)', color: 'var(--text)' },
    '& svg': { color: active ? 'var(--text)' : 'var(--text-3)', flexShrink: 0 },
    '& span': {
      flex: 1,
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
  });
}
