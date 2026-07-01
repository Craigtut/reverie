# Resize, reflow, and scroll-back anchoring (findings)

> What happens when the user resizes the window while scrolled back into history, why redraw-heavy TUIs (Ink / Claude Code) look jumbled there while line-oriented CLIs do not, and what Reverie anchors. Builds on [`decisions.md`](decisions.md) (D6, D7, D8) and [`scrollback-coverage-design.md`](scrollback-coverage-design.md). Status: findings + implemented position anchor, 2026-06-18.

## The symptom

Scrolled to the live tail, a width resize reflows cleanly for every CLI. Scrolled **up** into history and resizing:

- **Line-oriented CLIs (Codex, Cortex, plain shells): correct.** Text rewraps to the new width; widening refills the space, narrowing rewraps.
- **Redraw-heavy TUIs (Claude Code / Ink): jumbled.** Widening does not fill the new space; narrowing pushes characters from the end of a line down onto a new line, producing mid-word breaks. The live tail still reflows correctly (Ink re-renders the active area at the new width); only the scrolled-back history is wrong.

## Two separable concerns

The resize-while-scrolled-up experience is really two independent problems. Conflating them sent us down the wrong path at first.

1. **Position (the scroll anchor).** After reflow the row count changes, so the same `scrollTop` pixel points at different content and the view jumps. Fixed for the primary-screen scrolled-back case (see "The position re-anchor" below). Affects all CLIs.
2. **Content (reflow quality).** How good the reflowed scroll-back *looks*. For line-oriented output it reflows cleanly; for a TUI's frozen, hard-wrapped scroll-back it is inherently lossy. This is the Ink jumble, and it is **not** fixable by anchoring.

## Root cause of the content jumble: hard-wrapped scroll-back cannot be reflowed

A terminal can only re-wrap **soft-wrapped** content: a single long logical line that the terminal itself wrapped, which it marks with a wrap-continuation flag so it can rejoin and re-split at the new width. It **cannot** rejoin **hard-wrapped** content: an app that pre-broke its own lines with explicit newlines at its render-time width. Those are independent lines to the terminal; the information about where the logical breaks were is gone.

Originally verified directly against `libghostty-vt` 0.1.1 with a throwaway probe (since reverted), `total_rows` for the same content across widths:

| content | 40 cols | 80 cols (wider) | 20 cols (narrower) |
| --- | --- | --- | --- |
| soft-wrapped (one long line) | 5 | **4** (rejoined, refilled) | 7 (rewrapped) |
| hard-wrapped (pre-broken lines) | 5 | **5** (did NOT rejoin) | 8 (overflow wrapped down) |

The hard-wrapped row is exactly the reported symptom: widening leaves it flat (does not fill), narrowing overflow-wraps to new lines.

**Ink hard-wraps.** Ink (Claude Code's UI layer) measures and wraps text itself, emitting pre-broken lines, and positions content with cursor moves. So its scroll-back is frozen hard-wrapped output at the width it was rendered. Codex / Cortex / shells emit soft-wrappable long lines, which is why they reflow correctly. This is the entire reason Issue A is Ink-only.

Upstream Ink confirmed this exact failure mode in 2026: when Ink wraps text to terminal width it inserts literal newlines, terminals treat those as hard breaks, and resize reflow cannot recover the original paragraph boundaries. The same thread calls out Claude Code as a visible affected app. See <https://github.com/vadimdemedes/ink/issues/883>.

**This is inherent, not our bug.** Confirmed by checking Ghostty's own macOS terminal app: scroll up, resize, and it repaints with the exact same behavior we have. No emulator can un-hard-wrap another app's committed output.

## The position re-anchor (implemented with libghostty 0.2)

Even though we cannot fix the content, we can fix the position jump. `libghostty-vt` 0.2 exposes tracked grid refs, so Reverie now creates a short-lived tracked ref inside the terminal worker during resize. The tracked ref follows the anchored row through reflow and returns its new screen position.

Current path:

1. On a width resize while scrolled up, the frontend sends its current top-visible row (the anchor) with the resize.
2. The backend maps the stable row id back to the current buffer position, creates `Terminal::track_grid_ref(Point::Screen(...))`, calls `resize()`, then asks the tracked ref for its post-resize screen point.
3. The backend scrolls libghostty's viewport to that reflowed row and emits the normal post-resize Full frame. The frontend adopts that frame and keeps its own viewport model.

Follow-tail sessions still resize at the tail. Alternate-screen sessions do not send a scrollback anchor.

**What it does not fix.** It fixes only the position jump, not the content jumble that is the actual user complaint. It does not make Ink scroll-back look clean.

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

Useful public references:

- `libghostty-vt` 0.2: `Terminal::resize` reflows the primary screen if wraparound mode is enabled; tracked refs follow cells through scrolling, pruning, resize, and reflow. Local source: `libghostty-vt-0.2.0/src/terminal.rs`, `libghostty-vt-0.2.0/src/screen.rs`.
- xterm.js exposes `IBufferLine.isWrapped`, "whether the line is wrapped from the previous line", and documents `translateToString` as per-line only, not accounting for wrap state. See <https://xtermjs.org/docs/api/terminal/interfaces/ibufferline/>.
- VTE/Konsole discussion says the essential prerequisite for rewrap is that each terminal row records whether it ended with soft wrap or hard wrap. See <https://bugs.kde.org/show_bug.cgi?id=196998#c13>.
- Ink issue #916 shows a related resize artifact: after narrowing, old rendered output may occupy more physical rows than Ink's logical line count, making erasure math terminal-dependent. See <https://github.com/vadimdemedes/ink/pull/916>.

## Decision: accept it for v0 (D9)

Reflowing a redraw-heavy TUI's hard-wrapped scroll-back across a resize is an inherent limitation shared by every terminal, including Ghostty's own app. We do not attempt to "fix" the content. The live tail is correct (the CLI re-renders it), line-oriented CLIs reflow cleanly, and only a TUI's scrolled-back history reflows imperfectly. This is a documented known limitation, not a bug.

## If we revisit

- **During-drag polish (small):** while a scrolled-up reflow is in flight, paint placeholders instead of the stale-width bridge so no old-width junk flashes mid-drag.
- **kitty-style frozen scroll-back (heavy, not recommended):** to make Ink history look clean we would have to stop reflowing it and render the historical region at its original width (letterboxed). That re-introduces a frontend-side frozen-history layer at fixed widths, contradicts D5/D7 (libghostty owns history, persist nothing), echoes the removed transcript approach, and brings its own problems (clipping, variable-width rendering). Out of scope for v0.

## Related

- [`decisions.md`](decisions.md) D6 (the scrolling line), D7 (serve only from libghostty; the resize-reflow argument), D8 (StableRowIndex), D9 (this decision).
- [`scrollback-coverage-design.md`](scrollback-coverage-design.md) for coverage and reflow re-seed.
- [`libghostty-history-limits.md`](libghostty-history-limits.md) for the buffer reach and the reflow caveat.
