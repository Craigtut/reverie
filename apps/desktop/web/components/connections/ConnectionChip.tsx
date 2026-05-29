import { useEffect, useState } from 'react';

import { css } from '../../styled-system/css';
import { listSessionConnections } from '../../services/connectionsApi';
import { onConnectionStateChange } from '../../services/connectionsApi';
import type { Connection } from '../../domain';

/**
 * Persistent chip on a session card that shows how many open connections
 * the session participates in. Clicking it opens the connection panel for
 * that session.
 *
 * The chip is intentionally low-key: a small pill with a count. We do not
 * render peer names inside the chip itself to keep the card clean; the
 * panel surfaces full identity.
 */
export function ConnectionChip({
  sessionId,
  onOpenPanel,
}: {
  sessionId: string;
  onOpenPanel?: (sessionId: string) => void;
}) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await listSessionConnections(sessionId);
        if (!cancelled) setConnections(list);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    let stop: (() => void) | null = null;
    void onConnectionStateChange(() => {
      void load();
    }).then(fn => {
      if (cancelled) fn();
      else stop = fn;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [sessionId]);

  const openCount = connections.filter(c => c.status === 'open').length;
  if (openCount === 0) return null;
  if (error) return null;

  return (
    <button
      type="button"
      className={chipClass}
      onClick={event => {
        event.stopPropagation();
        onOpenPanel?.(sessionId);
      }}
      data-testid={`connection-chip-${sessionId}`}
      aria-label={`${openCount} open connection${openCount === 1 ? '' : 's'}`}
    >
      <span className={iconClass} aria-hidden>
        ↔
      </span>
      <span>{openCount}</span>
    </button>
  );
}

const chipClass = css({
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '2px 8px',
  borderRadius: '999px',
  background: 'var(--surface-hover, rgba(0,0,0,0.05))',
  border: '1px solid var(--line-faint)',
  color: 'var(--text-2)',
  fontSize: '11px',
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'background 120ms ease, color 120ms ease',
  '&:hover': {
    background: 'var(--surface-hover-strong, rgba(0,0,0,0.08))',
    color: 'var(--text)',
  },
});
const iconClass = css({ fontSize: '12px', lineHeight: 1 });
