import { Play } from '@phosphor-icons/react';
import { useRef } from 'react';

import { css } from '../../styled-system/css';
import { agentLabel, agentTabLabel, isResumeLaunch, launchButtonLabel } from '../../domain';
import type { ShellSession } from '../../domain';
import { ResumeBloom } from '../chrome';
import { Typography } from '../primitives/Typography';

// Covers the terminal surface for a selected-but-not-running session: an idle
// state with a launch/resume button, and a launching state where the session
// "comes back to life" as a radial dot bloom on the bare terminal surface, with
// the action word and the session title sitting directly on the background.
// Returns null when no session is selected.
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
  // Freeze whether this launch is a resume at the instant launching begins.
  // Claude captures its native session id via hooks within the launch window, so
  // a fresh session gains a nativeSessionRef mid-launch; reading it live would
  // flip "Starting" to "Resuming" on the user. Snapshot the pre-launch session
  // on the rising edge and hold it until launching ends.
  const wasLaunching = useRef(false);
  const resumeAtLaunchStart = useRef(false);
  if (launching && !wasLaunching.current) {
    resumeAtLaunchStart.current = session ? isResumeLaunch(session) : false;
  } else if (!launching) {
    resumeAtLaunchStart.current = false;
  }
  wasLaunching.current = launching;

  if (!session) return null;

  if (launching) {
    const actionLabel = resumeAtLaunchStart.current ? 'Resuming' : 'Starting';
    const title = session.title?.trim() || agentTabLabel(session);

    return (
      <div
        className={resumeOverlayClass}
        data-testid="session-launch-overlay"
        data-state="launching"
      >
        <ResumeBloom />
        <div className={resumeCopyClass}>
          <Typography
            as="span"
            variant="title2"
            tone="default"
            data-testid="session-launching-label"
          >
            {actionLabel}
          </Typography>
          <Typography
            as="span"
            variant="smallBody"
            tone="faint"
            className={resumeTitleClass}
            data-testid="session-launching-title"
          >
            {title}
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

// The resume moment lives directly on the terminal surface, not in a panel: a
// full-cover bloom canvas with the copy floating on the background below it.
const resumeOverlayClass = css({
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
  pointerEvents: 'none',
  zIndex: 5,
});

const resumeCopyClass = css({
  position: 'absolute',
  left: 0,
  right: 0,
  // Sit just below the bloom, which is lifted slightly above the surface center.
  top: 'calc(50% + 38px)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '7px',
  padding: '0 24px',
  textAlign: 'center',
  // Rise in a beat after the bloom sparks to life; reduced-motion flattens it.
  animation: 'reverieRiseIn 560ms cubic-bezier(0.16, 1, 0.3, 1) 220ms both',
});

const resumeTitleClass = css({
  maxWidth: '420px',
  overflowWrap: 'anywhere',
});
