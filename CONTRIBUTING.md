# Contributing to Reverie

Thanks for your interest in Reverie. This guide covers how to set up the
project, the checks we keep green, and the conventions we follow. Please also
read [`CLAUDE.md`](CLAUDE.md), which is the source of truth for how to operate
in this repository, and the docs it points to in [`docs/`](docs/README.md).

## Code of conduct

Be respectful and constructive. Harassment, personal attacks, and abusive
behavior are not welcome in issues, pull requests, or any project space.

## Prerequisites

Reverie is a hybrid Rust + TypeScript desktop app built with Tauri v2.

- **Node.js 20+** and npm.
- **Rust** (edition 2024, toolchain `1.93` or newer), with `rustfmt` and
  `clippy` components.
- **Zig `0.15.x`** on your `PATH`. This is required for any build that links
  `libghostty-vt` (the terminal core). On macOS the npm scripts prepend the
  Homebrew `zig@0.15` keg path (`/opt/homebrew/opt/zig@0.15/bin`) when present.
  If a build fails on the Ghostty link step, a missing or wrong Zig version is
  the usual cause.

Builds that link Ghostty also need `DYLD_LIBRARY_PATH` pointed at the generated
`libghostty-vt.dylib`. The `npm run dev:desktop` / `npm run run:release`
scripts handle this for you, so prefer them over raw `cargo run`.

## Getting started

```bash
npm install            # installs deps and sets up Husky git hooks
npm run dev            # run the desktop app (Panda watch + Vite + Tauri)
npm run dev:harness    # browser-only React harness with fixture services
```

On macOS, desktop WebDriver cannot drive WKWebView, so use `npm run dev:harness`
for UI iteration and screenshots. Rust/Tauri tests remain the source of truth
for persistence, commands, CLI detection, and native session launch.

## Checks to keep green

Run the full check suite before opening a pull request:

```bash
npm run check          # frontend lint/typecheck/build + Rust tests/checks
```

Or run the pieces individually:

```bash
npm run lint           # Biome (lint + format check)
npm run typecheck      # Panda codegen + tsc --noEmit
npm run test:unit      # Vitest unit tests
cargo test             # core Rust tests (reverie-core, persistence, bridge)
```

## Code style and linting

- **TypeScript / web** is formatted and linted with [Biome](https://biomejs.dev).
  Run `npm run lint:fix` to auto-fix, or `npm run format` to format only.
- **Rust** is formatted with `rustfmt` (edition 2024) and linted with `clippy`.

A Husky **pre-commit** hook auto-formats and lints your staged files and runs a
typecheck. A **commit-msg** hook validates your commit message (see below). The
hooks are installed automatically by `npm install`.

## Commit messages

Reverie uses [Conventional Commits](https://www.conventionalcommits.org/),
enforced by commitlint. The full rules live in [`CLAUDE.md`](CLAUDE.md). In short:

```
<type>(<scope>): <description>
```

- **Single line only.** No body or footer, except the DCO `Signed-off-by`
  trailer added by `git commit -s` (see the DCO section below). No
  `Co-Authored-By` or other trailers.
- Imperative mood ("add resume flow", not "added resume flow").
- Under 100 characters.
- **Types:** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `style`.
- **Scopes:** `core`, `desktop`, `web`, `terminal`, `adapters`, `docs`, `ci`, `release`.

Example: `feat(web): add focus rename inline editor to the left nav`

commitlint validates the message and rejects non-conforming ones with a helpful
error. It does not rewrite them, so fix the message and commit again.

## Pull requests

- Keep changes small and focused: one logical change per PR where possible.
- Make sure `npm run check` passes and CI is green.
- Describe what changed and why. Link any related issue.
- Respect the product and architecture guardrails in
  [`CLAUDE.md`](CLAUDE.md) (never require git, keep the domain layer
  independent of the terminal renderer, local-first only, and so on).

## Developer Certificate of Origin (DCO)

Reverie uses the [Developer Certificate of Origin](DCO) (DCO 1.1) instead of a
Contributor License Agreement. The DCO is a lightweight, contributor-friendly
sign-off: by adding it to a commit you certify that you wrote the change, or
otherwise have the right to submit it under the project's license. There is no
separate form to sign.

Sign off each commit by adding the `-s` flag:

```bash
git commit -s -m "feat(web): add focus rename inline editor"
```

That appends a trailer using your configured git name and email:

```
Signed-off-by: Your Name <you@example.com>
```

By signing off you agree to the terms in the [`DCO`](DCO) file. Contributions are
licensed inbound under the same [MIT License](LICENSE) the project ships under
(inbound = outbound). The `Signed-off-by` line is the one trailer allowed by the
single-line commit rule above; please do not add any other body, footer, or
co-author trailers.
