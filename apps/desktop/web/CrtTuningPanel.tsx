// Dev harness for the CRT terminal post-process. Renders the real WebGL2
// terminal renderer over a readable fake transcript, with live sliders bound to
// the CRT uniforms so the effect can be dialed against actual terminal text.
//
// Open with `npm run dev:harness` then visit `/?crtTuning=1` in Chrome.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createTerminalGpuRenderer } from './terminal-gpu-renderer';
import { TERMINAL_SURFACE } from './terminal-canvas-renderer';
import { TERMINAL_THEME } from './themes/terminalTheme';
import { CRT_BOOT_PRESET, CRT_GLASS_PRESET, type CrtParams } from './terminalCrt';
import { CrtLoadingCanvas } from './crtLoading';
import type { TerminalCell, TerminalFrame, TerminalRow } from './terminalTypes';

const FG = TERMINAL_THEME.dark.foreground;
const GREEN = '#7fd88f';
const CYAN = '#6cc7d6';
const AMBER = '#e2b65a';
const FAINT = '#8a8175';

// A readable fake session so warp + aberration can be judged on real glyphs,
// not noise. Each entry is [text, color].
const TRANSCRIPT: Array<[string, string]> = [
  ['reverie ~/Code/reverie  (main)', FAINT],
  ['', FG],
  ['> Summarize what the terminal renderer paints with.', FG],
  ['', FG],
  ['● The terminal renders through a WebGL2 pipeline:', FG],
  ['  glyph atlas + instanced quads, dirty-row paints into', FG],
  ['  a retained framebuffer. A CRT post-pass warps that', FG],
  ['  framebuffer to the screen as convex glass.', FG],
  ['', FG],
  ['  ┌─ pass order ─────────────────────────────┐', CYAN],
  ['  │ curvature → mask → aberration → scanline  │', CYAN],
  ['  │ → vignette → bloom                        │', CYAN],
  ['  └───────────────────────────────────────────┘', CYAN],
  ['', FG],
  ['  $ npm run dev:harness', GREEN],
  ['  VITE v5.4.2  ready in 412 ms', FAINT],
  ['  ➜  Local:   http://127.0.0.1:1420/', FAINT],
  ['', FG],
  ['  warning: readability is the constraint here —', AMBER],
  ['  the glass must stay legible at the corners.', AMBER],
  ['', FG],
  ['  the quick brown fox jumps over the lazy dog 0123456789', FG],
  ['  THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG !@#$%^&*()', FG],
  ['', FG],
  ['> _', GREEN],
];

function transcriptFrame(cols: number, rows: number): TerminalFrame {
  const out: TerminalRow[] = [];
  for (let row = 0; row < rows; row += 1) {
    const entry = TRANSCRIPT[row];
    const cells: TerminalCell[] = [];
    if (entry) {
      const [text, color] = entry;
      const chars = [...text].slice(0, cols);
      chars.forEach((ch, col) => {
        cells.push({ col, text: ch, fg: color, bg: TERMINAL_THEME.dark.background });
      });
    }
    out.push({ index: row, dirty: true, cells });
  }
  return {
    dirty: 'full',
    rows: out,
    cursor: { visible: true, row: 24, col: 4, style: 'block' },
    colors: {
      foreground: TERMINAL_THEME.dark.foreground,
      background: TERMINAL_THEME.dark.background,
      cursor: GREEN,
    },
  };
}

type SliderKey = keyof CrtParams;

const SLIDERS: Array<{ key: SliderKey; label: string; min: number; max: number; step: number }> = [
  { key: 'curvature', label: 'Curvature (bulge)', min: 0, max: 0.2, step: 0.005 },
  { key: 'aberration', label: 'Chromatic aberration', min: 0, max: 0.01, step: 0.0001 },
  { key: 'vignette', label: 'Vignette', min: 0, max: 0.8, step: 0.01 },
  { key: 'scanline', label: 'Scanline', min: 0, max: 0.6, step: 0.01 },
  { key: 'scanlineScale', label: 'Scanline scale (px)', min: 1, max: 8, step: 0.5 },
  { key: 'mask', label: 'RGB mask', min: 0, max: 1, step: 0.02 },
  { key: 'maskScale', label: 'Mask scale (px)', min: 1, max: 8, step: 0.5 },
  { key: 'bloom', label: 'Bloom', min: 0, max: 2, step: 0.05 },
  { key: 'bloomThreshold', label: 'Bloom threshold', min: 0, max: 1, step: 0.02 },
  { key: 'grain', label: 'Grain', min: 0, max: 0.3, step: 0.005 },
  { key: 'flicker', label: 'Flicker', min: 0, max: 0.2, step: 0.005 },
];

type Content = 'terminal' | 'boot' | 'resume';

// The terminal preview: the real WebGL2 renderer over the fake transcript, with
// the CRT effect driven live by the panel's glass params.
function TerminalPreview({ params, enabled }: { params: CrtParams; enabled: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<ReturnType<typeof createTerminalGpuRenderer> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frame = useMemo(() => transcriptFrame(TERMINAL_SURFACE.cols, TERMINAL_SURFACE.rows), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: create-once; live changes go through setCrt below.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: ReturnType<typeof createTerminalGpuRenderer>;
    try {
      renderer = createTerminalGpuRenderer(canvas, {
        cols: TERMINAL_SURFACE.cols,
        rows: TERMINAL_SURFACE.rows,
        cellWidth: TERMINAL_SURFACE.cellWidth,
        cellHeight: TERMINAL_SURFACE.cellHeight,
        fontSize: TERMINAL_SURFACE.fontSize,
        baseline: TERMINAL_SURFACE.baseline,
        preferredBackends: ['webgl2'],
        // Transparent like the real terminal: the canvas defers its background to
        // the CSS panel behind it (the wrapper's terminal-bg below), so tuning
        // here matches how the effect blends in the app.
        backgroundOpacity: 0,
        background: TERMINAL_THEME.dark.background,
        foreground: TERMINAL_THEME.dark.foreground,
        crt: enabled ? params : null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    rendererRef.current = renderer;
    renderer.paintFrame(frame);
    return () => {
      renderer.dispose?.();
      rendererRef.current = null;
    };
  }, [frame]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer?.setCrt) return;
    renderer.setCrt(enabled ? params : null);
    renderer.paintFrame(frame);
  }, [enabled, params, frame]);

  const width = TERMINAL_SURFACE.cols * TERMINAL_SURFACE.cellWidth;
  const height = TERMINAL_SURFACE.rows * TERMINAL_SURFACE.cellHeight;
  return (
    <div>
      {error && (
        <pre style={{ color: '#ff8a7a', fontSize: 11, whiteSpace: 'pre-wrap' }}>{error}</pre>
      )}
      <canvas
        ref={canvasRef}
        style={{
          width,
          height,
          display: 'block',
          borderRadius: 6,
          background: TERMINAL_THEME.dark.background,
        }}
      />
      <p style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }}>
        {width}×{height} CSS px · WebGL2 · {enabled ? 'CRT on' : 'flat'}
      </p>
    </div>
  );
}

// The loading-screen preview: the boot/resume content piped through the CRT pass
// with the panel's boot params. Boot loops so the fill is always visible.
function LoadingPreview({ variant, params }: { variant: 'boot' | 'resume'; params: CrtParams }) {
  const [key, setKey] = useState(0);
  return (
    <div>
      <div
        style={{ width: 760, height: 460, borderRadius: 6, overflow: 'hidden', background: '#000' }}
      >
        <CrtLoadingCanvas
          key={key}
          variant={variant}
          params={params}
          onDone={
            variant === 'boot' ? () => window.setTimeout(() => setKey(k => k + 1), 500) : undefined
          }
        />
      </div>
      <p style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }}>
        760×460 CSS px · {variant === 'boot' ? 'Reverie boot (loops)' : 'resume breathing'} · boot
        preset
      </p>
    </div>
  );
}

export function CrtTuningPanel() {
  const [content, setContent] = useState<Content>('terminal');
  const [enabled, setEnabled] = useState(true);
  // Separate param sets so the readable "glass" look (tuned on the terminal) and
  // the cranked "boot" look (tuned on the Reverie loading screen) are dialed
  // independently. The active set follows the selected test content.
  const [glassParams, setGlassParams] = useState<CrtParams>(CRT_GLASS_PRESET);
  const [bootParams, setBootParams] = useState<CrtParams>(CRT_BOOT_PRESET);

  const isTerminal = content === 'terminal';
  const params = isTerminal ? glassParams : bootParams;
  const setParams = isTerminal ? setGlassParams : setBootParams;

  return (
    <div
      style={{
        display: 'flex',
        gap: 24,
        padding: 24,
        background: '#1a1815',
        minHeight: '100vh',
        color: '#e8e1d7',
        fontFamily: 'ui-monospace, monospace',
      }}
    >
      <div style={{ flex: '0 0 auto' }}>
        {isTerminal ? (
          <TerminalPreview params={glassParams} enabled={enabled} />
        ) : (
          <LoadingPreview variant={content} params={bootParams} />
        )}
      </div>
      <div
        style={{
          flex: '1 1 280px',
          maxWidth: 340,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <h1 style={{ fontSize: 16, margin: 0 }}>CRT tuning</h1>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span
            style={{
              fontSize: 11,
              opacity: 0.6,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Test content
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['terminal', 'boot', 'resume'] as Content[]).map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setContent(c)}
                style={{ ...presetButton, background: content === c ? '#473f33' : '#2c2823' }}
              >
                {c === 'terminal' ? 'Terminal' : c === 'boot' ? 'Reverie boot' : 'Resume'}
              </button>
            ))}
          </div>
          <span style={{ fontSize: 11, opacity: 0.6 }}>
            {isTerminal
              ? 'Editing the glass preset (always-on, readable).'
              : 'Editing the boot preset (loading sequences only).'}
          </span>
        </div>

        {isTerminal && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
            Effect enabled
          </label>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={presetButton} onClick={() => setParams(CRT_GLASS_PRESET)}>
            Load glass preset
          </button>
          <button type="button" style={presetButton} onClick={() => setParams(CRT_BOOT_PRESET)}>
            Load boot preset
          </button>
        </div>
        {SLIDERS.map(slider => (
          <label
            key={slider.key}
            style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}
          >
            <span style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{slider.label}</span>
              <span style={{ opacity: 0.7 }}>{Number(params[slider.key]).toFixed(4)}</span>
            </span>
            <input
              type="range"
              min={slider.min}
              max={slider.max}
              step={slider.step}
              value={params[slider.key]}
              onChange={e => setParams(prev => ({ ...prev, [slider.key]: Number(e.target.value) }))}
            />
          </label>
        ))}
        <button
          type="button"
          style={{ ...presetButton, marginTop: 8 }}
          onClick={() => navigator.clipboard?.writeText(JSON.stringify(params, null, 2))}
        >
          Copy {isTerminal ? 'glass' : 'boot'} params JSON
        </button>
      </div>
    </div>
  );
}

const presetButton: React.CSSProperties = {
  background: '#2c2823',
  color: '#e8e1d7',
  border: '1px solid #463f37',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 12,
  cursor: 'pointer',
};
