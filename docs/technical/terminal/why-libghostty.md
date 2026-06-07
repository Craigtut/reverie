# Why libghostty-vt (background)

> Background and provenance for the terminal core: what `libghostty-vt` is, what it gives us, what we still own, and the Rust binding plus build landscape it brings. This is the still-valid research distilled from the original strategy spike (since removed). For the design built on top of it, see [`architecture.md`](architecture.md); for where the core runs, see [`decisions.md`](decisions.md) (D1).

## What libghostty-vt is

`libghostty-vt` is the VT core split out of Ghostty (a high-quality cross-platform terminal written in Zig). It is terminal *emulation*, not a desktop terminal widget. It provides:

- escape-sequence parsing and the authoritative terminal state (the grid)
- an in-memory scrollback
- line wrapping and resize reflow
- input encoding (keys, mouse, focus, paste)
- a render state for incremental, dirty-row render updates
- formatting helpers (plain text, VT, HTML), useful for debugging but not the production renderer

## What we still own

Because the core does not draw and is not a widget, Reverie owns everything around it:

- PTY creation, process spawn, and lifecycle
- input routing and resize handling
- glyph shaping and GPU/canvas rendering in the WebView
- selection, copy, paste
- terminal theming
- cross-platform packaging and the build chain

This split is the renderer-independence guardrail in practice: the core reports cells, the WebGL2 island paints them.

## The Rust binding and build landscape

The Rust path is a third-party binding (origin `uzaaft/libghostty-rs`), shipped as two crates:

- `libghostty-vt` (safe Rust API) plus `libghostty-vt-sys` (raw FFI), pinned at version `0.1.1`.
- Building it requires Zig `0.15.x` on PATH, pinned deliberately because a newer default Zig mis-links (see CLAUDE.md and [`../packaging-and-distribution.md`](../packaging-and-distribution.md)). The `-sys` crate fetches a pinned Ghostty source revision; `GHOSTTY_SOURCE_DIR` can point it at a local checkout.
- The safe wrapper is render-state driven (it hands us the visible cells and rows to draw), and its objects are **not `Send`/`Sync`**. That is why each session's terminal state lives on a single dedicated owner thread, fed by message passing from the PTY reader (see [`backend.md`](backend.md), the per-session owner).
- The API is pre-1.0 and tracks a pinned Ghostty commit, so breaking changes are expected. We stay on the official release rather than pin a post-release Ghostty commit, a fork-like path we have ruled out (see [`decisions.md`](decisions.md) D8).

`ratatui-ghostty` was prior evidence that the same VT core renders cleanly through a Rust UI layer; it is a reference point, not a dependency.

## Related

- [`decisions.md`](decisions.md): D1 (the core runs native in the Rust backend, not WASM) and D8 (stay on the official release, no fork).
- [`backend.md`](backend.md) for the per-session single-threaded owner this binding forces.
- [`../tech-stack.md`](../tech-stack.md) and [`../packaging-and-distribution.md`](../packaging-and-distribution.md) for the build and ship specifics.
