# Terminal decisions

A log of pivotal, hard-to-reverse terminal decisions: the choice, why, the alternative, and what would make us revisit. For the design these sit inside, see [`architecture.md`](architecture.md).

## D1: `libghostty-vt` runs natively in the Rust backend, not as WASM in the WebView

**Status:** Accepted, 2026-05-31. The VT core is native; this records why we keep it there rather than moving it into the WebView.

**Context.** `libghostty-vt` is the VT core: it parses terminal output and maintains the grid, scrollback, wrapping, and reflow. It does not render. That leaves a fork in where the core runs.

- **Option A (chosen): native.** The core runs in the Rust backend. It streams dirty-row diffs to a thin WebGL2 renderer in the WebView, and serves history ranges on request.
- **Option B: WASM in the WebView.** The core is compiled to WebAssembly and runs next to the renderer; only raw PTY bytes cross the boundary. Precedents exist (`coder/ghostty-web`, `wiedymi/restty`).

**Decision.** Keep the VT core native in the Rust backend.

**Why.** Reverie runs many parallel sessions, most off-screen, that must keep being processed even when nothing renders; that belongs on backend threads, not as N WASM engines in one WebView the browser throttles when backgrounded. The backend already owns the process and the byte stream, so co-locating the core keeps one coherent owner. It is also robust to WebView reloads (the frontend rehydrates from a snapshot) and honors the renderer-independence guardrail.

**When Option B would win.** A single-visible-terminal app with no background sessions. That is not Reverie.

**Revisit if** Reverie stops running concurrent live sessions, or the WebView gains a shared-memory terminal surface.

## D2: v0 scope is paint plus scroll-back within `libghostty`'s buffer; search is a separate feature and is out of scope

**Status:** Accepted, 2026-05-31.

**Decision.** The goal right now is to paint every supported CLI live, performantly, across dozens of sessions, and to let the user scroll back through the history `libghostty` holds in memory. Out of scope: search and any cross-session content index (a separate product feature). We persist no terminal history (see D5); the in-memory buffer is the entire scroll-back reach.

**Why.** The core risk and the core value are the same thing, fast and correct painting of varied CLIs, with smooth scroll-back over what is in memory. Nothing else is needed to prove the terminal works. Keeping the surface small also keeps the architecture honest: there is no transcript, no replay, and no restore machinery to get wrong.

**Consequence.** Scroll-back reaches as far as `libghostty`'s buffer, which is a generous dial (see D7 and [`libghostty-history-limits.md`](libghostty-history-limits.md)). Rows that evict past it are gone, which is acceptable. Search, if built later, sources from the CLIs' own session files, not from terminal history.

**Revisit when** the paint core is solid and we choose to design the (separate) search feature.

## D3: Scale target is dozens of concurrent sessions, no hard cap

**Status:** Accepted, 2026-05-31.

**Decision.** Design to feel great at roughly 25 to 50 concurrent live sessions, degrade gracefully beyond, and never hard-cap. Only the focused session paints at 60fps; background sessions keep running but are throttled or unpainted.

**Why.** It matches Reverie's parallel-session identity. Per-session memory is bounded by `libghostty`'s scrollback budget, so v0 can keep dozens resident. "No hard cap, shed under pressure" is the design intent.

**Consequence.** v0 keeps live sessions resident; aggressive shedding is deferred.

## D4: Per-CLI behavior is handled by the VT core, not special-cased in the renderer

**Status:** Accepted, 2026-05-31.

**Decision.** All CLI-specific terminal behavior (alternate screen, redraws, animations, cursor, colors, wide cells) is handled by `libghostty-vt`. The renderer paints the cells the core reports and knows nothing about which CLI produced them.

**Why.** A correct VT emulator already handles these. Special-casing per CLI in the renderer would be fragile, unnecessary, and would couple the renderer to CLI quirks.

## D5: Resuming a session uses the CLI's own resume; Reverie persists no terminal history

**Status:** Accepted, 2026-05-31. Corrects a conflation in earlier attempts.

**Decision.** To resume a session, Reverie relaunches the agent CLI with its native resume flag (for example `claude --resume <session-id>`), using the CLI-native session id Reverie stored. The CLI restores its own context. Reverie does not snapshot, persist, or replay PTY or terminal state, and it does not keep terminal history across an app restart.

**Why.** The agent CLIs already own durable conversation state and a resume command. Reproducing that ourselves, by saving and restoring the grid or replaying bytes, is duplicate, lossy, and fragile, and it tangled "rendering history" together with "restoring a session." `libghostty` owns only the live history of the running process; a resumed session is a new process with a fresh terminal that the CLI repaints.

**Consequence.** There is no transcript capture for history, no restore-from-disk, and no PTY-state replay anywhere in the terminal. The only durable thing Reverie keeps is its session-to-CLI-session-id mapping and how to launch the resume. "History that survives a restart" is not a requirement and must not reappear in the design.

## D6: The scrolling line: `libghostty` stores and serves history, the frontend drives scrolling

**Status:** Accepted, 2026-05-31. This is the fix for both prior attempts.

**Decision.** `libghostty-vt` owns and stores the live scrollback (its in-memory buffer) and serves ranges of rows on request. The frontend owns the viewport and drives scrolling. The backend reads requested ranges from `libghostty`'s buffer and returns them; it never moves `libghostty`'s viewport in response to a scroll.

**Mechanism.** The frontend renders from a local mirror of rows near the viewport. Scrolling moves the viewport over the mirror (instant, local). As the view nears the top of the mirror, the frontend asks the backend for more rows above; the backend serves them from `libghostty`'s buffer; the frontend extends its mirror. The fetch is a prefetch ahead of need, not a per-scroll round-trip.

**Why.** Attempt one made the backend drive scrolling, so every scroll was a round-trip that moved the viewport and re-emitted rows; that lagged. Attempt two tried to make the frontend own the history. The correct line keeps `libghostty` as the history store and the frontend as the scroll driver, with an asynchronous range fetch between them.

**Bound and caveat.** Reach is `libghostty`'s scrollback budget (see [`libghostty-history-limits.md`](libghostty-history-limits.md)). Past it, the oldest rows have evicted and are gone; we do not persist them. On resize, `libghostty` reflows scrollback, so row numbering changes; the frontend re-seeds from a fresh snapshot and re-issues range requests against the new generation rather than trusting old positions.

## D7: Scroll-back is served only from `libghostty`; the buffer size is a dial, not an architecture decision

**Status:** Accepted, 2026-05-31. Sharpens D6 after a good challenge. `libghostty` is the single source of truth, so we serve scroll-back only from it, never from a persisted copy.

**Decision.**

- `libghostty` is the sole source of truth for everything it holds. The backend serves scroll-back rows only by reading `libghostty`'s live buffer. We persist nothing and serve no stale rows.
- How far back a user can scroll is set by `libghostty`'s scrollback budget, which is a configuration dial. libghostty's own default is 10 MB; **Reverie sets it to 100 MB per session**, which holds a whole session for all but the most extreme cases. It grows lazily, so a budget that large only costs what a session actually produces, and background sessions' buffers are shed under memory pressure.
- The frontend does not receive the whole buffer at once. It holds a window near the viewport and fetches more rows lazily as it scrolls, caching each band so a given region is read from `libghostty` about once. Reads are never done per frame or per cell.

**Why.**

- Keeping `libghostty` as the only source avoids a second, stale copy. The decisive case is resize: when all the history lives in `libghostty`, a width change reflows the whole history correctly and the frontend simply re-seeds. A persisted copy would be at the old width and wrong.
- Reading deep rows from `libghostty` is comparatively expensive (it walks the page list), but only relative to the live viewport, and only a real problem if done in the render loop. As an occasional band prefetch that the frontend then caches, it is cheap. So we minimize reads by caching, not by bulk-dumping the buffer to the frontend, which would not scale to dozens of sessions and would double memory.

**Consequence.** In-session scroll-back, including to the start of most sessions, is handled by setting the dial generously; it adds no new system and persists nothing. There is no durable-history milestone behind this, because a restart uses the CLI's resume (D5).

## D8: Rows carry a backend-computed stable id (StableRowIndex), not a buffer position

**Status:** Accepted, 2026-06-01. Sharpens D6/D7 on *how* the frontend identifies a row across trim, after research into how decoupled renderers (WezTerm, xterm.js, Warp) and Ghostty itself solve it. Full design in [`scrollback-coverage-design.md`](scrollback-coverage-design.md).

**Context.** D6/D7 keep `libghostty` the sole source of truth and have the frontend mirror rows near the viewport. But `libghostty`'s row positions are buffer-relative: when the byte cap is hit and the oldest rows are evicted, every position shifts. A mirror keyed by position therefore desyncs the instant the backend trims, which for Reverie's long agent sessions is normal, not an edge.

- **Option A (chosen): a stable, monotonic per-line id, computed in our backend.** Each row gets `id = buffer_position + lines_evicted`; the backend reports the retained range `[oldest_id, newest_id]`; trim advances `oldest_id` and survivors keep their id (no re-seed); the frontend keys its cache and viewport anchor by id. This is the WezTerm `StableRowIndex` pattern, the canonical answer for a renderer decoupled from the buffer.
- **Option B: hold `libghostty`'s tracked pins across the boundary.** This is what Ghostty's own renderer uses, but it is in-process only (a live pointer into the core's heap); an IPC consumer cannot hold one. The pin/serial machinery is not on the released C ABI, and the forming upstream surface is unreleased and would require pinning a post-release Ghostty commit, i.e. a fork.
- **Option C: keep position keying, re-seed on every trim.** Re-seed churn for an actively-trimming session, and it still cannot keep a scrolled-back view anchored.

**Decision.** Compute a StableRowIndex in the backend (we own the terminal, like WezTerm). Below the cap `lines_evicted == 0`, so `id == position` and the machinery is inert. Trim advances `oldest_id` without a re-seed; only reflow/clear/alt re-seed (a generation bump). We stay on the official `libghostty-vt` release and do not fork.

**Why.** It is the only model that keeps a decoupled frontend coherent across trim *and* append, it makes the coverage fix (provenance, the Ink bug) fall out keyed by id, and it confines the one thing the released library cannot give us to a graceful corner.

**Consequence (the one residual).** Keeping `lines_evicted` exact needs an eviction count the released ABI does not emit, so at the cap while actively flooding *and* scrolled back, the anchor can drift (content stays correct, it self-re-anchors). Never wrong content, never a livelock. It is exact for free, with no architecture change, once `libghostty` ships an eviction/pin signal in a release.

**Revisit when** `libghostty-vt` publishes a release exposing tracked pins, a page serial, or an eviction/line counter: adopt it to make `lines_evicted` exact and retire the residual.

## D9: Reflowing a TUI's hard-wrapped scroll-back across a resize is an accepted limitation, not a bug

**Status:** Accepted, 2026-06-02. Full findings in [`resize-reflow-anchoring.md`](resize-reflow-anchoring.md).

**Context.** Resizing width while scrolled back into history reflows cleanly for line-oriented CLIs (Codex, Cortex, shells) but looks jumbled for redraw-heavy TUIs (Claude Code / Ink): widening does not refill the space, narrowing overflow-wraps to new lines. A terminal can only re-wrap *soft-wrapped* content (a long logical line it wrapped itself, flagged as continuation); it cannot rejoin an app's *hard-wrapped* lines (pre-broken with explicit newlines), because the logical-break information is gone. Ink hard-wraps and positions its output, so its scroll-back is frozen at the render-time width. Verified: Ghostty's own macOS terminal app reflows scrolled-back TUI history with the identical imperfect result, confirming the limit is inherent to the content, not our implementation.

**Decision.** Do not attempt to make a TUI's scrolled-back history reflow cleanly. The live tail is correct (the CLI re-renders it), line-oriented CLIs reflow correctly, and only a TUI's scrolled-back history reflows imperfectly. Treat this as a documented known limitation.

**What we explicitly separated.** Position (the scroll anchor) and content (reflow quality) are different problems. Position is fixable: libghostty preserves the viewport pin across reflow and our released binding exposes it (`scroll_viewport` + `scrollbar`), so a future re-anchor needs no fork (refines D8). It is deferred because it fixes only the position jump, not the content jumble that is the actual complaint, and Ghostty's app does not bother to anchor the scrolled-back position either.

**Revisit if** we want to remove the position jump on resize (cheap, exact, helps every CLI; see the findings doc), or if a product need justifies a frozen/letterboxed historical layer to make TUI history look clean (heavy; contradicts D5/D7).
