// Shared WebGL renderer for per-session state cells.
//
// The product's signature texture is dots; this draws the *live* version of it:
// a small dot constellation whose size + glow are a function of a per-state
// motion field, evaluated in a fragment shader so the falloff is smooth and
// analog rather than a mechanical CSS pulse. The four session states read by
// motion *type*, not just color:
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
//   - There is exactly ONE WebGL context, an offscreen canvas reused per cell.
//     Each cell owns a cheap 2D <canvas> in the DOM (clipped + scrolled for free
//     by its container); we render a cell in GL then drawImage it onto that 2D
//     canvas. No N contexts, no overlay-positioning math.
//   - Only animating cells drive the rAF loop: the continuously-animated states
//     (active/attention/error), and any cell mid-transition or in the finished
//     settle. Static states stamp exactly once.
//   - The loop stops when no cell is animating and when the tab is hidden.
//   - prefers-reduced-motion renders a single representative still per state and
//     skips transitions entirely.

export type CellState = 'fresh' | 'active' | 'idle' | 'attention' | 'error' | 'finished';

const STATE_CODE: Record<CellState, number> = {
  fresh: 0,
  active: 1,
  attention: 2,
  error: 3,
  finished: 4,
  idle: 5,
};

// --- Transition moments -------------------------------------------------------
// Most state changes are an instant swap. A few are worth a one-shot motion
// played *on the change itself*, keyed on the state we came FROM. A transition is
// deliberately decoupled from state: the base render is always the target state's
// resting look, and the transition is a time-boxed *overlay* faded out by its
// progress. That keeps moments composable and cheap to add.
//
// To author a new moment:
//   1. add a `TransitionKind` + a code in `TRANSITION_CODE`,
//   2. add a branch to `transitionOverlay()` in the vertex shader,
//   3. map the `from>to` pair(s) to it in `TRANSITIONS`.
export type TransitionKind = 'settle';

interface TransitionDef {
  kind: TransitionKind;
  durationMs: number;
}

// Shader codes for each kind. 0 is reserved for "no transition".
const TRANSITION_CODE: Record<TransitionKind, number> = {
  settle: 1,
};

// Keyed `${from}>${to}`. Pairs not listed here swap instantly with no overlay.
const TRANSITIONS: Partial<Record<`${CellState}>${CellState}`, TransitionDef>> = {
  // The agent just finished a turn: the working energy releases outward and the
  // cell comes to rest. A green-tinted bloom dissolving into the neutral idle dot.
  'active>idle': { kind: 'settle', durationMs: 1400 },
};

// How long the finished bloom plays before the cell goes static.
const FINISHED_SETTLE_MS = 1500;
const TILE = 256; // offscreen GL render size in device px; downscaled per cell
const GRID = 5; // 5x5 dot lattice

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
}

interface GlProgram {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  uState: WebGLUniformLocation | null;
  uTime: WebGLUniformLocation | null;
  uAge: WebGLUniformLocation | null;
  uSeed: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uColorFrom: WebGLUniformLocation | null;
  uTransition: WebGLUniformLocation | null;
  uTransProgress: WebGLUniformLocation | null;
}

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aQuad;   // unit quad corner in [-1,1]
layout(location=1) in vec2 aGrid;   // per-dot lattice position in [-1,1]
uniform int uState;
uniform float uTime;
uniform float uAge;
uniform float uSeed;
uniform int uTransition;      // active transition kind (0 = none)
uniform float uTransProgress; // 0..1 across the transition (1 = done)
out vec2 vUv;
out float vBright;
out float vTrans;             // overlay weight, also tints the dot toward FROM color

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  float a = hash(i), b = hash(i+vec2(1,0)), c = hash(i+vec2(0,1)), d = hash(i+vec2(1,1));
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}

void field(vec2 g, out float s, out float b){
  float r = length(g);
  float core = smoothstep(1.1, 0.0, r);
  if (uState == 0) {            // fresh: still, dim seed (corners fade out)
    s = 0.18 + 0.48 * core;
    b = 0.13 + 0.40 * core;
  } else if (uState == 1) {     // active: drifting gaussian presence
    vec2 c = 0.52 * vec2(sin(uTime*0.55 + uSeed), sin(uTime*0.43 + uSeed*1.7 + 1.0));
    float d = length(g - c);
    float blob = exp(-d*d / 0.30);
    float n = 0.07 * (vnoise(g*1.6 + uTime*0.35 + uSeed) - 0.5);
    // Low base so dots far from the moving presence shrink toward transparent
    // (the far corner nearly vanishes when the blob sits in the opposite one),
    // so the lattice never reads as a hard square.
    s = clamp(0.10 + 0.90*blob + n, 0.0, 1.0);
    b = clamp(0.14 + 0.86*blob, 0.0, 1.0);
  } else if (uState == 2 || uState == 3) { // attention / error: pinging rings
    float speed = uState == 3 ? 4.6 : 3.2;
    float sharp = uState == 3 ? 5.0 : 4.0;
    float pulse = 0.80 + 0.20 * sin(uTime * speed);
    float coreLit = smoothstep(0.72, 0.0, r);
    float wave = 0.5 + 0.5 * sin(r*6.3 - uTime*speed);
    float ring = pow(wave, sharp) * smoothstep(1.25, 0.1, r);
    float m = max(coreLit, ring);
    s = clamp(0.30 + 0.70*m, 0.0, 1.0);
    b = clamp((0.50 + 0.50*m) * pulse, 0.20, 1.0);
  } else if (uState == 4) {     // finished: bloom once, settle to a present, even lattice
    float settle = smoothstep(0.0, 1.1, uAge);
    float bloomR = uAge * 1.35;
    float bloom = pow(0.5 + 0.5*sin((r - bloomR)*6.0), 6.0) * (1.0 - settle);
    // The settled rest state is a full, evenly-lit constellation that holds
    // until the session is seen: brighter and fuller than idle's dim center dot
    // so "ready for you" reads as present and invitational, not at-rest. The
    // four corners stay a touch dimmer so it is a dot cluster, not a square.
    float even = 0.32 + 0.50 * smoothstep(1.5, 0.0, r);
    s = clamp(mix(0.24, even, settle) + bloom*0.5, 0.0, 1.0);
    b = clamp(mix(0.26, even, settle) + bloom*0.5, 0.0, 1.0);
  } else {                      // idle (5): alive, resting, waiting on you
    // A still, center-weighted presence: brighter than fresh/finished and
    // clearly concentrated at the core (not the green drift of "working").
    float glow = smoothstep(1.0, 0.0, r);
    s = 0.16 + 0.56 * glow;
    b = 0.20 + 0.52 * glow;
  }
}

// One-shot transition overlays, layered over the target state's resting field and
// faded out by progress p in [0,1]. Returns the overlay weight, which the
// fragment stage uses to tint the dot toward the FROM color.
float transitionOverlay(vec2 g, float p, inout float s, inout float b){
  float r = length(g);
  float t = 0.0;
  if (uTransition == 1) {            // settle: working energy releases, then rests
    float ringR = (1.0 - pow(1.0 - p, 2.0)) * 1.5;   // ease-out expansion
    float fade  = pow(1.0 - p, 1.4);                 // soft, lingering tail
    float ring  = pow(0.5 + 0.5 * sin((r - ringR) * 5.5), 6.0);
    float flash = smoothstep(0.6, 0.0, r) * pow(1.0 - p, 3.0) * 0.45; // release instant
    t = max(ring * fade, flash);
    s = clamp(s + t * 0.5, 0.0, 1.0);
    b = clamp(b + t * 0.7, 0.0, 1.0);
  }
  return t;
}

void main(){
  float s; float b;
  field(aGrid, s, b);
  // No-ops (returns 0, leaves s/b) when uTransition == 0.
  float t = transitionOverlay(aGrid, uTransProgress, s, b);
  vBright = b;
  vTrans = t;
  vUv = aQuad;
  float spread = 0.66;            // how far the lattice fills the tile
  float dotRadius = 0.188 * s;    // half-size of a dot in tile space
  vec2 center = aGrid * spread;
  vec2 pos = center + aQuad * dotRadius;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
in float vBright;
in float vTrans;
uniform vec3 uColor;
uniform vec3 uColorFrom;
out vec4 outColor;
void main(){
  float d = length(vUv);
  float a = smoothstep(1.0, 0.34, d) * vBright;  // crisp dot with a soft halo
  // During a transition the overlay reads in the FROM color (e.g. green work
  // energy) and dissolves toward the target color as the moment settles.
  vec3 col = mix(uColor, uColorFrom, clamp(vTrans, 0.0, 1.0));
  // Premultiplied alpha so overlapping soft dots bloom gently over any card bg.
  outColor = vec4(col * a, a);
}`;

let gl: WebGL2RenderingContext | null = null;
let prog: GlProgram | null = null;
let glCanvas: HTMLCanvasElement | null = null;
let glUnavailable = false;

const cells = new Map<symbol, Cell>();
let rafId = 0;
let running = false;
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
  // the shader is what sets "finished" apart, so it reads as present, not alarming.
  finished: [0.72, 0.74, 0.8],
};

function ensureGl(): GlProgram | null {
  if (prog) return prog;
  if (glUnavailable) return null;
  try {
    glCanvas = document.createElement('canvas');
    glCanvas.width = TILE;
    glCanvas.height = TILE;
    const context = glCanvas.getContext('webgl2', {
      premultipliedAlpha: true,
      alpha: true,
      antialias: true,
    });
    if (!context) throw new Error('no webgl2');
    gl = context;
    const program = linkProgram(gl, VERT, FRAG);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    // Unit quad (triangle strip) shared by every dot instance.
    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Per-instance lattice positions.
    const lattice: number[] = [];
    for (let row = 0; row < GRID; row += 1) {
      for (let col = 0; col < GRID; col += 1) {
        lattice.push((col / (GRID - 1)) * 2 - 1, (row / (GRID - 1)) * 2 - 1);
      }
    }
    const gridBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lattice), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    prog = {
      gl,
      program,
      vao: vao as WebGLVertexArrayObject,
      uState: gl.getUniformLocation(program, 'uState'),
      uTime: gl.getUniformLocation(program, 'uTime'),
      uAge: gl.getUniformLocation(program, 'uAge'),
      uSeed: gl.getUniformLocation(program, 'uSeed'),
      uColor: gl.getUniformLocation(program, 'uColor'),
      uColorFrom: gl.getUniformLocation(program, 'uColorFrom'),
      uTransition: gl.getUniformLocation(program, 'uTransition'),
      uTransProgress: gl.getUniformLocation(program, 'uTransProgress'),
    };
    return prog;
  } catch {
    glUnavailable = true;
    gl = null;
    glCanvas = null;
    return null;
  }
}

function linkProgram(context: WebGL2RenderingContext, vsrc: string, fsrc: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const shader = context.createShader(type);
    if (!shader) throw new Error('shader alloc failed');
    context.shaderSource(shader, src);
    context.compileShader(shader);
    if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
      const log = context.getShaderInfoLog(shader);
      context.deleteShader(shader);
      throw new Error(`shader compile failed: ${log}`);
    }
    return shader;
  };
  const program = context.createProgram();
  if (!program) throw new Error('program alloc failed');
  context.attachShader(program, compile(context.VERTEX_SHADER, vsrc));
  context.attachShader(program, compile(context.FRAGMENT_SHADER, fsrc));
  context.linkProgram(program);
  if (!context.getProgramParameter(program, context.LINK_STATUS)) {
    throw new Error(`program link failed: ${context.getProgramInfoLog(program)}`);
  }
  return program;
}

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

// Render one cell into the shared GL canvas, then stamp it onto the cell's 2D
// canvas. `now` drives time; for static frames we pass a fixed phase so the
// representative still is stable.
function renderCell(cell: Cell, now: number) {
  const ctx2d = cell.ctx;
  ctx2d.clearRect(0, 0, cell.dprSize, cell.dprSize);
  const p = ensureGl();
  if (!p || !glCanvas) {
    draw2dFallback(cell);
    return;
  }
  const g = p.gl;
  g.viewport(0, 0, TILE, TILE);
  g.clearColor(0, 0, 0, 0);
  g.clear(g.COLOR_BUFFER_BIT);
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram is a GL call, not a React hook.
  g.useProgram(p.program);
  g.bindVertexArray(p.vao);
  g.uniform1i(p.uState, STATE_CODE[cell.state]);
  // Reduced motion / static states use a fixed, calm phase.
  const animating = isAnimating(cell, now);
  const time = reduceMotion ? cell.seed : now / 1000 + cell.seed;
  g.uniform1f(p.uTime, animating || cell.state === 'finished' ? time : cell.seed);
  g.uniform1f(p.uAge, reduceMotion ? 2.0 : cellAge(cell, now));
  g.uniform1f(p.uSeed, cell.seed);
  const c = colors[cell.state];
  g.uniform3f(p.uColor, c[0], c[1], c[2]);
  // Transition overlay: tinted toward the FROM state's color while it plays.
  const frac = transitionFrac(cell, now);
  const overlay = frac !== null ? cell.transition : null;
  const from = overlay ? colors[overlay.from] : c;
  g.uniform3f(p.uColorFrom, from[0], from[1], from[2]);
  g.uniform1i(p.uTransition, overlay ? TRANSITION_CODE[overlay.def.kind] : 0);
  g.uniform1f(p.uTransProgress, frac ?? 1.0);
  g.drawArraysInstanced(g.TRIANGLE_STRIP, 0, 4, GRID * GRID);
  g.bindVertexArray(null);
  ctx2d.drawImage(glCanvas, 0, 0, TILE, TILE, 0, 0, cell.dprSize, cell.dprSize);
}

// Tiny dependency-free still used when WebGL2 is unavailable: a graded dot grid.
function draw2dFallback(cell: Cell) {
  const ctx = cell.ctx;
  const c = colors[cell.state];
  const rgb = `${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}`;
  const n = GRID;
  const gap = cell.dprSize / n;
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      const gx = (col / (n - 1)) * 2 - 1;
      const gy = (row / (n - 1)) * 2 - 1;
      const r = Math.hypot(gx, gy);
      const core = Math.max(0, 1 - r / 1.1);
      const lit = cell.state === 'fresh' || cell.state === 'finished' ? 0.35 : 0.7;
      const size = (0.28 + 0.4 * core) * gap * 0.7;
      const alpha = 0.2 + lit * core;
      ctx.beginPath();
      ctx.fillStyle = `rgba(${rgb}, ${alpha.toFixed(3)})`;
      ctx.arc(gap * (col + 0.5), gap * (row + 0.5), size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
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
    rafId = requestAnimationFrame(frame);
  } else {
    running = false;
    rafId = 0;
  }
}

function startLoop() {
  if (running || reduceMotion || document.hidden) return;
  running = true;
  rafId = requestAnimationFrame(frame);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (rafId) cancelAnimationFrame(rafId);
      running = false;
      rafId = 0;
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
  };
  cells.set(key, cell);
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
      cells.delete(key);
    },
  };
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
    // Neutral, same family as idle (--text-2); the shader's brighter lattice, not
    // a distinct hue, is what marks it present. Monochrome guardrail.
    finished: read('--text-2', colors.finished),
  };
  const now = performance.now();
  for (const cell of cells.values()) renderCell(cell, now);
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
