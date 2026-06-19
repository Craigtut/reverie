import { Play } from '@phosphor-icons/react';
import { motion } from 'motion/react';

import { css } from '../../styled-system/css';
import { agentLabel, agentTabLabel, launchButtonLabel } from '../../domain';
import type { ShellSession } from '../../domain';
import { CrtLoadingCanvas } from '../../crtLoading';
import { Typography } from '../primitives/Typography';

// The "coming back to life" overlay for a session that is waking: a full-cover
// breathing CRT canvas with the action word + title drawn inside it (so the
// warp/bloom apply to the text too). Mount/unmount and the fade in/out are owned
// by the parent's <AnimatePresence>; this only declares its enter/exit, so there
// is no setTimeout / onTransitionEnd bookkeeping that a StrictMode double-invoke
// can strand (which is what kept it stuck at opacity 0, blanking the canvas).
// `resuming` picks the verb and is frozen by the parent at the instant the wake
// begins (Claude gains its native session ref mid-launch, which would otherwise
// flip "Starting" to "Resuming" on the user).
export function SessionResumeOverlay({
  session,
  resuming,
}: {
  session: ShellSession;
  resuming: boolean;
}) {
  const actionLabel = resuming ? 'Resuming' : 'Starting';
  const title = session.title?.trim() || agentTabLabel(session);
  return (
    <motion.div
      className={resumeOverlayClass}
      data-testid="session-launch-overlay"
      data-state="launching"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      // A touch slower on the way out so the handoff to the live terminal stays calm.
      exit={{ opacity: 0, transition: { duration: 0.6, ease: 'easeOut' } }}
      transition={{ duration: 0.45, ease: 'easeOut' }}
    >
      <CrtLoadingCanvas variant="resume" label={actionLabel} sublabel={title} />
      <div className={resumeCopySrOnlyClass}>
        <Typography as="span" variant="title2" tone="default" data-testid="session-launching-label">
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
    </motion.div>
  );
}

// The idle launch/resume card for a selected-but-not-running session: the Run /
// Resume button with the agent + working directory. Shown only when nothing is
// waking and the boot is not covering the screen (the parent decides).
export function SessionIdleLaunchCard({
  session,
  disabled,
  onLaunch,
}: {
  session: ShellSession;
  disabled: boolean;
  onLaunch: () => void;
}) {
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

// The visible label/title are drawn inside the resume canvas (so the warp/bloom
// apply); the DOM copy is hidden for screen readers + tests only.
const resumeCopySrOnlyClass = css({
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
});

const resumeTitleClass = css({
  maxWidth: '420px',
  overflowWrap: 'anywhere',
});
