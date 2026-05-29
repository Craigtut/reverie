import { Play } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { agentLabel, agentTabLabel, launchButtonLabel } from '../../domain';
import type { ShellSession } from '../../domain';
import { DotField } from '../chrome';

// Covers the terminal surface for a selected-but-not-running session: an idle
// state with a launch/resume button, and a launching state with the breathing
// dot field. Returns null when no session is selected.
export function SessionLaunchOverlay({ session, launching, disabled, onLaunch }: {
  session: ShellSession | null;
  launching: boolean;
  disabled: boolean;
  onLaunch: () => void;
}) {
  if (!session) return null;

  if (launching) {
    return (
      <div className={launchOverlayClass} data-testid="session-launch-overlay" data-state="launching">
        <div className={launchCardClass} data-state="launching">
          <div className={launchFieldClass}>
            <DotField variant="launching" />
          </div>
          <span className={launchingLabelClass} data-testid="session-launching-label">
            Launching {agentLabel(session.agentKind)}
          </span>
          <span className={launchCardMetaClass}>{session.cwd}</span>
        </div>
      </div>
    );
  }

  const label = launchButtonLabel(session);
  return (
    <div className={launchOverlayClass} data-testid="session-launch-overlay" data-state="idle">
      <div className={launchCardClass} data-state="idle">
        <span className={launchCardTitleClass}>{agentTabLabel(session)}</span>
        <span className={launchCardMetaClass}>
          {agentLabel(session.agentKind)} · {session.cwd}
        </span>
        <button
          type="button"
          className={primaryLaunchButtonClass}
          data-testid="session-launch-button"
          disabled={disabled}
          onClick={onLaunch}
        >
          <Play size={13} weight="fill" />
          {label}
        </button>
      </div>
    </div>
  );
}

const launchOverlayClass = css({
  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  pointerEvents: 'none',
  zIndex: 5,
  '& > *': { pointerEvents: 'auto' },
});

const launchCardClass = css({
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '14px',
  padding: '28px 32px 26px',
  borderRadius: '20px',
  background: 'color-mix(in srgb, var(--surface-1) 84%, transparent)',
  border: '1px solid var(--line)',
  boxShadow: '0 24px 70px -28px rgba(0,0,0,0.55)',
  minWidth: '320px',
  maxWidth: '420px',
  textAlign: 'center',
  backdropFilter: 'blur(10px)',
});

const launchCardTitleClass = css({
  fontSize: '14px',
  fontWeight: 500,
  color: 'var(--text)',
  letterSpacing: '-0.005em',
});

const launchCardMetaClass = css({
  fontSize: '11px',
  color: 'var(--text-3)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  wordBreak: 'break-all',
  lineHeight: 1.5,
});

const primaryLaunchButtonClass = css({
  marginTop: '6px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  padding: '9px 18px',
  borderRadius: '999px',
  background: 'var(--text)',
  color: 'var(--bg)',
  border: 0,
  cursor: 'pointer',
  fontWeight: 500,
  fontSize: '12.5px',
  letterSpacing: '0.01em',
  transition: 'transform 140ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms ease',
  '&:hover': { transform: 'translateY(-1px)' },
  '&:active': { transform: 'translateY(0)' },
  '&:disabled': { opacity: 0.5, cursor: 'not-allowed', transform: 'none' },
  '& svg': { color: 'var(--bg)' },
});

const launchFieldClass = css({
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  opacity: 0.85,
});

const launchingLabelClass = css({
  position: 'relative',
  zIndex: 1,
  fontSize: '11.5px',
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-2)',
});
