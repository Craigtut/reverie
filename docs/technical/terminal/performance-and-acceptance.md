# Terminal performance and acceptance

> The yardstick. If the implementation is faithful to this architecture, it meets these. Use this doc to check the build against the design. Scope is v0 (live paint, scroll-back within `libghostty`'s buffer, dozens of sessions). See [`architecture.md`](architecture.md).

## Performance budgets

- **Paint.** The focused session sustains 60fps. A normal frame paints in well under 16.6ms. No frame goes over budget during typing or single-cell animation.
- **Input latency.** Keystroke to on-screen echo is imperceptible: target about one frame, comfortably under 50ms.
- **Scroll, at any depth.** Scrolling within the buffer is local and smooth at 60fps, with no backend round-trip on the hot path, and it stays smooth no matter how far back in the buffer the user is. Topping up older rows is an asynchronous prefetch: a slow fetch shows as "older rows arrive a moment later," never as a scroll stutter or freeze. This is the exact failure we are designing against, terminals that lag the deeper you scroll into a long history.
- **Burst output.** A flood of output (a build log, a several-thousand-line dump) drains without deadlock and without blocking input. Frames coalesce; queues stay bounded.
- **Concurrency.** Dozens of sessions (target 25 to 50) run with the focused one smooth. Background sessions do not drag the focused frame rate.
- **Idle.** A session with no output and no scroll costs near zero CPU and GPU. No busy paint loop.

## Correctness across CLIs (all must paint correctly, live)

- **Claude and other Ink-style CLIs:** alternate screen, live panels, spinners, cursor movement, frequent redraws.
- **Codex, Cortex:** line-oriented output, styles, colors.
- **Plain shells:** standard output, prompts, control sequences.
- **Common to all:** truecolor, bold, italic, underline, inverse, wide CJK and emoji cells, cursor shapes, resize and reflow.

This is live painting plus scroll-back within `libghostty`'s buffer. We persist no history; a restart resumes the CLI. There is no deep-history or replay path to test.

## How to verify

- Renderer unit tests: glyph atlas behavior, instanced paint, dirty-row paint preserving untouched rows, cursor and wide-cell geometry, fallback selection.
- A harness scenario that paints warmed full-window frames and dirty-row frames under a 60fps budget gate.
- A deep-scroll test: fill `libghostty`'s buffer to its limit, scroll from bottom to top, and assert the paint stays at 60fps throughout and that the row top-up never blocks the scroll.
- A multi-session stress: several real PTYs, one foreground, measuring paint time, frames received versus dropped, and inter-frame cadence through the full backend-to-WebView path.
- Per-CLI live-render fixtures: feed representative byte streams (including an Ink-style redraw sequence) and assert the painted result.

Out of scope, not measured: search (a separate feature), and anything involving persisted history (there is none).

## Acceptance checklist (v0 is done when all are true)

- [ ] Focused session sustains 60fps; no over-budget frame during typing or single-cell animation.
- [ ] Keystroke echo is imperceptible.
- [ ] Scrolling within the buffer is local, smooth at 60fps at any depth, and never blocks on the backend.
- [ ] Older rows are fetched as an async prefetch that tops up the mirror ahead of need; reaching not-yet-fetched rows shows a brief fill, not a freeze.
- [ ] At the bottom, the viewport stays pinned and follows new output; scrolled up, a jump-to-bottom button appears and returns to the live tail and re-pins; the button is hidden at the bottom.
- [ ] A burst of output drains without deadlock and without blocking input.
- [ ] Dozens of concurrent sessions run with the focused one smooth and background ones not dragging it.
- [ ] An idle session costs near-zero CPU and GPU.
- [ ] Claude, Codex, Cortex, and a plain shell all paint correctly live, including colors, styles, wide cells, alternate screen, and redraws.
- [ ] No terminal cells are rendered as DOM.
- [ ] No full-grid snapshot crosses the wire per frame; only seed snapshots (on attach, focus, resize), dirty-row diffs, and history-range replies.
- [ ] `libghostty` serves history rows; the frontend drives the viewport (D6).
- [ ] Resume relaunches the CLI with its resume flag; there is no Reverie-side PTY-state restore (D5).

## Faithfulness check (architecture, not just behavior)

The build is faithful to this spec when: the VT core is native in Rust (D1); the wire carries binary seed snapshots, dirty-row diffs, and history-range request/reply over a Channel and Raw Requests, not JSON events (wire-protocol); the frontend is a renderer plus a row mirror plus the viewport, with no VT parsing or reflow, and it drives scrolling while `libghostty` serves rows (D6); resume relaunches the CLI rather than restoring state (D5); and nothing implements search, persisted history, or transcripts (D2, D5). If any of those drift, the implementation has diverged from the source of truth and should be reconciled here or in the code, deliberately, not by accident.
