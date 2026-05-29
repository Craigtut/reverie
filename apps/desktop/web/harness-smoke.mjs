import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT_URL = process.env.REVERIE_HARNESS_URL ?? 'http://127.0.0.1:1421';
const SERVER_TIMEOUT_MS = 20_000;
const CHROME_TIMEOUT_MS = 30_000;

const scenarios = [
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
];

const chromePath = resolveChromePath();
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

async function runChromeScenario({ name, url, profileDir }) {
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--disable-component-update',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=12000',
    `--user-data-dir=${profileDir}`,
    '--dump-dom',
    url,
  ];

  const { stdout, stderr, code } = await runProcessUntil(
    chromePath,
    args,
    CHROME_TIMEOUT_MS,
    output => output.includes('id="reverie-harness-smoke-result"'),
  );
  if (code !== 0 && !stdout.includes('id="reverie-harness-smoke-result"')) {
    throw new Error(`Chrome exited with code ${code} for ${name}\n${stderr}`);
  }

  if (
    !stdout.includes('id="reverie-harness-smoke-result"') ||
    !stdout.includes('data-harness-smoke="passed"')
  ) {
    const resultSnippet = extractResultSnippet(stdout);
    throw new Error(
      `Harness smoke scenario failed: ${name}\n${resultSnippet || stdout.slice(-3000)}\n${stderr}`,
    );
  }

  console.log(`✓ ${name}`);
}

function runProcessUntil(command, args, timeoutMs, isDone) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      resolve({ stdout, stderr, code });
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new Error(
          `Timed out running ${command}\n${extractResultSnippet(stdout) || stdout.slice(-3000)}\n${stderr}`,
        ),
      );
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (isDone(stdout)) finish(0);
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      finish(code ?? 0);
    });
  });
}

function extractResultSnippet(dom) {
  const marker = 'reverie-harness-smoke-result';
  const index = dom.indexOf(marker);
  if (index === -1) return '';
  return dom.slice(Math.max(0, index - 500), Math.min(dom.length, index + 2500));
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
