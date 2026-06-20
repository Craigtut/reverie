import { css } from '../../styled-system/css';
import { useSpeechEngineStore } from '../../store';
import { speechProvision } from '../../services/speechApi';
import { Switch } from '../primitives/Switch';
import { Typography } from '../primitives/Typography';

// The "Voice input" settings block: the opt-in/affordance toggles plus the live
// status of the on-device speech engine (provisioning / ready / unavailable) and
// microphone permission. This is the foundation's own settings surface; the
// dispatch shortcut and the in-terminal voice button are separate features that
// build on the same engine. Self-contained: persisted settings come in via
// props (drilled from the workspace like the other toggles); engine + mic state
// are read from the speech store, which the app keeps live.
export function VoiceSection({
  voiceEnabled,
  voiceLanguage,
  voicePushToTalk,
  onSetVoiceSettings,
}: {
  voiceEnabled: boolean;
  voiceLanguage: string;
  voicePushToTalk: boolean;
  onSetVoiceSettings: (next: {
    voiceEnabled: boolean;
    voiceLanguage: string;
    voicePushToTalk: boolean;
  }) => void;
}) {
  const engine = useSpeechEngineStore(s => s.engine);
  const micPermission = useSpeechEngineStore(s => s.micPermission);

  const status = engineStatusCopy(engine);
  const canRetry = engine.kind === 'error' || engine.kind === 'unavailable';

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

      <ul className={listClass}>
        <li className={rowClass}>
          <div className={rowTextClass}>
            <Typography as="span" variant="smallBody" tone="default">
              Enable voice input
            </Typography>
            <Typography as="span" variant="caption" tone="faint" style={{ lineHeight: 1.5 }}>
              Show the voice controls. Transcription runs entirely on your Mac (Apple Neural
              Engine); audio never leaves the device. Microphone access:{' '}
              {micPermissionCopy(micPermission)}.
            </Typography>
          </div>
          <Switch
            checked={voiceEnabled}
            onChange={next =>
              onSetVoiceSettings({ voiceEnabled: next, voiceLanguage, voicePushToTalk })
            }
            ariaLabel="Enable voice input"
            testId="settings-voice-toggle"
          />
        </li>

        {voiceEnabled ? (
          <li className={rowClass}>
            <div className={rowTextClass}>
              <Typography as="span" variant="smallBody" tone="default">
                Press and hold to talk
              </Typography>
              <Typography as="span" variant="caption" tone="faint" style={{ lineHeight: 1.5 }}>
                Hold the voice control while speaking and release to transcribe. Off makes it a
                click-to-start, click-to-stop toggle instead.
              </Typography>
            </div>
            <Switch
              checked={voicePushToTalk}
              onChange={next =>
                onSetVoiceSettings({ voiceEnabled, voiceLanguage, voicePushToTalk: next })
              }
              ariaLabel="Press and hold to talk"
              testId="settings-voice-ptt-toggle"
            />
          </li>
        ) : null}
      </ul>
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

const listClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
});

const rowClass = css({
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '16px',
  paddingY: '10px',
});

const rowTextClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  maxWidth: '34rem',
});
