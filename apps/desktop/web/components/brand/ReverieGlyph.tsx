import { css } from '../../styled-system/css';

// The Reverie symbol at hero scale, the centerpiece of the first-run panel.
// Same 32x32 path as components/chrome/ReverieMark.tsx (the titlebar mark) and
// crtLoading.tsx; here it carries the brand on its own in place of a wordmark,
// so it reads bright with a soft glow rather than the titlebar's dim presence.
export function ReverieGlyph({ size = 96 }: { size?: number }) {
  return (
    <svg
      className={glyphClass}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="Reverie"
      data-testid="reverie-glyph"
    >
      <path
        d="M20 7C20 8.10457 20.8954 9 22 9H26C27.1046 9 28 9.89543 28 11V15C28 16.1046 27.1046 17 26 17H22C20.8954 17 20 17.8954 20 19C20 20.1046 20.8954 21 22 21H26C27.1046 21 28 21.8954 28 23V27C28 28.1046 27.1046 29 26 29H22C20.8954 29 20 28.1046 20 27V25C20 23.8954 19.1046 23 18 23H10C8.89543 23 8 22.1046 8 21V17C8 15.8954 8.89543 15 10 15H18C19.1046 15 20 14.1046 20 13C20 11.8954 19.1046 11 18 11H6C4.89543 11 4 10.1046 4 9V5C4 3.89543 4.89543 3 6 3H18C19.1046 3 20 3.89543 20 5V7Z"
        fill="currentColor"
      />
    </svg>
  );
}

const glyphClass = css({
  // Warm bright white in dark, near-black in light: the same --dot-bright the
  // old wordmark lit its dots with, so the hero keeps the brand's glow.
  color: 'var(--dot-bright)',
  display: 'block',
  flexShrink: 0,
  filter: 'drop-shadow(0 0 32px color-mix(in srgb, var(--dot-bright) 13%, transparent))',
});
