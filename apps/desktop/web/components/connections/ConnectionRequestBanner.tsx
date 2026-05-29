import { useEffect, useState } from 'react';

import { css } from '../../styled-system/css';
import { useConnectionRequests } from '../../hooks/useConnectionsState';
import { blockSessionPair, pairRecentlyDenied } from '../../services/connectionsApi';
import type { Connection } from '../../domain';
import { Typography } from '../primitives/Typography';

const REPEAT_BLOCK_SECONDS = 600;

/**
 * The accept/deny banner for outstanding inter-agent connection requests.
 *
 * Renders zero or more cards: one per pending request, ordered by sequence so
 * the user works through them top-down. Each card carries the requesting
 * agent's reason verbatim plus accept/deny actions. The banner sits at the
 * focus level (above the terminal pane in the active session view) and is
 * also rendered on the dashboard.
 *
 * State is driven by `useConnectionRequests`, which listens for
 * `connection_request_changed` events so the banner appears as soon as the
 * helper subprocess fires a `reverie.request_connection` call.
 */
export function ConnectionRequestBanner() {
  const { requests, accept, deny } = useConnectionRequests();
  if (requests.length === 0) return null;
  return (
    <div className={containerClass} data-testid="connection-request-banner">
      {requests.map(({ connection }) => (
        <RequestCard
          key={connection.id}
          connection={connection}
          onAccept={() => {
            const requestId = connection.pendingRequest?.requestId;
            if (!requestId) return;
            void accept(requestId);
          }}
          onDeny={reason => {
            const requestId = connection.pendingRequest?.requestId;
            if (!requestId) return;
            void deny(requestId, reason);
          }}
        />
      ))}
    </div>
  );
}

function RequestCard({
  connection,
  onAccept,
  onDeny,
}: {
  connection: Connection;
  onAccept: () => void;
  onDeny: (reason: string | null) => void;
}) {
  const initiator =
    connection.initiator.kind === 'agent' ? connection.initiator.sessionId : 'A teammate';
  const target =
    connection.initiator.kind === 'agent'
      ? connection.participantA === connection.initiator.sessionId
        ? connection.participantB
        : connection.participantA
      : connection.participantB;
  const [isRepeat, setIsRepeat] = useState(false);
  useEffect(() => {
    if (connection.initiator.kind !== 'agent') return;
    let cancelled = false;
    void pairRecentlyDenied(initiator, target)
      .then(value => {
        if (!cancelled) setIsRepeat(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initiator, target, connection.id, connection.initiator.kind]);

  return (
    <article
      className={cardClass}
      data-testid="connection-request-card"
      data-repeat={isRepeat ? 'on' : 'off'}
    >
      <header className={cardHeaderClass}>
        <Typography
          as="span"
          variant="tiny"
          tone="faint"
          uppercase
          style={{ letterSpacing: '0.12em' }}
        >
          {isRepeat ? 'Connection requested again' : 'Connection requested'}
        </Typography>
        {connection.topic ? (
          <Typography
            as="span"
            variant="caption"
            tone="muted"
            className={topicClass}
            style={{ fontStyle: 'italic' }}
          >
            {connection.topic}
          </Typography>
        ) : null}
      </header>
      <p className={routeClass}>
        <Typography
          as="code"
          variant="caption"
          tone="muted"
          className={sessionTagClass}
          title={initiator}
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {short(initiator)}
        </Typography>
        <Typography as="span" variant="caption" tone="inherit" aria-hidden>
          {' → '}
        </Typography>
        <Typography
          as="code"
          variant="caption"
          tone="muted"
          className={sessionTagClass}
          title={target}
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {short(target)}
        </Typography>
      </p>
      <Typography
        as="p"
        variant="smallBody"
        tone="default"
        className={reasonClass}
        style={{ lineHeight: '1.55', fontStyle: 'italic' }}
      >
        "{connection.reasonOpened}"
      </Typography>
      <footer className={footerClass}>
        {isRepeat ? (
          <button
            type="button"
            className={blockButtonClass}
            onClick={async () => {
              if (connection.initiator.kind !== 'agent') return;
              await blockSessionPair(initiator, target, REPEAT_BLOCK_SECONDS);
              onDeny('blocked after repeat request');
            }}
            data-testid="connection-block"
            title="Stop further requests from this source for 10 minutes"
          >
            <Typography as="span" variant="caption" tone="inherit">
              Block 10 min
            </Typography>
          </button>
        ) : null}
        <button
          type="button"
          className={denyButtonClass}
          onClick={() => onDeny(null)}
          data-testid="connection-deny"
        >
          <Typography as="span" variant="caption" tone="inherit">
            Deny
          </Typography>
        </button>
        <button
          type="button"
          className={allowButtonClass}
          onClick={onAccept}
          data-testid="connection-accept"
        >
          <Typography as="span" variant="caption" tone="inherit">
            Allow connection
          </Typography>
        </button>
      </footer>
    </article>
  );
}

function short(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

const containerClass = css({
  position: 'relative',
  zIndex: 6,
  display: 'grid',
  gap: '10px',
  padding: '12px 16px 0',
});
const cardClass = css({
  display: 'grid',
  gap: '12px',
  padding: '14px 16px',
  borderRadius: '14px',
  background: 'var(--surface-1, rgba(255,255,255,0.85))',
  border: '1px solid var(--line)',
  boxShadow: '0 6px 22px rgba(20, 18, 14, 0.12)',
  backdropFilter: 'blur(14px)',
});
const cardHeaderClass = css({
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '12px',
});
const topicClass = css({
  maxWidth: '50%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
const routeClass = css({
  margin: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
});
const sessionTagClass = css({
  padding: '2px 8px',
  borderRadius: '999px',
  background: 'var(--surface-hover, rgba(0,0,0,0.05))',
});
const reasonClass = css({
  margin: 0,
});
const footerClass = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '8px',
});
const denyButtonClass = css({
  appearance: 'none',
  border: '1px solid var(--line)',
  background: 'transparent',
  color: 'var(--text-2)',
  padding: '6px 14px',
  borderRadius: '999px',
  cursor: 'pointer',
  '&:hover': { background: 'var(--surface-hover, rgba(0,0,0,0.04))' },
});
const allowButtonClass = css({
  appearance: 'none',
  border: '1px solid var(--text)',
  background: 'var(--text)',
  color: 'var(--surface-0, white)',
  padding: '6px 14px',
  borderRadius: '999px',
  cursor: 'pointer',
});
const blockButtonClass = css({
  appearance: 'none',
  border: '1px solid currentColor',
  background: 'transparent',
  color: 'var(--status-warning, #b03f1f)',
  padding: '6px 14px',
  borderRadius: '999px',
  cursor: 'pointer',
  marginRight: 'auto',
});
