import { motion } from 'motion/react';
import { CheckCircle, Plus } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { activeWorkspaceSessions, groupSessionsByState } from '../../domain';
import type {
  ActivityState,
  SessionStateTimeline,
  SessionTerminalBinding,
  ShellSession,
  WorkspaceShellSnapshot,
} from '../../domain';
import { EmptyState } from '../onboarding';
import { Typography } from '../primitives/Typography';
import { DashboardCountPills } from './DashboardCountPills';
import { DashboardStateRails, type SessionCardActions } from './DashboardStateRails';
import { DASHBOARD_SECTIONS } from './sections';

// The default surface (Home): every non-archived session across the workspace,
// grouped by state. Archived sessions are excluded here and live in each focus's
// history. Shows first-run onboarding when there are no sessions at all, and a
// calm "all caught up" panel once everything has been archived.
export function DashboardSurface({
  shell,
  sessionTerminalBindings,
  cortexActivity,
  sessionTimelines,
  sessionActions,
  onOpenSession,
  onCreateProject,
  onCreateGeneralSession,
  onOpenSettings,
  onSetWorkspaceDefaultDangerousMode,
  keepAwakeEnabled,
  onSetKeepAwakeEnabled,
}: {
  shell: WorkspaceShellSnapshot;
  sessionTerminalBindings: Record<string, SessionTerminalBinding>;
  cortexActivity: Record<string, ActivityState>;
  sessionTimelines: Record<string, SessionStateTimeline>;
  sessionActions: SessionCardActions;
  onOpenSession: (session: ShellSession) => void;
  onCreateProject: () => void;
  onCreateGeneralSession: () => void;
  onOpenSettings: () => void;
  onSetWorkspaceDefaultDangerousMode: (next: boolean) => void;
  keepAwakeEnabled: boolean;
  onSetKeepAwakeEnabled: (next: boolean) => void;
}) {
  // Home shows every *effectively* active session: not archived, and not inside
  // an archived topic or project (see activeWorkspaceSessions). Filtering on the
  // session's own bit alone is what used to leak a deleted project's sessions
  // onto Home, since archiving a project hides its sessions by ancestry.
  const active = activeWorkspaceSessions(shell);
  const groups = groupSessionsByState(active, sessionTerminalBindings, cortexActivity);
  // The home is an attention router: it shows only the tiers that earn a place
  // here. `fresh` is off the home entirely (it lives in the nav), so we render the
  // home-visible sections and judge "all caught up" by whether any of them has
  // content. A workspace of only never-launched sessions therefore reads calm,
  // not as a wall of fresh tiles.
  const homeSections = DASHBOARD_SECTIONS.filter(section => section.home);
  const hasHomeContent = homeSections.some(section => groups[section.key].length > 0);

  // When idle is the only tier with anything in it, nothing needs you and nothing
  // is running: a collapsed idle chip pinned to the top-left reads as a broken,
  // empty page rather than the calm state it actually is. So in that case we drop
  // into a quiet layout: the content centers in the body and the idle list opens
  // in place, so your resting work is right there to pick up. Idle stays collapsed
  // only when it has higher tiers above it to defer to.
  const nonEmptyHomeSections = homeSections.filter(section => groups[section.key].length > 0);
  const calmIdleOnly = nonEmptyHomeSections.length === 1 && nonEmptyHomeSections[0].key === 'idle';
  const renderedSections = calmIdleOnly
    ? homeSections.map(section =>
        // In the quiet layout the idle rail is the whole screen, so render it as a
        // plain, always-open list (no collapse control to fold the page back to
        // empty).
        section.key === 'idle'
          ? { ...section, collapsible: false, defaultCollapsed: false }
          : section,
      )
    : homeSections;

  if (shell.sessions.length === 0) {
    return (
      <EmptyState
        createProject={onCreateProject}
        createGeneralSession={onCreateGeneralSession}
        openSettings={onOpenSettings}
        workspaceDefaultDangerousMode={shell.workspace.defaultDangerousMode}
        onSetWorkspaceDefaultDangerousMode={onSetWorkspaceDefaultDangerousMode}
        keepAwakeEnabled={keepAwakeEnabled}
        onSetKeepAwakeEnabled={onSetKeepAwakeEnabled}
      />
    );
  }

  if (!hasHomeContent) {
    return (
      <div className={caughtUpClass} data-testid="dashboard-caught-up">
        <motion.div
          className={caughtUpCenterClass}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <CheckCircle size={26} weight="duotone" />
          <Typography as="h1" variant="subtitle" tone="default">
            You're all caught up
          </Typography>
          <Typography as="p" variant="smallBody" tone="faint" align="center">
            Nothing open right now. Closed sessions are kept in each focus's history, where you can
            restore them anytime.
          </Typography>
          <button
            type="button"
            className={caughtUpActionClass}
            data-testid="caught-up-new-session-button"
            onClick={onCreateGeneralSession}
          >
            <Plus size={14} />
            <Typography as="span" variant="smallBody" tone="inherit">
              New session
            </Typography>
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className={dashboardSurfaceClass} data-testid="dashboard-surface">
      <motion.div
        className={dashboardContentClass}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      >
        <header className={dashboardHeaderClass}>
          <div>
            <Typography
              as="p"
              variant="tiny"
              tone="faint"
              uppercase
              style={{ letterSpacing: '0.12em' }}
            >
              Workspace
            </Typography>
            <Typography as="h1" variant="subtitle" tone="default" className={dashboardTitleClass}>
              {shell.workspace.name}
            </Typography>
          </div>
          <DashboardCountPills groups={groups} />
        </header>

        {calmIdleOnly ? (
          <div className={calmBodyClass} data-testid="dashboard-quiet">
            <div className={calmHeadingClass}>
              <Typography as="h2" variant="subtitle" tone="default" align="center">
                Everything's quiet
              </Typography>
              <Typography as="p" variant="smallBody" tone="faint" align="center">
                Nothing needs you right now. Pick up a resting session below whenever you're ready.
              </Typography>
            </div>
            <DashboardStateRails
              groups={groups}
              shell={shell}
              bindings={sessionTerminalBindings}
              cortexActivity={cortexActivity}
              sessionTimelines={sessionTimelines}
              sessionActions={sessionActions}
              onOpenSession={onOpenSession}
              sections={renderedSections}
            />
          </div>
        ) : (
          <DashboardStateRails
            groups={groups}
            shell={shell}
            bindings={sessionTerminalBindings}
            cortexActivity={cortexActivity}
            sessionTimelines={sessionTimelines}
            sessionActions={sessionActions}
            onOpenSession={onOpenSession}
            sections={homeSections}
          />
        )}
      </motion.div>
    </div>
  );
}

const dashboardSurfaceClass = css({
  position: 'relative',
  // height (not flex: 1): the parent canvas stage is a block, not a flex
  // container, so flex: 1 collapses to auto/content height and the inner
  // overflowY: auto never gets a bounded height to scroll within. A definite
  // 100% height fills the stage and lets the content rail scroll on overflow.
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: 'transparent',
});

const dashboardContentClass = css({
  position: 'relative',
  zIndex: 2,
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '28px 32px 40px',
  display: 'flex',
  flexDirection: 'column',
  gap: '28px',
});

// The quiet (idle-only) body. `marginBlock: auto` centers it in the space below
// the header when the list is short, and collapses to 0 (so the parent simply
// scrolls, never clipping the top) when a long idle list overflows. The generous
// `paddingTop` and `gap` are deliberate: when nothing needs you, the "everything's
// quiet" heading gets real breathing room above it and a wide margin down to the
// resting list, so the state reads calm rather than crowded.
const calmBodyClass = css({
  marginBlock: 'auto',
  display: 'flex',
  flexDirection: 'column',
  paddingTop: '72px',
  gap: '94px',
  width: '100%',
});

const calmHeadingClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  maxWidth: '460px',
  marginInline: 'auto',
  textAlign: 'center',
  '& p': { margin: 0 },
});

const dashboardHeaderClass = css({
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: '16px',
  flexWrap: 'wrap',
});

// Layout only; the title's size + color come from the Typography variant + tone.
const dashboardTitleClass = css({
  margin: '4px 0 0',
});

const caughtUpClass = css({
  position: 'relative',
  // height (not flex: 1): see dashboardSurfaceClass. The parent stage is a block,
  // so a definite height is needed to fill it and center the panel in the stage.
  height: '100%',
  minHeight: 0,
  display: 'grid',
  placeItems: 'center',
  overflow: 'hidden',
  background: 'transparent',
});

const caughtUpCenterClass = css({
  position: 'relative',
  zIndex: 2,
  display: 'grid',
  justifyItems: 'center',
  gap: '12px',
  width: 'min(400px, calc(100vw - 360px))',
  textAlign: 'center',
  color: 'var(--text-3)',
  '& > svg': { color: 'var(--good)' },
  '& p': { margin: 0 },
});

const caughtUpActionClass = css({
  marginTop: '6px',
  height: '34px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '7px',
  padding: '0 14px',
  borderRadius: '999px',
  border: '1px solid var(--line-strong)',
  color: 'var(--text)',
  background: 'var(--surface-3)',
  boxShadow: 'var(--shadow)',
  cursor: 'pointer',
  transition: 'background 140ms ease',
  _hover: { background: 'var(--surface-hi)' },
});
