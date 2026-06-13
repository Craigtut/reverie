import { ArrowClockwise, ArrowsClockwise } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { relaunchToUpdate, runUpdateCheck } from '../../hooks';
import { useUpdateStore } from '../../store';
import { primaryComposerButtonClass, secondaryComposerButtonClass } from '../primitives/buttons';
import { Switch } from '../primitives/Switch';
import { Typography } from '../primitives/Typography';

// Software update controls in Settings > General. Renders only on a build that
// can update (production desktop channel); the dev channel and browser harness
// report `enabled: false`, so this stays hidden there. It exposes the manual
// check, the auto-check / auto-download preferences, the current version, and a
// relaunch button once an update is staged.
export function SoftwareUpdateSection() {
  const enabled = useUpdateStore(s => s.enabled);
  const currentVersion = useUpdateStore(s => s.currentVersion);
  const phase = useUpdateStore(s => s.phase);
  const availableVersion = useUpdateStore(s => s.availableVersion);
  const progress = useUpdateStore(s => s.downloadProgress);
  const lastCheckedAt = useUpdateStore(s => s.lastCheckedAt);
  const autoCheck = useUpdateStore(s => s.autoCheck);
  const autoDownload = useUpdateStore(s => s.autoDownload);
  const setAutoCheck = useUpdateStore(s => s.setAutoCheck);
  const setAutoDownload = useUpdateStore(s => s.setAutoDownload);

  if (!enabled) return null;

  const busy = phase === 'checking' || phase === 'downloading';
  const showRelaunch = phase === 'available' || phase === 'downloading' || phase === 'ready';

  return (
    <section className={settingsGroupClass} aria-labelledby="settings-update-label">
      <Typography
        as="h2"
        id="settings-update-label"
        variant="tiny"
        tone="faint"
        uppercase
        style={{ letterSpacing: '0.12em' }}
      >
        Software update
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
              Reverie {currentVersion}
            </Typography>
            <Typography as="span" variant="caption" tone="faint" style={{ lineHeight: 1.5 }}>
              {statusLine(phase, availableVersion, progress, lastCheckedAt)}
            </Typography>
          </div>
          <div className={actionsClass}>
            {showRelaunch ? (
              <button
                type="button"
                className={primaryComposerButtonClass}
                data-testid="settings-relaunch-update"
                disabled={phase === 'downloading'}
                onClick={() => void relaunchToUpdate()}
              >
                <ArrowClockwise size={14} weight="bold" />
                Relaunch to update
              </button>
            ) : (
              <button
                type="button"
                className={secondaryComposerButtonClass}
                data-testid="settings-check-update"
                disabled={busy}
                onClick={() => void runUpdateCheck({ manual: true })}
              >
                <ArrowsClockwise size={14} weight="bold" />
                {phase === 'checking' ? 'Checking…' : 'Check for updates'}
              </button>
            )}
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
              Check automatically
            </Typography>
            <Typography as="span" variant="caption" tone="faint" style={{ lineHeight: 1.5 }}>
              Quietly look for new versions while Reverie runs. Updates never interrupt your work.
            </Typography>
          </div>
          <Switch
            checked={autoCheck}
            onChange={setAutoCheck}
            ariaLabel="Check for updates automatically"
            testId="settings-update-auto-check"
          />
        </li>
        <li className={settingsRowClass}>
          <div className={settingsRowTextClass}>
            <Typography
              as="span"
              variant="smallBody"
              tone="default"
              style={{ letterSpacing: '-0.005em' }}
            >
              Download automatically
            </Typography>
            <Typography as="span" variant="caption" tone="faint" style={{ lineHeight: 1.5 }}>
              Download a new version in the background so it is ready to install when you relaunch.
            </Typography>
          </div>
          <Switch
            checked={autoDownload}
            onChange={setAutoDownload}
            ariaLabel="Download updates automatically"
            testId="settings-update-auto-download"
          />
        </li>
      </ul>
    </section>
  );
}

function statusLine(
  phase: ReturnType<typeof useUpdateStore.getState>['phase'],
  version: string | null,
  progress: number | null,
  lastCheckedAt: number | null,
): string {
  switch (phase) {
    case 'checking':
      return 'Checking for updates…';
    case 'downloading':
      return version
        ? `Downloading ${version}${progress != null ? ` (${Math.round(progress * 100)}%)` : '…'}`
        : 'Downloading update…';
    case 'available':
      return version ? `Version ${version} is available to download.` : 'An update is available.';
    case 'ready':
      return version
        ? `Version ${version} is ready. It installs when you quit, or relaunch now.`
        : 'An update is ready to install.';
    case 'error':
      return 'The last update check did not complete. Try again.';
    case 'uptodate':
      return lastCheckedAt
        ? `Up to date. Last checked ${formatChecked(lastCheckedAt)}.`
        : 'Up to date.';
    default:
      return "You're on the latest installed version.";
  }
}

function formatChecked(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return 'just now';
  }
}

const settingsGroupClass = css({ display: 'grid', gap: '12px' });

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

const settingsRowTextClass = css({ flex: 1, minWidth: 0, display: 'grid', gap: '3px' });

const actionsClass = css({ display: 'inline-flex', alignItems: 'center', flexShrink: 0 });
