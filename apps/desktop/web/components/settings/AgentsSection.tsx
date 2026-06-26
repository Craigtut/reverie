import { css } from '../../styled-system/css';
import type {
  AgentCliDetection,
  AgentKind,
  BridgeInstallationStatus,
  BridgeStatusReport,
} from '../../domain';
import { AGENT_INSTALL_GUIDES, AGENT_KIND_TO_BRIDGE_CLI } from '../../domain';
import { CliInstallActions } from '../onboarding';
import { Switch } from '../primitives/Switch';
import { Typography } from '../primitives/Typography';

// One on/off subsetting shown beneath a CLI's row in the Agents list. Each is a
// self-contained toggle bound to a workspace setting and its write handler, so a
// CLI owns its own launch/behavior options. This is the seam for the "subsettings
// under each CLI" pattern: give a CLI more controls by adding entries for its
// AgentKind in `subSettingsByKind` below.
interface CliSubSetting {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

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
  claudeFullscreenEnabled,
  onSetClaudeFullscreenEnabled,
  bridgeStatus,
  bridgeBusy,
  onToggle,
  onRetryInstall,
}: {
  detections: AgentCliDetection[];
  pending: AgentKind | null;
  error: string | null;
  claudeFullscreenEnabled: boolean;
  onSetClaudeFullscreenEnabled: (value: boolean) => void;
  bridgeStatus: BridgeStatusReport | null;
  bridgeBusy: AgentKind | null;
  onToggle: (kind: AgentKind, enabled: boolean) => void;
  onRetryInstall: (kind: AgentKind) => void;
}) {
  // Per-CLI subsettings, rendered under each detected + enabled CLI's row. Keyed
  // by AgentKind so each CLI owns its own toggles; today only Claude Code has one
  // (its fullscreen renderer). Add a CLI's controls by giving it entries here.
  const subSettingsByKind: Partial<Record<AgentKind, CliSubSetting[]>> = {
    claude_code: [
      {
        id: 'claude-fullscreen',
        label: 'Fullscreen rendering',
        description:
          "Let Claude take over the terminal with its own fullscreen renderer. Off keeps Claude inline in Reverie's scrollback. Takes effect the next time a Claude session starts.",
        checked: claudeFullscreenEnabled,
        onChange: onSetClaudeFullscreenEnabled,
      },
    ],
  };
  return (
    <section className={sectionClass} aria-labelledby="settings-agents-label">
      <Typography
        as="h2"
        id="settings-agents-label"
        variant="tiny"
        tone="faint"
        uppercase
        style={{ letterSpacing: '0.12em' }}
      >
        Agents
      </Typography>
      <Typography as="p" variant="smallBody" tone="muted" style={{ lineHeight: 1.55 }}>
        The agent CLIs Reverie looks for on this machine. Turn one off to hide it everywhere new
        sessions are created and to keep Reverie out of its config files. Not detected? Install it
        below and Reverie picks it up automatically.
      </Typography>
      {error ? (
        <p className={errorClass} role="alert">
          <Typography as="span" variant="smallBody" tone="inherit">
            {error}
          </Typography>
        </p>
      ) : null}
      <ul className={listClass}>
        {detections.map(detection => (
          <AgentRow
            key={detection.kind}
            detection={detection}
            busy={pending === detection.kind}
            subSettings={subSettingsByKind[detection.kind] ?? []}
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
  subSettings,
  bridgeEntry,
  bridgeBusy,
  onToggle,
  onRetryInstall,
}: {
  detection: AgentCliDetection;
  busy: boolean;
  subSettings: CliSubSetting[];
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
  const toolsInstalled = Boolean(
    bridgeEntry?.mcpInstalled && bridgeEntry.hookInstalled && !bridgeEntry.mismatchedPaths,
  );

  return (
    <li
      className={rowClass}
      data-testid={`agent-cli-row-${kind}`}
      data-available={available ? 'on' : 'off'}
      title={detail}
    >
      <div className={rowMainClass} data-row-main>
        <Typography
          as="span"
          variant="smallBody"
          tone="default"
          className={rowTitleClass}
          style={{ letterSpacing: '-0.005em' }}
        >
          {displayName}
        </Typography>

        <Typography
          as="span"
          variant="caption"
          tone="inherit"
          uppercase
          className={statusClass}
          style={{ letterSpacing: '0.06em' }}
          data-tone={available ? 'on' : 'off'}
          data-testid={`agent-cli-status-${kind}`}
        >
          {available ? 'Detected' : 'Not detected'}
        </Typography>

        {available ? (
          <Switch
            checked={enabled}
            onChange={next => onToggle(kind, next)}
            disabled={busy}
            ariaLabel={`Enable ${displayName}`}
            testId={`agent-cli-toggle-${kind}`}
          />
        ) : (
          // Nothing to enable until it is installed; hold the column so
          // detected and not-detected rows stay aligned.
          <span className={switchPlaceholderClass} aria-hidden />
        )}
      </div>

      {!available ? (
        <div className={installHintClass} data-testid={`agent-cli-install-${kind}`}>
          <CliInstallActions guide={AGENT_INSTALL_GUIDES[kind]} />
        </div>
      ) : null}

      {showReverieTools ? (
        bridgeEntry === null ? (
          // Status hasn't loaded yet; muted hint keeps the row from jumping.
          <Typography
            as="span"
            variant="caption"
            tone="inherit"
            className={toolsHintClass}
            style={{ letterSpacing: '0.02em' }}
            data-tone="muted"
            data-testid={`agent-cli-tools-${kind}`}
          >
            Checking Reverie tools…
          </Typography>
        ) : toolsInstalled ? (
          <Typography
            as="span"
            variant="caption"
            tone="inherit"
            className={toolsHintClass}
            style={{ letterSpacing: '0.02em' }}
            data-tone="ok"
            data-testid={`agent-cli-tools-${kind}`}
            title={bridgeEntry.mismatchedPaths ? 'Different bridge path detected' : undefined}
          >
            ✓ Reverie tools installed
          </Typography>
        ) : (
          <Typography
            as="span"
            variant="caption"
            tone="inherit"
            className={toolsHintClass}
            style={{ letterSpacing: '0.02em' }}
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
              <Typography as="span" variant="caption" tone="inherit">
                {bridgeBusy ? 'Installing…' : 'Install Reverie tools'}
              </Typography>
            </button>
          </Typography>
        )
      ) : null}

      {showReverieTools && subSettings.length > 0 ? (
        <ul className={subSettingsListClass} data-testid={`agent-cli-subsettings-${kind}`}>
          {subSettings.map(setting => (
            <li key={setting.id} className={subSettingRowClass}>
              <div className={subSettingTextClass}>
                <Typography
                  as="span"
                  variant="smallBody"
                  tone="default"
                  style={{ letterSpacing: '-0.005em' }}
                >
                  {setting.label}
                </Typography>
                <Typography as="span" variant="caption" tone="faint" style={{ lineHeight: 1.5 }}>
                  {setting.description}
                </Typography>
              </div>
              <Switch
                checked={setting.checked}
                onChange={setting.onChange}
                ariaLabel={`${displayName}: ${setting.label}`}
                testId={`agent-cli-subsetting-${setting.id}`}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

const sectionClass = css({ display: 'grid', gap: '12px' });
const errorClass = css({
  margin: 0,
  padding: '8px 12px',
  borderRadius: '8px',
  background: 'var(--status-warning-soft, rgba(220, 110, 70, 0.12))',
  color: 'var(--status-warning, #b03f1f)',
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
  // Dim only the title/status line of a not-detected CLI; its install command
  // and link below stay full strength so they read as the actionable next step.
  '&[data-available="off"] [data-row-main]': { opacity: 0.62 },
});
const installHintClass = css({ marginTop: '2px' });
const rowMainClass = css({
  display: 'grid',
  gridTemplateColumns: '1fr auto auto',
  alignItems: 'center',
  gap: '16px',
});
const toolsHintClass = css({
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
  '&:disabled': { opacity: 0.6, cursor: 'wait' },
});
const rowTitleClass = css({
  minWidth: 0,
});
const statusClass = css({
  color: 'var(--text-3)',
  '&[data-tone="on"]': { color: 'var(--status-ok, #2f7a3f)' },
});

// Holds the switch column on not-detected rows so detected and not-detected
// rows stay aligned (the switch itself lives in the shared Switch primitive).
const switchPlaceholderClass = css({ width: '38px', height: '22px', flexShrink: 0 });

// A CLI's subsettings, nested under its row. A faint left rule and indent signal
// the toggles belong to the CLI above without adding a whole separate section.
const subSettingsListClass = css({
  listStyle: 'none',
  margin: '6px 0 2px',
  padding: '0 0 0 14px',
  display: 'grid',
  borderLeft: '2px solid var(--line-faint)',
});
const subSettingRowClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '16px',
  padding: '8px 0',
});
const subSettingTextClass = css({
  flex: 1,
  minWidth: 0,
  display: 'grid',
  gap: '3px',
});
