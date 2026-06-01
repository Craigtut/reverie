#!/usr/bin/env node
// run-with-zig.mjs — ensure a Zig 0.15.x toolchain is on PATH, then exec the
// command passed as arguments (e.g. `node scripts/run-with-zig.mjs cargo build`).
//
// Reverie's terminal core links `libghostty-vt`, which is built with Zig and
// pins the 0.15 series. The default `zig` on a developer's machine is often a
// different version (0.16+), so we cannot simply trust whatever is on PATH —
// doing so links against the wrong compiler and fails deep in the build with a
// confusing error. This script resolves a *0.15.x* toolchain explicitly:
//
//   1. The Homebrew `zig@0.15` keg, located via `brew --prefix zig@0.15`. This
//      works on any Homebrew prefix (Apple Silicon `/opt/homebrew` or Intel
//      `/usr/local`), so it is the portable local-dev path. Used only if its
//      zig actually reports 0.15.x.
//   2. A `zig` already on PATH that reports 0.15.x — covers CI (setup-zig pins
//      the version but installs no brew formula) and devs whose default is 0.15.
//   3. Otherwise: fail with install guidance instead of guessing.
//
// This replaces a hardcoded `/opt/homebrew/opt/zig@0.15/bin` PATH prefix that
// was duplicated across the npm scripts and assumed one machine's layout.
//
// macOS Apple Silicon is Reverie's only build *target*, but the build *host*
// can be any Mac, which is exactly why the Homebrew prefix must be discovered
// rather than hardcoded.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';

const REQUIRED_SERIES = '0.15';

// `zig version` prints just the version (e.g. "0.15.1"); null if zig is missing
// or errors. We look it up by explicit path so we can probe a specific install.
function zigVersion(zigBinary) {
  const res = spawnSync(zigBinary, ['version'], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout) return null;
  return res.stdout.trim();
}

// The `bin` dir of the Homebrew zig@0.15 keg, or null if Homebrew or the keg is
// absent. `brew --prefix` may return a path for an uninstalled formula, so we
// confirm the binary actually exists rather than trusting the path alone.
function brewKegBin() {
  const res = spawnSync('brew', ['--prefix', 'zig@0.15'], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout) return null;
  const bin = join(res.stdout.trim(), 'bin');
  return existsSync(join(bin, 'zig')) ? bin : null;
}

// Returns the bin dir to prepend to PATH, or '' if a suitable zig is already on
// PATH (no change needed), or null if no 0.15.x toolchain can be found.
function resolveZigBin() {
  const keg = brewKegBin();
  if (keg && zigVersion(join(keg, 'zig'))?.startsWith(REQUIRED_SERIES)) {
    return keg;
  }
  if (zigVersion('zig')?.startsWith(REQUIRED_SERIES)) {
    return '';
  }
  return null;
}

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error('run-with-zig: no command given (usage: run-with-zig.mjs <cmd> [args...])');
  process.exit(2);
}

const binDir = resolveZigBin();
if (binDir === null) {
  const found = zigVersion('zig');
  console.error(
    `\nReverie's terminal core links libghostty-vt and requires Zig ${REQUIRED_SERIES}.x.\n` +
      `Found: ${found ? `zig ${found} on PATH` : 'no zig on PATH'}.\n` +
      `Fix it with:  brew install zig@0.15\n` +
      `(or put a Zig ${REQUIRED_SERIES}.x toolchain on your PATH).\n`,
  );
  process.exit(1);
}

const env = { ...process.env };
if (binDir) env.PATH = `${binDir}${delimiter}${env.PATH ?? ''}`;

const [cmd, ...rest] = command;
const result = spawnSync(cmd, rest, { stdio: 'inherit', env });
if (result.error) {
  console.error(`run-with-zig: failed to launch ${cmd}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 0);
