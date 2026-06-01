# Scrollback coverage and row identity (design)

> How the frontend mirror decides, per row, whether it can render the row it holds or must fetch from the backend, so scroll-back is correct for every CLI (Ink/TUI, line-oriented, plain shells) without ever showing stale or wrongly-blank content. This is a **design to review before implementation**, written so we get the foundation right. Status: proposed. Read alongside [`frontend.md`](frontend.md), [`backend.md`](backend.md), [`wire-protocol.md`](wire-protocol.md), [`libghostty-history-limits.md`](libghostty-history-limits.md), and [`decisions.md`](decisions.md).

## 1. The problem, precisely

The frontend keeps a bounded mirror of rows and must classify every absolute row as one of: **render what I hold** or **fetch it**. The current code makes that decision on a row's *content* (a blank row is treated as "not loaded"), which is wrong in both directions:

- **False miss (the Ink bug):** Ink and TUIs pad their UI with genuinely-blank rows. A blank row at the top of the tail window is real content, but it is excluded from coverage, so the window is a permanent miss and the prefetch re-requests it forever on the redraw cadence. Scroll-back can never extend.
- **False hit (the stale-blank risk):** under load the backend coalesces frames, so a row's content can be written and scrolled off-screen within one coalesce window, leaving a stale blank in the mirror where the backend actually has a real line. If we trusted that blank, scroll-back would show an empty line instead of the real content.

The fix is the principle every robust precedent (mosh, Ghostty's own buffer, Warp, virtualized lists) converges on: **decide coverage by a row's source and freshness, never by its content.** Blank is first-class content. The thing we cannot trust is a row we may have *missed*.

## 2. What the `libghostty-vt` binding actually provides

Grounded in the installed binding (`libghostty-vt` 0.1.1 + `-sys`):

- **By-position reads exist.** `terminal.grid_ref(Point) -> GridRef`, where `Point` is `Active | Viewport | Screen | History` with a `{x, y}` coordinate and **`y` may exceed a page** for `Screen`/`History`. `GridRef::row()` yields the row's cells. So we can read any scrollback row by position **without moving the viewport**. Caveats (binding docs + research): `Screen`/`History` lookups traverse the page list (`O(pages)`, "not built to sustain framerates"), and a `GridRef` is volatile (valid only until the next terminal mutation). Use it for occasional bands, read under the lock, copy out immediately.
- **Positions are buffer-relative.** `scrollbar() -> {offset, len, total}`, `total_rows()`, `scrollback_rows()` all describe the *current* in-memory buffer. When the 100 MB cap is hit and the oldest rows are trimmed, these positions **shift** (position 0 becomes a newer line).
- **Screen kind is available.** `active_screen()` distinguishes primary vs alternate.
- **No stable identity is exposed.** There are no pins, no page serials, and no monotonic "lines ever" counter in the safe binding or the C ABI bindings. `GridRef` carries a `node` pointer, but pages are pooled and recycled, so it is not a stable id.

## 3. Decision: identity is (epoch, buffer position), not pins

The research's ideal was pin-anchored identity that survives scroll/trim/reflow without re-seeding. **The binding does not expose pins or serials, so that model is not achievable without extending a pre-1.0 third-party Zig binding (new C ABI surface + maintenance) or synthesizing line-ids in our backend (fragile: there is no trim signal to count evictions reliably).**

It is also largely unnecessary:

- **Within an epoch (no resize, no trim), buffer positions are stable.** Scrolling is a view operation; appending output adds rows at the bottom and does not renumber existing scrollback rows. So a buffer position already *is* a stable identity for the entire life of a normal (sub-100 MB, no-resize) session, which is the overwhelming majority.
- **Reflow (resize) changes the rows themselves**, so we must re-seed the row mirror regardless; pins would only preserve the scroll *anchor* (which we handle separately, see scenario R), not the row cache.
- **Pins would only add value across a trim** (100 MB+), and even then only to avoid a re-seed.

**Decision:** address rows by **(epoch, buffer-relative absolute row)**. A single per-session `epoch` (the existing generation marker, generalized) is bumped on **resize, full clear (ED 2/3), alternate-screen toggle, and trim**. Within an epoch, a row's position is its stable identity and any row we hold from this epoch is authoritative-by-position. On an epoch bump the frontend re-seeds and re-fetches against the new epoch. Pin-anchored identity is **deferred** to a future binding-extension milestone; trigger to revisit: trim-heavy deep scroll-back in 100 MB+ sessions becomes a real product requirement. The model below is structured so identity can be swapped to pins later without reworking the coverage logic.

Per-row *content versions* (the research's other heavy piece) are also unnecessary here: within an epoch scrollback is immutable, and active-area rows are always carried at their latest value by the live frames, so epoch + provenance subsumes per-row versioning.

## 4. The coverage model

Each mirrored row carries a small **state**, set by its source, never by its content:

- **Confirmed(epoch):** read from an authoritative source at `epoch` — the current live viewport (the tail the backend just sent) or an explicit history fetch. This is coverage; render it (blank or not). 
- **Provisional:** live-captured earlier, then drifted out of the current coverage band. Kept for instant repaint, but **not** coverage; scrolling to it re-fetches. Reconciled (replaced + Confirmed, or discarded) when a fetch or live frame next covers it.
- **Absent:** not held. Render a placeholder; fetch.

Derived rules:

1. **Coverage = the set of Confirmed rows at the current epoch.** A scroll-back paint window is renderable without a fetch iff every row in it is Confirmed at the current epoch. The viewport rectangle is *not* itself a coverage primitive; it is where we render and prefetch.
2. **Live-wins-in-overlap.** When a fetched band overlaps the live tail, the live frame's rows win (they are newer). Coverage is a union; value precedence in the overlap favors the live frame.
3. **Hysteresis band.** Coverage transitions (Confirmed -> Provisional) happen only when a row exits the *coverage band* = viewport +/- overscan, not on a one-row scroll. The prefetch refills the band's leading edge ahead of need. This defuses thrash at the just-scrolled-out boundary and the Ink pad/unpad oscillation.
4. **Reconciliation.** A fetch (or live frame) covering a Provisional row replaces it and marks it Confirmed; if the authoritative value differs from the provisional one, the provisional repaint was wrong and is corrected (no silent stale).
5. **Epoch invalidation.** On an epoch bump (resize/clear/alt/trim) the mirror's Confirmed rows are no longer at the current epoch, so coverage is empty until re-seeded; in-flight fetches carry their issuing epoch and **stale-epoch responses are dropped** on arrival.
6. **Eviction.** The mirror is bounded; evict rows farthest from the coverage band (LRU by distance), never within the band or an in-flight prefetch range.

## 5. Data flow and per-component changes

**Backend (`ghostty.rs`, `runtime.rs`):**
- Rewrite `read_rows(start, count)` to use `grid_ref(Point::Screen{ y })` per row (read under the worker lock, copy cells out immediately, never hold a `GridRef`). This removes the viewport-pin excursion and its restore/error-handling entirely (a net simplification and one fewer class of bug). Keep the `MAX_READ_ROWS` clamp and the empty-past-end behavior.
- Maintain the per-session `epoch: u32` and bump it on resize, full clear, alt-screen toggle, and trim. Resize/clear/alt are directly observable. **Trim detection** is the one hard signal: the binding gives no trim event. Interim approach (v0): treat trim as an accepted edge documented in scenario T, because the frontend mirror is bounded well below the 100 MB cap and follows the tail, so it rarely holds rows near the trim boundary; add explicit trim detection (or a binding extension) when 100 MB+ deep scroll-back is a real requirement. Stamp the epoch on every frame and every band.

**Wire (`wire-protocol.md`):**
- The frame already carries the viewport offset + rows (the "current screen" manifest) and a generation; generalize "generation" to "epoch" and keep stamping it. The row band already carries a generation + start + rows; keep, as the epoch. Fetch requests already carry the generation; ensure stale-epoch responses are dropped on the frontend. No new wire shapes are required; this is a semantics tightening, not a protocol change.

**Frontend (`bufferModel.ts`, `terminalController.ts`, `useTerminalSession.ts`):**
- Replace the content-based `cachedRanges` bookkeeping with per-row **state** (Confirmed(epoch)/Provisional/Absent). Coverage queries (`terminalBufferCachedRangeForRows`, the prefetch miss test) read state, not content.
- Live frame ingest marks the current viewport rows Confirmed(epoch); rows that left the coverage band become Provisional; live wins in overlap.
- Fetch merge marks the band Confirmed(epoch) and reconciles provisional rows; drop a band whose epoch != current.
- Prefetch uses the hysteresis band (overscan) and fetches proactively at the band's leading edge so scroll-up from the tail stays smooth.
- Eviction by distance from the band.

## 6. Scenario analysis

Every scenario the model must handle, with the intended behavior. (B = the bug we are fixing; the rest is the foundation.)

- **N. Normal output, small session.** Output fills the viewport; rows are Confirmed(epoch=1) as live frames arrive; scrolling within the mirror is local. Coverage holds; no fetch needed until past the mirror.
- **B1. Ink/TUI blank-padded tail.** The tail window's top row is blank but in the current viewport -> Confirmed -> covered -> no perpetual miss. **Fixes the reported bug.**
- **B2. Fast initial output (coalesced).** The initial screen's blank rows scroll past within a coalesce window; the frontend never captured their real content. Those rows are no longer in the current viewport and were never fetched -> Provisional -> a scroll-up there re-fetches and gets the real content. **No stale blank shown.**
- **S1. Scroll up beyond the mirror.** The paint window nears the band edge -> prefetch a band via `read_rows` -> merge as Confirmed -> persists. Smooth.
- **S2. Scroll up then back to the tail (overlap).** A fetched band overlaps the live tail; live frames keep updating the tail and win in the overlap by recency. No stale fetched value shadows live output.
- **R. Resize / reflow.** Epoch bumps -> coverage empties -> re-seed from the fresh Full frame -> re-fetch. The scroll *anchor* (the logical position the user was viewing) is preserved best-effort so the view does not jump; the row cache is rebuilt (rows genuinely changed). In-flight fetches from the old epoch are dropped on arrival.
- **A. Alternate screen.** No scrollback on the alt screen (libghostty forces it off); the alt-screen render path carries no buffer and suppresses scroll-back. Entering/leaving bumps the epoch; on return to primary the primary buffer re-seeds.
- **C. Full clear (ED 2/3).** Content is rewritten; epoch bumps; re-seed.
- **T. Trim (100 MB+).** Buffer positions shift. v0: accepted edge (the bounded, tail-following mirror rarely holds rows near the trim boundary). Future: detect trim -> bump epoch (re-seed) or extend the binding for pins. Documented limitation, not silent corruption, because deep scroll-back past the trim point is the only affected path and it is an extreme-session case.
- **RR. Rapid resizes / races.** Each fetch carries its epoch; a response that lands after the epoch advanced is dropped, never written into the current-epoch coverage.
- **TH. Prefetch thrash at the edge.** The hysteresis band (viewport +/- overscan) means a row does not flip Confirmed<->Provisional on a 1-row scroll or on Ink pad/unpad; it must exit the whole band. Prefetch refills the leading edge.
- **E. Eviction.** The mirror is bounded; rows farthest from the band are evicted; never the band or an in-flight prefetch range. A re-scroll to an evicted region re-fetches.
- **BG. Background session.** Not painted, not prefetched; its live frames still update its mirror tail (throttled). On focus, re-seed (a fresh Full frame) and resume.
- **P. Genuinely blank scrollback (padding / blank lines).** A fetched band including blank rows marks them Confirmed; they render as blank, no re-fetch. (Directly honors that blank rows are normal content.)
- **D. Active-area multi-row churn (TUI dashboard).** On-screen rows that rewrite are carried at their latest value by live frames (coalescing sends the latest, not intermediate, over a reliable ordered Channel) -> Confirmed -> rendered correctly. On-screen rows are not subject to the drifted-out staleness.
- **F. Follow-tail + jump-to-bottom.** Pinned at bottom: the viewport (tail) is Confirmed and followed. Scrolled up: unpinned; the jump-to-bottom button returns to the tail and re-pins. Coverage at the tail is always the current viewport.
- **NS. No scrollback (content fits the viewport).** Everything is the current viewport -> all Confirmed -> trivially covered.
- **RC. Fetch returns content differing from a provisional row.** Reconcile: replace + Confirm; the corrected content paints (a provisional guess is never left to rot).

## 7. Implementation plan (phased, each gated by build-green + both reviewers)

- **Phase A (backend):** rewrite `read_rows` to use `grid_ref` (drop the pin-move/restore); generalize the generation to an `epoch` and bump it on resize/clear/alt (trim deferred per scenario T). Tests: `read_rows` returns correct bands via `grid_ref`; epoch bumps on each event.
- **Phase B (frontend coverage model):** replace content-based coverage with per-row state (Confirmed(epoch)/Provisional/Absent); coverage query + prefetch miss test read state; live ingest sets Confirmed/Provisional + live-wins-overlap; fetch merge confirms + reconciles + drops stale-epoch bands; hysteresis band; eviction by distance. Tests: every scenario in section 6 (B1, B2, S1, S2, R, A, C, RR, TH, E, P, D, F, NS, RC).
- **Phase C (wire/epoch tightening):** ensure the epoch is stamped on frames + bands and that stale-epoch fetch responses are dropped; re-seed on epoch bump preserves the scroll anchor.
- **Phase D (verification):** the scenario tests above as the regression suite; the existing "stale blank" guard test is preserved (it is scenario B2); a harness pass against Ink-like fixtures.

## 8. Risks and deferred work

- **Trim (scenario T)** is the one accepted v0 edge; the trigger to address it (detect trim -> epoch bump, or extend the binding for pins) is 100 MB+ deep scroll-back becoming a real need.
- **`grid_ref` cost** (`O(pages)` for deep history) is mitigated by fetching bands and caching them frontend-side (each region read about once), exactly the existing prefetch discipline; never call it per frame.
- **Pin-anchored identity** is the deferred enhancement; the (epoch, position) + provenance architecture here can adopt pins later without reworking coverage, if the binding gains a pin/serial/line-id surface.
