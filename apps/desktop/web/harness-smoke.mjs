import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const ROOT_URL = process.env.REVERIE_HARNESS_URL ?? 'http://127.0.0.1:1421';
const SERVER_TIMEOUT_MS = 20_000;
const CHROME_TIMEOUT_MS = 30_000;
const CHROME_POLL_MS = 100;

const allScenarios = [
  {
    name: 'empty-onboarding',
    query: 'fixture=empty&resetFixture=1&harnessSmoke=empty-onboarding',
    profileGroup: 'persisted-empty',
  },
  {
    name: 'partial-cli',
    query: 'fixture=empty&cli=partial&resetFixture=1&harnessSmoke=partial-cli',
    profileGroup: 'partial-cli',
  },
  {
    name: 'no-cli',
    query: 'fixture=empty&cli=none&resetFixture=1&harnessSmoke=no-cli',
    profileGroup: 'no-cli',
  },
  {
    name: 'terminal-interaction',
    query: 'fixture=empty&resetFixture=1&harnessSmoke=terminal-interaction',
    profileGroup: 'terminal-interaction',
  },
  {
    name: 'terminal-concurrent-sessions',
    query: 'fixture=empty&resetFixture=1&harnessSmoke=terminal-concurrent-sessions',
    profileGroup: 'terminal-concurrent-sessions',
  },
  {
    name: 'terminal-alternate-screen',
    query: 'fixture=empty&resetFixture=1&harnessSmoke=terminal-alternate-screen',
    profileGroup: 'terminal-alternate-screen',
  },
  {
    name: 'terminal-resize-storm',
    query: 'fixture=empty&resetFixture=1&harnessSmoke=terminal-resize-storm',
    profileGroup: 'terminal-resize-storm',
    useGpu: true,
  },
  {
    name: 'terminal-render-performance',
    query: 'fixture=empty&resetFixture=1&harnessSmoke=terminal-render-performance',
    profileGroup: 'terminal-render-performance',
    useGpu: true,
  },
];
const scenarioFilter = process.env.REVERIE_HARNESS_SCENARIO;
const scenarios = scenarioFilter
  ? allScenarios.filter(scenario => scenario.name === scenarioFilter)
  : allScenarios;
if (scenarioFilter && scenarios.length === 0) {
  throw new Error(`Unknown harness scenario filter: ${scenarioFilter}`);
}

const chrome = resolveChromeCommand();
const spawnedServer = await ensureHarnessServer();
const profileDirs = new Map();

try {
  for (const scenario of scenarios) {
    const profileDir = await profileDirFor(scenario.profileGroup);
    const url = `${ROOT_URL}/?${scenario.query}`;
    await runChromeScenario({ ...scenario, url, profileDir });
  }
  console.log(`Harness smoke passed: ${scenarios.map(scenario => scenario.name).join(', ')}`);
} finally {
  if (spawnedServer) {
    spawnedServer.kill('SIGTERM');
  }
  for (const dir of profileDirs.values()) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function profileDirFor(group) {
  const existing = profileDirs.get(group);
  if (existing) return existing;

  const dir = await mkdtemp(path.join(tmpdir(), `reverie-${group}-`));
  profileDirs.set(group, dir);
  return dir;
}

async function ensureHarnessServer() {
  if (await canReachHarness()) return null;

  const harnessUrl = new URL(ROOT_URL);
  const viteBin = path.join(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(
    process.execPath,
    [viteBin, '--host', harnessUrl.hostname, '--port', harnessUrl.port || '1421', '--strictPort'],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', chunk => process.stdout.write(chunk));
  child.stderr.on('data', chunk => process.stderr.write(chunk));

  const started = Date.now();
  while (Date.now() - started < SERVER_TIMEOUT_MS) {
    if (child.exitCode !== null) {
      throw new Error(
        `Harness dev server exited before it became reachable with code ${child.exitCode}`,
      );
    }
    if (await canReachHarness()) return child;
    await delay(250);
  }

  child.kill('SIGTERM');
  throw new Error(`Timed out waiting for harness dev server at ${ROOT_URL}`);
}

async function canReachHarness() {
  try {
    const response = await fetch(ROOT_URL, { signal: AbortSignal.timeout(750) });
    return response.ok;
  } catch {
    return false;
  }
}

async function runChromeScenario({ name, url, profileDir, useGpu = false }) {
  const debugPort = await reservePort();
  const args = [
    '--headless=new',
    '--no-sandbox',
    ...(useGpu ? [] : ['--disable-gpu']),
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--disable-component-update',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--run-all-compositor-stages-before-draw',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    url,
  ];

  const child = spawn(chrome.command, [...chrome.args, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });

  try {
    const result = await waitForHarnessResult({
      debugPort,
      url,
      child,
      name,
      stderrForError,
    });
    if (result.status !== 'passed') {
      throw new Error(
        `Harness smoke scenario failed: ${name}\n${result.text}\n${stderrForError()}`,
      );
    }
    printScenarioDetails(name, result.text);
  } finally {
    await stopProcess(child);
  }

  console.log(`✓ ${name}`);

  function stderrForError() {
    return stderr.slice(-3000);
  }
}

function printScenarioDetails(name, text) {
  if (name !== 'terminal-render-performance') return;
  try {
    const result = JSON.parse(text);
    for (const assertion of result.assertions ?? []) {
      if (typeof assertion === 'string' && assertion.includes('WebGL2')) {
        console.log(`  ${assertion}`);
      }
    }
  } catch {
    // The pass/fail result is already handled by the caller.
  }
}

async function waitForPageWebSocket(debugPort, url, child, stderrForError) {
  const started = Date.now();
  while (Date.now() - started < CHROME_TIMEOUT_MS) {
    if (child.exitCode !== null) {
      throw new Error(
        `Chrome exited before DevTools was reachable for ${url}\n${stderrForError()}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
        signal: AbortSignal.timeout(750),
      });
      const targets = await response.json();
      const page =
        targets.find(target => target.type === 'page' && target.url === url) ??
        targets.find(target => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still booting.
    }
    await delay(CHROME_POLL_MS);
  }

  throw new Error(`Timed out waiting for Chrome DevTools target for ${url}\n${stderrForError()}`);
}

async function waitForHarnessResult({ debugPort, url, child, name, stderrForError }) {
  let cdp = null;
  try {
    const started = Date.now();
    while (Date.now() - started < CHROME_TIMEOUT_MS) {
      try {
        if (!cdp) {
          const pageWsUrl = await waitForPageWebSocket(debugPort, url, child, stderrForError);
          cdp = await connectCdp(pageWsUrl);
          await cdp.send('Runtime.enable');
        }
        const value = await cdp.evaluate(`
          (() => {
            const marker = document.querySelector('#reverie-harness-smoke-result');
            if (!marker) return null;
            return {
              status: document.body.getAttribute('data-harness-smoke'),
              text: marker.textContent || ''
            };
          })()
        `);
        if (value) return value;
      } catch (error) {
        if (!isRecoverableCdpError(error)) throw error;
        cdp?.close();
        cdp = null;
      }
      await delay(CHROME_POLL_MS);
    }

    const bodyText = cdp
      ? await cdp
          .evaluate(`(() => document.body ? document.body.textContent.slice(0, 3000) : '')()`)
          .catch(() => '')
      : '';
    throw new Error(`Timed out waiting for harness smoke result: ${name}\n${bodyText}`);
  } finally {
    cdp?.close();
  }
}

function isRecoverableCdpError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Inspected target navigated or closed') ||
    message.includes('Execution context was destroyed') ||
    message.includes('Cannot find context with specified id') ||
    message.includes('CDP socket closed') ||
    message.includes('WebSocket is not open')
  );
}

function connectCdp(pageWsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(pageWsUrl);
    const pending = new Map();
    let nextId = 0;
    let opened = false;

    socket.addEventListener('open', () => {
      opened = true;
      resolve({
        send(method, params = {}) {
          if (socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('CDP socket closed'));
          }
          const id = ++nextId;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((resolveMessage, rejectMessage) => {
            pending.set(id, { resolve: resolveMessage, reject: rejectMessage });
          });
        },
        async evaluate(expression) {
          const result = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
          });
          if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.text ?? 'Runtime.evaluate failed');
          }
          return result.result?.value ?? null;
        },
        close() {
          socket.close();
        },
      });
    });

    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data.toString());
      const pendingMessage = pending.get(message.id);
      if (!pendingMessage) return;
      pending.delete(message.id);
      if (message.error) pendingMessage.reject(new Error(message.error.message));
      else pendingMessage.resolve(message.result);
    });

    socket.addEventListener('error', error => {
      if (!opened) reject(error);
      for (const pendingMessage of pending.values()) pendingMessage.reject(error);
      pending.clear();
    });

    socket.addEventListener('close', () => {
      const error = new Error('CDP socket closed');
      if (!opened) reject(error);
      for (const pendingMessage of pending.values()) pendingMessage.reject(error);
      pending.clear();
    });
  });
}

function resolveChromeCommand() {
  const chromePath = resolveChromePath();
  if (
    process.platform === 'darwin' &&
    process.arch === 'arm64' &&
    chromePath.startsWith('/Applications/') &&
    existsSync('/usr/bin/arch')
  ) {
    return { command: '/usr/bin/arch', args: ['-arm64', chromePath] };
  }
  return { command: chromePath, args: [] };
}

function resolveChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean);

  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) {
    throw new Error(
      'Unable to find a local Chromium browser. Set CHROME_PATH to run Reverie harness smoke tests.',
    );
  }
  return found;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address) resolve(address.port);
        else reject(new Error('Could not reserve a local debug port'));
      });
    });
  });
}

function stopProcess(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve();
    }, 500);
    child.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
