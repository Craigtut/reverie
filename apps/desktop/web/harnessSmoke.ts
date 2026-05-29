type HarnessScenario = 'empty-onboarding' | 'partial-cli' | 'no-cli';

type HarnessResult = {
  scenario: HarnessScenario;
  status: 'passed' | 'failed';
  assertions: string[];
  error?: string;
};

let harnessSmokeStarted = false;
const assertions: string[] = [];

export function maybeRunHarnessSmokeTest() {
  const scenario = new URLSearchParams(window.location.search).get('harnessSmoke') as HarnessScenario | null;
  if (!scenario || harnessSmokeStarted) return;

  harnessSmokeStarted = true;
  window.setTimeout(() => {
    runHarnessSmokeScenario(scenario).catch(error => {
      publishHarnessResult({
        scenario,
        status: 'failed',
        assertions: [...assertions],
        error: error instanceof Error ? error.stack ?? error.message : String(error),
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
  expectAllCliChoicesAvailable('onboarding-cli-choice', 3, 'onboarding CLI summary exposes all supported CLIs');

  await clickTestId('empty-create-project-button');
  await expectComposerMode('project');
  expectAbsentTestId('session-tabs', 'project creation hides session tabs');
  expectAbsentTestId('terminal-controls', 'project creation hides terminal controls');
  expectAbsentTestId('terminal-body', 'project creation hides the terminal body');
  expectDisabled('submit-project-button', true, 'project submit starts disabled until a folder is selected');
  await clickTestId('choose-project-folder-button');
  await waitFor(() => requireTestId('project-folder-selection').getAttribute('data-selected') === 'true', 'project folder picker records a selected folder');
  assertions.push('project folder picker records a selected folder');
  await waitFor(() => !isDisabled(requireTestId('submit-project-button')), 'project submit enables after folder selection');
  await clickTestId('submit-project-button');

  await expectComposerMode('focus');
  expectAbsentTestId('session-tabs', 'focus creation hides session tabs');
  expectAbsentTestId('terminal-controls', 'focus creation hides terminal controls');
  expectAbsentTestId('terminal-body', 'focus creation hides the terminal body');
  expectDisabled('submit-focus-button', true, 'focus submit starts disabled until a focus title is filled');
  fillInput('focus-title-input', 'Harness Smoke Focus');
  await waitFor(() => !isDisabled(requireTestId('submit-focus-button')), 'focus submit enables after title entry');
  await clickTestId('submit-focus-button');

  await expectComposerMode('session');
  expectAbsentTestId('session-tabs', 'session creation hides session tabs');
  expectAbsentTestId('terminal-controls', 'session creation hides terminal controls');
  expectAbsentTestId('terminal-body', 'session creation hides the previous terminal body');
  assertTextIncludes('cli-availability-summary', '3 of 3 detected', 'session composer reports all CLIs detected');
  assertInputValue('session-cwd-input', '/Users/user/Code/reverie', 'project-backed session inherits the selected project folder cwd');
  await clickCliChoice('codex_cli');
  expectCliSelected('codex_cli', 'Codex can be selected for a new session');
  assertTextIncludes('selected-cli-summary', 'Codex CLI is ready', 'selected CLI summary reassures that Codex is ready');
  fillInput('session-title-input', 'Harness Codex Session');
  await waitFor(() => !isDisabled(requireTestId('submit-session-button')), 'session submit enables after valid CLI and inherited cwd');
  await clickTestId('submit-session-button');

  await waitFor(() => !queryByTestId('creation-composer'), 'session creation closes the composer');
  await expectTestId('terminal-body', 'created session opens the terminal body');
  await waitForTextIncludes('terminal-status-label', 'Running', 'created Codex session starts its own terminal runtime');
  assertDocumentIncludes('Harness Smoke Focus', 'created focus is visible in the shell');
  assertTextIncludes('terminal-meta-strip', 'Harness Codex Session', 'created session title is visible in terminal metadata');
  const codexTerminalId = await waitForTerminalId('created Codex session receives its own terminal id');

  await clickTestId('create-session-button');
  await expectComposerMode('session');
  await clickCliChoice('claude_code');
  fillInput('session-title-input', 'Harness Claude Parallel Session');
  await waitFor(() => !isDisabled(requireTestId('submit-session-button')), 'second session submit enables with a different CLI');
  await clickTestId('submit-session-button');
  await waitForTextIncludes('terminal-meta-strip', 'Harness Claude Parallel Session', 'second session becomes the active terminal');
  const claudeTerminalId = await waitForTerminalId('created Claude session receives its own terminal id');
  if (claudeTerminalId === codexTerminalId) {
    throw new Error('session tabs share a terminal id; expected each session tab to own a distinct terminal process');
  }
  assertions.push('separate session tabs own distinct terminal ids');

  await clickSessionTabWithText('Codex');
  await waitFor(() => requireTestId('terminal-meta-strip').getAttribute('data-terminal-id') === codexTerminalId, 'clicking Codex tab reattaches its original terminal id');
  assertions.push('clicking Codex tab reattaches its original terminal id');
  await clickSessionTabWithText('Claude Parallel');
  await waitFor(() => requireTestId('terminal-meta-strip').getAttribute('data-terminal-id') === claudeTerminalId, 'clicking Claude tab reattaches its original terminal id');
  assertions.push('clicking Claude tab reattaches its original terminal id');

  await closeActiveSessionTab();
  await waitFor(() => ![...document.querySelectorAll('[data-testid="session-tab"]')].some(tab => tab.textContent?.includes('Claude Parallel')), 'closing a top tab hides it from active tabs');
  assertions.push('closing a top tab hides it from active tabs');
  await clickTestId('focus-session-history-button');
  await expectTestId('session-history-surface', 'focus history opens on the right stage');
  await waitFor(() => Boolean(document.querySelector('[data-testid="session-history-row"][data-tab-visible="false"]')), 'closed tab remains in focus session history');
  assertions.push('closed tab remains in focus session history');
  await clickTestId('restore-session-tab-button');
  await clickSessionTabWithText('Claude Parallel');
  await waitFor(() => {
    const restoredTerminalId = requireTestId('terminal-meta-strip').getAttribute('data-terminal-id') ?? '';
    return restoredTerminalId.length > 0 && restoredTerminalId !== claudeTerminalId;
  }, 'restored tab starts a fresh resumable terminal runtime');
  assertions.push('restored tab starts a fresh resumable terminal runtime');

  window.location.replace(`${window.location.origin}${window.location.pathname}?fixture=empty&harnessSmoke=empty-onboarding&harnessStage=assert-persisted`);
  await new Promise<void>(() => {});
}

async function runPartialCliScenario() {
  await expectTestId('onboarding-panel', 'empty partial-CLI fixture starts on onboarding');
  await clickTestId('empty-create-focus-button');
  await expectComposerMode('focus');
  fillInput('focus-title-input', 'Harness General Focus');
  await clickTestId('submit-focus-button');

  await expectComposerMode('session');
  assertInputValue('session-cwd-input', '/Users/user', 'general workspace session defaults to the home cwd');
  assertTextIncludes('cli-availability-summary', '2 of 3 detected', 'partial CLI fixture reports only available CLIs');
  expectCliAvailability('codex_cli', false, 'Codex is shown unavailable in the partial fixture');
  expectDisabled(selectorForCli('codex_cli'), true, 'unavailable Codex choice is disabled');
  await clickCliChoice('claude_code');
  expectCliSelected('claude_code', 'Claude can be selected when Codex is unavailable');
  assertTextIncludes('selected-cli-summary', 'Claude Code is ready', 'selected CLI summary updates to Claude');
  fillInput('session-title-input', 'Harness Claude Session');
  fillInput('session-cwd-input', '/Users/user');
  await waitFor(() => !isDisabled(requireTestId('submit-session-button')), 'partial fixture can create a session with an available CLI');
  await clickTestId('submit-session-button');

  await waitFor(() => !queryByTestId('creation-composer'), 'partial CLI session creation closes the composer');
  await waitForTextIncludes('terminal-status-label', 'Running', 'created Claude session starts its own terminal runtime');
  assertDocumentIncludes('Harness General Focus', 'General workspace focus is visible after creation');
  assertTextIncludes('terminal-meta-strip', 'Harness Claude Session', 'Claude session title is visible in terminal metadata');
}

async function runNoCliScenario() {
  await expectTestId('onboarding-panel', 'empty no-CLI fixture starts on onboarding');
  await clickTestId('empty-create-focus-button');
  await expectComposerMode('focus');
  fillInput('focus-title-input', 'Harness No CLI Focus');
  await clickTestId('submit-focus-button');

  await expectComposerMode('session');
  assertTextIncludes('cli-availability-summary', 'No supported CLIs detected', 'no-CLI fixture reports no supported CLIs');
  await expectTestId('cli-empty-help', 'no-CLI fixture explains that organization can continue without session creation');
  for (const kind of ['cortex_code', 'claude_code', 'codex_cli']) {
    expectCliAvailability(kind, false, `${kind} is unavailable in the no-CLI fixture`);
    expectDisabled(selectorForCli(kind), true, `${kind} choice is disabled in the no-CLI fixture`);
  }
  expectDisabled('submit-session-button', true, 'session creation stays disabled when no supported CLI is detected');
  assertDocumentIncludes('Harness No CLI Focus', 'focus creation still works when no CLI is detected');
}

async function runAssertPersistedScenario() {
  await waitFor(() => !queryByTestId('onboarding-panel'), 'persisted empty fixture does not return to onboarding');
  await waitForDocumentIncludes('reverie', 'folder-selected project persists across a browser reload');
  await waitForDocumentIncludes('Harness Smoke Focus', 'focus persists across a browser reload');
  await expectTestId('dashboard-surface', 'persisted workspace opens to the dashboard after reload');
  await waitFor(() => {
    const card = [...document.querySelectorAll<HTMLElement>('[data-testid="dashboard-session-card"]')]
      .find(candidate => candidate.textContent?.includes('Harness Codex Session'));
    if (!card) return false;
    card.click();
    return true;
  }, 'persisted Codex session is visible on the dashboard after reload');
  assertions.push('persisted Codex session is visible on the dashboard after reload');
  await expectTestId('terminal-body', 'persisted created session opens terminal body from dashboard after reload');
  await waitForTextIncludes('terminal-meta-strip', 'Harness Codex Session', 'session persists across a browser reload');
  await waitFor(() => {
    const activeTab = document.querySelector('[data-testid="session-tab"][data-active="true"]');
    return Boolean(activeTab?.textContent?.includes('Codex'));
  }, 'persisted Codex session tab becomes selected after dashboard open');
  assertions.push('persisted Codex session tab becomes selected after dashboard open');
}

async function waitForTerminalId(label: string) {
  let terminalId = '';
  await waitFor(() => {
    terminalId = requireTestId('terminal-meta-strip').getAttribute('data-terminal-id') ?? '';
    return terminalId.length > 0;
  }, label);
  assertions.push(label);
  return terminalId;
}

async function clickSessionTabWithText(text: string) {
  const tab = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="session-tab"]')]
    .find(candidate => candidate.textContent?.includes(text));
  if (!tab) throw new Error(`Could not find session tab containing ${text}`);
  tab.click();
  await waitFor(() => tab.getAttribute('data-active') === 'true', `${text} session tab becomes active`);
  assertions.push(`${text} session tab becomes active`);
}

async function closeActiveSessionTab() {
  const activeTab = document.querySelector<HTMLElement>('[data-testid="session-tab"][data-active="true"]');
  if (!activeTab) throw new Error('Could not find active session tab to close');
  const closeButton = activeTab.querySelector<HTMLElement>('[data-testid="close-session-tab-button"]');
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
  await waitFor(() => queryByTestId('creation-composer')?.getAttribute('data-mode') === mode, `${mode} composer opens`);
  assertions.push(`${mode} composer opens`);
}

function expectAllCliChoicesAvailable(testId: string, count: number, label: string) {
  const choices = [...document.querySelectorAll(`[data-testid="${testId}"]`)];
  if (choices.length !== count) {
    throw new Error(`${label}: expected ${count} choices, found ${choices.length}`);
  }
  for (const choice of choices) {
    if (choice.getAttribute('data-available') !== 'true') {
      throw new Error(`${label}: expected every choice to be available`);
    }
  }
  assertions.push(label);
}

function expectCliAvailability(kind: string, available: boolean, label: string) {
  const choice = requireSelector(selectorForCli(kind));
  if (choice.getAttribute('data-available') !== String(available)) {
    throw new Error(`${label}: expected data-available=${available}`);
  }
  assertions.push(label);
}

function expectCliSelected(kind: string, label: string) {
  const choice = requireSelector(selectorForCli(kind));
  if (choice.getAttribute('data-selected') !== 'true') {
    throw new Error(`${label}: expected ${kind} to be selected`);
  }
  assertions.push(label);
}

function expectDisabled(testIdOrSelector: string, disabled: boolean, label: string) {
  const element = testIdOrSelector.startsWith('[') ? requireSelector(testIdOrSelector) : requireTestId(testIdOrSelector);
  if (isDisabled(element) !== disabled) {
    throw new Error(`${label}: expected disabled=${disabled}`);
  }
  assertions.push(label);
}

function assertTextIncludes(testId: string, text: string, label: string) {
  const element = requireTestId(testId);
  if (!element.textContent?.includes(text)) {
    throw new Error(`${label}: expected [${testId}] to include ${JSON.stringify(text)}, got ${JSON.stringify(element.textContent ?? '')}`);
  }
  assertions.push(label);
}

function assertInputValue(testId: string, value: string, label: string) {
  const input = requireTestId<HTMLInputElement>(testId);
  if (input.value !== value) {
    throw new Error(`${label}: expected [${testId}] value ${JSON.stringify(value)}, got ${JSON.stringify(input.value)}`);
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
  input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
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
  return element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement
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
  output.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:999999;max-height:45vh;margin:0;padding:12px;overflow:auto;background:#09090b;color:#f8fafc;font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;white-space:pre-wrap;';
  document.body.appendChild(output);
}
