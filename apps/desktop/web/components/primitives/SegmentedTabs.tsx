import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  motion,
  useMotionTemplate,
  useReducedMotion,
  useSpring,
  useTransform,
  useVelocity,
  type MotionValue,
} from 'motion/react';

import { css, cx } from '../../styled-system/css';
import { Typography } from './Typography';

export interface SegmentedTabItem<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
}

// The measured box of a tab button within the track. Drives where the lit pill
// sits and how wide it is, and (via the center) how the light pools over each
// label as the pill passes.
interface TabGeom {
  left: number;
  width: number;
  top: number;
  height: number;
}

// Travel speed (px/s) at which the motion reads as "moving fast": fullest
// stretch, brightest rim and glow. Tuned for the short hops this control spans,
// so even a quick neighbor change feels lively without the long throws blowing
// past the ceiling.
const MAX_VELOCITY = 1900;

// How far (px) from the pill's center a label still catches its light. Kept
// under one tab's spacing so neighbors sit dim at rest and a label only blooms
// as the pill's light sweeps directly across it mid-glide.
const LABEL_FALLOFF = 50;

// A reusable segmented control for switching between sibling views (e.g. the
// Settings sections). The active state is a single "pebble of warm light" that
// glides between tabs in the app's rim-lit panel language: a soft conic rim that
// is brightest at the top-left at rest and rotates its bright point toward the
// leading edge as it travels, a gentle squash-and-stretch along the direction of
// motion, and a warm glow that blooms while moving and settles when it lands.
// The pill's own velocity drives every one of those, so the lighting reacts to
// how far and how fast you jump. Presentational: the caller owns the selected id.
export function SegmentedTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  idBase,
  className,
}: {
  tabs: SegmentedTabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  // When set, wires aria so each tab points at `${idBase}-panel-${id}`.
  idBase?: string;
  className?: string;
}) {
  const reduced = useReducedMotion() ?? false;

  const trackRef = useRef<HTMLDivElement>(null);
  const tabEls = useRef(new Map<T, HTMLButtonElement>());
  const [geoms, setGeoms] = useState<Record<string, TabGeom>>({});
  // Until the first measurement lands, the pill snaps to position instead of
  // flying in from the origin; after that, every move animates.
  const positioned = useRef(false);

  const tabsKey = tabs.map(tab => tab.id).join('|');
  const activeGeom = geoms[value];

  // The pill rides two springs: x (its left edge) and width. Springing the width
  // too lets it morph smoothly when neighboring tabs differ in size. Tuned snappy
  // and overshoot-free (critically damped) so the glide is quick but never bouncy;
  // reduced motion is quicker still.
  const springConfig = reduced
    ? { stiffness: 820, damping: 96, mass: 0.5 }
    : { stiffness: 680, damping: 39, mass: 0.55 };
  const x = useSpring(0, springConfig);
  const width = useSpring(0, springConfig);

  // Measure every tab box relative to the track, and re-measure when the tab set
  // changes or the track resizes (font load, window resize, a scrollbar gutter
  // appearing). The pill reads its target geometry from this.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tabsKey stands in for the tabs array identity.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => {
      const next: Record<string, TabGeom> = {};
      for (const tab of tabs) {
        const el = tabEls.current.get(tab.id);
        if (!el) continue;
        next[tab.id] = {
          left: el.offsetLeft,
          width: el.offsetWidth,
          top: el.offsetTop,
          height: el.offsetHeight,
        };
      }
      setGeoms(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [tabsKey]);

  // Drive the springs to the active tab. The first positioned frame jumps (no
  // animation) so the pill is simply there on mount; subsequent changes glide.
  const activeLeft = activeGeom?.left ?? 0;
  const activeWidth = activeGeom?.width ?? 0;
  useLayoutEffect(() => {
    if (!activeGeom) return;
    if (!positioned.current) {
      x.jump(activeLeft);
      width.jump(activeWidth);
      positioned.current = true;
    } else {
      x.set(activeLeft);
      width.set(activeWidth);
    }
  }, [activeGeom, activeLeft, activeWidth, x, width]);

  // Speed in 0..1, lightly smoothed so the lighting doesn't flicker frame to
  // frame. Everything "alive" about the pill hangs off this.
  const velocity = useVelocity(x);
  const speedRaw = useTransform(velocity, v =>
    reduced ? 0 : Math.min(Math.abs(v) / MAX_VELOCITY, 1),
  );
  const speed = useSpring(speedRaw, { stiffness: 330, damping: 26, mass: 0.32 });

  // Squash & stretch along the travel axis: up to +7% wider while moving fast,
  // back to 1 at rest. transformOrigin is centered so it reads as momentum, not
  // a drift.
  const scaleX = useTransform(speed, s => 1 + s * 0.07);

  // Fill warms from the calm chip surface toward the lifted one as it moves.
  const fillMix = useTransform(speed, s => s * 100);
  const fill = useMotionTemplate`color-mix(in srgb, var(--surface-hi) ${fillMix}%, var(--surface-3))`;

  // Warm glow blooms with speed: a soft halo plus a faint grounding shadow.
  const glowAlpha = useTransform(speed, s => 0.1 + s * 0.28);
  const glow = useMotionTemplate`0 8px 24px -12px rgb(var(--seg-glow) / ${glowAlpha}), 0 1px 2px 0 rgb(0 0 0 / 0.18)`;

  // The bright arc of the rim rests at the top-left (matching the panels) and
  // rotates toward the leading edge as the pill travels: light catching the rim.
  const rimDeg = useTransform(velocity, v => {
    if (reduced) return 198;
    return 198 + Math.max(-1, Math.min(1, v / MAX_VELOCITY)) * 48;
  });
  const rimFrom = useMotionTemplate`${rimDeg}deg`;

  // The pill's center, so each label can read its distance and warm accordingly.
  const pillCenter = useTransform([x, width], ([xv, wv]: number[]) => xv + wv / 2);

  return (
    <div ref={trackRef} className={cx(groupClass, className)} role="tablist" aria-label={ariaLabel}>
      <motion.span
        aria-hidden
        className={pillClass}
        initial={false}
        animate={{ opacity: activeGeom ? 1 : 0 }}
        transition={{ opacity: { duration: 0.18, ease: 'easeOut' } }}
        style={{
          x,
          width,
          scaleX,
          top: activeGeom?.top ?? 0,
          height: activeGeom?.height ?? 0,
          backgroundColor: fill,
          boxShadow: glow,
          ['--seg-rim-from' as string]: rimFrom,
        }}
      >
        <span className={pillRimClass} />
        <span className={pillSheenClass} />
      </motion.span>

      {tabs.map(tab => {
        const active = tab.id === value;
        const geom = geoms[tab.id];
        return (
          <button
            key={tab.id}
            ref={el => {
              if (el) tabEls.current.set(tab.id, el);
              else tabEls.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            id={idBase ? `${idBase}-tab-${tab.id}` : undefined}
            aria-selected={active}
            aria-controls={idBase ? `${idBase}-panel-${tab.id}` : undefined}
            data-active={active}
            data-testid={`segmented-tab-${tab.id}`}
            className={tabClass}
            onClick={() => onChange(tab.id)}
          >
            <TabLabel
              pillCenter={pillCenter}
              center={geom ? geom.left + geom.width / 2 : Number.NaN}
              active={active}
              reduced={reduced}
            >
              {tab.icon}
              <Typography as="span" variant="caption" tone="inherit">
                {tab.label}
              </Typography>
            </TabLabel>
          </button>
        );
      })}
    </div>
  );
}

// A tab's label, lit by the passing pill. Its color crossfades from the muted
// ramp toward full-strength text as the pill's center nears its own, so the
// light visibly sweeps across the labels while the pill glides. The icon
// inherits the same animated color. Under reduced motion it just tracks the
// active state with a plain transition.
function TabLabel({
  pillCenter,
  center,
  active,
  reduced,
  children,
}: {
  pillCenter: MotionValue<number>;
  center: number;
  active: boolean;
  reduced: boolean;
  children: ReactNode;
}) {
  const litPct = useTransform(pillCenter, c => {
    if (!Number.isFinite(center)) return active ? 100 : 0;
    const t = 1 - Math.abs(c - center) / LABEL_FALLOFF;
    return Math.max(0, Math.min(1, t)) * 100;
  });
  const color = useMotionTemplate`color-mix(in srgb, var(--text) ${litPct}%, var(--text-3))`;

  if (reduced) {
    return (
      <span className={labelClass} style={{ color: active ? 'var(--text)' : 'var(--text-3)' }}>
        {children}
      </span>
    );
  }
  return (
    <motion.span className={labelClass} style={{ color }}>
      {children}
    </motion.span>
  );
}

const groupClass = css({
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '2px',
  padding: '3px',
  borderRadius: '999px',
  border: '1px solid var(--line)',
  background: 'color-mix(in srgb, var(--surface-1) 80%, transparent)',
  // Warm-light channels for the pill's glow and sheen, kept as raw RGB triples
  // so the motion layer can interpolate alpha. Light mode leans brighter/cooler.
  '--seg-glow': '255 244 228',
  '[data-theme="light"] &': { '--seg-glow': '255 252 245' },
});

// The gliding pill. It sits behind the labels (zIndex 0) and never takes
// pointer events. overflow:hidden clips the inner sheen/rim to the pill radius;
// the outer glow is a box-shadow, so it still blooms past the edge.
const pillClass = css({
  position: 'absolute',
  left: 0,
  zIndex: 0,
  borderRadius: '999px',
  overflow: 'hidden',
  pointerEvents: 'none',
  transformOrigin: 'center',
  willChange: 'transform, width',
});

// The conic rim border, drawn with the panel rim-light gradient and masked to a
// 1px ring. `--seg-rim-from` (animated by the pill) rotates the bright arc
// toward the leading edge as it moves; at rest it rests top-left.
const pillRimClass = css({
  position: 'absolute',
  inset: 0,
  borderRadius: 'inherit',
  padding: '1px',
  background:
    'conic-gradient(from var(--seg-rim-from, 198deg) at 30% 20%, var(--rim-2) 0deg, var(--rim-2) 60deg, var(--rim-1) 145deg, var(--rim-1) 190deg, var(--rim-2) 260deg, var(--rim-2) 360deg)',
  WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
  WebkitMaskComposite: 'xor',
  maskComposite: 'exclude',
  pointerEvents: 'none',
});

// A soft top-left sheen inside the pill, the faint inner glow the panels carry.
const pillSheenClass = css({
  position: 'absolute',
  inset: 0,
  borderRadius: 'inherit',
  background: 'radial-gradient(120% 85% at 28% -15%, rgb(var(--seg-glow) / 0.18), transparent 62%)',
  pointerEvents: 'none',
});

const tabClass = css({
  position: 'relative',
  zIndex: 1,
  display: 'inline-flex',
  alignItems: 'center',
  height: '28px',
  padding: '0 14px',
  borderRadius: '999px',
  border: '0',
  background: 'transparent',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  _focusVisible: {
    outline: 'none',
    boxShadow: '0 0 0 3px color-mix(in srgb, var(--text) 8%, transparent)',
  },
});

const labelClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  color: 'var(--text-3)',
  transition: 'color 160ms ease',
  '& svg': { color: 'currentcolor' },
});
