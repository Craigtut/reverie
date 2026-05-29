import { css } from '../../styled-system/css';
import type { AgentCliDetection, AgentKind } from '../../domain';

// The "Agents" settings block: one row per supported CLI showing whether it is
// detected on this machine and, when it is, a switch to turn it on or off. A
// switched-off CLI is never offered as a session agent elsewhere in the app and
// never has its config files written (the inter-agent bridge below is removed
// when a CLI is disabled). Not-detected CLIs show what we looked for and carry
// no switch, since there is nothing to enable.
export function AgentsSection({
  detections,
  pending,
  error,
  onToggle,
}: {
  detections: AgentCliDetection[];
  pending: AgentKind | null;
  error: string | null;
  onToggle: (kind: AgentKind, enabled: boolean) => void;
}) {
  return (
    <section className={sectionClass} aria-labelledby="settings-agents-label">
      <h2 id="settings-agents-label" className={sectionLabelClass}>
        Agents
      </h2>
      <p className={sectionHelpClass}>
        The agent CLIs Reverie found on this machine. Turn one off to hide it everywhere new
        sessions are created and to keep Reverie out of its config files.
      </p>
      {error ? (
        <p className={errorClass} role="alert">
          {error}
        </p>
      ) : null}
      <ul className={listClass}>
        {detections.map(detection => (
          <AgentRow
            key={detection.kind}
            detection={detection}
            busy={pending === detection.kind}
            onToggle={onToggle}
          />
        ))}
      </ul>
    </section>
  );
}

function AgentRow({
  detection,
  busy,
  onToggle,
}: {
  detection: AgentCliDetection;
  busy: boolean;
  onToggle: (kind: AgentKind, enabled: boolean) => void;
}) {
  const { kind, displayName, available, enabled, executable, candidates } = detection;
  const detail = available
    ? (executable ?? candidates[0] ?? 'Detected on PATH')
    : `Looked for: ${candidates.join(', ') || 'no known locations'}`;

  return (
    <li
      className={rowClass}
      data-testid={`agent-cli-row-${kind}`}
      data-available={available ? 'on' : 'off'}
    >
      <div className={rowTextClass}>
        <span className={rowTitleClass}>{displayName}</span>
        <span className={rowHelpClass}>{detail}</span>
      </div>

      <span
        className={statusClass}
        data-tone={available ? 'on' : 'off'}
        data-testid={`agent-cli-status-${kind}`}
      >
        {available ? 'Detected' : 'Not detected'}
      </span>

      {available ? (
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`Enable ${displayName}`}
          data-state={enabled ? 'on' : 'off'}
          data-testid={`agent-cli-toggle-${kind}`}
          className={switchClass}
          disabled={busy}
          onClick={() => onToggle(kind, !enabled)}
        >
          <span className={switchKnobClass} />
        </button>
      ) : (
        // Nothing to enable until it is installed; hold the column so detected
        // and not-detected rows stay aligned.
        <span className={switchPlaceholderClass} aria-hidden />
      )}
    </li>
  );
}

const sectionClass = css({ display: 'grid', gap: '12px' });
const sectionLabelClass = css({
  margin: 0,
  color: 'var(--text-3)',
  fontSize: '10.5px',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  fontWeight: 500,
});
const sectionHelpClass = css({
  margin: 0,
  color: 'var(--text-2)',
  fontSize: '13px',
  lineHeight: '1.55',
});
const errorClass = css({
  margin: 0,
  padding: '8px 12px',
  borderRadius: '8px',
  background: 'var(--status-warning-soft, rgba(220, 110, 70, 0.12))',
  color: 'var(--status-warning, #b03f1f)',
  fontSize: '13px',
});
const listClass = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  borderTop: '1px solid var(--line-faint)',
  borderBottom: '1px solid var(--line-faint)',
});
const rowClass = css({
  display: 'grid',
  gridTemplateColumns: '1fr auto auto',
  alignItems: 'center',
  gap: '16px',
  padding: '16px 4px',
  borderTop: '1px solid var(--line-faint)',
  _first: { borderTop: 'none' },
  '&[data-available="off"]': { opacity: 0.62 },
});
const rowTextClass = css({ display: 'grid', gap: '4px', minWidth: 0 });
const rowTitleClass = css({
  fontSize: '13.5px',
  fontWeight: 500,
  color: 'var(--text)',
  letterSpacing: '-0.005em',
});
const rowHelpClass = css({
  fontSize: '12px',
  color: 'var(--text-3)',
  fontFamily: 'var(--font-mono)',
  wordBreak: 'break-all',
});
const statusClass = css({
  fontSize: '11px',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
  '&[data-tone="on"]': { color: 'var(--status-ok, #2f7a3f)' },
});

// Neutral on/off switch. Unlike the YOLO switch (warn-toned because it is
// dangerous) this is a plain monochrome toggle: a filled track when on.
const switchClass = css({
  position: 'relative',
  width: '38px',
  height: '22px',
  borderRadius: '999px',
  border: '1px solid var(--line)',
  background: 'var(--surface-2)',
  cursor: 'pointer',
  padding: 0,
  flexShrink: 0,
  transition: 'background 160ms ease, border-color 160ms ease',
  _hover: { borderColor: 'var(--line-strong)' },
  '&[data-state="on"]': {
    background: 'var(--text)',
    borderColor: 'var(--text)',
  },
  '&:disabled': { opacity: 0.5, cursor: 'not-allowed' },
});
const switchKnobClass = css({
  position: 'absolute',
  top: '50%',
  left: '2px',
  width: '16px',
  height: '16px',
  borderRadius: '50%',
  background: 'var(--text)',
  transform: 'translateY(-50%)',
  transition: 'left 160ms ease, background 160ms ease',
  boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
  '[data-state="on"] &': {
    left: '18px',
    background: 'var(--surface-1)',
  },
});
const switchPlaceholderClass = css({ width: '38px', height: '22px', flexShrink: 0 });
