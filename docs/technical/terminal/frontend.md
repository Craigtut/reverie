# Terminal frontend (WebView, WebGL2)

> The WebView side: a thin, fast renderer plus the view-state it needs. It paints the cells the backend reports and drives scrolling; it does not parse or own the truth. See [`architecture.md`](architecture.md).

## Responsibilities

- Hold a **mirror** of the rows near the viewport (seed snapshot, applied diffs, and history-range replies), keyed by row position.
- Own the **viewport** (which rows are on screen) and drive scrolling.
- Decide when to ask the backend for more rows (when scrolling up runs the mirror low).
- Rasterize glyphs once into an **atlas** and paint cells as instanced quads at 60fps.
- Redraw only when something changed.
- Capture input (keyboard, paste, IME, mouse) and send it to the backend.

Not its job: VT parsing, wrapping, reflow, or being the history store. It is a renderer plus a cache plus the scroll driver.

## The row mirror (view-state, not domain logic)

The mirror is a copy of the rows near the viewport: seeded by the snapshot, kept current by diffs, and extended upward by history-range replies as the user scrolls back. The authoritative grid and the full history live in Rust; this is the local copy the renderer reads so it never blocks on the backend to draw a frame. Applying a diff replaces the changed rows; applying a snapshot rebuilds the mirror; a history reply prepends older rows. The mirror is bounded, and rows far outside the viewport can be evicted and re-fetched later.

## The renderer

- **Glyph atlas.** Each unique character-and-style is rasterized once into a texture and reused forever. Common ASCII is pre-warmed. A new glyph is rasterized on first sight and added.
- **Two instanced passes.** One pass fills every visible cell's background; one pass stamps every visible cell's glyph sampled from the atlas. Each pass is essentially one GPU draw call over all visible cells.
- **Dirty redraw.** Repaint only on a viewport move or a visible-row change. Do not spin the paint loop when nothing changed, so an idle or background session costs near zero.
- **Backends.** WebGL2 is primary. Canvas 2D is the fallback. WebGPU stays behind the same renderer contract until the WebView runtime supports it reliably.
- **Hard guardrail.** Never render terminal cells as DOM. The terminal is an imperative canvas island.

## Scrolling (the frontend drives it)

- Scrolling moves the viewport pointer over the mirror and repaints from it. It is local: no backend round-trip, so it is instant.
- As the viewport approaches the top of the mirrored rows, the frontend sends a history-range request for a band of older rows, ahead of running out. The backend serves them from `libghostty`'s buffer; the frontend prepends them to the mirror. The user keeps scrolling smoothly while the top-up happens in the background.
- Reach is `libghostty`'s scrollback budget (a dial). Scrolling stops at the oldest row the buffer holds; older rows have evicted and are gone (we persist nothing). The frontend shows that edge as the top of available history.
- Pinned to the bottom, the viewport follows new output. Scrolled up, new output lands in the mirror without moving the view.
- On resize, the generation bumps; the frontend drops its mirror, re-seeds from the fresh snapshot, and re-issues history requests against the new generation. It never mixes rows from two generations, because reflow renumbers them.

## Input

- A hidden text input captures focus, paste, and IME composition, positioned on the cursor cell so candidate windows land in the right place.
- Keys and mouse events are encoded and sent to the backend. Mouse-tracking is forwarded only when the running app requested it; otherwise the mouse drives local selection.
- Selection and copy are local overlays over the mirror. In-view find (the current screen and the mirrored rows) is a local overlay too. Cross-session and deep search are deferred.

## What the frontend deliberately does not do

It does not own or persist history, does not parse or reflow, and does not reach past `libghostty`'s buffer. Scrolling stops at the edge of available history. There is no transcript, no replay, and no search in the renderer; a restart is handled by the CLI's resume, not by the frontend.

## Motion

No animation inside the paint loop. Terminal content animation is whatever the CLI draws through VT (the core handles it, the renderer just paints the result). Shell-level motion (panels, transitions) is separate from the terminal paint loop. This is a guardrail: the paint loop stays a dumb, fast cell painter.
