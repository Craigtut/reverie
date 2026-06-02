import { Play } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { agentLabel, agentTabLabel, launchButtonLabel } from '../../domain';
import type { ShellSession } from '../../domain';
import { DotField } from '../chrome';
import { Typography } from '../primitives/Typography';

// Covers the terminal surface for a selected-but-not-running session: an idle
// state with a launch/resume button, and a launching state with the breathing
// dot field. Returns null when no session is selected.
export function SessionLaunchOverlay({
  session,
  launching,
  disabled,
  onLaunch,
}: {
  session: ShellSession | null;
  launching: boolean;
  disabled: boolean;
  onLaunch: () => void;
}) {
  if (!session) return null;

  if (launching) {
    return (
      <div
        className={launchOverlayClass}
        data-testid="session-launch-overlay"
        data-state="launching"
      >
        <div className={launchCardClass} data-state="launching">
          <div className={launchFieldClass}>
            <DotField variant="launching" />
          </div>
          <Typography
            as="span"
            variant="caption"
            tone="muted"
            uppercase
            className={launchingLabelClass}
            data-testid="session-launching-label"
            style={{ letterSpacing: '0.08em' }}
          >
            Launching {agentLabel(session.agentKind)}
          </Typography>
          <Typography
            as="span"
            variant="caption"
            tone="faint"
            selectable
            className={launchCardMetaClass}
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              lineHeight: 1.5,
            }}
          >
            {session.cwd}
          </Typography>
        </div>
      </div>
    );
  }

  const label = launchButtonLabel(session);
  return (
    <div className={launchOverlayClass} data-testid="session-launch-overlay" data-state="idle">
      <div className={launchCardClass} data-state="idle">
        <Typography as="span" variant="smallBody" tone="default">
          {agentTabLabel(session)}
        </Typography>
        <Typography
          as="span"
          variant="caption"
          tone="faint"
          selectable
          className={launchCardMetaClass}
          style={{
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            lineHeight: 1.5,
          }}
        >
          {agentLabel(session.agentKind)} · {session.cwd}
        </Typography>
        <button
          type="button"
          className={primaryLaunchButtonClass}
          data-testid="session-launch-button"
          disabled={disabled}
          onClick={onLaunch}
        >
          <Play size={13} weight="fill" />
          <Typography
            as="span"
            variant="caption"
            tone="inherit"
            style={{ letterSpacing: '0.01em' }}
          >
            {label}
          </Typography>
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

const launchCardMetaClass = css({
  wordBreak: 'break-all',
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
});
