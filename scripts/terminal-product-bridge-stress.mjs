#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.REVERIE_PRODUCT_STRESS_CHROME_PORT ?? 9366);
const bridgeUrl = process.env.REVERIE_PRODUCT_STRESS_BRIDGE_URL ?? 'http://127.0.0.1:17777';
const webBaseUrl = process.env.REVERIE_PRODUCT_STRESS_WEB_URL ?? 'http://127.0.0.1:1421/';
const transcriptRows = Number(process.env.REVERIE_PRODUCT_STRESS_TRANSCRIPT_ROWS ?? 2200);
const stressLoops = Number(process.env.REVERIE_PRODUCT_STRESS_LOOPS ?? 2);
const renderer = process.env.REVERIE_PRODUCT_STRESS_RENDERER ?? 'webgl2';
const command = process.env.REVERIE_PRODUCT_STRESS_COMMAND ?? defaultStressCommand();
const headless = process.env.REVERIE_PRODUCT_STRESS_HEADLESS !== '0';
const keepOpen = process.env.REVERIE_PRODUCT_STRESS_KEEP_OPEN === '1';
const screenshotDir = process.env.REVERIE_PRODUCT_STRESS_SCREENSHOT_DIR ?? '';
const wheelDelayMs = Number(process.env.REVERIE_PRODUCT_STRESS_WHEEL_DELAY_MS ?? 90);
const strictVisual = process.env.REVERIE_PRODUCT_STRESS_STRICT_VISUAL !== '0';
const visualEvidence = [];
const url =
  process.env.REVERIE_PRODUCT_STRESS_URL ??
  `${webBaseUrl}?fixture=populated&resetFixture=1&terminalBridge=1&terminalRenderer=${encodeURIComponent(
    renderer,
  )}&bridgeUrl=${encodeURIComponent(bridgeUrl)}&bridgeCommand=${encodeURIComponent(command)}`;

async function main() {
  const chrome = findChromium();
  const userDataDir = join(tmpdir(), `reverie-product-terminal-stress-${process.pid}`);
  mkdirSync(userDataDir, { recursive: true });
  if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });

  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--hide-scrollbars=false',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-component-update',
    '--disable-default-apps',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,800',
    url,
  ];
  if (headless) chromeArgs.splice(2, 0, '--headless=new');

  const child = spawn(chrome, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', chunk => process.stderr.write(chunk));

  let cdp = null;
  try {
    const page = await waitForPageTarget(port, url);
    cdp = await CdpClient.connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    await waitForSnapshot(
      cdp,
      snapshot => snapshot.cards > 0 || snapshot.tabs > 0 || Boolean(snapshot.viewport),
      15_000,
      'app shell controls',
    );
    await openFixtureSession(cdp);

    const ready = await waitForProductReady(cdp);
    await assertVisibleLiveAdvances(cdp, 'initial live output');
    await assertViewportConstrained(ready, 'initial');
    await assertVisibleCanvasPaint(cdp, 'initial live');

    for (let cycle = 1; cycle <= stressLoops; cycle += 1) {
      const bottom = await snapshotOf(cdp);
      const bottomThumb = bottom.scrollbar?.thumbTop ?? null;
      await wheelRows(cdp, -80, 8);
      const detached = await waitForSnapshot(
        cdp,
        snapshot =>
          snapshot.summary?.liveFollow === false &&
          snapshot.followState === 'history' &&
          snapshot.scrollbar?.thumbTop !== bottomThumb &&
          hasVisibleHistRows(snapshot),
        12_000,
        `cycle ${cycle} scroll up`,
      );
      await assertViewportConstrained(detached, `cycle ${cycle} detached`);
      await assertLiveFrameEventsContinue(cdp, `cycle ${cycle} detached live frames`);
      await assertVisibleCanvasPaint(cdp, `cycle ${cycle} detached history`);

      await resize(cdp, 720, 520);
      const narrow = await waitForSnapshot(
        cdp,
        snapshot =>
          snapshot.summary?.liveFollow === false &&
          hasVisibleHistRows(snapshot) &&
          snapshot.viewport?.clientHeight > 100 &&
          snapshot.viewport?.clientHeight < 700 &&
          snapshot.stage?.height < 700 &&
          snapshot.shell?.height <= 520,
        12_000,
        `cycle ${cycle} narrow resize`,
      );
      await assertViewportConstrained(narrow, `cycle ${cycle} narrow`);
      await assertVisibleCanvasPaint(cdp, `cycle ${cycle} narrow history`);

      await wheelRows(cdp, -36, 4);
      const scrolledNarrow = await waitForSnapshot(
        cdp,
        snapshot =>
          snapshot.summary?.liveFollow === false &&
          hasVisibleHistRows(snapshot) &&
          snapshot.scrollbar?.thumbTop !== null,
        12_000,
        `cycle ${cycle} narrow scroll`,
      );
      await assertViewportConstrained(scrolledNarrow, `cycle ${cycle} narrow scroll`);
      await assertVisibleCanvasPaint(cdp, `cycle ${cycle} narrow scrolled history`);

      await followLive(cdp);
      const live = await waitForSnapshot(
        cdp,
        snapshot => snapshot.summary?.liveFollow === true && snapshot.followState === 'live',
        12_000,
        `cycle ${cycle} follow live`,
      );
      await assertViewportConstrained(live, `cycle ${cycle} live`);
      await assertVisibleLiveAdvances(cdp, `cycle ${cycle} live output after follow`);
      await assertVisibleCanvasPaint(cdp, `cycle ${cycle} live`);

      await resize(cdp, 1200, 800);
      const wide = await waitForSnapshot(
        cdp,
        snapshot => snapshot.viewport?.clientHeight > 500 && snapshot.shell?.height <= 800,
        12_000,
        `cycle ${cycle} wide resize`,
      );
      await assertViewportConstrained(wide, `cycle ${cycle} wide`);
      await assertVisibleCanvasPaint(cdp, `cycle ${cycle} wide`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          loops: stressLoops,
          transcriptRows,
          visualEvidence,
          final: summarizeSnapshot(await snapshotOf(cdp)),
        },
        null,
        2,
      ),
    );
  } finally {
    if (cdp) {
      await terminateBridgeSession(cdp).catch(() => {});
      cdp.close();
    }
    if (!keepOpen) {
      child.kill('SIGTERM');
      await waitForExit(child);
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } else {
      console.error(`Leaving Chrome open on port ${port} with profile ${userDataDir}`);
    }
  }
}

function defaultStressCommand() {
  return [
    `i=1`,
    `while [ $i -le ${Math.max(1, transcriptRows)} ]; do`,
    `  printf "HIST %04d product-stress abcdefghijklmnopqrstuvwxyz0123456789\\\\n" $i`,
    `  i=$((i+1))`,
    `done`,
    `t=0`,
    `while true; do`,
    `  printf "LIVE %06d product-stress tick\\\\n" $t`,
    `  printf "SPIN %06d product-stress tick\\\\n" $t`,
    `  t=$((t+1))`,
    `  sleep 0.05`,
    `done`,
  ].join('; ');
}

async function openFixtureSession(cdp) {
  const clicked = await evaluate(
    cdp,
    `(() => {
      const selectors = [
        '[data-testid="dashboard-session-card"]',
        '[data-testid="session-tab"]',
        '[data-testid="nav-session-row"]',
      ].join(', ');
      const all = [...document.querySelectorAll(selectors)];
      const candidate =
        all.find(element => /Scratch notes|Session store spike/.test(element.textContent || '')) ??
        all[0];
      if (candidate instanceof HTMLElement) {
        candidate.click();
        return candidate.textContent ?? '';
      }
      return null;
    })()`,
  );
  if (clicked === null) throw new Error('No fixture session was available to open');
}

async function waitForProductReady(cdp) {
  return waitForSnapshot(
    cdp,
    snapshot =>
      snapshot.status === 'Running' &&
      Number(snapshot.summary?.rowCount ?? 0) > transcriptRows &&
      (hasVisibleHistRows(snapshot) || hasVisibleLiveRows(snapshot)),
    Math.max(30_000, transcriptRows * 8),
    'product terminal ready',
  );
}

async function followLive(cdp) {
  const clicked = await evaluate(
    cdp,
    `(() => {
      const button = document.querySelector('[data-testid="follow-live-button"]');
      if (button instanceof HTMLButtonElement) {
        button.click();
        return true;
      }
      return false;
    })()`,
  );
  if (clicked) return;
  await wheelRows(cdp, 120, 12);
}

async function resize(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(350);
  await flushAnimationFrames(cdp, 3);
}

async function wheelRows(cdp, rows, repeats) {
  for (let index = 0; index < repeats; index += 1) {
    const snapshot = await snapshotOf(cdp);
    const rect = snapshot.viewport?.rect;
    if (!rect) throw new Error('Missing terminal viewport for wheel event');
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      deltaX: 0,
      deltaY: rows * 18,
    });
    if (wheelDelayMs > 0) await sleep(wheelDelayMs);
  }
}

async function assertViewportConstrained(snapshot, label) {
  const viewportHeight = Number(snapshot.viewport?.clientHeight ?? 0);
  const stageHeight = Number(snapshot.stage?.height ?? 0);
  const shellHeight = Number(snapshot.shell?.height ?? 0);
  const surfaceRows = Number(snapshot.summary?.surface?.rows ?? 0);
  if (!(viewportHeight > 100)) {
    throw new Error(
      `${label}: viewport is too small: ${JSON.stringify(summarizeSnapshot(snapshot))}`,
    );
  }
  if (viewportHeight > Math.max(900, shellHeight + 20)) {
    throw new Error(
      `${label}: viewport expanded beyond shell: ${JSON.stringify(summarizeSnapshot(snapshot))}`,
    );
  }
  if (stageHeight > Math.max(900, shellHeight + 20)) {
    throw new Error(
      `${label}: stage expanded beyond shell: ${JSON.stringify(summarizeSnapshot(snapshot))}`,
    );
  }
  if (surfaceRows > 80) {
    throw new Error(
      `${label}: surface rows exploded to ${surfaceRows}: ${JSON.stringify(
        summarizeSnapshot(snapshot),
      )}`,
    );
  }
}

async function assertLiveFrameEventsContinue(cdp, label) {
  const before = await snapshotOf(cdp);
  const beforeSeq = Number(before.summary?.events?.lastMatchedFrameSeq ?? -1);
  await sleep(900);
  const after = await snapshotOf(cdp);
  const afterSeq = Number(after.summary?.events?.lastMatchedFrameSeq ?? -1);
  if (!(afterSeq > beforeSeq)) {
    throw new Error(
      `${label}: live frames did not advance, before=${beforeSeq}, after=${afterSeq}`,
    );
  }
}

async function assertVisibleLiveAdvances(cdp, label) {
  const before = await waitForSnapshot(
    cdp,
    snapshot => maxVisibleLiveTick(snapshot) !== null,
    12_000,
    `${label} visible live before`,
  );
  const beforeTick = maxVisibleLiveTick(before) ?? -1;
  await sleep(900);
  const after = await waitForSnapshot(
    cdp,
    snapshot => {
      const tick = maxVisibleLiveTick(snapshot);
      return tick !== null && tick > beforeTick;
    },
    12_000,
    `${label} visible live after`,
  );
  const afterTick = maxVisibleLiveTick(after) ?? -1;
  if (!(afterTick > beforeTick)) {
    throw new Error(
      `${label}: live output did not advance, before=${beforeTick}, after=${afterTick}`,
    );
  }
}

async function assertVisibleCanvasPaint(cdp, label) {
  await flushAnimationFrames(cdp, 3);
  const probe = await evaluate(cdp, canvasPixelProbeExpression());
  const screenshotPath = await captureScreenshot(cdp, label);
  visualEvidence.push({ label, screenshotPath, probe: summarizeCanvasProbe(probe) });
  if (!probe?.ok) {
    if (strictVisual) {
      throw new Error(`${label}: canvas probe failed: ${probe?.reason ?? 'unknown failure'}`);
    }
    return;
  }
  if ((probe.visibleCopiedBrightPixels ?? 0) < 100) {
    if (strictVisual) {
      throw new Error(
        `${label}: visible canvas has too few bright pixels: ${JSON.stringify(probe)}`,
      );
    }
    return;
  }
  if ((probe.brightScanRows ?? 0) < 8) {
    if (strictVisual) {
      throw new Error(
        `${label}: visible canvas has too few lit scan rows: ${JSON.stringify(probe)}`,
      );
    }
    return;
  }
  if ((probe.longestDarkRun ?? 0) > Math.min(180, (probe.sourceHeight ?? 0) * 0.45)) {
    if (strictVisual) {
      throw new Error(`${label}: visible canvas has a large blank band: ${JSON.stringify(probe)}`);
    }
    return;
  }
  const expectedLitCellRows = Math.floor(
    Math.min(probe.visibleModelRows ?? 0, probe.totalCellRows ?? 0) * 0.6,
  );
  if (expectedLitCellRows >= 5 && (probe.litCellRows ?? 0) < expectedLitCellRows) {
    if (strictVisual) {
      throw new Error(
        `${label}: visible canvas has too few lit terminal rows: ${JSON.stringify(probe)}`,
      );
    }
    return;
  }
  if (
    (probe.totalCellRows ?? 0) >= 8 &&
    (probe.longestDarkCellRun ?? 0) > Math.max(3, Math.floor((probe.totalCellRows ?? 0) * 0.28))
  ) {
    if (strictVisual) {
      throw new Error(
        `${label}: visible canvas has too many consecutive blank terminal rows: ${JSON.stringify(
          probe,
        )}`,
      );
    }
  }
}

async function captureScreenshot(cdp, label) {
  if (!screenshotDir) return null;
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const filename = `${String(visualEvidence.length + 1).padStart(2, '0')}-${slugify(label)}.png`;
  const path = join(screenshotDir, filename);
  writeFileSync(path, Buffer.from(screenshot.data, 'base64'));
  return path;
}

function summarizeCanvasProbe(probe) {
  if (!probe) return null;
  return {
    ok: probe.ok,
    reason: probe.reason,
    sourceWidth: probe.sourceWidth,
    sourceHeight: probe.sourceHeight,
    visibleCopiedBrightPixels: probe.visibleCopiedBrightPixels,
    brightScanRows: probe.brightScanRows,
    longestDarkRun: probe.longestDarkRun,
    totalCellRows: probe.totalCellRows,
    litCellRows: probe.litCellRows,
    longestDarkCellRun: probe.longestDarkCellRun,
    visibleModelRows: probe.visibleModelRows,
  };
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 80);
}

function canvasPixelProbeExpression() {
  return `(() => {
    const canvas = document.querySelector('[data-testid="terminal-canvas"]');
    if (!(canvas instanceof HTMLCanvasElement)) return { ok: false, reason: 'missing canvas' };
    const viewport = document.querySelector('[data-testid="terminal-viewport"]');
    if (!(viewport instanceof HTMLElement)) return { ok: false, reason: 'missing viewport' };
    const debug = window.__REVERIE_TERMINAL_DEBUG__?.summary?.() ?? null;
    const rows = window.__REVERIE_TERMINAL_DEBUG__?.visibleRows?.() ?? [];
    const canvasRect = canvas.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const left = Math.max(canvasRect.left, viewportRect.left);
    const top = Math.max(canvasRect.top, viewportRect.top);
    const right = Math.min(canvasRect.right, viewportRect.right);
    const bottom = Math.min(canvasRect.bottom, viewportRect.bottom);
    const cssWidth = Math.max(0, right - left);
    const cssHeight = Math.max(0, bottom - top);
    const scaleX = canvasRect.width > 0 ? canvas.width / canvasRect.width : 1;
    const scaleY = canvasRect.height > 0 ? canvas.height / canvasRect.height : 1;
    const sourceX = Math.max(0, Math.floor((left - canvasRect.left) * scaleX));
    const sourceY = Math.max(0, Math.floor((top - canvasRect.top) * scaleY));
    const sourceWidth = Math.max(0, Math.min(canvas.width - sourceX, Math.floor(cssWidth * scaleX), 640));
    const sourceHeight = Math.max(0, Math.min(canvas.height - sourceY, Math.floor(cssHeight * scaleY), 640));
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      return { ok: false, reason: 'no visible canvas intersection', sourceWidth, sourceHeight };
    }
    const copy = document.createElement('canvas');
    copy.width = sourceWidth;
    copy.height = sourceHeight;
    const context = copy.getContext('2d');
    if (!context) return { ok: false, reason: 'missing 2d context' };
    context.drawImage(canvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
    const data = context.getImageData(0, 0, sourceWidth, sourceHeight).data;
    let visibleCopiedBrightPixels = 0;
    const brightRows = new Uint16Array(sourceHeight);
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] > 16 && data[index] + data[index + 1] + data[index + 2] > 150) {
        visibleCopiedBrightPixels += 1;
        brightRows[Math.floor(index / 4 / sourceWidth)] += 1;
      }
    }
    let brightScanRows = 0;
    let longestDarkRun = 0;
    let currentDarkRun = 0;
    for (let row = 0; row < brightRows.length; row += 1) {
      if (brightRows[row] >= 2) {
        brightScanRows += 1;
        currentDarkRun = 0;
      } else {
        currentDarkRun += 1;
        longestDarkRun = Math.max(longestDarkRun, currentDarkRun);
      }
    }
    const scaledCellHeight = Math.max(1, Math.round((debug?.surface?.cellHeight ?? 18) * scaleY));
    let totalCellRows = 0;
    let litCellRows = 0;
    let longestDarkCellRun = 0;
    let currentDarkCellRun = 0;
    const alignedStart = -(sourceY % scaledCellHeight);
    for (let bandTop = alignedStart; bandTop < sourceHeight; bandTop += scaledCellHeight) {
      const clippedTop = Math.max(0, bandTop);
      const clippedBottom = Math.min(sourceHeight, bandTop + scaledCellHeight);
      if (clippedBottom - clippedTop < Math.max(3, scaledCellHeight * 0.45)) continue;
      totalCellRows += 1;
      let brightPixelsInBand = 0;
      for (let row = clippedTop; row < clippedBottom; row += 1) {
        brightPixelsInBand += brightRows[row] ?? 0;
      }
      if (brightPixelsInBand >= 4) {
        litCellRows += 1;
        currentDarkCellRun = 0;
      } else {
        currentDarkCellRun += 1;
        longestDarkCellRun = Math.max(longestDarkCellRun, currentDarkCellRun);
      }
    }
    return {
      ok: true,
      sourceWidth,
      sourceHeight,
      visibleCopiedBrightPixels,
      brightScanRows,
      longestDarkRun,
      totalCellRows,
      litCellRows,
      longestDarkCellRun,
      visibleModelRows: rows.length,
    };
  })()`;
}

function hasVisibleHistRows(snapshot) {
  return (snapshot.visibleRows ?? []).some(row => /\bHIST\d{4}/u.test(String(row.text ?? '')));
}

function hasVisibleLiveRows(snapshot) {
  return maxVisibleLiveTick(snapshot) !== null;
}

function maxVisibleLiveTick(snapshot) {
  const ticks = (snapshot.visibleRows ?? [])
    .map(row => /\b(?:LIVE|SPIN)(\d{6})/u.exec(String(row.text ?? ''))?.[1])
    .filter(Boolean)
    .map(value => Number(value));
  if (ticks.length === 0) return null;
  return Math.max(...ticks);
}

async function terminateBridgeSession(cdp) {
  const snapshot = await snapshotOf(cdp);
  const terminalId = snapshot.terminalId ?? snapshot.summary?.activeTerminalId;
  if (!terminalId) return;
  await fetch(`${bridgeUrl}/terminate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ terminalId }),
  }).catch(() => {});
}

async function snapshotOf(cdp) {
  const json = await evaluate(cdp, `JSON.stringify(${snapshotExpression()})`);
  return JSON.parse(json ?? 'null');
}

function snapshotExpression() {
  return `(() => {
    const api = window.__REVERIE_TERMINAL_DEBUG__;
    const viewport = document.querySelector('[data-testid="terminal-viewport"]');
    const stage = document.querySelector('[data-testid="focus-stage"]');
    const shell = document.querySelector('[data-testid="reverie-app-shell"]');
    const body = document.querySelector('[data-testid="terminal-body"]');
    const track = document.querySelector('[data-testid="terminal-scrollbar"]');
    const thumb = document.querySelector('[data-testid="terminal-scrollbar-thumb"]');
    const rows = api?.visibleRows?.() ?? [];
    const rectOf = element => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        bottom: rect.bottom,
      };
    };
    return {
      terminalId: body?.dataset?.terminalId ?? null,
      status: document.querySelector('[data-testid="terminal-status-label"]')?.textContent ?? null,
      followState: document.querySelector('[data-testid="follow-live-state"]')?.textContent ?? null,
      summary: api?.summary?.() ?? null,
      visibleRows: rows.slice(0, 16),
      shell: rectOf(shell),
      stage: rectOf(stage),
      viewport: viewport
        ? {
            scrollTop: viewport.scrollTop,
            clientHeight: viewport.clientHeight,
            scrollHeight: viewport.scrollHeight,
            rect: rectOf(viewport),
          }
        : null,
      scrollbar: track
        ? {
            scrollable: track.dataset.scrollable,
            thumbTop: thumb?.style.top ?? null,
            thumbHeight: thumb?.style.height ?? null,
            thumbRect: rectOf(thumb),
          }
        : null,
      cards: document.querySelectorAll('[data-testid="dashboard-session-card"]').length,
      tabs: document.querySelectorAll('[data-testid="session-tab"]').length,
    };
  })()`;
}

function summarizeSnapshot(snapshot) {
  return {
    status: snapshot?.status,
    followState: snapshot?.followState,
    liveFollow: snapshot?.summary?.liveFollow,
    surface: snapshot?.summary?.surface,
    startRow: snapshot?.summary?.startRow,
    rowCount: snapshot?.summary?.rowCount,
    viewport: snapshot?.viewport
      ? {
          scrollTop: snapshot.viewport.scrollTop,
          clientHeight: snapshot.viewport.clientHeight,
          scrollHeight: snapshot.viewport.scrollHeight,
        }
      : null,
    shell: snapshot?.shell,
    stage: snapshot?.stage,
    scrollbar: snapshot?.scrollbar,
    sample: snapshot?.visibleRows?.slice(0, 4),
  };
}

async function waitForSnapshot(cdp, predicate, timeoutMs, label) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await snapshotOf(cdp);
    if (predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(summarizeSnapshot(last), null, 2)}`);
}

async function flushAnimationFrames(cdp, count) {
  await evaluate(
    cdp,
    `new Promise(resolve => {
      let remaining = ${Math.max(0, count)};
      const tick = () => {
        remaining -= 1;
        if (remaining <= 0) resolve(true);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })`,
  );
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'Runtime.evaluate failed');
  }
  return result.result.value;
}

async function waitForPageTarget(portNumber, expectedUrl) {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${portNumber}/json/list`);
      if (response.ok) {
        const pages = await response.json();
        const page =
          pages.find(item => item.type === 'page' && item.url === expectedUrl) ??
          pages.find(item => item.type === 'page' && item.url.includes('127.0.0.1')) ??
          pages.find(item => item.type === 'page');
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {
      // Chrome may still be starting.
    }
    await sleep(100);
  }
  throw new Error('Timed out waiting for Chrome page target');
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? 'CDP command failed'));
      else pending.resolve(message.result);
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new CdpClient(ws);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

function findChromium() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Unable to find Chrome or Chromium. Set CHROME_PATH to the browser binary.');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', resolve);
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
