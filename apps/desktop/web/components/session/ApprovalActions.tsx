import { useState, type MouseEvent } from 'react';
import { Check, X } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { supportsInlineApproval } from '../../domain';
import type { ActivityPermissionRequest } from '../../domain';
import { resolvePermission } from '../../services/shellApi';
import { Typography } from '../primitives/Typography';

type Phase = 'idle' | 'submitting' | 'stale';

// Approve / Deny for a tool-permission request, answered from a native card or
// the in-session banner instead of the CLI's own TUI prompt. The decision routes
// through `resolve_permission` to the blocked hook (Claude / Codex) or the Cortex
// decision file. On success the agent proceeds and the activity feed drops the
// request, so this control simply disappears with the card; on a CLI that can't
// answer externally, or once the answer window has passed (`delivered === false`),
// it degrades to the "respond in the terminal" signpost. Deny-safe throughout.
export function ApprovalActions({
  sessionId,
  permission,
  agentKind,
}: {
  sessionId: string;
  permission: ActivityPermissionRequest;
  agentKind: string;
}) {
  const [phase, setPhase] = useState<Phase>('idle');

  // Tier-2 CLI (detect-only): never offer buttons we can't honor.
  if (!supportsInlineApproval(agentKind)) {
    return <SignpostHint />;
  }

  const decide = async (event: MouseEvent, decision: 'allow' | 'deny') => {
    // These buttons sit inside a clickable card / banner; a click here must not
    // also open the session.
    event.stopPropagation();
    if (phase === 'submitting') return;
    setPhase('submitting');
    try {
      const delivered = await resolvePermission(sessionId, permission.id, decision);
      // When delivered, the agent proceeds and the next activity update removes
      // the request (and this control). When not, the answer window has passed,
      // so fall back to the signpost.
      setPhase(delivered ? 'idle' : 'stale');
    } catch {
      setPhase('stale');
    }
  };

  if (phase === 'stale') {
    return <SignpostHint />;
  }

  const busy = phase === 'submitting';
  return (
    <div className={actionsRowClass} data-testid="approval-actions">
      <button
        type="button"
        className={denyButtonClass}
        disabled={busy}
        onClick={event => decide(event, 'deny')}
        data-testid="approval-deny"
      >
        <X size={13} weight="bold" />
        <Typography as="span" variant="caption" tone="inherit">
          Deny
        </Typography>
      </button>
      <button
        type="button"
        className={approveButtonClass}
        disabled={busy}
        onClick={event => decide(event, 'allow')}
        data-testid="approval-approve"
      >
        <Check size={13} weight="bold" />
        <Typography as="span" variant="caption" tone="inherit">
          {busy ? 'Sending…' : 'Approve'}
        </Typography>
      </button>
    </div>
  );
}

function SignpostHint() {
  return (
    <Typography
      as="span"
      variant="tiny"
      tone="warn"
      uppercase
      style={{ letterSpacing: '0.08em' }}
      data-testid="approval-signpost"
    >
      Respond in the terminal
    </Typography>
  );
}

const actionsRowClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
});

const denyButtonClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  height: '26px',
  padding: '0 11px',
  borderRadius: '7px',
  border: '1px solid var(--line-strong)',
  cursor: 'pointer',
  transition: 'background 140ms ease, border-color 140ms ease, opacity 140ms ease',
  background: 'var(--surface-2)',
  color: 'var(--text-2)',
  _hover: {
    background: 'var(--surface-hi)',
    color: 'var(--text)',
  },
  _disabled: { opacity: 0.6, cursor: 'default' },
});

// Approve carries the only color: the status green, matching the monochrome +
// status-color palette. Deny stays neutral so the affirmative action reads first.
const approveButtonClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  height: '26px',
  padding: '0 11px',
  borderRadius: '7px',
  border: '1px solid color-mix(in srgb, var(--good) 40%, var(--line) 60%)',
  cursor: 'pointer',
  transition: 'background 140ms ease, border-color 140ms ease, opacity 140ms ease',
  background: 'color-mix(in srgb, var(--good) 16%, transparent)',
  color: 'var(--text)',
  _hover: { background: 'color-mix(in srgb, var(--good) 26%, transparent)' },
  _disabled: { opacity: 0.6, cursor: 'default' },
});
