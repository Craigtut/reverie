import { motion } from 'motion/react';
import { Archive, Plus, Warning } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { agentLabel, groupSessionsByState, shortId } from '../../domain';
import type {
  ActivityState,
  DashboardStatus,
  SessionState,
  SessionTerminalBinding,
  ShellFocus,
  ShellSession,
  WorkspaceShellSnapshot,
} from '../../domain';
import { DashboardRail } from '../dashboard';
import {
  dangerComposerButtonClass,
  primaryComposerButtonClass,
  secondaryComposerButtonClass,
} from '../primitives/buttons';
import { Typography } from '../primitives/Typography';

const SECTIONS: { key: SessionState; title: string; tone: DashboardStatus; attention?: boolean }[] =
  [
    { key: 'attention', title: 'Needs your attention', tone: 'attention', attention: true },
    { key: 'finished', title: 'Ready for you', tone: 'recent' },
    { key: 'active', title: 'Working', tone: 'live' },
    { key: 'idle', title: 'Idle', tone: 'recent' },
    { key: 'fresh', title: 'Fresh', tone: 'recent' },
  ];

// The focus view: a dashboard scoped to one focus. Non-archived sessions are
// grouped into the same state sections as Home; archived sessions sit in a list
// at the bottom, each restorable or deletable. The only place archived sessions
// surface.
export function SessionHistorySurface({
  focus,
  shell,
  activeSessions,
  archivedSessions,
  sessionTerminalBindings,
  cortexActivity,
  onOpenSession,
  onRestore,
  onDelete,
  onCreateSession,
  busy,
}: {
  focus: ShellFocus | null;
  shell: WorkspaceShellSnapshot;
  activeSessions: ShellSession[];
  archivedSessions: ShellSession[];
  sessionTerminalBindings: Record<string, SessionTerminalBinding>;
  cortexActivity: Record<string, ActivityState>;
  onOpenSession: (session: ShellSession) => void;
  onRestore: (session: ShellSession) => void;
  onDelete: (session: ShellSession) => void;
  onCreateSession: () => void;
  busy: boolean;
}) {
  const project = focus?.projectId
    ? (shell.projects.find(p => p.id === focus.projectId) ?? null)
    : null;
  const breadcrumb = focus ? (project ? project.name : shell.workspace.generalLabel) : 'Workspace';
  const groups = groupSessionsByState(activeSessions, sessionTerminalBindings, cortexActivity);
  const total = activeSessions.length + archivedSessions.length;

  return (
    <div className={focusSurfaceClass} data-testid="session-history-surface">
      <motion.div
        className={focusContentClass}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      >
        <header className={focusHeaderClass}>
          <div>
            <Typography
              as="p"
              variant="tiny"
              tone="faint"
              uppercase
              style={{ letterSpacing: '0.12em' }}
            >
              {breadcrumb}
            </Typography>
            <Typography as="h1" variant="subtitle" tone="default" className={focusTitleClass}>
              {focus?.title ?? 'No focus selected'}
            </Typography>
            <Typography as="span" variant="caption" tone="faint">
              {activeSessions.length} active · {archivedSessions.length} archived · {total} total
            </Typography>
          </div>
          <button
            className={primaryComposerButtonClass}
            type="button"
            onClick={onCreateSession}
            disabled={busy || !focus}
          >
            <Plus size={14} />
            <Typography as="span" variant="smallBodyAlt" tone="inherit">
              New session
            </Typography>
          </button>
        </header>

        {SECTIONS.map(section =>
          groups[section.key].length > 0 ? (
            <DashboardRail
              key={section.key}
              title={section.title}
              icon={section.attention ? <Warning size={13} weight="fill" /> : undefined}
              tone={section.tone}
              sessions={groups[section.key]}
              shell={shell}
              bindings={sessionTerminalBindings}
              cortexActivity={cortexActivity}
              onOpenSession={onOpenSession}
            />
          ) : null,
        )}

        {activeSessions.length === 0 ? (
          <Typography
            as="div"
            variant="smallBody"
            tone="faint"
            className={focusEmptyClass}
            data-testid="session-history-empty"
          >
            No active sessions in this focus. Start one with “New session”.
          </Typography>
        ) : null}

        {archivedSessions.length > 0 ? (
          <section className={archivedSectionClass} data-testid="archived-section">
            <header className={archivedHeaderClass}>
              <Archive size={13} />
              <Typography
                as="h2"
                variant="caption"
                tone="faint"
                uppercase
                style={{ letterSpacing: '0.1em' }}
              >
                Archived
              </Typography>
              <Typography as="span" variant="caption" tone="ghost">
                {archivedSessions.length}
              </Typography>
            </header>
            <div className={archivedListClass}>
              {archivedSessions.map(session => (
                <div
                  className={archivedRowClass}
                  key={session.id}
                  data-testid="session-history-row"
                  data-session-id={session.id}
                  data-tab-visible="false"
                >
                  <div className={archivedRowMainClass}>
                    <Typography as="strong" variant="smallBodyAlt" tone="default">
                      {session.title}
                    </Typography>
                    <Typography as="span" variant="caption" tone="faint">
                      {agentLabel(session.agentKind)} · {session.status.replace(/_/g, ' ')} ·{' '}
                      {shortId(session.id)}
                    </Typography>
                    <Typography
                      as="small"
                      variant="caption"
                      tone="faint"
                      selectable
                      className={archivedPathClass}
                    >
                      {session.cwd}
                    </Typography>
                  </div>
                  <div className={archivedActionsClass}>
                    <button
                      className={secondaryComposerButtonClass}
                      type="button"
                      data-testid="restore-session-tab-button"
                      onClick={() => onRestore(session)}
                      disabled={busy}
                    >
                      <Typography as="span" variant="smallBodyAlt" tone="inherit">
                        Restore
                      </Typography>
                    </button>
                    <button
                      className={dangerComposerButtonClass}
                      type="button"
                      data-testid="delete-session-button"
                      onClick={() => onDelete(session)}
                      disabled={busy}
                    >
                      <Typography as="span" variant="smallBodyAlt" tone="inherit">
                        Delete
                      </Typography>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </motion.div>
    </div>
  );
}

const focusSurfaceClass = css({
  position: 'relative',
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: 'transparent',
});

const focusContentClass = css({
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

const focusHeaderClass = css({
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: '16px',
  flexWrap: 'wrap',
});

const focusTitleClass = css({
  margin: '4px 0 2px',
});

const focusEmptyClass = css({
  padding: '18px',
  border: '1px dashed var(--line)',
  borderRadius: '18px',
});

const archivedSectionClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  marginTop: '4px',
  paddingTop: '20px',
  borderTop: '1px solid var(--line-faint)',
});

const archivedHeaderClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  color: 'var(--text-3)',
});

const archivedListClass = css({
  display: 'grid',
  gap: '8px',
});

const archivedRowClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '18px',
  padding: '12px 14px',
  border: '1px solid var(--line)',
  borderRadius: '14px',
  background: 'color-mix(in srgb, var(--surface-1) 60%, transparent)',
});

const archivedRowMainClass = css({
  minWidth: 0,
  display: 'grid',
  gap: '3px',
  '& > *': { display: 'block' },
});

const archivedPathClass = css({
  maxWidth: '540px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const archivedActionsClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexShrink: 0,
});
