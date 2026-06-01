import { useState } from 'react';
import { CaretRight, Moon, Sun } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { AGENT_KIND_TO_BRIDGE_CLI } from '../../domain';
import type { CreateSessionRecordRequest } from '../../domain';
import { useAgentCliEnablement } from '../../hooks/useAgentClis';
import { useBridgeInstallationStatus } from '../../hooks/useConnectionsState';
import { useShellStore } from '../../store';
import { SegmentedTabs, type SegmentedTabItem } from '../primitives/SegmentedTabs';
import { Typography } from '../primitives/Typography';
import { AgentsSection } from './AgentsSection';
import { ConnectionPolicySection } from './ConnectionPolicySection';
import { ShortcutsPanel } from './ShortcutsPanel';

type SettingsTab = 'general' | 'shortcuts';

const SETTINGS_TABS: SegmentedTabItem<SettingsTab>[] = [
  { id: 'general', label: 'General' },
  { id: 'shortcuts', label: 'Shortcuts' },
];

// The settings surface: appearance (theme) + default new-session preferences.
// Theme and the new-session defaults are all persisted workspace settings now:
// the active theme highlight reads the live UI store, but every change is
// routed through the props so it both flips the UI and persists.
export function SettingsSurface({
  theme,
  onSetTheme,
  defaultAgentKind,
  onSetDefaultAgentKind,
  defaultNewSessionDangerous,
  onSetDefaultNewSessionDangerous,
}: {
  // The persisted workspace theme; the handler flips the live UI and persists.
  theme: 'light' | 'dark';
  onSetTheme: (value: 'light' | 'dark') => void;
  // The persisted workspace default agent that seeds new sessions. The select
  // reflects and writes this, then seeds the live composer.
  defaultAgentKind: CreateSessionRecordRequest['agentKind'];
  onSetDefaultAgentKind: (value: CreateSessionRecordRequest['agentKind']) => void;
  // The persisted workspace default that seeds new sessions. The toggle reflects
  // and writes this, not the ephemeral composer state.
  defaultNewSessionDangerous: boolean;
  onSetDefaultNewSessionDangerous: (value: boolean) => void;
}) {
  const detections = useShellStore(s => s.agentCliDetections);

  // The bridge status lives here, not inside the bridge section, so disabling a
  // CLI (which removes its bridge on the backend) can refresh those rows.
  const bridge = useBridgeInstallationStatus();
  const enablement = useAgentCliEnablement(() => void bridge.refresh());

  const [tab, setTab] = useState<SettingsTab>('general');

  return (
    <div className={settingsSurfaceClass} data-testid="settings-surface">
      <div className={settingsScrollClass}>
        <header className={settingsHeaderClass}>
          <Typography
            as="span"
            variant="caption"
            tone="faint"
            uppercase
            style={{ letterSpacing: '0.12em' }}
          >
            Settings
          </Typography>
          <Typography as="h1" variant="title" tone="default" style={{ letterSpacing: '-0.035em' }}>
            Settings
          </Typography>
          <SegmentedTabs
            tabs={SETTINGS_TABS}
            value={tab}
            onChange={setTab}
            ariaLabel="Settings sections"
            idBase="settings"
            className={settingsTabsClass}
          />
        </header>

        {tab === 'shortcuts' ? (
          <div
            role="tabpanel"
            id="settings-panel-shortcuts"
            aria-labelledby="settings-tab-shortcuts"
          >
            <ShortcutsPanel />
          </div>
        ) : (
          <div
            role="tabpanel"
            id="settings-panel-general"
            aria-labelledby="settings-tab-general"
            className={settingsPanelClass}
          >
            <section className={settingsGroupClass} aria-labelledby="settings-appearance-label">
              <Typography
                as="h2"
                id="settings-appearance-label"
                variant="tiny"
                tone="faint"
                uppercase
                style={{ letterSpacing: '0.12em' }}
              >
                Appearance
              </Typography>
              <ul className={settingsListClass}>
                <li className={settingsRowClass}>
                  <div className={settingsRowTextClass}>
                    <Typography
                      as="span"
                      variant="smallBody"
                      tone="default"
                      style={{ letterSpacing: '-0.005em' }}
                    >
                      Theme
                    </Typography>
                    <Typography
                      as="span"
                      variant="caption"
                      tone="faint"
                      style={{ lineHeight: 1.5 }}
                    >
                      The same warm-neutral palette in either mode.
                    </Typography>
                  </div>
                  <div className={themeSegmentedClass} role="radiogroup" aria-label="Theme">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={theme === 'light'}
                      aria-label="Light theme"
                      data-active={theme === 'light'}
                      data-testid="settings-theme-light"
                      onClick={() => onSetTheme('light')}
                    >
                      <Sun size={15} />
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={theme === 'dark'}
                      aria-label="Dark theme"
                      data-active={theme === 'dark'}
                      data-testid="settings-theme-dark"
                      onClick={() => onSetTheme('dark')}
                    >
                      <Moon size={15} />
                    </button>
                  </div>
                </li>
              </ul>
            </section>

            <section className={settingsGroupClass} aria-labelledby="settings-sessions-label">
              <Typography
                as="h2"
                id="settings-sessions-label"
                variant="tiny"
                tone="faint"
                uppercase
                style={{ letterSpacing: '0.12em' }}
              >
                Sessions
              </Typography>
              <ul className={settingsListClass}>
                <li className={settingsRowClass}>
                  <div className={settingsRowTextClass}>
                    <Typography
                      as="span"
                      variant="smallBody"
                      tone="default"
                      style={{ letterSpacing: '-0.005em' }}
                    >
                      Default agent
                    </Typography>
                    <Typography
                      as="span"
                      variant="caption"
                      tone="faint"
                      style={{ lineHeight: 1.5 }}
                    >
                      The CLI new sessions start with.
                    </Typography>
                  </div>
                  <div className={settingsSelectWrapClass}>
                    <select
                      className={settingsSelectClass}
                      value={defaultAgentKind}
                      data-testid="settings-default-agent"
                      onChange={event =>
                        onSetDefaultAgentKind(
                          event.currentTarget.value as CreateSessionRecordRequest['agentKind'],
                        )
                      }
                    >
                      {detections.map(detection => {
                        const usable = detection.available && detection.enabled;
                        const suffix = usable
                          ? ''
                          : detection.available
                            ? ' (off)'
                            : ' (not detected)';
                        return (
                          <option key={detection.kind} value={detection.kind} disabled={!usable}>
                            {detection.displayName}
                            {suffix}
                          </option>
                        );
                      })}
                    </select>
                    <CaretRight size={12} weight="bold" />
                  </div>
                </li>
                <li className={settingsRowClass}>
                  <div className={settingsRowTextClass}>
                    <Typography
                      as="span"
                      variant="smallBody"
                      tone="default"
                      style={{ letterSpacing: '-0.005em' }}
                    >
                      Enable YOLO for new sessions
                    </Typography>
                    <Typography
                      as="span"
                      variant="caption"
                      tone="faint"
                      style={{ lineHeight: 1.5 }}
                    >
                      Skip per-tool approvals when launching a new session.
                    </Typography>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={defaultNewSessionDangerous}
                    aria-label="Enable YOLO for new sessions"
                    data-state={defaultNewSessionDangerous ? 'on' : 'off'}
                    data-testid="settings-yolo-toggle"
                    className={settingsSwitchClass}
                    onClick={() => onSetDefaultNewSessionDangerous(!defaultNewSessionDangerous)}
                  >
                    <span className={settingsSwitchKnobClass} />
                  </button>
                </li>
              </ul>
            </section>

            <AgentsSection
              detections={detections}
              pending={enablement.pending}
              error={enablement.error}
              bridgeStatus={bridge.status}
              bridgeBusy={
                bridge.busyCli
                  ? (detections.find(
                      detection => AGENT_KIND_TO_BRIDGE_CLI[detection.kind] === bridge.busyCli,
                    )?.kind ?? null)
                  : null
              }
              onToggle={(kind, enabled) => void enablement.toggle(kind, enabled)}
              onRetryInstall={kind => {
                const cli = AGENT_KIND_TO_BRIDGE_CLI[kind];
                if (cli) void bridge.install(cli);
              }}
            />
            {anyReverieToolsInstalled(detections, bridge.status) ? (
              <ConnectionPolicySection />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

const settingsSurfaceClass = css({
  position: 'relative',
  zIndex: 2,
  height: '100%',
  minHeight: 0,
  overflow: 'auto',
  background: 'transparent',
});

const settingsScrollClass = css({
  width: 'min(680px, calc(100% - 64px))',
  margin: '0 auto',
  padding: '72px 0 96px',
  display: 'grid',
  gap: '36px',
  lgDown: { width: 'min(680px, calc(100% - 40px))', padding: '48px 0 72px' },
});

const settingsHeaderClass = css({
  display: 'grid',
  gap: '6px',
  marginBottom: '4px',
});

// The segmented control sits just below the title; justifySelf keeps the pill
// hugging its content instead of stretching across the settings column.
const settingsTabsClass = css({
  justifySelf: 'start',
  marginTop: '14px',
});

// Holds the General tab's sections with the same rhythm they had as direct
// children of the settings column.
const settingsPanelClass = css({
  display: 'grid',
  gap: '36px',
});

const settingsGroupClass = css({
  display: 'grid',
  gap: '12px',
});

const settingsListClass = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  borderTop: '1px solid var(--line-faint)',
  borderBottom: '1px solid var(--line-faint)',
});

const settingsRowClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '24px',
  padding: '18px 4px',
  borderTop: '1px solid var(--line-faint)',
  _first: { borderTop: 'none' },
});

const settingsRowTextClass = css({
  flex: 1,
  minWidth: 0,
  display: 'grid',
  gap: '3px',
});

const themeSegmentedClass = css({
  display: 'inline-flex',
  padding: '3px',
  borderRadius: '999px',
  border: '1px solid var(--line)',
  background: 'color-mix(in srgb, var(--surface-1) 80%, transparent)',
  gap: '2px',
  '& button': {
    width: '34px',
    height: '28px',
    display: 'grid',
    placeItems: 'center',
    borderRadius: '999px',
    color: 'var(--text-3)',
    cursor: 'pointer',
    transition: 'color 140ms ease, background 140ms ease',
    _hover: { color: 'var(--text-2)' },
  },
  '& button[data-active="true"]': {
    color: 'var(--text)',
    background: 'var(--surface-3)',
    boxShadow: 'inset 0 0 0 1px var(--line-strong)',
  },
});

const settingsSelectWrapClass = css({
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  '& svg': {
    position: 'absolute',
    right: '10px',
    color: 'var(--text-3)',
    pointerEvents: 'none',
    transform: 'rotate(90deg)',
  },
});

const settingsSelectClass = css({
  appearance: 'none',
  border: '1px solid var(--line)',
  borderRadius: '10px',
  background: 'color-mix(in srgb, var(--surface-1) 80%, transparent)',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: '13px',
  padding: '8px 28px 8px 12px',
  cursor: 'pointer',
  outline: 'none',
  transition: 'border-color 140ms ease, background 140ms ease',
  _hover: { borderColor: 'var(--line-strong)' },
  _focusVisible: {
    borderColor: 'var(--line-strong)',
    boxShadow: '0 0 0 3px color-mix(in srgb, var(--text) 8%, transparent)',
  },
});

const settingsSwitchClass = css({
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
    background: 'color-mix(in srgb, var(--warn) 78%, transparent)',
    borderColor: 'color-mix(in srgb, var(--warn) 60%, var(--line-strong))',
  },
});

const settingsSwitchKnobClass = css({
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
    background: '#FFFFFF',
  },
});

// True when at least one detected+enabled CLI has the full Reverie tools
// installed. The connection-policy section is hidden until this is true:
// without any installed CLI there is nothing for a policy to affect.
function anyReverieToolsInstalled(
  detections: ReturnType<typeof useShellStore.getState>['agentCliDetections'],
  status: ReturnType<typeof useBridgeInstallationStatus>['status'],
): boolean {
  if (!status) return false;
  return detections.some(detection => {
    if (!detection.available || !detection.enabled) return false;
    const cli = AGENT_KIND_TO_BRIDGE_CLI[detection.kind];
    if (!cli) return false;
    const entry = status[cli];
    return entry.mcpInstalled && entry.hookInstalled && !entry.mismatchedPaths;
  });
}
