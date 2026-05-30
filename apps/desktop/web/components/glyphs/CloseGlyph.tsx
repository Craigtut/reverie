import { css } from '../../styled-system/css';

// The close (X) glyph used by the hover-revealed actions in the left nav and the
// session tabs. Unlike Phosphor's X (a single filled path), this is two separate
// stroke <line>s so each diagonal can animate on its own: when the X is revealed
// on hover, the strokes swing into the crossed position as a quick two-beat. The
// top-left -> bottom-right stroke ("lead") lands first; the other ("trail")
// follows a beat later. The motion is owned by the consumer's hover rule (which
// also reveals the action), keyed off the data-x-line attributes below. Color
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
      <line data-x-line="lead" x1="5" y1="5" x2="19" y2="19" />
      <line data-x-line="trail" x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

const closeGlyphClass = css({
  display: 'block',
  // Let the strokes swing/translate slightly past the viewBox during the
  // entrance without clipping at the svg edge.
  overflow: 'visible',
  '& line': {
    strokeWidth: 2,
    strokeLinecap: 'round',
    // Pivot/scale each stroke about its own midpoint (the shared center of the
    // X), so the entrance reads as the two lines settling into the cross.
    transformBox: 'fill-box',
    transformOrigin: 'center',
  },
});
