# Resize, reflow, and scroll-back anchoring (findings)

> What happens when the user resizes the window while scrolled back into history, why redraw-heavy TUIs (Ink / Claude Code) look jumbled there while line-oriented CLIs do not, and why we accept it for v0. Builds on [`decisions.md`](decisions.md) (D6, D7, D8) and [`scrollback-coverage-design.md`](scrollback-coverage-design.md). Status: findings + decision (see D9 in `decisions.md`), 2026-06-02.

## The symptom

Scrolled to the live tail, a width resize reflows cleanly for every CLI. Scrolled **up** into history and resizing:

- **Line-oriented CLIs (Codex, Cortex, plain shells): correct.** Text rewraps to the new width; widening refills the space, narrowing rewraps.
- **Redraw-heavy TUIs (Claude Code / Ink): jumbled.** Widening does not fill the new space; narrowing pushes characters from the end of a line down onto a new line, producing mid-word breaks. The live tail still reflows correctly (Ink re-renders the active area at the new width); only the scrolled-back history is wrong.

## Two separable concerns

The resize-while-scrolled-up experience is really two independent problems. Conflating them sent us down the wrong path at first.

1. **Position (the scroll anchor).** After reflow the row count changes, so the same `scrollTop` pixel points at different content and the view jumps. Fixable (see "The position re-anchor" below). Affects all CLIs.
2. **Content (reflow quality).** How good the reflowed scroll-back *looks*. For line-oriented output it reflows cleanly; for a TUI's frozen, hard-wrapped scroll-back it is inherently lossy. This is the Ink jumble, and it is **not** fixable by anchoring.

## Root cause of the content jumble: hard-wrapped scroll-back cannot be reflowed

A terminal can only re-wrap **soft-wrapped** content: a single long logical line that the terminal itself wrapped, which it marks with a wrap-continuation flag so it can rejoin and re-split at the new width. It **cannot** rejoin **hard-wrapped** content: an app that pre-broke its own lines with explicit newlines at its render-time width. Those are independent lines to the terminal; the information about where the logical breaks were is gone.

Verified directly against our installed `libghostty-vt` 0.1.1 with a throwaway probe (since reverted), `total_rows` for the same content across widths:

| content | 40 cols | 80 cols (wider) | 20 cols (narrower) |
| --- | --- | --- | --- |
| soft-wrapped (one long line) | 5 | **4** (rejoined, refilled) | 7 (rewrapped) |
| hard-wrapped (pre-broken lines) | 5 | **5** (did NOT rejoin) | 8 (overflow wrapped down) |

The hard-wrapped row is exactly the reported symptom: widening leaves it flat (does not fill), narrowing overflow-wraps to new lines.

**Ink hard-wraps.** Ink (Claude Code's UI layer) measures and wraps text itself, emitting pre-broken lines, and positions content with cursor moves. So its scroll-back is frozen hard-wrapped output at the width it was rendered. Codex / Cortex / shells emit soft-wrappable long lines, which is why they reflow correctly. This is the entire reason Issue A is Ink-only.

**This is inherent, not our bug.** Confirmed by checking Ghostty's own macOS terminal app: scroll up, resize, and it repaints with the exact same behavior we have. No emulator can un-hard-wrap another app's committed output.

## The position re-anchor (available on our released binding, deferred)

Even though we cannot fix the content, we *can* fix the position jump, and the mechanism is cleaner than expected. Contrary to an earlier assumption (and to D8's note that pins are unavailable), libghostty preserves the **viewport pin** across reflow, and our released binding exposes it. Verified by probe: with the viewport scrolled to a row showing "LINE04...", resizing 20 -> 10 cols kept the viewport on LINE04 (`at_bottom=false`) with its offset moving 6 -> 12 to the reflowed position.

So a future position fix needs no fork (respects D8) and no arbitrary tracked-pin API:

1. On a width resize while scrolled up, the frontend sends its current top-visible row (the anchor) with the resize.
2. The backend moves libghostty's viewport to that row (`scroll_viewport` / the existing `scroll_to_row_start`), calls `resize()` (reflow keeps the pin on that content), reads the new viewport offset (`scrollbar`), restores the viewport to the tail, and reports the reflowed offset on the post-resize Full frame.
3. The frontend sets `scrollTop` to the reflowed offset after it re-seeds at the new generation.

The `scrollbar` read deep in history walks the page list (expensive), but this is once per resize, never per frame.

**Why it is deferred.** It fixes only the position jump, not the content jumble that is the actual user complaint, and Ghostty's own app does not bother to keep the scrolled-back position anchored either. It is a modest, exact improvement that helps every CLI and is worth doing if we revisit, but it does not make Ink scroll-back look clean.

## The corner case: scroll up, resize, then scroll to a new area

This is handled by the existing architecture, and clarifies why the re-anchor is only a one-shot position fix:

- After a resize the generation bumps, the frontend re-seeds, and the spacer is sized to the new reflowed `total_rows`. The whole coordinate system is now the new reflowed space.
- Scrolling to any new area maps `scrollTop -> row` in that new space and fetches those rows from libghostty at the current width. So newly-viewed content is always served reflowed; it never needs the re-anchor "treatment."
- The re-anchor only corrects the one position you were viewing at the instant of the resize. Everything after rides the normal fetch.

There is no gap: position is a one-shot correction, content for all areas is served reflowed automatically (cleanly for line-oriented CLIs, inherently-imperfect for Ink).

## Cross-terminal survey

How mature emulators handle reflowing scrolled-back history (researched from primary sources):

- **iTerm2**: reflows via a `LineBuffer` of raw lines plus width-independent `LineBufferPosition` handles. Cleanest anchoring, but still cannot rejoin an app's hard-wrapped lines.
- **WezTerm**: reflows on logical lines (`last_cell_was_wrapped`); its `StableRowIndex` is stable against eviction, **not** reflow; its core `resize()` fixes only the cursor and does not restore the scrolled-back viewport.
- **xterm.js**: reflows via a per-line `isWrapped` flag; preserves the viewport only by shifting `ybase`/`ydisp` by the row-count delta, and follows the bottom only when already at the bottom. Approximate when scrolled up.
- **Ghostty (the app)**: tracked pins rewritten on every mutation including reflow (the viewport is a pin). Even so, its terminal app shows the same imperfect result reflowing a TUI's hard-wrapped scroll-back, because the limitation is the content, not the anchor.
- **kitty**: deliberately does **not** reflow scroll-back at all; it special-cases only the live prompt. The clearest statement that the industry treats historical reflow as not worth it.

## Decision: accept it for v0 (D9)

Reflowing a redraw-heavy TUI's hard-wrapped scroll-back across a resize is an inherent limitation shared by every terminal, including Ghostty's own app. We do not attempt to "fix" the content. The live tail is correct (the CLI re-renders it), line-oriented CLIs reflow cleanly, and only a TUI's scrolled-back history reflows imperfectly. This is a documented known limitation, not a bug.

## If we revisit

- **Position re-anchor (low cost, exact, recommended first):** the viewport-pin mechanism above. Helps every CLI; does not address the Ink content jumble.
- **During-drag polish (small):** while a scrolled-up reflow is in flight, paint placeholders instead of the stale-width bridge so no old-width junk flashes mid-drag.
- **kitty-style frozen scroll-back (heavy, not recommended):** to make Ink history look clean we would have to stop reflowing it and render the historical region at its original width (letterboxed). That re-introduces a frontend-side frozen-history layer at fixed widths, contradicts D5/D7 (libghostty owns history, persist nothing), echoes the removed transcript approach, and brings its own problems (clipping, variable-width rendering). Out of scope for v0.

## Related

- [`decisions.md`](decisions.md) D6 (the scrolling line), D7 (serve only from libghostty; the resize-reflow argument), D8 (StableRowIndex; the released ABI exposes no tracked pins), D9 (this decision).
- [`scrollback-coverage-design.md`](scrollback-coverage-design.md) for coverage and reflow re-seed.
- [`libghostty-history-limits.md`](libghostty-history-limits.md) for the buffer reach and the reflow caveat.
