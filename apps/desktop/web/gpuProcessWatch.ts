// Notice when WebKit restarts its GPU process, so 2D canvas islands can repaint.
//
// WebKit renders every canvas in a separate GPU process and relaunches that
// process when it crashes or is judged unresponsive. WebGL contexts are told
// (webglcontextlost, then webglcontextrestored); 2D canvases are told nothing,
// yet they lose their pixels, and a CanvasGradient created before the restart
// fills solid black afterwards. So this module keeps one 1x1 WebGL context as a
// sentinel and tells subscribers when it is restored: their cue to drop cached
// canvas resources (gradients, offscreen layers) and repaint.
//
// The sentinel is created on the first subscription and lives for the page.
// WebKit evicts the oldest live WebGL context only past 16 per page, far more
// than Reverie holds (the terminal and the brief resume overlay).

type Listener = () => void;

const listeners = new Set<Listener>();
let sentinel: HTMLCanvasElement | null = null;

function ensureSentinel() {
  if (sentinel || typeof document === 'undefined') return;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'low-power',
  });
  if (!gl) return;
  // Without preventDefault the context stays lost and is never restored.
  canvas.addEventListener('webglcontextlost', event => event.preventDefault());
  canvas.addEventListener('webglcontextrestored', notifyRestart);
  sentinel = canvas;
}

function notifyRestart() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[reverie] GPU restart listener failed', error);
    }
  }
}

/** Call `listener` each time WebKit's GPU process comes back after a restart.
 *  Returns the unsubscribe function. */
export function onGpuProcessRestart(listener: Listener): () => void {
  ensureSentinel();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
