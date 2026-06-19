// The retro CRT loading sequences: a shell-level canvas island that draws its
// content (the boot symbol + a blocky progress bar, or a breathing dot
// constellation for resume) on a 2D canvas, pipes it through the shared CRT pass
// at the boot preset, and animates with a rAF loop. This is the ONE place the
// time-driven CRT layers (bloom, scanlines, mask, grain, flicker) run, and only
// here because it is a deliberate shell-level moment, never the live terminal.
//
// Like resumeBloom.ts it follows the island conventions: DPR capped at 2, color
// read from the live `--text` token, the loop stops when the tab is hidden, and
// prefers-reduced-motion renders a single static frame with no motion.

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { css } from './styled-system/css';
import { useUiStore } from './store';
import { appRuntimeMode } from './services/runtime';
import {
  CRT_BOOT_PRESET,
  createCrtPass,
  type CrtParams,
  type CrtPass,
  type PremultipliedColor,
} from './terminalCrt';

const MAX_DPR = 2;
// The Reverie mark, same path as components/chrome/ReverieMark.tsx (32x32 box).
const MARK_PATH =
  'M20 7C20 8.10457 20.8954 9 22 9H26C27.1046 9 28 9.89543 28 11V15C28 16.1046 27.1046 17 26 17H22C20.8954 17 20 17.8954 20 19C20 20.1046 20.8954 21 22 21H26C27.1046 21 28 21.8954 28 23V27C28 28.1046 27.1046 29 26 29H22C20.8954 29 20 28.1046 20 27V25C20 23.8954 19.1046 23 18 23H10C8.89543 23 8 22.1046 8 21V17C8 15.8954 8.89543 15 10 15H18C19.1046 15 20 14.1046 20 13C20 11.8954 19.1046 11 18 11H6C4.89543 11 4 10.1046 4 9V5C4 3.89543 4.89543 3 6 3H18C19.1046 3 20 3.89543 20 5V7Z';
const markPath = new Path2D(MARK_PATH);

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(value: string): Rgb | null {
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

function parseRgb(value: string, fallback: Rgb): Rgb {
  const match = value.match(/(\d+(?:\.\d+)?)/g);
  if (!match || match.length < 3) return fallback;
  return { r: Number(match[0]), g: Number(match[1]), b: Number(match[2]) };
}

function readTextColor(canvas: HTMLElement): Rgb {
  const fallback: Rgb = { r: 232, g: 225, b: 215 };
  if (typeof window === 'undefined') return fallback;
  // `--text` is declared as a hex literal and custom properties are NOT resolved
  // to rgb() by getComputedStyle, so parse hex first (the regex path only caught
  // the digits in a hex string and silently fell back to a fixed warm-white,
  // which is why the resume bloom never tracked the theme). Keep the rgb() path
  // as a defensive fallback in case the token form ever changes.
  const token = getComputedStyle(canvas).getPropertyValue('--text').trim();
  return parseHex(token) ?? parseRgb(token, fallback);
}

function cssRgb(c: Rgb, alpha = 1): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
}

// Draw the boot frame: the mark above a retro blocky square progress bar, on the
// terminal background. `progress` is 0..1; `t` is seconds for the idle shimmer.
function drawBoot(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  progress: number,
  t: number,
  fg: Rgb,
) {
  ctx.save();
  // Transparent background: only the mark + bar are painted, so the canvas
  // blends with whatever is behind it (the grain/bloom ride only the painted
  // pixels, never a full-canvas rectangle).
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;

  // The mark, scaled from its 32-unit box, centered above the bar. A gentle
  // breathing alpha gives the phosphor some life before the bloom warms it.
  const markSize = Math.min(w, h) * 0.26;
  const breathe = 0.82 + 0.18 * Math.sin(t * 2.2);
  ctx.save();
  ctx.translate(cx - markSize / 2, cy - markSize / 2 - markSize * 0.55);
  ctx.scale(markSize / 32, markSize / 32);
  ctx.fillStyle = cssRgb(fg, breathe);
  ctx.fill(markPath);
  ctx.restore();

  // Retro blocky progress bar: a row of square cells that fill left to right.
  const cells = 16;
  const barWidth = Math.min(w * 0.42, 360);
  const gap = Math.max(2, barWidth * 0.012);
  const cell = (barWidth - gap * (cells - 1)) / cells;
  const barX = cx - barWidth / 2;
  const barY = cy + markSize * 0.7;
  const filled = Math.floor(progress * cells + 0.001);
  for (let i = 0; i < cells; i += 1) {
    const x = barX + i * (cell + gap);
    if (i < filled) {
      ctx.fillStyle = cssRgb(fg, 0.95);
      ctx.fillRect(x, barY, cell, cell);
    } else {
      ctx.fillStyle = cssRgb(fg, 0.16);
      ctx.fillRect(x, barY, cell, cell);
    }
  }
  ctx.restore();
}

// The resume bloom: a port of the original ResumeBloom island (resumeBloom.ts),
// re-expressed on this 2D scratch canvas so the CRT warp/bloom/scanlines apply.
// It is a single, compact, FIXED-SIZE constellation (not a viewport-scaled
// field): a tight disc lattice of brick-offset dots, core dots larger + brighter
// than the rim, that fans out from the center on entry, then breathes with a
// phase-lag shimmer and emits a slow ripple halo on each breath peak. All sizes
// are CSS px multiplied by `dpr` at draw time so the bloom stays the same on-
// screen size regardless of terminal dimensions (the old field grew with the
// window, which read as huge and sparse).
const BLOOM_SPACING = 26; // base gap between lattice dots (CSS px)
const BLOOM_RINGS = 3; // rows/cols out from center -> a small diamond of dots
const BLOOM_CLIP = BLOOM_SPACING * 3.15; // disc radius the bloom lives within
const BLOOM_PERIOD = 2800; // sustained breathing cycle (ms)
const BLOOM_ENTER = 1150; // one-time entrance bloom (ms)
const BLOOM_WAVE = 0.7 * Math.PI; // gentle outward phase lag -> a coherent shimmer
const BLOOM_RIPPLE_LIFE = 1600; // ms for a ring to expand and fade
const BLOOM_LIFT = 52; // px the bloom sits above the surface center (copy below)
const TWO_PI = Math.PI * 2;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const breathCurve = (p: number) => 0.5 - 0.5 * Math.cos(p); // smooth 0..1
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

interface BloomDot {
  bx: number;
  by: number;
  rho: number; // normalized distance from center, 0 (core) .. 1 (rim)
}

// The lattice is fixed: offset ("brick") rows clipped to a disc, sorted core
// first so the entrance can fan dots out from the center. Built once (CSS units).
const BLOOM_LATTICE: BloomDot[] = (() => {
  const dots: BloomDot[] = [];
  for (let r = -BLOOM_RINGS - 1; r <= BLOOM_RINGS + 1; r += 1) {
    for (let c = -BLOOM_RINGS - 1; c <= BLOOM_RINGS + 1; c += 1) {
      const ox = r & 1 ? BLOOM_SPACING / 2 : 0;
      const bx = c * BLOOM_SPACING + ox;
      const by = r * BLOOM_SPACING;
      const dist = Math.hypot(bx, by);
      if (dist > BLOOM_CLIP) continue;
      dots.push({ bx, by, rho: dist / BLOOM_CLIP });
    }
  }
  dots.sort((a, b) => a.rho - b.rho);
  return dots;
})();
const BLOOM_RHO_MAX = BLOOM_LATTICE.reduce((m, d) => Math.max(m, d.rho), 0) || 1;

// Per-mount state the bloom carries across frames: the live ripple rings, and
// the key that gates emitting exactly one ring per breath cycle.
interface BloomScene {
  ripples: { t0: number }[];
  rippleState: { lastKey: string };
}

// Draw the resume frame: the bloom constellation with the action word + session
// title drawn INTO the canvas below it so the warp/bloom/scanlines apply to the
// text too (instead of a flat DOM label floating over the effect). `reduced`
// paints a single resting bloom with no motion.
function drawBreathing(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  dpr: number,
  fg: Rgb,
  text: { label?: string; sublabel?: string },
  scene: BloomScene,
  reduced: boolean,
) {
  ctx.clearRect(0, 0, w, h);
  const now = t * 1000; // ms since the bloom started
  const cx = w / 2;
  // Lift the bloom above the surface center so the label + title sit below it.
  const cy = h / 2 - BLOOM_LIFT * dpr;

  // Entrance ramps the field in once; reduced motion jumps straight to bloomed.
  const enter = reduced ? 1 : easeOutCubic(clamp01(now / BLOOM_ENTER));
  const phase = reduced ? Math.PI / 2 : ((now / BLOOM_PERIOD) % 1) * TWO_PI;
  const g = breathCurve(phase);
  const breathAmp = enter;
  const spread = reduced ? 1 : lerp(1, lerp(0.96, 1.08, g), breathAmp);
  // Intro envelope for the text: ramp its alpha up from zero over the first
  // ~0.6s. The WebGL context takes ~40-60ms to init, so the first frame lands
  // part-way into the container fade; driving the fade from the content itself
  // keeps the copy from popping in mid-bright. The dots have their own entrance.
  const introEased = reduced ? 1 : easeOutCubic(clamp01(now / 600));

  // Ripples: one as the field arrives, then one at each breath peak.
  const { ripples, rippleState } = scene;
  if (!reduced) {
    const cycle = Math.floor(now / BLOOM_PERIOD);
    if (now > BLOOM_ENTER * 0.55 && rippleState.lastKey === '') {
      ripples.push({ t0: now });
      rippleState.lastKey = 'enter';
    }
    if (g > 0.5 && rippleState.lastKey !== `c${cycle}`) {
      ripples.push({ t0: now });
      rippleState.lastKey = `c${cycle}`;
    }
  }

  ctx.save();
  ctx.translate(cx, cy);

  // The subtle ring(s) that pulse out from the core.
  for (let i = ripples.length - 1; i >= 0; i -= 1) {
    const age = (now - ripples[i].t0) / BLOOM_RIPPLE_LIFE;
    if (age >= 1 || age < 0) {
      ripples.splice(i, 1);
      continue;
    }
    const rad = lerp(BLOOM_SPACING * 0.5, BLOOM_CLIP * 1.85, easeOutCubic(age)) * dpr;
    ctx.beginPath();
    ctx.arc(0, 0, rad, 0, TWO_PI);
    ctx.strokeStyle = cssRgb(fg, (1 - age) * 0.15);
    ctx.lineWidth = lerp(1.5, 0.4, age) * dpr;
    ctx.stroke();
  }

  // The dots: core larger + brighter than the rim, outer dots arriving a beat
  // later so the field grows outward into life.
  for (const d of BLOOM_LATTICE) {
    const rn = d.rho / BLOOM_RHO_MAX;
    const appear = reduced ? 1 : easeOutCubic(clamp01((enter - rn * 0.35) / 0.65));
    const posScale = lerp(0.3, 1, appear);
    const local = breathCurve(phase - d.rho * BLOOM_WAVE);
    const base = lerp(3.0, 1.3, rn);
    const size = base * lerp(0.85, 1.15, local) * lerp(0.4, 1, appear);
    const a0 = lerp(0.95, 0.4, rn ** 0.8);
    const shimmer = lerp(1, lerp(0.78, 1, local), breathAmp);
    const alpha = clamp01(a0 * shimmer * appear);
    if (size <= 0.2 || alpha <= 0.01) continue;
    ctx.beginPath();
    ctx.arc(d.bx * spread * posScale * dpr, d.by * spread * posScale * dpr, size * dpr, 0, TWO_PI);
    ctx.fillStyle = cssRgb(fg, alpha);
    ctx.fill();
  }
  ctx.restore();

  // The action word + title, sized to match the old DOM copy (title2 / smallBody)
  // and placed just below the bloom rather than scaled to the viewport.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelTop = h / 2 + 40 * dpr;
  if (text.label) {
    ctx.font = `600 ${28 * dpr}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
    // A whisper of breath so the word feels alive with the dots, but mostly steady.
    ctx.fillStyle = cssRgb(fg, (0.88 + 0.06 * g) * introEased);
    ctx.fillText(text.label, cx, labelTop);
  }
  if (text.sublabel) {
    ctx.font = `400 ${14 * dpr}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.fillStyle = cssRgb(fg, 0.42 * introEased);
    ctx.fillText(truncateText(ctx, text.sublabel, 420 * dpr), cx, labelTop + 40 * dpr);
  }
}

// Trim a string with an ellipsis to fit a max pixel width in the current font.
function truncateText(ctx: CanvasRenderingContext2D, value: string, maxWidth: number): string {
  if (ctx.measureText(value).width <= maxWidth) return value;
  let text = value;
  while (text.length > 1 && ctx.measureText(`${text}…`).width > maxWidth) {
    text = text.slice(0, -1);
  }
  return `${text}…`;
}

export function CrtLoadingCanvas({
  variant,
  durationMs = 1900,
  onDone,
  params,
  label,
  sublabel,
}: {
  variant: 'boot' | 'resume';
  // Boot only: how long the bar takes to fill before the sequence resolves.
  durationMs?: number;
  // Boot only: fired once the sequence (fill + brief hold) has finished.
  onDone?: () => void;
  // Override the CRT params (default CRT_BOOT_PRESET). Read live each frame so
  // the dev tuning panel can dial the loading look against this content.
  params?: CrtParams;
  // Resume only: the action word ("Resuming"/"Starting") and session title,
  // drawn INTO the canvas so the warp/bloom/scanlines apply to them too.
  label?: string;
  sublabel?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const theme = useUiStore(s => s.theme);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const textRef = useRef({ label, sublabel });
  textRef.current = { label, sublabel };

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-inits only on theme/variant; durationMs is read once.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const host = canvas.parentElement ?? canvas;
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);

    // Size is re-measured (not captured once): the resume canvas mounts over the
    // terminal viewport, which may be mid-layout (or zero) on the frame it first
    // appears. A one-shot measure stuck at a transient/zero size paints into a
    // dead buffer (the "blank resume" bug). A ResizeObserver keeps the backing
    // store + scratch + CRT pass matched to the host.
    const measure = () => {
      const cw = Math.max(1, host.clientWidth);
      const ch = Math.max(1, host.clientHeight);
      return { cssW: cw, cssH: ch, width: Math.round(cw * dpr), height: Math.round(ch * dpr) };
    };
    let { cssW, cssH, width, height } = measure();
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    // Transparent + PREMULTIPLIED alpha (matching the terminal path), so a faint
    // pixel carries a faint color: the bloom is coverage-weighted (a dim dot
    // blooms dimly, not blown out), grain is gated by alpha so it rides only
    // painted pixels, and the canvas blends with whatever is behind it with no
    // visible rectangle. `uploadContent` premultiplies the 2D source to match.
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    const scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    const ctx = scratch.getContext('2d');
    if (!gl || !ctx) return;

    let pass: CrtPass;
    try {
      pass = createCrtPass(gl, width, height);
    } catch {
      return;
    }

    const fg = readTextColor(canvas);
    // Transparent bezel so out-of-warp areas show through to the background.
    const bezel: PremultipliedColor = { r: 0, g: 0, b: 0, a: 0 };
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const start = performance.now();
    let raf = 0;
    let done = false;
    let doneTimer: ReturnType<typeof setTimeout> | null = null;

    // Resume bloom state that must persist across frames for this mount: the
    // expanding ripple rings and the key that gates one ring per breath cycle.
    const resumeScene: BloomScene = { ripples: [], rippleState: { lastKey: '' } };

    const renderFrame = (progress: number, t: number) => {
      if (variant === 'boot') drawBoot(ctx, width, height, progress, t, fg);
      else drawBreathing(ctx, width, height, t, dpr, fg, textRef.current, resumeScene, reduced);
      pass.uploadContent(scratch);
      pass.render(paramsRef.current ?? CRT_BOOT_PRESET, t, bezel);
    };

    const resizeToHost = () => {
      const next = measure();
      if (next.width === width && next.height === height) return;
      ({ cssW, cssH, width, height } = next);
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      scratch.width = width;
      scratch.height = height;
      pass.resize(width, height);
    };
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resizeToHost()) : null;
    resizeObserver?.observe(host);

    const finish = () => {
      if (done) return;
      done = true;
      // The parent overlay owns the fade-out; just signal completion after a
      // brief hold so the filled bar reads as done.
      doneTimer = setTimeout(() => onDoneRef.current?.(), 220);
    };

    if (reduced) {
      // A single static frame. Boot still resolves after its duration so startup
      // is never blocked on motion the user asked to avoid.
      renderFrame(variant === 'boot' ? 0.7 : 0.5, 0);
      if (variant === 'boot') doneTimer = setTimeout(finish, Math.min(durationMs, 700));
    } else {
      const tick = () => {
        if (document.visibilityState === 'hidden') {
          raf = requestAnimationFrame(tick);
          return;
        }
        const elapsed = performance.now() - start;
        const t = elapsed / 1000;
        if (variant === 'boot') {
          const fill = Math.min(1, elapsed / durationMs);
          renderFrame(fill, t);
          // Hold briefly at full before resolving so the bar reads as complete.
          if (elapsed >= durationMs + 260 && !done) finish();
        } else {
          renderFrame(1, t);
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    return () => {
      resizeObserver?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      if (doneTimer) clearTimeout(doneTimer);
      pass.dispose();
    };
    // Re-init on theme change so the colors re-read; variant/duration are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, variant]);

  return (
    <canvas ref={canvasRef} className={css({ display: 'block', width: '100%', height: '100%' })} />
  );
}

// Plays the retro power-on boot sequence once per app launch, over the main
// content region (the sidebar stays visible and usable, so the user can start a
// session right away). Off unless the CRT effect is enabled. The module-level
// guard means a re-render never replays it; a full reload (an actual relaunch)
// resets it.
let bootPlayed = false;

const BOOT_FADE_MS = 520;
const BOOT_MAX_DURATION_MS = 5200;

// The boot is a real-app moment; play it only inside the desktop app, never the
// browser fixture (dev harness / smoke test / unit tests) so iteration + tests
// are not held behind a power-on (and rAF is paused on backgrounded tabs anyway).
function shouldPlayBoot(): boolean {
  return !bootPlayed && appRuntimeMode() === 'tauri';
}

export function CrtBootSequence() {
  const setBootSequenceActive = useUiStore(s => s.setBootSequenceActive);
  // The power-on plays once per launch, independent of the CRT terminal toggle
  // (which only governs the live-terminal glass). `playing` is the one-shot gate;
  // `done` flips when the canvas (or the hard cap) finishes, which removes the
  // overlay so AnimatePresence fades it out — no manual exit timers or
  // onTransitionEnd handoff that can strand the gate.
  const [playing, setPlaying] = useState(shouldPlayBoot);
  const [done, setDone] = useState(false);
  const startedAtRef = useRef(Date.now());

  // Hold the global gate (which hides the still-loading content and defers the
  // resume) while the boot owns the screen. Cleared once the boot has fully faded
  // out, in AnimatePresence's onExitComplete below. `done` flipping does not
  // re-run this, so the gate stays up through the fade-out.
  useEffect(() => {
    if (playing) {
      if (!bootPlayed) bootPlayed = true;
      startedAtRef.current = Date.now();
      setBootSequenceActive(true);
    } else {
      // Not playing (already ran this load / HMR): clear the gate so the content
      // is never stranded hidden behind a boot that will not play.
      setBootSequenceActive(false);
    }
  }, [playing, setBootSequenceActive]);

  // Hard cap: retire the boot even if the canvas never signals done (a
  // backgrounded start pauses rAF), so it can never cover the app forever.
  useEffect(() => {
    if (!playing || done) return;
    const cap = window.setTimeout(() => setDone(true), BOOT_MAX_DURATION_MS);
    return () => window.clearTimeout(cap);
  }, [playing, done]);

  // Sleep/login can pause rAF and timers while the boot owns the stage. Retire
  // by wall clock on every foreground signal so the content gate cannot strand
  // the app hidden after wake.
  useEffect(() => {
    if (!playing || done) return;
    const retireIfStale = () => {
      if (Date.now() - startedAtRef.current < BOOT_MAX_DURATION_MS) return;
      setDone(true);
    };
    window.addEventListener('focus', retireIfStale);
    window.addEventListener('pageshow', retireIfStale);
    document.addEventListener('visibilitychange', retireIfStale);
    return () => {
      window.removeEventListener('focus', retireIfStale);
      window.removeEventListener('pageshow', retireIfStale);
      document.removeEventListener('visibilitychange', retireIfStale);
    };
  }, [playing, done]);

  // AnimatePresence normally flips `playing` off after the exit fade. Keep a
  // timer backstop so a paused animation cannot keep bootSequenceActive true.
  useEffect(() => {
    if (!playing || !done) return;
    const fallback = window.setTimeout(() => setPlaying(false), BOOT_FADE_MS + 160);
    return () => window.clearTimeout(fallback);
  }, [playing, done]);

  return (
    <AnimatePresence onExitComplete={() => setPlaying(false)}>
      {playing && !done ? (
        <motion.div
          key="crt-boot"
          className={bootOverlayClass}
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: BOOT_FADE_MS / 1000, ease: 'easeOut' }}
        >
          <div className={bootContentClass}>
            <CrtLoadingCanvas variant="boot" onDone={() => setDone(true)} />
          </div>
          {/* The window's top-left ambient glow, cast OVER the boot so its flat dark
            backdrop is softened by the same light as the rest of the app (matches
            terminalGlowClass) instead of reading as a hard black rectangle. */}
          <div className={bootGlowClass} aria-hidden="true" />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

const bootOverlayClass = css({
  position: 'absolute',
  inset: 0,
  zIndex: 40,
  // The boot is purely decorative: clicks pass through to the content (and the
  // sidebar is a separate region entirely), so the user is never blocked.
  pointerEvents: 'none',
  // No backdrop: the canvas (symbol + bar, transparent, grain on painted pixels
  // only) floats over the app's ambient field + glow. The content underneath is
  // held hidden during the boot (AppLayout gates it on bootSequenceActive), so
  // there is nothing to flash through and no solid rectangle / hard edge.
});

const bootGlowClass = css({
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  // Same falloff as the app's terminalGlowClass, anchored to the window's
  // top-left so the boot picks up the ambient light instead of flat black.
  background: 'radial-gradient(circle 900px at top left, var(--glow), transparent)',
});

const bootContentClass = css({
  // Holds the boot canvas; the whole overlay (this + the glow) fades in and out
  // via the parent motion.div, so no per-child opacity transition is needed.
  width: '100%',
  height: '100%',
});

// Dev harness wrapper: fills the viewport and (for boot) loops by remounting on
// each completion so the fill animation can be inspected without race timing.
export function CrtLoadingHarness({ variant }: { variant: 'boot' | 'resume' }) {
  const [key, setKey] = useState(0);
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0b0a09' }}>
      <div style={{ position: 'absolute', inset: 0 }}>
        <CrtLoadingCanvas
          key={key}
          variant={variant}
          label={variant === 'resume' ? 'Resuming' : undefined}
          sublabel={variant === 'resume' ? 'Check terminal rendering technology' : undefined}
          onDone={() => window.setTimeout(() => setKey(k => k + 1), 500)}
        />
      </div>
    </div>
  );
}
