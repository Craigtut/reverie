// Shared renderer for per-session state cells.
//
// The product's signature texture is dots; this draws the *live* version of it:
// a small dot constellation whose size + glow are a function of a per-state
// motion field (stateFieldMotion.ts), so the falloff is smooth and analog rather
// than a mechanical CSS pulse. The four session states read by motion *type*,
// not just color:
//
//   fresh     - a still, dim seed (no animation)
//   active    - a soft gaussian "presence" gliding across the lattice (green)
//   attention - rhythmic rings pinging outward from a lit core (amber/red)
//   finished  - one bloom that settles into an even, still lattice (neutral)
//
// On top of those resting states, specific state *changes* can play a one-shot
// transition overlay (see TRANSITIONS): e.g. active -> idle blooms the working
// energy outward and settles it, so finishing a turn reads as a small moment.
//
// Performance is non-negotiable (this can appear on dozens of cards at once), so:
//   - Each cell owns a cheap 2D <canvas> in the DOM (clipped + scrolled for free
//     by its container) and its 25 dots are painted straight into it. There is
//     no WebGL and no cross-canvas copy: WebKit renders canvases in a separate
//     GPU process, and the old shared-WebGL-canvas-then-drawImage design made a
//     fresh cross-process image copy per cell per frame.
//   - The paint loop does not allocate: dot samples are reused, and each cell
//     caches one unit-radius gradient per tint that every dot reuses through a
//     per-dot transform.
//   - Only animating cells drive the rAF loop: the continuously-animated states
//     (active/attention/error), and any cell mid-transition or in the finished
//     settle. Static states stamp exactly once.
//   - The loop stops when no cell is animating and when the tab is hidden.
//   - prefers-reduced-motion renders a single representative still per state and
//     skips transitions entirely.

import {
  type CellState,
  DOT_ALPHA_STOPS,
  type DotSample,
  type TransitionKind,
  sampleLattice,
} from './stateFieldMotion';

export type { CellState, TransitionKind } from './stateFieldMotion';

// --- Transition moments -------------------------------------------------------
// Most state changes are an instant swap. A few are worth a one-shot motion
// played *on the change itself*, keyed on the state we came FROM. A transition is
// deliberately decoupled from state: the base render is always the target state's
// resting look, and the transition is a time-boxed *overlay* faded out by its
// progress. That keeps moments composable and cheap to add.
//
// To author a new moment:
//   1. add a `TransitionKind` in stateFieldMotion.ts,
//   2. add a branch to `transitionOverlay()` there,
//   3. map the `from>to` pair(s) to it in `TRANSITIONS`.
interface TransitionDef {
  kind: TransitionKind;
  durationMs: number;
}

// Keyed `${from}>${to}`. Pairs not listed here swap instantly with no overlay.
const TRANSITIONS: Partial<Record<`${CellState}>${CellState}`, TransitionDef>> = {
  // The agent just finished a turn: the working energy releases outward and the
  // cell comes to rest. A green-tinted bloom dissolving into the neutral idle dot.
  'active>idle': { kind: 'settle', durationMs: 1400 },
};

// How long the finished bloom plays before the cell goes static.
const FINISHED_SETTLE_MS = 1500;
const BATTERY_ANIMATION_INTERVAL_MS = 1000 / 15;
// Dots below these are invisible at any cell size; skip their draw calls.
const MIN_DOT_RADIUS_PX = 0.05;
const MIN_DOT_ALPHA = 0.003;
// Transition tints are quantized so a cell caches a handful of gradients, not one
// per frame. 16 steps is finer than the eye can track on a 1.4s dissolve.
const TINT_STEPS = 16;
// Ceiling on cached gradients per cell (a theme flip mid-transition is the only
// way to approach it); past it the cache is simply rebuilt.
const MAX_CACHED_GRADIENTS = 48;
const FULL_TURN = Math.PI * 2;

export interface StateCellHandle {
  update(state: CellState): void;
  destroy(): void;
}

// An in-flight transition overlay on a cell. `from` is the state we left, used
// to tint the overlay toward where it came from (e.g. green "working" energy
// dissolving into the neutral resting cell).
interface ActiveTransition {
  def: TransitionDef;
  from: CellState;
  startedAt: number;
}

interface Cell {
  ctx: CanvasRenderingContext2D;
  cssSize: number;
  dprSize: number;
  state: CellState;
  seed: number;
  stateChangedAt: number;
  transition: ActiveTransition | null;
  // Unit-radius dot gradients keyed by tint. A canvas gradient is defined in the
  // coordinate space current at fill time, so one gradient at the origin serves
  // every dot of that tint through a per-dot transform.
  gradients: Map<string, CanvasGradient>;
}

const cells = new Map<symbol, Cell>();
const samples: DotSample[] = [];
let rafId = 0;
let frameTimerId = 0;
let running = false;
let batteryMode = false;
const reduceMotion =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

// Status-color lookups resolved from CSS variables, refreshed on theme change.
let colors: Record<CellState, [number, number, number]> = {
  fresh: [0.5, 0.5, 0.5],
  active: [0.43, 0.72, 0.48],
  idle: [0.62, 0.66, 0.72],
  attention: [0.85, 0.65, 0.3],
  error: [0.85, 0.4, 0.4],
  // Same neutral family as idle (no status hue); the brighter, fuller lattice in
  // the motion field is what sets "finished" apart, so it reads as present, not alarming.
  finished: [0.72, 0.74, 0.8],
};

function cellAge(cell: Cell, now: number): number {
  return Math.max(0, (now - cell.stateChangedAt) / 1000);
}

// Progress of an in-flight transition overlay in [0,1], or null when there is
// none or it has elapsed. Pure: expiry is cleaned up by the frame loop so the
// final settled frame gets stamped exactly once.
function transitionFrac(cell: Cell, now: number): number | null {
  const t = cell.transition;
  if (!t) return null;
  const frac = (now - t.startedAt) / t.def.durationMs;
  return frac >= 1 ? null : Math.max(0, frac);
}

function isAnimating(cell: Cell, now: number): boolean {
  if (reduceMotion) return false;
  if (cell.state === 'active' || cell.state === 'attention' || cell.state === 'error') return true;
  if (cell.state === 'finished') return now - cell.stateChangedAt < FINISHED_SETTLE_MS;
  return transitionFrac(cell, now) !== null;
}

// The dot gradient for a tint `weight` of the way from `to` toward `from`.
function dotGradient(
  cell: Cell,
  to: readonly [number, number, number],
  from: readonly [number, number, number],
  weight: number,
): CanvasGradient {
  const step = Math.round(weight * TINT_STEPS) / TINT_STEPS;
  const r = Math.round((to[0] + (from[0] - to[0]) * step) * 255);
  const g = Math.round((to[1] + (from[1] - to[1]) * step) * 255);
  const b = Math.round((to[2] + (from[2] - to[2]) * step) * 255);
  const key = `${r},${g},${b}`;
  const cached = cell.gradients.get(key);
  if (cached) return cached;
  if (cell.gradients.size >= MAX_CACHED_GRADIENTS) cell.gradients.clear();
  const gradient = cell.ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  for (const [offset, alpha] of DOT_ALPHA_STOPS) {
    gradient.addColorStop(offset, `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`);
  }
  cell.gradients.set(key, gradient);
  return gradient;
}

// Paint one cell. `now` drives time; for static frames we pass a fixed phase so
// the representative still is stable.
function renderCell(cell: Cell, now: number) {
  const { ctx, dprSize } = cell;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, dprSize, dprSize);

  // Reduced motion / static states use a fixed, calm phase.
  const animating = isAnimating(cell, now);
  const time = reduceMotion ? cell.seed : now / 1000 + cell.seed;
  // Transition overlay: tinted toward the FROM state's color while it plays.
  const frac = transitionFrac(cell, now);
  const overlay = frac !== null ? cell.transition : null;
  sampleLattice(
    {
      state: cell.state,
      time: animating || cell.state === 'finished' ? time : cell.seed,
      age: reduceMotion ? 2 : cellAge(cell, now),
      seed: cell.seed,
      transition: overlay ? overlay.def.kind : null,
      progress: frac ?? 1,
    },
    samples,
  );

  const to = colors[cell.state];
  const from = overlay ? colors[overlay.from] : to;
  // Lattice space is [-1, 1] with +y up; map it onto the cell's device pixels.
  const half = dprSize / 2;
  for (const dot of samples) {
    const radius = dot.radius * half;
    if (radius < MIN_DOT_RADIUS_PX || dot.bright < MIN_DOT_ALPHA) continue;
    // Source-over at the dot's peak alpha matches the old premultiplied blend,
    // so overlapping soft dots still bloom gently over any card background.
    ctx.globalAlpha = dot.bright;
    ctx.fillStyle = dotGradient(cell, to, from, dot.trans);
    ctx.setTransform(radius, 0, 0, radius, half + dot.x * half, half - dot.y * half);
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, FULL_TURN);
    ctx.fill();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

function frame() {
  const now = performance.now();
  let stillAnimating = false;
  for (const cell of cells.values()) {
    if (isAnimating(cell, now)) {
      renderCell(cell, now);
      stillAnimating = true;
    } else if (cell.transition) {
      // A transition overlay just elapsed: clear it and stamp the settled target
      // state once. (A transition whose target is itself a continuously-animated
      // state never reaches here; it is cleared lazily on the next change.)
      cell.transition = null;
      renderCell(cell, now);
    } else if (cell.state === 'finished') {
      // Stamp the settled frame once as the bloom window closes.
      renderCell(cell, now);
    }
  }
  if (stillAnimating && !document.hidden) {
    scheduleFrame(nextFrameDelay(now));
  } else {
    running = false;
    rafId = 0;
    frameTimerId = 0;
  }
}

function nextFrameDelay(frameStartedAt: number) {
  if (!batteryMode) return 0;
  return Math.max(0, BATTERY_ANIMATION_INTERVAL_MS - (performance.now() - frameStartedAt));
}

function scheduleFrame(delayMs: number) {
  if (delayMs <= 0) {
    rafId = requestAnimationFrame(frame);
    return;
  }
  frameTimerId = window.setTimeout(() => {
    frameTimerId = 0;
    if (!running || document.hidden) return;
    rafId = requestAnimationFrame(frame);
  }, delayMs);
}

function cancelLoopFrame() {
  if (rafId) cancelAnimationFrame(rafId);
  if (frameTimerId) window.clearTimeout(frameTimerId);
  rafId = 0;
  frameTimerId = 0;
}

function startLoop() {
  if (running || reduceMotion || document.hidden) return;
  running = true;
  scheduleFrame(0);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelLoopFrame();
      running = false;
    } else {
      // Repaint stills (positions/time may have drifted) and resume if needed.
      const now = performance.now();
      for (const cell of cells.values()) renderCell(cell, now);
      startLoop();
    }
  });
}

let colorsResolved = false;

export function registerStateCell(
  canvas: HTMLCanvasElement,
  state: CellState,
  seed: number,
): StateCellHandle {
  if (!colorsResolved) {
    refreshStateFieldColors();
    colorsResolved = true;
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssSize = canvas.clientWidth || parseFloat(canvas.style.width) || 22;
  const dprSize = Math.round(cssSize * dpr);
  canvas.width = dprSize;
  canvas.height = dprSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { update: () => {}, destroy: () => {} };
  }
  const key = Symbol('cell');
  const cell: Cell = {
    ctx,
    cssSize,
    dprSize,
    state,
    seed,
    stateChangedAt: performance.now(),
    transition: null,
    gradients: new Map(),
  };
  cells.set(key, cell);
  // WebKit may drop a canvas's backing store when its GPU process restarts.
  // Animating cells repaint on the next frame anyway; this restores the stills.
  const repaint = () => renderCell(cell, performance.now());
  canvas.addEventListener('contextrestored', repaint);
  renderCell(cell, performance.now()); // immediate first paint
  if (isAnimating(cell, performance.now())) startLoop();

  return {
    update(next: CellState) {
      if (next === cell.state) return;
      const now = performance.now();
      // Look up a transition moment for this exact change before we leave the
      // FROM state. Skipped under reduced motion (we just swap to the still).
      const def = reduceMotion ? undefined : TRANSITIONS[`${cell.state}>${next}`];
      cell.transition = def ? { def, from: cell.state, startedAt: now } : null;
      cell.state = next;
      cell.stateChangedAt = now;
      renderCell(cell, now);
      if (isAnimating(cell, now)) startLoop();
    },
    destroy() {
      canvas.removeEventListener('contextrestored', repaint);
      cells.delete(key);
    },
  };
}

export function setStateFieldBatteryMode(onBattery: boolean) {
  if (batteryMode === onBattery) return;
  batteryMode = onBattery;
  if (running) {
    cancelLoopFrame();
    scheduleFrame(0);
  } else {
    startLoop();
  }
}

// Re-resolve status colors from the live CSS variables (call on theme change)
// and repaint every cell so static stills pick up the new palette.
export function refreshStateFieldColors() {
  if (typeof window === 'undefined') return;
  // The theme custom properties (--good, --text-2, ...) are scoped to the app
  // shell, not :root. Read them from a node inside the shell so the cells track
  // the active theme: a live cell canvas (inherits the vars) is ideal; fall back
  // to the shell element, then the document.
  const source =
    cells.values().next().value?.ctx.canvas ??
    document.querySelector('[data-testid="reverie-app-shell"]') ??
    document.documentElement;
  const style = getComputedStyle(source as Element);
  const read = (name: string, fallback: [number, number, number]): [number, number, number] =>
    parseCssColor(style.getPropertyValue(name).trim()) ?? fallback;
  colors = {
    fresh: read('--text-3', colors.fresh),
    active: read('--good', colors.active),
    idle: read('--text-2', colors.idle),
    attention: read('--warn', colors.attention),
    error: read('--bad', colors.error),
    // Neutral, same family as idle (--text-2); the brighter lattice, not a
    // distinct hue, is what marks it present. Monochrome guardrail.
    finished: read('--text-2', colors.finished),
  };
  const now = performance.now();
  for (const cell of cells.values()) {
    cell.gradients.clear();
    renderCell(cell, now);
  }
}

// Dev aid: manually drive a render at an arbitrary time so the motion can be
// inspected in a backgrounded tab where rAF is throttled (the MCP harness).
// Stripped from production builds.
if (typeof window !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __reverieStateField?: unknown }).__reverieStateField = {
    renderAt(ms: number) {
      for (const cell of cells.values()) renderCell(cell, ms);
    },
    refresh() {
      refreshStateFieldColors();
    },
  };
}

function parseCssColor(value: string): [number, number, number] | null {
  if (!value) return null;
  const probe = document.createElement('span');
  probe.style.color = value;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  const match = resolved.match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  const parts = match[1].split(',').map(s => parseFloat(s));
  if (parts.length < 3) return null;
  return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
}
