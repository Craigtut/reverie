// The session-resume bloom: the canvas island behind the "Resuming" moment.
//
// When a selected session has to wake its underlying CLI (Claude/Codex/Cortex)
// back up, there is a short, indeterminate wait while the native process
// attaches. Instead of a spinner in a box, the empty terminal surface plays a
// radial "coming back to life" bloom built from the product's signature dot
// motif: a tight core sparks outward into a breathing constellation that emits
// slow ripple halos (echoing the file-drop droplet ripple), then holds and
// breathes until the live terminal takes over.
//
// This is a SIBLING of dotField.ts, not a variant of it: dotField tiles a
// full-bleed field and animates row-bands or a radial breath, whereas this is a
// single centered bloom with an entrance ramp, a coherent outward wave, and
// expanding rings. It follows the same island conventions: DPR capped at 2, dot
// color read from the live `--text` token (so it tracks the theme, which the
// terminal surface follows), the loop stops when the tab is hidden, and
// prefers-reduced-motion renders a single static bloom with no motion. Like the
// launching field, it is a shell-level hero animation, never the ambient field,
// so a continuous loop while visible is intended.

export interface ResumeBloomHandle {
  /** Recolor dots from the current `--text` token (call after a theme change). */
  refresh(): void;
  /** Tear down the rAF loop, observers, and listeners. */
  destroy(): void;
}

interface BloomDot {
  bx: number;
  by: number;
  rho: number; // normalized distance from center, 0 (core) .. 1 (rim)
}

interface Ripple {
  t0: number;
}

const MAX_DPR = 2;
const SPACING = 26; // base gap between lattice dots
const RINGS = 3; // rows/cols out from center -> a small diamond of dots
const CLIP = SPACING * 3.15; // disc radius the bloom lives within
const PERIOD = 2800; // sustained breathing cycle (ms)
const ENTER = 1150; // one-time entrance bloom (ms)
const WAVE = 0.7 * Math.PI; // gentle outward phase lag -> a coherent shimmer
const RIPPLE_LIFE = 1600; // ms for a ring to expand and fade
const CENTER_LIFT = 56; // px the bloom sits above the surface center (copy below)
const TWO_PI = Math.PI * 2;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const breath = (p: number) => 0.5 - 0.5 * Math.cos(p); // smooth 0..1
const easeOut = (t: number) => 1 - (1 - t) ** 3;

export function createResumeBloom(canvas: HTMLCanvasElement): ResumeBloomHandle {
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('Canvas 2D context is unavailable');
  const ctx: CanvasRenderingContext2D = context;

  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const reducedMotionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reducedMotion = reducedMotionMq.matches;

  let cssWidth = 0;
  let cssHeight = 0;
  let raf = 0;
  let startedAt = performance.now();
  let hidden = document.visibilityState === 'hidden';
  let color = { r: 239, g: 233, b: 223 };
  const ripples: Ripple[] = [];
  let lastRippleKey = '';

  // The lattice is fixed: offset ("brick") rows clipped to a disc, sorted core
  // first so the entrance can fan dots out from the center.
  const dots: BloomDot[] = [];
  for (let r = -RINGS - 1; r <= RINGS + 1; r++) {
    for (let c = -RINGS - 1; c <= RINGS + 1; c++) {
      const ox = r & 1 ? SPACING / 2 : 0;
      const bx = c * SPACING + ox;
      const by = r * SPACING;
      const dist = Math.hypot(bx, by);
      if (dist > CLIP) continue;
      dots.push({ bx, by, rho: dist / CLIP });
    }
  }
  dots.sort((a, b) => a.rho - b.rho);
  const rhoMax = dots.reduce((m, d) => Math.max(m, d.rho), 0) || 1;

  function readDotColor() {
    const value = getComputedStyle(canvas).getPropertyValue('--text').trim();
    color = parseHex(value) ?? { r: 239, g: 233, b: 223 };
  }

  function parseHex(value: string): { r: number; g: number; b: number } | null {
    if (!value.startsWith('#')) return null;
    let hex = value.slice(1);
    if (hex.length === 3)
      hex = hex
        .split('')
        .map(ch => ch + ch)
        .join('');
    if (hex.length !== 6) return null;
    const n = parseInt(hex, 16);
    if (Number.isNaN(n)) return null;
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    cssWidth = rect.width;
    cssHeight = rect.height;
    canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
    canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (reducedMotion) drawFrame(startedAt); // static: paint once at the resting bloom
  }

  function drawFrame(nowAbs: number) {
    if (cssWidth === 0) return;
    const now = nowAbs - startedAt;
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const cx = cssWidth / 2;
    const cy = cssHeight / 2 - CENTER_LIFT;

    // entrance ramps the field in once; reduced motion jumps straight to bloomed
    const enter = reducedMotion ? 1 : easeOut(clamp01(now / ENTER));
    const phase = reducedMotion ? Math.PI / 2 : ((now / PERIOD) % 1) * TWO_PI;
    const g = breath(phase);
    const breathAmp = enter;
    const spread = reducedMotion ? 1 : lerp(1, lerp(0.96, 1.08, g), breathAmp);

    // ripples: one as the field arrives, then one at each breath peak
    if (!reducedMotion) {
      const cycle = Math.floor(now / PERIOD);
      if (now > ENTER * 0.55 && lastRippleKey === '') {
        ripples.push({ t0: now });
        lastRippleKey = 'enter';
      }
      if (g > 0.5 && lastRippleKey !== 'c' + cycle) {
        ripples.push({ t0: now });
        lastRippleKey = 'c' + cycle;
      }
    }

    ctx.save();
    ctx.translate(cx, cy);

    for (let i = ripples.length - 1; i >= 0; i--) {
      const age = (now - ripples[i].t0) / RIPPLE_LIFE;
      if (age >= 1 || age < 0) {
        ripples.splice(i, 1);
        continue;
      }
      const rad = lerp(SPACING * 0.5, CLIP * 1.85, easeOut(age));
      ctx.beginPath();
      ctx.arc(0, 0, rad, 0, TWO_PI);
      ctx.strokeStyle = `rgba(${color.r},${color.g},${color.b},${(1 - age) * 0.15})`;
      ctx.lineWidth = lerp(1.5, 0.4, age);
      ctx.stroke();
    }

    for (const d of dots) {
      const rn = d.rho / rhoMax;
      // outer dots arrive a beat later, so the field grows outward into life
      const appear = reducedMotion ? 1 : easeOut(clamp01((enter - rn * 0.35) / 0.65));
      const posScale = lerp(0.3, 1, appear);
      const local = breath(phase - d.rho * WAVE);
      const base = lerp(3.0, 1.3, rn);
      const size = base * lerp(0.85, 1.15, local) * lerp(0.4, 1, appear);
      const a0 = lerp(0.95, 0.4, rn ** 0.8);
      const shimmer = lerp(1, lerp(0.78, 1, local), breathAmp);
      const alpha = clamp01(a0 * shimmer * appear);
      if (size <= 0.2 || alpha <= 0.01) continue;
      ctx.beginPath();
      ctx.arc(d.bx * spread * posScale, d.by * spread * posScale, size, 0, TWO_PI);
      ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${alpha})`;
      ctx.fill();
    }
    ctx.restore();
  }

  function loop(now: number) {
    raf = 0;
    if (hidden || reducedMotion) return;
    drawFrame(now);
    raf = requestAnimationFrame(loop);
  }

  function start() {
    if (hidden) return;
    if (reducedMotion) {
      drawFrame(startedAt);
      return;
    }
    if (!raf) raf = requestAnimationFrame(loop);
  }

  function stop() {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  function onVisibility() {
    const nowHidden = document.visibilityState === 'hidden';
    if (nowHidden === hidden) return;
    hidden = nowHidden;
    if (hidden) {
      stop();
    } else {
      // Re-anchor the entrance so it does not fast-forward through the time the
      // tab spent in the background; resume the bloom from a fresh spark.
      startedAt = performance.now();
      ripples.length = 0;
      lastRippleKey = '';
      start();
    }
  }

  function onReducedMotion(event: MediaQueryListEvent) {
    reducedMotion = event.matches;
    stop();
    ripples.length = 0;
    lastRippleKey = '';
    startedAt = performance.now();
    start();
  }

  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => resize());
    ro.observe(canvas);
  } else {
    window.addEventListener('resize', resize);
  }
  document.addEventListener('visibilitychange', onVisibility);
  reducedMotionMq.addEventListener('change', onReducedMotion);

  readDotColor();
  resize();
  start();

  return {
    refresh() {
      readDotColor();
      if (reducedMotion) drawFrame(startedAt);
    },
    destroy() {
      stop();
      ro?.disconnect();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      reducedMotionMq.removeEventListener('change', onReducedMotion);
    },
  };
}
