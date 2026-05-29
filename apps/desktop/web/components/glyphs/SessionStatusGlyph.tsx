import { css } from '../../styled-system/css';
import type { GlyphState } from '../../domain';

// The per-session status glyph: a 4x4 dot constellation whose inner 2x2 "core"
// carries live state (working breathes green, attention pulses amber, error is
// red). The breathing/pulse keyframes live in main.css and pause when the app
// is unfocused. The outer twelve dots stay quietly dim.
export function SessionStatusGlyph({ state }: { state: GlyphState }) {
  return (
    <span className={sessionGlyphClass} data-state={state} aria-hidden="true">
      {Array.from({ length: 16 }, (_, index) => {
        const row = Math.floor(index / 4);
        const col = index % 4;
        const isCore = (row === 1 || row === 2) && (col === 1 || col === 2);
        return <i key={index} data-core={isCore ? 'true' : 'false'} />;
      })}
    </span>
  );
}

const sessionGlyphClass = css({
  width: '22px',
  height: '22px',
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  gridTemplateRows: 'repeat(4, 1fr)',
  gap: '2px',
  flexShrink: 0,
  '& i': {
    borderRadius: '50%',
    background: 'var(--text-3)',
    opacity: 0.22,
    transformOrigin: '50% 50%',
  },
  '& i[data-core="true"]': {
    background: 'var(--text)',
    opacity: 0.5,
  },
  '&[data-state="working"] i[data-core="true"]': {
    background: 'var(--good)',
    animation: 'reverie-glyph-breathe 1.6s ease-in-out infinite',
  },
  '&[data-state="working"] i[data-core="true"]:nth-of-type(7)': { animationDelay: '0.10s' },
  '&[data-state="working"] i[data-core="true"]:nth-of-type(10)': { animationDelay: '0.20s' },
  '&[data-state="working"] i[data-core="true"]:nth-of-type(11)': { animationDelay: '0.30s' },
  '&[data-state="attention"] i[data-core="true"]': {
    background: 'var(--warn)',
    opacity: 1,
    animation: 'reverie-glyph-attention-pulse 1.4s ease-in-out infinite',
  },
  '&[data-state="error"] i[data-core="true"]': {
    background: 'var(--bad)',
    opacity: 1,
  },
});
