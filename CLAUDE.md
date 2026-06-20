# Reverie

Reverie is a **local-first agentic workspace**: a desktop home for running, organizing, and resuming many terminal-based AI agent sessions in parallel, for anyone, not just software engineers. It is not an IDE and not a thin wrapper around one terminal component. The durable product is the user's organized, resumable map of agent work.

This file tells agents how to operate in this repository. It is intentionally short and points out to the docs. **Read the relevant doc before doing substantial work in its area.**

## Documentation map (read these)

Start here, then drill down. `docs/README.md` is the full index.

| When you are working on… | Read |
| --- | --- |
| Why Reverie exists, personas, the Workspace → Project → Topic → Session model (the data model still calls a Topic a "Focus") | [`docs/product-vision.md`](docs/product-vision.md) |
| Anything visual: color, theming, layout, motion, the dot field | [`docs/design-vision.md`](docs/design-vision.md) |
| v1 scope, user flows, requirements, non-goals | [`docs/product/v1-product-spec.md`](docs/product/v1-product-spec.md) |
| Languages, frameworks, build constraints | [`docs/technical/tech-stack.md`](docs/technical/tech-stack.md) |
| Backend/domain/persistence/adapters, the system's seams | [`docs/technical/technical-architecture.md`](docs/technical/technical-architecture.md) |
| React/Panda shell and the terminal-renderer boundary | [`docs/technical/frontend-architecture.md`](docs/technical/frontend-architecture.md) |
| Agents need to see or drive the real macOS Tauri UI | [`docs/technical/agent-automation.md`](docs/technical/agent-automation.md) |
| The terminal pipeline: libghostty-vt core, the wire, the WebGL2 renderer, scrollback and reflow | [`docs/technical/terminal/`](docs/technical/terminal/README.md) |
| What to build next + the canonical "checks to keep green" | [`docs/technical/implementation-queue.md`](docs/technical/implementation-queue.md) |
| Bundling, the Ghostty dylib/rpath story, signing, and how to cut a release | [`docs/technical/packaging-and-distribution.md`](docs/technical/packaging-and-distribution.md) |

## Repo structure

Hybrid Rust + TypeScript monorepo building one macOS desktop app (Apple Silicon).

```
reverie/
├── Cargo.toml                    # Rust workspace (reverie-bridge, reverie-core, reverie-persistence)
├── package.json                  # npm root + all dev scripts
├── packages/reverie-core/        # Pure Rust domain/runtime crate (no Tauri, no UI)
├── packages/reverie-persistence/ # SQLite-backed WorkspaceRepository crate
├── apps/reverie-bridge/          # MCP bridge sidecar binaries (reverie-bridge + hook forwarders)
├── apps/desktop/
│   ├── src-tauri/                # Tauri v2 desktop app (Rust)
│   └── web/                      # Vite + React frontend (WebView UI)
├── spikes/                       # Isolated proofs (e.g. ghostty-vt-proof)
└── docs/                         # Documentation (see map above)
```

## Operating in this repo

### Build & check

```bash
npm run dev               # run the desktop app on the DEV channel (separate data dir + "dev" badged icon)
npm run dev:agent         # run the DEV channel with the local agent automation bridge
npm run dev:harness       # browser-only React UI loop (Vite + Panda); load harness fixtures via the harness query param
npm run dev:reset         # wipe the dev channel's data (only ever the com.muselab.reverie.dev folder)
npm run check             # frontend typecheck/build + Rust tests/checks
npm run build             # PRODUCTION desktop build (base identity; install/test prod locally)
npm run version:set -- X  # bump version across all 6 manifests in lockstep (x.y.z | patch | minor | major)
npm run icon:dev          # regenerate the badged dev icon after the production icon changes
cargo test                # core Rust tests
```

See "Dev vs production channels" below for why `npm run dev` and `npm run build` use different bundle identifiers and data directories.

Keep the checks in [`docs/technical/implementation-queue.md`](docs/technical/implementation-queue.md) green; that file is the source of truth for the current check list.

### Build constraints you must know

- **Zig `0.15.x` is required** to build anything that links `libghostty-vt`. The npm build/run scripts route `cargo`/`tauri` through `scripts/run-with-zig.mjs`, which resolves a 0.15.x toolchain (the Homebrew `zig@0.15` keg via `brew --prefix`, or a 0.15.x already on `PATH` such as CI's) and fails with install guidance otherwise. The version is pinned deliberately: a machine's default `zig` is often newer (0.16+) and mis-links. If a build fails on the Ghostty link step, a missing or wrong-version Zig is the usual cause (`brew install zig@0.15`).
- **A Swift toolchain (Xcode Command Line Tools) is required** for the desktop build: the `reverie-speech` STT engine's `asr` feature pulls `fluidaudio-rs`, whose build script runs `swift build` to compile a CoreML/ANE bridge. It static-links (no dylib to bundle) but needs an `-rpath /usr/lib/swift` (baked by the build scripts) for the Swift runtime. The root `cargo test` stays Swift-free (the native deps are feature-gated). The ~500MB Parakeet model is downloaded at runtime, never bundled. See [`docs/product/core-experience/voice-input.md`](docs/product/core-experience/voice-input.md).
- The terminal core links `libghostty-vt.dylib`, but **nothing needs `DYLD_LIBRARY_PATH` at runtime**. For development, `npm run dev` / `dev:desktop` / `run:release` go through `cargo run`, which injects the library search path automatically. For distribution, `npm run bundle` ships the dylib inside the app (`Contents/Frameworks`) resolved by a baked rpath. Prefer those scripts over launching the raw built binary directly. See [`docs/technical/packaging-and-distribution.md`](docs/technical/packaging-and-distribution.md).
- macOS desktop WebDriver can't drive WKWebView, so **use `npm run dev:harness` for UI iteration and screenshots**. Rust/Tauri tests remain the source of truth for persistence, commands, CLI detection, and native session launch.

### Dev vs production channels

`npm run dev` runs the **dev channel**: a separate bundle identifier (`com.muselab.reverie.dev`, productName "Reverie Dev", badged Dock icon, " Dev" window title). Production (`npm run build`, `npm run bundle`) keeps the base `com.muselab.reverie`. Because macOS namespaces Application Support by identifier, the dev build's database and diagnostics live in a **separate folder** and never co-mingle with a real install. CLI-readable scratch and hook files use `~/.reverie-dev/` for dev and `~/.reverie/` for production. The agent CLI homes (`~/.claude`, `~/.codex`, `~/.cortex`) are intentionally shared across channels: those sessions belong to the CLIs.

- Mechanism: `scripts/tauri-channel.mjs dev` merges `tauri.dev.conf.json` over `tauri.conf.json` via the `TAURI_CONFIG` env var (the same RFC 7396 merge the Tauri CLI's `--config` uses; `tauri-build` reads it at compile time). It works through our `cargo run` dev path without the Tauri CLI. Production paths pass no overlay, so a local `npm run build` is a real production app.
- `npm run dev:reset` wipes the dev data folder (only ever the `.dev` path) when a schema or migration needs a clean slate.
- `npm run icon:dev` regenerates the badged dev icon (`scripts/make-dev-icon.py`) after the production icon changes.
- Dev-only behaviors (terminal diagnostics, the runtime Dock badge) key off `commands::is_dev_channel`, i.e. the identifier ending in `.dev`.

### Runtime diagnostics

The desktop app appends terminal renderer diagnostics (dev channel only) to its app-data dir:

```bash
~/Library/Application Support/com.muselab.reverie.dev/terminal-diagnostics.jsonl   # npm run dev
# A production build writes no diagnostics log.
```

Use this log when investigating real Tauri terminal behavior that the browser harness cannot fully show: resize flicker, blank or repeated history rows, scrollback cache misses, renderer remounts, slow paints, input focus stalls, or a running terminal that appears stuck. Each JSONL entry includes the selected session id, active terminal id, timestamp, and a payload such as `buffer_cache_miss`, `history_rows_request`, `history_jump_*`, renderer lifecycle traces, or slow paint samples. Check this file before guessing from screenshots when the running desktop app diverges from harness behavior.

### Agent automation bridge

When an agent needs to inspect or drive the real macOS Tauri UI, run:

```bash
npm run dev:agent
```

This builds the dev channel with the `agent-automation` Cargo feature and starts a token-protected HTTP bridge on `127.0.0.1` only. The app writes the manifest here:

```bash
~/Library/Application Support/com.muselab.reverie.dev/agent-automation.json
```

Use the manifest token for `/status`, `/app`, `/dom`, `/terminal`, `/eval`, `/click`, `/type`, `/press`, `/terminal/input`, `/terminal/paste`, `/devtools/open`, and `/screenshot`. The screenshot endpoint uses WebKit snapshotting first, with `screencapture` only as a fallback. The terminal is a canvas, so use `/terminal` for readable rows instead of DOM inspection.

Do not broaden this into production. The bridge must stay behind all gates: `debug_assertions`, the explicit `agent-automation` Cargo feature, `REVERIE_AGENT_AUTOMATION=1`, the `.dev` bundle identifier, localhost binding, and per-run token auth. See [`docs/technical/agent-automation.md`](docs/technical/agent-automation.md).

### Releases

Releases are cut by pushing a `vX.Y.Z` tag, which triggers `.github/workflows/release.yml` (macOS, Apple Silicon: Reverie's only target). Read [`docs/technical/packaging-and-distribution.md`](docs/technical/packaging-and-distribution.md) before cutting one. Before tagging:

- Update `CHANGELOG.md`: move `Unreleased` items into a new `## [X.Y.Z]` section, summarizing the commits since the previous tag (`git log <prev-tag>..HEAD`), grouped by Conventional Commit type. Commit as `docs(release): changelog for vX.Y.Z`.
- Bump the version with `npm run version:set -- <x.y.z | patch | minor | major>`, which updates `package.json`, `apps/desktop/src-tauri/tauri.conf.json`, and every crate `Cargo.toml` in lockstep (then run `npm run check` to refresh `Cargo.lock`).
- macOS signing/notarization needs these repo secrets: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`. Without them the build is unsigned.
- Auto-updates need the Tauri minisign keypair (separate from Apple signing): the public key in `tauri.conf.json` (`plugins.updater.pubkey`) and the `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repo secrets. Publishing a release (not just drafting it) is what makes an update live, since the updater endpoint resolves `latest`. See [`docs/technical/packaging-and-distribution.md`](docs/technical/packaging-and-distribution.md).

Bundling is enabled and the Ghostty dylib ships inside the app with a baked rpath (no runtime `DYLD_LIBRARY_PATH`). `npm run bundle` produces the `.app` and `.dmg` locally; the release workflow builds them in CI. Signed, notarized releases additionally need the Apple secrets above. See the packaging doc for how it works.

## Guardrails (do not violate)

These are load-bearing product and architecture rules. Breaking them undermines what Reverie is.

- **Never require git.** Folders are projects; git is optional, always. No worktree-, repo-, or branch-gating in the core flow.
- **Don't turn Reverie into an IDE.** Favor session continuity and an organized map over feature sprawl. Developer-only features (worktrees, etc.) are opt-in, progressive-disclosure only.
- **Keep the product/domain layer independent of the terminal renderer.** The UI consumes Reverie's `TerminalFrame` event model, not Ghostty-specific APIs.
- **Never render terminal cells as React DOM.** The terminal is an imperative Canvas island.
- **All frontend text renders through the `<Typography>` primitive** (`apps/desktop/web/components/primitives/Typography.tsx`). Pick a `variant` from the scale (`themes/typography.ts`) and a `tone` for color; never set `fontSize`, `fontWeight`, `lineHeight`, or text `color` ad-hoc in a `css()` block. Residual needs (monospace, opacity, eyebrow letter-spacing) go through the component's `className`/`style`, not a parallel text style.
- **Don't animate inside the terminal paint loop.** Motion is shell-level only.
- **Local-first only.** No accounts, cloud sync, or sync seams in v1.
- **Dangerous / YOLO mode stays explicit.** Off by default, opt-in, overridable per session. Never hidden behind defaults.
- **Design is monochrome + status colors only.** Warm-neutral palette, light *and* dark as equals. See [`docs/design-vision.md`](docs/design-vision.md).
- **Don't let terminal proof/spike code become production architecture by accident.**

## Writing style

- **Never use em dashes** in copy, comments, or docs. Use commas, colons, semicolons, parentheses, or separate sentences instead.
- Write in plain language that matches the product's tone.

## Commit conventions

Reverie uses [Conventional Commits](https://www.conventionalcommits.org/).

**Format (single line only, no body, no footer, no co-authors):**

```
<type>(<scope>): <description>
```

**Examples:**

```
feat(web): add focus rename inline editor to the left nav
fix(terminal): keep PTY and Ghostty dimensions aligned on resize
feat(adapters): capture Codex native session id from rollout jsonl
docs(product): clarify that projects never require git
refactor(core): split native session ref capture out of app_shell
```

**Types:** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `style`

**Scopes:** `core` (reverie-core), `desktop` (Tauri app), `web` (React frontend), `terminal` (PTY/Ghostty/runtime/backend), `adapters` (agent CLI adapters), `docs`, `ci`, `release`

**Rules:**

- Single line only. No message body, no footer, no `Co-Authored-By`. (External contributors sign commits with a DCO `Signed-off-by` trailer via `git commit -s`; that trailer is the one allowed exception. See CONTRIBUTING.md.)
- Commit early and often. Small, focused commits are preferred; one logical change per commit.
- Write in imperative mood: "add resume flow" not "added resume flow".
- Keep the first line under 100 characters.
- Always use `git commit -m "..."` with a single-line message.
- Only commit or push when the user asks.
