# libghostty-vt history limits

> How far back `libghostty`'s in-memory scrollback reaches, how it stores and serves rows, and the caveats an embedder must respect when the frontend drives scrolling and the backend serves ranges (D6). This bounds scroll-back; past this edge, rows have evicted and are gone (we persist nothing; a restart resumes the CLI).
>
> Source: verified against the vendored Ghostty source in this repo (Ghostty 1.3.2-dev). File references are to the Ghostty tree (`src/...` and the C headers under `include/ghostty/...`).

## The headline: scrollback is a memory budget, not a row count

`libghostty` bounds scrollback by **bytes of page memory, not by number of rows.** The config option `scrollback-limit` is a byte count, default **10 MB per terminal surface** (`src/config/Config.zig`). When the limit is reached, the oldest lines are evicted. The buffer is allocated lazily up to the limit, so a large limit does not immediately cost memory. Reverie sets this dial to **100 MB per session** (see [`decisions.md`](decisions.md), D7); because allocation is lazy, that ceiling only costs what a session actually produces.

The common "~10k rows" belief is a misread. There is a `10_000` constant in the source, but it is also a byte value (a low struct default used only when an embedder builds a terminal without passing config), not a row count. Reverie should reason about scrollback in **bytes** and convert to an approximate row reach only for display.

Approximate reach: at 8 bytes per cell, 10 MB is on the order of tens of thousands of rows at typical widths, but it varies with width and content. Do not hard-code a row number.

Gotcha: the C header field `GhosttyTerminalOptions.max_scrollback` is documented as a number of lines, but the value flows into a byte-based cap. Treat it as bytes; the Zig source is authoritative and the header comment is misleading.

## How the buffer is structured, and how it evicts

Scrollback and the active area are one structure: a doubly-linked list of fixed-capacity pages (a standard page holds 215 by 215 cells), oldest page first, active page last (`src/terminal/PageList.zig`, `src/terminal/page.zig`). When appending would exceed the byte cap and more than one page exists, the oldest page is popped and recycled (zeroed and reinserted as the new active page) to avoid reallocation. Eviction is therefore page-granular, a whole page of rows at a time, not row-by-row. The limit is per terminal surface; the primary screen and the alternate screen each have their own buffer.

## Reading arbitrary history rows is safe, but not free

This is the load-bearing capability for D6 (the backend serves any range without disturbing the live terminal). It exists, with one important cost caveat.

`libghostty` separates three concepts:

- **Active area:** where the running process writes. Always the last page or pages.
- **Viewport:** what is displayed. It is a marker (active, top, or a pin), not a copy. Moving it is an explicit, separate call. Reading does not touch it.
- **Arbitrary position:** a point tagged active, viewport, screen (full, including scrollback), or history (scrollback only), with a row offset that may exceed a single page.

So the backend can read any range by row offset in history or screen coordinates **without moving the viewport or perturbing the running process.** That is exactly the clean separation our scroll-back design needs.

The cost caveat shapes the implementation:

- The fast path is the **render-state API**, but it is **viewport-bound**: it always reflects wherever the viewport currently is and takes no range argument. This is what the live paint loop uses.
- Arbitrary-range reads use a **grid-reference path** tagged history or screen, and those **traverse the page list to resolve the row, so they are order-of-pages expensive for large scrollback.** The source explicitly says this path is not meant for a render loop.

So the two read paths are different by design: **render-state for the live viewport (fast), grid references for frontend-requested history ranges (slower).** The backend must not call the history path per cell per frame. It resolves a requested band once, copies the rows out immediately, and caches them, because grid references are volatile (valid only until the next terminal mutation, so they must be read under the terminal lock and copied at once).

Total-row and scrollback-row counts (for a scrollbar) are available but are also flagged expensive at arbitrary positions, so cache them and re-query only on writes or resize, not per scroll tick.

## Row identity: trim shifts positions, reflow renumbers them

`libghostty`'s row positions are buffer-relative. **Trim** (eviction at the byte cap) drops the oldest rows, so every position shifts down. **Reflow** (a width change) rewraps soft-wrapped lines, changing how many rows the content occupies and renumbering them; `libghostty` just invalidates its cached row offset. Either way, an absolute-position cache is wrong afterward.

We handle the two differently (see [`decisions.md`](decisions.md) D8 and [`scrollback-coverage-design.md`](scrollback-coverage-design.md)):

- **Trim:** the backend gives each row a stable id (`id = position + lines_evicted`, the WezTerm StableRowIndex pattern). Survivors keep their id, so the frontend's cache stays coherent across eviction with **no re-seed**; it only learns the oldest id advanced. `libghostty-vt` 0.2 tracked refs are useful inside the backend worker for bounded operations such as resize anchoring, but an IPC consumer cannot hold one, so the frontend still needs stable row ids. The catch: the API emits no eviction count, so `lines_evicted` is exact below the cap and best-effort at it (the graceful residual in D8).
- **Reflow:** rewrap genuinely changes the rows, so the id space stays monotonic but what each id resolves to changes. Here we **re-seed**: the wire protocol carries a generation marker (see [`wire-protocol.md`](wire-protocol.md)); on resize, bump the generation, re-seed from a fresh snapshot, re-issue range requests against the new geometry, and re-anchor the viewport. Row-only resizes do not reflow but still shift the active-area/scrollback split, so the safe rule is re-seed on any resize.

## Memory cost, and what it means for dozens of sessions

A cell is exactly 8 bytes. A standard page (215 by 215 cells) is on the order of 395 KB including its side pools. The number that governs cost is the byte cap, not row math: each session's primary scrollback is capped at `scrollback-limit`, which Reverie sets to 100 MB, allocated lazily.

So the theoretical worst case for dozens of sessions is roughly 100 MB per session that actually fills its scrollback (40 full sessions about 4 GB), independent of width because the cap is in bytes. In practice almost no session fills 100 MB, and lazy allocation means idle and short sessions cost far less; background buffers are also shed under memory pressure. The effective levers are shedding off-screen sessions' buffers and the `scrollback-limit` dial. (This excludes Kitty graphics storage, which has its own large separate cap if images are enabled.)

This is what makes D3 (dozens, no hard cap, shed under pressure) affordable, and it names the levers if we ever need to shed: lower the per-session byte cap, or drop off-screen sessions' buffers entirely.

## Other gotchas the embedder must respect

- **The alternate screen has no scrollback.** While a full-screen TUI is on the alternate screen (a TUI menu, vim, htop), scrollback is forced off. The primary screen's scrollback is preserved underneath and returns on exit, but is not appended to during alt-screen use. The frontend should detect the active screen and suppress scroll-back affordances while on the alternate screen.
- **Wide cells use spacer cells.** A double-width glyph is a wide cell followed by a spacer; soft-wrap boundaries use a spacer too. Reconstructing text means skipping spacers, and a wide char occupies two columns. (Our per-cell record already carries display width.)
- **Graphemes are out-of-line.** A cell with combining marks stores only its first codepoint inline; the rest live in a per-page pool and are read separately. One cell is not one character.
- **Soft-wrap is a row flag, not a character.** To rebuild logical lines (for copy, search, or a title), follow the wrap flags; they are also what reflow rewraps.
- **Dirty tracking is two-layer and caller-managed.** The render-state API tracks a global dirty flag and per-row dirty bits independently, and only sets them; the caller must reset both after drawing. Easy to over-draw or drop updates if mishandled.
- **Pages are pooled and recycled, so page pointers are not stable.** Do not hold raw references across terminal mutations. `libghostty-vt` 0.2 tracked refs are owned handles that can survive mutations inside the terminal worker, but they still cannot cross the frontend IPC boundary. That is why we compute our own stable row id for the wire/cache contract (see [`decisions.md`](decisions.md) D8).

## Implications for our design (the short version)

- Live viewport uses the fast render-state path; history scroll-back uses the slower grid-reference path. Two paths by design.
- History reads are order-of-pages expensive, so the backend resolves a requested band once, copies rows out under the lock, and caches them. Never read history per cell per frame. This matches the wire protocol's "prefetch a band, not a row at a time" rule.
- Budget memory in bytes (Reverie sets 100 MB per session, lazy), not rows. The levers for many sessions are shedding background buffers under pressure and the `scrollback-limit` dial.
- Re-seed on any resize; never trust an absolute row index across a width change.
- Suppress scroll-back on the alternate screen from the frontend: the backend keeps serving rows and only reports the `alternate_screen` mode, while the renderer holds a separate alternate-screen view and returns to its primary-screen view when the agent leaves it. No backend gating, no backend re-seed.
- Reach ends at the byte cap, which is a dial we can raise. Past it, the oldest rows have evicted and are gone; we persist nothing. A restart resumes the CLI, not stored history.
