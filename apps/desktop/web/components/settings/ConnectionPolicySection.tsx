import { css } from '../../styled-system/css';
import { POLICY_LABELS, type ConnectionPolicy } from '../../domain';
import { useConnectionPolicy } from '../../hooks/useConnectionsState';
import { Typography } from '../primitives/Typography';

const POLICIES: ConnectionPolicy[] = [
  'always_ask',
  'auto_allow_focus',
  'auto_allow_project',
  'auto_allow_workspace',
];

export function ConnectionPolicySection() {
  const { policy, error, update } = useConnectionPolicy();
  return (
    <section className={sectionClass} aria-labelledby="settings-connection-policy-label">
      <Typography
        as="h2"
        id="settings-connection-policy-label"
        variant="tiny"
        tone="faint"
        uppercase
        style={{ letterSpacing: '0.12em' }}
      >
        Connection policy
      </Typography>
      <Typography as="p" variant="smallBody" tone="muted" style={{ lineHeight: 1.55 }}>
        How Reverie handles a connection request between two of your sessions. Cross-project
        requests always require explicit accept regardless of policy.
      </Typography>
      {error ? (
        <p className={errorClass} role="alert">
          <Typography as="span" variant="smallBody" tone="inherit">
            {error}
          </Typography>
        </p>
      ) : null}
      <ul className={listClass} role="radiogroup" aria-label="Connection policy">
        {POLICIES.map(option => {
          const labels = POLICY_LABELS[option];
          const checked = policy === option;
          return (
            <li key={option}>
              <label className={radioRowClass} data-checked={checked ? 'on' : 'off'}>
                <input
                  type="radio"
                  name="connection-policy"
                  value={option}
                  checked={checked}
                  onChange={() => void update(option)}
                  data-testid={`policy-radio-${option}`}
                />
                <span className={radioDotClass} aria-hidden />
                <span className={radioTextClass}>
                  <Typography as="span" variant="smallBody" tone="default">
                    {labels.title}
                  </Typography>
                  <Typography as="span" variant="caption" tone="faint" style={{ lineHeight: 1.5 }}>
                    {labels.help}
                  </Typography>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
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
  gap: '4px',
});
const radioRowClass = css({
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '14px',
  alignItems: 'flex-start',
  padding: '14px 14px',
  border: '1px solid var(--line-faint)',
  borderRadius: '12px',
  cursor: 'pointer',
  transition: 'background 120ms ease, border-color 120ms ease',
  '& input': {
    position: 'absolute',
    opacity: 0,
    pointerEvents: 'none',
  },
  '&[data-checked="on"]': {
    borderColor: 'var(--text)',
    background: 'var(--surface-hover, rgba(0,0,0,0.04))',
  },
  // When the row is selected, light up the inner dot we styled in
  // radioDotClass.
  '&[data-checked="on"] span::after': { opacity: 1 },
});
const radioDotClass = css({
  width: '14px',
  height: '14px',
  borderRadius: '999px',
  border: '1px solid var(--text-3)',
  display: 'block',
  marginTop: '3px',
  position: 'relative',
  '&::after': {
    content: '""',
    position: 'absolute',
    inset: '3px',
    borderRadius: '999px',
    background: 'var(--text)',
    opacity: 0,
    transition: 'opacity 120ms ease',
  },
  // Light up the inner dot when the parent row is the selected radio. Panda
  // does not accept attribute selectors on ancestors directly inside the
  // object, so we extend the radioRowClass with the matching child rule.
});
const radioTextClass = css({ display: 'grid', gap: '3px', minWidth: 0 });
