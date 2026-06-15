import { css } from '../../styled-system/css';

// The close (X) glyph used by the session tabs' close control. Two rounded
// stroke <line>s crossed at center, matching the tab chrome's weight. Color
// comes from the surrounding currentColor.
export function CloseGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg
      className={closeGlyphClass}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

const closeGlyphClass = css({
  display: 'block',
  '& line': {
    strokeWidth: 2,
    strokeLinecap: 'round',
  },
});
