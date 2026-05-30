import { Plus, ShieldWarning } from '@phosphor-icons/react';
import { css } from '../../styled-system/css';
import { agentTabLabel, cellStateFor } from '../../domain';
import type { ShellSession } from '../../domain';
import { TERMINAL_TAB_DROP_ZONE } from '../../hooks';
import { AgentGlyph, CloseGlyph, StateCell } from '../glyphs';
import { Typography } from '../primitives/Typography';

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
  // Locks the auto-approve chip while the selected session's agent is thinking:
  // toggling resumes the session, which would interrupt it.
  dangerousToggleLocked: boolean;
  // The session whose tab the cursor is hovering during a file drag, so it
  // lights up as a "file this here" target. Null when no drag is over a tab.
  dropTargetSessionId?: string | null;
  // Full-history toggle, relocated here from the (removed) terminal meta strip so
  // the top-right reads as a single row of session actions. Jumping back to the
  // live tail is handled by the floating control in TerminalSurface instead.
  historyViewing: boolean;
  onSelectSession: (session: ShellSession) => void;
  onCloseSession: (event: { stopPropagation: () => void }, session: ShellSession) => void;
  onCreateSession: () => void;
  onToggleDangerousMode: () => void;
  onViewFullHistory: () => void;
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
  dangerousToggleLocked,
  dropTargetSessionId,
  historyViewing,
  onSelectSession,
  onCloseSession,
  onCreateSession,
  onToggleDangerousMode,
  onViewFullHistory,
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
            data-drop-zone={TERMINAL_TAB_DROP_ZONE}
            data-drop-id={session.id}
            data-session-id={session.id}
            data-active={session.id === selectedSessionId ? 'true' : 'false'}
            data-drop-armed={session.id === dropTargetSessionId ? 'true' : 'false'}
            onClick={() => onSelectSession(session)}
          >
            <AgentGlyph kind={session.agentKind} />
            <Typography as="span" variant="caption" tone="inherit">
              {agentTabLabel(session)}
            </Typography>
            {/* Trailing slot: the live state dot at rest crossfades to a large
                square close target on hover (mirrors the left-nav row pattern),
                so the tab never shows both a status and a persistent X. */}
            <span className={tabTrailingClass}>
              <span className={tabCellWrapClass} data-tab-meta="true" aria-hidden="true">
                <StateCell
                  state={cellStateFor(
                    session,
                    session.status === 'running' || session.id === runningSessionId,
                    null,
                  )}
                  size={12}
                />
              </span>
              <span
                className={tabCloseClass}
                role="button"
                tabIndex={0}
                data-testid="close-session-tab-button"
                data-tab-action="true"
                aria-label={`Close ${session.title} tab`}
                onClick={event => void onCloseSession(event, session)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ')
                    void onCloseSession(event, session);
                }}
              >
                <CloseGlyph size={12} />
              </span>
            </span>
          </button>
        ))}
        {visibleSessions.length === 0 ? (
          <Typography
            as="div"
            variant="caption"
            tone="faint"
            className={emptyTabsHintClass}
            data-testid="empty-session-tabs"
          >
            No sessions in this focus
          </Typography>
        ) : null}
        <span className={tabDividerClass} />
        <button
          className={newTabClass}
          type="button"
          data-testid="create-session-button"
          disabled={busy || !canUseAppServices || !canCreateSession}
          onClick={onCreateSession}
          title="New session"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className={topControlsClass} data-testid="terminal-controls">
        {hasSelectedSession && !historyViewing ? (
          <button
            type="button"
            className={followLiveButtonClass}
            data-testid="view-history-button"
            onClick={onViewFullHistory}
            title="Scroll the whole session, back to the beginning"
          >
            <Typography as="span" variant="tiny" tone="inherit">
              Full history
            </Typography>
          </button>
        ) : null}
        <button
          type="button"
          className={autoApproveChipClass({ warn: effectiveDangerousMode })}
          data-testid="auto-approve-chip"
          aria-pressed={effectiveDangerousMode}
          disabled={!hasSelectedSession || busy || dangerousToggleLocked}
          title={
            dangerousToggleLocked
              ? "Auto-approve can't change while the agent is working. Wait until it's idle."
              : hasTerminalBinding
                ? `Click to restart this session with auto-approve ${effectiveDangerousMode ? 'off' : 'on'}.`
                : `Click to set auto-approve ${effectiveDangerousMode ? 'off' : 'on'} for the next launch.`
          }
          onClick={onToggleDangerousMode}
        >
          <ShieldWarning size={14} />
          <Typography as="span" variant="caption" tone="inherit">
            {effectiveDangerousMode ? 'Auto-approve · on' : 'Auto-approve · off'}
          </Typography>
        </button>
      </div>
    </div>
  );
}

const topBandClass = css({
  // Lifted above the frame glow (which sits at zIndex 1 in the canvas-stage
  // context): the tabs + top actions stay crisp on top of the glow.
  position: 'relative',
  zIndex: 2,
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
    transition: 'background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease',
    // Hover (or keyboard focus within) crossfades the trailing slot: the state
    // dot fades out, the square close target fades in, in place.
    _hover: {
      color: 'var(--text)',
      '& [data-tab-action]': { opacity: 1, pointerEvents: 'auto' },
      '& [data-tab-meta]': { opacity: 0 },
      // As the close X is revealed, its two strokes swing into the cross: the
      // lead diagonal lands first, the trail follows a beat later (see main.css).
      '& [data-x-line="lead"]': {
        animation: 'reverieCloseLead 200ms cubic-bezier(0.34, 1.45, 0.5, 1) backwards',
      },
      '& [data-x-line="trail"]': {
        animation: 'reverieCloseTrail 200ms cubic-bezier(0.34, 1.45, 0.5, 1) 170ms backwards',
      },
    },
    '&:has(:focus-visible)': {
      '& [data-tab-action]': { opacity: 1, pointerEvents: 'auto' },
      '& [data-tab-meta]': { opacity: 0 },
    },
    // File-drop target: a dragged file hovering this tab lights it as a "file
    // this into that session" target, lifting it with a --good-tinted ring.
    '&[data-drop-armed="true"]': {
      color: 'var(--text)',
      background: 'color-mix(in srgb, var(--good) 16%, var(--surface-3))',
      boxShadow:
        '0 0 0 1px color-mix(in srgb, var(--good) 60%, transparent), 0 4px 14px rgba(0,0,0,0.35)',
    },
    '& > span:nth-child(2)': { overflow: 'hidden', textOverflow: 'ellipsis' },
  });
}

// The trailing slot: a fixed square that holds the resting state dot and the
// hover close target stacked on the same center, so they crossfade without
// shifting layout. Square + ~most of the tab height (28px) for a generous,
// easy-to-hit close target.
const tabTrailingClass = css({
  position: 'relative',
  flexShrink: 0,
  width: '24px',
  height: '24px',
  marginLeft: '1px',
  display: 'grid',
  placeItems: 'center',
});

const tabCellWrapClass = css({
  display: 'grid',
  placeItems: 'center',
  transition: 'opacity 120ms ease',
});

const tabCloseClass = css({
  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  borderRadius: '6px',
  color: 'var(--text-2)',
  background: 'transparent',
  cursor: 'pointer',
  opacity: 0,
  pointerEvents: 'none',
  transition: 'opacity 120ms ease, color 120ms ease, background 120ms ease',
  _hover: { color: 'var(--text)', background: 'var(--surface-hi)' },
});

const emptyTabsHintClass = css({
  padding: '0 8px',
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

const followLiveButtonClass = css({
  color: 'var(--text-2)',
  border: '1px solid var(--line)',
  background: 'transparent',
  borderRadius: '999px',
  padding: '4px 11px',
  cursor: 'pointer',
  flexShrink: 0,
  transition: 'color 140ms ease, border-color 140ms ease',
  _hover: { color: 'var(--text)', borderColor: 'var(--line-strong)' },
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
    whiteSpace: 'nowrap',
  });
}
