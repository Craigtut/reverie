#!/usr/bin/env node
// changelog-extract.mjs — print the CHANGELOG.md notes for one version, so CI can
// use CHANGELOG.md as the single source of truth for GitHub Release bodies. The
// release workflow runs this for the pushed tag and passes the output to
// tauri-action's releaseBody; nothing is hand-copied into the GitHub Release.
//
//   node scripts/changelog-extract.mjs 0.2.0     # prints the ## [0.2.0] section
//   node scripts/changelog-extract.mjs v0.2.0    # leading v is accepted/stripped
//
// Exits non-zero if the version has no section (or an empty one), so a release
// with a missing changelog entry fails loudly instead of publishing empty notes.
// This is the forcing function that keeps the changelog updated before tagging.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const raw = process.argv[2];
if (!raw) {
  console.error('changelog-extract: usage: changelog-extract.mjs <version>');
  process.exit(2);
}
// Accept either "v0.2.0" or "0.2.0".
const version = raw.replace(/^v/, '');

const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
const lines = changelog.split('\n');

// Any version heading: "## [0.2.0] - 2026-06-13" (the date is optional).
const anyHeadingRe = /^##\s+\[[^\]]+\]/;
// The reference-link footer at the bottom: "[0.2.0]: https://github.com/...".
const refLinkRe = /^\[[^\]]+\]:\s+https?:\/\//;
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const targetRe = new RegExp(`^##\\s+\\[${escaped}\\]`);

let start = -1;
for (let i = 0; i < lines.length; i++) {
  if (targetRe.test(lines[i])) {
    start = i;
    break;
  }
}
if (start === -1) {
  console.error(`changelog-extract: no "## [${version}]" section in CHANGELOG.md`);
  process.exit(1);
}

// The body runs from just after the heading until the next version heading or
// the reference-link footer, whichever comes first.
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (anyHeadingRe.test(lines[i]) || refLinkRe.test(lines[i])) {
    end = i;
    break;
  }
}

const body = lines
  .slice(start + 1, end)
  .join('\n')
  .trim();
if (!body) {
  console.error(`changelog-extract: the "## [${version}]" section is empty`);
  process.exit(1);
}
process.stdout.write(`${body}\n`);
