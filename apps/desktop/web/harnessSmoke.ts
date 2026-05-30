type HarnessScenario = 'empty-onboarding' | 'partial-cli' | 'no-cli' | 'terminal-interaction';

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
    default:
      throw new Error(`Unknown harness smoke scenario: ${scenario}`);
  }

  publishHarnessResult({ scenario, status: 'passed', assertions: [...assertions] });
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
  recordedInputs(): Array<{ terminalId: string; input: string }>;
}

function fixtureHook(): FixtureHook {
  const hook = (window as unknown as { __REVERIE_FIXTURE__?: FixtureHook }).__REVERIE_FIXTURE__;
  if (!hook) throw new Error('fixture test hook (__REVERIE_FIXTURE__) is not present');
  return hook;
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
  fixture.emitTerminalFrame(terminalId, ['hello https://reverie.test/docs world']);
  await flushDom();
  const viewport = requireTestId('terminal-viewport');
  viewport.scrollTop = 0;
  viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
  await flushDom();

  const canvas = requireTestId<HTMLCanvasElement>('terminal-canvas');
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
