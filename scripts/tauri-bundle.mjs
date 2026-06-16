#!/usr/bin/env node
// Build the production Tauri bundle from the repo root.
//
// Tauri requires TAURI_SIGNING_PRIVATE_KEY whenever updater artifacts are
// enabled and a public updater key is present in tauri.conf.json. For local
// install smoke tests, a developer often only needs the .app and .dmg, not the
// updater tarball. In that case this wrapper disables updater artifact creation
// for this invocation only. CI uses the release workflow, which fails fast when
// the signing secrets are absent.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcTauri = join(root, 'apps/desktop/src-tauri');
const runWithZig = join(root, 'scripts/run-with-zig.mjs');

const requireUpdaterSignature = process.env.REVERIE_REQUIRE_UPDATER_SIGNATURE === '1';
const hasUpdaterPrivateKey = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY?.trim());

if (requireUpdaterSignature && !hasUpdaterPrivateKey) {
  console.error(
    'bundle:updater requires TAURI_SIGNING_PRIVATE_KEY because updater artifacts are signed.',
  );
  process.exit(1);
}

const args = [runWithZig, 'npx', 'tauri', 'build'];

if (!hasUpdaterPrivateKey) {
  console.warn(
    '[bundle] TAURI_SIGNING_PRIVATE_KEY is not set. Building app and DMG only; updater artifacts are disabled for this local bundle.',
  );
  args.push('--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
}

const result = spawnSync(process.execPath, args, {
  cwd: srcTauri,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`bundle: failed to launch tauri build: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 0);
