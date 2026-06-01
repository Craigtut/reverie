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
- **Reflow (resize):** rewraps rows, so the *content behind* ids changes even though the id space stays monotonic. We do not remap ids one-to-one (neither does WezTerm); we **re-seed**: bump the generation, drop the cache, re-fetch, and re-anchor the viewport to the content at the top of the prior view (best-effort). So trim is handled by the id (no re-seed); reflow is handled by re-seed. Together they cover all churn.

**The one honest residual.** Keeping `lines_evicted` exact requires knowing how many rows libghostty evicted, and 0.1.1 emits no eviction signal; eviction happens silently inside the core, and coalesced append+prune within one write batch can mask the count in `total_rows` deltas. So `lines_evicted` is **exact below the cap (zero)** and **best-effort at the cap**. The only user-visible effect is in one corner: scrolled back *while* output is actively flooding past the dial, the anchor can **drift** (content stays correct; the scroll position slides) until it re-anchors. This is graceful, never wrong content and never a livelock, far smaller than position-keying's desync-on-every-trim, the same case WezTerm re-anchors for, and it becomes **exact for free, with no architecture change**, the moment libghostty ships an eviction/pin signal in a release (we swap our estimate for its exact value). Accepted as the price of staying on the official library with no fork (D8).

## 4. The coverage model (keyed by stable id)

Each mirrored row carries a **state**, set by its source, never by its content:

- **Confirmed(generation):** read from an authoritative source in the current generation, the live viewport (the tail the backend just sent) or an explicit history fetch. This is coverage; render it, blank or not.
- **Provisional:** live-captured earlier, then drifted out of the coverage band. Render for instant repaint, but not coverage; scrolling to it re-fetches; reconciled (replaced + Confirmed, or discarded) when a fetch or live frame next covers it.
- **Absent:** not held. Render a placeholder; fetch.

Rows are keyed by **stable id**; coverage is evaluated within the current **generation** (the reflow/clear/alt marker). Derived rules:

1. **Coverage = the Confirmed rows (by id) in the current generation.** A paint window is renderable without a fetch iff every id in it is Confirmed. The viewport is where we render and prefetch, not itself a coverage primitive.
2. **Live-wins-in-overlap.** Where a fetched band overlaps the live tail, the live frame's rows win (newer).
3. **Hysteresis band.** Confirmed -> Provisional happens only when an id exits the coverage band (viewport +/- overscan), not on a one-row scroll; the prefetch refills the leading edge ahead of need. Defuses thrash at the just-scrolled-out boundary and the Ink pad/unpad oscillation.
4. **Reconciliation.** A fetch (or live frame) covering a Provisional id replaces it and marks it Confirmed; if the authoritative value differs, the provisional repaint was wrong and is corrected. This is also what makes the at-cap id drift self-heal: a re-fetch reconciles whatever the ids now resolve to.
5. **Trim is not a generation bump.** `oldest_id` advances, evicted ids are dropped, survivors stay Confirmed. The cache is untouched above `oldest_id`.
6. **Generation invalidation (reflow/clear/alt only).** On a generation bump, Confirmed rows are stale, coverage empties, re-seed; in-flight fetches carry their generation and stale-generation responses are dropped.
7. **Eviction (frontend cache bound).** The mirror is bounded; evict ids farthest from the coverage band (LRU by distance), never within the band or an in-flight prefetch range.

Per-row content versions are unnecessary: within a generation scrollback is immutable and active-area rows always arrive at their latest value on the live frames, so generation + id + provenance subsumes versioning.

## 5. Data flow and per-component changes

**Backend (`ghostty.rs`, `runtime.rs`):**
- Track `lines_evicted: u64` per session (0 until the first eviction; advanced best-effort from `total_rows` deltas at the cap, within a generation). Derive `oldest_id`/`newest_id`.
- Keep the pin-step `read_rows` serve (it moves the viewport pin once per window and reads via the fast `RenderState` path, far cheaper than per-cell `grid_ref`; see section 2). In Phase B it takes an **id range** and maps it to a buffer position at the request boundary (`pos = id - lines_evicted`, clamped to the live range), echoing the served start id.
- Keep the per-session **generation**. Phase A bumps it on resize (the existing behavior); Phase B adds full-clear and alt-screen-toggle bumps alongside the frontend's re-seed handling. Trim does **not** bump it. Stamp the generation + `oldest_id` on every frame (`newest_id` derives from `oldest_id + total_rows`); Phase B stamps the served id on each band.

**Wire (`wire-protocol.md`):**
- Frames carry `generation` + `oldest_id` (a single new u64; `newest_id` derives from the existing `total_rows`) alongside the viewport offset + rows. In Phase B the history request and the band reply carry the start **id**. This is a small additive tightening (the existing generation marker generalizes), not a new protocol shape.

**Frontend (`bufferModel.ts`, `terminalController.ts`, `useTerminalSession.ts`):**
- Key the mirror and cache by **stable id**; coverage queries and the prefetch miss test read per-id state, not content.
- Live ingest marks current-viewport ids Confirmed(generation); ids that leave the coverage band become Provisional; live wins in overlap.
- Fetch merge marks the band Confirmed(generation), reconciles provisional ids, and drops a band whose generation != current.
- Anchor the viewport to a stable id. On trim (the frame's `oldest_id` advanced), drop ids below `oldest_id`, keep the rest. On a generation bump, re-seed and re-anchor to the top-of-view id.
- Prefetch on the hysteresis band; evict by id-distance.

## 6. Scenario analysis

(B = the bug we are fixing; the rest is the foundation.)

- **N. Normal output, small session.** `lines_evicted == 0`, `id == position`. Live frames mark ids Confirmed; scrolling is local. No fetch until past the mirror.
- **B1. Ink/TUI blank-padded tail.** The tail window's top row is blank but in the current viewport -> Confirmed -> covered -> no perpetual miss. **Fixes the reported bug.**
- **B2. Fast initial output (coalesced).** Initial blank rows scroll past within a coalesce window; never captured. Those ids left the viewport and were never fetched -> Provisional -> scroll-up there re-fetches the real content. **No stale blank shown.**
- **S1. Scroll up beyond the mirror.** Window nears the band edge -> prefetch a band by id range, served by the pin-step `read_rows` -> merge as Confirmed -> persists.
- **S2. Scroll up then back to the tail (overlap).** A fetched band overlaps the live tail; live frames win in the overlap by recency.
- **T. Trim (output exceeds the dial).** `oldest_id` advances; the frontend drops ids below it and keeps survivors at their ids; **no re-seed, no desync.** Residual: at the cap while flooding *and* scrolled back, `lines_evicted` is best-effort, so the anchor can drift (content correct, self-re-anchors via reconciliation). Becomes exact when libghostty ships an eviction signal.
- **R. Resize / reflow.** Generation bumps -> coverage empties -> re-seed from the fresh Full frame -> re-fetch by id; the viewport re-anchors to the top-of-view content (best-effort). Old-generation in-flight fetches are dropped.
- **A. Alternate screen.** No scrollback on alt (libghostty forces it off); suppress scroll-back; generation bumps on enter/leave; primary re-seeds on return.
- **C. Full clear (ED 2/3).** Content rewritten; generation bumps; re-seed.
- **RR. Rapid resizes / races.** Each fetch carries its generation; a response landing after the generation advanced is dropped.
- **TH. Prefetch thrash at the edge.** The hysteresis band means an id does not flip Confirmed<->Provisional on a 1-row scroll or Ink pad/unpad; it must exit the band.
- **E. Cache eviction.** Frontend mirror is bounded; ids farthest from the band are evicted; never the band or an in-flight prefetch. Re-scroll re-fetches.
- **BG. Background session.** Not painted/prefetched; live frames still update its tail (throttled). On focus, re-seed and resume.
- **P. Genuinely blank scrollback (padding / blank lines).** A fetched band including blank rows marks those ids Confirmed; they render blank, no re-fetch.
- **D. Active-area multi-row churn (TUI dashboard).** On-screen rows that rewrite arrive at their latest value on live frames (coalescing sends the latest over a reliable ordered Channel) -> Confirmed -> correct.
- **F. Follow-tail + jump-to-bottom.** Pinned at bottom: the viewport (tail) is Confirmed and followed. Scrolled up: unpinned; jump-to-bottom returns to the tail and re-pins.
- **NS. No scrollback (fits the viewport).** Everything is the current viewport -> all Confirmed.
- **RC. Fetch returns content differing from a Provisional id.** Reconcile: replace + Confirm; corrected content paints.

## 7. Implementation plan (phased, each gated by build-green + both reviewers)

- **Phase A (backend stable-id foundation) [done]:** track `lines_evicted` and report `oldest_id` (the floor; `newest_id` derives from `oldest_id + total_rows`) on every frame, carried as a u64 through the binary wire + the TS decoder (golden vectors updated in lockstep). `read_rows` stays the pin-step serve. Tests: `id == position` below the cap; `oldest_id` advances on eviction; reflow is not miscounted as eviction.
- **Phase B (the id cutover + frontend coverage):** the coordinated switch to id addressing. Backend: `read_rows` / the `ReadRows` command / the band take a start **id** (the worker maps id -> position via `lines_evicted` and echoes the served id); generation also bumps on full clear / alt-screen toggle. Frontend: key the cache/coverage by stable id with per-id state (Confirmed(generation)/Provisional/Absent); live ingest + fetch merge + reconciliation + live-wins-overlap; trim drops below `oldest_id` without re-seed; a generation bump re-seeds + re-anchors; hysteresis; id-distance eviction. Tests: every scenario in section 6, including batched/coalesced-write drift (the at-cap residual the reconciliation must heal).
- **Phase D (verification):** the scenario tests as the regression suite (the existing "stale blank" guard is scenario B2); a harness pass against Ink-like fixtures.

## 8. Risks and deferred work

- **At-cap id drift (the residual)** is graceful (content correct, self-healing) and becomes exact when libghostty exposes an eviction/pin signal in a release; the StableRowIndex architecture adopts it with no rework. Tracked in [`decisions.md`](decisions.md) D8.
- **History-read cost** (the pin-step serve walks the page list, `O(pages)` deep) is mitigated by fetching whole bands and caching by id (each region read about once); never per frame. (`grid_ref` was rejected for band reads: it is a single-cell resolver, so a band would cost `cols x O(pages)`; see section 2.)
- **The reach dial** (`SCROLLBACK_LIMIT_BYTES`) is the single lever for how much history exists; raise it there if long sessions need more. Unlimited reach would need durable disk-backed history, which is out of scope (D5).
