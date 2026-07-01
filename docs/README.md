# Reverie Docs

Documentation for Reverie, a local-first agentic workspace. Start with the vision docs, then drill into product or technical detail.

## High-level vision

- [`product-vision.md`](product-vision.md): what Reverie is and why: the agentic-workspace thesis, personas, and the Workspace → Project → Topic → Session model.
- [`design-vision.md`](design-vision.md): the visual/interaction language: warm-neutral monochrome, light + dark, the ambient dot field, rim-lit panels.

## Product

- [`product/v1-product-spec.md`](product/v1-product-spec.md): v1 scope, target users, UX flows, requirements, and non-goals.
- [`product/search-and-recall.md`](product/search-and-recall.md): content-level recall ("find the session I was working on"): native-file completeness research, the Reverie-owned conversation index, discovered/external sessions, and the unified command-palette UX.
- [`product/core-experience/`](product/core-experience/README.md): the core interaction loop: the two-layer thesis (orchestration minimizes attention, conversation maximizes bandwidth), the attention-router home, capability-tiered approval cards, the completion surface + re-entry header, voice dispatch, and the on-device STT primitive.

## Technical

- [`technical/tech-stack.md`](technical/tech-stack.md): factual map of languages, frameworks, and build constraints.
- [`technical/technical-architecture.md`](technical/technical-architecture.md): Rust/Tauri architecture, domain model, persistence, agent-adapter contracts, terminal boundary.
- [`technical/frontend-architecture.md`](technical/frontend-architecture.md): React/Panda shell direction and the imperative terminal-renderer boundary.
- [`technical/agent-automation.md`](technical/agent-automation.md): dev-only local bridge for agents to inspect and interact with the real macOS Tauri UI.
- [`technical/terminal/`](technical/terminal/README.md): canonical terminal design: the `libghostty-vt` core in the Rust backend, the WebGL2 renderer boundary, what crosses the wire, scrollback and reflow, and the native-vs-WASM decision.
- [`technical/remote-access/`](technical/remote-access/README.md): the mobile companion: reaching a running desktop from a phone over end-to-end-encrypted WebRTC, the data-channel protocol, the zero-knowledge security model, and the Rust desktop peer + React Native client. The proprietary backend that brokers it is documented privately.
- [`technical/implementation-queue.md`](technical/implementation-queue.md): current build status, immediate build queue, and the "checks to keep green".
- [`technical/packaging-and-distribution.md`](technical/packaging-and-distribution.md): how the app is bundled, how the Ghostty dylib is shipped without runtime `DYLD_LIBRARY_PATH`, code signing, and the tag-driven release flow.
- [`technical/cortex-activity-contract.md`](technical/cortex-activity-contract.md): authoritative spec for the Cortex Code activity-state surface (per-session `activity/state.json` + `events.jsonl`).
- [`technical/activity-ingestion.md`](technical/activity-ingestion.md): how per-CLI session lifecycle signal is normalized into one `ActivityState`: the `ActivityUpdate` spine, the correlator, the four-axis taxonomy, and the "how to add a CLI" decision tree.

## Planning

- [`ideas-and-tickets.md`](ideas-and-tickets.md): the parking lot: ideas, to-dos, and open tickets not yet in active work, each with the what / why / UX shape / open questions.
