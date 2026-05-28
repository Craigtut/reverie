# Reverie Docs

Documentation for Reverie, a local-first agentic workspace. Start with the vision docs, then drill into product or technical detail.

## High-level vision

- [`product-vision.md`](product-vision.md) — what Reverie is and why: the agentic-workspace thesis, personas, and the Workspace → Project → Focus → Session model.
- [`design-vision.md`](design-vision.md) — the visual/interaction language: warm-neutral monochrome, light + dark, the ambient dot field, rim-lit panels.

## Product

- [`product/v1-product-spec.md`](product/v1-product-spec.md) — v1 scope, target users, UX flows, requirements, and non-goals.

## Technical

- [`technical/tech-stack.md`](technical/tech-stack.md) — factual map of languages, frameworks, and build constraints.
- [`technical/technical-architecture.md`](technical/technical-architecture.md) — Rust/Tauri architecture, domain model, persistence, agent-adapter contracts, terminal boundary.
- [`technical/frontend-architecture.md`](technical/frontend-architecture.md) — React/Panda shell direction and the imperative terminal-renderer boundary.
- [`technical/terminal-strategy.md`](technical/terminal-strategy.md) — Ghostty/libghostty research and terminal implementation strategy.
- [`technical/implementation-queue.md`](technical/implementation-queue.md) — current build status, immediate build queue, and the "checks to keep green".
- [`technical/cortex-activity-contract.md`](technical/cortex-activity-contract.md) — authoritative spec for the Cortex Code activity-state surface (per-session `activity/state.json` + `events.jsonl`).
