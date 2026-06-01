// Shared canvas dot-field renderer.
//
// The product's signature texture: dots represent agents and activity. One
// primitive is configured by variant for every surface that needs the motif
// (ambient background, launching hero, dashboard constellation, card glyphs).
// Performance is non-negotiable, and this surface is full-window, so it must
// never repaint when nothing is moving. A static dot layer is cached on an
// offscreen canvas. The ambient field is event-driven: it draws the static
// layer once, then runs a rAF loop only while a dash is alive, and even then it
// repaints just the row-band each dash occupies (never the whole window). Dash
// spawns are scheduled with a timer instead of polling every frame. The
// breathing launch variant animates the full field, so it keeps a continuous
// loop while visible. DPR is capped at 2, both loops stop when the tab is
// hidden, and prefers-reduced-motion disables all movement (static only).

export type DotFieldVariant = 'ambient' | 'launching';

export interface DotFieldOptions {
  variant?: DotFieldVariant;
}

export interface DotFieldHandle {
  /** Re-measure the canvas, regenerate cells, and rebuild the static layer.
   *  Call after theme changes so dot colors track the current CSS variables. */
  refresh(): void;
  /** Tear down the rAF loop, observers, timers, and listeners. */
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

interface Band {
  y0: number;
  h: number;
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
    baseAlphaRange: 0.1,
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
  // Row-bands painted last frame; restored to the static layer before the next
  // frame so a moving dash never leaves a trail and we never clear the window.
  let prevBands: Band[] = [];
  let raf = 0;
  let dashTimer = 0;
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

  /** Paint the whole static layer to the visible canvas. Used for the idle
   *  steady state and for the continuously-animated breath variant. */
  function drawStaticFull() {
    if (cssWidth === 0) return;
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    if (staticLayer) ctx.drawImage(staticLayer, 0, 0, cssWidth, cssHeight);
  }

  /** Restore one full-width row-band from the static layer (erases a dash). */
  function restoreBand(band: Band) {
    if (band.h <= 0) return;
    ctx.clearRect(0, band.y0, cssWidth, band.h);
    if (staticLayer) {
      ctx.drawImage(
        staticLayer,
        0,
        band.y0 * dpr,
        cssWidth * dpr,
        band.h * dpr,
        0,
        band.y0,
        cssWidth,
        band.h,
      );
    }
  }

  function dashBand(dash: Dash): Band {
    const halfDot = tuning.dotSize / 2;
    const top = Math.max(0, Math.floor(dash.y - halfDot - 1));
    const bottom = Math.min(cssHeight, Math.ceil(dash.y + halfDot + 1));
    return { y0: top, h: Math.max(0, bottom - top) };
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
    // Geometry changed: drop transient dashes and repaint the static base.
    dashes = [];
    prevBands = [];
    drawStaticFull();
  }

  function spawnDash(now: number) {
    if (dashes.length >= MAX_DASHES) return;
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

  function scheduleNextDash() {
    if (tuning.dashesPerSecond <= 0 || reducedMotion || hidden) return;
    if (dashTimer) return;
    const interval = 1000 / tuning.dashesPerSecond;
    dashTimer = window.setTimeout(onDashTick, interval);
  }

  function onDashTick() {
    dashTimer = 0;
    if (!hidden && !reducedMotion) {
      spawnDash(performance.now());
      if (!raf) raf = requestAnimationFrame(dashFrame);
    }
    scheduleNextDash();
  }

  // Ambient loop: runs only while a dash is alive, and touches only the
  // row-bands the dashes occupy. When the last dash expires it restores the
  // final bands and stops, leaving the static layer on screen.
  function dashFrame(now: number) {
    raf = 0;
    if (hidden || cssWidth === 0) return;

    // Erase last frame's bands and this frame's bands (deduped) back to static.
    const bands = mergeBands([...prevBands, ...dashes.map(dashBand)]);
    for (const band of bands) restoreBand(band);

    const color = readDotColor();
    const halfDot = tuning.dotSize / 2;
    const newBands: Band[] = [];
    for (let i = dashes.length - 1; i >= 0; i--) {
      const dash = dashes[i];
      const age = now - dash.t0;
      const k = age / dash.dur;
      if (k >= 1) {
        dashes.splice(i, 1);
        continue;
      }
      const x = dash.startX + dash.vx * (age / 1000);
      const fade = 1 - k * k;
      ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${0.55 * fade})`;
      ctx.fillRect(x, dash.y - halfDot, dash.len, tuning.dotSize);
      newBands.push(dashBand(dash));
    }
    prevBands = newBands;

    if (dashes.length > 0) {
      raf = requestAnimationFrame(dashFrame);
    }
  }

  // Launching loop: the breath touches the full field, so this redraws the
  // whole surface each frame. It only runs while visible and not reduced.
  function breathFrame(now: number) {
    raf = 0;
    if (hidden || cssWidth === 0) return;

    drawStaticFull();

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

    raf = requestAnimationFrame(breathFrame);
  }

  function mergeBands(bands: Band[]): Band[] {
    const merged: Band[] = [];
    for (const band of bands) {
      if (band.h <= 0) continue;
      const existing = merged.find(other => other.y0 === band.y0 && other.h === band.h);
      if (!existing) merged.push(band);
    }
    return merged;
  }

  // Pick the right loop/timer for the variant and current state. Idempotent.
  function start() {
    drawStaticFull();
    if (hidden) return;
    if (tuning.breath) {
      if (!reducedMotion && !raf) raf = requestAnimationFrame(breathFrame);
    } else {
      scheduleNextDash();
    }
  }

  function stop() {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (dashTimer) {
      clearTimeout(dashTimer);
      dashTimer = 0;
    }
  }

  function onVisibility() {
    const nowHidden = document.visibilityState === 'hidden';
    if (nowHidden === hidden) return;
    hidden = nowHidden;
    if (hidden) {
      stop();
      dashes = [];
      prevBands = [];
    } else {
      start();
    }
  }

  function onReducedMotion(event: MediaQueryListEvent) {
    reducedMotion = event.matches;
    stop();
    dashes = [];
    prevBands = [];
    drawStaticFull();
    if (!reducedMotion) start();
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
  start();

  return {
    refresh() {
      regenerateCells();
      // Repaint the whole field so a theme change recolors every dot at once,
      // not just the row-bands a dash happens to touch. Drop stale band state.
      prevBands = [];
      drawStaticFull();
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
