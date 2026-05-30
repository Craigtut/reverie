import { css } from '../../styled-system/css';

// The Reverie wordmark glyph, sat in the titlebar's upper-right to balance the
// traffic lights on the left. Inline SVG (the project's icon convention) so it
// inherits color: it reads as the warm off-white --text in dark mode and the
// near-black --text in light mode, staying legible in both.
export function ReverieMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      className={markClass}
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      role="img"
      aria-label="Reverie"
      data-testid="reverie-mark"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M22 2C26.4183 2 30 5.58172 30 10C30 14.4183 26.4183 18 22 18C26.4183 18 30 21.5817 30 26V33C30 33.5523 29.5523 34 29 34H23C22.4477 34 22 33.5523 22 33V27C22 26.4477 21.5523 26 21 26H15C14.4477 26 14 26.4477 14 27V33C14 33.5523 13.5523 34 13 34H7C6.44772 34 6 33.5523 6 33V27C6 26.4477 6.44772 26 7 26H13C13.5523 26 14 25.5523 14 25V19C14 18.4477 13.5523 18 13 18H7C6.44772 18 6 17.5523 6 17V11C6 10.4477 6.44772 10 7 10H13C13.5523 10 14 9.55228 14 9V3C14 2.44772 14.4477 2 15 2H22ZM15 10C14.4477 10 14 10.4477 14 11V17C14 17.5523 14.4477 18 15 18H21C21.5523 18 22 17.5523 22 17V11C22 10.4477 21.5523 10 21 10H15Z"
        fill="currentColor"
      />
    </svg>
  );
}

const markClass = css({
  // Warm white (--text is #EFE9DF in dark, near-black in light), held at a
  // low opacity so the mark reads as a subtle presence rather than a logo.
  color: 'var(--text)',
  opacity: 0.32,
  flexShrink: 0,
  display: 'block',
});
