#!/usr/bin/env node
// reset-dev-data.mjs — wipe the dev channel's stored data (the Reverie database,
// General scratch workspaces, diagnostics) so a botched migration or a stale
// schema can be cleared in one step.
//
// This targets ONLY the dev bundle's Application Support folder. The `.dev`
// suffix is hardcoded and the path is asserted to contain it before any delete,
// so this can never touch the production install's data.
//
//   node scripts/reset-dev-data.mjs          # delete after confirming the path
//   node scripts/reset-dev-data.mjs --yes    # skip the prompt (for scripts/CI)

import { rmSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const DEV_IDENTIFIER = 'com.animus.reverie.dev';
const target = join(homedir(), 'Library', 'Application Support', DEV_IDENTIFIER);

// Safety rail: never proceed unless the resolved path is the dev folder.
if (!target.endsWith(`${DEV_IDENTIFIER}`) || !target.includes('.dev')) {
  console.error(`reset-dev-data: refusing to delete a non-dev path: ${target}`);
  process.exit(1);
}

if (!existsSync(target)) {
  console.log(`reset-dev-data: nothing to do, ${target} does not exist.`);
  process.exit(0);
}

const skipPrompt = process.argv.includes('--yes') || process.argv.includes('-y');

async function confirm() {
  if (skipPrompt) return true;
  const sizeNote = statSync(target).isDirectory() ? '(directory)' : '';
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(
    `This deletes the DEV data folder:\n  ${target} ${sizeNote}\nProduction data is untouched. Continue? [y/N] `,
  );
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

if (!(await confirm())) {
  console.log('reset-dev-data: aborted, nothing deleted.');
  process.exit(0);
}

rmSync(target, { recursive: true, force: true });
console.log(`reset-dev-data: removed ${target}`);
