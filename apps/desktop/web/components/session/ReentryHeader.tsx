import { Sparkle, Warning, X } from '@phosphor-icons/react';

import { css, cx } from '../../styled-system/css';
import { activeReentrySummary, activityForSession } from '../../domain';
import type { ActivityState, ShellSession } from '../../domain';
import { dismissSessionReentry as persistDismiss } from '../../services/shellApi';
import { useShellStore } from '../../store';
import { Typography } from '../primitives/Typography';

// The re-entry catch-up notice: a small amber card that floats over the terminal,
// centered just below the session tabs, when you return to a session that finished
// a turn while you were away. It is a glance, not a document, the full detail is in
// the terminal right beneath it. A catch-up artifact, not a live status bar: the
// backend generates it once when the session comes to rest unseen, and it hides
// when you re-engage (the agent starts working) or you close it. See reverie-core's
// ReentrySummary and apps/.../reentry_summary.rs.
interface ReentryHeaderProps {
  session: ShellSession;
  cortexActivity: Record<string, ActivityState>;
}

// Suppressed whenever the agent is actively working or blocking on the user (a
// working agent invalidates the catch-up; a permission gate has its own banner).
function isBusy(activity: ActivityState | null): boolean {
  if (!activity) return false;
  if (activity.status === 'working') return true;
  if (activity.status === 'awaiting_permission' || activity.status === 'awaiting_response')
    return true;
  return Boolean(activity.lastError && !activity.lastError.recoverable);
}

function clean(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function ReentryHeader({ session, cortexActivity }: ReentryHeaderProps) {
  const dismissInStore = useShellStore(s => s.dismissSessionReentry);
  const activity = activityForSession(session, cortexActivity);
  const summary = activeReentrySummary(session);

  if (!summary || isBusy(activity)) return null;

  const goal = clean(summary.fields.currentGoal);
  const news = clean(summary.fields.whatChanged);
  const pending = clean(summary.fields.pendingDecision);
  const leftOff =
    summary.fields.whereWeLeftOff
      ?.map(entry => entry.trim())
      .filter(Boolean)
      .join('  ·  ') || null;

  // Adaptive two-tier hierarchy: lead with the most actionable / newest thing,
  // anchor it with context beneath. The pending decision (the agent waiting on
  // you) wins; otherwise the news (what changed); otherwise the goal itself.
  const waiting = Boolean(pending);
  const headline = pending ?? news ?? goal ?? leftOff;
  if (!headline) return null;
  const supporting = headline === goal ? (news ?? leftOff) : goal;

  const dismiss = () => {
    dismissInStore(session.id); // instant, optimistic
    void persistDismiss(session.id).catch(() => {
      // The browser harness has no backend; the optimistic dismiss still holds.
    });
  };

  return (
    <section
      className={cx(
        containerBaseClass,
        waiting ? containerWaitingToneClass : containerRestToneClass,
      )}
      role="status"
      data-testid="reentry-header"
    >
      <span className={iconClass} aria-hidden="true">
        {waiting ? <Warning size={16} weight="fill" /> : <Sparkle size={15} weight="fill" />}
      </span>

      <div className={bodyClass}>
        {waiting ? (
          <Typography
            as="span"
            variant="tiny"
            tone="warn"
            uppercase
            className={eyebrowClass}
            style={{ letterSpacing: '0.07em' }}
          >
            Waiting on you
          </Typography>
        ) : null}
        <Typography
          as="p"
          variant="smallBody"
          tone="default"
          className={headlineClass}
          data-testid="reentry-headline"
        >
          {headline}
        </Typography>
        {supporting ? (
          <Typography
            as="p"
            variant="caption"
            tone="muted"
            className={supportingClass}
            data-testid="reentry-supporting"
          >
            {supporting}
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
        <X size={12} weight="bold" />
      </button>
    </section>
  );
}

// A floating, centered, narrow card, an object hovering over the terminal rather
// than another full-width toolbar row. The left accent bar + warm tint mark it as
// an attention surface; the elevation shadow lifts it off the canvas. The tone
// classes layer the amber on top (composed via cx so Panda extracts each).
const containerBaseClass = css({
  position: 'absolute',
  top: 'calc(var(--reverie-shell-pad) + 54px)',
  left: '50%',
  transform: 'translateX(-50%)',
  width: 'min(540px, calc(100% - 48px))',
  // Above the terminal canvas (zIndex 2), the edge fades (3), and the jump button
  // (4); level with the tab band (5) since the two never overlap spatially.
  zIndex: 5,
  display: 'flex',
  alignItems: 'flex-start',
  gap: '10px',
  padding: '9px 11px 10px 13px',
  borderRadius: '12px',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderLeftWidth: '3px',
  boxShadow: '0 12px 32px color-mix(in srgb, black 38%, transparent)',
  backdropFilter: 'blur(14px)',
});

const containerRestToneClass = css({
  background: 'color-mix(in srgb, var(--warn) 11%, var(--surface-1))',
  borderColor: 'color-mix(in srgb, var(--warn) 26%, var(--line))',
  borderLeftColor: 'color-mix(in srgb, var(--warn) 70%, transparent)',
});

// The pending-decision variant leans into the amber: a touch more fill and a
// fully saturated accent bar, so "the agent is waiting on you" reads as the most
// urgent state the notice can show.
const containerWaitingToneClass = css({
  background: 'color-mix(in srgb, var(--warn) 15%, var(--surface-1))',
  borderColor: 'color-mix(in srgb, var(--warn) 38%, var(--line))',
  borderLeftColor: 'var(--warn)',
});

const iconClass = css({
  flexShrink: 0,
  display: 'inline-flex',
  marginTop: '1px',
  color: 'var(--warn)',
});

const bodyClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1px',
  minWidth: 0,
  flex: 1,
});

const eyebrowClass = css({
  marginBottom: '1px',
});

// The headline carries the weight of the notice: the ask, the news, or the goal.
// Clamp to two lines so a long line stays bounded; the full text is in the
// terminal directly below.
const headlineClass = css({
  margin: 0,
  lineClamp: 2,
  overflow: 'hidden',
});

// The anchoring context line: quieter, one line, ellipsized.
const supportingClass = css({
  margin: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const closeButtonClass = css({
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: '18px',
  height: '18px',
  marginTop: '1px',
  padding: 0,
  borderRadius: '6px',
  border: 'none',
  background: 'transparent',
  color: 'var(--text-3)',
  cursor: 'pointer',
  transition: 'background 120ms ease, color 120ms ease',
  '&:hover': {
    background: 'color-mix(in srgb, var(--warn) 18%, transparent)',
    color: 'var(--text)',
  },
});
