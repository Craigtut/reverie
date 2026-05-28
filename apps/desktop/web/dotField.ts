// Shared canvas dot-field renderer.
//
// The product's signature texture: dots represent agents and activity. One
// primitive is configured by variant for every surface that needs the motif
// (ambient background, launching hero, dashboard constellation, card glyphs).
// Performance is non-negotiable: a static dot layer is cached on an offscreen
// canvas and blitted once per frame; only transient effects (dashes, the
// breathing pulse) redraw per-frame. DPR is capped at 2, the loop pauses when
// the tab is hidden, and prefers-reduced-motion disables movement entirely.

export type DotFieldVariant = 'ambient' | 'launching';

export interface DotFieldOptions {
  variant?: DotFieldVariant;
}

export interface DotFieldHandle {
  /** Re-measure the canvas, regenerate cells, and rebuild the static layer.
   *  Call after theme changes so dot colors track the current CSS variables. */
  refresh(): void;
  /** Tear down the rAF loop, observers, and listeners. */
  destroy(): void;
}

interface Cell {
  x: number;
  y: number;
  alpha: number;
}

interface Dash {
  y: number;
  startX: number;
  vx: number;
  len: number;
  t0: number;
  dur: number;
}

const MAX_DPR = 2;
const MAX_DASHES = 3;
const BREATH_PERIOD_HZ = 0.9; // ~1.1 s breath

interface VariantTuning {
  spacing: number;
  dotSize: number;
  accentChance: number;
  baseAlphaMin: number;
  baseAlphaRange: number;
  accentAlphaMin: number;
  accentAlphaRange: number;
  dashesPerSecond: number;
  breath: boolean;
}

const TUNING: Record<DotFieldVariant, VariantTuning> = {
  ambient: {
    spacing: 24,
    dotSize: 1.2,
    accentChance: 0.045,
    baseAlphaMin: 0.08,
    baseAlphaRange: 0.05,
    accentAlphaMin: 0.32,
    accentAlphaRange: 0.18,
    dashesPerSecond: 0.32,
    breath: false,
  },
  launching: {
    spacing: 16,
    dotSize: 2.0,
    accentChance: 0,
    baseAlphaMin: 0.18,
    baseAlphaRange: 0.10,
    accentAlphaMin: 0,
    accentAlphaRange: 0,
    dashesPerSecond: 0,
    breath: true,
  },
};

export function createDotField(
  canvas: HTMLCanvasElement,
  opts: DotFieldOptions = {},
): DotFieldHandle {
  const variant: DotFieldVariant = opts.variant ?? 'ambient';
  const tuning = TUNING[variant];
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('Canvas 2D context is unavailable');
  const ctx: CanvasRenderingContext2D = context;

  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const reducedMotionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reducedMotion = reducedMotionMq.matches;

  let cssWidth = 0;
  let cssHeight = 0;
  let cells: Cell[] = [];
  let staticLayer: HTMLCanvasElement | null = null;
  let dashes: Dash[] = [];
  let lastDashSpawn = 0;
  let raf = 0;
  let hidden = document.visibilityState === 'hidden';

  function readDotColor(): { r: number; g: number; b: number } {
    // CSS custom properties are inherited, so reading from the canvas resolves
    // whichever theme its ancestor data-theme element currently declares.
    const value = getComputedStyle(canvas).getPropertyValue('--text').trim();
    return parseHex(value) ?? { r: 239, g: 233, b: 223 };
  }

  function parseHex(value: string): { r: number; g: number; b: number } | null {
    if (!value.startsWith('#')) return null;
    let hex = value.slice(1);
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length !== 6) return null;
    const n = parseInt(hex, 16);
    if (Number.isNaN(n)) return null;
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
  }

  function regenerateCells() {
    cells = [];
    const cols = Math.ceil(cssWidth / tuning.spacing) + 1;
    const rows = Math.ceil(cssHeight / tuning.spacing) + 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const accent = tuning.accentChance > 0 && Math.random() < tuning.accentChance;
        const alpha = accent
          ? tuning.accentAlphaMin + Math.random() * tuning.accentAlphaRange
          : tuning.baseAlphaMin + Math.random() * tuning.baseAlphaRange;
        cells.push({
          x: c * tuning.spacing + (r % 2 ? tuning.spacing / 2 : 0),
          y: r * tuning.spacing,
          alpha,
        });
      }
    }
    buildStaticLayer();
  }

  function buildStaticLayer() {
    const w = Math.max(1, Math.floor(cssWidth * dpr));
    const h = Math.max(1, Math.floor(cssHeight * dpr));
    const layer = document.createElement('canvas');
    layer.width = w;
    layer.height = h;
    const sctx = layer.getContext('2d', { alpha: true });
    if (!sctx) {
      staticLayer = null;
      return;
    }
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const color = readDotColor();
    const half = tuning.dotSize / 2;
    for (const cell of cells) {
      sctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${cell.alpha})`;
      sctx.fillRect(cell.x - half, cell.y - half, tuning.dotSize, tuning.dotSize);
    }
    staticLayer = layer;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    cssWidth = rect.width;
    cssHeight = rect.height;
    canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
    canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    regenerateCells();
  }

  function maybeSpawnDash(now: number) {
    if (tuning.dashesPerSecond <= 0) return;
    if (dashes.length >= MAX_DASHES) return;
    if (now - lastDashSpawn < 1000 / tuning.dashesPerSecond) return;
    lastDashSpawn = now;
    const fromLeft = Math.random() < 0.5;
    const rows = Math.max(1, Math.floor(cssHeight / tuning.spacing));
    const y = (Math.floor(Math.random() * rows) + 0.5) * tuning.spacing;
    const speed = tuning.spacing * (1.6 + Math.random() * 1.2);
    dashes.push({
      y,
      startX: fromLeft ? -tuning.spacing * 2 : cssWidth + tuning.spacing,
      vx: fromLeft ? speed : -speed,
      len: tuning.spacing * (1.6 + Math.random() * 1.0),
      t0: now,
      dur: 1600 + Math.random() * 900,
    });
  }

  function frame(now: number) {
    if (hidden || cssWidth === 0) {
      raf = requestAnimationFrame(frame);
      return;
    }

    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if (staticLayer) {
      ctx.drawImage(staticLayer, 0, 0, cssWidth, cssHeight);
    }

    if (tuning.breath && !reducedMotion) {
      const cx = cssWidth / 2;
      const cy = cssHeight / 2;
      const radius = Math.min(cssWidth, cssHeight) * 0.45;
      const pulse = 0.5 + 0.5 * Math.sin((now / 1000) * BREATH_PERIOD_HZ * 2 * Math.PI);
      const color = readDotColor();
      ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${0.18 + 0.32 * pulse})`;
      const baseSize = tuning.dotSize;
      for (const cell of cells) {
        const dx = cell.x - cx;
        const dy = cell.y - cy;
        const d = Math.hypot(dx, dy);
        if (d > radius) continue;
        const k = 1 - d / radius;
        const size = baseSize + 2.2 * k * pulse;
        ctx.fillRect(cell.x - size / 2, cell.y - size / 2, size, size);
      }
    }

    if (!reducedMotion && tuning.dashesPerSecond > 0) {
      maybeSpawnDash(now);
      const color = readDotColor();
      const halfDot = tuning.dotSize / 2;
      for (let i = dashes.length - 1; i >= 0; i--) {
        const d = dashes[i];
        const age = now - d.t0;
        const k = age / d.dur;
        if (k >= 1) {
          dashes.splice(i, 1);
          continue;
        }
        const x = d.startX + d.vx * (age / 1000);
        const fade = 1 - k * k;
        ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${0.55 * fade})`;
        ctx.fillRect(x, d.y - halfDot, d.len, tuning.dotSize);
      }
    }

    raf = requestAnimationFrame(frame);
  }

  function onVisibility() {
    hidden = document.visibilityState === 'hidden';
  }

  function onReducedMotion(event: MediaQueryListEvent) {
    reducedMotion = event.matches;
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

  resize();
  raf = requestAnimationFrame(frame);

  return {
    refresh() {
      regenerateCells();
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      reducedMotionMq.removeEventListener('change', onReducedMotion);
    },
  };
}
