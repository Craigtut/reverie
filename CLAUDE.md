# Reverie

Reverie is a **local-first agentic workspace**: a calm desktop home for running, organizing, and resuming many terminal-based AI agent sessions in parallel, for anyone, not just software engineers. It is not an IDE and not a thin wrapper around one terminal component. The durable product is the user's organized, resumable map of agent work.

This file tells agents how to operate in this repository. It is intentionally short and points out to the docs. **Read the relevant doc before doing substantial work in its area.**

## Documentation map (read these)

Start here, then drill down. `docs/README.md` is the full index.

| When you are working on… | Read |
| --- | --- |
| Why Reverie exists, personas, the Workspace → Project → Focus → Session model | [`docs/product-vision.md`](docs/product-vision.md) |
| Anything visual: color, theming, layout, motion, the dot field | [`docs/design-vision.md`](docs/design-vision.md) |
| v1 scope, user flows, requirements, non-goals | [`docs/product/v1-product-spec.md`](docs/product/v1-product-spec.md) |
| Languages, frameworks, build constraints | [`docs/technical/tech-stack.md`](docs/technical/tech-stack.md) |
| Backend/domain/persistence/adapters, the system's seams | [`docs/technical/technical-architecture.md`](docs/technical/technical-architecture.md) |
| React/Panda shell and the terminal-renderer boundary | [`docs/technical/frontend-architecture.md`](docs/technical/frontend-architecture.md) |
| Ghostty/libghostty terminal strategy | [`docs/technical/terminal-strategy.md`](docs/technical/terminal-strategy.md) |
| What to build next + the canonical "checks to keep green" | [`docs/technical/implementation-queue.md`](docs/technical/implementation-queue.md) |

## Repo structure

Hybrid Rust + TypeScript monorepo building one cross-platform desktop app.

```
reverie/
├── Cargo.toml                    # Rust workspace (member: packages/reverie-core)
├── package.json                  # npm root + all dev scripts
├── packages/reverie-core/        # Pure Rust domain/runtime crate (no Tauri, no UI)
├── apps/desktop/
│   ├── src-tauri/                # Tauri v2 desktop app (Rust)
│   └── web/                      # Vite + React frontend (WebView UI)
├── spikes/                       # Isolated proofs (e.g. ghostty-vt-proof)
└── docs/                         # Documentation (see map above)
```

## Operating in this repo

### Build & check

```bash
npm run dev               # run the desktop app (Panda watch + Vite + Tauri)
npm run dev:harness       # browser-only React harness with fixture services (fast UI loop)
npm run check             # frontend typecheck/build + Rust tests/checks
npm run build             # production desktop build
cargo test                # core Rust tests
```

Keep the checks in [`docs/technical/implementation-queue.md`](docs/technical/implementation-queue.md) green; that file is the source of truth for the current check list.

### Build constraints you must know

- **Zig `0.15.x` must be on `PATH`** for any build that links `libghostty-vt`. The npm scripts prepend the Homebrew `zig@0.15` keg path when present; if a build fails on the Ghostty link step, this is the usual cause.
- Builds that link Ghostty need `DYLD_LIBRARY_PATH` pointed at the generated `libghostty-vt.dylib`; `npm run dev:desktop` / `run:release` handle this. Prefer those scripts over raw `cargo run`.
- macOS desktop WebDriver can't drive WKWebView, so **use `npm run dev:harness` for UI iteration and screenshots**. Rust/Tauri tests remain the source of truth for persistence, commands, CLI detection, and native session launch.

## Guardrails (do not violate)

These are load-bearing product and architecture rules. Breaking them undermines what Reverie is.

- **Never require git.** Folders are projects; git is optional, always. No worktree-, repo-, or branch-gating in the core flow.
- **Don't turn Reverie into an IDE.** Favor session continuity and a calm, organized map over feature sprawl. Developer-only features (worktrees, etc.) are opt-in, progressive-disclosure only.
- **Keep the product/domain layer independent of the terminal renderer.** The UI consumes Reverie's `TerminalFrame` event model, not Ghostty-specific APIs.
- **Never render terminal cells as React DOM.** The terminal is an imperative Canvas island.
- **Don't animate inside the terminal paint loop.** Motion is shell-level only.
- **Local-first only.** No accounts, cloud sync, or sync seams in v1.
- **Dangerous / YOLO mode stays explicit.** Off by default, opt-in, overridable per session. Never hidden behind defaults.
- **Design is monochrome + status colors only.** Warm-neutral palette, light *and* dark as equals. See [`docs/design-vision.md`](docs/design-vision.md).
- **Don't let terminal proof/spike code become production architecture by accident.**

## Writing style

- **Never use em dashes** in copy, comments, or docs. Use commas, colons, semicolons, parentheses, or separate sentences instead.
- Write in plain, calm language that matches the product's tone.

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

- Single line only. No message body, no footer, no `Co-Authored-By`.
- Commit early and often. Small, focused commits are preferred; one logical change per commit.
- Write in imperative mood: "add resume flow" not "added resume flow".
- Keep the first line under 100 characters.
- Always use `git commit -m "..."` with a single-line message.
- Only commit or push when the user asks.
