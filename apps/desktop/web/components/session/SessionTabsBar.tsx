import { Plus, ShieldWarning, X } from '@phosphor-icons/react';
import { css } from '../../styled-system/css';
import { agentTabLabel } from '../../domain';
import type { ShellSession } from '../../domain';
import { AgentGlyph } from '../glyphs';

export interface SessionTabsBarProps {
  visibleSessions: ShellSession[];
  selectedSessionId: string | null;
  runningSessionId: string | null;
  busy: boolean;
  canUseAppServices: boolean;
  canCreateSession: boolean;
  hasSelectedSession: boolean;
  hasTerminalBinding: boolean;
  effectiveDangerousMode: boolean;
  onSelectSession: (session: ShellSession) => void;
  onCloseSession: (event: { stopPropagation: () => void }, session: ShellSession) => void;
  onCreateSession: () => void;
  onToggleDangerousMode: () => void;
}

// The band above the terminal: the session tabs for the active focus plus the
// auto-approve toggle. Presentational; the shell owns selection and lifecycle.
export function SessionTabsBar({
  visibleSessions,
  selectedSessionId,
  runningSessionId,
  busy,
  canUseAppServices,
  canCreateSession,
  hasSelectedSession,
  hasTerminalBinding,
  effectiveDangerousMode,
  onSelectSession,
  onCloseSession,
  onCreateSession,
  onToggleDangerousMode,
}: SessionTabsBarProps) {
  return (
    <div className={topBandClass}>
      <div className={tabsClass} data-testid="session-tabs">
        {visibleSessions.map(session => (
          <button
            key={session.id}
            className={tabClass({ active: session.id === selectedSessionId })}
            type="button"
            data-testid="session-tab"
            data-session-id={session.id}
            data-active={session.id === selectedSessionId ? 'true' : 'false'}
            onClick={() => onSelectSession(session)}
          >
            <AgentGlyph kind={session.agentKind} />
            <span>{agentTabLabel(session)}</span>
            {session.status === 'running' || session.id === runningSessionId ? <i className={runningDotClass} /> : null}
            <span
              className={tabCloseClass}
              role="button"
              tabIndex={0}
              data-testid="close-session-tab-button"
              aria-label={`Close ${session.title} tab`}
              onClick={event => void onCloseSession(event, session)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') void onCloseSession(event, session);
              }}
            >
              <X size={12} />
            </span>
          </button>
        ))}
        {visibleSessions.length === 0 ? (
          <div className={emptyTabsHintClass} data-testid="empty-session-tabs">No sessions in this focus</div>
        ) : null}
        <span className={tabDividerClass} />
        <button className={newTabClass} type="button" data-testid="create-session-button" disabled={busy || !canUseAppServices || !canCreateSession} onClick={onCreateSession} title="New session">
          <Plus size={14} />
        </button>
      </div>

      <div className={topControlsClass} data-testid="terminal-controls">
        <button
          type="button"
          className={autoApproveChipClass({ warn: effectiveDangerousMode })}
          data-testid="auto-approve-chip"
          aria-pressed={effectiveDangerousMode}
          disabled={!hasSelectedSession || busy}
          title={
            hasTerminalBinding
              ? `Click to restart this session with auto-approve ${effectiveDangerousMode ? 'off' : 'on'}.`
              : `Click to set auto-approve ${effectiveDangerousMode ? 'off' : 'on'} for the next launch.`
          }
          onClick={onToggleDangerousMode}
        >
          <ShieldWarning size={14} />
          {effectiveDangerousMode ? 'Auto-approve · on' : 'Auto-approve · off'}
        </button>
      </div>
    </div>
  );
}

const topBandClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '16px',
  padding: '4px 4px 12px',
  flexShrink: 0,
});

const tabsClass = css({
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0',
  overflowX: 'auto',
  padding: '4px',
  borderRadius: '12px',
  border: '1px solid var(--line)',
  background: 'var(--surface-1)',
  boxShadow: 'var(--shadow)',
});

function tabClass({ active }: { active: boolean }) {
  return css({
    height: '28px',
    minWidth: 'auto',
    maxWidth: '174px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '7px',
    padding: '0 11px',
    borderRadius: '8px',
    color: active ? 'var(--text)' : 'var(--text-2)',
    background: active ? 'var(--surface-3)' : 'transparent',
    border: '0',
    boxShadow: active ? 'inset 0 1px 0 rgba(255,255,255,0.035)' : 'none',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    fontSize: '12px',
    fontWeight: 500,
    transition: 'background 0.15s ease, color 0.15s ease',
    _hover: { color: 'var(--text)' },
    '& > span:nth-child(2)': { overflow: 'hidden', textOverflow: 'ellipsis' },
  });
}

const runningDotClass = css({
  width: '5px',
  height: '5px',
  borderRadius: '50%',
  background: 'var(--good)',
  boxShadow: '0 0 0 3px rgba(111,184,122,0.14)',
  marginLeft: '2px',
});

const tabCloseClass = css({
  opacity: 0.45,
  flexShrink: 0,
  width: '14px',
  height: '14px',
  padding: '1px',
  borderRadius: '3px',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  _hover: { opacity: 1, background: 'var(--surface-hi)' },
});

const emptyTabsHintClass = css({
  color: 'var(--text-3)',
  padding: '0 8px',
  fontSize: '12px',
});

const tabDividerClass = css({
  width: '1px',
  height: '18px',
  background: 'var(--line)',
  margin: '0 2px',
  flexShrink: 0,
});

const newTabClass = css({
  width: '26px',
  height: '26px',
  display: 'grid',
  placeItems: 'center',
  borderRadius: '8px',
  border: '0',
  color: 'var(--text-3)',
  background: 'transparent',
  cursor: 'pointer',
  _hover: { background: 'var(--surface-3)', color: 'var(--text)' },
  _disabled: { opacity: 0.45, cursor: 'not-allowed' },
});

const topControlsClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '10px',
  flexShrink: 0,
});

function autoApproveChipClass({ warn }: { warn: boolean }) {
  return css({
    height: '28px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '0 10px 0 8px',
    borderRadius: '999px',
    border: `1px solid ${warn ? 'color-mix(in srgb, var(--warn) 38%, transparent)' : 'var(--line)'}`,
    color: warn ? 'var(--warn)' : 'var(--text-2)',
    background: 'var(--surface-1)',
    boxShadow: 'var(--shadow)',
    fontSize: '11.5px',
    fontWeight: 500,
    whiteSpace: 'nowrap',
  });
}
