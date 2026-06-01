import { createTerminalGpuRenderer } from './terminal-gpu-renderer';
import { makeSyntheticFrame, percentile, TERMINAL_SURFACE } from './terminal-canvas-renderer';
import type { RenderMetrics } from './domain';
import type { TerminalFrame } from './terminalTypes';

type HarnessScenario =
  | 'empty-onboarding'
  | 'partial-cli'
  | 'no-cli'
  | 'terminal-interaction'
  | 'terminal-concurrent-sessions'
  | 'terminal-alternate-screen'
  | 'terminal-resize-storm'
  | 'terminal-render-performance';

type HarnessResult = {
  scenario: HarnessScenario;
  status: 'passed' | 'failed';
  assertions: string[];
  error?: string;
};

let harnessSmokeStarted = false;
const assertions: string[] = [];

export function maybeRunHarnessSmokeTest() {
  const scenario = new URLSearchParams(window.location.search).get(
    'harnessSmoke',
  ) as HarnessScenario | null;
  if (!scenario || harnessSmokeStarted) return;

  harnessSmokeStarted = true;
  window.setTimeout(() => {
    runHarnessSmokeScenario(scenario).catch(error => {
      publishHarnessResult({
        scenario,
        status: 'failed',
        assertions: [...assertions],
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    });
  }, 0);
}

async function runHarnessSmokeScenario(scenario: HarnessScenario) {
  assertions.length = 0;
  await waitFor(() => Boolean(queryByTestId('reverie-app-shell')), 'Reverie app shell mounted');

  switch (scenario) {
    case 'empty-onboarding':
      await runEmptyOnboardingScenario();
      break;
    case 'partial-cli':
      await runPartialCliScenario();
      break;
    case 'no-cli':
      await runNoCliScenario();
      break;
    case 'terminal-interaction':
      await runTerminalInteractionScenario();
      break;
    case 'terminal-concurrent-sessions':
      await runTerminalConcurrentSessionsScenario();
      break;
    case 'terminal-alternate-screen':
      await runTerminalAlternateScreenScenario();
      break;
    case 'terminal-resize-storm':
      await runTerminalResizeStormScenario();
      break;
    case 'terminal-render-performance':
      await runTerminalRenderPerformanceScenario();
      break;
    default:
      throw new Error(`Unknown harness smoke scenario: ${scenario}`);
  }

  publishHarnessResult({ scenario, status: 'passed', assertions: [...assertions] });
}

async function runTerminalRenderPerformanceScenario() {
  const cols = TERMINAL_SURFACE.cols;
  const rows = TERMINAL_SURFACE.rows;
  const canvas = document.createElement('canvas');
  canvas.width = cols * TERMINAL_SURFACE.cellWidth;
  canvas.height = rows * TERMINAL_SURFACE.cellHeight;
  canvas.style.cssText =
    'position:fixed;left:-10000px;top:0;width:1080px;height:648px;pointer-events:none;';
  document.body.appendChild(canvas);

  try {
    const renderer = createTerminalGpuRenderer(canvas, {
      cols,
      rows,
      cellWidth: TERMINAL_SURFACE.cellWidth,
      cellHeight: TERMINAL_SURFACE.cellHeight,
      preferredBackends: ['webgl2', 'canvas2d'],
    });
    const backend = renderer.capabilities.backend;
    if (backend !== 'webgl2') {
      throw new Error(`terminal renderer benchmark expected webgl2, got ${backend}`);
    }

    for (let frameIndex = 0; frameIndex < 96; frameIndex += 1) {
      renderer.paintFrame(makeSyntheticFrame(frameIndex, { cols, rows }));
    }
    await nextAnimationFrame();
    await expectCanvasPainted(canvas, 'benchmark canvas paints through WebGL2');
    await expectDirtyPaintPreservesUntouchedRows(renderer, canvas, cols, rows);

    const fullWindow = await measureRendererFrames(renderer, frameIndex =>
      makeSyntheticFrame(1000 + frameIndex, { cols, rows }),
    );
    const dirtyRows = await measureRendererFrames(renderer, frameIndex =>
      makeSyntheticFrame(2000 + frameIndex, {
        cols,
        rows,
        dirtyOnly: true,
        dirtyRowsPerFrame: 8,
      }),
    );

    assertRendererBudget(fullWindow, 'full-window WebGL2 paints stay inside 60 FPS budget', {
      p95Ms: 16.7,
      avgMs: 10,
      slowFrames: 3,
    });
    assertRendererBudget(dirtyRows, 'dirty-row WebGL2 paints leave scroll headroom', {
      p95Ms: 8,
      avgMs: 5,
      slowFrames: 0,
    });
  } finally {
    canvas.remove();
  }

  await runTerminalControllerWebGlPerformanceScenario();
}

async function runEmptyOnboardingScenario() {
  const stage = new URLSearchParams(window.location.search).get('harnessStage');
  if (stage === 'assert-persisted') {
    await runAssertPersistedScenario();
    return;
  }

  await expectTestId('onboarding-panel', 'empty fixture starts on onboarding');
  await expectTestId(
    'empty-create-session-button',
    'onboarding offers a New session action for General',
  );

  await clickTestId('empty-create-project-button');
  await expectComposerMode('project');
  expectAbsentTestId('session-tabs', 'project creation hides session tabs');
  expectAbsentTestId('terminal-body', 'project creation hides the terminal body');
  await clickTestId('choose-project-folder-button');
  await waitFor(
    () => requireTestId('project-folder-selection').getAttribute('data-selected') === 'true',
    'project folder picker records a selected folder',
  );
  assertions.push('project folder picker records a selected folder');
  await waitFor(
    () => !isDisabled(requireTestId('submit-project-button')),
    'Add project enables after a folder is selected',
  );
  await clickTestId('submit-project-button');

  // A fresh project drops straight into the topic composer. Agent tiles are the
  // commit: they stay disabled until the topic is named, then picking one creates
  // the topic and its first session in a single step.
  await expectComposerMode('focus');
  expectAbsentTestId('session-tabs', 'topic creation hides session tabs');
  expectAbsentTestId('terminal-body', 'topic creation hides the terminal body');
  expectDisabled(
    selectorForCli('codex_cli'),
    true,
    'agent tiles are disabled until the topic is named',
  );
  fillInput('focus-title-input', 'Harness Smoke Topic');
  await waitFor(
    () => !isDisabled(requireSelector(selectorForCli('codex_cli'))),
    'agent tiles enable after the topic is named',
  );
  await clickCliChoice('codex_cli');

  await waitFor(() => !queryByTestId('creation-composer'), 'picking an agent closes the composer');
  await expectTestId('terminal-body', 'the first session opens the terminal body');
  await waitForTextIncludes(
    'terminal-status-label',
    'Running',
    'the first Codex session starts its own terminal runtime',
  );
  assertDocumentIncludes('Harness Smoke Topic', 'created topic is visible in the shell');
  assertTextIncludes('session-tabs', 'Codex', 'the first session shows the agent name in its tab');
  const codexTerminalId = await waitForTerminalId(
    'created Codex session receives its own terminal id',
  );

  // A second session in the same topic, started from the tab bar, again commits
  // by picking an agent.
  await clickTestId('create-session-button');
  await expectComposerMode('session');
  await clickCliChoice('claude_code');
  await waitFor(() => !queryByTestId('creation-composer'), 'second agent pick closes the composer');
  await waitForTextIncludes('session-tabs', 'Claude', 'second session becomes the active terminal');
  const claudeTerminalId = await waitForTerminalId(
    'created Claude session receives its own terminal id',
  );
  if (claudeTerminalId === codexTerminalId) {
    throw new Error(
      'session tabs share a terminal id; expected each session tab to own a distinct terminal process',
    );
  }
  assertions.push('separate session tabs own distinct terminal ids');

  await clickSessionTabWithText('Codex');
  await waitFor(
    () => requireTestId('terminal-body').getAttribute('data-terminal-id') === codexTerminalId,
    'clicking Codex tab reattaches its original terminal id',
  );
  assertions.push('clicking Codex tab reattaches its original terminal id');
  await clickSessionTabWithText('Claude');
  await waitFor(
    () => requireTestId('terminal-body').getAttribute('data-terminal-id') === claudeTerminalId,
    'clicking Claude tab reattaches its original terminal id',
  );
  assertions.push('clicking Claude tab reattaches its original terminal id');

  await closeActiveSessionTab();
  await waitFor(
    () =>
      ![...document.querySelectorAll('[data-testid="session-tab"]')].some(tab =>
        tab.textContent?.includes('Claude'),
      ),
    'closing a top tab hides it from active tabs',
  );
  assertions.push('closing a top tab hides it from active tabs');
  await clickTestId('nav-focus-open');
  await expectTestId('session-history-surface', 'opening the topic shows its dashboard');
  await waitFor(
    () =>
      Boolean(
        document.querySelector('[data-testid="session-history-row"][data-tab-visible="false"]'),
      ),
    'closed (archived) session shows in the topic archived list',
  );
  assertions.push('closed (archived) session shows in the topic archived list');
  await clickTestId('restore-session-tab-button');
  await clickSessionTabWithText('Claude');
  await waitFor(() => {
    const restoredTerminalId =
      requireTestId('terminal-body').getAttribute('data-terminal-id') ?? '';
    return restoredTerminalId.length > 0 && restoredTerminalId !== claudeTerminalId;
  }, 'restored tab starts a fresh resumable terminal runtime');
  assertions.push('restored tab starts a fresh resumable terminal runtime');

  window.location.replace(
    `${window.location.origin}${window.location.pathname}?fixture=empty&harnessSmoke=empty-onboarding&harnessStage=assert-persisted`,
  );
  await new Promise<void>(() => {});
}

async function runPartialCliScenario() {
  await expectTestId('onboarding-panel', 'empty partial-CLI fixture starts on onboarding');
  await clickTestId('empty-create-session-button');

  await expectComposerMode('session');
  // The cwd lives behind the Options disclosure now.
  await clickTestId('session-options-toggle');
  assertInputValue(
    'session-cwd-input',
    '/Users/user',
    'general workspace session defaults to the home cwd',
  );
  expectCliAvailability('codex_cli', false, 'Codex is shown unavailable in the partial fixture');
  expectDisabled(selectorForCli('codex_cli'), true, 'unavailable Codex tile is disabled');
  await clickCliChoice('claude_code');

  await waitFor(
    () => !queryByTestId('creation-composer'),
    'partial CLI session creation closes the composer',
  );
  await waitForTextIncludes(
    'terminal-status-label',
    'Running',
    'created Claude session starts its own terminal runtime',
  );
  assertTextIncludes('session-tabs', 'Claude', 'Claude session shows the agent name in its tab');
}

async function runNoCliScenario() {
  await expectTestId('onboarding-panel', 'empty no-CLI fixture starts on onboarding');
  await clickTestId('empty-create-session-button');

  await expectComposerMode('session');
  await expectTestId(
    'cli-empty-help',
    'no-CLI fixture explains that organization can continue without an agent',
  );
  for (const kind of ['cortex_code', 'claude_code', 'codex_cli']) {
    expectCliAvailability(kind, false, `${kind} is unavailable in the no-CLI fixture`);
    expectDisabled(selectorForCli(kind), true, `${kind} tile is disabled in the no-CLI fixture`);
  }
}

async function runAssertPersistedScenario() {
  await waitFor(
    () => !queryByTestId('onboarding-panel'),
    'persisted empty fixture does not return to onboarding',
  );
  await waitForDocumentIncludes(
    'reverie',
    'folder-selected project persists across a browser reload',
  );
  await waitForDocumentIncludes('Harness Smoke Topic', 'topic persists across a browser reload');
  await expectTestId(
    'dashboard-surface',
    'persisted workspace opens to the dashboard after reload',
  );
  await waitFor(() => {
    const card = [
      ...document.querySelectorAll<HTMLElement>('[data-testid="dashboard-session-card"]'),
    ].find(candidate => candidate.textContent?.includes('Codex'));
    if (!card) return false;
    card.click();
    return true;
  }, 'persisted Codex session is visible on the dashboard after reload');
  assertions.push('persisted Codex session is visible on the dashboard after reload');
  await expectTestId(
    'terminal-body',
    'persisted created session opens terminal body from dashboard after reload',
  );
  await waitForTextIncludes('session-tabs', 'Codex', 'session persists across a browser reload');
  await waitFor(() => {
    const activeTab = document.querySelector('[data-testid="session-tab"][data-active="true"]');
    return Boolean(activeTab?.textContent?.includes('Codex'));
  }, 'persisted Codex session tab becomes selected after dashboard open');
  assertions.push('persisted Codex session tab becomes selected after dashboard open');
}

interface FixtureHook {
  stopStream(terminalId: string): void;
  emitTerminalFrame(terminalId: string, lines: string[]): void;
  emitRawTerminalFrame(terminalId: string, frame: TerminalFrame, seq?: number): void;
  finishTerminal(terminalId: string, childSuccess?: boolean): void;
  frontendActivityEvents(): Array<{ terminalId: string; active: boolean }>;
  recordedInputs(): Array<{ terminalId: string; input: string }>;
  recordedRenderMetrics(): RenderMetrics[];
}

interface TerminalDebugHook {
  trace(): Array<Record<string, unknown>>;
  clear(): void;
  summary(): {
    surface?: { cols: number; rows: number; cellWidth: number; cellHeight: number };
    liveFollow?: boolean;
    startRow?: number;
    rowCount?: number;
    visibleRowCount?: number;
    firstVisibleRow?: number | null;
    lastVisibleRow?: number | null;
    traceLength?: number;
    traceCounts?: Record<string, number>;
    metrics?: Record<string, number>;
  };
  visibleRows(): Array<{ index: number; text: string }>;
}

function fixtureHook(): FixtureHook {
  const hook = (window as unknown as { __REVERIE_FIXTURE__?: FixtureHook }).__REVERIE_FIXTURE__;
  if (!hook) throw new Error('fixture test hook (__REVERIE_FIXTURE__) is not present');
  return hook;
}

function terminalDebugHook(): TerminalDebugHook {
  const hook = (window as unknown as { __REVERIE_TERMINAL_DEBUG__?: TerminalDebugHook })
    .__REVERIE_TERMINAL_DEBUG__;
  if (!hook) throw new Error('terminal debug hook (__REVERIE_TERMINAL_DEBUG__) is not present');
  return hook;
}

async function createRunningTerminalSession(topicTitle: string, labelPrefix: string) {
  await clickTestId('empty-create-project-button');
  await clickTestId('choose-project-folder-button');
  await waitFor(
    () => requireTestId('project-folder-selection').getAttribute('data-selected') === 'true',
    `${labelPrefix} project folder is selected`,
  );
  await waitFor(
    () => !isDisabled(requireTestId('submit-project-button')),
    `${labelPrefix} project submit enables`,
  );
  await clickTestId('submit-project-button');
  fillInput('focus-title-input', topicTitle);
  await waitFor(
    () => !isDisabled(requireSelector(selectorForCli('codex_cli'))),
    `${labelPrefix} Codex tile enables after the topic is named`,
  );
  await clickCliChoice('codex_cli');
  await expectTestId('terminal-body', `${labelPrefix} session opens terminal body`);
  await waitForTextIncludes('terminal-status-label', 'Running', `${labelPrefix} session starts`);
  const terminalId = await waitForTerminalId(`${labelPrefix} session has a terminal id`);
  const fixture = fixtureHook();
  fixture.stopStream(terminalId);
  return {
    terminalId,
    fixture,
    canvas: requireTestId<HTMLCanvasElement>('terminal-canvas'),
    viewport: requireTestId<HTMLDivElement>('terminal-viewport'),
    debug: terminalDebugHook(),
  };
}

async function runTerminalControllerWebGlPerformanceScenario() {
  await clickTestId('empty-create-session-button');
  await expectComposerMode('session');
  await clickCliChoice('codex_cli');
  await expectTestId('terminal-body', 'controller WebGL session opens terminal body');
  await waitForTextIncludes('terminal-status-label', 'Running', 'controller WebGL session starts');
  const terminalId = await waitForTerminalId('controller WebGL session has a terminal id');
  const fixture = fixtureHook();
  const canvas = requireTestId<HTMLCanvasElement>('terminal-canvas');
  await waitFor(
    () => canvas.width > 0 && canvas.height > 0 && canvas.getBoundingClientRect().height > 0,
    'controller WebGL canvas has a backing store',
  );
  fixture.stopStream(terminalId);
  await flushDom();
  const viewport = requireTestId<HTMLDivElement>('terminal-viewport');
  viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
  await flushDom();

  fixture.emitRawTerminalFrame(
    terminalId,
    terminalFrameFromLines([
      'controller WebGL row zero before',
      'controller WebGL row one',
      'controller WebGL row two',
      'controller WebGL row three',
      'controller WebGL row four',
      'controller WebGL stable sentinel',
    ]),
    30_000,
  );
  await flushDom();
  viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
  await flushDom();
  const partialUpdates = 16;

  for (let index = 0; index < partialUpdates; index += 1) {
    fixture.emitRawTerminalFrame(
      terminalId,
      terminalFrameFromLines([`controller WebGL row zero ${index}`], {
        dirty: 'partial',
        rowOffset: 0,
      }),
      30_001 + index,
    );
    await flushDom();
  }

  fixture.finishTerminal(terminalId, true);
  await waitFor(() => {
    return fixture.recordedRenderMetrics().some(metrics => metrics.terminalId === terminalId);
  }, 'controller WebGL session records render metrics');
  const metrics = fixture
    .recordedRenderMetrics()
    .filter(metrics => metrics.terminalId === terminalId)
    .at(-1);
  if (!metrics) throw new Error('missing controller WebGL render metrics');
  if (metrics.rendererBackend !== 'webgl2') {
    throw new Error(`controller terminal expected WebGL2 backend, got ${metrics.rendererBackend}`);
  }
  const paintSamples = metrics.paintSamples ?? 0;
  const averageRowsPainted =
    paintSamples === 0 ? 0 : (metrics.rendererRowsPainted ?? 0) / paintSamples;
  if (averageRowsPainted <= 0) {
    throw new Error(
      `controller WebGL retained paints did not record painted rows: avg rows ${averageRowsPainted.toFixed(
        2,
      )}`,
    );
  }
  assertions.push(
    `controller WebGL2 path records retained dirty-row paints: avgRows=${averageRowsPainted.toFixed(
      1,
    )}`,
  );
}

async function runTerminalResizeStormScenario() {
  const { terminalId, fixture, viewport, canvas, debug } = await createRunningTerminalSession(
    'Resize Storm Topic',
    'resize-storm',
  );
  await setTerminalViewportRows(viewport, 20, 'resize-storm baseline surface rows');
  fixture.emitRawTerminalFrame(
    terminalId,
    terminalFrameFromLines(
      Array.from({ length: 40 }, (_, index) => `resize storm stable row ${index}`),
    ),
    40_000,
  );
  await waitFor(
    () => debug.visibleRows().some(row => row.text.startsWith('resize storm stable row')),
    'resize-storm visible rows show the baseline frame',
  );
  assertCanvasGeometry(canvas, 'resize-storm canvas has a nonzero backing store');
  debug.clear();

  const stormSizes = [
    { cols: 121, rows: 21 },
    { cols: 124, rows: 22 },
    { cols: 127, rows: 23 },
    { cols: 122, rows: 24 },
    { cols: 120, rows: 22 },
    { cols: 126, rows: 20 },
    { cols: 121, rows: 21 },
    { cols: 127, rows: 24 },
    { cols: 123, rows: 23 },
    { cols: 120, rows: 20 },
  ];
  for (const { cols, rows } of stormSizes) {
    await setTerminalViewportSize(
      viewport,
      cols,
      rows,
      `resize-storm surface reaches ${cols}x${rows}`,
    );
    await waitFor(
      () => debug.visibleRows().some(row => row.text.startsWith('resize storm stable row')),
      `resize-storm content stays visible at ${cols}x${rows}`,
    );
    assertCanvasGeometry(canvas, `resize-storm canvas geometry stays valid at ${cols}x${rows}`);
  }

  const summary = debug.summary();
  const counts = summary.traceCounts ?? {};
  const mountStarts = counts['renderer_mount:start'] ?? 0;
  const rendererDisposes = Object.entries(counts)
    .filter(([key]) => key.startsWith('renderer_dispose'))
    .reduce((sum, [, count]) => sum + count, 0);
  const surfaceChanges = counts.surface_change ?? 0;
  if (mountStarts !== 0 || rendererDisposes !== 0) {
    throw new Error(
      `within-capacity resize remounted renderer: mountStarts=${mountStarts} disposes=${rendererDisposes}`,
    );
  }
  if (surfaceChanges < stormSizes.length) {
    throw new Error(
      `resize storm did not report enough surface changes: ${surfaceChanges}/${stormSizes.length}`,
    );
  }
  assertions.push('within-capacity resize storm does not remount the renderer');
  assertions.push('within-capacity resize storm keeps the terminal canvas painted');
}

function assertCanvasGeometry(canvas: HTMLCanvasElement, label: string) {
  const rect = canvas.getBoundingClientRect();
  if (canvas.width <= 0 || canvas.height <= 0 || rect.width <= 0 || rect.height <= 0) {
    throw new Error(
      `${label}: invalid canvas geometry ${canvas.width}x${canvas.height}, rect=${rect.width}x${rect.height}`,
    );
  }
  assertions.push(label);
}

async function setTerminalViewportRows(viewport: HTMLDivElement, rows: number, label: string) {
  await setTerminalViewportSize(viewport, TERMINAL_SURFACE.cols, rows, label);
}

async function setTerminalViewportSize(
  viewport: HTMLDivElement,
  cols: number,
  rows: number,
  label: string,
) {
  const width = cols * TERMINAL_SURFACE.cellWidth;
  const height = rows * TERMINAL_SURFACE.cellHeight;
  viewport.style.width = `${width}px`;
  viewport.style.maxWidth = viewport.style.width;
  viewport.style.height = `${height}px`;
  viewport.style.maxHeight = viewport.style.height;
  await nextAnimationFrame();
  await flushDom();
  await waitFor(() => {
    const surface = terminalDebugHook().summary().surface;
    return surface?.cols === cols && surface.rows === rows;
  }, label);
  assertions.push(label);
}

// Exercises the terminal interaction layer end-to-end against the browser
// fixture: drag-select, the right-click menu (selection / link / grid targets),
// send-to-input, and link detection. A deterministic frame is injected so the
// assertions do not depend on the random synthetic stream.
async function runTerminalInteractionScenario() {
  // Onboard to a single running session.
  await clickTestId('empty-create-project-button');
  await clickTestId('choose-project-folder-button');
  await waitFor(
    () => requireTestId('project-folder-selection').getAttribute('data-selected') === 'true',
    'project folder is selected',
  );
  await waitFor(
    () => !isDisabled(requireTestId('submit-project-button')),
    'project submit enables',
  );
  await clickTestId('submit-project-button');
  fillInput('focus-title-input', 'Interaction Topic');
  await waitFor(
    () => !isDisabled(requireSelector(selectorForCli('codex_cli'))),
    'agent tiles enable after the topic is named',
  );
  // Picking the agent creates the topic and its first session and opens it.
  await clickCliChoice('codex_cli');
  await expectTestId('terminal-body', 'created session opens the terminal body');
  await waitForTextIncludes('terminal-status-label', 'Running', 'created session is running');
  const terminalId = await waitForTerminalId('interaction session has a terminal id');

  // Freeze the synthetic stream and inject a deterministic line with a URL.
  const fixture = fixtureHook();
  fixture.stopStream(terminalId);
  const canvas = requireTestId<HTMLCanvasElement>('terminal-canvas');
  const textInput = requireTestId<HTMLTextAreaElement>('terminal-text-input');
  await expectPrimaryDirtyPaintPreservesStablePixels(fixture, terminalId, canvas);
  fixture.emitTerminalFrame(terminalId, ['hello https://reverie.test/docs world']);
  await flushDom();
  const viewport = requireTestId('terminal-viewport');
  viewport.scrollTop = 0;
  viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
  await flushDom();

  await expectCanvasPainted(canvas, 'terminal canvas paints the injected frame');
  const pointer = (type: string, col: number, rowPx = 9, button = 0) => {
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        button,
        clientX: rect.left + col * 9 + 1,
        clientY: rect.top + rowPx,
      }),
    );
  };
  const contextMenu = (col: number, rowPx = 9) => {
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: rect.left + col * 9 + 1,
        clientY: rect.top + rowPx,
      }),
    );
  };
  const closeMenu = async () => {
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await flushDom();
  };

  // Drag-select "hello" (cols 0..4).
  pointer('pointerdown', 0);
  pointer('pointermove', 5);
  pointer('pointerup', 5);
  await flushDom();

  // Right-click the selection -> selection menu with copy + agent actions.
  contextMenu(2);
  await expectTestId('terminal-context-menu', 'right-click on a selection opens the menu');
  await expectTestId('menu-item-copy', 'selection menu offers Copy');
  await expectTestId('menu-item-ask-agent', 'selection menu offers Ask an agent about this');
  await expectTestId('menu-item-send-to-input', 'selection menu offers Send to input');

  // Send to input -> the selected text is written to the terminal.
  await clickTestId('menu-item-send-to-input');
  await waitFor(
    () => fixture.recordedInputs().some(entry => entry.input.includes('hello')),
    'Send to input writes the selection to the terminal',
  );
  assertions.push('Send to input writes the selection to the terminal');

  // Right-click the URL -> link menu (link target wins over the selection).
  contextMenu(12);
  await expectTestId('menu-item-open-link', 'right-click on a URL offers Open link');
  await expectTestId('menu-item-copy-link-address', 'link menu offers Copy link address');
  await closeMenu();

  textInput.focus();
  textInput.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  textInput.value = '界';
  textInput.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '界' }));
  await waitFor(
    () => fixture.recordedInputs().some(entry => entry.input.includes('界')),
    'IME composition commits text to the terminal',
  );
  assertions.push('IME composition commits text to the terminal');

  const wideInputCountBefore = fixture.recordedInputs().length;
  const rowBeforeWideFrame = canvasRowFingerprint(canvas, 0);
  fixture.emitRawTerminalFrame(terminalId, terminalWideCellFrame('A界B'));
  await waitFor(
    () => canvasRowFingerprint(canvas, 0) !== rowBeforeWideFrame,
    'wide-cell frame paints',
  );
  pointer('pointerdown', 2);
  pointer('pointermove', 1);
  pointer('pointerup', 1);
  await flushDom();
  contextMenu(2);
  await expectTestId('menu-item-send-to-input', 'wide-cell selection can send to input');
  await clickTestId('menu-item-send-to-input');
  await waitFor(
    () => fixture.recordedInputs().length > wideInputCountBefore,
    'wide-cell selection is written to terminal input',
  );
  const wideInput = fixture.recordedInputs().at(-1)?.input ?? '';
  if (wideInput !== '界') {
    throw new Error(`wide-cell selection copied unexpected text: ${JSON.stringify(wideInput)}`);
  }
  assertions.push('wide-cell selection copies the glyph once from either cell half');

  // A plain click on a blank cell clears the selection; right-click there yields
  // the empty-grid menu (Paste + Select all only, no Copy).
  pointer('pointerdown', 2, 99);
  pointer('pointerup', 2, 99);
  await flushDom();
  contextMenu(2, 99);
  await expectTestId('menu-item-paste', 'empty-grid menu offers Paste');
  await expectTestId('menu-item-select-all', 'empty-grid menu offers Select all');
  expectAbsentTestId('menu-item-copy', 'empty-grid menu has no Copy');
  await closeMenu();
}

async function expectPrimaryDirtyPaintPreservesStablePixels(
  fixture: FixtureHook,
  terminalId: string,
  canvas: HTMLCanvasElement,
) {
  fixture.emitRawTerminalFrame(
    terminalId,
    terminalFrameFromLines(['primary row zero before', '', '', '', '', 'primary stable sentinel']),
    20_001,
  );
  await waitFor(() => canvasHasVisibleVariance(canvas), 'primary dirty-paint base frame renders');
  await nextAnimationFrame();
  const viewport = requireTestId<HTMLDivElement>('terminal-viewport');
  viewport.scrollTop = 0;
  viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
  await nextAnimationFrame();
  const changedBefore = canvasRowFingerprint(canvas, 0);
  const stableBefore = canvasRowFingerprint(canvas, 5);

  fixture.emitRawTerminalFrame(
    terminalId,
    terminalFrameFromLines(['primary row zero after'], {
      dirty: 'partial',
      rowOffset: 0,
    }),
    20_002,
  );
  await waitFor(
    () => canvasRowFingerprint(canvas, 0) !== changedBefore,
    'primary dirty row repaints changed row',
  );

  const stableAfter = canvasRowFingerprint(canvas, 5);
  if (stableAfter !== stableBefore) {
    throw new Error('primary dirty-row paint changed an untouched stable row');
  }
  assertions.push('primary dirty-row paint preserves untouched rows');
}

async function runTerminalConcurrentSessionsScenario() {
  await clickTestId('empty-create-project-button');
  await clickTestId('choose-project-folder-button');
  await waitFor(
    () => requireTestId('project-folder-selection').getAttribute('data-selected') === 'true',
    'project folder is selected',
  );
  await waitFor(
    () => !isDisabled(requireTestId('submit-project-button')),
    'project submit enables',
  );
  await clickTestId('submit-project-button');
  fillInput('focus-title-input', 'Concurrent Terminal Topic');
  await waitFor(
    () => !isDisabled(requireSelector(selectorForCli('codex_cli'))),
    'agent tiles enable after the topic is named',
  );

  await clickCliChoice('codex_cli');
  await waitForTextIncludes('terminal-status-label', 'Running', 'first session starts running');
  const codexTerminalId = await waitForTerminalId('first session receives a terminal id');
  await waitForFrontendActivity({ [codexTerminalId]: true }, 'first terminal is marked foreground');

  await clickTestId('create-session-button');
  await clickCliChoice('claude_code');
  await waitForTextIncludes('session-tabs', 'Claude', 'second session becomes active');
  const claudeTerminalId = await waitForTerminalId('second session receives a terminal id');
  await waitForFrontendActivity(
    { [codexTerminalId]: false, [claudeTerminalId]: true },
    'foreground priority moves to the second terminal',
  );

  await clickTestId('create-session-button');
  await clickCliChoice('cortex_code');
  await waitForTextIncludes('session-tabs', 'Cortex', 'third session becomes active');
  const cortexTerminalId = await waitForTerminalId('third session receives a terminal id');
  if (new Set([codexTerminalId, claudeTerminalId, cortexTerminalId]).size !== 3) {
    throw new Error('concurrent terminal sessions did not receive distinct terminal ids');
  }
  assertions.push('concurrent terminal sessions receive distinct terminal ids');
  await waitForFrontendActivity(
    {
      [codexTerminalId]: false,
      [claudeTerminalId]: false,
      [cortexTerminalId]: true,
    },
    'foreground priority moves to the third terminal',
  );
  await waitForTextIncludes('terminal-status-label', 'Running', 'third terminal is input-ready');

  const fixture = fixtureHook();
  fixture.finishTerminal(claudeTerminalId, true);
  await waitForFrontendActivity(
    { [codexTerminalId]: false, [cortexTerminalId]: true },
    'background terminal exit keeps the current terminal foreground',
  );
  await waitForTextIncludes(
    'terminal-status-label',
    'Running',
    'background terminal exit keeps foreground input armed',
  );

  const textInput = requireTestId<HTMLTextAreaElement>('terminal-text-input');
  textInput.focus();
  const inputText = 'foreground input after background exit';
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(textInput, inputText);
  textInput.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      data: inputText,
      inputType: 'insertText',
    }),
  );
  await waitFor(
    () =>
      fixture
        .recordedInputs()
        .some(
          entry =>
            entry.terminalId === cortexTerminalId &&
            entry.input.includes('foreground input after background exit'),
        ),
    'background terminal exit does not disarm foreground input',
  );
  assertions.push('background terminal exit does not disarm foreground input');

  await clickSessionTabWithText('Codex');
  await waitForFrontendActivity(
    { [codexTerminalId]: true, [cortexTerminalId]: false },
    'foreground priority returns to a reselected terminal',
  );
}

async function runTerminalAlternateScreenScenario() {
  await clickTestId('empty-create-project-button');
  await clickTestId('choose-project-folder-button');
  await waitFor(
    () => requireTestId('project-folder-selection').getAttribute('data-selected') === 'true',
    'project folder is selected',
  );
  await waitFor(
    () => !isDisabled(requireTestId('submit-project-button')),
    'project submit enables',
  );
  await clickTestId('submit-project-button');
  fillInput('focus-title-input', 'Alternate Screen Topic');
  await waitFor(
    () => !isDisabled(requireSelector(selectorForCli('codex_cli'))),
    'Codex tile enables after the topic is named',
  );
  await clickCliChoice('codex_cli');
  await expectTestId('terminal-body', 'alternate-screen session opens terminal body');
  await waitForTextIncludes('terminal-status-label', 'Running', 'alternate-screen session starts');
  const terminalId = await waitForTerminalId('alternate-screen session has a terminal id');

  const fixture = fixtureHook();
  fixture.stopStream(terminalId);
  const canvas = requireTestId<HTMLCanvasElement>('terminal-canvas');

  fixture.emitTerminalFrame(terminalId, ['primary stale row zero', 'primary stale row one']);
  await flushDom();
  const viewport = requireTestId('terminal-viewport');
  viewport.scrollTop = 0;
  viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
  await flushDom();
  await waitFor(
    () => canvasHasVisibleVariance(canvas),
    'primary frame paints before alternate-screen entry',
  );
  const primaryRowZero = canvasRowFingerprint(canvas, 0);

  fixture.emitRawTerminalFrame(
    terminalId,
    terminalFrameFromLines(['ink base row zero', 'ink stable row one', 'ink base row two'], {
      alternateScreen: true,
    }),
    10_001,
  );
  await waitFor(
    () => canvasRowFingerprint(canvas, 0) !== primaryRowZero,
    'alternate-screen frame replaces primary row pixels',
  );

  const baseRowZero = canvasRowFingerprint(canvas, 0);
  const baseStableRowOne = canvasRowFingerprint(canvas, 1);
  const baseRowTwo = canvasRowFingerprint(canvas, 2);

  fixture.emitRawTerminalFrame(
    terminalId,
    terminalFrameFromLines(['ink row zero updated'], {
      alternateScreen: true,
      dirty: 'partial',
      rowOffset: 0,
    }),
    10_002,
  );
  fixture.emitRawTerminalFrame(
    terminalId,
    terminalFrameFromLines(['ink row two updated'], {
      alternateScreen: true,
      dirty: 'partial',
      rowOffset: 2,
    }),
    10_003,
  );
  await waitFor(
    () =>
      canvasRowFingerprint(canvas, 0) !== baseRowZero &&
      canvasRowFingerprint(canvas, 2) !== baseRowTwo,
    'coalesced alternate-screen partial rows repaint together',
  );
  const stableRowOne = canvasRowFingerprint(canvas, 1);
  if (stableRowOne !== baseStableRowOne) {
    throw new Error('alternate-screen dirty-row paint changed an untouched stable row');
  }
  assertions.push('alternate-screen dirty-row paint preserves untouched rows');
  openContextMenu(canvas, 1, TERMINAL_SURFACE.cellHeight * 5);
  await clickTestId('menu-item-select-all');
  await flushDom();
  openContextMenu(canvas, 1, 9);
  await expectTestId('menu-item-send-to-input', 'alternate-screen selection can send to input');
  const inputCountBeforeSend = fixture.recordedInputs().length;
  await clickTestId('menu-item-send-to-input');
  await waitFor(
    () => fixture.recordedInputs().length > inputCountBeforeSend,
    'alternate-screen selection is written to terminal input',
  );
  const input = fixture.recordedInputs().at(-1)?.input ?? '';
  if (
    !input.includes('ink row zero updated') ||
    !input.includes('ink stable row one') ||
    !input.includes('ink row two updated') ||
    input.includes('primary stale')
  ) {
    throw new Error(`unexpected alternate-screen selection text: ${JSON.stringify(input)}`);
  }
  assertions.push('alternate-screen composite selection contains only current rows');
}

function terminalFrameFromLines(
  lines: string[],
  options: {
    alternateScreen?: boolean;
    dirty?: TerminalFrame['dirty'];
    rowOffset?: number;
  } = {},
): TerminalFrame {
  const rowOffset = options.rowOffset ?? 0;
  const dirty = options.dirty ?? 'full';
  const totalRows = Math.max(TERMINAL_SURFACE.rows, rowOffset + lines.length);
  return {
    dirty,
    rows: lines.map((line, lineIndex) => ({
      index: rowOffset + lineIndex,
      dirty: true,
      cells: [...line].map((text, col) => ({ col, text })),
    })),
    cursor: { visible: false, row: 0, col: 0, position: { row: 0, col: 0 } },
    modes: { alternateScreen: options.alternateScreen === true },
    scrollback: {
      totalRows,
      scrollbackRows: Math.max(0, totalRows - TERMINAL_SURFACE.rows),
      viewportOffset: 0,
      viewportRows: TERMINAL_SURFACE.rows,
      atBottom: true,
    },
  };
}

function terminalWideCellFrame(text: 'A界B'): TerminalFrame {
  return {
    dirty: 'full',
    rows: [
      {
        index: 0,
        dirty: true,
        cells: [
          { col: 0, text: text[0] ?? 'A' },
          { col: 1, width: 2, text: text[1] ?? '界' },
          { col: 3, text: text[2] ?? 'B' },
        ],
      },
    ],
    cursor: { visible: false, row: 0, col: 0, position: { row: 0, col: 0 } },
    scrollback: {
      totalRows: TERMINAL_SURFACE.rows,
      scrollbackRows: 0,
      viewportOffset: 0,
      viewportRows: TERMINAL_SURFACE.rows,
      atBottom: true,
    },
  };
}

function openContextMenu(canvas: HTMLCanvasElement, col: number, rowPx = 9) {
  const rect = canvas.getBoundingClientRect();
  canvas.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + col * TERMINAL_SURFACE.cellWidth + 1,
      clientY: rect.top + rowPx,
    }),
  );
}

function canvasRowFingerprint(canvas: HTMLCanvasElement, row: number) {
  const backingScale = canvasBackingScale(canvas);
  const cellHeight = TERMINAL_SURFACE.cellHeight * backingScale;
  const cellWidth = TERMINAL_SURFACE.cellWidth * backingScale;
  const x = 0;
  const y = Math.max(0, Math.round(row * cellHeight));
  const width = Math.max(1, Math.min(canvas.width, Math.round(cellWidth * 48)));
  const height = Math.max(1, Math.min(canvas.height - y, Math.round(cellHeight)));
  const data = canvasRegionPixels(canvas, x, y, width, height);
  let hash = 2166136261;
  let signal = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3] ?? 0;
    signal += alpha;
    hash ^= data[offset] ?? 0;
    hash = Math.imul(hash, 16777619);
    hash ^= data[offset + 1] ?? 0;
    hash = Math.imul(hash, 16777619);
    hash ^= data[offset + 2] ?? 0;
    hash = Math.imul(hash, 16777619);
    hash ^= alpha;
    hash = Math.imul(hash, 16777619);
  }
  return `${hash >>> 0}:${signal}`;
}

function canvasBackingScale(canvas: HTMLCanvasElement) {
  const cssHeight =
    parseCssPx(canvas.style.height) ||
    canvas.getBoundingClientRect().height ||
    canvas.height / (window.devicePixelRatio || 1);
  return cssHeight > 0 ? canvas.height / cssHeight : window.devicePixelRatio || 1;
}

function parseCssPx(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function canvasRegionPixels(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const snapshot = document.createElement('canvas');
  snapshot.width = canvas.width;
  snapshot.height = canvas.height;
  const context = snapshot.getContext('2d');
  if (context) {
    try {
      context.drawImage(canvas, 0, 0);
      return context.getImageData(x, y, width, height).data;
    } catch {
      // Fall through to WebGL readback.
    }
  }

  const gl = canvas.getContext('webgl2');
  if (!gl) return new Uint8Array(width * height * 4);
  const pixels = new Uint8Array(width * height * 4);
  gl.finish();
  gl.readPixels(x, canvas.height - y - height, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return pixels;
}

async function waitForFrontendActivity(expected: Record<string, boolean>, label: string) {
  await waitFor(() => {
    const latest = latestFrontendActivity();
    return Object.entries(expected).every(
      ([terminalId, active]) => latest.get(terminalId) === active,
    );
  }, label);
  assertions.push(label);
}

function latestFrontendActivity() {
  const latest = new Map<string, boolean>();
  for (const event of fixtureHook().frontendActivityEvents()) {
    latest.set(event.terminalId, event.active);
  }
  return latest;
}

async function waitForTerminalId(label: string) {
  let terminalId = '';
  await waitFor(() => {
    terminalId = requireTestId('terminal-body').getAttribute('data-terminal-id') ?? '';
    return terminalId.length > 0;
  }, label);
  assertions.push(label);
  return terminalId;
}

async function clickSessionTabWithText(text: string) {
  const tab = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="session-tab"]')].find(
    candidate => candidate.textContent?.includes(text),
  );
  if (!tab) throw new Error(`Could not find session tab containing ${text}`);
  tab.click();
  await waitFor(
    () => tab.getAttribute('data-active') === 'true',
    `${text} session tab becomes active`,
  );
  assertions.push(`${text} session tab becomes active`);
}

async function closeActiveSessionTab() {
  const activeTab = document.querySelector<HTMLElement>(
    '[data-testid="session-tab"][data-active="true"]',
  );
  if (!activeTab) throw new Error('Could not find active session tab to close');
  const closeButton = activeTab.querySelector<HTMLElement>(
    '[data-testid="close-session-tab-button"]',
  );
  if (!closeButton) throw new Error('Could not find active session tab close control');
  closeButton.click();
  await flushDom();
  if (queryByTestId('confirm-accept')) {
    await clickTestId('confirm-accept');
  }
  await flushDom();
}

async function expectCanvasPainted(canvas: HTMLCanvasElement, label: string) {
  await waitFor(() => canvasHasVisibleVariance(canvas), label);
  assertions.push(label);
}

async function expectDirtyPaintPreservesUntouchedRows(
  renderer: ReturnType<typeof createTerminalGpuRenderer>,
  canvas: HTMLCanvasElement,
  cols: number,
  rows: number,
) {
  const guardRow = rows - 1;
  renderer.paintFrame(makeSyntheticFrame(3000, { cols, rows }));
  await nextAnimationFrame();
  const before = canvasRowFingerprint(canvas, guardRow);

  renderer.paintFrame(
    makeSyntheticFrame(0, {
      cols,
      rows,
      dirtyOnly: true,
      dirtyRowsPerFrame: 1,
    }),
  );
  await nextAnimationFrame();

  const after = canvasRowFingerprint(canvas, guardRow);
  if (after !== before) {
    throw new Error(`dirty-row WebGL2 paint changed untouched row ${guardRow}`);
  }
  assertions.push('dirty-row WebGL2 paints preserve untouched rows');
}

interface RenderTimingSummary {
  frames: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  slowFrames: number;
}

async function measureRendererFrames(
  renderer: ReturnType<typeof createTerminalGpuRenderer>,
  frameAt: (index: number) => TerminalFrame,
) {
  const samples: number[] = [];
  for (let frameIndex = 0; frameIndex < 90; frameIndex += 1) {
    await nextAnimationFrame();
    const started = performance.now();
    renderer.paintFrame(frameAt(frameIndex));
    samples.push(performance.now() - started);
  }

  return summarizeRenderTimings(samples);
}

function summarizeRenderTimings(samples: number[]): RenderTimingSummary {
  return {
    frames: samples.length,
    avgMs: samples.reduce((sum, sample) => sum + sample, 0) / Math.max(1, samples.length),
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.max(0, ...samples),
    slowFrames: samples.filter(sample => sample > 16.7).length,
  };
}

function assertRendererBudget(
  summary: RenderTimingSummary,
  label: string,
  budget: { p95Ms: number; avgMs: number; slowFrames: number },
) {
  const message = `${label}: avg=${summary.avgMs.toFixed(2)}ms p95=${summary.p95Ms.toFixed(
    2,
  )}ms max=${summary.maxMs.toFixed(2)}ms slow=${summary.slowFrames}/${summary.frames}`;
  if (
    summary.p95Ms > budget.p95Ms ||
    summary.avgMs > budget.avgMs ||
    summary.slowFrames > budget.slowFrames
  ) {
    throw new Error(message);
  }
  assertions.push(message);
}

function canvasHasVisibleVariance(canvas: HTMLCanvasElement) {
  if (canvas.width <= 0 || canvas.height <= 0) return false;

  if (snapshotCanvasHasVisibleVariance(canvas)) return true;

  const gl = canvas.getContext('webgl2');
  if (gl) {
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.finish();
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return imageHasVisibleVariance(pixels);
  }

  const context = canvas.getContext('2d');
  if (!context) return false;
  try {
    return imageHasVisibleVariance(context.getImageData(0, 0, canvas.width, canvas.height).data);
  } catch {
    return false;
  }
}

function snapshotCanvasHasVisibleVariance(canvas: HTMLCanvasElement) {
  const snapshot = document.createElement('canvas');
  snapshot.width = canvas.width;
  snapshot.height = canvas.height;
  const context = snapshot.getContext('2d');
  if (!context) return false;
  try {
    context.drawImage(canvas, 0, 0);
    return imageHasVisibleVariance(
      context.getImageData(0, 0, snapshot.width, snapshot.height).data,
    );
  } catch {
    return false;
  }
}

function imageHasVisibleVariance(data: Uint8Array | Uint8ClampedArray) {
  if (data.length < 8) return false;
  const baseR = data[0] ?? 0;
  const baseG = data[1] ?? 0;
  const baseB = data[2] ?? 0;
  const baseA = data[3] ?? 0;

  for (let offset = 4; offset < data.length; offset += 16) {
    const alpha = data[offset + 3] ?? 0;
    if (alpha <= 0) continue;
    const delta =
      Math.abs((data[offset] ?? 0) - baseR) +
      Math.abs((data[offset + 1] ?? 0) - baseG) +
      Math.abs((data[offset + 2] ?? 0) - baseB) +
      Math.abs(alpha - baseA);
    if (delta > 12) return true;
  }
  return false;
}

async function nextAnimationFrame() {
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

async function expectTestId(testId: string, label: string) {
  await waitFor(() => Boolean(queryByTestId(testId)), label);
  assertions.push(label);
}

function expectAbsentTestId(testId: string, label: string) {
  if (queryByTestId(testId)) {
    throw new Error(`${label}: expected [${testId}] to be absent`);
  }
  assertions.push(label);
}

async function expectComposerMode(mode: 'project' | 'focus' | 'session') {
  await waitFor(
    () => queryByTestId('creation-composer')?.getAttribute('data-mode') === mode,
    `${mode} composer opens`,
  );
  assertions.push(`${mode} composer opens`);
}

function expectCliAvailability(kind: string, available: boolean, label: string) {
  const choice = requireSelector(selectorForCli(kind));
  if (choice.getAttribute('data-available') !== String(available)) {
    throw new Error(`${label}: expected data-available=${available}`);
  }
  assertions.push(label);
}

function expectDisabled(testIdOrSelector: string, disabled: boolean, label: string) {
  const element = testIdOrSelector.startsWith('[')
    ? requireSelector(testIdOrSelector)
    : requireTestId(testIdOrSelector);
  if (isDisabled(element) !== disabled) {
    throw new Error(`${label}: expected disabled=${disabled}`);
  }
  assertions.push(label);
}

function assertTextIncludes(testId: string, text: string, label: string) {
  const element = requireTestId(testId);
  if (!element.textContent?.includes(text)) {
    throw new Error(
      `${label}: expected [${testId}] to include ${JSON.stringify(text)}, got ${JSON.stringify(element.textContent ?? '')}`,
    );
  }
  assertions.push(label);
}

function assertInputValue(testId: string, value: string, label: string) {
  const input = requireTestId<HTMLInputElement>(testId);
  if (input.value !== value) {
    throw new Error(
      `${label}: expected [${testId}] value ${JSON.stringify(value)}, got ${JSON.stringify(input.value)}`,
    );
  }
  assertions.push(label);
}

async function waitForTextIncludes(testId: string, text: string, label: string) {
  await waitFor(() => queryByTestId(testId)?.textContent?.includes(text) ?? false, label);
  assertions.push(label);
}

async function waitForDocumentIncludes(text: string, label: string) {
  await waitFor(() => document.body.textContent?.includes(text) ?? false, label);
  assertions.push(label);
}

function assertDocumentIncludes(text: string, label: string) {
  if (!document.body.textContent?.includes(text)) {
    throw new Error(`${label}: document did not include ${JSON.stringify(text)}`);
  }
  assertions.push(label);
}

async function clickTestId(testId: string) {
  await waitFor(() => Boolean(queryByTestId(testId)), `click target ${testId} exists`);
  const element = requireTestId(testId);
  if (isDisabled(element)) throw new Error(`Cannot click disabled element: ${testId}`);
  (element as HTMLElement).click();
  await flushDom();
}

async function clickCliChoice(kind: string) {
  const selector = selectorForCli(kind);
  await waitFor(() => Boolean(document.querySelector(selector)), `CLI choice ${kind} exists`);
  const element = requireSelector(selector);
  if (isDisabled(element)) throw new Error(`Cannot click disabled CLI choice: ${kind}`);
  (element as HTMLElement).click();
  await flushDom();
}

function fillInput(testId: string, value: string) {
  const input = requireTestId<HTMLInputElement>(testId);
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(
    new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }),
  );
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 25));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await flushDom();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function flushDom() {
  await Promise.resolve();
  await new Promise<void>(resolve => window.setTimeout(resolve, 25));
}

function queryByTestId<T extends Element = HTMLElement>(testId: string): T | null {
  return document.querySelector(`[data-testid="${testId}"]`) as T | null;
}

function requireTestId<T extends Element = HTMLElement>(testId: string): T {
  const element = queryByTestId<T>(testId);
  if (!element) throw new Error(`Missing [data-testid=${testId}]`);
  return element;
}

function requireSelector<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector(selector) as T | null;
  if (!element) throw new Error(`Missing selector: ${selector}`);
  return element;
}

function selectorForCli(kind: string) {
  return `[data-testid="cli-choice"][data-cli-kind="${kind}"]`;
}

function isDisabled(element: Element) {
  return element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
    ? element.disabled
    : element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';
}

function publishHarnessResult(result: HarnessResult) {
  document.body.setAttribute('data-harness-smoke', result.status);
  document.body.setAttribute('data-harness-smoke-scenario', result.scenario);

  const existing = document.querySelector('#reverie-harness-smoke-result');
  existing?.remove();

  const output = document.createElement('pre');
  output.id = 'reverie-harness-smoke-result';
  output.textContent = JSON.stringify(result, null, 2);
  output.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;z-index:999999;max-height:45vh;margin:0;padding:12px;overflow:auto;background:#09090b;color:#f8fafc;font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;white-space:pre-wrap;';
  document.body.appendChild(output);
}
