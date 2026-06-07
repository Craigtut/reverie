import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Archive, CaretRight, Plus, Trash, Warning } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { groupSessionsByState, sessionCanRestore, sortGroupByRecency } from '../../domain';
import type {
  ActivityState,
  DashboardStatus,
  SessionState,
  SessionStateTimeline,
  SessionTerminalBinding,
  ShellFocus,
  ShellSession,
  WorkspaceShellSnapshot,
} from '../../domain';
import { DashboardRail } from '../dashboard';
import { AgentGlyph } from '../glyphs';
import { primaryComposerButtonClass } from '../primitives/buttons';
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
// grouped into the same state sections as Home. Archived sessions are tucked
// behind a quiet disclosure at the bottom (collapsed by default): the user
// rarely needs them, so they stay out of the way until deliberately opened. The
// only place archived sessions surface.
export function SessionHistorySurface({
  focus,
  shell,
  activeSessions,
  archivedSessions,
  sessionTerminalBindings,
  cortexActivity,
  sessionTimelines,
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
  sessionTimelines: Record<string, SessionStateTimeline>;
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

  // Archives stay tucked away by default and re-collapse whenever the user lands
  // on a different topic, so the focus view always opens calm. Resetting during
  // render (keyed on the focus id) avoids an extra mount and the open-then-snap
  // flash a post-render effect would cause.
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [seenFocusId, setSeenFocusId] = useState(focus?.id ?? null);
  if ((focus?.id ?? null) !== seenFocusId) {
    setSeenFocusId(focus?.id ?? null);
    setArchivedOpen(false);
  }

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
              sessions={sortGroupByRecency(
                groups[section.key],
                section.key,
                sessionTimelines,
                cortexActivity,
              )}
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
            <button
              type="button"
              className={archivedToggleClass}
              data-testid="archived-disclosure-toggle"
              aria-expanded={archivedOpen}
              onClick={() => setArchivedOpen(open => !open)}
            >
              <Archive size={13} />
              <Typography
                as="span"
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
              <span className={archivedToggleSpacerClass} />
              <span className={archivedCaretClass} data-open={archivedOpen} aria-hidden="true">
                <CaretRight size={12} weight="bold" />
              </span>
            </button>

            <AnimatePresence initial={false}>
              {archivedOpen ? (
                <motion.div
                  key="archived-list"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
                  style={{ overflow: 'hidden' }}
                >
                  <div className={archivedListClass}>
                    {archivedSessions.map(session => {
                      const restorable = sessionCanRestore(session);
                      return (
                        <div
                          className={archivedRowClass}
                          key={session.id}
                          data-testid="session-history-row"
                          data-session-id={session.id}
                          data-tab-visible="false"
                        >
                          <span className={archivedGlyphClass}>
                            <AgentGlyph kind={session.agentKind} />
                          </span>
                          <Typography
                            as="strong"
                            variant="smallBodyAlt"
                            tone="default"
                            truncate
                            className={archivedTitleClass}
                          >
                            {session.title}
                          </Typography>
                          {!restorable ? (
                            <span
                              className={cantRestoreTagClass}
                              title="This session exited without a resumable conversation, so restoring it can't bring the agent's history back."
                            >
                              <Warning size={11} weight="fill" />
                              <Typography
                                as="span"
                                variant="tiny"
                                tone="inherit"
                                uppercase
                                style={{ letterSpacing: '0.06em' }}
                              >
                                Can't restore
                              </Typography>
                            </span>
                          ) : null}
                          <span className={archivedActionsClass} data-row-actions="true">
                            <button
                              className={archivedRestoreButtonClass}
                              type="button"
                              data-testid="restore-session-tab-button"
                              onClick={() => onRestore(session)}
                              disabled={busy}
                            >
                              <Typography as="span" variant="caption" tone="inherit">
                                Restore
                              </Typography>
                            </button>
                            <button
                              className={archivedDeleteButtonClass}
                              type="button"
                              data-testid="delete-session-button"
                              onClick={() => onDelete(session)}
                              disabled={busy}
                              aria-label={`Delete ${session.title}`}
                              title="Delete permanently"
                            >
                              <Trash size={14} />
                            </button>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
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
  marginTop: '4px',
  paddingTop: '16px',
  borderTop: '1px solid var(--line-faint)',
});

// The collapsed disclosure: a full-width, quiet strip that stays out of the way
// until the user reaches for it.
const archivedToggleClass = css({
  appearance: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  width: '100%',
  padding: '6px 10px',
  borderRadius: '10px',
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--text-3)',
  cursor: 'pointer',
  transition: 'background 130ms ease, color 130ms ease',
  _hover: { background: 'var(--surface-2)', color: 'var(--text-2)' },
});

const archivedToggleSpacerClass = css({ flex: 1 });

const archivedCaretClass = css({
  display: 'grid',
  placeItems: 'center',
  color: 'inherit',
  transition: 'transform 160ms cubic-bezier(0.22, 1, 0.36, 1)',
  '&[data-open="true"]': { transform: 'rotate(90deg)' },
});

const archivedListClass = css({
  display: 'grid',
  gap: '2px',
  paddingTop: '8px',
});

// Compact single-line row. Calm at rest (actions faded out), it reveals its
// Restore/Delete controls on hover or keyboard focus, matching the nav idiom.
const archivedRowClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  minHeight: '40px',
  padding: '6px 10px 6px 8px',
  borderRadius: '11px',
  border: '1px solid transparent',
  transition: 'background 130ms ease',
  _hover: {
    background: 'var(--surface-2)',
    '& [data-row-actions]': { opacity: 1, pointerEvents: 'auto' },
  },
  '&:focus-within': {
    '& [data-row-actions]': { opacity: 1, pointerEvents: 'auto' },
  },
});

// The agent's own logo, a touch larger than its 14px default so it reads as the
// row's anchor.
const archivedGlyphClass = css({
  display: 'inline-flex',
  flexShrink: 0,
  '& > span': { width: '16px', height: '16px' },
});

const archivedTitleClass = css({
  flex: 1,
  minWidth: 0,
});

// The lone status the user needs: shown only when a session genuinely can't be
// restored. Otherwise the row says nothing about restorability.
const cantRestoreTagClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  flexShrink: 0,
  padding: '2px 8px',
  borderRadius: '999px',
  color: 'var(--warn)',
  background: 'color-mix(in srgb, var(--warn) 12%, transparent)',
  border: '1px solid color-mix(in srgb, var(--warn) 28%, transparent)',
});

const archivedActionsClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  flexShrink: 0,
  opacity: 0,
  pointerEvents: 'none',
  transition: 'opacity 130ms ease',
});

const archivedRestoreButtonClass = css({
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  height: '28px',
  padding: '0 12px',
  borderRadius: '999px',
  border: '1px solid var(--line)',
  background: 'color-mix(in srgb, var(--surface-2) 72%, transparent)',
  color: 'var(--text-2)',
  cursor: 'pointer',
  transition: 'border-color 130ms ease, color 130ms ease, background 130ms ease',
  _hover: { borderColor: 'var(--line-strong)', color: 'var(--text)' },
  _disabled: { opacity: 0.45, cursor: 'not-allowed' },
});

// Destructive and permanent, so it stays a quiet ghost icon until hover, then
// turns bad-toned to signal the stakes.
const archivedDeleteButtonClass = css({
  appearance: 'none',
  display: 'inline-grid',
  placeItems: 'center',
  width: '28px',
  height: '28px',
  borderRadius: '999px',
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--text-3)',
  cursor: 'pointer',
  transition: 'color 130ms ease, background 130ms ease, border-color 130ms ease',
  _hover: {
    color: 'var(--bad)',
    background: 'color-mix(in srgb, var(--bad) 12%, transparent)',
    borderColor: 'color-mix(in srgb, var(--bad) 30%, transparent)',
  },
  _disabled: { opacity: 0.45, cursor: 'not-allowed' },
});
