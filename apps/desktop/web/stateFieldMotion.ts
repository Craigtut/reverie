// Motion model for the session state cells: where each dot of the 5x5 lattice
// sits, how large and bright it is, and how strongly a transition overlay tints
// it, as a pure function of state, time, and seed.
//
// This used to live in a WebGL vertex/fragment shader pair. The math is
// unchanged; it runs on the CPU now because a cell is only 25 dots, and the GPU
// path cost far more than it saved. WebKit renders canvases in its separate GPU
// process, and stamping a shared WebGL canvas onto each cell's 2D canvas made a
// fresh cross-process image copy per cell per frame (hundreds per second with a
// few working sessions). Painting these dots straight into each cell's own 2D
// canvas keeps the look and removes that churn, along with the WebGL context
// and its context-loss failure mode.
//
// Coordinates follow the old shader's clip space: x and y in [-1, 1] with +y up.
// The painter maps them onto the cell canvas.

export type CellState = 'fresh' | 'active' | 'idle' | 'attention' | 'error' | 'finished';

// A one-shot overlay played on a specific state change (see TRANSITIONS in
// stateField.ts). Each kind has a branch in `transitionOverlay`.
export type TransitionKind = 'settle';

export const GRID = 5; // 5x5 dot lattice
const LATTICE_SPREAD = 0.66; // how far the lattice fills the tile
const DOT_RADIUS_SCALE = 0.2; // half-size of a dot in tile space at full size

export interface FieldInput {
  state: CellState;
  // Seconds; already offset by the cell's seed when animating.
  time: number;
  // Seconds since the cell entered its current state.
  age: number;
  seed: number;
  transition: TransitionKind | null;
  // Transition progress in [0, 1]; 1 when there is no transition.
  progress: number;
}

export interface DotSample {
  // Dot center in [-1, 1], +y up.
  x: number;
  y: number;
  // Dot radius in the same units (0 means not drawn).
  radius: number;
  // Peak alpha of the dot, in [0, 1].
  bright: number;
  // Transition overlay weight in [0, 1]: how far to tint toward the FROM color.
  trans: number;
}

// Lattice positions in [-1, 1], row-major, computed once.
const LATTICE: ReadonlyArray<readonly [number, number]> = (() => {
  const points: Array<readonly [number, number]> = [];
  for (let row = 0; row < GRID; row += 1) {
    for (let col = 0; col < GRID; col += 1) {
      points.push([(col / (GRID - 1)) * 2 - 1, (row / (GRID - 1)) * 2 - 1]);
    }
  }
  return points;
})();

// GLSL built-ins, with GLSL semantics.
function fract(x: number): number {
  return x - Math.floor(x);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function hash(x: number, y: number): number {
  return fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
}

function vnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return mix(mix(a, b, ux), mix(c, d, ux), uy);
}

interface SizeBright {
  s: number;
  b: number;
}

// Per-state resting field for one lattice point: dot size `s` and brightness `b`.
function field(gx: number, gy: number, input: FieldInput, out: SizeBright) {
  const r = Math.hypot(gx, gy);
  const core = smoothstep(1.1, 0, r);
  const { time, age, seed } = input;
  switch (input.state) {
    case 'fresh': {
      // A still, dim seed (corners fade out).
      out.s = 0.18 + 0.48 * core;
      out.b = 0.13 + 0.4 * core;
      return;
    }
    case 'active': {
      // A drifting gaussian presence. A low base lets dots far from it shrink
      // toward transparent, so the lattice never reads as a hard square.
      const cx = 0.52 * Math.sin(time * 0.55 + seed);
      const cy = 0.52 * Math.sin(time * 0.43 + seed * 1.7 + 1);
      const dx = gx - cx;
      const dy = gy - cy;
      const blob = Math.exp(-(dx * dx + dy * dy) / 0.3);
      const n = 0.07 * (vnoise(gx * 1.6 + time * 0.35 + seed, gy * 1.6 + time * 0.35 + seed) - 0.5);
      out.s = clamp(0.1 + 0.9 * blob + n, 0, 1);
      out.b = clamp(0.14 + 0.86 * blob, 0, 1);
      return;
    }
    case 'attention':
    case 'error': {
      // Rings pinging outward from a lit core.
      const isError = input.state === 'error';
      const speed = isError ? 4.6 : 3.2;
      const sharp = isError ? 5 : 4;
      const pulse = 0.8 + 0.2 * Math.sin(time * speed);
      const coreLit = smoothstep(0.72, 0, r);
      const wave = 0.5 + 0.5 * Math.sin(r * 6.3 - time * speed);
      const ring = wave ** sharp * smoothstep(1.25, 0.1, r);
      const m = Math.max(coreLit, ring);
      out.s = clamp(0.3 + 0.7 * m, 0, 1);
      out.b = clamp((0.5 + 0.5 * m) * pulse, 0.2, 1);
      return;
    }
    case 'finished': {
      // Bloom once, then settle to a present, even lattice that holds until the
      // session is seen: brighter and fuller than idle so "ready for you" reads
      // as invitational. The corners stay a touch dimmer so it stays a cluster.
      const settle = smoothstep(0, 1.1, age);
      const bloomR = age * 1.35;
      const bloom = (0.5 + 0.5 * Math.sin((r - bloomR) * 6)) ** 6 * (1 - settle);
      const even = 0.32 + 0.5 * smoothstep(1.5, 0, r);
      out.s = clamp(mix(0.24, even, settle) + bloom * 0.5, 0, 1);
      out.b = clamp(mix(0.26, even, settle) + bloom * 0.5, 0, 1);
      return;
    }
    case 'idle': {
      // Alive, resting, waiting on you: a still, center-weighted presence.
      const glow = smoothstep(1, 0, r);
      out.s = 0.16 + 0.56 * glow;
      out.b = 0.2 + 0.52 * glow;
      return;
    }
  }
}

// One-shot overlay layered over the target state's resting field and faded out
// by progress. Returns the overlay weight, which tints the dot toward the FROM
// color.
function transitionOverlay(
  gx: number,
  gy: number,
  kind: TransitionKind | null,
  p: number,
  io: SizeBright,
): number {
  if (kind !== 'settle') return 0;
  // Settle: the working energy releases outward, then rests.
  const r = Math.hypot(gx, gy);
  const ringR = (1 - (1 - p) ** 2) * 1.5; // ease-out expansion
  const fade = (1 - p) ** 1.4; // soft, lingering tail
  const ring = (0.5 + 0.5 * Math.sin((r - ringR) * 5.5)) ** 6;
  const flash = smoothstep(0.6, 0, r) * (1 - p) ** 3 * 0.45; // release instant
  const t = Math.max(ring * fade, flash);
  io.s = clamp(io.s + t * 0.5, 0, 1);
  io.b = clamp(io.b + t * 0.7, 0, 1);
  return t;
}

const scratch: SizeBright = { s: 0, b: 0 };

// Sample every lattice dot for one frame into `out` (reused across frames to
// keep the paint loop allocation-free). Returns `out`.
export function sampleLattice(input: FieldInput, out: DotSample[] = []): DotSample[] {
  for (let index = 0; index < LATTICE.length; index += 1) {
    const [gx, gy] = LATTICE[index];
    field(gx, gy, input, scratch);
    const trans = transitionOverlay(gx, gy, input.transition, input.progress, scratch);
    // Round the square lattice into a soft disc: attenuate each dot by its
    // distance from the center so the corners drop away and the edge midpoints
    // dim a touch. Applied after the field and any overlay so every state and
    // moment rounds the same way (corner r ~1.41, edge-mid 1.0, center 0).
    const env = smoothstep(1.5, 0.82, Math.hypot(gx, gy));
    let dot = out[index];
    if (!dot) {
      dot = { x: 0, y: 0, radius: 0, bright: 0, trans: 0 };
      out[index] = dot;
    }
    dot.x = gx * LATTICE_SPREAD;
    dot.y = gy * LATTICE_SPREAD;
    dot.radius = DOT_RADIUS_SCALE * scratch.s * env;
    dot.bright = scratch.b * env;
    dot.trans = clamp(trans, 0, 1);
  }
  out.length = LATTICE.length;
  return out;
}

// Alpha across one dot as a function of normalized distance from its center
// (0 = center, 1 = rim): a mostly solid disc with a thin shoulder plus a faint
// low-weight glow, so the rim softens instead of hard-cutting.
export function dotAlpha(d: number): number {
  const disc = smoothstep(0.82, 0.56, d);
  const glow = smoothstep(1, 0.5, d) * 0.13;
  return clamp(disc + glow, 0, 1);
}

// Gradient stops that trace `dotAlpha` closely enough at cell sizes.
export const DOT_ALPHA_STOPS: ReadonlyArray<readonly [offset: number, alpha: number]> = [
  0, 0.5, 0.56, 0.62, 0.69, 0.76, 0.82, 0.91, 1,
].map(offset => [offset, dotAlpha(offset)] as const);
