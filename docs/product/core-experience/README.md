# Core experience

This folder is the design for Reverie's core interaction loop: how a person dispatches work to many agents, stays oriented across them, and has a fast back-and-forth with any one of them. It sits downstream of [`product-vision.md`](../../product-vision.md) and assumes the Workspace → Project → Topic → Session model.

It is a set of feature designs, not a spec. Each feature has its own doc. This README is the anchor: the thesis they share, the two principles that resolve the hard problems, what the platform already gives us, and the order to build in.

## The thesis: two layers with opposite goals

Reverie is not a grid of sessions. It is two surfaces with opposite jobs, and most of the design follows from keeping them apart:

| | The orchestration layer (zoomed out) | The conversation layer (zoomed in) |
| --- | --- | --- |
| What the user is doing | Triaging which of N agents needs them | Workshopping with one agent |
| Design goal | **Minimize** attention | **Maximize** the bandwidth to that agent |
| Failure mode | A wall of idle tiles, anxious babysitting | Throttled by typing, slow to dispatch |
| Right feel | A calm radar that only speaks when needed | A pair-programmer you talk to |

The orchestration layer is the [home / attention router](home-attention-router.md). The conversation layer is everything that makes one session high-bandwidth: [voice input](voice-input.md), the [re-entry header](completions-and-reentry.md), and [approval cards](approval-cards.md). [Dispatch](dispatch.md) is the front door that feeds both.

## Jobs to be done

- **Dispatch.** When something comes up an agent could handle, fire it off with zero ceremony and trust it lands organized.
- **Converse.** When deep with one agent, give direction as fast as I can think it.
- **Triage.** When several agents run, pull me in only where I am actually needed, in a predictable order.
- **Re-enter.** When I come back to an agent, let me remember where we were in seconds, not minutes.
- **The emotional job.** Make running ten agents feel calm. The product holds the coordination anxiety, not me. The test for every feature: does it preserve the reverie or break it?

## Two principles that resolve the hard problems

These two ideas are why the design works. Every feature doc leans on them.

### 1. The router never ranks by intelligence

A home that ranks agents by a guessed sense of "importance" is worse than useless: the moment its model of importance diverges from the user's, they miss the thing that mattered or get spammed by the thing that did not. So the router never guesses importance.

- **Vertical order is objective state, derived from facts, never judged.** Errored → blocked on approval → finished-and-unseen → working (ambient) → idle (collapsed) → fresh (off the home). The user can always predict this order because there is no judgment in it. Trust comes from predictability, not cleverness.
- **The model only ever labels, never orders.** Where an LLM touches these surfaces, it writes a one-line "what is this agent doing / asking." A wrong caption is recoverable (you read past it); a wrong rank is fatal. Keep the AI on the cheap-to-correct side of that line.
- **We do not add user-managed importance.** No pins, no stars, no "current topic is more important" weighting. Those move the management burden onto the user, which is the opposite of the job. Decided against in the exploration; see [home-attention-router.md](home-attention-router.md).

### 2. Capability-tiered, graceful degradation across CLIs

The CLIs are not symmetric, and Reverie will keep adding more. So features that touch a CLI are built as an abstraction the CLI **opts into by capability**, with an honest fallback when it cannot. A new harness plugs in at whatever tier it supports and the UI degrades gracefully instead of breaking. The richest example is [approval cards](approval-cards.md); the same shape governs attention signals and completions. The capability matrix is in [`technical/`](../../technical/activity-ingestion.md) territory; the per-feature bindings live in each doc.

## The features

- **[home-attention-router.md](home-attention-router.md)** — the home reshaped from a session grid into a state-tiered attention surface: big-with-actions at the top, idle collapsed away, fresh gone entirely.
- **[approval-cards.md](approval-cards.md)** — native approve/deny cards over the third-party TUIs, built as a capability-tiered abstraction. The intended design has all three current CLIs answering approvals from the card while keeping their TUI; today only "signpost and jump" is built (the terminal shows a permission banner and the user answers in the TUI), with the inline answer round-trip still to be wired.
- **[completions-and-reentry.md](completions-and-reentry.md)** — the shared completion surface (CLI-reuse, no new auth) and the re-entry header that kills the reorientation tax on return.
- **[dispatch.md](dispatch.md)** — a global shortcut, anywhere on the machine, that turns a spoken request into a routed, dispatched agent session.
- **[voice-input.md](voice-input.md)** — the on-device speech-to-text primitive (Parakeet V3) and the floating voice button that fills a TUI's own input field.

## Two shared primitives

Most of the new value rides on two primitives. Build them well and several features fall out.

- **A completion surface.** Small LLM completions (summaries, titles, dispatch classification) via the CLI the user already authenticated. No new account, BYO provider, structured output. Spec in [completions-and-reentry.md](completions-and-reentry.md).
- **On-device STT.** Parakeet V3, fully local. Powers both dispatch and in-session voice. Spec in [voice-input.md](voice-input.md).

## What the platform already gives us

Much of the hard plumbing exists. Do not rebuild it.

- **A localhost hook server** (`packages/reverie-core/src/hook_server.rs`) with per-session tokens and `/hooks/claude/<token>` + `/hooks/codex/<token>` endpoints that already translate hook payloads into `ActivityUpdate`s, including `awaiting_permission` with a `displaySummary` and sanitized `args`.
- **A bridge sidecar** (`reverie-bridge`, `packages/reverie-core/src/bridge_protocol.rs`) with `wait_for_decision` / `poll_decision` methods: a ready-made "block until the user decides" channel.
- **PTY input** (`packages/reverie-core/src/pty.rs`, `write_input`, bracketed paste + control sequences).
- **Adapters** (`packages/reverie-core/src/agents.rs`, the `AgentAdapter` trait + `built_in_adapters`) that launch/resume/discover all three CLIs and already read their transcripts.
- **Activity ingestion** (`apps/desktop/src-tauri/src/correlator.rs`, the file watchers, `apps/desktop/web/domain/activity.ts` `deriveSessionState`).

The gaps are narrower than they look: the **UI surfaces**, the **decision round-trip** from card back to agent (designed via hook/bridge, not fully wired, and some prior hook code is flagged dead so it needs a verification pass), and **any LLM completion at all** (currently zero).

## Build sequence

1. **Home reshape.** State-tiered hierarchy, collapse idle, build on the in-flight finished-state work. Pure frontend, immediate relief.
2. **Completion surface → re-entry header.** The primitive dispatch also needs; lowest-risk way to prove the no-new-auth LLM path.
3. **Approval cards.** Wire the existing approval data plus the decision round-trip; verify the dead hook code. The goal is to bring all three CLIs up to the "answer from card" tier; until that round-trip lands they stay at "signpost and jump."
4. **Dispatch.** Global shortcut + STT + classification routed into the existing launch machinery.
5. **Voice input + notifications.** The floating button and the three-tier system notifications/badge.

## What changed from the initial exploration

Decisions already taken, so we do not relitigate them:

- **Dropped** pinned/focused agents and topic-as-importance weighting. The router orders by objective state only.
- **Dropped** the overlay "redirect / talk-over" input field. We do not put our own input box over a TUI's. The surviving piece is the floating voice button that fills the TUI's own field.
- **Dropped** Apple Foundation Models (Swift-only; Rust access is beta FFI) and the PydanticAI sidecar. The completion surface is CLI-reuse.
- **Confirmed** Cortex is TypeScript on `@earendil-works/pi-ai`; the completion command exposes its existing `completeSimple()`.
- **Confirmed** Codex can answer approvals while keeping its TUI via the stable `PermissionRequest` hook, so it is a first-class citizen for approval cards, not the holdout.
- **Chose** Parakeet V3 for STT.
