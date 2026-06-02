import { css } from '../../styled-system/css';

// The one sliding on/off switch used across the app (settings, agent rows).
// A binary control: a pill track with a knob that slides right when on. Two
// tones share the same geometry and motion: `neutral` fills with the text color
// (a plain preference), `warn` fills with the warn color (a dangerous setting
// like YOLO/auto-approve). Mutually-exclusive choices use a segmented control
// instead; this is only for true on/off toggles.
export function Switch({
  checked,
  onChange,
  tone = 'neutral',
  disabled = false,
  ariaLabel,
  testId,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  tone?: 'neutral' | 'warn';
  disabled?: boolean;
  ariaLabel: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-state={checked ? 'on' : 'off'}
      data-tone={tone}
      data-testid={testId}
      disabled={disabled}
      className={switchClass}
      onClick={() => onChange(!checked)}
    >
      <span className={switchKnobClass} />
    </button>
  );
}

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
  '&[data-state="on"][data-tone="neutral"]': {
    background: 'var(--text)',
    borderColor: 'var(--text)',
  },
  '&[data-state="on"][data-tone="warn"]': {
    background: 'color-mix(in srgb, var(--warn) 78%, transparent)',
    borderColor: 'color-mix(in srgb, var(--warn) 60%, var(--line-strong))',
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
  '[data-state="on"] &': { left: '18px' },
  '[data-state="on"][data-tone="neutral"] &': { background: 'var(--surface-1)' },
  '[data-state="on"][data-tone="warn"] &': { background: '#FFFFFF' },
});
