import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { CaretRight } from '@phosphor-icons/react';

import { css, cx } from '../../styled-system/css';
import { groupSessionsByState } from '../../domain';
import type {
  ActivityState,
  SessionStateTimeline,
  SessionTerminalBinding,
  ShellFocus,
  ShellProject,
  ShellSession,
  WorkspaceShellSnapshot,
} from '../../domain';
import { useGitStatusStore } from '../../store';
import { Typography } from '../primitives/Typography';
import { DashboardCountPills } from './DashboardCountPills';
import { DashboardStateRails, type SessionCardActions } from './DashboardStateRails';
import { RepoStrip } from './RepoStrip';

// One project's overview, a zoom level below Home: every active session across
// the project's topics, intermingled (no per-topic dividers) and grouped into
// the same state sections Home uses. Like Home it carries the calm count pills
// and no "New session" button: it is a map of the project's work, not a place to
// start more. New sessions are created from a topic in the sidebar. Clicking a
// session card opens its terminal.
export function ProjectDashboardSurface({
  shell,
  project,
  sessionTerminalBindings,
  cortexActivity,
  sessionTimelines,
  sessionActions,
  onOpenSession,
  onRestoreTopic,
  onDeleteTopic,
  onLocateFolder,
}: {
  shell: WorkspaceShellSnapshot;
  project: ShellProject;
  sessionTerminalBindings: Record<string, SessionTerminalBinding>;
  cortexActivity: Record<string, ActivityState>;
  sessionTimelines: Record<string, SessionStateTimeline>;
  sessionActions: SessionCardActions;
  onOpenSession: (session: ShellSession) => void;
  onRestoreTopic: (focus: ShellFocus) => void;
  onDeleteTopic: (focus: ShellFocus) => void;
  // Repair the project's folder location (manual fallback for a move that
  // auto-reconnect could not follow). Invoked from the missing-folder banner.
  onLocateFolder: (project: ShellProject) => void;
}) {
  // Scope to the project's non-archived topics, matching what the sidebar rolls
  // up onto the project row, so the row's pills and this surface always agree.
  const { sessions, topicCount } = useMemo(() => {
    const focusIds = new Set(
      shell.focuses
        .filter(focus => !focus.archived && focus.projectId === project.id)
        .map(focus => focus.id),
    );
    return {
      sessions: shell.sessions.filter(
        session => !session.archived && focusIds.has(session.focusId),
      ),
      topicCount: focusIds.size,
    };
  }, [shell.focuses, shell.sessions, project.id]);

  // The project's own archived topics (own bit set). They live here, off the main
  // map, with restore and a permanent delete. A session count uses every session
  // in the topic since they are all effectively archived with it.
  const archivedTopics = useMemo(
    () => shell.focuses.filter(focus => focus.projectId === project.id && focus.archived),
    [shell.focuses, project.id],
  );
  const [showArchived, setShowArchived] = useState(false);

  // Git context for this project folder, pushed by the backend poll loop. Null
  // when the folder is not a repository (then the repo strip simply doesn't
  // render, and the page reads exactly as it did before git awareness).
  const repoStatus = useGitStatusStore(s => s.repoStatus[project.id]);

  const groups = groupSessionsByState(sessions, sessionTerminalBindings, cortexActivity);

  return (
    <div className={projectSurfaceClass} data-testid="project-dashboard-surface">
      <motion.div
        className={projectContentClass}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      >
        <header className={projectHeaderClass}>
          <div>
            <Typography
              as="p"
              variant="tiny"
              tone="faint"
              uppercase
              style={{ letterSpacing: '0.12em' }}
            >
              Project
            </Typography>
            <Typography as="h1" variant="subtitle" tone="default" className={projectTitleClass}>
              {project.name}
            </Typography>
            <Typography as="span" variant="caption" tone="faint">
              {topicCount} {topicCount === 1 ? 'topic' : 'topics'} · {sessions.length}{' '}
              {sessions.length === 1 ? 'session' : 'sessions'}
            </Typography>
          </div>
          <DashboardCountPills groups={groups} />
        </header>

        {project.folderMissing ? (
          <div className={missingBannerClass} role="alert" data-testid="project-folder-missing">
            <div className={missingTextClass}>
              <Typography as="span" variant="smallBody" tone="warn">
                This project’s folder can’t be found
              </Typography>
              <Typography as="span" variant="caption" tone="faint" className={missingPathClass}>
                {project.path}
              </Typography>
            </div>
            <button
              type="button"
              className={missingActionClass}
              onClick={() => onLocateFolder(project)}
            >
              <Typography as="span" variant="caption" tone="inherit">
                Locate folder…
              </Typography>
            </button>
          </div>
        ) : null}

        {repoStatus ? <RepoStrip status={repoStatus} projectId={project.id} /> : null}

        {sessions.length > 0 ? (
          <DashboardStateRails
            groups={groups}
            shell={shell}
            bindings={sessionTerminalBindings}
            cortexActivity={cortexActivity}
            sessionTimelines={sessionTimelines}
            sessionActions={sessionActions}
            onOpenSession={onOpenSession}
          />
        ) : (
          <Typography
            as="div"
            variant="smallBody"
            tone="faint"
            className={projectEmptyClass}
            data-testid="project-dashboard-empty"
          >
            No active sessions in this project yet. Open a topic in the sidebar to start one.
          </Typography>
        )}

        {archivedTopics.length > 0 ? (
          <section className={archivedSectionClass} data-testid="project-archived-topics">
            <button
              type="button"
              className={archivedToggleClass}
              onClick={() => setShowArchived(open => !open)}
              aria-expanded={showArchived}
            >
              <CaretRight
                size={12}
                weight="bold"
                className={cx(archivedCaretClass, showArchived && archivedCaretOpenClass)}
              />
              <Typography
                as="span"
                variant="caption"
                tone="faint"
                uppercase
                style={{ letterSpacing: '0.1em' }}
              >
                Archived topics ({archivedTopics.length})
              </Typography>
            </button>
            {showArchived ? (
              <ul className={archivedListClass}>
                {archivedTopics.map(focus => {
                  const count = shell.sessions.filter(
                    session => session.focusId === focus.id,
                  ).length;
                  return (
                    <li key={focus.id} className={archivedRowClass}>
                      <div className={archivedRowMainClass}>
                        <Typography as="span" variant="smallBody" tone="muted">
                          {focus.title}
                        </Typography>
                        <Typography as="span" variant="caption" tone="faint">
                          {count} {count === 1 ? 'session' : 'sessions'}
                        </Typography>
                      </div>
                      <div className={archivedRowActionsClass}>
                        <button
                          type="button"
                          className={archivedActionClass}
                          onClick={() => onRestoreTopic(focus)}
                        >
                          <Typography as="span" variant="caption" tone="inherit">
                            Restore
                          </Typography>
                        </button>
                        <button
                          type="button"
                          className={cx(archivedActionClass, archivedDangerClass)}
                          onClick={() => onDeleteTopic(focus)}
                        >
                          <Typography as="span" variant="caption" tone="inherit">
                            Delete
                          </Typography>
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>
        ) : null}
      </motion.div>
    </div>
  );
}

const projectSurfaceClass = css({
  position: 'relative',
  // height (not flex: 1): the parent canvas stage is a block, so a definite
  // height is what lets the inner overflowY: auto scroll. Mirrors DashboardSurface.
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: 'transparent',
});

const projectContentClass = css({
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

const projectHeaderClass = css({
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: '16px',
  flexWrap: 'wrap',
});

const projectTitleClass = css({
  margin: '4px 0 2px',
});

const projectEmptyClass = css({
  padding: '18px',
  border: '1px dashed var(--line)',
  borderRadius: '18px',
});

const missingBannerClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '16px',
  flexWrap: 'wrap',
  padding: '12px 16px',
  border: '1px solid color-mix(in srgb, var(--warn) 45%, var(--line))',
  borderRadius: '14px',
  background: 'color-mix(in srgb, var(--warn) 8%, var(--surface-1))',
});

const missingTextClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  minWidth: 0,
});

const missingPathClass = css({
  fontFamily: 'var(--font-mono, monospace)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const missingActionClass = css({
  flexShrink: 0,
  background: 'transparent',
  border: '1px solid color-mix(in srgb, var(--warn) 55%, var(--line))',
  borderRadius: '999px',
  padding: '5px 14px',
  cursor: 'pointer',
  color: 'var(--warn)',
  transition: 'border-color 0.15s ease, background 0.15s ease',
  _hover: { background: 'color-mix(in srgb, var(--warn) 14%, transparent)' },
});

const archivedSectionClass = css({
  marginTop: '8px',
  borderTop: '1px solid var(--line)',
  paddingTop: '16px',
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
});

const archivedToggleClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  background: 'transparent',
  border: 'none',
  padding: '2px 0',
  cursor: 'pointer',
  color: 'var(--text-3)',
  width: 'fit-content',
  _hover: { color: 'var(--text-2)' },
});

const archivedCaretClass = css({
  transition: 'transform 0.18s ease',
});

const archivedCaretOpenClass = css({
  transform: 'rotate(90deg)',
});

const archivedListClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  listStyle: 'none',
  margin: 0,
  padding: 0,
});

const archivedRowClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '16px',
  padding: '10px 14px',
  border: '1px solid var(--line)',
  borderRadius: '14px',
  background: 'var(--surface-1)',
});

const archivedRowMainClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  minWidth: 0,
});

const archivedRowActionsClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  flexShrink: 0,
});

const archivedActionClass = css({
  background: 'transparent',
  border: '1px solid var(--line)',
  borderRadius: '999px',
  padding: '4px 12px',
  cursor: 'pointer',
  color: 'var(--text-2)',
  transition: 'border-color 0.15s ease, color 0.15s ease, background 0.15s ease',
  _hover: { borderColor: 'var(--line-strong)', color: 'var(--text)' },
});

const archivedDangerClass = css({
  color: 'var(--text-3)',
  _hover: { borderColor: 'var(--bad)', color: 'var(--bad)' },
});
