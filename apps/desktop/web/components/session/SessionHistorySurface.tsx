import { Plus } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { agentLabel, shortId } from '../../domain';
import type { ShellFocus, ShellSession } from '../../domain';
import { dangerComposerButtonClass, primaryComposerButtonClass, secondaryComposerButtonClass } from '../primitives/buttons';

// Full session history for a focus: every session ever created under it
// (active tabs + closed tabs), with restore / delete actions and a new-session
// button. Closed-tab sessions keep their record so they can be resumed.
export function SessionHistorySurface({ focus, sessions, visibleCount, hiddenCount, onRestore, onDelete, onCreateSession, busy }: {
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
          <p>Focus session history</p>
          <h2>{focus?.title ?? 'No focus selected'}</h2>
          <span>{sessions.length} total · {visibleCount} active tabs · {hiddenCount} closed tabs</span>
        </div>
        <button className={primaryComposerButtonClass} type="button" onClick={onCreateSession} disabled={busy || !focus}>
          <Plus size={14} /> New session
        </button>
      </div>

      <div className={sessionHistoryListClass}>
        {sessions.length === 0 ? (
          <div className={sessionHistoryEmptyClass} data-testid="session-history-empty">No sessions have been created under this focus yet.</div>
        ) : sessions.map(session => {
          const tabVisible = session.tabVisible !== false;
          return (
            <div className={sessionHistoryRowClass} key={session.id} data-testid="session-history-row" data-session-id={session.id} data-tab-visible={tabVisible ? 'true' : 'false'}>
              <div>
                <strong>{session.title}</strong>
                <span>{agentLabel(session.agentKind)} · {session.status.replace(/_/g, ' ')} · {shortId(session.id)}</span>
                <small>{session.cwd}</small>
              </div>
              <div className={sessionHistoryActionsClass}>
                {tabVisible ? <span className={activeTabPillClass}>Active tab</span> : (
                  <button className={secondaryComposerButtonClass} type="button" data-testid="restore-session-tab-button" onClick={() => onRestore(session)} disabled={busy}>
                    Restore tab
                  </button>
                )}
                <button className={dangerComposerButtonClass} type="button" data-testid="delete-session-button" onClick={() => onDelete(session)} disabled={busy}>
                  Delete
                </button>
              </div>
            </div>
          );
        })}
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
  '& p': { margin: 0, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.14em', fontSize: '11px', fontWeight: 700 },
  '& h2': { margin: '6px 0', fontSize: '30px', letterSpacing: '-0.04em' },
  '& span': { color: 'var(--text-3)', fontSize: '12px' },
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
  '& strong': { display: 'block', fontSize: '14px' },
  '& span': { display: 'block', marginTop: '4px', color: 'var(--text-3)', fontSize: '12px' },
  '& small': { display: 'block', marginTop: '3px', color: 'var(--text-3)', fontSize: '11px', maxWidth: '540px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
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
  color: 'var(--text-3)',
});

const activeTabPillClass = css({
  height: '28px',
  padding: '0 10px',
  border: '1px solid var(--line)',
  borderRadius: '999px',
  display: 'inline-flex !important',
  alignItems: 'center',
  color: 'var(--text-2) !important',
  fontSize: '11px !important',
});
