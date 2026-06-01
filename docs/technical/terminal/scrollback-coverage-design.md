# Scrollback coverage model (design)

> How the frontend mirror decides, per row, whether it can render the row it holds or must fetch from the backend, so scroll-back is correct for every CLI (Ink/TUI, line-oriented, plain shells) without ever showing stale or wrongly-blank content. This is a **design to review before implementation**, written so we get the foundation right. Status: proposed. Read alongside [`frontend.md`](frontend.md), [`backend.md`](backend.md), [`wire-protocol.md`](wire-protocol.md), [`libghostty-history-limits.md`](libghostty-history-limits.md), and [`decisions.md`](decisions.md).

## 0. Scope: reach is the one dial, and it is settled

How far back you can scroll is libghostty's scrollback budget: a single byte dial, `SCROLLBACK_LIMIT_BYTES` in `apps/desktop/src-tauri/src/terminal/ghostty.rs` (currently 100 MB, lazily allocated, fed to `max_scrollback` at construction). libghostty is the source of truth, and that dial *is* the reach. Beyond it the oldest rows are evicted and gone, because we persist nothing (locked, D5). A multi-GB session cannot scroll to its start; that is the deliberate consequence of the dial, not a defect. Turning the reach up or down is a one-line change to that constant.

This design does **not** add, duplicate, or second-guess that dial, and it introduces no second "window" or memory plane. It is solely about making scroll-back *correct within whatever the dial holds*.

## 1. The problem, precisely

The frontend keeps a bounded mirror of rows and must classify every absolute row as one of: **render what I hold** or **fetch it**. The current code makes that decision on a row's *content* (a blank row is treated as "not loaded"), which is wrong in both directions:

- **False miss (the Ink bug):** Ink and TUIs pad their UI with genuinely-blank rows. A blank row at the top of the tail window is real content, but it is excluded from coverage, so the window is a permanent miss and the prefetch re-requests it forever on the redraw cadence. Scroll-back can never extend. **This is the reported bug, and it happens on short sessions with no trim involved.**
- **False hit (the stale-blank risk):** under load the backend coalesces frames, so a row's content can be written and scrolled off-screen within one coalesce window, leaving a stale blank in the mirror where the backend actually has a real line. If we trusted that blank, scroll-back would show an empty line instead of the real content.

The fix is the principle every robust precedent (mosh, Ghostty's own buffer, Warp, virtualized lists) converges on: **decide coverage by a row's source and freshness, never by its content.** Blank is first-class content. The thing we cannot trust is a row we may have *missed*.

## 2. What the `libghostty-vt` binding actually provides

Grounded in the installed binding (`libghostty-vt` 0.1.1 + `-sys`):

- **By-position reads exist.** `terminal.grid_ref(Point) -> GridRef`, where `Point` is `Active | Viewport | Screen | History` with a `{x, y}` coordinate and **`y` may exceed a page** for `Screen`/`History`. `GridRef::row()` yields the row's cells. So we can read any scrollback row by position **without moving the viewport**. Caveats (binding docs + research): `Screen`/`History` lookups traverse the page list (`O(pages)`, "not built to sustain framerates"), and a `GridRef` is volatile (valid only until the next terminal mutation). Use it for occasional bands, read under the lock, copy out immediately.
- **Positions are buffer-relative.** `scrollbar() -> {offset, len, total}`, `total_rows()`, `scrollback_rows()` all describe the *current* in-memory buffer. When the dial is hit and the oldest rows are trimmed, these positions **shift** (position 0 becomes a newer line).
- **Screen kind is available.** `active_screen()` distinguishes primary vs alternate.
- **No stable identity is exposed.** There are no pins, no page serials, and no monotonic "lines ever" counter in the safe binding or the C ABI bindings. `GridRef` carries a `node` pointer, but pages are pooled and recycled, so it is not a stable id.

## 3. Row identity: just (epoch, buffer position)

Rows are addressed by their buffer-relative position within an `epoch` (the existing generation marker, generalized). Within an epoch, positions are stable: scrolling is a view operation and appending output never renumbers existing rows, so a position already *is* a stable id for the whole life of a normal session. The epoch bumps on the events that genuinely change the row layout - resize/reflow, full clear (ED 2/3), alt-screen toggle - and a bump simply re-seeds the mirror (re-fetch against the new epoch); in-flight fetches carry their epoch so a late, stale-epoch response is dropped.

The one layout change the binding cannot signal is **trim** (when output exceeds the dial and libghostty evicts the oldest rows, shifting positions). We deliberately do **not** solve trim with stable identity / pins:

- The binding exposes no pins, serials, or line counter (section 2), so pins would mean forking a pre-1.0 Zig dependency for a single rare case.
- Trim only affects scroll-back *while* a flood large enough to exceed the dial is actively running - rare, and already lossy by the dial.
- It never corrupts. A post-trim position mismatch is caught by reconciliation (rule 4) and self-corrects with a re-seed, exactly the resize path. Worst case is a transient scroll-position shift, never garbage.

So **trim is handled as graceful re-seed**, and pins stay a documented future option (section 8) we will almost certainly never need. Per-row content versions are likewise unnecessary: within an epoch scrollback is immutable and active-area rows always arrive at their latest value on the live frames, so epoch + provenance subsumes versioning.

## 4. The coverage model

Each mirrored row carries a small **state**, set by its source, never by its content:

- **Confirmed(epoch):** read from an authoritative source at `epoch` - the current live viewport (the tail the backend just sent) or an explicit history fetch. This is coverage; render it (blank or not).
- **Provisional:** live-captured earlier, then drifted out of the current coverage band. Kept for instant repaint, but **not** coverage; scrolling to it re-fetches. Reconciled (replaced + Confirmed, or discarded) when a fetch or live frame next covers it.
- **Absent:** not held. Render a placeholder; fetch.

Derived rules:

1. **Coverage = the set of Confirmed rows at the current epoch.** A scroll-back paint window is renderable without a fetch iff every row in it is Confirmed at the current epoch. The viewport rectangle is *not* itself a coverage primitive; it is where we render and prefetch.
2. **Live-wins-in-overlap.** When a fetched band overlaps the live tail, the live frame's rows win (they are newer). Coverage is a union; value precedence in the overlap favors the live frame.
3. **Hysteresis band.** Coverage transitions (Confirmed -> Provisional) happen only when a row exits the *coverage band* = viewport +/- overscan, not on a one-row scroll. The prefetch refills the band's leading edge ahead of need. This defuses thrash at the just-scrolled-out boundary and the Ink pad/unpad oscillation.
4. **Reconciliation.** A fetch (or live frame) covering a Provisional row replaces it and marks it Confirmed; if the authoritative value differs from the provisional one, the provisional repaint was wrong and is corrected (no silent stale). This rule is also what makes trim safe (section 3): a stale-positioned row is corrected the moment it is re-fetched.
5. **Epoch invalidation.** On an epoch bump (resize/clear/alt) the mirror's Confirmed rows are no longer at the current epoch, so coverage is empty until re-seeded; in-flight fetches carry their issuing epoch and **stale-epoch responses are dropped** on arrival.
6. **Eviction.** The mirror is bounded; evict rows farthest from the coverage band (LRU by distance), never within the band or an in-flight prefetch range.

## 5. Data flow and per-component changes

**Backend (`ghostty.rs`, `runtime.rs`):**
- Rewrite `read_rows(start, count)` to use `grid_ref(Point::Screen{ y })` per row (read under the worker lock, copy cells out immediately, never hold a `GridRef`). This removes the viewport-pin excursion and its restore/error-handling entirely (a net simplification and one fewer class of bug). Keep the `MAX_READ_ROWS` clamp and the empty-past-end behavior.
- Keep the per-session `epoch` (the existing generation) and bump it on resize, full clear, and alt-screen toggle - all directly observable. Trim needs no epoch bump and no detection: it is handled by frontend reconciliation + re-seed (section 3, scenario T). Stamp the epoch on every frame and every band.

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
- **T. Trim (session output exceeds the dial).** libghostty evicts the oldest rows and its positions shift. The mirror follows the tail and is bounded well inside the buffer, so this only bites if you are scrolled back reading during a flood big enough to trim. Behavior: never garbage - a position mismatch is caught by reconciliation (rule 4) and re-seeds, the same path as resize. Perfect anchoring across trim would need stable identity the binding does not expose; it is a documented future option (section 8), not a v0 need.
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

- **Phase A (backend):** rewrite `read_rows` to use `grid_ref` (drop the pin-move/restore); generalize the generation to an `epoch` and bump it on resize/clear/alt (trim needs no special handling - graceful re-seed, scenario T). Tests: `read_rows` returns correct bands via `grid_ref`; epoch bumps on each event.
- **Phase B (frontend coverage model):** replace content-based coverage with per-row state (Confirmed(epoch)/Provisional/Absent); coverage query + prefetch miss test read state; live ingest sets Confirmed/Provisional + live-wins-overlap; fetch merge confirms + reconciles + drops stale-epoch bands; hysteresis band; eviction by distance. Tests: every scenario in section 6 (B1, B2, S1, S2, R, A, C, RR, TH, E, P, D, F, NS, RC).
- **Phase C (wire/epoch tightening):** ensure the epoch is stamped on frames + bands and that stale-epoch fetch responses are dropped; re-seed on epoch bump preserves the scroll anchor.
- **Phase D (verification):** the scenario tests above as the regression suite; the existing "stale blank" guard test is preserved (it is scenario B2); a harness pass against Ink-like fixtures.

## 8. Risks and deferred work

- **Trim (scenario T)** is handled by graceful re-seed, never corruption. Perfect cross-trim anchoring is the only thing pins would buy, and only for scroll-back during an active flood; we revisit *if* that becomes a real complaint, and it would require extending the binding for a pin/serial/line-id surface. The (epoch, position) + provenance architecture here can adopt that later without reworking coverage.
- **`grid_ref` cost** (`O(pages)` for deep history) is mitigated by fetching bands and caching them frontend-side (each region read about once), exactly the existing prefetch discipline; never call it per frame.
- **The reach dial** (`SCROLLBACK_LIMIT_BYTES`) is the single lever for how much history exists; if long sessions need more, raise it there. Unlimited reach would require durable disk-backed history, which is out of scope (D5).
