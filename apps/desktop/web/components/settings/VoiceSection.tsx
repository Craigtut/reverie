import { useEffect, useState } from 'react';

import { css } from '../../styled-system/css';
import { useShellStore, useSpeechEngineStore } from '../../store';
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
  const canRetry = engine.kind === 'error' || engine.kind === 'unavailable';

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

      <Typography as="span" variant="caption" tone="faint" style={{ lineHeight: 1.5 }}>
        Transcription runs entirely on your Mac (Apple Neural Engine); audio never leaves the
        device. Microphone access: {micPermissionCopy(micPermission)}.
      </Typography>

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
        label: 'Preparing on-device speech (one-time setup, this can take a moment).',
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
