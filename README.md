# Reverie

Reverie is a local-first desktop app for organizing and resuming agent CLI sessions.

The product thesis: people increasingly use terminal-based agents for many kinds of work, not just software engineering. Reverie should make those sessions easy to structure, revisit, and continue without requiring git, accounts, cloud sync, or developer-only workflow assumptions.

## V1 shape

- macOS desktop app (Apple Silicon) built with Tauri v2 and a Rust-first backend.
- Local-only persistence: no accounts, sync, or cloud services in v1.
- Core hierarchy: `Workspace → Project → Focus → Session`.
- Projects are optional folder-backed contexts and must not require git.
- General workspace sessions live outside any project for non-folder-specific work.
- Supported agent CLIs from v1:
  - Claude Code
  - Codex CLI
  - Cortex Code
- The user installs CLIs separately; Reverie detects available executables and enables them.
- Dangerous / YOLO behavior is opt-in, off by default, configurable globally and per session.

## Current docs

See [`docs/README.md`](docs/README.md) for the full index. Highlights:

- [`docs/product-vision.md`](docs/product-vision.md) — the agentic-workspace thesis, personas, and the Workspace → Project → Focus → Session model.
- [`docs/design-vision.md`](docs/design-vision.md) — warm-neutral monochrome visual language, light + dark, and the ambient dot field.
- [`docs/product/v1-product-spec.md`](docs/product/v1-product-spec.md) — product direction, users, v1 scope, UX flows, and non-goals.
- [`docs/technical/tech-stack.md`](docs/technical/tech-stack.md) — languages, frameworks, and build constraints.
- [`docs/technical/technical-architecture.md`](docs/technical/technical-architecture.md) — Rust/Tauri architecture, data model, persistence, terminal boundaries, and CLI adapter contracts.
- [`docs/technical/terminal-strategy.md`](docs/technical/terminal-strategy.md) — Ghostty/libghostty research and terminal implementation strategy.
- [`docs/technical/frontend-architecture.md`](docs/technical/frontend-architecture.md) — React/Panda shell direction and terminal renderer boundary.
- [`docs/technical/implementation-queue.md`](docs/technical/implementation-queue.md) — immediate build queue after the terminal-quality spike.

Agent operating instructions live in [`CLAUDE.md`](CLAUDE.md) (with [`AGENTS.md`](AGENTS.md) symlinked to it).

## Build status

The repository is still at early product-build stage, but now has a Rust workspace, Tauri desktop app, Vite + React product shell, SQLite-backed local app state, Ghostty-backed terminal runtime, and Cortex session resume path. Product and architecture seams are being kept explicit so the implementation can move from proof toward a real local-first desktop application without losing terminal correctness.

The current Tauri app renders `libghostty-vt`-derived `TerminalFrame` data in a desktop WebView Canvas surface and streams live PTY → Ghostty → Tauri frames through `apps/desktop/src-tauri/src/terminal_runtime.rs`. The React shell starts live terminal sessions through the stable `start_session` command and consumes `terminal_frame` / `terminal_exit` events. Zig `0.15.2` must be on `PATH` for builds that include `libghostty-vt`; the npm scripts prepend the Homebrew `zig@0.15` keg path when present.

The frontend baseline is Vite + React 19 + Panda CSS + Motion + Phosphor Icons. React owns the product shell; the terminal surface stays an imperative Canvas island. The current shell loads persisted workspace/project/focus/session data from a local SQLite database in the Tauri app-data directory, keeps General sessions available without requiring a Project, exposes first create-focus/create-session command flows, and launches selected sessions through the stable `start_session` runtime path. Cortex native-session capture now has both an explicit attach command and a launch-window discovery path that scans `~/.cortex/sessions/*/meta.json` by cwd/timestamp instead of relying on terminal-output scraping.

Useful root scripts:

```bash
npm run dev              # start the desktop app for development
npm run run              # alias for npm run dev
npm run rundev           # forgiving alias for npm run dev
npm run dev:harness      # start the browser-testable React/Vite harness with fixture services
npm run test:web:harness # build/typecheck the harness and run scripted browser smoke coverage
npm run build:web        # generate Panda CSS, typecheck, and build the web assets
npm run build            # production desktop build alias
npm run build:desktop    # build web assets and the release desktop binary
npm run bundle           # build the distributable macOS .app + .dmg (Tauri bundle)
npm run run:release      # build and launch the optimized release binary
npm run check            # frontend build/typecheck plus Rust tests/checks
```

## Browser-testable UI harness

The production app still runs through Tauri/Rust, but the React shell now has a browser fixture runtime for product/UI testing on macOS where Tauri desktop WebDriver cannot drive WKWebView. Use `npm run dev:harness` and open `http://127.0.0.1:1420` to exercise the same Reverie shell in a normal browser. Open `http://127.0.0.1:1420?fixture=empty` to start from an empty first-run workspace and exercise onboarding into project/focus/session creation; add `&resetFixture=1` for a clean fixture database. The harness persists fixture workspace state in `localStorage` so reloads feel like a real app. Use `&cli=partial` to make Codex unavailable, or `&cli=none` to test the no-supported-CLI state. In this mode `apps/desktop/web/appRuntime.ts` replaces Tauri IPC with deterministic fixture services for workspace loading, project/focus/session creation, CLI detection, terminal lifecycle events, synthetic terminal frames, and Ghostty proof data.

Stable browser automation anchors are exposed through `data-testid` attributes such as `left-panel`, `workspace-nav`, `onboarding-panel`, `onboarding-cli-choice`, `create-focus-button`, `add-project-button`, `session-tabs`, `create-session-button`, `selected-cli-summary`, `cli-choice-list`, `cli-availability-summary`, `cli-empty-help`, `launch-session-button`, `terminal-viewport`, `terminal-canvas`, `terminal-status-label`, and `theme-toggle`. `npm run test:web:harness` now runs scripted Chrome smoke coverage over the empty onboarding flow, reload persistence, partial-CLI selection, and no-supported-CLI blocking state; set `CHROME_PATH` if Chrome/Chromium is installed somewhere nonstandard. This harness is the intended fast loop for screenshots and interaction tests; Rust/Tauri tests remain the source of truth for SQLite persistence, command handlers, CLI detection, and native session launch behavior.

`npm run bundle` produces a distributable macOS app (`Reverie.app`) and disk image (`.dmg`) under `apps/desktop/src-tauri/target/release/bundle/`. The Ghostty VT library (`libghostty-vt.dylib`) is bundled into `Reverie.app/Contents/Frameworks/` and resolved through a baked `@executable_path/../Frameworks` rpath, so the packaged app needs no `DYLD_LIBRARY_PATH` at runtime. For development, `npm run dev` and `npm run run:release` launch through `cargo run`, which resolves the library automatically. See [`docs/technical/packaging-and-distribution.md`](docs/technical/packaging-and-distribution.md) for the full packaging and release story, including code signing.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, the checks to keep green, and the commit conventions. Agent operating instructions live in [`CLAUDE.md`](CLAUDE.md).

## Acknowledgements

Reverie's terminal core is built on [Ghostty](https://ghostty.org/)'s VT engine via the `libghostty-vt` bindings, and the desktop shell is built with [Tauri](https://tauri.app/). See [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) for the major third-party components and their licenses.

## License

Reverie's source code is licensed under the [MIT License](LICENSE). © 2026 Craig Tuttle.

The Reverie name and the brand assets in [`branding/`](branding/) are not covered by
the MIT License; all rights reserved. See [`branding/README.md`](branding/README.md).

If you fork Reverie and ship a modified build, please give it a different name and
your own branding, so users can tell it apart from the official project. This is a
community courtesy, not a trademark claim: the Reverie name is unregistered.

Contributions are accepted under the [Developer Certificate of Origin](DCO); see
[`CONTRIBUTING.md`](CONTRIBUTING.md) for how to sign off your commits.
