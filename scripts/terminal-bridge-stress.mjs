#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.REVERIE_STRESS_CHROME_PORT ?? 9346);
const resizeFrameFlushes = Number(process.env.REVERIE_STRESS_FRAME_FLUSHES ?? 3);
const boundaryWheelSteps = Number(process.env.REVERIE_STRESS_BOUNDARY_STEPS ?? 240);
const boundaryBounceLoops = Number(process.env.REVERIE_STRESS_BOUNDARY_BOUNCES ?? 1);
const detachedSoakMs = Number(process.env.REVERIE_STRESS_DETACHED_SOAK_MS ?? 3500);
const altScreenStressEnabled = process.env.REVERIE_STRESS_ALT_SCREEN !== '0';
const altScreenFrames = Number(process.env.REVERIE_STRESS_ALT_FRAMES ?? 320);
const scrollSweepSteps = Number(process.env.REVERIE_STRESS_SWEEP_STEPS ?? 10);
const scrollSweepEnabled = process.env.REVERIE_STRESS_SCROLL_SWEEP !== '0' && scrollSweepSteps > 0;
const renderer = process.env.REVERIE_STRESS_RENDERER;
const verboseSnapshots = process.env.REVERIE_STRESS_VERBOSE === '1';
const bridgeUrl = process.env.REVERIE_STRESS_BRIDGE_URL ?? 'http://127.0.0.1:17777';
const transcriptRows = Number(process.env.REVERIE_STRESS_TRANSCRIPT_ROWS ?? 900);
const stressLoops = Number(process.env.REVERIE_STRESS_LOOPS ?? 3);
const warmupTimeoutMs = Number(
  process.env.REVERIE_STRESS_WARMUP_TIMEOUT_MS ?? Math.max(20_000, Math.ceil(transcriptRows * 3.5)),
);
const command = process.env.REVERIE_STRESS_COMMAND ?? defaultStressCommand();
const webBaseUrl = process.env.REVERIE_STRESS_WEB_URL ?? 'http://127.0.0.1:1421/';
const url =
  process.env.REVERIE_STRESS_URL ??
  `${webBaseUrl}?terminalBridgeDebug=1&bridgeUrl=${encodeURIComponent(
    bridgeUrl,
  )}&bridgeCommand=${encodeURIComponent(command)}${
    renderer === 'webgl2' ? '&bridgeRenderer=webgl2' : ''
  }`;

const failures = [];

async function main() {
  const chrome = findChromium();
  const userDataDir = join(tmpdir(), `reverie-terminal-bridge-stress-${process.pid}`);
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
      '--window-size=1100,720',
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

    await waitForSnapshot(
      cdp,
      snapshot =>
        snapshot?.status === 'running' && hasManyRows(snapshot) && hasLiveOutput(snapshot),
      warmupTimeoutMs,
    );
    await assertCapture(cdp, 'warmup');
    await assertFrameAdvances(cdp, 'warmup live output', 2, 900);

    for (let cycle = 1; cycle <= stressLoops; cycle += 1) {
      await wheelToBoundary(cdp, 'top', `cycle ${cycle} top`);
      await waitForScrollbackView(cdp, `cycle ${cycle} top`);
      await assertCapture(cdp, `cycle ${cycle} top`);
      await assertVisibleText(cdp, `cycle ${cycle} top`, /\bHIST \d{4}\b/u);
      await assertHistoryTopMarker(cdp, `cycle ${cycle} top`);
      await assertFrameAdvances(cdp, `cycle ${cycle} live output while at top`, 2, 900);

      await resize(cdp, 720, 520);
      await waitForVisibleStressRows(cdp, `cycle ${cycle} narrow while top`);
      await assertCapture(cdp, `cycle ${cycle} narrow while top`);
      await assertVisibleText(cdp, `cycle ${cycle} narrow while top`, /\bHIST \d{4}\b/u);
      await resize(cdp, 980, 620);
      await waitForVisibleStressRows(cdp, `cycle ${cycle} mid while top`);
      await assertCapture(cdp, `cycle ${cycle} mid while top`);

      await boundaryBounce(cdp, cycle);
      if (scrollSweepEnabled) {
        await scrollbackContinuitySweep(cdp, `cycle ${cycle} scrollback continuity`);
      }

      await wheelToBoundary(cdp, 'bottom', `cycle ${cycle} bottom`);
      await waitForVisibleStressRows(cdp, `cycle ${cycle} bottom`);
      await assertCapture(cdp, `cycle ${cycle} bottom`);
      await assertLivePaintAdvances(cdp, `cycle ${cycle} live paint at bottom`, 2, 900);
      await assertVisibleLiveTickAdvances(cdp, `cycle ${cycle} visible live output`, 1, 900);

      await wheelToScrollbackView(cdp, `cycle ${cycle} mid scrollback`);
      await assertCapture(cdp, `cycle ${cycle} mid scrollback`);
      await detachedLiveSoak(cdp, `cycle ${cycle} detached live resize soak`);
      await scrollResizeChurn(cdp, `cycle ${cycle} scroll resize churn`);
      await waitForScrollbackView(cdp, `cycle ${cycle} scroll resize churn`);
      await assertCapture(cdp, `cycle ${cycle} scroll resize churn`);
      await resize(cdp, 480, 520);
      await waitForScrollbackView(cdp, `cycle ${cycle} small while scrolled`);
      await assertCapture(cdp, `cycle ${cycle} small while scrolled`);
      await resize(cdp, 1200, 800);
      await waitForScrollbackView(cdp, `cycle ${cycle} wide while scrolled`);
      await assertCapture(cdp, `cycle ${cycle} wide while scrolled`);
      await resizeBurst(cdp, `cycle ${cycle} burst while scrolled`, [
        [620, 500],
        [1260, 760],
        [540, 600],
        [1160, 640],
      ]);
      await waitForScrollbackView(cdp, `cycle ${cycle} burst while scrolled`);
      await assertCapture(cdp, `cycle ${cycle} burst while scrolled`);
      await waitForCurrentSurfaceBuffer(cdp, `cycle ${cycle} replay after burst`);
      await assertCapture(cdp, `cycle ${cycle} replay after burst`);
      await historyLiveInputRace(cdp, `cycle ${cycle} history live input race`);
      if (altScreenStressEnabled) {
        await alternateScreenAnimationStress(cdp, `cycle ${cycle} alternate screen animation`);
      }
    }

    await wheelToBoundary(cdp, 'top', 'final top');
    await waitForScrollbackView(cdp, 'final top before input');
    await assertCapture(cdp, 'final top before input');
    await assertVisibleText(cdp, 'final top before input', /\bHIST \d{4}\b/u);
    await assertHistoryTopMarker(cdp, 'final top before input');

    const token = `stress-${Date.now()}`;
    await typeTerminalText(cdp, `${token}\n`);
    await waitForSnapshot(
      cdp,
      snapshot => rows(snapshot).some(row => row.text.includes(token)),
      8_000,
    );
    await assertCapture(cdp, 'input returned to live');
    await assertLivePaintAdvances(cdp, 'live output after input', 2, 900);
    await assertVisibleLiveTickAdvances(cdp, 'visible live output after input', 1, 900);

    await resize(cdp, 480, 520);
    await assertCapture(cdp, 'narrow live resize');
    await resize(cdp, 1200, 800);
    await assertCapture(cdp, 'wide live resize');
    await resizeBurst(cdp, 'live resize burst', [
      [580, 500],
      [1280, 760],
      [520, 620],
      [1200, 800],
    ]);
    await assertCapture(cdp, 'live resize burst');
    await assertFrameAdvances(cdp, 'final live output', 2, 900);
    await assertVisibleLiveTickAdvances(cdp, 'final visible live output', 1, 900);

    await cdp.close();
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  if (failures.length > 0) {
    throw new Error(`Terminal bridge stress failed:\n${failures.join('\n')}`);
  }
}

function defaultStressCommand() {
  const program = String.raw`
import select
import sys
import time

transcript_rows = __TRANSCRIPT_ROWS__
alt_screen_frames = __ALT_SCREEN_FRAMES__
symbols = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]
for i in range(1, transcript_rows + 1):
    marker = symbols[i % len(symbols)]
    print(f"HIST {i:04d} {marker} file=src/module_{i % 29:02d}.rs task={i % 7} abcdefghijklmnopqrstuvwxyz", flush=True)
    if i % 31 == 0:
        print(f"HIST {i:04d} wrapped-detail {marker} " + ("0123456789abcdef" * 12), flush=True)
    time.sleep(0.001)

tick = 0
spinner = "|/-\\"
bar = "##########----------"

def run_alt_screen_stress(current_tick):
    payload = "abcdefghijklmnopqrstuvwxyz0123456789"
    sys.stdout.write("\x1b[?1049h\x1b[?25l")
    sys.stdout.flush()
    for frame in range(alt_screen_frames):
        phase = spinner[frame % len(spinner)]
        offset = frame % len(payload)
        moving = payload[offset:] + payload[:offset]
        chunks = ["\x1b[H\x1b[2J", f"\x1b[1;1HALT {frame:06d} tick={current_tick:06d} phase={phase}\x1b[K"]
        for row in range(2, 41):
            stripe = (row + frame) % 10
            chunks.append(f"\x1b[{row};1HALT_ROW {row - 1:02d} frame={frame:06d} stripe={stripe} {moving}\x1b[K")
        sys.stdout.write("".join(chunks))
        sys.stdout.flush()
        time.sleep(0.025)
    sys.stdout.write("\x1b[?25h\x1b[?1049l")
    sys.stdout.flush()
    print(f"ALT_STRESS_DONE tick={current_tick:06d}", flush=True)

while True:
    ready, _, _ = select.select([sys.stdin], [], [], 0.02)
    if ready:
        line = sys.stdin.readline()
        if line == "":
            break
        command = line.strip()
        if command == "ALT_STRESS":
            print(f"ALT_STRESS_BEGIN tick={tick:06d}", flush=True)
            run_alt_screen_stress(tick)
            tick += 1
            continue
        print(f"ECHO_STRESS {command} tick={tick:06d}", flush=True)
    if tick % 17 == 0:
        print(f"ANIM {tick:06d} phase={spinner[tick % len(spinner)]} {bar[tick % len(bar):]}{bar[:tick % len(bar)]}", flush=True)
    elif tick % 5 == 0:
        print(f"LIVE {tick:06d} abcdefghijklmnopqrstuvwxyz progress={tick % 100:02d}", flush=True)
    else:
        sys.stdout.write(f"\rSPIN {tick:06d} {spinner[tick % len(spinner)]}")
        sys.stdout.flush()
    tick += 1
    time.sleep(0.025)
`;
  return `python3 -u -c ${shellQuote(
    program
      .replace('__TRANSCRIPT_ROWS__', String(transcriptRows))
      .replace('__ALT_SCREEN_FRAMES__', String(altScreenFrames)),
  )}`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function assertCapture(cdp, label) {
  await flushAnimationFrames(cdp, resizeFrameFlushes);
  const snapshot = await snapshotOf(cdp);
  const canvasProbe = await evaluate(cdp, canvasPixelProbeExpression());
  const labelled = textRowCount(snapshot);
  const visible = visibleTextRowCount(snapshot);
  const pending = snapshot?.pendingFrames ?? 0;
  const paintMs = snapshot?.paintSummary?.elapsedMs ?? 0;

  if (snapshot?.status !== 'running') {
    failures.push(`${label}: status is ${String(snapshot?.status)}`);
  }
  if (!snapshot?.lastFrameSeq) {
    failures.push(`${label}: no frame sequence`);
  }
  if ((snapshot?.historyFills?.failed ?? 0) > 0) {
    failures.push(`${label}: history fill failures ${snapshot.historyFills.failed}`);
  }
  if (labelled < 12) {
    failures.push(`${label}: only ${labelled} text rows in composite`);
  }
  if (visible < 3) {
    failures.push(`${label}: only ${visible} visible text rows`);
  }
  if (pending > 160) {
    failures.push(`${label}: pending frame backlog ${pending}`);
  }
  if (paintMs > 50) {
    failures.push(`${label}: paint took ${paintMs.toFixed(2)}ms`);
  }
  if (!canvasProbe?.ok || (canvasProbe.visibleCopiedBrightPixels ?? 0) < 100) {
    failures.push(
      `${label}: visible canvas pixels ${String(canvasProbe?.visibleCopiedBrightPixels)} (${String(
        canvasProbe?.reason ?? 'no reason',
      )})`,
    );
  }
  if ((canvasProbe?.longestDarkRun ?? 0) > Math.min(180, (canvasProbe?.sourceHeight ?? 0) * 0.45)) {
    failures.push(
      `${label}: visible canvas has a ${canvasProbe.longestDarkRun}px blank band in ${canvasProbe.sourceHeight}px`,
    );
  }
  if ((canvasProbe?.brightScanRows ?? 0) < 8) {
    failures.push(`${label}: only ${String(canvasProbe?.brightScanRows)} lit canvas scan rows`);
  }
  const minimumLitScanRows = Math.min(
    (canvasProbe?.sourceHeight ?? 0) * 0.35,
    Math.max(8, visible * 5),
  );
  if ((canvasProbe?.brightScanRows ?? 0) < minimumLitScanRows) {
    failures.push(
      `${label}: only ${String(canvasProbe?.brightScanRows)} lit canvas scan rows, expected at least ${minimumLitScanRows.toFixed(
        1,
      )}`,
    );
  }
  const expectedLitCellRows = Math.floor(Math.min(visible, canvasProbe?.totalCellRows ?? 0) * 0.65);
  if (expectedLitCellRows >= 5 && (canvasProbe?.litCellRows ?? 0) < expectedLitCellRows) {
    failures.push(
      `${label}: only ${String(canvasProbe?.litCellRows)} lit terminal row bands, expected at least ${expectedLitCellRows}`,
    );
  }
  if (
    (canvasProbe?.totalCellRows ?? 0) >= 8 &&
    (canvasProbe?.longestDarkCellRun ?? 0) >
      Math.max(3, Math.floor((canvasProbe?.totalCellRows ?? 0) * 0.25))
  ) {
    failures.push(
      `${label}: visible canvas has ${String(canvasProbe?.longestDarkCellRun)} consecutive dark terminal row bands`,
    );
  }
  const rowGap = visibleRowIndexGap(snapshot);
  if (visible >= 8 && rowGap > 3) {
    failures.push(`${label}: visible row index gap ${rowGap}`);
  }
  if (snapshot?.canvas?.rect && snapshot?.viewport?.rect) {
    const canvas = snapshot.canvas.rect;
    const viewport = snapshot.viewport.rect;
    if (canvas.bottom < viewport.top + 4 || canvas.top > viewport.bottom - 4) {
      failures.push(
        `${label}: canvas outside viewport top=${canvas.top.toFixed(1)} bottom=${canvas.bottom.toFixed(
          1,
        )}`,
      );
    }
    if (snapshot?.surface) {
      const expectedCanvasWidth = snapshot.surface.cols * snapshot.surface.cellWidth;
      if (canvas.width + 1 < expectedCanvasWidth) {
        failures.push(
          `${label}: canvas width ${canvas.width.toFixed(1)}px is smaller than surface width ${expectedCanvasWidth}px`,
        );
      }
      if (canvas.height + 1 < viewport.height) {
        failures.push(
          `${label}: canvas height ${canvas.height.toFixed(1)}px is smaller than viewport height ${viewport.height.toFixed(
            1,
          )}px`,
        );
      }
    }
  }

  const baseLog = {
    label,
    frame: snapshot?.lastFrameSeq,
    backend: snapshot?.paintSummary?.backend,
    surface: snapshot?.surface,
    visible,
    pending,
    paintMs,
    historyFills: snapshot?.historyFills,
    canvasPixels: canvasProbe?.visibleCopiedBrightPixels,
    brightScanRows: canvasProbe?.brightScanRows,
    longestDarkRun: canvasProbe?.longestDarkRun,
    litCellRows: canvasProbe?.litCellRows,
    totalCellRows: canvasProbe?.totalCellRows,
    longestDarkCellRun: canvasProbe?.longestDarkCellRun,
    viewport: snapshot?.viewport
      ? {
          scrollTop: snapshot.viewport.scrollTop,
          clientHeight: snapshot.viewport.clientHeight,
          scrollHeight: snapshot.viewport.scrollHeight,
        }
      : null,
    controller: snapshot?.controller,
  };
  console.log(
    JSON.stringify(
      verboseSnapshots
        ? {
            ...baseLog,
            canvas: snapshot?.canvas
              ? {
                  top: snapshot.canvas.rect?.top,
                  bottom: snapshot.canvas.rect?.bottom,
                  height: snapshot.canvas.rect?.height,
                  styleHeight: snapshot.canvas.styleHeight,
                  transform: snapshot.canvas.transform,
                }
              : null,
            spacer: snapshot?.spacer
              ? {
                  height: snapshot.spacer.rect?.height,
                  styleHeight: snapshot.spacer.styleHeight,
                  top: snapshot.spacer.rect?.top,
                  bottom: snapshot.spacer.rect?.bottom,
                }
              : null,
            buffer: snapshot?.buffer
              ? {
                  cols: snapshot.buffer.cols,
                  viewportRows: snapshot.buffer.viewportRows,
                  viewportOffset: snapshot.buffer.viewportOffset,
                  totalRows: snapshot.buffer.totalRows,
                  atBottom: snapshot.buffer.atBottom,
                  generation: snapshot.buffer.generation,
                  rowMapSize: snapshot.buffer.rowMapSize,
                  resizeReflowPending: snapshot.buffer.resizeReflowPending,
                  cachedRanges: snapshot.buffer.cachedRanges?.slice(-4),
                  rows: snapshot.buffer.rows?.slice(0, 8),
                }
              : null,
            visibleSample: snapshot?.visibleRows?.slice(0, 4),
            rowSample: snapshot?.rows?.slice(0, 4),
            lastPaint: snapshot?.lastPaint,
          }
        : baseLog,
    ),
  );
}

async function boundaryBounce(cdp, cycle) {
  for (let bounce = 1; bounce <= boundaryBounceLoops; bounce += 1) {
    await wheelToBoundary(cdp, 'bottom', `cycle ${cycle} bounce ${bounce} bottom`);
    await waitForVisibleStressRows(cdp, `cycle ${cycle} bounce ${bounce} bottom`);
    await assertCapture(cdp, `cycle ${cycle} bounce ${bounce} bottom`);
    await assertLivePaintAdvances(
      cdp,
      `cycle ${cycle} bounce ${bounce} live paint at bottom`,
      2,
      900,
    );
    await assertVisibleLiveTickAdvances(
      cdp,
      `cycle ${cycle} bounce ${bounce} visible live output`,
      1,
      900,
    );

    await wheelToBoundary(cdp, 'top', `cycle ${cycle} bounce ${bounce} top`);
    await waitForScrollbackView(cdp, `cycle ${cycle} bounce ${bounce} top`);
    await assertCapture(cdp, `cycle ${cycle} bounce ${bounce} top`);
    await assertVisibleText(cdp, `cycle ${cycle} bounce ${bounce} top`, /\bHIST \d{4}\b/u);
    await assertHistoryTopMarker(cdp, `cycle ${cycle} bounce ${bounce} top`);
    await assertFrameAdvances(
      cdp,
      `cycle ${cycle} bounce ${bounce} live output while at top`,
      2,
      900,
    );
  }
}

async function scrollbackContinuitySweep(cdp, label) {
  await wheelToBoundary(cdp, 'top', `${label} start top`);
  await waitForScrollbackView(cdp, `${label} start top`);
  await assertHistoryTopMarker(cdp, `${label} start top`);
  const before = await snapshotOf(cdp);
  const beforeSeq = before?.lastFrameSeq ?? 0;
  const fractions = scrollSweepFractions(before);

  for (const [direction, sweepFractions] of [
    ['down', fractions],
    ['up', fractions.slice().reverse()],
  ]) {
    let previousMedian = null;
    for (let index = 0; index < sweepFractions.length; index += 1) {
      const fraction = sweepFractions[index];
      const stepLabel = `${label} ${direction} ${index + 1}/${sweepFractions.length}`;
      await setViewportScrollFraction(cdp, fraction);
      await waitForVisibleStressRows(cdp, stepLabel);
      await waitForScrollbackView(cdp, stepLabel);
      await assertCapture(cdp, stepLabel);
      const snapshot = await snapshotOf(cdp);
      assertVisibleTranscriptContinuity(snapshot, stepLabel, direction, previousMedian);
      previousMedian = median(visibleHistNumbers(snapshot)) ?? previousMedian;
    }
  }

  const after = await snapshotOf(cdp);
  const frameDelta = (after?.lastFrameSeq ?? 0) - beforeSeq;
  const expectedDelta = Math.max(4, Math.floor(scrollSweepSteps / 2));
  if (frameDelta < expectedDelta) {
    failures.push(`${label}: frame advanced by ${frameDelta}, expected ${expectedDelta}`);
  }
  await detachedLiveTailContinuityCheck(cdp, `${label} live tail`);
}

function scrollSweepFractions(snapshot) {
  const steps = Math.max(2, Math.floor(scrollSweepSteps));
  const rowCount = Number(snapshot?.controller?.rowCount ?? snapshot?.buffer?.totalRows ?? 0);
  const viewportRows = Number(snapshot?.surface?.rows ?? snapshot?.buffer?.viewportRows ?? 30);
  const maxScrollableRows = Math.max(1, rowCount - viewportRows);
  const transcriptSafetyRows = Math.max(80, viewportRows * 4);
  const transcriptTargetRow = Math.max(0, transcriptRows - transcriptSafetyRows);
  const transcriptCap = rowCount > 0 ? transcriptTargetRow / maxScrollableRows : 0.92;
  const maxFraction = Math.min(0.92, Math.max(0.12, transcriptCap));
  const fractions = [];
  for (let index = 0; index < steps; index += 1) {
    fractions.push((index / (steps - 1)) * maxFraction);
  }
  return fractions;
}

async function detachedLiveTailContinuityCheck(cdp, label) {
  await setViewportScrollFraction(cdp, 0.92);
  await waitForVisibleStressRows(cdp, label);
  await waitForDetachedVisibleStressView(cdp, label);
  await assertCapture(cdp, label);
  const snapshot = await snapshotOf(cdp);
  const histNumbers = visibleHistNumbers(snapshot);
  if (histNumbers.length >= 2) {
    assertVisibleTranscriptContinuity(snapshot, label, 'down', null);
  } else {
    assertVisibleLiveTickOrder(snapshot, label);
  }
  await assertFrameAdvances(cdp, `${label} backend live output`, 2, 900);
}

async function setViewportScrollFraction(cdp, fraction) {
  const targetFraction = JSON.stringify(Math.max(0, Math.min(0.98, Number(fraction) || 0)));
  await evaluate(
    cdp,
    `(() => {
      const viewport = document.querySelector('[data-testid="terminal-bridge-debug-viewport"]');
      if (!(viewport instanceof HTMLElement)) throw new Error('missing terminal viewport');
      const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      viewport.scrollTop = Math.round(max * ${targetFraction});
      viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      return {
        scrollTop: viewport.scrollTop,
        clientHeight: viewport.clientHeight,
        scrollHeight: viewport.scrollHeight,
      };
    })()`,
  );
  await sleep(90);
  await flushAnimationFrames(cdp, resizeFrameFlushes);
}

function assertVisibleTranscriptContinuity(snapshot, label, direction, previousMedian) {
  const histNumbers = visibleHistNumbers(snapshot);
  if (histNumbers.length < 2) {
    failures.push(
      `${label}: expected multiple visible transcript markers, saw ${JSON.stringify(
        (snapshot?.visibleRows ?? []).slice(0, 8),
      )}`,
    );
    return;
  }
  for (let index = 1; index < histNumbers.length; index += 1) {
    if (histNumbers[index] + 1 < histNumbers[index - 1]) {
      failures.push(
        `${label}: visible HIST markers reversed ${JSON.stringify(
          histNumbers,
        )}, rows=${JSON.stringify((snapshot?.visibleRows ?? []).slice(0, 8))}`,
      );
      return;
    }
  }
  const currentMedian = median(histNumbers);
  if (currentMedian === null || previousMedian === null) return;
  if (direction === 'down' && currentMedian + 24 < previousMedian) {
    failures.push(
      `${label}: median HIST moved backward while sweeping down, previous=${previousMedian}, current=${currentMedian}`,
    );
  }
  if (direction === 'up' && currentMedian > previousMedian + 24) {
    failures.push(
      `${label}: median HIST moved forward while sweeping up, previous=${previousMedian}, current=${currentMedian}`,
    );
  }
}

function assertVisibleLiveTickOrder(snapshot, label) {
  const ticks = visibleLiveTicks(snapshot);
  if (ticks.length < 2) {
    failures.push(
      `${label}: expected detached live-tail rows, saw ${JSON.stringify(
        (snapshot?.visibleRows ?? []).slice(0, 8),
      )}`,
    );
    return;
  }
  for (let index = 1; index < ticks.length; index += 1) {
    if (ticks[index] + 1 < ticks[index - 1]) {
      failures.push(
        `${label}: visible live ticks reversed ${JSON.stringify(
          ticks,
        )}, rows=${JSON.stringify((snapshot?.visibleRows ?? []).slice(0, 8))}`,
      );
      return;
    }
  }
}

async function assertFrameAdvances(cdp, label, minimumDelta, waitMs) {
  const before = await snapshotOf(cdp);
  await sleep(waitMs);
  await flushAnimationFrames(cdp, resizeFrameFlushes);
  const after = await snapshotOf(cdp);
  const delta = (after?.lastFrameSeq ?? 0) - (before?.lastFrameSeq ?? 0);
  if (delta < minimumDelta) {
    failures.push(`${label}: frame advanced by ${delta}, expected ${minimumDelta}`);
  }
}

async function assertLivePaintAdvances(cdp, label, minimumDelta, waitMs) {
  const before = await snapshotOf(cdp);
  await sleep(waitMs);
  await flushAnimationFrames(cdp, resizeFrameFlushes);
  const after = await snapshotOf(cdp);
  const frameDelta = (after?.lastFrameSeq ?? 0) - (before?.lastFrameSeq ?? 0);
  const beforePaint = before?.lastPaint?.timestampMs ?? 0;
  const afterPaint = after?.lastPaint?.timestampMs ?? 0;
  if (frameDelta < minimumDelta) {
    failures.push(`${label}: frame advanced by ${frameDelta}, expected ${minimumDelta}`);
  }
  if (afterPaint <= beforePaint) {
    failures.push(`${label}: paint timestamp did not advance`);
  }
}

async function assertVisibleLiveTickAdvances(cdp, label, minimumDelta, waitMs) {
  const before = await snapshotOf(cdp);
  const beforeTick = maxVisibleLiveTick(before);
  const beforeFrame = before?.lastFrameSeq ?? 0;
  const beforeSignature = visibleLiveSignature(before);
  await sleep(waitMs);
  await flushAnimationFrames(cdp, resizeFrameFlushes);
  const after = await snapshotOf(cdp);
  const afterTick = maxVisibleLiveTick(after);
  const afterFrame = after?.lastFrameSeq ?? 0;
  const afterSignature = visibleLiveSignature(after);
  if (beforeTick === null) {
    failures.push(
      `${label}: no visible live tick before wait, saw ${JSON.stringify(
        (before?.visibleRows ?? []).slice(0, 6),
      )}`,
    );
    return;
  }
  if (afterTick === null) {
    failures.push(
      `${label}: no visible live tick after wait, saw ${JSON.stringify(
        (after?.visibleRows ?? []).slice(0, 6),
      )}`,
    );
    return;
  }
  const delta = afterTick - beforeTick;
  const frameDelta = afterFrame - beforeFrame;
  const visibleChanged = beforeSignature !== afterSignature;
  if (delta < minimumDelta && (frameDelta < minimumDelta || !visibleChanged)) {
    failures.push(
      `${label}: visible live tick advanced by ${delta}, frame advanced by ${frameDelta}, expected ${minimumDelta}, before=${beforeTick}, after=${afterTick}, beforeRows=${JSON.stringify(
        (before?.visibleRows ?? []).slice(0, 6),
      )}, afterRows=${JSON.stringify((after?.visibleRows ?? []).slice(0, 6))}`,
    );
  }
}

async function assertVisibleAltFrameAdvances(cdp, label, minimumDelta, waitMs) {
  const before = await snapshotOf(cdp);
  const beforeFrame = maxVisibleAltFrame(before);
  const beforeSeq = before?.lastFrameSeq ?? 0;
  const beforeSignature = visibleAltSignature(before);
  await sleep(waitMs);
  await flushAnimationFrames(cdp, resizeFrameFlushes);
  const after = await snapshotOf(cdp);
  const afterFrame = maxVisibleAltFrame(after);
  const afterSeq = after?.lastFrameSeq ?? 0;
  const afterSignature = visibleAltSignature(after);
  if (beforeFrame === null) {
    failures.push(
      `${label}: no visible alternate-screen frame before wait, saw ${JSON.stringify(
        (before?.visibleRows ?? []).slice(0, 6),
      )}`,
    );
    return;
  }
  if (afterFrame === null) {
    failures.push(
      `${label}: no visible alternate-screen frame after wait, saw ${JSON.stringify(
        (after?.visibleRows ?? []).slice(0, 6),
      )}`,
    );
    return;
  }
  const delta = afterFrame - beforeFrame;
  const seqDelta = afterSeq - beforeSeq;
  const visibleChanged = beforeSignature !== afterSignature;
  if (delta < minimumDelta && (seqDelta < minimumDelta || !visibleChanged)) {
    failures.push(
      `${label}: visible alternate-screen frame advanced by ${delta}, terminal frame advanced by ${seqDelta}, expected ${minimumDelta}, before=${beforeFrame}, after=${afterFrame}, beforeRows=${JSON.stringify(
        (before?.visibleRows ?? []).slice(0, 6),
      )}, afterRows=${JSON.stringify((after?.visibleRows ?? []).slice(0, 6))}`,
    );
  }
}

function visibleLiveSignature(snapshot) {
  return (snapshot?.visibleRows ?? []).map(row => `${row.index}:${row.text}`).join('\n');
}

function visibleAltSignature(snapshot) {
  return (snapshot?.visibleRows ?? [])
    .filter(row => /\bALT(?:_ROW)?\b/u.test(String(row.text ?? '')))
    .map(row => `${row.index}:${row.text}`)
    .join('\n');
}

async function wheelRows(cdp, rows, repeats) {
  for (let index = 0; index < repeats; index += 1) {
    const snapshot = await snapshotOf(cdp);
    const rect = snapshot?.viewport?.rect;
    const cellHeight = snapshot?.surface?.cellHeight ?? 18;
    if (!rect) throw new Error('missing viewport rect for wheel');
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.floor(rect.left + rect.width / 2),
      y: Math.floor(rect.top + rect.height / 2),
      deltaX: 0,
      deltaY: rows * cellHeight,
    });
    await sleep(35);
    await flushAnimationFrames(cdp, 1);
  }
}

async function wheelToBoundary(cdp, boundary, label) {
  const direction = boundary === 'top' ? -1 : 1;
  let previous = null;
  for (let step = 0; step < boundaryWheelSteps; step += 1) {
    const snapshot = await snapshotOf(cdp);
    const viewport = snapshot?.viewport;
    if (!viewport) throw new Error(`missing viewport for ${label}`);
    const topInset = snapshot?.surface?.cellHeight ?? 0;
    const atTop = viewport.scrollTop <= topInset + 2;
    const atBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 3;
    if ((boundary === 'top' && atTop) || (boundary === 'bottom' && atBottom)) return;
    const position = `${viewport.scrollTop}:${viewport.scrollHeight}:${snapshot?.lastFrameSeq}`;
    if (position === previous) {
      await sleep(120);
    }
    previous = position;
    await wheelRows(cdp, direction * 90, 1);
  }
  const snapshot = await snapshotOf(cdp);
  const viewport = snapshot?.viewport;
  failures.push(
    `${label}: did not reach ${boundary}, scrollTop=${String(
      viewport?.scrollTop,
    )}, scrollHeight=${String(viewport?.scrollHeight)}`,
  );
}

async function resize(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(80);
  await flushAnimationFrames(cdp, resizeFrameFlushes);
}

async function resizeBurst(cdp, _label, sizes) {
  for (const [width, height] of sizes) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }
  await flushAnimationFrames(cdp, resizeFrameFlushes);
}

async function scrollResizeChurn(cdp, label) {
  const sizes = [
    [780, 540],
    [1180, 760],
    [500, 520],
    [1100, 620],
    [640, 700],
    [1200, 800],
  ];
  for (let index = 0; index < sizes.length; index += 1) {
    await wheelRows(cdp, index % 2 === 0 ? -28 : 36, 1);
    const [width, height] = sizes[index];
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(15);
  }
  await flushAnimationFrames(cdp, resizeFrameFlushes + 2);
  const snapshot = await snapshotOf(cdp);
  if ((snapshot?.pendingFrames ?? 0) > 160) {
    failures.push(`${label}: pending frame backlog ${snapshot.pendingFrames}`);
  }
}

async function detachedLiveSoak(cdp, label) {
  if (detachedSoakMs <= 0) return;
  await wheelRows(cdp, -60, 4);
  await waitForScrollbackView(cdp, `${label} initial scrollback`);
  const before = await snapshotOf(cdp);
  const beforeSeq = before?.lastFrameSeq ?? 0;
  const sizes = [
    [760, 520],
    [1180, 760],
    [540, 560],
    [1240, 800],
    [680, 620],
  ];
  const started = Date.now();
  let index = 0;
  while (Date.now() - started < detachedSoakMs) {
    await wheelRows(cdp, index % 2 === 0 ? -14 : 18, 1);
    const [width, height] = sizes[index % sizes.length];
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(45);
    await flushAnimationFrames(cdp, 1);
    const snapshot = await snapshotOf(cdp);
    if (snapshot?.controller?.liveFollow === true) {
      await wheelRows(cdp, -80, 2);
    }
    if ((snapshot?.pendingFrames ?? 0) > 160) {
      failures.push(`${label}: pending frame backlog ${snapshot.pendingFrames}`);
    }
    index += 1;
  }
  await flushAnimationFrames(cdp, resizeFrameFlushes + 2);
  await waitForScrollbackView(cdp, label);
  await assertCapture(cdp, label);
  await assertVisibleText(cdp, label, /\bHIST \d{4}\b/u);
  const after = await snapshotOf(cdp);
  const frameDelta = (after?.lastFrameSeq ?? 0) - beforeSeq;
  const expectedDelta = Math.max(4, Math.floor(detachedSoakMs / 600));
  if (frameDelta < expectedDelta) {
    failures.push(`${label}: frame advanced by ${frameDelta}, expected ${expectedDelta}`);
  }
}

async function alternateScreenAnimationStress(cdp, label) {
  await wheelToBoundary(cdp, 'bottom', `${label} preflight bottom`);
  await waitForLiveFollow(cdp, `${label} preflight live`);
  await writeBridgeInput(cdp, 'ALT_STRESS\n');
  await waitForVisiblePattern(cdp, `${label} entered`, /\bALT\s+\d{6}\b/u, 5_000);
  await assertCapture(cdp, `${label} initial`);
  await alternateScreenWheelAssault(cdp, `${label} wheel assault`);

  const sizes = [
    [720, 520],
    [1240, 780],
    [520, 560],
    [1120, 640],
    [640, 720],
    [1200, 800],
  ];
  for (let index = 0; index < sizes.length; index += 1) {
    await wheelRows(cdp, index % 2 === 0 ? -16 : 20, 1);
    const [width, height] = sizes[index];
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(180);
    await flushAnimationFrames(cdp, resizeFrameFlushes);
    await assertAlternateScreenPinned(cdp, `${label} resize ${index + 1}`);
    await assertVisibleAltFrameAdvances(cdp, `${label} frame ${index + 1}`, 1, 250);
    await assertCapture(cdp, `${label} resize ${index + 1}`);
  }

  await waitForSnapshot(
    cdp,
    snapshot => rows(snapshot).some(row => /\bALT_STRESS_DONE\b/u.test(String(row.text ?? ''))),
    Math.max(8_000, altScreenFrames * 40),
  ).catch(error => {
    failures.push(`${label}: expected alternate screen exit marker, ${error.message}`);
  });
  await assertCapture(cdp, `${label} returned`);
  await waitForLiveFollow(cdp, `${label} live restored`);
  await assertVisibleLiveTickAdvances(cdp, `${label} live output after alternate screen`, 1, 900);
}

async function alternateScreenWheelAssault(cdp, label) {
  await assertAlternateScreenPinned(cdp, `${label} initial pin`);
  const wheelPattern = [-120, 120, -90, 90, -140, 140, -60, 60];
  for (const rows of wheelPattern) {
    await wheelRows(cdp, rows, 1);
    await sleep(45);
    await flushAnimationFrames(cdp, 1);
  }
  await assertAlternateScreenPinned(cdp, `${label} final pin`);
  await assertVisibleAltFrameAdvances(cdp, label, 1, 250);
  await assertCapture(cdp, label);
}

async function assertAlternateScreenPinned(cdp, label) {
  const snapshot = await snapshotOf(cdp);
  const viewport = snapshot?.viewport;
  const hasAltRows = (snapshot?.visibleRows ?? []).some(row =>
    /\bALT(?:_ROW)?\b/u.test(String(row.text ?? '')),
  );
  if (!hasAltRows) {
    failures.push(
      `${label}: no visible alternate-screen rows, saw ${JSON.stringify(
        (snapshot?.visibleRows ?? []).slice(0, 6),
      )}`,
    );
    return;
  }
  if (snapshot?.controller?.liveFollow !== true) {
    failures.push(
      `${label}: alternate-screen liveFollow is ${String(snapshot?.controller?.liveFollow)}`,
    );
  }
  if (!viewport) {
    failures.push(`${label}: missing viewport`);
    return;
  }
  const cellHeight = snapshot?.surface?.cellHeight ?? 18;
  const allowedGap = Math.max(3, cellHeight);
  if (viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - allowedGap) {
    failures.push(
      `${label}: alternate-screen viewport detached, scrollTop=${viewport.scrollTop}, clientHeight=${viewport.clientHeight}, scrollHeight=${viewport.scrollHeight}`,
    );
  }
}

async function historyLiveInputRace(cdp, label) {
  await wheelToScrollbackView(cdp, `${label} pre-input scrollback`);
  await resizeBurst(cdp, `${label} pre-input resize`, [
    [760, 520],
    [1220, 780],
    [560, 600],
    [1120, 660],
  ]);
  const token = `race-${Date.now()}`;
  await typeTerminalText(cdp, `${token}\n`);
  await waitForSnapshot(
    cdp,
    snapshot =>
      rows(snapshot).some(row => row.text.includes(token)) &&
      snapshot?.controller?.liveFollow === true &&
      snapshot?.controller?.historyMode === false,
    8_000,
  ).catch(error => {
    failures.push(`${label}: ${error.message}`);
  });
  await waitForLiveFollow(cdp, label);
  await assertCapture(cdp, label);
  await assertVisibleLiveTickAdvances(cdp, `${label} visible live output`, 1, 900);
  await sleep(700);
  await waitForLiveFollow(cdp, `${label} after stale jump window`);
}

async function waitForLiveFollow(cdp, label) {
  await waitForSnapshot(
    cdp,
    snapshot =>
      snapshot?.controller?.liveFollow === true &&
      snapshot?.controller?.historyMode === false &&
      maxVisibleLiveTick(snapshot) !== null,
    8_000,
  ).catch(error => {
    failures.push(`${label}: expected live-follow terminal, ${error.message}`);
  });
}

async function typeTerminalText(cdp, text, options = {}) {
  await evaluate(
    cdp,
    `(() => {
      const input = document.querySelector('[data-testid="terminal-bridge-debug-input"]');
      if (!(input instanceof HTMLTextAreaElement)) throw new Error('missing terminal input');
      input.focus({ preventScroll: true });
      return true;
    })()`,
  );
  let pendingText = '';
  async function flushText() {
    if (!pendingText) return;
    const value = JSON.stringify(pendingText);
    await evaluate(
      cdp,
      `(() => {
        const input = document.querySelector('[data-testid="terminal-bridge-debug-input"]');
        if (!(input instanceof HTMLTextAreaElement)) throw new Error('missing terminal input');
        input.focus({ preventScroll: true });
        input.value += ${value};
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          data: ${value},
          inputType: 'insertText',
        }));
        return true;
      })()`,
    );
    pendingText = '';
  }
  for (const char of text) {
    if (char === '\n') {
      await flushText();
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    } else {
      pendingText += char;
    }
  }
  await flushText();
  const token = text.trim();
  if (token && options.bridgeFallback !== false) {
    await sleep(250);
    const snapshot = await snapshotOf(cdp);
    if (!rows(snapshot).some(row => row.text.includes(token)) && snapshot?.terminalId) {
      await bridgePost('/input', { terminalId: snapshot.terminalId, input: text });
    }
  }
}

async function writeBridgeInput(cdp, text) {
  const snapshot = await snapshotOf(cdp);
  if (!snapshot?.terminalId) {
    throw new Error('missing terminal id for bridge input');
  }
  await bridgePost('/input', { terminalId: snapshot.terminalId, input: text });
}

async function bridgePost(path, body) {
  const response = await fetch(`${bridgeUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Bridge ${path} failed: ${response.status} ${await response.text()}`);
  }
}

function rows(snapshot) {
  return [...(snapshot?.rows ?? []), ...(snapshot?.visibleRows ?? [])];
}

function textRowCount(snapshot) {
  return (snapshot?.rows ?? []).filter(row => hasStressText(row.text)).length;
}

function hasManyRows(snapshot) {
  const viewport = snapshot?.viewport;
  const scrollbackReady =
    viewport !== undefined &&
    viewport.scrollHeight > Math.max(viewport.clientHeight * 3, viewport.clientHeight + 1200);
  return textRowCount(snapshot) >= 24 && scrollbackReady;
}

function hasLiveOutput(snapshot) {
  return (
    maxVisibleLiveTick(snapshot) !== null || rows(snapshot).some(row => liveTick(row.text) !== null)
  );
}

function visibleTextRowCount(snapshot) {
  return (snapshot?.visibleRows ?? []).filter(row => hasStressText(row.text)).length;
}

function visibleRowIndexGap(snapshot) {
  const indexes = (snapshot?.visibleRows ?? [])
    .map(row => Number(row.index))
    .filter(index => Number.isFinite(index))
    .sort((left, right) => left - right);
  let maxGap = 0;
  for (let index = 1; index < indexes.length; index += 1) {
    maxGap = Math.max(maxGap, indexes[index] - indexes[index - 1]);
  }
  return maxGap;
}

function hasStressText(value) {
  return /\b(?:HIST|LIVE|SPIN|ANIM|ECHO_STRESS|ALT|ALT_ROW|ALT_STRESS_DONE)\b/u.test(
    String(value ?? ''),
  );
}

function maxVisibleLiveTick(snapshot) {
  let maxTick = null;
  for (const row of snapshot?.visibleRows ?? []) {
    const tick = liveTick(row.text);
    if (tick === null) continue;
    maxTick = maxTick === null ? tick : Math.max(maxTick, tick);
  }
  return maxTick;
}

function maxVisibleAltFrame(snapshot) {
  let maxFrame = null;
  for (const row of snapshot?.visibleRows ?? []) {
    const frame = altFrame(row.text);
    if (frame === null) continue;
    maxFrame = maxFrame === null ? frame : Math.max(maxFrame, frame);
  }
  return maxFrame;
}

function visibleHistNumbers(snapshot) {
  const numbers = [];
  for (const row of snapshot?.visibleRows ?? []) {
    const match = /\bHIST\s+(\d{4})\b/u.exec(String(row.text ?? ''));
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value)) numbers.push(value);
  }
  return numbers;
}

function visibleLiveTicks(snapshot) {
  const ticks = [];
  for (const row of snapshot?.visibleRows ?? []) {
    const tick = liveTick(row.text);
    if (tick === null) continue;
    ticks.push(tick);
  }
  return ticks;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function liveTick(text) {
  const match = /\b(?:LIVE|SPIN|ANIM)\s+(\d{6})\b/u.exec(String(text ?? ''));
  if (!match) return null;
  const tick = Number(match[1]);
  return Number.isFinite(tick) ? tick : null;
}

function altFrame(text) {
  const match = /\b(?:ALT|ALT_ROW)\s+\d{0,6}[^0-9]+frame=(\d{6})|\bALT\s+(\d{6})\b/u.exec(
    String(text ?? ''),
  );
  if (!match) return null;
  const frame = Number(match[1] ?? match[2]);
  return Number.isFinite(frame) ? frame : null;
}

async function assertVisibleText(cdp, label, pattern) {
  const snapshot = await snapshotOf(cdp);
  const visible = snapshot?.visibleRows ?? [];
  if (!visible.some(row => pattern.test(String(row.text ?? '')))) {
    failures.push(
      `${label}: expected visible text ${String(pattern)}, saw ${JSON.stringify(
        visible.slice(0, 6),
      )}`,
    );
  }
}

async function waitForVisiblePattern(cdp, label, pattern, timeoutMs = 8_000) {
  await waitForSnapshot(
    cdp,
    snapshot => (snapshot?.visibleRows ?? []).some(row => pattern.test(String(row.text ?? ''))),
    timeoutMs,
  ).catch(error => {
    failures.push(`${label}: expected visible text ${String(pattern)}, ${error.message}`);
  });
}

async function assertHistoryTopMarker(cdp, label) {
  const snapshot = await snapshotOf(cdp);
  const visible = snapshot?.visibleRows ?? [];
  if (!visible.some(row => /\bHIST 0001\b/u.test(String(row.text ?? '')))) {
    failures.push(
      `${label}: expected the first transcript row at history top, saw ${JSON.stringify(
        visible.slice(0, 8),
      )}`,
    );
  }
}

async function waitForVisibleStressRows(cdp, label, minimumRows = 3) {
  await waitForSnapshot(cdp, snapshot => visibleTextRowCount(snapshot) >= minimumRows, 8_000).catch(
    error => {
      failures.push(`${label}: ${error.message}`);
    },
  );
}

async function waitForScrollbackView(cdp, label) {
  await waitForSnapshot(cdp, snapshot => isScrollbackView(snapshot), 8_000).catch(error => {
    failures.push(`${label}: expected preserved scrollback view, ${error.message}`);
  });
}

async function waitForDetachedVisibleStressView(cdp, label) {
  await waitForSnapshot(
    cdp,
    snapshot => {
      const controller = snapshot?.controller;
      const requiredVisibleRows = Math.max(12, Math.floor((snapshot?.surface?.rows ?? 12) * 0.55));
      const historySettled =
        controller?.pendingHistoryScrollTarget === null &&
        controller?.pendingHistoryJumpTarget === null &&
        controller?.historyJumpBusy === false;
      return (
        controller?.liveFollow === false &&
        historySettled &&
        visibleTextRowCount(snapshot) >= requiredVisibleRows
      );
    },
    8_000,
  ).catch(error => {
    failures.push(`${label}: expected dense detached visible stress view, ${error.message}`);
  });
}

async function waitForCurrentSurfaceBuffer(cdp, label) {
  await waitForSnapshot(
    cdp,
    snapshot =>
      snapshot?.surface?.cols === snapshot?.buffer?.cols &&
      snapshot?.surface?.rows === snapshot?.buffer?.viewportRows &&
      snapshot?.buffer?.resizeReflowPending === false,
    15_000,
  ).catch(error => {
    failures.push(`${label}: expected history replay to match current surface, ${error.message}`);
  });
}

async function wheelToScrollbackView(cdp, label) {
  for (let step = 0; step < boundaryWheelSteps; step += 1) {
    const snapshot = await snapshotOf(cdp);
    if (isScrollbackView(snapshot)) return;
    await wheelRows(cdp, -90, 1);
  }
  await waitForScrollbackView(cdp, label);
}

function isScrollbackView(snapshot) {
  const controller = snapshot?.controller;
  const historySettled =
    controller?.pendingHistoryScrollTarget === null &&
    controller?.pendingHistoryJumpTarget === null &&
    controller?.historyJumpBusy === false;
  return (
    controller?.liveFollow === false &&
    historySettled &&
    visibleTextRowCount(snapshot) >= 3 &&
    (snapshot?.visibleRows ?? []).some(row => /\bHIST \d{4}\b/u.test(String(row.text ?? '')))
  );
}

async function snapshotOf(cdp) {
  return evaluate(cdp, 'window.__REVERIE_TERMINAL_DEBUG__?.()');
}

async function waitForSnapshot(cdp, predicate, timeoutMs = 10_000) {
  const started = Date.now();
  let lastSnapshot = null;
  while (Date.now() - started < timeoutMs) {
    const snapshot = await snapshotOf(cdp);
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

function canvasPixelProbeExpression() {
  return `(() => {
    const canvas = document.querySelector('[data-testid="terminal-bridge-debug-canvas"]');
    if (!(canvas instanceof HTMLCanvasElement)) return { ok: false, reason: 'missing canvas' };
    const viewport = document.querySelector('[data-testid="terminal-bridge-debug-viewport"]');
    if (!(viewport instanceof HTMLElement)) return { ok: false, reason: 'missing viewport' };
    const canvasRect = canvas.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const debug = window.__REVERIE_TERMINAL_DEBUG__?.();
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
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      return { ok: false, reason: 'no visible canvas intersection', visibleCopiedBrightPixels: 0 };
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
    };
  })()`;
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
    throw new Error(result.exceptionDetails.exception?.description ?? 'Runtime.evaluate failed');
  }
  return result.result.value;
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  static async connect(targetUrl) {
    const socket = new WebSocket(targetUrl);
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
    if (!message.id) return;
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
}

await main();
