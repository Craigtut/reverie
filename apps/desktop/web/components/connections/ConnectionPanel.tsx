import { useCallback, useEffect, useMemo, useState } from 'react';
import { X } from '@phosphor-icons/react';

import { css, cx } from '../../styled-system/css';
import { scrollFadeClass } from '../../themes/scrollbars';
import { useScrollbarFade } from '../../hooks/useScrollbarFade';
import {
  closeConnection,
  fetchConnectionTranscript,
  listSessionConnections,
  onConnectionStateChange,
} from '../../services/connectionsApi';
import type { Connection, ConnectionMessage } from '../../domain';
import { Typography } from '../primitives/Typography';

/**
 * Modal-ish overlay listing every connection for a session, with each
 * connection's transcript inline. Users can close an open connection from
 * here; closed connections stay visible (history is preserved).
 *
 * Mounts inside `AppLayout` similar to other overlays. Caller opens/closes
 * via `sessionId` and `onClose`; passing `null` for sessionId renders
 * nothing.
 */
export function ConnectionPanel({
  sessionId,
  onClose,
}: {
  sessionId: string | null;
  onClose: () => void;
}) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [transcripts, setTranscripts] = useState<Record<string, ConnectionMessage[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const scrollRef = useScrollbarFade<HTMLUListElement>();

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const list = await listSessionConnections(sessionId);
      setConnections(list);
      const next: Record<string, ConnectionMessage[]> = {};
      await Promise.all(
        list.map(async connection => {
          try {
            next[connection.id] = await fetchConnectionTranscript(connection.id);
          } catch {
            next[connection.id] = [];
          }
        }),
      );
      setTranscripts(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    void refresh();
    let stop: (() => void) | null = null;
    let cancelled = false;
    void onConnectionStateChange(() => {
      void refresh();
    }).then(fn => {
      if (cancelled) fn();
      else stop = fn;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [sessionId, refresh]);

  const ordered = useMemo(() => {
    const out = [...connections];
    out.sort((a, b) => {
      if (a.status !== b.status) {
        if (a.status === 'open') return -1;
        if (b.status === 'open') return 1;
      }
      return a.createdAt.localeCompare(b.createdAt);
    });
    return out;
  }, [connections]);

  if (!sessionId) return null;

  return (
    <div className={backdropClass} role="dialog" aria-modal="true" data-testid="connection-panel">
      <div className={panelClass}>
        <header className={panelHeaderClass}>
          <div>
            <Typography
              as="span"
              variant="tiny"
              tone="faint"
              uppercase
              style={{ letterSpacing: '0.12em' }}
            >
              Connections
            </Typography>
            <Typography as="h2" variant="subtitle" tone="default" style={{ marginTop: '4px' }}>
              For this session
            </Typography>
          </div>
          <button
            type="button"
            className={closeButtonClass}
            onClick={onClose}
            aria-label="Close connection panel"
          >
            <X size={16} />
          </button>
        </header>
        {error ? (
          <Typography
            as="p"
            variant="smallBody"
            tone="inherit"
            selectable
            className={errorClass}
            role="alert"
            style={{ color: 'var(--status-warning, #b03f1f)' }}
          >
            {error}
          </Typography>
        ) : null}
        {ordered.length === 0 ? (
          <Typography as="p" variant="smallBody" tone="faint" className={emptyClass}>
            No connections yet for this session.
          </Typography>
        ) : (
          <ul ref={scrollRef} className={cx(listClass, scrollFadeClass)}>
            {ordered.map(connection => (
              <li key={connection.id} className={connectionRowClass}>
                <ConnectionHeader connection={connection} />
                <Transcript
                  messages={transcripts[connection.id] ?? []}
                  emptyHint={
                    connection.status === 'open'
                      ? 'No messages yet on this connection.'
                      : 'No messages were exchanged before this connection closed.'
                  }
                />
                {connection.status === 'open' ? (
                  <div className={actionRowClass}>
                    <button
                      type="button"
                      className={disconnectButtonClass}
                      disabled={busy === connection.id}
                      onClick={async () => {
                        setBusy(connection.id);
                        try {
                          await closeConnection(connection.id, null);
                          await refresh();
                        } finally {
                          setBusy(null);
                        }
                      }}
                      data-testid={`connection-disconnect-${connection.id}`}
                    >
                      <Typography as="span" variant="caption" tone="inherit">
                        Disconnect
                      </Typography>
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ConnectionHeader({ connection }: { connection: Connection }) {
  return (
    <header className={connectionHeaderClass}>
      <Typography
        as="span"
        variant="tiny"
        tone="inherit"
        uppercase
        className={statusPillClass}
        data-status={connection.status}
        style={{ letterSpacing: '0.06em' }}
      >
        {connection.status}
      </Typography>
      <Typography
        as="span"
        variant="smallBody"
        tone="default"
        className={topicLineClass}
        title={connection.reasonOpened}
      >
        {connection.topic ?? connection.reasonOpened}
      </Typography>
    </header>
  );
}

function Transcript({ messages, emptyHint }: { messages: ConnectionMessage[]; emptyHint: string }) {
  if (messages.length === 0) {
    return (
      <Typography
        as="p"
        variant="caption"
        tone="faint"
        className={transcriptEmptyClass}
        style={{ fontStyle: 'italic' }}
      >
        {emptyHint}
      </Typography>
    );
  }
  return (
    <ol className={transcriptClass}>
      {messages.map(message => (
        <li key={message.id} className={messageClass}>
          <header className={messageHeaderClass}>
            <Typography
              as="code"
              variant="caption"
              tone="muted"
              title={message.fromSession}
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {shortId(message.fromSession)}
            </Typography>
            <Typography as="span" variant="caption" tone="faint" aria-hidden>
              {' → '}
            </Typography>
            <Typography
              as="code"
              variant="caption"
              tone="muted"
              title={message.toSession}
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {shortId(message.toSession)}
            </Typography>
            <Typography
              as="time"
              variant="caption"
              tone="faint"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {message.sentAt}
            </Typography>
          </header>
          <Typography
            as="p"
            variant="smallBody"
            tone="default"
            className={messageBodyClass}
            style={{ lineHeight: '1.55', whiteSpace: 'pre-wrap' }}
          >
            {message.body}
          </Typography>
        </li>
      ))}
    </ol>
  );
}

function shortId(id: string): string {
  if (id.length <= 10) return id;
  return `${id.slice(0, 6)}…${id.slice(-3)}`;
}

const backdropClass = css({
  position: 'fixed',
  inset: 0,
  background: 'rgba(20, 18, 14, 0.45)',
  display: 'grid',
  placeItems: 'center',
  zIndex: 10,
});
const panelClass = css({
  width: 'min(700px, calc(100% - 64px))',
  maxHeight: '80vh',
  display: 'grid',
  gridTemplateRows: 'auto 1fr',
  background: 'var(--surface-0, white)',
  border: '1px solid var(--line)',
  borderRadius: '16px',
  boxShadow: '0 24px 80px rgba(20, 18, 14, 0.35)',
  overflow: 'hidden',
});
const panelHeaderClass = css({
  padding: '20px 24px',
  borderBottom: '1px solid var(--line-faint)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
});
const closeButtonClass = css({
  appearance: 'none',
  background: 'transparent',
  border: '1px solid var(--line)',
  color: 'var(--text-2)',
  width: '32px',
  height: '32px',
  display: 'grid',
  placeItems: 'center',
  borderRadius: '999px',
  cursor: 'pointer',
});
const errorClass = css({
  margin: '12px 24px',
});
const emptyClass = css({
  margin: 0,
  padding: '32px 24px',
});
const listClass = css({
  listStyle: 'none',
  margin: 0,
  padding: '12px 24px 28px',
  display: 'grid',
  gap: '20px',
  overflow: 'auto',
});
const connectionRowClass = css({ display: 'grid', gap: '10px' });
const connectionHeaderClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
});
const statusPillClass = css({
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: '999px',
  border: '1px solid var(--line)',
  color: 'var(--text-2)',
  '&[data-status="open"]': {
    color: 'var(--status-ok, #2f7a3f)',
    borderColor: 'currentColor',
  },
  '&[data-status="closed"]': { opacity: 0.75 },
  '&[data-status="denied"]': { color: 'var(--status-warning, #b03f1f)' },
});
const topicLineClass = css({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
const transcriptEmptyClass = css({
  margin: 0,
});
const transcriptClass = css({
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'grid',
  gap: '10px',
});
const messageClass = css({
  display: 'grid',
  gap: '4px',
  padding: '10px 12px',
  border: '1px solid var(--line-faint)',
  borderRadius: '10px',
  background: 'var(--surface-hover, rgba(0,0,0,0.03))',
});
const messageHeaderClass = css({
  display: 'flex',
  alignItems: 'baseline',
  gap: '6px',
  '& time': { marginLeft: 'auto' },
});
const messageBodyClass = css({
  margin: 0,
});
const actionRowClass = css({ display: 'flex', justifyContent: 'flex-end' });
const disconnectButtonClass = css({
  appearance: 'none',
  border: '1px solid currentColor',
  background: 'transparent',
  color: 'var(--status-warning, #b03f1f)',
  padding: '6px 14px',
  borderRadius: '999px',
  cursor: 'pointer',
  '&:disabled': { opacity: 0.5, cursor: 'not-allowed' },
});
