import { css } from '../../styled-system/css';

// The one sliding on/off switch used across the app (settings, agent rows).
// A binary control: a pill track with a knob that slides right when on. When
// on, the track fills with the text color and the knob reads as a light disc,
// so every switch looks the same wherever it appears. Mutually-exclusive
// choices use a segmented control instead; this is only for true on/off toggles.
export function Switch({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  testId,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
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
