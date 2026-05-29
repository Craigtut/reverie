import { css } from '../../styled-system/css';
import type {
  AgentCliDetection,
  AgentKind,
  BridgeInstallationStatus,
  BridgeStatusReport,
} from '../../domain';
import { AGENT_KIND_TO_BRIDGE_CLI } from '../../domain';

// The "Agents" settings block: one row per supported CLI showing whether it
// is detected on this machine and, when it is, a switch to turn it on or
// off. A switched-off CLI is never offered as a session agent elsewhere in
// the app and never has its config files written. When a CLI is enabled
// Reverie auto-installs its integration (currently the inter-agent
// connection bridge) into that CLI's user-global config; the row shows a
// small confirmation, or a retry affordance if the auto-install failed.
export function AgentsSection({
  detections,
  pending,
  error,
  bridgeStatus,
  bridgeBusy,
  onToggle,
  onRetryInstall,
}: {
  detections: AgentCliDetection[];
  pending: AgentKind | null;
  error: string | null;
  bridgeStatus: BridgeStatusReport | null;
  bridgeBusy: AgentKind | null;
  onToggle: (kind: AgentKind, enabled: boolean) => void;
  onRetryInstall: (kind: AgentKind) => void;
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
            bridgeEntry={bridgeEntryFor(detection.kind, bridgeStatus)}
            bridgeBusy={bridgeBusy === detection.kind}
            onToggle={onToggle}
            onRetryInstall={onRetryInstall}
          />
        ))}
      </ul>
    </section>
  );
}

function bridgeEntryFor(
  kind: AgentKind,
  report: BridgeStatusReport | null,
): BridgeInstallationStatus | null {
  if (!report) return null;
  const cli = AGENT_KIND_TO_BRIDGE_CLI[kind];
  if (!cli) return null;
  return report[cli];
}

function AgentRow({
  detection,
  busy,
  bridgeEntry,
  bridgeBusy,
  onToggle,
  onRetryInstall,
}: {
  detection: AgentCliDetection;
  busy: boolean;
  bridgeEntry: BridgeInstallationStatus | null;
  bridgeBusy: boolean;
  onToggle: (kind: AgentKind, enabled: boolean) => void;
  onRetryInstall: (kind: AgentKind) => void;
}) {
  const { kind, displayName, available, enabled, executable, candidates } = detection;
  // The title + status pill already say everything most people need; the
  // resolved binary (or, when missing, the locations we searched) lives in a
  // hover tooltip so the detail is there for the curious without cluttering
  // the row.
  const detail = available
    ? (executable ?? candidates[0] ?? 'Detected on PATH')
    : `Looked for: ${candidates.join(', ') || 'no known locations'}`;

  const showReverieTools = available && enabled;
  const toolsInstalled =
    bridgeEntry !== null &&
    bridgeEntry.mcpInstalled &&
    bridgeEntry.hookInstalled &&
    !bridgeEntry.mismatchedPaths;

  return (
    <li
      className={rowClass}
      data-testid={`agent-cli-row-${kind}`}
      data-available={available ? 'on' : 'off'}
      title={detail}
    >
      <div className={rowMainClass}>
        <span className={rowTitleClass}>{displayName}</span>

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
          // Nothing to enable until it is installed; hold the column so
          // detected and not-detected rows stay aligned.
          <span className={switchPlaceholderClass} aria-hidden />
        )}
      </div>

      {showReverieTools ? (
        bridgeEntry === null ? (
          // Status hasn't loaded yet; muted hint keeps the row from jumping.
          <span
            className={toolsHintClass}
            data-tone="muted"
            data-testid={`agent-cli-tools-${kind}`}
          >
            Checking Reverie tools…
          </span>
        ) : toolsInstalled ? (
          <span
            className={toolsHintClass}
            data-tone="ok"
            data-testid={`agent-cli-tools-${kind}`}
            title={bridgeEntry.mismatchedPaths ? 'Different bridge path detected' : undefined}
          >
            ✓ Reverie tools installed
          </span>
        ) : (
          <span
            className={toolsHintClass}
            data-tone="missing"
            data-testid={`agent-cli-tools-${kind}`}
          >
            Reverie tools not installed.
            <button
              type="button"
              className={installRetryClass}
              disabled={bridgeBusy}
              onClick={() => onRetryInstall(kind)}
              data-testid={`agent-cli-tools-retry-${kind}`}
            >
              {bridgeBusy ? 'Installing…' : 'Install Reverie tools'}
            </button>
          </span>
        )
      ) : null}
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
  gap: '6px',
  padding: '16px 4px',
  borderTop: '1px solid var(--line-faint)',
  _first: { borderTop: 'none' },
  '&[data-available="off"]': { opacity: 0.62 },
});
const rowMainClass = css({
  display: 'grid',
  gridTemplateColumns: '1fr auto auto',
  alignItems: 'center',
  gap: '16px',
});
const toolsHintClass = css({
  fontSize: '11.5px',
  letterSpacing: '0.02em',
  color: 'var(--text-3)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  '&[data-tone="ok"]': { color: 'var(--status-ok, #2f7a3f)' },
  '&[data-tone="missing"]': { color: 'var(--status-warning, #b03f1f)' },
});
const installRetryClass = css({
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  padding: 0,
  color: 'inherit',
  textDecoration: 'underline',
  textUnderlineOffset: '2px',
  cursor: 'pointer',
  fontSize: 'inherit',
  '&:disabled': { opacity: 0.6, cursor: 'wait' },
});
const rowTitleClass = css({
  minWidth: 0,
  fontSize: '13.5px',
  fontWeight: 500,
  color: 'var(--text)',
  letterSpacing: '-0.005em',
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
