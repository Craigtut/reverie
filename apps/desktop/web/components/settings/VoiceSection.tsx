import { useEffect, useState } from 'react';

import { css } from '../../styled-system/css';
import { useShellStore, useSpeechEngineStore } from '../../store';
import { provisioningLabel } from '../../domain';
import {
  listAudioInputDevices,
  setVoiceInputDevice,
  speechProvision,
} from '../../services/speechApi';
import { Typography } from '../primitives/Typography';

// The "Voice input" settings block: a read-only status readout for the on-device
// speech engine (provisioning / ready / unavailable) plus the microphone
// permission state. There are no toggles: voice input is on-device and
// privacy-safe, so it needs no enable switch, and the interaction model lives
// with the surfaces that use it (dispatch, a future voice button), not here. The
// status is useful mainly during the one-time model download. Self-contained:
// engine + mic state come from the speech store, which the app keeps live.
export function VoiceSection() {
  const engine = useSpeechEngineStore(s => s.engine);
  const micPermission = useSpeechEngineStore(s => s.micPermission);
  const shell = useShellStore(s => s.shell);
  const setShell = useShellStore(s => s.setShell);

  const status = engineStatusCopy(engine);
  // Retry only helps a failed download/compile. Hardware-unavailable can't be
  // retried away, so no button there.
  const canRetry = engine.kind === 'error';
  const provisioning = engine.kind === 'provisioning';
  const ready = engine.kind === 'ready';

  const selectedDevice = shell.workspace.voiceInputDevice ?? '';
  const [devices, setDevices] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listAudioInputDevices()
      .then(list => {
        if (!cancelled) setDevices(list);
      })
      .catch(() => {
        /* enumeration unavailable (e.g. harness): leave the default option */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSelectDevice = (value: string) => {
    void setVoiceInputDevice(value || null)
      .then(setShell)
      .catch(() => {
        /* surfaced by the command; keep the prior selection */
      });
  };

  return (
    <section className={groupClass} aria-labelledby="settings-voice-label">
      <Typography
        as="h2"
        id="settings-voice-label"
        variant="tiny"
        tone="faint"
        uppercase
        style={{ letterSpacing: '0.12em' }}
      >
        Voice input
      </Typography>

      {/* Engine status: the one-time model download lands here, then Ready. */}
      <div className={statusRowClass}>
        <span className={dotClass} data-tone={status.tone} aria-hidden />
        <Typography as="span" variant="caption" tone="faint" style={{ lineHeight: 1.5 }}>
          {status.label}
        </Typography>
        {canRetry ? (
          <button type="button" className={retryClass} onClick={() => void speechProvision()}>
            <Typography as="span" variant="caption" tone="default">
              Retry
            </Typography>
          </button>
        ) : null}
      </div>

      {/* One-time setup: an indeterminate bar (no byte progress is available),
          with the stage named in the status line above. Shell-level motion. */}
      {provisioning ? <div className={provisionBarClass} aria-hidden /> : null}

      <Typography as="span" variant="caption" tone="faint" style={{ lineHeight: 1.5 }}>
        Transcription runs entirely on your Mac (Apple Neural Engine); audio never leaves the
        device. Microphone access: {micPermissionCopy(micPermission)}.
      </Typography>

      {/* The mic picker only matters once speech is ready; while it downloads or
          is unavailable it reads as broken, so hide it until then. */}
      {ready ? (
        <label className={deviceRowClass}>
          <Typography as="span" variant="caption" tone="muted">
            Microphone
          </Typography>
          <select
            className={selectClass}
            value={selectedDevice}
            onChange={event => onSelectDevice(event.target.value)}
          >
            <option value="">System default</option>
            {devices.map(device => (
              <option key={device} value={device}>
                {device}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </section>
  );
}

function engineStatusCopy(engine: ReturnType<typeof useSpeechEngineStore.getState>['engine']): {
  label: string;
  tone: 'ready' | 'busy' | 'idle' | 'error';
} {
  switch (engine.kind) {
    case 'ready':
      return { label: 'On-device speech is ready.', tone: 'ready' };
    case 'provisioning':
      return {
        label:
          engine.phase === 'optimizing'
            ? `${provisioningLabel(engine.phase)} (almost ready).`
            : `${provisioningLabel(engine.phase)} (one-time, ~460 MB download).`,
        tone: 'busy',
      };
    case 'error':
      return { label: `Speech setup failed: ${engine.message}`, tone: 'error' };
    case 'unavailable':
      return { label: `Voice unavailable: ${engine.reason}.`, tone: 'idle' };
  }
}

function micPermissionCopy(permission: string): string {
  switch (permission) {
    case 'granted':
      return 'granted';
    case 'denied':
      return 'denied (enable it in System Settings > Privacy & Security > Microphone)';
    default:
      return 'will be requested on first use';
  }
}

const groupClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
});

const statusRowClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
});

// An indeterminate one-time-setup bar: a calm sheen sweeping a faint track. No
// byte progress is available from the engine, so this signals motion, not a
// percentage. Reuses the dispatch routing sheen keyframe (main.css).
const provisionBarClass = css({
  height: '3px',
  borderRadius: '999px',
  background:
    'linear-gradient(90deg, var(--colors-border-subtle) 0%, var(--colors-status-warning, #d6a338) 50%, var(--colors-border-subtle) 100%)',
  backgroundSize: '200% 100%',
  animation: 'dispatchRouting 1.4s linear infinite',
});

const dotClass = css({
  width: '7px',
  height: '7px',
  borderRadius: '999px',
  flexShrink: 0,
  background: 'var(--colors-text-faint)',
  '&[data-tone="ready"]': { background: 'var(--colors-status-success, #4caf72)' },
  '&[data-tone="busy"]': { background: 'var(--colors-status-warning, #d6a338)' },
  '&[data-tone="error"]': { background: 'var(--colors-status-danger, #d6533f)' },
});

const retryClass = css({
  marginLeft: 'auto',
  padding: '2px 10px',
  borderRadius: '7px',
  border: '1px solid var(--colors-border-subtle)',
  cursor: 'pointer',
  background: 'transparent',
  _hover: { background: 'var(--colors-surface-raised)' },
});

const deviceRowClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
});

const selectClass = css({
  flexShrink: 0,
  maxWidth: '60%',
  padding: '4px 8px',
  borderRadius: '7px',
  border: '1px solid var(--colors-border-subtle)',
  background: 'var(--colors-surface-raised)',
  color: 'var(--text)',
  fontFamily: 'inherit',
  fontSize: '12px',
  cursor: 'pointer',
});
