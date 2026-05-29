import { css } from '../../styled-system/css';

// The 4x4 dot brand glyph shown in the titlebar.
export function BrandMark() {
  return (
    <span className={brandMarkClass} aria-hidden="true">
      {[true, true, true, false, true, false, true, false, true, true, false, false, true, false, true, false].map((on, index) => (
        <i key={index} data-on={on ? 'true' : 'false'} />
      ))}
    </span>
  );
}

const brandMarkClass = css({
  width: '18px',
  height: '18px',
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  gridTemplateRows: 'repeat(4, 1fr)',
  gap: '1.5px',
  '& i': {
    background: 'var(--dot-ambient)',
    borderRadius: '0.5px',
    opacity: 0.35,
  },
  '& i[data-on="true"]': {
    opacity: 1,
    background: 'var(--text)',
  },
});
