import { X } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { activeReentrySummary, activityForSession } from '../../domain';
import type { ActivityState, ShellSession } from '../../domain';
import { dismissSessionReentry as persistDismiss } from '../../services/shellApi';
import { useShellStore } from '../../store';
import { Typography } from '../primitives/Typography';

// The re-entry ("where we left off") header: a small, dense, closable panel that
// appears just below the session tabs when you return to a session that finished
// a turn while you were away. It is a catch-up artifact, not a live status bar:
// the backend generates it once when the session comes to rest unseen, and it
// hides again the moment you re-engage (the agent starts working) or you close
// it. See reverie-core's ReentrySummary and apps/.../reentry_summary.rs.
interface ReentryHeaderProps {
  session: ShellSession;
  cortexActivity: Record<string, ActivityState>;
}

// The header is a rest-state catch-up aid, so it is suppressed whenever the agent
// is actively working or blocking on the user (a working agent invalidates the
// "where we left off" note, and a permission gate has its own banner).
function isBusy(activity: ActivityState | null): boolean {
  if (!activity) return false;
  if (activity.status === 'working') return true;
  if (activity.status === 'awaiting_permission' || activity.status === 'awaiting_response')
    return true;
  return Boolean(activity.lastError && !activity.lastError.recoverable);
}

export function ReentryHeader({ session, cortexActivity }: ReentryHeaderProps) {
  const dismissInStore = useShellStore(s => s.dismissSessionReentry);
  const activity = activityForSession(session, cortexActivity);
  // Shown only while the summary still describes the current rest and is not
  // dismissed (activeReentrySummary), and the agent is not busy again (a working
  // agent invalidates the note; a permission gate has its own banner).
  const summary = activeReentrySummary(session);

  if (!summary || isBusy(activity)) return null;
  const { currentGoal, whereWeLeftOff, whatChanged, pendingDecision } = summary.fields;

  const dismiss = () => {
    dismissInStore(session.id); // instant, optimistic
    void persistDismiss(session.id).catch(() => {
      // The browser harness has no backend; the optimistic dismiss still holds.
    });
  };

  return (
    <section className={containerClass} role="status" data-testid="reentry-header">
      <div className={bodyClass}>
        <div className={headRowClass}>
          <Typography
            as="span"
            variant="tiny"
            tone="faint"
            uppercase
            className={eyebrowClass}
            style={{ letterSpacing: '0.08em' }}
          >
            Where you left off
          </Typography>
          <Typography as="span" variant="caption" tone="default" truncate className={goalClass}>
            {currentGoal}
          </Typography>
        </div>

        {whereWeLeftOff && whereWeLeftOff.length > 0 ? (
          <Typography
            as="p"
            variant="caption"
            tone="muted"
            data-testid="reentry-left-off"
            className={lineClass}
          >
            {whereWeLeftOff.join(' · ')}
          </Typography>
        ) : null}

        {whatChanged ? (
          <Typography as="p" variant="caption" tone="muted" className={lineClass}>
            <span className={tagClass}>New</span>
            {whatChanged}
          </Typography>
        ) : null}

        {pendingDecision ? (
          <Typography
            as="p"
            variant="caption"
            tone="warn"
            data-testid="reentry-pending"
            className={lineClass}
          >
            <span className={tagClass}>Waiting on you</span>
            {pendingDecision}
          </Typography>
        ) : null}
      </div>

      <button
        type="button"
        className={closeButtonClass}
        onClick={dismiss}
        aria-label="Dismiss"
        data-testid="reentry-dismiss"
      >
        <X size={13} weight="bold" />
      </button>
    </section>
  );
}

const containerClass = css({
  // Floats over the terminal, just below the floating tab band, mirroring how
  // SessionTabsBar overlays the stage. The terminal viewport runs full height
  // under it (the band/header are chrome on top), so this is positioned rather
  // than in flow, or the band would paint over it at the top of the stage.
  position: 'absolute',
  // The tab band sits at top: var(--reverie-shell-pad) and is ~54px tall; clear
  // it with a small gap so the header reads as sitting just beneath the tabs.
  top: 'calc(var(--reverie-shell-pad) + 56px)',
  left: 'var(--reverie-shell-pad)',
  right: 'var(--reverie-shell-pad)',
  // Above the terminal canvas (zIndex 2), the edge fades (3), and the jump button
  // (4); level with the tab band (5) since the two never overlap spatially.
  zIndex: 5,
  display: 'flex',
  alignItems: 'flex-start',
  gap: '10px',
  padding: '8px 10px 8px 12px',
  borderRadius: '10px',
  // Near-opaque over the dark terminal so the catch-up text reads cleanly, with
  // the same elevation shadow the tab pills use so it floats above the canvas.
  background: 'color-mix(in srgb, var(--surface-1) 92%, transparent)',
  border: '1px solid var(--line)',
  boxShadow: 'var(--shadow)',
  backdropFilter: 'blur(8px)',
});

const bodyClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '3px',
  minWidth: 0,
  flex: 1,
});

const headRowClass = css({
  display: 'flex',
  alignItems: 'baseline',
  gap: '8px',
  minWidth: 0,
});

const eyebrowClass = css({
  flexShrink: 0,
});

const goalClass = css({
  minWidth: 0,
});

const lineClass = css({
  margin: 0,
  display: 'flex',
  alignItems: 'baseline',
  gap: '6px',
  lineHeight: 1.35,
});

const tagClass = css({
  flexShrink: 0,
  fontSize: '9px',
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  opacity: 0.7,
});

const closeButtonClass = css({
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: '20px',
  height: '20px',
  padding: 0,
  borderRadius: '6px',
  border: 'none',
  background: 'transparent',
  color: 'var(--text-3)',
  cursor: 'pointer',
  transition: 'background 120ms ease, color 120ms ease',
  '&:hover': {
    background: 'var(--surface-hover)',
    color: 'var(--text)',
  },
});
