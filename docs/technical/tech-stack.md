# Reverie Tech Stack

> A factual map of what Reverie is built with, derived from `Cargo.toml`, `package.json`, and the configs in the repo root. For *why* and *how the layers fit together*, see [`technical-architecture.md`](technical-architecture.md), [`frontend-architecture.md`](frontend-architecture.md), and [`terminal-strategy.md`](terminal-strategy.md).

## Shape of the repo

Reverie is a **hybrid Rust + TypeScript monorepo** building a single macOS desktop app.

```
reverie/
├── Cargo.toml                    # Rust workspace (members: packages/reverie-core)
├── package.json                  # Frontend/npm workspace root + all dev scripts
├── packages/
│   └── reverie-core/             # Pure Rust domain/runtime crate (no Tauri, no UI)
│       └── src/{domain,agents,pty,terminal}.rs
├── apps/
│   └── desktop/
│       ├── src-tauri/            # Tauri v2 desktop app (Rust)
│       │   └── src/{main,app_shell,terminal_backend,terminal_runtime}.rs
│       └── web/                  # Vite + React frontend (the WebView UI)
├── spikes/                       # Isolated proofs (e.g. ghostty-vt-proof)
└── docs/                         # This documentation
```

## Backend / core (Rust)

| Concern | Choice | Notes |
| --- | --- | --- |
| Edition / toolchain | Rust **edition 2024**, `rust-version = 1.93` | Set in the workspace `Cargo.toml` |
| Desktop shell | **Tauri v2** (`tauri`, `tauri-build`) | Owns the WebView, commands, and events |
| Domain/runtime crate | `reverie-core` | Pure logic: domain model, agent adapters, PTY, terminal frame model. No Tauri dependency. |
| Terminal emulation | **`libghostty-vt` 0.1.1** | Ghostty VT core (parsing, state, scrollback, reflow). Pre-1.0; **requires Zig `0.15.x` on `PATH`** to build. |
| PTY / process | **`portable-pty` 0.9** | Cross-platform process spawn + PTY for macOS/Windows/Linux |
| Local persistence | **`rusqlite` 0.32** (`bundled`) + JSON document store | Current state is a versioned JSON shell store in the Tauri app-data dir, migrating toward SQLite |
| Serialization | `serde`, `serde_json` | Domain records, native-session refs, Tauri boundary |
| Errors | `anyhow`, `thiserror` | App-level vs. library-level error handling |
| IDs | `uuid` (v4) | Reverie-owned session/record IDs |
| Native dialogs | `rfd` 0.15 | Folder pickers for adding projects |

## Frontend (TypeScript / web)

| Concern | Choice | Notes |
| --- | --- | --- |
| Framework | **React 19** (`react`, `react-dom`) | Owns the product shell; does **not** render terminal cells |
| Build tool | **Vite 7** (`@vitejs/plugin-react`) | Root `apps/desktop/web/`, dev server on `127.0.0.1:1420`, builds to `dist/` |
| Language | **TypeScript 5.9** | `strict`, `moduleResolution: Bundler`, `noEmit` (Vite transpiles) |
| Styling | **Panda CSS** (`@pandacss/dev`) | Tokens, recipes, codegen to `apps/desktop/web/styled-system/` (gitignored) |
| Animation | **Motion** (`motion`) | Restrained shell-level animation only — never in the terminal paint loop |
| Icons | **Phosphor Icons** (`@phosphor-icons/react`) | App-shell iconography |
| Terminal renderer | Imperative **WebGL2-first** canvas island | Consumes Ghostty-derived `TerminalFrame` events from Rust; Canvas 2D fallback remains available, and WebGPU stays behind the renderer boundary until Tauri's WebView runtime supports it reliably |
| Tauri bridge | `@tauri-apps/api` | Commands/events between React and the Rust backend |

### Fonts & theming

- UI font **Inter**, monospace **JetBrains Mono** (see [`../design-vision.md`](../design-vision.md)).
- Warm-neutral monochrome token set with `data-theme` light/dark switching, currently defined inline in `App.tsx`. `panda.config.ts` holds a stale blue token set that should be reconciled.

## Browser-testable harness

Because Tauri desktop WebDriver can't drive macOS WKWebView, the React shell has a **browser fixture runtime** (`apps/desktop/web/appRuntime.ts`) that replaces Tauri IPC with deterministic fixtures. Run `npm run dev:harness` → `http://127.0.0.1:1420`. Smoke coverage runs through `harness-smoke.mjs` / `harnessSmoke.ts` against headless Chrome (`CHROME_PATH` overrides the binary). This is the fast loop for UI screenshots/interaction tests; Rust/Tauri tests remain the source of truth for persistence, commands, CLI detection, and native session launch.

## Key build constraints

- **Zig `0.15.x` must be on `PATH`** for any build that links `libghostty-vt`. The npm scripts prepend the Homebrew `zig@0.15` keg path (`/opt/homebrew/opt/zig@0.15/bin`) when present.
- The terminal core links `libghostty-vt.dylib`, but nothing needs `DYLD_LIBRARY_PATH` at runtime: `npm run dev:desktop` / `run:release` use `cargo run` (which injects the library path), and `npm run bundle` ships the dylib inside the app bundle (`Contents/Frameworks`) resolved by a baked rpath. App bundling is enabled in `tauri.conf.json`. See [`packaging-and-distribution.md`](packaging-and-distribution.md).
- Target platform: **macOS (Apple Silicon) only**. Windows and Linux are out of scope: the `libghostty-vt-sys` bindings have no Windows build path, and shipping is scoped to Apple Silicon. See [`packaging-and-distribution.md`](packaging-and-distribution.md).

## Common commands

```bash
npm run dev               # start the desktop app (Panda watch + Vite + Tauri/cargo)
npm run dev:harness       # browser-only React harness with fixture services
npm run build             # production desktop build (web assets + release binary)
npm run build:web         # Panda codegen + tsc --noEmit + vite build
npm run check             # frontend typecheck/build + Rust tests/checks
npm run test:web:harness  # build harness + scripted Chrome smoke coverage
cargo test                # core Rust tests
```

See [`implementation-queue.md`](implementation-queue.md) for the canonical "checks to keep green" list and current build status.
