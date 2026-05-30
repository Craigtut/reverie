// The drop field: a dot lattice that behaves like the surface of a pool.
//
// It is the visual centerpiece of the file-drop interaction. The signature
// Reverie dot field "rises to receive" a dragged file: a dim lattice fades in
// across the app, the pointer pulls nearby dots into a soft gravity-well dimple
// while you hover, and releasing the file raises a localized 3D dome the lattice
// drapes over and undulates on (a raindrop in a pool, seen at a slight tilt)
// before it settles. Each disturbed dot is drawn elongated along its own
// velocity (round-capped capsule = motion blur) and brightens as the rings pass.
//
// Performance follows the same contract as the ambient dot field: a single rAF
// loop runs ONLY while the field is rising, a pointer is active, or a ripple is
// alive, and it halts itself (final clear, no reschedule) the instant the
// surface settles, so it costs nothing at idle. prefers-reduced-motion drops
// the displacement forces and renders the flat field only. DPR is capped at 2.

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface DropFieldHandle {
  /** Re-measure the canvas and rebuild the lattice. Call on layout change. */
  resize(): void;
  /** Pointer position in canvas-local CSS px, or null to release the well. */
  setPointer(x: number | null, y?: number): void;
  /** Overall rise of the field, 0 (gone) .. 1 (full). Drives fade in/out. */
  setIntensity(level: number): void;
  /** Emit a droplet ripple centered at a canvas-local CSS px point. */
  splash(x: number, y: number): void;
  /** Re-read themed colors (the status bloom) after a theme flip. */
  refresh(): void;
  /** Tear down the loop and listeners. */
  destroy(): void;
}

interface Ripple {
  x: number;
  y: number;
  t0: number;
}

const MAX_DPR = 2;
const SPACING = 26;
const DOT_SIZE = 1.7;
const MAX_RIPPLES = 4;

// Gravity-well (hover) tuning.
const WELL_SIGMA = SPACING * 2.6; // reach of the dimple
const WELL_AMP = SPACING * 0.82; // how far the nearest dots lean in
const WELL_BREATH_HZ = 0.85;

// Droplet tuning. The drop is NOT a wave that flies to the edges: it is a
// localized 3D dome the lattice drapes over and undulates on, then settles (a
// raindrop in a pool, seen at a slight tilt). The dome's HEIGHT field drives the
// look: dots bob along screen-Y (the 3D rise) and compress slightly toward the
// rings (never shoot outward), while brightness tracks the height so the rings
// glow and travel as the surface oscillates. Keeping displacement small is what
// turns "fireworks" into an undulating ripple.
const DOME_LIFE = 1.8; // s before a spent dome is dropped
const DOME_TAU = 0.66; // s amplitude decay (the settle)
const DOME_AMP = SPACING * 1.35; // peak height-field value
const DOME_SIGMA0 = SPACING * 2.6; // starting dome radius
const DOME_SPREAD = 150; // px/s the dome radius grows (gentle, stays localized)
const DOME_RING_K = (Math.PI * 2) / (SPACING * 2.3); // radial ring wavenumber (~2-3 rings within the dome)
const DOME_OMEGA = Math.PI * 2 * 1.8; // surface undulation rate (~1.8 Hz bob)
const DOME_VERT = 0.8; // height -> screen-Y bob (the 3D rise), fraction of H
const DOME_RADIAL = 0.44; // height -> radial compression, fraction of H (rings, not flight)
const BLOOM_LIFE = 0.4; // s the --good impact bloom lasts

export function createDropField(canvas: HTMLCanvasElement): DropFieldHandle {
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('Canvas 2D context is unavailable');
  const ctx: CanvasRenderingContext2D = context;

  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const reducedMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = reducedMq.matches;

  let cssW = 0;
  let cssH = 0;
  let count = 0;
  let restX = new Float32Array(0);
  let restY = new Float32Array(0);
  let prevX = new Float32Array(0);
  let prevY = new Float32Array(0);
  let baseAlpha = new Float32Array(0);
  let dotPhase = new Float32Array(0);

  let pointerX: number | null = null;
  let pointerY = 0;
  let smoothX = 0;
  let smoothY = 0;
  let hasSmooth = false;

  let intensity = 0;
  let intensityTarget = 0;
  let ripples: Ripple[] = [];

  // Dots stay warm-cream in both themes: the terminal surface (and our scrim)
  // is always dark, so a light dot reads on either. Only the impact bloom
  // tracks the themed --good status color.
  const dotRGB: RGB = { r: 239, g: 233, b: 223 };
  const brightRGB: RGB = { r: 255, g: 250, b: 240 };
  let goodRGB: RGB = { r: 111, g: 184, b: 122 };

  let raf = 0;
  let lastT = 0;
  let hidden = document.visibilityState === 'hidden';

  function now(): number {
    return performance.now();
  }

  function parseColor(value: string): RGB | null {
    const text = value.trim();
    if (text.startsWith('#')) {
      let hex = text.slice(1);
      if (hex.length === 3)
        hex = hex
          .split('')
          .map(c => c + c)
          .join('');
      if (hex.length !== 6) return null;
      const n = parseInt(hex, 16);
      if (Number.isNaN(n)) return null;
      return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
    }
    const match = text.match(/rgba?\(([^)]+)\)/);
    if (match) {
      const parts = match[1].split(',').map(p => parseFloat(p));
      if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite))
        return { r: parts[0], g: parts[1], b: parts[2] };
    }
    return null;
  }

  function readColors() {
    const good = parseColor(getComputedStyle(canvas).getPropertyValue('--good'));
    if (good) goodRGB = good;
  }

  function rebuild() {
    const cols = Math.ceil(cssW / SPACING) + 1;
    const rows = Math.ceil(cssH / SPACING) + 1;
    count = cols * rows;
    restX = new Float32Array(count);
    restY = new Float32Array(count);
    prevX = new Float32Array(count);
    prevY = new Float32Array(count);
    baseAlpha = new Float32Array(count);
    dotPhase = new Float32Array(count);
    let i = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // Stagger odd rows so the lattice reads as the dot field, not graph paper.
        const x = c * SPACING + (r % 2 ? SPACING / 2 : 0);
        const y = r * SPACING;
        restX[i] = x;
        restY[i] = y;
        prevX[i] = x;
        prevY[i] = y;
        baseAlpha[i] = 0.07 + Math.random() * 0.05;
        dotPhase[i] = Math.random() * Math.PI * 2;
        i++;
      }
    }
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    cssW = rect.width;
    cssH = rect.height;
    canvas.width = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.max(1, Math.floor(cssH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rebuild();
    wake();
  }

  function setPointer(x: number | null, y = 0) {
    if (x === null) {
      pointerX = null;
    } else {
      pointerX = x;
      pointerY = y;
      if (!hasSmooth) {
        smoothX = x;
        smoothY = y;
        hasSmooth = true;
      }
    }
    wake();
  }

  function setIntensity(level: number) {
    intensityTarget = Math.max(0, Math.min(1, level));
    wake();
  }

  function splash(x: number, y: number) {
    ripples.push({ x, y, t0: now() });
    if (ripples.length > MAX_RIPPLES) ripples.shift();
    wake();
  }

  function settled(): boolean {
    return intensityTarget <= 0 && intensity <= 0.004 && ripples.length === 0;
  }

  function wake() {
    if (raf || hidden) return;
    if (settled()) return;
    lastT = now();
    raf = requestAnimationFrame(frame);
  }

  function frame(t: number) {
    raf = 0;
    const dt = Math.min(0.05, Math.max(0.001, (t - lastT) / 1000));
    lastT = t;

    // Ease the field's rise toward its target, and let the pointer-well chase
    // the cursor. Tight tracking (dt*34) so the dimple sits under the cursor
    // rather than visibly trailing it during a drag.
    intensity += (intensityTarget - intensity) * Math.min(1, dt * 9);
    if (pointerX !== null && hasSmooth) {
      smoothX += (pointerX - smoothX) * Math.min(1, dt * 34);
      smoothY += (pointerY - smoothY) * Math.min(1, dt * 34);
    }
    ripples = ripples.filter(rp => (t - rp.t0) / 1000 < DOME_LIFE);

    render(t);

    if (settled()) {
      intensity = 0;
      ctx.clearRect(0, 0, cssW, cssH);
      hasSmooth = false;
      return;
    }
    wake();
  }

  function render(t: number) {
    ctx.clearRect(0, 0, cssW, cssH);
    if (intensity <= 0.003 && ripples.length === 0) return;
    ctx.lineCap = 'round';

    const wellActive = pointerX !== null && !reduced;
    const tSec = t / 1000;

    for (let i = 0; i < count; i++) {
      const rx = restX[i];
      const ry = restY[i];
      let dispx = 0;
      let dispy = 0;

      if (wellActive) {
        const ddx = smoothX - rx;
        const ddy = smoothY - ry;
        const d2 = ddx * ddx + ddy * ddy;
        const g = Math.exp(-d2 / (2 * WELL_SIGMA * WELL_SIGMA));
        if (g > 0.002) {
          const breath = 0.82 + 0.18 * Math.sin(tSec * WELL_BREATH_HZ * Math.PI * 2 + dotPhase[i]);
          const amp = WELL_AMP * g * breath;
          const dist = Math.sqrt(d2) + 1e-3;
          dispx += (ddx / dist) * amp;
          dispy += (ddy / dist) * amp;
        }
      }

      // Height-field energy at this dot (sum of |height| over live domes); it
      // drives ring brightness so the rings read even when motion is brief.
      let energy = 0;
      if (!reduced) {
        for (const rp of ripples) {
          const rdx = rx - rp.x;
          const rdy = ry - rp.y;
          const r = Math.sqrt(rdx * rdx + rdy * rdy);
          const age = (t - rp.t0) / 1000;
          const sigma = DOME_SIGMA0 + DOME_SPREAD * age;
          const env = Math.exp(-(r * r) / (2 * sigma * sigma));
          if (env <= 0.003) continue;
          // The dome's height field: localized (env), oscillating as rings travel
          // through it (cos of radius minus time), damping over time. This is a
          // 3D surface, not a push: we read its height, we don't fling the dot.
          const h =
            DOME_AMP *
            env *
            Math.cos(DOME_RING_K * r - DOME_OMEGA * age) *
            Math.exp(-age / DOME_TAU);
          // Drape the lattice over it: bob along screen-Y (the 3D rise) and
          // compress slightly toward the rings. Small, so it undulates not flies.
          dispy -= h * DOME_VERT;
          const radial = h * DOME_RADIAL;
          const dist = r + 1e-3;
          dispx += (rdx / dist) * radial;
          dispy += (rdy / dist) * radial;
          energy += Math.abs(h);
        }
      }

      const cx = rx + dispx;
      const cy = ry + dispy;
      const vx = cx - prevX[i];
      const vy = cy - prevY[i];
      prevX[i] = cx;
      prevY[i] = cy;

      const speed = Math.sqrt(vx * vx + vy * vy);
      const dispMag = Math.sqrt(dispx * dispx + dispy * dispy);
      // Brightness: motion + well lean + (dominant) dome height. The energy term
      // lights the traveling rings; speed lights the fast-moving crests.
      const boost = Math.min(1, speed * 0.16 + dispMag * 0.03 + energy * 0.05);
      const alpha = (baseAlpha[i] + boost * (0.95 - baseAlpha[i])) * intensity;
      if (alpha < 0.012) continue;

      const cr = dotRGB.r + (brightRGB.r - dotRGB.r) * boost;
      const cg = dotRGB.g + (brightRGB.g - dotRGB.g) * boost;
      const cb = dotRGB.b + (brightRGB.b - dotRGB.b) * boost;
      const color = `rgba(${cr | 0},${cg | 0},${cb | 0},${alpha})`;

      // Motion blur: stretch the dot into a round-capped capsule along its
      // velocity. The gentle bob is slow, so the multiplier is generous to keep
      // the streaky, nuanced look of the reference.
      const len = Math.min(speed * 2.6, SPACING * 2.4);
      if (len > 0.7 && speed > 1e-3) {
        const ux = vx / speed;
        const uy = vy / speed;
        ctx.strokeStyle = color;
        ctx.lineWidth = DOT_SIZE;
        ctx.beginPath();
        ctx.moveTo(cx - ux * (len / 2), cy - uy * (len / 2));
        ctx.lineTo(cx + ux * (len / 2), cy + uy * (len / 2));
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.fillRect(cx - DOT_SIZE / 2, cy - DOT_SIZE / 2, DOT_SIZE, DOT_SIZE);
      }
    }

    // The single status-color moment: a soft --good bloom at each fresh impact,
    // fading within a third of a second.
    for (const rp of ripples) {
      const age = (t - rp.t0) / 1000;
      if (age >= BLOOM_LIFE) continue;
      const k = 1 - age / BLOOM_LIFE;
      // Localized to the dome, not an expanding shockwave: a soft swell at the
      // impact that fades as the surface settles.
      const radius = SPACING * (2.0 + age * 3.5);
      const glow = ctx.createRadialGradient(rp.x, rp.y, 0, rp.x, rp.y, radius);
      glow.addColorStop(0, `rgba(${goodRGB.r},${goodRGB.g},${goodRGB.b},${0.36 * k * intensity})`);
      glow.addColorStop(1, `rgba(${goodRGB.r},${goodRGB.g},${goodRGB.b},0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function onVisibility() {
    hidden = document.visibilityState === 'hidden';
    if (hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    } else {
      wake();
    }
  }

  function onReducedChange(event: MediaQueryListEvent) {
    reduced = event.matches;
    wake();
  }

  document.addEventListener('visibilitychange', onVisibility);
  reducedMq.addEventListener('change', onReducedChange);
  readColors();
  resize();

  return {
    resize,
    setPointer,
    setIntensity,
    splash,
    refresh: readColors,
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      document.removeEventListener('visibilitychange', onVisibility);
      reducedMq.removeEventListener('change', onReducedChange);
    },
  };
}
