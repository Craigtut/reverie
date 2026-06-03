# Reverie Docs

Documentation for Reverie, a local-first agentic workspace. Start with the vision docs, then drill into product or technical detail.

## High-level vision

- [`product-vision.md`](product-vision.md) — what Reverie is and why: the agentic-workspace thesis, personas, and the Workspace → Project → Focus → Session model.
- [`design-vision.md`](design-vision.md) — the visual/interaction language: warm-neutral monochrome, light + dark, the ambient dot field, rim-lit panels.

## Product

- [`product/v1-product-spec.md`](product/v1-product-spec.md) — v1 scope, target users, UX flows, requirements, and non-goals.
- [`product/search-and-recall.md`](product/search-and-recall.md) — content-level recall ("find the session I was working on"): native-file completeness research, the Reverie-owned conversation index, discovered/external sessions, and the unified command-palette UX.
- [`product/core-experience/`](product/core-experience/README.md) — the core interaction loop: the two-layer thesis (orchestration minimizes attention, conversation maximizes bandwidth), the attention-router home, capability-tiered approval cards, the completion surface + re-entry header, voice dispatch, and the on-device STT primitive.

## Technical

- [`technical/tech-stack.md`](technical/tech-stack.md) — factual map of languages, frameworks, and build constraints.
- [`technical/technical-architecture.md`](technical/technical-architecture.md) — Rust/Tauri architecture, domain model, persistence, agent-adapter contracts, terminal boundary.
- [`technical/frontend-architecture.md`](technical/frontend-architecture.md) — React/Panda shell direction and the imperative terminal-renderer boundary.
- [`technical/terminal/`](technical/terminal/README.md) — canonical terminal design: the `libghostty-vt` core in the Rust backend, the WebGL2 renderer boundary, what crosses the wire, and the native-vs-WASM decision.
- [`technical/terminal-strategy.md`](technical/terminal-strategy.md): Ghostty/libghostty research and terminal implementation strategy. **Historical, superseded by `terminal/`** (predates the v0 rebuild).
- [`technical/terminal-overhaul-handoff.md`](technical/terminal-overhaul-handoff.md): focused handoff for the terminal renderer overhaul. **Historical, superseded by `terminal/`** (predates the v0 rebuild; its open bugs/next tasks are stale).
- [`technical/implementation-queue.md`](technical/implementation-queue.md) — current build status, immediate build queue, and the "checks to keep green".
- [`technical/packaging-and-distribution.md`](technical/packaging-and-distribution.md): how the app is bundled, how the Ghostty dylib is shipped without runtime `DYLD_LIBRARY_PATH`, code signing, and the tag-driven release flow.
- [`technical/cortex-activity-contract.md`](technical/cortex-activity-contract.md) — authoritative spec for the Cortex Code activity-state surface (per-session `activity/state.json` + `events.jsonl`).
- [`technical/activity-ingestion.md`](technical/activity-ingestion.md) — how per-CLI session lifecycle signal is normalized into one `ActivityState`: the `ActivityUpdate` spine, the correlator, the four-axis taxonomy, and the "how to add a CLI" decision tree.

## Planning

- [`ideas-and-tickets.md`](ideas-and-tickets.md) — the parking lot: ideas, to-dos, and open tickets not yet in active work, each with the what / why / UX shape / open questions.
