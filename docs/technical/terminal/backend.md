# Terminal backend (Rust)

> The Rust side of the terminal: it owns the process, the VT state, and the history store, and turns raw output into small frame updates for the WebView. It also serves ranges of history on request. Scope is v0. See [`architecture.md`](architecture.md).

## Responsibilities

- Spawn and manage the CLI process and its PTY: cwd, environment, resize, signals, exit.
- For resume, launch the CLI with its native resume flag (see [How resume works](#how-resume-works)).
- Feed PTY output bytes into `libghostty-vt` to maintain the live grid and a bounded in-memory scrollback.
- Track which rows changed since the last update (dirty rows).
- Emit seed snapshots and frame diffs to the WebView in Reverie's renderer-agnostic model (`TerminalFrame` / `TerminalCell`).
- Serve history-range requests: read the asked-for rows from `libghostty`'s buffer and return them.
- Accept input (keys, paste, mouse, focus) and forward it to the PTY.
- Handle resize: set the new size on the PTY and on `libghostty-vt`; the core reflows.

Not its job: rendering, fonts, glyphs, pixels, the viewport (it never decides what is on screen), persisting terminal history, or search.

## How resume works

Resume is the CLI's job, not ours (D5). The backend does not snapshot or restore terminal state. It relaunches the agent CLI with its resume flag and the CLI-native session id Reverie stored (for example `claude --resume <session-id>`), and the CLI rebuilds its own context. `libghostty` renders the fresh output of that new process into a fresh terminal. The only durable thing Reverie needs for resume is the small mapping from its session to the CLI-native session id and how to launch the resume; that mapping lives in Reverie's domain layer, not in the terminal core.

## The per-session owner (threading)

`libghostty-vt`'s state is single-threaded and not safe to share across threads. So each session has exactly one owner that holds its terminal state. Around that owner:

- a reader drains the PTY and hands bytes to the owner,
- the owner applies the bytes to the VT state and recomputes dirty rows,
- an emitter serializes the dirty rows and pushes them over the wire,
- the same owner answers history-range requests by reading rows from its buffer.

Sessions are independent. Dozens run as independent owners (tasks or threads) coordinated by a terminal runtime or registry. This is what lets a background session keep consuming output without the focused session's paint loop caring, and it is the structural reason the native-core decision (D1) fits Reverie.

## Dirty tracking and snapshots

- **Steady state:** emit a diff of just the dirty rows.
- **On attach, focus, or resize:** emit a full seed snapshot (the current screen plus a margin of rows), then resume diffs. The snapshot carries a generation marker.
- **Coalescing:** for the focused session, collapse a burst of changes into at most one frame per frame budget (about 16ms). Do not emit faster than the frontend can paint.

## Serving history ranges (the scroll-back line)

`libghostty` is the history store. When the frontend scrolls up and runs low on mirrored rows, it asks for a range via the `read_terminal_rows(terminal_id, start_id, count, generation)` command (`start_id` is a stable line id, not a buffer position; the backend maps it to a position with the live floor `oldest_id`); the backend reads those rows from `libghostty`'s live buffer and replies with the binary row band in [`wire-protocol.md`](wire-protocol.md), tagged with the generation it was read at. This is the line from D6: `libghostty` serves rows, the frontend drives the viewport. The backend never moves the viewport in response to a scroll and has no scroll commands at all; the only pull is this one request/reply.

Mechanism (shaped by the binding). The current `libghostty` Rust binding reads full rows efficiently through its render state, which always reflects the terminal's current viewport. It also exposes grid refs for targeted cell/anchor work, but those are not the right hot path for serving viewport-sized history bands. So a range is served on the same worker thread that solely owns the terminal. The command dispatches a `ReadRows` message to that worker, which runs `GhosttyTerminalState::read_rows`: it moves the viewport pin to `start_row` with the exact `scroll_to_row_start`, extracts the visible rows through the render state, steps the pin down a viewport height at a time until `count` rows are gathered or the buffer is exhausted (a clamp near the bottom can land the pin before `start_row`, so it reads the real offset back and keeps only rows in range), then restores the pin to the active area (`scroll_bottom`) before returning. `count` is clamped to a sane maximum so a pathological request never walks the whole page list at once, and `start_row` past the end returns an empty band. Because every access to the terminal is serialized on that one worker thread, a serve is never interleaved with a live extract, so the user never sees the excursion, and the forced-full frame the restore leaves behind means the next live frame repaints the tail cleanly. The live stream always emits the active area (the tail): the worker re-pins the tail before each live extract and carries no follow-tail flag, because the frontend, not the backend, decides whether the tail is on screen.

Two practical constraints (details in [`libghostty-history-limits.md`](libghostty-history-limits.md)). First, moving the pin deep into scrollback walks the page list and is comparatively expensive, so a band is served once on request and cached on the frontend, never read per cell per frame. Second, the alternate screen has no scrollback (full-screen TUIs). The backend does not gate on this: it serves `read_rows` unconditionally (it only checks the generation) and simply reports `modes.alternate_screen` in each frame. The frontend reads that flag and keeps a separate alternate-screen view, suppressing the scroll-back affordance while on the alternate screen and returning to its primary-screen view when the session leaves it. There is no backend suppression and no backend re-seed.

## The frame model

The wire payload is Reverie's own model, not Ghostty types, which preserves the renderer-independence guardrail.

- A frame is either a **snapshot** (complete for the rows it carries) or a **diff** (changed rows only); a history reply is a band of older rows.
- It carries dimensions, the cursor, a generation, and a list of rows.
- Each row is its position plus a list of cells; each cell is its character or grapheme, display width, foreground color, background color, and style flags.

This is the small per-cell shape every fast terminal converges on. See [`wire-protocol.md`](wire-protocol.md) for the encoding.

## Bounded scrollback (v0)

`libghostty-vt` keeps an in-memory scrollback. That buffer is the entire history we serve; the seed snapshot plus history-range replies deliver it. It is bounded by a memory budget that Reverie sets to 100 MB per session (libghostty's own default is 10 MB), lazily allocated, not a fixed row count; see [`libghostty-history-limits.md`](libghostty-history-limits.md). Rows that scroll past the oldest the buffer holds evict and are gone; we persist nothing, and a restart uses the CLI's resume (D5).

## Many sessions (tiers)

- **Focused:** full 60fps diffs, and it answers history-range requests as the user scrolls.
- **Background, live, off-screen:** keep consuming the PTY and updating state, but throttle hard or suspend frame emission since nothing is painting it. On focus, send a fresh seed snapshot, then resume diffs.
- **Memory:** per-session cost is bounded by the scrollback limit, so dozens stay resident. There is no hard cap (D3). Under real memory pressure, off-screen state may be shed.

Background liveness in the UI (activity indicators) rides Reverie's existing activity signal, not terminal painting.

## Input and resize

- Input: encode keys, paste, mouse, and focus and write the bytes to the PTY. Forward mouse-tracking sequences only when the running app has asked for them.
- Resize: set the PTY size and the core size; the core reflows wrapped lines; bump the generation and emit a fresh snapshot so the frontend re-mirrors at the new geometry and re-issues any history requests against the new generation.

## What the backend does not do

- **No transcript capture.** The backend does not write terminal output to disk. We persist no terminal history.
- **No restore or replay.** A restart resumes the CLI, which re-establishes its own session (D5). The backend never reconstructs a terminal from saved bytes.
- **No search.** Search is a separate product feature; if it is ever built, it sources from the CLIs' own session files, not from the terminal. The terminal core has no part in it.
