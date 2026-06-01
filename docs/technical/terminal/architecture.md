# Terminal architecture

> How Reverie paints a fast terminal for many parallel agent sessions: the `libghostty-vt` core in the Rust backend, a thin WebGL2 renderer in the WebView, and a narrow boundary between them. v0 is about one thing, painting all the CLIs performantly, including scrolling back through what `libghostty` holds in memory. We persist no terminal history: a restart is handled by the CLI's own resume. Search is a separate feature and is out of scope. See [How resume works](#how-resume-works) and [Non-goals](#non-goals).

## What we are building right now

A user runs Claude, Codex, Cortex, or a plain shell in a Reverie session. Output streams in, often fast, often redrawing the screen (spinners, progress bars, Ink-style live panels). That has to paint smoothly at 60fps, respond to typing with no perceptible lag, let the user scroll back through the session, and keep working when dozens of sessions run at once. That is the whole job for now.

Two things we explicitly do not do. We do not run search (a separate product feature). And we **persist no terminal history at all**: there is no history store, no transcript, and no restoring terminal state across a restart, because resume re-runs the CLI (see [How resume works](#how-resume-works)). The entire scroll-back story is `libghostty`'s in-memory buffer.

## How resume works

Reverie does not save or restore terminal state. To resume a session, Reverie relaunches the agent CLI with its own resume flag (for example `claude --resume <session-id>`), using the CLI-native session id Reverie stored when the session was created. The CLI rebuilds its own conversation context and prints whatever it prints; `libghostty` renders that fresh output into a fresh terminal.

So there is no Reverie-managed PTY snapshot, no saved grid to restore, and no byte replay to reconstruct a screen. A resumed session is simply a new process with a new terminal. `libghostty` owns only the live history of the currently running process; it does not carry across a resume, and it does not need to. **We never need terminal history that survives an app restart, because the CLI's own resume re-establishes the session.** The only durable thing Reverie keeps is the small mapping from its session to the CLI-native session id and how to launch the resume; that lives in the domain layer, not the terminal core. This corrects a conflation in earlier attempts, where "render history" and "restore a session" got tangled together (see [`decisions.md`](decisions.md), D5).

## The one principle

Put the ownership line in exactly one place and never blur it.

- The **backend owns the truth.** `libghostty-vt` reads the raw output and maintains the live grid of styled cells plus an in-memory scrollback, handles wrapping and reflow on resize, and serves ranges of history rows on request. It is the single source of terminal state.
- The **frontend owns the view.** The WebGL2 island holds a mirror of the rows near the viewport, a glyph atlas, and a pointer to where it is looking. It draws, and it drives scrolling. It does not parse, wrap, or hold the authoritative buffer.
- The **wire carries deltas and serves ranges.** Small incremental updates flow down; the frontend asks for more rows when it needs them. Never a full snapshot of the screen every frame.

Get that division right and 60fps plus smooth scrolling fall out almost for free. Blur it and you get scroll lag and stutter, the failure modes this design exists to prevent.

## Who owns what

| Layer | Owns | Does not own |
| --- | --- | --- |
| Rust backend (`src/terminal/`) | PTY and process lifecycle; `libghostty-vt` VT parsing; the authoritative grid and the in-memory scrollback; wrap and reflow; dirty-row tracking; serving requested history ranges from its buffer | pixels, fonts, glyph rasterization, GPU state, the viewport (it never decides what is on screen), any persisted history |
| The wire (Tauri IPC) | carrying seed snapshots and dirty-row diffs down, and input plus history-range requests up, in binary | any business logic |
| WebView frontend (`web/terminal/`) | a mirror of the rows near the viewport; the viewport and scrolling; the glyph atlas; the imperative WebGL2 renderer; deciding when to ask for more rows | VT parsing, reflow, the authoritative buffer, the history store |

The frontend's row mirror and scroll state are **view-state**, not domain logic. The domain logic, meaning what the cells actually are, lives in the Rust core.

## What crosses the wire (v0)

Backend to frontend:

1. **Seed snapshot.** On attach, focus, or resize. The current screen plus a margin of rows around it (not the whole buffer), with a generation marker. Lets the frontend render and scroll immediately.
2. **Frame diff.** The rows that changed since the last update. The frequent, tiny message.
3. **Control.** Cursor position and shape, title, bell, size.

Frontend to backend:

4. **Input.** Encoded keys, paste, mouse, focus.
5. **History-range request.** When the user scrolls up and the mirror is running low, "send me the rows above what I have." The backend reads that range from `libghostty`'s buffer and returns it.

Per cell: the character or grapheme, its display width, foreground and background color, and style flags. A few bytes, binary.

Three things never cross the wire: pixels or images of text; fonts or glyph bitmaps (the frontend rasterizes its own glyphs once and caches them); and a full screen snapshot every frame. The last one is the cardinal sin. Ghostty's own renderer dropped per-frame full clones because the copy time blocked output, and that was in-process with no serialization, so across our boundary it is worse.

The history-range request reaches only as far as `libghostty`'s in-memory buffer. Once rows scroll past the oldest the buffer holds, they have evicted and are gone; we do not persist them. That is acceptable: a restart uses the CLI's resume, not stored history.

Transport: Tauri 2's binary-capable, ordered transports (the streaming Channel and Raw Requests), not the JSON event system, which Tauri documents as unsuitable for low-latency, high-throughput streams. See [`wire-protocol.md`](wire-protocol.md).

## How the frontend paints (and why it hits 60fps)

- **Draw each glyph once.** The first time a given character-and-style is needed, rasterize it into a glyph atlas. Every later occurrence is a copy from the atlas. Common ASCII is pre-warmed.
- **Draw the screen as instanced quads in two passes.** One pass fills cell backgrounds; one pass stamps glyphs from the atlas. Each pass is essentially one GPU call over all visible cells.
- **Redraw only what changed.** If the viewport has not moved and no visible row changed, do not repaint. An idle session costs nothing.

Because the glyphs are already in the atlas and the rows are already in the mirror, a repaint is reshuffling positions and colors into a buffer and issuing two draw calls, well inside the 16.6ms frame budget. WebGL2 primary, Canvas 2D fallback, WebGPU later behind the same contract. See [`frontend.md`](frontend.md).

## How scrolling works, and where the line is

This is the crux, and getting the line right is what both earlier attempts missed.

- `libghostty` **stores** the history (its in-memory scrollback) and **serves** ranges of it on request. It is the single source of history rows; we never persist a second copy.
- The frontend **drives** scrolling. It owns the viewport and decides when the view moves.
- The frontend keeps a mirror of rows near the viewport. Scrolling moves the viewport over that mirror and repaints from it. That is local and instant: no backend round-trip.
- As the viewport approaches the top of the mirrored rows, the frontend asks the backend for more rows above. The backend reads that range from `libghostty`'s buffer and returns it; the frontend extends its mirror. This fetch is a prefetch, run ahead of need, not a request on every scroll tick.

The line in one sentence: **`libghostty` serves rows, the frontend drives the viewport.** The pit in attempt one was making the backend drive the scroll, so every scroll movement was a round-trip that moved `libghostty`'s viewport and re-emitted rows, which lagged. Here `libghostty` never decides what is on screen; it only answers "give me rows X to Y."

Reach is the `libghostty` scrollback budget, which is a dial we set generously (see [`decisions.md`](decisions.md), D7). Beyond it, the oldest rows have evicted and are gone, which is fine because restart uses the CLI's resume. On resize, `libghostty` reflows wrapped lines, which renumbers rows, so the frontend re-seeds from a fresh snapshot rather than trusting old positions. See [`libghostty-history-limits.md`](libghostty-history-limits.md).

## Handling the different CLIs

The reason this works for Claude, Codex, Cortex, and shells alike is that `libghostty-vt` is a real, correct terminal emulator. Cursor moves, line redraws, the alternate screen, spinners and Ink-style live panels, truecolor, styles, and wide CJK and emoji cells are all normal VT behavior the core handles. The frontend never needs to know which CLI it is; it paints whatever cells the core reports.

A useful consequence of this scope: the known Claude/Ink "history looks corrupted" problem only arises when re-replaying a redraw-heavy app's raw saved bytes through a fresh terminal to reconstruct old scrollback. We never do that, because we persist no history and a restart uses the CLI's resume. Live painting of an Ink app, and scrolling within `libghostty`'s own buffer, are ordinary VT behavior and are not affected.

## Concurrency: dozens of sessions, no hard cap

Only the focused session paints at full 60fps. Background sessions keep consuming output and updating their state, but their frames are throttled or not pushed while off-screen; on focus, the backend sends a fresh seed snapshot and resumes diffs. Per-session memory is bounded by `libghostty`'s scrollback budget (default 10 MB, lazily allocated, so idle and short sessions cost little), which keeps dozens of resident sessions affordable. The design does not hard-cap session count; under real memory pressure the levers are lowering the per-session budget or shedding off-screen sessions' buffers. See [`backend.md`](backend.md) and [`performance-and-acceptance.md`](performance-and-acceptance.md).

## Non-goals

Deliberately out of scope. The architecture stays simple by not pretending to do these.

- **Search and any cross-session content index.** A separate product feature with its own design; the terminal does not build for it.
- **Persisting terminal history of any kind.** We never write terminal output to disk to survive a restart or to extend scroll-back past the in-memory buffer. The in-memory buffer is the whole scroll-back reach (a dial, D7); rows that evict are gone, and that is acceptable.
- **Restoring terminal state across a restart.** Not a Reverie feature. A restart resumes the CLI, which re-establishes its own session (see [How resume works](#how-resume-works)).

There is no deferred "deep history" or "transcript" milestone hiding behind these. They are simply not how Reverie works.

## Related

- [`decisions.md`](decisions.md) — why the core choices are what they are (D1 native core, D2 scope, D3 concurrency, D4 CLI behavior in the core, D5 resume is the CLI's job, D6 the scrolling line, D7 source of truth and the buffer dial).
- [`backend.md`](backend.md), [`wire-protocol.md`](wire-protocol.md), [`frontend.md`](frontend.md) — the three owners in detail.
- [`libghostty-history-limits.md`](libghostty-history-limits.md) — how far back `libghostty`'s buffer reaches, and the reflow caveat.
- [`performance-and-acceptance.md`](performance-and-acceptance.md) — the yardstick.
- The older [`../terminal-strategy.md`](../terminal-strategy.md) and [`../terminal-overhaul-handoff.md`](../terminal-overhaul-handoff.md) are historical and superseded by this folder.
