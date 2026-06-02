# Scrollback coverage and stable row identity (design)

> Two coupled questions, answered so scroll-back is correct for every CLI: (1) how the frontend decides, per row, whether it can render the row it holds or must fetch it; (2) how a row keeps a STABLE identity so the frontend's cache and viewport stay coherent when libghostty trims (evicts the oldest rows at the byte cap) and reflows (on resize). This is a **design to review before implementation**; it is the source of truth the implementation is held against. Status: proposed. Read alongside [`frontend.md`](frontend.md), [`backend.md`](backend.md), [`wire-protocol.md`](wire-protocol.md), [`libghostty-history-limits.md`](libghostty-history-limits.md), and [`decisions.md`](decisions.md) (D6, D7, D8).

## 0. Scope: reach is the one dial, and it is settled

How far back you can scroll is libghostty's scrollback budget: a single byte dial, `SCROLLBACK_LIMIT_BYTES` in `apps/desktop/src-tauri/src/terminal/ghostty.rs` (currently 100 MB, lazily allocated, fed to `max_scrollback` at construction). libghostty is the source of truth, and that dial *is* the reach. Beyond it the oldest rows are evicted and gone, because we persist nothing (locked, D5). A multi-GB session cannot scroll to its start; that is the deliberate consequence of the dial, not a defect. Turning the reach up or down is a one-line change to that constant. This design does not add, duplicate, or second-guess that dial; it is solely about making scroll-back *correct within whatever the dial holds*, including while the buffer is actively trimming.

## 1. The two problems, precisely

The frontend keeps a bounded mirror of rows and a viewport. Two distinct correctness problems:

**(a) Coverage decided by content (the Ink bug).** The current code classifies a row as render-vs-fetch by its *content*: a blank row is treated as "not loaded." This is wrong both ways. *False miss:* Ink and TUIs pad with genuinely-blank rows; a blank row in the tail window is real content but is excluded from coverage, so the window is a permanent miss and the prefetch re-requests it forever, so scroll-back never extends (this is the reported bug, on a short session, no trim involved). *False hit:* under load the backend coalesces frames, so a row can be written and scrolled off within one coalesce window, leaving a stale blank in the mirror where the backend has a real line. The fix: **decide coverage by a row's source and freshness, never its content.** Blank is first-class content; the thing we cannot trust is a row we may have *missed*.

**(b) Identity decided by buffer position (desync on trim).** The current mirror keys rows by absolute buffer position. libghostty's positions are buffer-relative: when the oldest rows are trimmed, position 0 becomes a newer line and *every* position shifts. A position-keyed cache therefore silently desyncs the instant the backend evicts. The fix: **give each row a stable identity that survives trim**, so eviction only removes rows, never renumbers the survivors.

## 2. What the `libghostty-vt` binding provides (grounded in the source)

Verified against the installed binding (`libghostty-vt` 0.1.1 + `-sys`, which is the latest published) and the vendored Ghostty source it builds:

- **By-position reads exist, but are single-cell.** `terminal.grid_ref(Point) -> GridRef`, `Point` ∈ `Active | Viewport | Screen | History` with `{x, y}` where `y` may exceed a page for `Screen`/`History`. But `GridRef::row()` only yields row *metadata*; the cells come one at a time from `GridRef::cell()`/`graphemes()`/`style()` for each `(x, y)`, and each `Screen`/`History` lookup traverses the page list (`O(pages)`). So reading a whole row by position costs `cols x O(pages)` — far more than the existing pin-step serve, which moves the viewport pin once per window and reads the whole window via the fast `RenderState` path. **`read_rows` therefore keeps the pin-step serve**; `grid_ref` is held in reserve for a future single-row need. (A `GridRef` is volatile, valid only until the next mutation, so any use must read under the worker lock and copy out immediately.)
- **Positions are buffer-relative.** `scrollbar() -> {offset, len, total}`, `total_rows()`, `scrollback_rows()` describe the *current* buffer; they shift (and `total_rows` decreases) when the oldest page is pruned.
- **No stable identity is exposed on the ABI.** No pin handle, no page-serial accessor, no trim/eviction signal, and no monotonic "lines ever" counter. The machinery exists *inside* Ghostty (tracked pins that the core rewrites on every mutation; a page serial; `Pin.garbage` on eviction), but it is in-process only: Ghostty's own renderer shares the core's heap under a mutex, keeps no scrollback mirror, and re-derives the viewport pin each frame. A renderer across our IPC boundary cannot hold a live pin.
- **The ABI is forming upstream, unreleased.** `main` has begun surfacing this (`grid_ref_track`, `point_from_grid_ref`), but it is incomplete and adopting it means pinning a post-release Ghostty commit, i.e. the fork-like path we have ruled out. So we do not rely on it; we stay on the official release.

## 3. Stable row identity: a backend-computed StableRowIndex

The canonical answer for a renderer decoupled from the buffer is a **stable, monotonic, never-reused per-line id** (WezTerm's `StableRowIndex`; the same shape in xterm.js markers and Warp block ids). Because libghostty does not give us one, **we compute it in our backend**, which owns the terminal, exactly as WezTerm computes it in the side that owns the buffer. This is not a fork; it is our bookkeeping on top of the official library.

Definition and rules:

- **`id = buffer_position + lines_evicted`**, where `lines_evicted` is a per-session monotonic count of rows dropped off the top. Equivalently the backend reports a live retained range **`[oldest_id, newest_id]`** (`oldest_id = lines_evicted`, `newest_id = lines_evicted + total_rows - 1`).
- **Below the cap, `lines_evicted == 0`, so `id == buffer_position`** exactly. The id machinery is inert until the buffer first evicts; the common session never exercises it.
- **Trim:** `lines_evicted += N`. Every surviving row keeps its id; the frontend only learns `oldest_id` advanced and drops the rows below it. **No re-seed.** (This is the decisive win over position-keying, which re-seeds or desyncs on every trim.)
- **Append:** new rows take the next ids; `newest_id` advances; nothing existing is renumbered.
- **Reflow (resize):** rewraps rows, so the *content behind* ids changes even though the id space stays monotonic. We do not remap ids one-to-one (neither does WezTerm); we **re-seed**: bump the generation, drop the cache, and re-fetch. Two honest caveats on the scrolled-back case, both analyzed in [`resize-reflow-anchoring.md`](resize-reflow-anchoring.md) (D9): we do NOT currently re-anchor the scroll *position* across reflow (the viewport keeps its pixel offset, which now maps to different content, so the view jumps); and reflowing a redraw-heavy TUI's hard-wrapped scroll-back is inherently lossy regardless of anchoring. So trim is handled by the id (no re-seed); reflow is handled by re-seed. Together they cover all churn.

**The one honest residual.** Keeping `lines_evicted` exact requires knowing how many rows libghostty evicted, and 0.1.1 emits no eviction signal; eviction happens silently inside the core, and coalesced append+prune within one write batch can mask the count in `total_rows` deltas. So `lines_evicted` is **exact below the cap (zero)** and **best-effort at the cap**. The only user-visible effect is in one corner: scrolled back *while* output is actively flooding past the dial, the anchor can **drift** (content stays correct; the scroll position slides) until it re-anchors. This is graceful, never wrong content and never a livelock, far smaller than position-keying's desync-on-every-trim, the same case WezTerm re-anchors for, and it becomes **exact for free, with no architecture change**, the moment libghostty ships an eviction/pin signal in a release (we swap our estimate for its exact value). Accepted as the price of staying on the official library with no fork (D8).

## 4. The coverage model (stateless provenance; position-keyed with an oldest_id anchor)

Coverage is decided by a row's **source, never its content**, and is computed **statelessly** per query: there is no per-row Confirmed/Provisional state machine that flips as the view scrolls. A row is renderable without a fetch iff it is either:

- in the **settled cached ranges** (rows that arrived with cells on a live frame, plus every fetched history band). These persist, so a non-blank row that has drifted out of the viewport stays covered: its scrollback content is immutable. *(implementation: `cachedRanges`)*
- **present in the current live viewport** (`[viewportOffset, viewportOffset + viewportRows)`). Covered whether or not it has characters, because a blank row in the live screen is real content, not a miss. *(this is the Ink-tail fix)*

A blank row that has **drifted** out of the viewport is in neither set, so a scroll-back to it re-fetches and gets the real content (the stale-blank guard). Fetched blank rows are covered (recorded in the settled ranges). *(implementation: `coverageRanges` = settled ranges UNION present viewport rows.)*

**Identity across trim.** The mirror is keyed by current buffer **position**, and the backend's `oldest_id` (rows evicted so far) is the stable anchor. When `oldest_id` advances, the carried-over mirror + settled ranges are **realigned** down by the delta and anything below 0 is dropped (`realignBufferForEviction`); the history-fetch id<->position conversion uses `oldest_id` at both ends. This is observably equivalent to keying by a permanent id (a survivor is never renumbered relative to the floor), at lower risk to the renderer's position-based paint loop, and it folds into the per-frame mirror rebuild so it is not an extra pass. Below the first eviction `oldest_id` is 0, so all of this is a no-op.

Derived rules:

1. **Trim is not a generation bump.** `oldest_id` advances, the mirror + settled ranges realign, evicted rows drop; survivors keep their place. No re-seed.
2. **A `total_rows` dip is not a reset.** A redraw-heavy TUI (Ink) shrinks and regrows its live area every frame, so the backend's `total_rows` oscillates below the cap with no eviction. A dip does NOT wipe or trim the mirror: the live frame overwrites the active rows and the immutable scroll-back below is kept; the extent follows `total_rows`. Only a genuine collapse to a single screen (`totalRows <= viewportRows`), a reflow, or a metadata-less fresh frame resets the mirror (`applyViewportFrameToBuffer`). Wiping on every dip caused an Ink-only re-fetch flap that read as blank / looping scroll-back.
3. **Live-wins-in-overlap.** A live frame overwrites a row's mirror entry at its position, so the live tail wins over an older fetched value wherever they overlap.
4. **Reflow re-seeds; clear and alt do not.** Only a reflow (resize) bumps the generation and re-seeds. Clear and alt-screen need no bump (see scenarios A and C in section 6 for why).
5. **Drift self-heals.** At the cap `oldest_id` is best-effort (D8). A stale anchor is corrected the moment the affected window is re-fetched, because the fetch round-trips through the *live* `oldest_id` (the merge converts `start_id - oldest_id` and drops a band whose rows have since evicted).
6. **Coverage decides fetch-vs-render, never the scroll gesture.** Coverage answers "can I paint this row without a fetch?" It does NOT gate scrolling: the viewport always moves to wherever the user scrolls and paints blank placeholders for not-yet-fetched rows, which the prefetch fills async (`scrollBufferedToTop`). A coverage-gated scroll once hard-capped scroll-back at the cached tail; that is fixed.
7. **Prefetch lead, not a hysteresis state machine.** Smooth scroll-up comes from prefetching a band ahead of the viewport edge (the controller's viewport-sized overscan, led in both directions) plus in-flight dedup. There is no Confirmed/Provisional state to flip, so there is nothing to thrash.
8. **Cache bound.** The mirror is bounded by a row limit; rows farthest from the viewport are pruned.

## 5. Data flow and per-component changes

**Backend (`ghostty.rs`, `runtime.rs`):**
- Track `lines_evicted: u64` per session (0 until the first eviction; advanced best-effort from `total_rows` deltas at the cap, within a generation). Derive `oldest_id`/`newest_id`.
- Keep the pin-step `read_rows` serve (it moves the viewport pin once per window and reads via the fast `RenderState` path, far cheaper than per-cell `grid_ref`; see section 2). In Phase B it takes an **id range** and maps it to a buffer position at the request boundary (`pos = id - lines_evicted`, clamped to the live range), echoing the served start id.
- Keep the per-session **generation**, bumped **only on resize** (reflow). Clear and alt-screen do **not** bump it (scenarios A and C explain why), and trim does **not**. Stamp the generation + `oldest_id` on every frame (`newest_id` derives from `oldest_id + total_rows`); stamp the served start id on each band.

**Wire (`wire-protocol.md`):**
- Frames carry `generation` + `oldest_id` (a single new u64; `newest_id` derives from the existing `total_rows`) alongside the viewport offset + rows. The history request and the band reply carry the start **id** (u64). This is a small additive tightening (the existing generation marker generalizes), not a new protocol shape.

**Frontend (`bufferModel.ts`, `terminalController.ts`, `useTerminalSession.ts`):**
- Coverage is stateless (section 4): `coverageRanges` = the settled cached ranges UNION the rows present in the current live viewport. No per-row Confirmed/Provisional state.
- The mirror is **position-keyed** and realigned by `oldest_id` on eviction (`realignBufferForEviction`); a live frame overwrites the tail rows in place, so live wins in overlap.
- History fetch addresses by **stable id**: the hook sends `position + getOldestId()`; `mergeLiveRows` converts the band's `start_id` back to a position (`start_id - oldest_id`) and drops a band whose rows have since evicted (negative position).
- On eviction (`oldest_id` advanced this frame), the controller re-anchors `scrollTop` by `-delta * cellHeight` when scrolled up, so the view tracks its content; the follow path keeps the tail pinned otherwise.
- On a generation bump (resize), re-seed; prune the mirror by distance from the viewport.

## 6. Scenario analysis

(B = the bug we are fixing; the rest is the foundation.) Note: a few scenarios below call a row "Confirmed"; that is legacy shorthand from the original plan. The model is now stateless (section 4), so read "Confirmed" as "covered by provenance" (present in a settled range or the live viewport). There is no Confirmed/Provisional state to flip.

- **N. Normal output, small session.** `lines_evicted == 0`, `id == position`. Live frames mark ids Confirmed; scrolling is local. No fetch until past the mirror.
- **B1. Ink/TUI blank-padded tail.** The tail window's top row is blank but in the current viewport -> Confirmed -> covered -> no perpetual miss. **Fixes the reported bug.**
- **B2. Fast initial output (coalesced).** Initial blank rows scroll past within a coalesce window; never captured. Those rows drifted out of the viewport and were never fetched (not settled, not present in the viewport) -> a scroll-up there re-fetches the real content. **No stale blank shown.**
- **S1. Scroll up beyond the mirror.** Window nears the band edge -> prefetch a band by id range, served by the pin-step `read_rows` -> merge as Confirmed -> persists.
- **S2. Scroll up then back to the tail (overlap).** A fetched band overlaps the live tail; live frames win in the overlap by recency.
- **T. Trim (output exceeds the dial).** `oldest_id` advances; the frontend drops ids below it and keeps survivors at their ids; **no re-seed, no desync.** Residual: at the cap while flooding *and* scrolled back, `lines_evicted` is best-effort, so the anchor can drift (content correct, self-re-anchors via reconciliation). Becomes exact when libghostty ships an eviction signal.
- **R. Resize / reflow.** Generation bumps -> coverage empties -> re-seed from the fresh Full frame -> re-fetch by id; the viewport re-anchors to the top-of-view content (best-effort). Old-generation in-flight fetches are dropped.
- **A. Alternate screen.** Handled by the renderer's separate alternate-screen view; the primary buffer is preserved untouched during the alt excursion (its `oldest_id`/positions do not change) and repaints on return, so no generation bump or re-seed is needed.
- **C. Full clear (ED 2/3).** ED 2 (clear screen) grows `total_rows`, so the eviction observer is a no-op. ED 3 (clear scrollback) drops `total_rows`, so the observer over-counts it as eviction and inflates `oldest_id`; but the frontend realigns by that same inflated delta consistently and the cleared rows shift out of the mirror, so content stays correct without a generation bump (the scroll anchor may jump, the accepted at-cap drift).
- **RR. Rapid resizes / races.** Each fetch carries its generation; a response landing after the generation advanced is dropped.
- **TH. Prefetch thrash at the edge.** Coverage is stateless -- there is no Confirmed/Provisional state to flip -- so a 1-row scroll or Ink pad/unpad cannot thrash it; the prefetch overscan + in-flight dedup keep the leading edge filled ahead of the scroll.
- **E. Cache eviction.** Frontend mirror is bounded; ids farthest from the band are evicted; never the band or an in-flight prefetch. Re-scroll re-fetches.
- **BG. Background session.** Not painted/prefetched; live frames still update its tail (throttled). On focus, re-seed and resume.
- **P. Genuinely blank scrollback (padding / blank lines).** A fetched band including blank rows marks those ids Confirmed; they render blank, no re-fetch.
- **D. Active-area multi-row churn (TUI dashboard).** On-screen rows that rewrite arrive at their latest value on live frames (coalescing sends the latest over a reliable ordered Channel) -> Confirmed -> correct.
- **F. Follow-tail + jump-to-bottom.** Pinned at bottom: the viewport (tail) is Confirmed and followed. Scrolled up: unpinned; jump-to-bottom returns to the tail and re-pins.
- **NS. No scrollback (fits the viewport).** Everything is the current viewport -> all Confirmed.
- **RC. Fetch returns content differing from a stale mirror row.** The merge overwrites the row at its position with the authoritative value; corrected content paints. The merge *is* the reconciliation -- there is no separate provisional step.

## 7. Implementation plan (phased, each gated by build-green + both reviewers)

- **Phase A (backend stable-id foundation) [done]:** track `lines_evicted` and report `oldest_id` (the floor; `newest_id` derives from `oldest_id + total_rows`) on every frame, carried as a u64 through the binary wire + the TS decoder (golden vectors updated in lockstep). `read_rows` stays the pin-step serve. Tests: `id == position` below the cap; `oldest_id` advances on eviction; reflow is not miscounted as eviction.
- **Phase B (the id cutover + frontend coverage) [done]:** the coordinated switch to id addressing. Backend: `read_rows` / the `ReadRows` command / the band take a start **id** (the worker maps id -> position via `lines_evicted` and echoes the served id). Frontend: coverage is **stateless** (settled ranges UNION present-viewport rows, section 4) -- this is the Ink fix; the **position-keyed mirror is realigned by `oldest_id` on eviction** (`realignBufferForEviction`) so scroll-back survives trim; the history fetch addresses by stable id (`mergeLiveRows` converts back, dropping evicted bands); the view re-anchors on eviction. Generation bumps only on resize -- clear and alt-screen are handled without a bump (scenarios A, C). The Confirmed/Provisional/hysteresis state machine in the original plan was collapsed to the simpler stateless model (no state to flip). Tests: coverage by provenance (Ink + drifted-blank guard) and the eviction realignment in `bufferModel.test.ts`.
- **Phase D (verification):** the remaining scenario coverage as a regression suite -- the controller's eviction re-anchor + the band-evicted-during-fetch drop (scenarios T/RC), and an ED-3 backend invariant test (scenario C) -- plus a full `npm run check` and a harness pass against Ink-like fixtures.

## 8. Risks and deferred work

- **At-cap id drift (the residual)** is graceful (content correct, self-healing) and becomes exact when libghostty exposes an eviction/pin signal in a release; the StableRowIndex architecture adopts it with no rework. Tracked in [`decisions.md`](decisions.md) D8.
- **History-read cost** (the pin-step serve walks the page list, `O(pages)` deep) is mitigated by fetching whole bands and caching by id (each region read about once); never per frame. (`grid_ref` was rejected for band reads: it is a single-cell resolver, so a band would cost `cols x O(pages)`; see section 2.)
- **The reach dial** (`SCROLLBACK_LIMIT_BYTES`) is the single lever for how much history exists; raise it there if long sessions need more. Unlimited reach would need durable disk-backed history, which is out of scope (D5).
