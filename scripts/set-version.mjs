#!/usr/bin/env node
// set-version.mjs — set the app version in every manifest that declares it, in
// one step, so package.json, the Tauri config, and the Rust crates never drift.
//
//   node scripts/set-version.mjs 0.2.0     # set an explicit version
//   node scripts/set-version.mjs patch     # bump x.y.Z from package.json
//   node scripts/set-version.mjs minor     # bump x.Y.0
//   node scripts/set-version.mjs major     # bump X.0.0
//
// package.json is the source of truth for the current version when bumping.
// Cargo.lock is intentionally not edited here: the next `cargo build`/`check`
// refreshes it (the crates are path deps, so no network is involved).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Every file that pins the app version. `kind` selects the editor: JSON files
// get their top-level "version" key set; Cargo files get the [package] version.
const TARGETS = [
  { path: 'package.json', kind: 'json' },
  { path: 'package-lock.json', kind: 'npm-lock' },
  { path: 'apps/desktop/src-tauri/tauri.conf.json', kind: 'json' },
  { path: 'apps/desktop/src-tauri/Cargo.toml', kind: 'cargo' },
  { path: 'packages/reverie-core/Cargo.toml', kind: 'cargo' },
  { path: 'packages/reverie-persistence/Cargo.toml', kind: 'cargo' },
  { path: 'packages/reverie-speech/Cargo.toml', kind: 'cargo' },
  { path: 'apps/reverie-bridge/Cargo.toml', kind: 'cargo' },
];

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function currentVersion() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  return pkg.version;
}

function bump(version, kind) {
  const core = version.split(/[-+]/)[0];
  const parts = core.split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`current version "${version}" is not plain x.y.z, pass an explicit version`);
  }
  const [major, minor, patch] = parts;
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function resolveTarget(arg) {
  if (arg === 'patch' || arg === 'minor' || arg === 'major') {
    return bump(currentVersion(), arg);
  }
  if (SEMVER.test(arg)) return arg;
  throw new Error(`"${arg}" is neither a semver nor patch|minor|major`);
}

// Top-level "version" is the first such key in both JSON files (it precedes any
// dependency block), and dependencies are keyed by package name, not "version",
// so a first-match replace is safe and preserves all hand formatting.
function setJsonVersion(content, version) {
  const re = /^(\s*"version"\s*:\s*)"[^"]*"/m;
  if (!re.test(content)) throw new Error('no top-level "version" key found');
  return content.replace(re, `$1"${version}"`);
}

// package-lock.json pins the root version twice: the top-level "version" and
// the root package entry packages[""].version. It also carries a "version" for
// every dependency, so the first-match/global string edits used elsewhere are
// unsafe here. Parse, set just those two fields, and reserialize with npm's
// formatting (2-space indent + trailing newline) so the diff stays to the two
// lines and the lockfile stays in sync with package.json (or `npm ci` fails).
function setNpmLockVersion(content, version) {
  const lock = JSON.parse(content);
  lock.version = version;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = version;
  }
  return `${JSON.stringify(lock, null, 2)}\n`;
}

// Replace only the version inside the [package] section, never a dependency's
// version = "..." pin elsewhere in the file.
function setCargoVersion(content, version) {
  const lines = content.split('\n');
  let inPackage = false;
  let done = false;
  for (let i = 0; i < lines.length; i++) {
    const section = lines[i].match(/^\s*\[([^\]]+)\]/);
    if (section) {
      inPackage = section[1].trim() === 'package';
      continue;
    }
    if (inPackage && !done) {
      const m = lines[i].match(/^(\s*version\s*=\s*)"[^"]*"(.*)$/);
      if (m) {
        lines[i] = `${m[1]}"${version}"${m[2]}`;
        done = true;
      }
    }
  }
  if (!done) throw new Error('no [package] version found');
  return lines.join('\n');
}

const arg = process.argv[2];
if (!arg) {
  console.error('set-version: usage: set-version.mjs <x.y.z | patch | minor | major>');
  process.exit(2);
}

let version;
try {
  version = resolveTarget(arg);
} catch (err) {
  console.error(`set-version: ${err.message}`);
  process.exit(1);
}

const from = currentVersion();
for (const { path, kind } of TARGETS) {
  const full = join(repoRoot, path);
  const before = readFileSync(full, 'utf8');
  const after =
    kind === 'json'
      ? setJsonVersion(before, version)
      : kind === 'npm-lock'
        ? setNpmLockVersion(before, version)
        : setCargoVersion(before, version);
  writeFileSync(full, after);
  console.log(`  ${path}`);
}

console.log(`\nset-version: ${from} -> ${version} across ${TARGETS.length} manifests.`);
console.log('Next: run `npm run check` (refreshes Cargo.lock) and update CHANGELOG.md.');
