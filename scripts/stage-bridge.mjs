#!/usr/bin/env node
// Stage the reverie-bridge helper binaries so they sit next to the desktop
// executable in dev AND inside the Tauri bundle in release.
//
// Why this exists: `reverie-bridge` / `reverie-bridge-preturn-hook` are members
// of the ROOT cargo workspace and build into <root>/target, while the desktop
// app is its own nested workspace and builds into apps/desktop/src-tauri/target.
// The agent CLIs (Claude Code, Codex, Cortex) are handed an absolute path to the
// helper and spawn it as a stdio MCP server, so the helper MUST exist on disk
// next to the desktop binary. We satisfy that invariant by copying the freshly
// built helpers into:
//   1. apps/desktop/src-tauri/binaries/<name>-<triple>
//      Tauri `externalBin` staging. The bundler copies + signs these into the
//      app's Contents/MacOS/ next to the main binary.
//   2. apps/desktop/src-tauri/target/<profile>/<name>
//      Next to the dev/run desktop binary, so `current_exe().parent()` resolves
//      the helper for `npm run dev` / `run:release` / a bare `cargo run`.
//
// Mirrors the libghostty-vt.dylib staging done in src-tauri/build.rs.

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function hostTriple() {
  try {
    return execFileSync('rustc', ['--print', 'host-tuple']).toString().trim();
  } catch {
    // Older rustc lacks `--print host-tuple`; fall back to parsing `-vV`.
    const verbose = execFileSync('rustc', ['-vV']).toString();
    const match = verbose.match(/^host:\s*(.+)$/m);
    if (!match) throw new Error('could not determine host target triple from rustc');
    return match[1].trim();
  }
}

const profile = flag('profile', 'debug'); // debug | release
const host = hostTriple();
const triple = flag('triple', host);

const BINS = ['reverie-bridge', 'reverie-bridge-preturn-hook'];

// Build the helper crate (produces both bins). When a non-host triple is
// requested, build for it so the artifact's arch matches the externalBin label.
const crossTriple = triple !== host ? triple : null;
const buildArgs = ['build', '-p', 'reverie-bridge'];
if (profile === 'release') buildArgs.push('--release');
if (crossTriple) buildArgs.push('--target', crossTriple);

console.log(`[stage-bridge] cargo ${buildArgs.join(' ')}`);
execFileSync('cargo', buildArgs, { cwd: root, stdio: 'inherit' });

const builtDir = crossTriple
  ? join(root, 'target', crossTriple, profile)
  : join(root, 'target', profile);

const binariesDir = join(root, 'apps/desktop/src-tauri/binaries');
const nextToExeDir = join(root, 'apps/desktop/src-tauri/target', profile);
mkdirSync(binariesDir, { recursive: true });
mkdirSync(nextToExeDir, { recursive: true });

for (const name of BINS) {
  const src = join(builtDir, name);
  if (!existsSync(src)) {
    throw new Error(`[stage-bridge] expected built binary missing: ${src}`);
  }
  // 1. externalBin staging (target-triple suffix) for the Tauri bundle.
  const bundleDest = join(binariesDir, `${name}-${triple}`);
  copyFileSync(src, bundleDest);
  chmodSync(bundleDest, 0o755);
  // 2. next to the dev/run desktop exe.
  const devDest = join(nextToExeDir, name);
  copyFileSync(src, devDest);
  chmodSync(devDest, 0o755);
  console.log(`[stage-bridge] staged ${name} (${triple}, ${profile})`);
}
