import type { ReactNode } from 'react';
import { css } from '../../styled-system/css';
import type { CellSessionState } from '../../domain';

// The CLI's own logo, shown beside session titles so the agent behind a session
// is instantly recognizable (and parallel sessions of different CLIs stay easy
// to tell apart). Claude, Codex, and Cortex all use their real brand marks.
//
// Sizing is driven by the wrapping <span>: 14px by default, overridable by a
// parent (e.g. the creation composer lifts it to 22px via `> span:first-child`).
// The inner SVG always fills that box.
//
// `state` (optional) modulates the mark in the nav so a live session stands out:
// only an `active` (working) session shows its full brand color (Claude clay,
// Cortex lime, Codex white); every at-rest state stays the muted icon gray it
// inherits from the row, and the opacity tier below dims it (idle recedes most,
// fresh sits at a quiet baseline, finished stays present). Consumers that pass no
// `state` (the tab bar, dashboard, composer) render at full brand color.
export function AgentGlyph({ kind, state }: { kind: string; state?: CellSessionState }) {
  const brand = BRAND[kind] ?? CORTEX_PLACEHOLDER;
  const opacity = state ? GLYPH_PRESENCE[state] : 1;
  // Assert the brand color only when the glyph should be colored: a working
  // session, or any consumer that passes no state. Otherwise leave the svg
  // uncolored so it inherits the row's muted gray. When colored, the color is set
  // inline on the <svg> itself so it wins over ancestor "& svg { color }" rules
  // (e.g. the nav row's icon color) that would otherwise capture the mark via
  // `fill="currentColor"` and gray it out.
  const colored = !state || state === 'active';
  return (
    <span className={glyphClass} style={{ opacity }} aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        style={colored ? { color: brand.color } : undefined}
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {brand.mark}
      </svg>
    </span>
  );
}

// Presence tiers for the mark. Anything live, awaiting the user, or finished and
// ready for review stays at full color so it pops in the rail; an idle session
// (run, seen, now at rest) fades the most; a fresh session keeps a quiet,
// in-between presence.
const GLYPH_PRESENCE: Record<CellSessionState, number> = {
  active: 1,
  attention: 1,
  error: 1,
  finished: 1,
  fresh: 0.55,
  idle: 0.32,
};

type Brand = { color: string; mark: ReactNode };

const BRAND: Record<string, Brand> = {
  // Claude's sunburst, in Claude clay.
  claude_code: {
    color: '#D97757',
    mark: <path fill="currentColor" d={CLAUDE_PATH()} />,
  },
  // Codex's own mark, in the primary text color so it reads crisp in both
  // light and dark themes.
  codex_cli: {
    color: 'var(--text)',
    mark: <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d={CODEX_PATH()} />,
  },
  // Cortex's double-chevron, in its brand lime. The source mark is drawn in a
  // 32-unit box, so it's scaled to fit this component's shared 24-unit viewBox.
  cortex_code: {
    color: '#B8E23E',
    mark: (
      <g fill="currentColor" transform="scale(0.75)">
        <path d={CORTEX_PATH_LEFT()} />
        <path d={CORTEX_PATH_RIGHT()} />
      </g>
    ),
  },
};

// Fallback for any CLI without a brand mark: a framed dot that nods to Reverie's
// dot field.
const CORTEX_PLACEHOLDER: Brand = {
  color: 'var(--good)',
  mark: (
    <>
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="12" cy="12" r="3.4" fill="currentColor" />
    </>
  ),
};

const glyphClass = css({
  width: '14px',
  height: '14px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  // Ease the presence shift when a session moves between states (e.g. active ->
  // idle) so the mark settles rather than snapping.
  transition: 'opacity 200ms ease',
  '& svg': { width: '100%', height: '100%', display: 'block' },
});

// Brand paths are kept in functions so the long `d` strings stay out of the
// component body. viewBox is 0 0 24 24 for all three.
function CLAUDE_PATH() {
  return 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z';
}

function CODEX_PATH() {
  return 'M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z';
}

function CORTEX_PATH_LEFT() {
  return 'M13.7071 21.7071C13.8946 21.8946 14 22.149 14 22.4142V28.0343C14 28.3907 13.5691 28.5691 13.3172 28.3172L1.70711 16.7071C1.31658 16.3166 1.31658 15.6834 1.70711 15.2929L13.3172 3.68284C13.5691 3.43086 14 3.60932 14 3.96569V9.58579C14 9.851 13.8946 10.1054 13.7071 10.2929L8 16L13.7071 21.7071Z';
}

function CORTEX_PATH_RIGHT() {
  return 'M18.2929 21.7071C18.1054 21.8946 18 22.149 18 22.4142V28.0343C18 28.3907 18.4309 28.5691 18.6828 28.3172L30.2929 16.7071C30.6834 16.3166 30.6834 15.6834 30.2929 15.2929L18.6828 3.68284C18.4309 3.43086 18 3.60932 18 3.96569V9.58579C18 9.851 18.1054 10.1054 18.2929 10.2929L24 16L18.2929 21.7071Z';
}
