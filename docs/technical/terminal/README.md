# Terminal

Durable design docs for Reverie's terminal. This folder is the source of truth for how the terminal is built. It is written from first principles and the research, on purpose, before reading the current implementation, so we have a clean target to hold the build against.

## Scope right now

v0 has one job: **performantly paint every supported agent CLI onto the screen, and let the user scroll back through the history `libghostty` is holding.** Claude and other redraw-heavy Ink-style CLIs, Codex, Cortex, and plain shells, rendered live at 60fps, with low input latency, across dozens of concurrent sessions.

Two things that are easy to conflate, made explicit:

- **Resume is the CLI's job.** Reverie resumes a session by relaunching the CLI with its own resume flag, not by saving or replaying terminal state. See [`architecture.md`](architecture.md) (How resume works) and [`decisions.md`](decisions.md) (D5).
- **`libghostty` owns the history; the frontend drives scrolling.** The backend serves ranges of rows from `libghostty`'s buffer when the frontend asks; the frontend never hands scrolling to the backend. Rows carry a backend-computed stable id so the cache stays coherent across trim. See [`decisions.md`](decisions.md) (D6, D8) and [`scrollback-coverage-design.md`](scrollback-coverage-design.md).

Out of scope (these are simply not how Reverie works, not deferred milestones):

- Search and any cross-session content index. A separate product feature; the terminal does not build for it.
- Persisting terminal history of any kind. No transcript, no restore-from-disk, no history that survives a restart. The in-memory buffer is the whole scroll-back reach, and a restart resumes the CLI, which re-establishes its own session.

See [`decisions.md`](decisions.md) (D2) for why, and the Non-goals section in [`architecture.md`](architecture.md).

## Docs

- [`architecture.md`](architecture.md) — the overview: the one principle, who owns what, how resume works, what crosses the wire, how painting and scrolling work, the scroll-back line, the different CLIs, and the non-goals. Start here.
- [`backend.md`](backend.md) — the Rust side: PTY runtime, the `libghostty-vt` core, per-session ownership and threading, serving history ranges, the frame model, and how dozens of sessions are managed.
- [`wire-protocol.md`](wire-protocol.md) — the boundary: the messages that cross between backend and WebView (including the history-range request), the transport, and the rules that keep it fast.
- [`frontend.md`](frontend.md) — the WebView side: the row mirror, the viewport, driving scrolling and topping up rows, the WebGL2 glyph-atlas renderer, and input.
- [`scrollback-coverage-design.md`](scrollback-coverage-design.md) — the scroll-back rework: how the frontend decides render-vs-fetch per row (coverage by provenance, the fix for the Ink scroll-stops bug) and how rows keep a stable id across trim and reflow (the backend-computed StableRowIndex model, D8).
- [`libghostty-history-limits.md`](libghostty-history-limits.md) — how far back `libghostty`'s buffer reaches, how it stores and serves rows, row identity across trim and reflow, and the caveats.
- [`resize-reflow-anchoring.md`](resize-reflow-anchoring.md) — why resizing while scrolled back reflows cleanly for line-oriented CLIs but jumbles a TUI's (Ink/Claude) hard-wrapped history, why that is inherent (even Ghostty's app does it), the viewport-pin position re-anchor we found but deferred, and the v0 decision to accept it (D9).
- [`performance-and-acceptance.md`](performance-and-acceptance.md) — the budgets and the acceptance checklist: the yardstick for "is the implementation faithful to this architecture".
- [`decisions.md`](decisions.md) — the log of pivotal decisions and why.

## Older terminal docs (historical)

[`../terminal-strategy.md`](../terminal-strategy.md) and [`../terminal-overhaul-handoff.md`](../terminal-overhaul-handoff.md) predate heavy changes and are kept only for history. This folder supersedes them as the design source of truth.
