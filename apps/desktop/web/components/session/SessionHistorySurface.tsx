import { Plus } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { agentLabel, shortId } from '../../domain';
import type { ShellFocus, ShellSession } from '../../domain';
import {
  dangerComposerButtonClass,
  primaryComposerButtonClass,
  secondaryComposerButtonClass,
} from '../primitives/buttons';
import { Typography } from '../primitives/Typography';

// Full session history for a focus: every session ever created under it
// (active tabs + closed tabs), with restore / delete actions and a new-session
// button. Closed-tab sessions keep their record so they can be resumed.
export function SessionHistorySurface({
  focus,
  sessions,
  visibleCount,
  hiddenCount,
  onRestore,
  onDelete,
  onCreateSession,
  busy,
}: {
  focus: ShellFocus | null;
  sessions: ShellSession[];
  visibleCount: number;
  hiddenCount: number;
  onRestore: (session: ShellSession) => void;
  onDelete: (session: ShellSession) => void;
  onCreateSession: () => void;
  busy: boolean;
}) {
  return (
    <div className={sessionHistorySurfaceClass} data-testid="session-history-surface">
      <div className={sessionHistoryHeaderClass}>
        <div>
          <Typography
            as="p"
            variant="caption"
            tone="faint"
            uppercase
            style={{ letterSpacing: '0.14em' }}
          >
            Focus session history
          </Typography>
          <Typography
            as="h2"
            variant="title"
            tone="default"
            style={{ margin: '6px 0', letterSpacing: '-0.04em' }}
          >
            {focus?.title ?? 'No focus selected'}
          </Typography>
          <Typography as="span" variant="caption" tone="faint">
            {sessions.length} total · {visibleCount} active tabs · {hiddenCount} closed tabs
          </Typography>
        </div>
        <button
          className={primaryComposerButtonClass}
          type="button"
          onClick={onCreateSession}
          disabled={busy || !focus}
        >
          <Plus size={14} />{' '}
          <Typography as="span" variant="smallBodyAlt" tone="inherit">
            New session
          </Typography>
        </button>
      </div>

      <div className={sessionHistoryListClass}>
        {sessions.length === 0 ? (
          <Typography
            as="div"
            variant="smallBody"
            tone="faint"
            className={sessionHistoryEmptyClass}
            data-testid="session-history-empty"
          >
            No sessions have been created under this focus yet.
          </Typography>
        ) : (
          sessions.map(session => {
            const tabVisible = session.tabVisible !== false;
            return (
              <div
                className={sessionHistoryRowClass}
                key={session.id}
                data-testid="session-history-row"
                data-session-id={session.id}
                data-tab-visible={tabVisible ? 'true' : 'false'}
              >
                <div>
                  <Typography
                    as="strong"
                    variant="smallBodyAlt"
                    tone="default"
                    className={sessionHistoryTitleClass}
                  >
                    {session.title}
                  </Typography>
                  <Typography
                    as="span"
                    variant="caption"
                    tone="faint"
                    className={sessionHistoryMetaClass}
                  >
                    {agentLabel(session.agentKind)} · {session.status.replace(/_/g, ' ')} ·{' '}
                    {shortId(session.id)}
                  </Typography>
                  <Typography
                    as="small"
                    variant="caption"
                    tone="faint"
                    className={sessionHistoryPathClass}
                  >
                    {session.cwd}
                  </Typography>
                </div>
                <div className={sessionHistoryActionsClass}>
                  {tabVisible ? (
                    <Typography
                      as="span"
                      variant="caption"
                      tone="muted"
                      className={activeTabPillClass}
                    >
                      Active tab
                    </Typography>
                  ) : (
                    <button
                      className={secondaryComposerButtonClass}
                      type="button"
                      data-testid="restore-session-tab-button"
                      onClick={() => onRestore(session)}
                      disabled={busy}
                    >
                      <Typography as="span" variant="smallBodyAlt" tone="inherit">
                        Restore tab
                      </Typography>
                    </button>
                  )}
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
            );
          })
        )}
      </div>
    </div>
  );
}

const sessionHistorySurfaceClass = css({
  minHeight: '100%',
  padding: '44px',
  color: 'var(--text)',
  background: 'radial-gradient(circle at 70% 14%, rgba(134,167,255,0.10), transparent 38%)',
});

const sessionHistoryHeaderClass = css({
  display: 'flex',
  justifyContent: 'space-between',
  gap: '24px',
  alignItems: 'flex-start',
  marginBottom: '22px',
});

const sessionHistoryListClass = css({
  display: 'grid',
  gap: '10px',
});

const sessionHistoryRowClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '18px',
  padding: '14px 16px',
  border: '1px solid var(--line)',
  borderRadius: '18px',
  background: 'color-mix(in srgb, var(--surface-2) 72%, transparent)',
  boxShadow: '0 18px 50px rgba(0,0,0,0.16)',
});

const sessionHistoryTitleClass = css({
  display: 'block',
});

const sessionHistoryMetaClass = css({
  display: 'block',
  marginTop: '4px',
});

const sessionHistoryPathClass = css({
  display: 'block',
  marginTop: '3px',
  maxWidth: '540px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const sessionHistoryActionsClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
});

const sessionHistoryEmptyClass = css({
  padding: '18px',
  border: '1px dashed var(--line)',
  borderRadius: '18px',
});

const activeTabPillClass = css({
  height: '28px',
  padding: '0 10px',
  border: '1px solid var(--line)',
  borderRadius: '999px',
  display: 'inline-flex',
  alignItems: 'center',
});
