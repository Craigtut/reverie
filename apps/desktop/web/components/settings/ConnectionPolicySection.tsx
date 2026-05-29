import { css } from '../../styled-system/css';
import { POLICY_LABELS, type ConnectionPolicy } from '../../domain';
import { useConnectionPolicy } from '../../hooks/useConnectionsState';

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
      <h2 id="settings-connection-policy-label" className={sectionLabelClass}>
        Connection policy
      </h2>
      <p className={sectionHelpClass}>
        How Reverie handles a connection request between two of your sessions. Cross-project
        requests always require explicit accept regardless of policy.
      </p>
      {error ? (
        <p className={errorClass} role="alert">
          {error}
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
                  <span className={radioTitleClass}>{labels.title}</span>
                  <span className={radioHelpClass}>{labels.help}</span>
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
const radioTitleClass = css({
  fontSize: '14px',
  color: 'var(--text)',
  fontWeight: 500,
});
const radioHelpClass = css({
  fontSize: '12px',
  color: 'var(--text-3)',
  lineHeight: '1.5',
});
