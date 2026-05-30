import { CircleDashed, Folder, GearSix, House, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import { css, cx } from '../../styled-system/css';
import { rimLitPanelClass } from '../../themes/surfaces';
import { sessionsForProject } from '../../domain';
import type {
  CreationMode,
  ShellFocus,
  ShellProject,
  SurfaceMode,
  WorkspaceShellSnapshot,
} from '../../domain';
import { TrafficLights } from '../chrome';
import { Typography } from '../primitives/Typography';
import { ProjectGroup } from './ProjectGroup';
import { FocusRow } from './FocusRow';

export interface SidebarProps {
  shell: WorkspaceShellSnapshot;
  surfaceMode: SurfaceMode;
  selectedProjectId: string | null;
  selectedFocusId: string | null;
  liveSessionCount: number;
  busy: boolean;
  canUseAppServices: boolean;
  onOpenCommandPalette: () => void;
  onGoToDashboard: () => void;
  onSelectProject: (projectId: string | null) => void;
  onOpenFocus: (projectId: string | null, focusId: string) => void;
  onOpenSessionHistory: (projectId: string | null, focusId: string) => void;
  onArchiveFocus: (focus: ShellFocus) => void;
  onArchiveProject: (project: ShellProject) => void;
  onOpenCreation: (mode: NonNullable<CreationMode>, projectId?: string | null) => void;
  onOpenSettings: () => void;
}

// The left navigation rail: workspace search, the Home row, the General focus
// group, the per-project focus groups, and the settings footer. Purely
// presentational; the shell owns the data and the mutations and passes them in.
export function Sidebar({
  shell,
  surfaceMode,
  selectedProjectId,
  selectedFocusId,
  liveSessionCount,
  busy,
  canUseAppServices,
  onOpenCommandPalette,
  onGoToDashboard,
  onSelectProject,
  onOpenFocus,
  onOpenSessionHistory,
  onArchiveFocus,
  onArchiveProject,
  onOpenCreation,
  onOpenSettings,
}: SidebarProps) {
  return (
    <aside
      className={cx(rimLitPanelClass, leftPanelClass)}
      aria-label="Reverie navigation"
      data-testid="left-panel"
    >
      <div className={titlebarClass} data-tauri-drag-region>
        <TrafficLights />
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
          Search focuses, sessions…
        </Typography>
        <Typography as="span" variant="tiny" tone="faint" className={searchShortcutClass}>
          ⌘K
        </Typography>
      </button>

      <nav className={navClass} data-testid="workspace-nav">
        <button
          type="button"
          className={homeRowClass({ active: surfaceMode === 'dashboard' })}
          data-testid="home-nav-button"
          data-active={surfaceMode === 'dashboard' ? 'true' : 'false'}
          onClick={onGoToDashboard}
        >
          <House size={15} weight={surfaceMode === 'dashboard' ? 'fill' : 'regular'} />
          <Typography as="span" variant="smallBody" tone="inherit" className={homeRowLabelClass}>
            Home
          </Typography>
          {liveSessionCount > 0 ? (
            <Typography
              as="span"
              variant="tiny"
              tone="faint"
              className={homeRowMetaClass}
              data-testid="home-nav-live-count"
            >
              {liveSessionCount} live
            </Typography>
          ) : null}
        </button>

        <ProjectGroup
          icon={<CircleDashed size={15} />}
          title={shell.workspace.generalLabel}
          count={sessionsForProject(null, shell).length}
          active={selectedProjectId === null && surfaceMode !== 'dashboard'}
          onProjectClick={() => onSelectProject(null)}
        >
          {shell.focuses
            .filter(focus => !focus.archived && !focus.projectId)
            .map(focus => (
              <FocusRow
                key={focus.id}
                focus={focus}
                count={shell.sessions.filter(session => session.focusId === focus.id).length}
                active={focus.id === selectedFocusId}
                live={shell.sessions.some(
                  session => session.focusId === focus.id && session.status === 'running',
                )}
                onClick={() => onOpenFocus(null, focus.id)}
                onHistory={event => {
                  event.stopPropagation();
                  onOpenSessionHistory(null, focus.id);
                }}
                onRemoveFocus={event => {
                  event.stopPropagation();
                  onArchiveFocus(focus);
                }}
              />
            ))}
          <button
            className={addFocusRowClass}
            type="button"
            data-testid="create-focus-button"
            disabled={busy || !canUseAppServices}
            onClick={() => onOpenCreation('focus', null)}
          >
            <Plus size={13} />
            <Typography as="span" variant="smallBody" tone="inherit">
              New focus
            </Typography>
          </button>
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

        {shell.projects
          .filter(project => !project.archived)
          .map(project => {
            const projectFocuses = shell.focuses.filter(
              focus => !focus.archived && focus.projectId === project.id,
            );
            return (
              <ProjectGroup
                key={project.id}
                icon={<Folder size={15} />}
                title={project.name}
                count={sessionsForProject(project.id, shell).length}
                active={selectedProjectId === project.id}
                onProjectClick={() => onSelectProject(project.id)}
                onRemoveProject={event => {
                  event.stopPropagation();
                  onArchiveProject(project);
                }}
              >
                {projectFocuses.map(focus => (
                  <FocusRow
                    key={focus.id}
                    focus={focus}
                    count={shell.sessions.filter(session => session.focusId === focus.id).length}
                    active={focus.id === selectedFocusId}
                    live={shell.sessions.some(
                      session => session.focusId === focus.id && session.status === 'running',
                    )}
                    onClick={() => onOpenFocus(project.id, focus.id)}
                    onHistory={event => {
                      event.stopPropagation();
                      onOpenSessionHistory(project.id, focus.id);
                    }}
                    onRemoveFocus={event => {
                      event.stopPropagation();
                      onArchiveFocus(focus);
                    }}
                  />
                ))}
                <button
                  className={addFocusRowClass}
                  type="button"
                  data-testid="create-project-focus-button"
                  disabled={busy || !canUseAppServices}
                  onClick={() => onOpenCreation('focus', project.id)}
                >
                  <Plus size={13} />
                  <Typography as="span" variant="smallBody" tone="inherit">
                    New focus
                  </Typography>
                </button>
              </ProjectGroup>
            );
          })}
      </nav>

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

const navClass = css({
  flex: 1,
  overflowY: 'auto',
  padding: '4px 8px 12px',
  position: 'relative',
  zIndex: 2,
  '&::-webkit-scrollbar': { width: '8px' },
  '&::-webkit-scrollbar-thumb': {
    background: 'var(--line)',
    borderRadius: '8px',
    border: '2px solid var(--surface-1)',
  },
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
  fontVariantNumeric: 'tabular-nums',
  padding: '1px 7px',
  border: '1px solid var(--line)',
  borderRadius: '999px',
  background: 'color-mix(in srgb, var(--surface-1) 70%, transparent)',
});

const addFocusRowClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  width: '100%',
  padding: '5px 10px',
  borderRadius: '8px',
  color: 'var(--text-3)',
  cursor: 'pointer',
  textAlign: 'left',
  _hover: { background: 'var(--surface-2)', color: 'var(--text)' },
});

const sectionLabelClass = css({
  padding: '12px 8px 4px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  '& button': {
    color: 'var(--text-3)',
    width: '18px',
    height: '18px',
    display: 'grid',
    placeItems: 'center',
    borderRadius: '5px',
    cursor: 'pointer',
    _hover: { background: 'var(--surface-2)', color: 'var(--text)' },
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
