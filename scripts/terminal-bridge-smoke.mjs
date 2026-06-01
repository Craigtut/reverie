#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const DEFAULT_URL =
  'http://127.0.0.1:1421/?terminalBridgeDebug=1&bridgeCommand=for%20i%20in%20%24%28seq%201%20160%29%3B%20do%20printf%20%27ROW%20%2503d%20abcdefghijklmnopqrstuvwxyz%5Cn%27%20%24i%3B%20done%3B%20sleep%2045';
const url = process.argv[2] ?? DEFAULT_URL;
const port = Number(process.env.REVERIE_DEBUG_CHROME_PORT ?? 9333);
const screenshotDir = process.env.REVERIE_DEBUG_SCREENSHOT_DIR ?? tmpdir();
const resizeSettleMs = Number(process.env.REVERIE_DEBUG_RESIZE_SETTLE_MS ?? 900);
const resizeFrameFlushes = Number(process.env.REVERIE_DEBUG_RESIZE_FRAME_FLUSHES ?? 2);
const maxResizeCaptureMs = Number(process.env.REVERIE_DEBUG_MAX_RESIZE_CAPTURE_MS ?? 3_000);
const maxPaintMs = Number(process.env.REVERIE_DEBUG_MAX_PAINT_MS ?? 25);
const warmupLabelledRows = Number(process.env.REVERIE_DEBUG_WARMUP_LABELLED_ROWS ?? 12);
const expectedBackend = process.env.REVERIE_DEBUG_EXPECT_BACKEND ?? expectedBackendForUrl(url);
const expectRowSequence =
  process.env.REVERIE_DEBUG_EXPECT_ROWS === '1' ||
  (process.env.REVERIE_DEBUG_EXPECT_ROWS !== '0' && url === DEFAULT_URL);
const forbiddenConsolePatterns = [
  /WebGL:\s*INVALID_/u,
  /CONTEXT_LOST_WEBGL/u,
  /Failed to fetch/u,
  /Unhandled/i,
];
const viewportSizes = process.env.REVERIE_DEBUG_VIEWPORTS
  ? parseViewportSizes(process.env.REVERIE_DEBUG_VIEWPORTS)
  : [
      [1200, 800],
      [720, 520],
      [1000, 680],
      [480, 520],
      [1200, 800],
    ];

async function main() {
  const chrome = findChromium();
  const userDataDir = join(tmpdir(), `reverie-terminal-bridge-chrome-${process.pid}`);
  mkdirSync(userDataDir, { recursive: true });

  const child = spawn(
    chrome,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--headless=new',
      '--hide-scrollbars=false',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      `--window-size=${viewportSizes[0][0]},${viewportSizes[0][1]}`,
      url,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  child.stderr.on('data', chunk => process.stderr.write(chunk));

  try {
    const page = await waitForPageTarget(port, url);
    const cdp = await CdpClient.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const consoleMessages = [];
    cdp.on('Runtime.consoleAPICalled', event => {
      const text = (event.params?.args ?? [])
        .map(arg => arg.value ?? arg.description ?? '')
        .join(' ')
        .trim();
      if (text) consoleMessages.push(text);
    });
    await waitForSnapshot(
      cdp,
      snapshot =>
        snapshot?.status === 'running' &&
        snapshot.lastFrameSeq &&
        (!expectRowSequence || labelledRowCount(snapshot) >= warmupLabelledRows),
    );

    const results = [];
    for (let index = 0; index < viewportSizes.length; index += 1) {
      const [width, height] = viewportSizes[index];
      const startedAt = nowMs();
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(resizeSettleMs);
      await flushAnimationFrames(cdp, resizeFrameFlushes);

      const snapshot = await evaluate(cdp, 'window.__REVERIE_TERMINAL_DEBUG__?.()');
      const visibleText = await evaluate(cdp, 'document.body.innerText');
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const screenshotBuffer = Buffer.from(screenshot.data, 'base64');
      const screenshotPath = join(
        screenshotDir,
        `reverie-terminal-bridge-${index}-${width}x${height}.png`,
      );
      writeFileSync(screenshotPath, screenshotBuffer);
      const pixelProbe = screenshotPixelProbe(screenshotBuffer, snapshot);
      const canvasProbe = await evaluate(cdp, canvasPixelProbeExpression());
      const captureElapsedMs = nowMs() - startedAt;

      results.push({
        index,
        viewport: { width, height },
        screenshotPath,
        surface: snapshot?.surface ?? null,
        surfaceState: snapshot?.surfaceState ?? null,
        status: snapshot?.status ?? null,
        frame: snapshot?.lastFrameSeq ?? null,
        paint: snapshot?.paintSummary ?? null,
        historyFills: snapshot?.historyFills ?? null,
        lastPaint: snapshot?.lastPaint ?? null,
        pixelProbe,
        canvasProbe,
        canvas: snapshot?.canvas ?? null,
        terminalViewport: snapshot?.viewport ?? null,
        timing: {
          captureElapsedMs,
          maxResizeCaptureMs,
          resizeSettleMs,
          resizeFrameFlushes,
        },
        rows: snapshot?.rows ?? [],
        visibleRows: snapshot?.visibleRows ?? [],
        trace: snapshot?.trace?.slice(-20) ?? [],
        firstRows: snapshot?.rows?.slice(0, 6) ?? [],
        lastRows: snapshot?.rows?.slice(-6) ?? [],
        pageText: String(visibleText ?? '')
          .split('\n')
          .slice(0, 8),
      });
    }

    assertSmokeResults(results, consoleMessages);
    console.log(JSON.stringify(results, null, 2));
    await cdp.close();
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  }
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (existsSync(cache)) {
    const shells = readdirSync(cache)
      .filter(name => name.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse();
    for (const shell of shells) {
      const executable = join(
        cache,
        shell,
        'chrome-headless-shell-mac-arm64',
        'chrome-headless-shell',
      );
      if (existsSync(executable)) return executable;
    }
  }
  throw new Error('Chromium headless shell not found. Run `npx playwright install chromium`.');
}

function parseViewportSizes(value) {
  const sizes = String(value)
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const match = part.match(/^(\d+)x(\d+)$/u);
      if (!match) throw new Error(`Invalid viewport size ${part}`);
      return [Number(match[1]), Number(match[2])];
    });
  if (sizes.length === 0) throw new Error('REVERIE_DEBUG_VIEWPORTS did not include any sizes');
  return sizes;
}

function expectedBackendForUrl(value) {
  try {
    const params = new URL(value).searchParams;
    const requested = params.get('bridgeRenderer') ?? params.get('terminalRenderer');
    return requested === 'webgl2' ? 'webgl2' : 'canvas2d';
  } catch {
    return 'canvas2d';
  }
}

async function waitForPageTarget(targetPort, expectedUrl) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${targetPort}/json/list`);
      const targets = await response.json();
      const page = targets.find(
        target =>
          target.type === 'page' && String(target.url).startsWith(expectedUrl.split('&')[0]),
      );
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Chrome is still starting.
    }
    await sleep(100);
  }
  throw new Error('Timed out waiting for Chromium debug target');
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? 'Runtime.evaluate failed');
  }
  return result.result.value;
}

async function waitForSnapshot(cdp, predicate) {
  const started = Date.now();
  let lastSnapshot = null;
  while (Date.now() - started < 10_000) {
    const snapshot = await evaluate(cdp, 'window.__REVERIE_TERMINAL_DEBUG__?.()');
    lastSnapshot = snapshot ?? null;
    if (predicate(snapshot)) return snapshot;
    await sleep(100);
  }
  throw new Error(
    `Timed out waiting for terminal debug snapshot. Last snapshot:\n${JSON.stringify(
      lastSnapshot,
      null,
      2,
    )}`,
  );
}

async function flushAnimationFrames(cdp, count) {
  const frames = Math.max(0, Math.floor(count));
  if (frames === 0) return;
  await evaluate(
    cdp,
    `new Promise(resolve => {
      let remaining = ${frames};
      const tick = () => {
        remaining -= 1;
        if (remaining <= 0) resolve(true);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })`,
  );
}

function assertSmokeResults(results, consoleMessages) {
  const failures = [];
  for (const result of results) {
    if (result.status !== 'running') {
      failures.push(`capture ${result.index} status was ${String(result.status)}`);
    }
    if (result.paint?.backend !== expectedBackend) {
      failures.push(`capture ${result.index} backend was ${String(result.paint?.backend)}`);
    }
    if (!result.frame) {
      failures.push(`capture ${result.index} had no frame sequence`);
    }
    if ((result.timing?.captureElapsedMs ?? 0) > maxResizeCaptureMs) {
      failures.push(
        `capture ${result.index} resize capture took ${Math.round(
          result.timing.captureElapsedMs,
        )}ms, budget ${maxResizeCaptureMs}ms`,
      );
    }
    if ((result.paint?.elapsedMs ?? 0) > maxPaintMs) {
      failures.push(
        `capture ${result.index} paint took ${result.paint.elapsedMs.toFixed(
          2,
        )}ms, budget ${maxPaintMs}ms`,
      );
    }
    if ((result.historyFills?.failed ?? 0) > 0) {
      failures.push(
        `capture ${result.index} had ${result.historyFills.failed} history fill failures`,
      );
    }
    failures.push(...canvasCoverageFailures(result));
    if (expectRowSequence) {
      failures.push(...rowSequenceFailures(result));
      failures.push(...pixelProbeFailures(result));
    }
  }

  const forbiddenMessages = consoleMessages.filter(message =>
    forbiddenConsolePatterns.some(pattern => pattern.test(message)),
  );
  if (forbiddenMessages.length > 0) {
    failures.push(`browser console errors:\n${forbiddenMessages.join('\n')}`);
  }

  if (failures.length > 0) {
    console.log(JSON.stringify(results, null, 2));
    throw new Error(`Terminal bridge smoke failed:\n${failures.join('\n')}`);
  }
}

function rowSequenceFailures(result) {
  const rows = sequenceRowsForVisibleViewport(result);
  const failures = [];
  let previousNumber = null;
  let trailingBlank = false;
  let labelledRows = 0;

  for (const row of rows) {
    const label = rowNumber(row.text);
    if (label === null) {
      if (labelledRows === 0) {
        failures.push(`capture ${result.index} starts with blank row ${row.index}`);
      } else {
        trailingBlank = true;
      }
      continue;
    }
    labelledRows += 1;
    if (trailingBlank) {
      failures.push(`capture ${result.index} has labelled row ${label} after a blank row`);
    }
    if (previousNumber !== null && label !== previousNumber + 1) {
      failures.push(`capture ${result.index} row labels jumped from ${previousNumber} to ${label}`);
    }
    previousNumber = label;
  }

  if (labelledRows < 12) {
    failures.push(`capture ${result.index} only exposed ${labelledRows} labelled rows`);
  }
  return failures;
}

function sequenceRowsForVisibleViewport(result) {
  if (Array.isArray(result.visibleRows) && result.visibleRows.length > 0) {
    return result.visibleRows;
  }
  const rows = result.rows ?? [];
  const canvas = result.canvas?.rect;
  const viewport = result.terminalViewport?.rect;
  const cellHeight = result.surface?.cellHeight ?? 0;
  if (!canvas || !viewport || !Number.isFinite(cellHeight) || cellHeight <= 0) return rows;

  const firstRowIndex = lastPaintStartRow(result) ?? rows[0]?.index ?? 0;
  return rows.filter(row => {
    const ordinal = Math.max(0, row.index - firstRowIndex);
    const top = canvas.top + ordinal * cellHeight;
    const bottom = top + cellHeight;
    return top >= viewport.top - 1 && bottom <= viewport.bottom + 1;
  });
}

function pixelProbeFailures(result) {
  const probe = result.pixelProbe;
  if (!probe?.ok) {
    return [`capture ${result.index} pixel probe failed: ${probe?.reason ?? 'missing probe'}`];
  }
  const failures = [];
  if ((probe.scannedRows ?? probe.samples.length) < 3) {
    failures.push(
      `capture ${result.index} only scanned ${
        probe.scannedRows ?? probe.samples.length
      } canvas rows`,
    );
  }
  for (const sample of probe.blankSamples ?? probe.samples) {
    if (sample.inkPixels < sample.minimumInkPixels) {
      failures.push(
        `capture ${result.index} row ${sample.rowIndex} has ${sample.inkPixels} ink pixels below ${sample.minimumInkPixels}`,
      );
    }
  }
  return failures;
}

function canvasCoverageFailures(result) {
  const canvas = result.canvas?.rect;
  const viewport = result.terminalViewport?.rect;
  const cellHeight = result.surface?.cellHeight ?? 0;
  if (!canvas || !viewport || !Number.isFinite(cellHeight) || cellHeight <= 0) return [];

  const failures = [];
  const topSlack = cellHeight + 1;
  const bottomSlack = cellHeight + 1;
  if (canvas.top > viewport.top + topSlack) {
    failures.push(
      `capture ${result.index} canvas starts ${Math.round(
        canvas.top - viewport.top,
      )}px below viewport top`,
    );
  }
  if (canvas.bottom < viewport.bottom - bottomSlack) {
    failures.push(
      `capture ${result.index} canvas ends ${Math.round(
        viewport.bottom - canvas.bottom,
      )}px above viewport bottom`,
    );
  }
  return failures;
}

function rowNumber(text) {
  const match = String(text ?? '').match(/^ROW\s+(\d+)/u);
  return match ? Number(match[1]) : null;
}

function labelledRowCount(snapshot) {
  return (snapshot?.rows ?? []).filter(row => rowNumber(row.text) !== null).length;
}

function lastPaintStartRow(source) {
  if (Number.isFinite(source?.lastPaint?.startRow)) return source.lastPaint.startRow;
  const trace = Array.isArray(source?.trace) ? source.trace : [];
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const event = trace[index];
    if (event?.kind !== 'paint') continue;
    if (!Number.isFinite(event.startRow)) continue;
    return event.startRow;
  }
  return null;
}

function screenshotPixelProbe(buffer, snapshot) {
  if (!snapshot?.surface || !snapshot?.canvas?.rect || !snapshot?.viewport?.rect) {
    return { ok: false, reason: 'missing snapshot geometry' };
  }
  const sourceRows =
    Array.isArray(snapshot.visibleRows) && snapshot.visibleRows.length > 0
      ? snapshot.visibleRows
      : (snapshot.rows ?? []);
  const labelledRows = sourceRows.filter(row => rowNumber(row.text) !== null);
  if (labelledRows.length < 3) {
    return { ok: false, reason: 'not enough labelled rows', labelledRows: labelledRows.length };
  }

  let image;
  try {
    image = decodePng(buffer);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const canvasRect = snapshot.canvas.rect;
  const viewportRect = snapshot.viewport.rect;
  const firstRowIndex =
    lastPaintStartRow(snapshot) ?? sourceRows[0]?.index ?? labelledRows[0].index;
  const visibleRows = labelledRows
    .map(row => {
      const ordinal = Math.max(0, row.index - firstRowIndex);
      const top = canvasRect.top + ordinal * snapshot.surface.cellHeight;
      const bottom = top + snapshot.surface.cellHeight;
      return { row, ordinal, top, bottom };
    })
    .filter(
      item =>
        item.bottom > Math.max(0, viewportRect.top) + 1 &&
        item.top < Math.min(image.height, viewportRect.bottom) - 1,
    );
  if (visibleRows.length < 3) {
    return {
      ok: false,
      reason: 'not enough visible labelled rows',
      visibleRows: visibleRows.length,
    };
  }

  const scanWidth = Math.max(
    snapshot.surface.cellWidth * 18,
    Math.min(image.width, snapshot.surface.cellWidth * 42),
  );
  const x = Math.max(0, Math.floor(canvasRect.left));
  const allSamples = visibleRows.map(item => {
    const y0 = Math.max(0, Math.floor(Math.max(item.top, viewportRect.top)));
    const y1 = Math.min(image.height, Math.ceil(Math.min(item.bottom, viewportRect.bottom)));
    const width = Math.max(1, Math.min(Math.floor(scanWidth), image.width - x));
    const height = Math.max(1, y1 - y0);
    let inkPixels = 0;
    for (let y = y0; y < y0 + height; y += 1) {
      for (let dx = 0; dx < width; dx += 1) {
        const offset = (y * image.width + x + dx) * 4;
        const r = image.data[offset] ?? 0;
        const g = image.data[offset + 1] ?? 0;
        const b = image.data[offset + 2] ?? 0;
        const a = image.data[offset + 3] ?? 0;
        if (a > 16 && r + g + b > 150) inkPixels += 1;
      }
    }
    return {
      rowIndex: item.row.index,
      text: item.row.text,
      ordinal: item.ordinal,
      x,
      y: y0,
      width,
      height,
      inkPixels,
      minimumInkPixels: 12,
    };
  });
  const blankSamples = allSamples.filter(sample => sample.inkPixels < sample.minimumInkPixels);
  const sampleIndexes = Array.from(
    new Set([0, Math.floor(allSamples.length / 2), allSamples.length - 1]),
  );
  const samples = sampleIndexes.map(index => allSamples[index]).filter(Boolean);
  const inkCounts = allSamples.map(sample => sample.inkPixels);
  return {
    ok: true,
    sourceWidth: image.width,
    sourceHeight: image.height,
    scannedRows: allSamples.length,
    minInkPixels: Math.min(...inkCounts),
    maxInkPixels: Math.max(...inkCounts),
    blankSamples,
    samples,
  };
}

function canvasPixelProbeExpression() {
  return `(() => {
    const canvas = document.querySelector('[data-testid="terminal-bridge-debug-canvas"]');
    if (!(canvas instanceof HTMLCanvasElement)) return { ok: false, reason: 'missing canvas' };
    const width = Math.min(canvas.width, 512);
    const height = Math.min(canvas.height, 512);
    const gl = canvas.getContext('webgl2');
    let webglBrightPixels = null;
    if (gl && width > 0 && height > 0) {
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      webglBrightPixels = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] > 16 && pixels[index] + pixels[index + 1] + pixels[index + 2] > 150) {
          webglBrightPixels += 1;
        }
      }
    }
    const copy = document.createElement('canvas');
    copy.width = width;
    copy.height = height;
    const context = copy.getContext('2d');
    if (!context || width <= 0 || height <= 0) {
      return { ok: false, reason: 'missing 2d context', width: canvas.width, height: canvas.height };
    }
    context.drawImage(canvas, 0, 0, width, height, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    let copiedBrightPixels = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] > 16 && data[index] + data[index + 1] + data[index + 2] > 150) {
        copiedBrightPixels += 1;
      }
    }
    const viewport = document.querySelector('[data-testid="terminal-bridge-debug-viewport"]');
    let visibleCopiedBrightPixels = null;
    if (viewport instanceof HTMLElement) {
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
      const sourceWidth = Math.max(0, Math.min(canvas.width - sourceX, Math.floor(cssWidth * scaleX), 512));
      const sourceHeight = Math.max(0, Math.min(canvas.height - sourceY, Math.floor(cssHeight * scaleY), 512));
      if (sourceWidth > 0 && sourceHeight > 0) {
        const visibleCopy = document.createElement('canvas');
        visibleCopy.width = sourceWidth;
        visibleCopy.height = sourceHeight;
        const visibleContext = visibleCopy.getContext('2d');
        if (visibleContext) {
          visibleContext.drawImage(canvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
          const visibleData = visibleContext.getImageData(0, 0, sourceWidth, sourceHeight).data;
          visibleCopiedBrightPixels = 0;
          for (let index = 0; index < visibleData.length; index += 4) {
            if (visibleData[index + 3] > 16 && visibleData[index] + visibleData[index + 1] + visibleData[index + 2] > 150) {
              visibleCopiedBrightPixels += 1;
            }
          }
        }
      }
    }
    return {
      ok: true,
      width: canvas.width,
      height: canvas.height,
      sampleWidth: width,
      sampleHeight: height,
      webglBrightPixels,
      copiedBrightPixels,
      visibleCopiedBrightPixels,
    };
  })()`;
}

function decodePng(buffer) {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!pngSignature.every((byte, index) => buffer[index] === byte)) {
    throw new Error('screenshot is not a PNG');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG format bitDepth=${bitDepth} colorType=${colorType}`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(idat));
  const raw = Buffer.alloc(height * stride);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const rowStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = inflated[sourceOffset + x];
      const left = x >= channels ? raw[rowStart + x - channels] : 0;
      const up = y > 0 ? raw[rowStart + x - stride] : 0;
      const upLeft = y > 0 && x >= channels ? raw[rowStart + x - stride - channels] : 0;
      raw[rowStart + x] = pngFilterValue(filter, value, left, up, upLeft);
    }
    sourceOffset += stride;
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * channels;
    const target = pixel * 4;
    rgba[target] = raw[source];
    rgba[target + 1] = raw[source + 1];
    rgba[target + 2] = raw[source + 2];
    rgba[target + 3] = colorType === 6 ? raw[source + 3] : 255;
  }
  return { width, height, data: rgba };
}

function pngFilterValue(filter, value, left, up, upLeft) {
  switch (filter) {
    case 0:
      return value;
    case 1:
      return (value + left) & 0xff;
    case 2:
      return (value + up) & 0xff;
    case 3:
      return (value + Math.floor((left + up) / 2)) & 0xff;
    case 4:
      return (value + paeth(left, up, upLeft)) & 0xff;
    default:
      throw new Error(`unsupported PNG filter ${filter}`);
  }
}

function paeth(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowMs() {
  return performance.now();
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timeout = setTimeout(resolve, 2_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    const client = new CdpClient(socket);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return client;
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    socket.addEventListener('message', event => this.handleMessage(event));
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(payload);
    });
  }

  handleMessage(event) {
    const message = JSON.parse(event.data);
    if (!message.id) {
      const handlers = this.eventHandlers.get(message.method);
      if (handlers) {
        for (const handler of handlers) handler(message);
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }
    pending.resolve(message.result);
  }

  close() {
    this.socket.close();
  }

  on(method, handler) {
    const handlers = this.eventHandlers.get(method) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
  }
}

await main();
