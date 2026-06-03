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
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="Reverie"
      data-testid="reverie-mark"
    >
      <path
        d="M20 7C20 8.10457 20.8954 9 22 9H26C27.1046 9 28 9.89543 28 11V15C28 16.1046 27.1046 17 26 17H22C20.8954 17 20 17.8954 20 19C20 20.1046 20.8954 21 22 21H26C27.1046 21 28 21.8954 28 23V27C28 28.1046 27.1046 29 26 29H22C20.8954 29 20 28.1046 20 27V25C20 23.8954 19.1046 23 18 23H10C8.89543 23 8 22.1046 8 21V17C8 15.8954 8.89543 15 10 15H18C19.1046 15 20 14.1046 20 13C20 11.8954 19.1046 11 18 11H6C4.89543 11 4 10.1046 4 9V5C4 3.89543 4.89543 3 6 3H18C19.1046 3 20 3.89543 20 5V7Z"
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
