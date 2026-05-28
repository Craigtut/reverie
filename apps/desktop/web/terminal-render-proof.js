import {
  TERMINAL_SURFACE,
  createTerminalCanvasRenderer,
  makeSyntheticFrame,
  percentile,
} from './terminal-canvas-renderer.js';

const BENCH_FRAMES = 360;
const DIRTY_ROWS_PER_FRAME = 8;

const canvas = document.querySelector('#terminal-canvas');
const log = document.querySelector('#proof-log');
const metrics = document.querySelector('#metrics');
const startButton = document.querySelector('#start-proof');
const ghosttyButton = document.querySelector('#ghostty-proof');
const streamButton = document.querySelector('#stream-proof');
const clearButton = document.querySelector('#clear-proof');

const terminalRenderer = createTerminalCanvasRenderer(canvas, TERMINAL_SURFACE);

function writeLog(line) {
  const stamped = `[${new Date().toLocaleTimeString()}] ${line}`;
  log.textContent = `${stamped}\n${log.textContent}`;
}

function setButtonsDisabled(disabled) {
  startButton.disabled = disabled;
  ghosttyButton.disabled = disabled;
  streamButton.disabled = disabled;
}

async function runSyntheticBenchmark({ dirtyOnly }) {
  const timings = [];
  let cellsDrawn = 0;
  const started = performance.now();

  for (let frameIndex = 0; frameIndex < BENCH_FRAMES; frameIndex++) {
    const frame = makeSyntheticFrame(frameIndex, {
      cols: terminalRenderer.cols,
      rows: terminalRenderer.rows,
      dirtyRowsPerFrame: DIRTY_ROWS_PER_FRAME,
      dirtyOnly,
    });
    const frameStarted = performance.now();
    terminalRenderer.paintFrame(frame);
    const frameEnded = performance.now();
    timings.push(frameEnded - frameStarted);
    cellsDrawn += frame.rows.reduce((sum, row) => sum + row.cells.length, 0);

    if (frameIndex % 30 === 0) {
      await new Promise(requestAnimationFrame);
    }
  }

  const elapsed = performance.now() - started;
  return {
    mode: dirtyOnly ? 'synthetic dirty-row patch' : 'synthetic full-frame repaint',
    frames: BENCH_FRAMES,
    cellsDrawn,
    elapsedMs: elapsed,
    avgFrameMs: timings.reduce((sum, value) => sum + value, 0) / timings.length,
    p95FrameMs: percentile(timings, 0.95),
    maxFrameMs: Math.max(...timings),
    cellsPerSecond: cellsDrawn / (elapsed / 1000),
  };
}

async function runGhosttyBridgeBenchmark() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) {
    throw new Error('Tauri invoke bridge is unavailable. Run this proof inside the Tauri desktop shell.');
  }

  const fetchStarted = performance.now();
  const payload = await invoke('ghostty_frame_sequence');
  const fetchElapsed = performance.now() - fetchStarted;
  const timings = [];
  let cellsDrawn = 0;
  const renderStarted = performance.now();

  for (let frameIndex = 0; frameIndex < payload.frames.length; frameIndex++) {
    const frame = payload.frames[frameIndex];
    const frameStarted = performance.now();
    terminalRenderer.paintFrame(frame);
    const frameEnded = performance.now();
    timings.push(frameEnded - frameStarted);
    cellsDrawn += terminalRenderer.rowsToPaint(frame).reduce((sum, row) => sum + row.cells.length, 0);

    if (frameIndex % 12 === 0) {
      await new Promise(requestAnimationFrame);
    }
  }

  const renderElapsed = performance.now() - renderStarted;
  return {
    mode: 'Ghostty frame bridge',
    frames: payload.frames.length,
    cellsDrawn,
    elapsedMs: renderElapsed,
    avgFrameMs: timings.reduce((sum, value) => sum + value, 0) / timings.length,
    p95FrameMs: percentile(timings, 0.95),
    maxFrameMs: Math.max(...timings),
    cellsPerSecond: cellsDrawn / (renderElapsed / 1000),
    bridgeMs: fetchElapsed,
    outputBytes: payload.output_bytes,
  };
}

async function runGhosttyLiveStreamBenchmark() {
  const invoke = window.__TAURI__?.core?.invoke;
  const listen = window.__TAURI__?.event?.listen;
  if (!invoke || !listen) {
    throw new Error('Tauri event bridge is unavailable. Run this proof inside the Tauri desktop shell.');
  }

  const timings = [];
  const interEventTimings = [];
  let cellsDrawn = 0;
  let framesReceived = 0;
  let droppedFrames = 0;
  let expectedSeq = 0;
  let lastEventAt = null;
  let receiveStarted = null;
  let startedPayload = null;
  let unlistenStarted = null;
  let unlistenFrame = null;
  let unlistenFinished = null;
  let unlistenFailed = null;

  function cleanup() {
    unlistenStarted?.();
    unlistenFrame?.();
    unlistenFinished?.();
    unlistenFailed?.();
  }

  return new Promise(async (resolve, reject) => {
    try {
      unlistenStarted = await listen('reverie-terminal-stream-started', event => {
        startedPayload = event.payload;
        receiveStarted = performance.now();
        writeLog(`Live stream started: target=${startedPayload.targetFrames} cols=${startedPayload.cols} rows=${startedPayload.rows}.`);
      });

      unlistenFrame = await listen('reverie-terminal-stream-frame', event => {
        const now = performance.now();
        if (receiveStarted === null) receiveStarted = now;
        if (lastEventAt !== null) interEventTimings.push(now - lastEventAt);
        lastEventAt = now;

        const payload = event.payload;
        if (payload.seq !== expectedSeq) {
          droppedFrames += Math.max(0, payload.seq - expectedSeq);
        }
        expectedSeq = payload.seq + 1;

        const frameStarted = performance.now();
        terminalRenderer.paintFrame(payload.frame);
        const frameEnded = performance.now();

        timings.push(frameEnded - frameStarted);
        cellsDrawn += terminalRenderer.rowsToPaint(payload.frame).reduce((sum, row) => sum + row.cells.length, 0);
        framesReceived += 1;
      });

      unlistenFinished = await listen('reverie-terminal-stream-finished', event => {
        const finished = event.payload;
        const receiveElapsed = receiveStarted === null ? 0 : performance.now() - receiveStarted;
        cleanup();

        const result = {
          mode: 'Ghostty live PTY event stream',
          frames: finished.framesEmitted,
          framesReceived,
          droppedFrames,
          chunksRead: finished.chunksRead,
          cellsDrawn,
          elapsedMs: receiveElapsed,
          avgFrameMs: timings.reduce((sum, value) => sum + value, 0) / Math.max(1, timings.length),
          p95FrameMs: percentile(timings, 0.95),
          maxFrameMs: Math.max(0, ...timings),
          cellsPerSecond: cellsDrawn / Math.max(0.001, receiveElapsed / 1000),
          outputBytes: finished.bytesRead,
          rustElapsedMs: finished.rustElapsedMs,
          totalEmitMs: finished.totalEmitMs,
          avgEmitMs: finished.avgEmitMs,
          maxEmitMs: finished.maxEmitMs,
          avgInterEventMs: interEventTimings.reduce((sum, value) => sum + value, 0) / Math.max(1, interEventTimings.length),
          p95InterEventMs: percentile(interEventTimings, 0.95),
          maxInterEventMs: Math.max(0, ...interEventTimings),
          childSuccess: finished.childSuccess,
          targetFrames: startedPayload?.targetFrames,
        };

        resolve(result);
      });

      unlistenFailed = await listen('reverie-terminal-stream-failed', event => {
        cleanup();
        reject(new Error(event.payload?.message || 'live stream failed'));
      });

      await invoke('start_live_pty_stream_proof');
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function optionalMetric(label, value, formatter = value => value) {
  if (value === undefined || value === null) return '';
  return `<div><dt>${label}</dt><dd>${formatter(value)}</dd></div>`;
}

function renderMetrics(results) {
  metrics.innerHTML = results.map(result => `
    <section class="metric-card">
      <h2>${result.mode}</h2>
      <dl>
        <div><dt>Frames</dt><dd>${result.frames}</dd></div>
        ${optionalMetric('Frames received', result.framesReceived)}
        ${optionalMetric('Dropped frames', result.droppedFrames)}
        ${optionalMetric('Chunks read', result.chunksRead)}
        <div><dt>Cells drawn</dt><dd>${result.cellsDrawn.toLocaleString()}</dd></div>
        <div><dt>Total paint/receive</dt><dd>${result.elapsedMs.toFixed(1)} ms</dd></div>
        <div><dt>Avg paint</dt><dd>${result.avgFrameMs.toFixed(3)} ms</dd></div>
        <div><dt>P95 paint</dt><dd>${result.p95FrameMs.toFixed(3)} ms</dd></div>
        <div><dt>Max paint</dt><dd>${result.maxFrameMs.toFixed(3)} ms</dd></div>
        <div><dt>Cells/sec</dt><dd>${Math.round(result.cellsPerSecond).toLocaleString()}</dd></div>
        ${optionalMetric('Bridge fetch', result.bridgeMs, value => `${value.toFixed(1)} ms`)}
        ${optionalMetric('VT bytes', result.outputBytes, value => value.toLocaleString())}
        ${optionalMetric('Rust stream', result.rustElapsedMs, value => `${value.toFixed(1)} ms`)}
        ${optionalMetric('Avg emit', result.avgEmitMs, value => `${value.toFixed(3)} ms`)}
        ${optionalMetric('Max emit', result.maxEmitMs, value => `${value.toFixed(3)} ms`)}
        ${optionalMetric('Avg inter-event', result.avgInterEventMs, value => `${value.toFixed(3)} ms`)}
        ${optionalMetric('P95 inter-event', result.p95InterEventMs, value => `${value.toFixed(3)} ms`)}
        ${optionalMetric('Max inter-event', result.maxInterEventMs, value => `${value.toFixed(3)} ms`)}
        ${optionalMetric('Child success', result.childSuccess, value => String(value))}
      </dl>
    </section>
  `).join('');
}

async function recordMetrics(result) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;

  try {
    await invoke('record_render_metrics', { metrics: result });
  } catch (error) {
    writeLog(`Unable to record metrics through Tauri: ${error.message}`);
  }
}

startButton.addEventListener('click', async () => {
  setButtonsDisabled(true);
  writeLog('Starting Canvas terminal surface benchmark with synthetic Reverie TerminalFrame data.');
  const full = await runSyntheticBenchmark({ dirtyOnly: false });
  writeLog(`Synthetic full repaint complete: avg=${full.avgFrameMs.toFixed(3)}ms p95=${full.p95FrameMs.toFixed(3)}ms.`);
  const dirty = await runSyntheticBenchmark({ dirtyOnly: true });
  writeLog(`Synthetic dirty-row patch complete: avg=${dirty.avgFrameMs.toFixed(3)}ms p95=${dirty.p95FrameMs.toFixed(3)}ms.`);
  renderMetrics([full, dirty]);
  setButtonsDisabled(false);
});

async function runGhosttyBridgeProof() {
  setButtonsDisabled(true);
  try {
    writeLog('Requesting real libghostty-vt TerminalFrame sequence through the Tauri invoke bridge.');
    const result = await runGhosttyBridgeBenchmark();
    writeLog(`Ghostty bridge complete: frames=${result.frames} avg=${result.avgFrameMs.toFixed(3)}ms p95=${result.p95FrameMs.toFixed(3)}ms bridge=${result.bridgeMs.toFixed(1)}ms.`);
    renderMetrics([result]);
    await recordMetrics(result);
    return result;
  } catch (error) {
    writeLog(`Ghostty bridge proof failed: ${error.message}`);
    throw error;
  } finally {
    setButtonsDisabled(false);
  }
}

async function runGhosttyLiveStreamProof() {
  setButtonsDisabled(true);
  try {
    writeLog('Starting live PTY -> Ghostty -> Tauri event stream proof.');
    const result = await runGhosttyLiveStreamBenchmark();
    writeLog(`Live stream complete: received=${result.framesReceived}/${result.frames} chunks=${result.chunksRead} avg=${result.avgFrameMs.toFixed(3)}ms p95=${result.p95FrameMs.toFixed(3)}ms inter-event-p95=${result.p95InterEventMs.toFixed(3)}ms.`);
    renderMetrics([result]);
    await recordMetrics(result);
    return result;
  } catch (error) {
    writeLog(`Live stream proof failed: ${error.message}`);
    throw error;
  } finally {
    setButtonsDisabled(false);
  }
}

ghosttyButton.addEventListener('click', () => {
  runGhosttyBridgeProof().catch(() => {});
});
streamButton.addEventListener('click', () => {
  runGhosttyLiveStreamProof().catch(() => {});
});

if (window.__TAURI__?.core?.invoke) {
  window.setTimeout(async () => {
    writeLog('Tauri runtime detected; auto-running Ghostty bridge and live stream proofs for reproducible benchmark capture.');
    try {
      await runGhosttyBridgeProof();
      await runGhosttyLiveStreamProof();
    } catch {
      // Each proof already writes its own failure into the visible log.
    }
  }, 500);
}

clearButton.addEventListener('click', () => {
  terminalRenderer.clear();
  metrics.innerHTML = '';
  log.textContent = '';
});

terminalRenderer.paintFrame(makeSyntheticFrame(0));
writeLog('Ready. Synthetic proof isolates Canvas cost; Ghostty bridge and live-stream proofs render real libghostty-vt frames inside the Tauri shell.');
