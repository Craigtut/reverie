import { css } from '../../styled-system/css';

// Shared agent-CLI choice styles: the responsive grid of CLI options and each
// choice card. Used by the onboarding panel and the creation composer.

export const cliChoiceGridClass = css({
  gridColumn: '1 / -1',
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: '8px',
  lgDown: { gridTemplateColumns: '1fr' },
});

export function cliChoiceClass({ active, available }: { active: boolean; available: boolean }) {
  return css({
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: '9px',
    minHeight: '54px',
    borderRadius: '14px',
    border: `1px solid ${active ? 'color-mix(in srgb, var(--line-strong) 82%, var(--accent))' : 'var(--line)'}`,
    background: active ? 'var(--surface-hi)' : 'var(--surface-1)',
    color: available ? 'var(--text)' : 'var(--text-4)',
    cursor: available ? 'pointer' : 'not-allowed',
    textAlign: 'left',
    padding: '9px 10px',
    opacity: available ? 1 : 0.56,
    boxShadow: active ? 'inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent)' : 'none',
    '& span:nth-child(2)': { display: 'grid', gap: '2px', minWidth: 0 },
    '& strong': { fontSize: '12px', fontWeight: 650 },
    '& small': { color: 'var(--text-3)', fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    '& em': {
      justifySelf: 'end',
      borderRadius: '999px',
      padding: '3px 7px',
      color: active ? 'var(--bg)' : 'var(--text-3)',
      background: active ? 'var(--text)' : 'var(--surface-2)',
      fontSize: '9.5px',
      fontStyle: 'normal',
      fontWeight: 700,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
    },
  });
}
