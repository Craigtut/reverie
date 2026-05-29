import { css } from '../../styled-system/css';
import {
  CLI_LABELS,
  type AgentCliDetection,
  type AgentKind,
  type BridgeCliKind,
  type BridgeInstallationStatus,
  type BridgeStatusReport,
} from '../../domain';

const CLIS: BridgeCliKind[] = ['cortex', 'codex', 'claude'];

// Bridge CLI ids map to agent-kind ids one-to-one. Kept local so this section
// can ask "is this CLI switched on?" against the detection list.
const CLI_TO_AGENT_KIND: Record<BridgeCliKind, AgentKind> = {
  cortex: 'cortex_code',
  codex: 'codex_cli',
  claude: 'claude_code',
};

/**
 * Per-CLI bridge installation toggle. Renders a row per CLI that is both
 * detected and switched on (in the Agents section above) with its status
 * (`installed`/`not installed`/`path mismatch`), the file that would be
 * touched, and an install/uninstall button. A switched-off or not-detected CLI
 * is intentionally absent: Reverie never writes to a CLI it is not using.
 *
 * State is owned by the settings surface and passed in, so toggling a CLI off
 * (which removes its bridge on the backend) refreshes these rows in lockstep.
 */
export function BridgeInstallationSection({
  detections,
  status,
  loading,
  error,
  install,
  uninstall,
}: {
  detections: AgentCliDetection[];
  status: BridgeStatusReport | null;
  loading: boolean;
  error: string | null;
  install: (cli: BridgeCliKind) => void;
  uninstall: (cli: BridgeCliKind) => void;
}) {
  const enabledClis = CLIS.filter(cli => {
    const detection = detections.find(item => item.kind === CLI_TO_AGENT_KIND[cli]);
    return Boolean(detection?.available && detection?.enabled);
  });

  return (
    <section className={sectionClass} aria-labelledby="settings-bridge-label">
      <h2 id="settings-bridge-label" className={sectionLabelClass}>
        Inter-agent bridge
      </h2>
      <p className={sectionHelpClass}>
        Reverie can let agents in different sessions coordinate with each other through a small
        helper. Installing this writes one Reverie-managed entry to each CLI's user-global config.
        Existing entries you've added stay untouched.
      </p>
      {error ? (
        <p className={errorClass} role="alert">
          {error}
        </p>
      ) : null}
      {enabledClis.length === 0 ? (
        <p className={emptyClass} data-testid="bridge-empty-hint">
          Turn on a detected agent above to manage its bridge.
        </p>
      ) : (
        <ul className={listClass}>
          {enabledClis.map(cli => (
            <BridgeRow
              key={cli}
              cli={cli}
              entry={status?.[cli] ?? null}
              disabled={loading || status === null}
              onInstall={() => install(cli)}
              onUninstall={() => uninstall(cli)}
            />
          ))}
        </ul>
      )}
      {status && enabledClis.length > 0 ? (
        <dl className={pathFooterClass}>
          <dt>Bridge helper</dt>
          <dd>{status.reverieBridgePath}</dd>
          <dt>Pre-turn hook</dt>
          <dd>{status.preturnHookPath}</dd>
        </dl>
      ) : null}
    </section>
  );
}

function BridgeRow({
  cli,
  entry,
  disabled,
  onInstall,
  onUninstall,
}: {
  cli: BridgeCliKind;
  entry: BridgeInstallationStatus | null;
  disabled: boolean;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const labels = CLI_LABELS[cli];
  const installed = entry?.mcpInstalled === true;
  const mismatched = entry?.mismatchedPaths === true;
  let stateLabel = installed ? 'Installed' : 'Not installed';
  if (mismatched) stateLabel = 'Different path detected';
  return (
    <li
      className={rowClass}
      data-installed={installed ? 'on' : 'off'}
      data-testid={`bridge-row-${cli}`}
    >
      <div className={rowTextClass}>
        <span className={rowTitleClass}>{labels.title}</span>
        <span className={rowHelpClass}>{labels.configPath}</span>
      </div>
      <div
        className={rowStateClass}
        data-tone={installed ? (mismatched ? 'warning' : 'on') : 'off'}
      >
        {stateLabel}
      </div>
      <button
        type="button"
        className={actionButtonClass}
        data-tone={installed ? 'danger' : 'primary'}
        disabled={disabled}
        onClick={installed ? onUninstall : onInstall}
        data-testid={`bridge-action-${cli}`}
      >
        {installed ? 'Remove' : 'Install'}
      </button>
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
const emptyClass = css({
  margin: 0,
  padding: '14px 4px',
  borderTop: '1px solid var(--line-faint)',
  borderBottom: '1px solid var(--line-faint)',
  color: 'var(--text-3)',
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
  padding: '14px 4px',
  borderTop: '1px solid var(--line-faint)',
  _first: { borderTop: 'none' },
});
const rowTextClass = css({ display: 'grid', gap: '4px', minWidth: 0 });
const rowTitleClass = css({
  fontSize: '14px',
  fontWeight: 500,
  color: 'var(--text)',
});
const rowHelpClass = css({
  fontSize: '12px',
  color: 'var(--text-3)',
  fontFamily: 'var(--font-mono)',
});
const rowStateClass = css({
  fontSize: '11px',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
  '&[data-tone="on"]': { color: 'var(--status-ok, #2f7a3f)' },
  '&[data-tone="warning"]': { color: 'var(--status-warning, #b03f1f)' },
});
const actionButtonClass = css({
  appearance: 'none',
  border: '1px solid var(--line)',
  background: 'transparent',
  color: 'var(--text)',
  fontSize: '12px',
  padding: '6px 14px',
  borderRadius: '999px',
  cursor: 'pointer',
  transition: 'background 120ms ease, border-color 120ms ease',
  '&:hover:not(:disabled)': { background: 'var(--surface-hover, rgba(0,0,0,0.04))' },
  '&[data-tone="danger"]': { color: 'var(--status-warning, #b03f1f)', borderColor: 'currentColor' },
  '&:disabled': { opacity: 0.5, cursor: 'not-allowed' },
});
const pathFooterClass = css({
  margin: 0,
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '4px 12px',
  fontSize: '11px',
  color: 'var(--text-3)',
  fontFamily: 'var(--font-mono)',
  '& dt': { letterSpacing: '0.04em', textTransform: 'uppercase' },
  '& dd': { margin: 0, wordBreak: 'break-all' },
});
