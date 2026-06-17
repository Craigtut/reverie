#!/usr/bin/env node
// tauri-channel.mjs: pick the build/run channel for the desktop app, then exec
// the rest of the command with that channel's config layered in.
//
//   node scripts/tauri-channel.mjs <channel> <cmd> [args...]
//     <channel> = dev | prod
//
// Reverie ships one app from one base config (tauri.conf.json = production). To
// keep a `npm run dev` build from co-mingling its data, icon, and Dock identity
// with a real install, the `dev` channel merges tauri.dev.conf.json over the
// base config. That overlay changes the bundle identifier to
// `com.muselab.reverie.dev`, which is what macOS namespaces Application Support,
// Caches, and Preferences by, so `app_data_dir()` (the Reverie database) moves
// to a separate folder with zero Rust changes.
//
// The merge uses TAURI_CONFIG, a JSON string that `tauri-build` reads at compile
// time and merge-patches (RFC 7396) over the file config. This is the same
// mechanism the Tauri CLI's `--config` flag uses, but it works through a plain
// `cargo run` (our dev path) without routing through the Tauri CLI. tauri-build
// emits `rerun-if-env-changed=TAURI_CONFIG`, so switching channels recompiles
// the embedded context. Dev runs the debug profile and prod the release profile,
// so their build artifacts never thrash each other.
//
// `prod` is a pass-through: no overlay, base config = production identity. This
// is deliberate so a local `npm run build` produces a real production app you
// can install and test, while only `npm run dev` carries the dev identity.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_CONFIG = join(repoRoot, 'apps/desktop/src-tauri/tauri.dev.conf.json');

const [channel, ...command] = process.argv.slice(2);

if (!channel || command.length === 0) {
  console.error('tauri-channel: usage: tauri-channel.mjs <dev|prod> <cmd> [args...]');
  process.exit(2);
}

const env = { ...process.env };

if (channel === 'dev') {
  // Pass the overlay as a JSON string (not a path): tauri-build expects the
  // value of TAURI_CONFIG to be the config itself. Parse first so a malformed
  // overlay fails loudly here rather than deep in the Rust build.
  let raw;
  try {
    raw = readFileSync(DEV_CONFIG, 'utf8');
    JSON.parse(raw);
  } catch (err) {
    console.error(`tauri-channel: cannot read dev overlay ${DEV_CONFIG}: ${err.message}`);
    process.exit(1);
  }
  env.TAURI_CONFIG = raw;
} else if (channel !== 'prod') {
  console.error(`tauri-channel: unknown channel "${channel}" (expected dev or prod)`);
  process.exit(2);
}

const [cmd, ...rest] = command;
const result = spawnSync(cmd, rest, { stdio: 'inherit', env });
if (result.error) {
  console.error(`tauri-channel: failed to launch ${cmd}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 0);
