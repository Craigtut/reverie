# libghostty 0.2 adoption notes

Status: findings, implemented foundation, and recommended follow-up, 2026-06-18.

Reverie already depends on `libghostty-vt = 0.2.0`, but most of the terminal integration still looks like the 0.1.x design. This note records the useful 0.2.0 APIs and how they map to Reverie's product and terminal architecture.

Implemented so far:

- default foreground/background/cursor color APIs, replacing synthetic OSC 10/11 injection,
- backend paste encoding through `paste::encode`,
- tracked-grid-ref resize anchoring for a scrolled-back primary-screen viewport.

## Current constraints

- Reverie still owns the product model and session continuity. `libghostty` owns only the live terminal state for the current process.
- The frontend still owns the viewport and drives scrollback. The backend must not become a scroll controller.
- Terminal history still is not persisted. New formatter or selection APIs are useful for copy, debug export, and live terminal behavior, not for durable transcript replay.
- The desktop crate enables `libghostty-vt` with `default-features = false` and only `link-dynamic`, so Kitty graphics wrappers are not available unless we explicitly enable that feature.

## Highest-value adoption

### 1. Use tracked grid refs for real anchors

0.2.0 exposes `Terminal::track_grid_ref`, `TrackedGridRef::point`, `TrackedGridRef::snapshot`, and `TrackedGridRef::set`. A tracked ref follows a cell through scrolling, pruning, resize, reflow, and other page-list mutations until that semantic location is discarded.

This directly targets the two workarounds in D8 and D9:

- The stable-row floor is still best-effort. `GhosttyTerminalState` infers `lines_evicted` from drops in `total_rows`, which can drift during heavy append plus prune batches.
- Resize while scrolled back currently re-seeds without preserving the user's top-visible row.

Implemented foundation:

- Add a backend resize path that accepts the frontend's top-visible stable id and column.
- Convert that anchor to a screen point, create or set a tracked grid ref, run `resize`, ask the tracked ref for its new screen point, then return the reflowed row offset on the next full frame.
- Keep the frontend-owned viewport model. The backend only resolves the one anchor during resize.

Current behavior: the frontend passes an optional top-visible stable id when it is scrolled back on the primary screen. The terminal worker tracks that row before resize, resolves its post-resize screen point, scrolls the backend viewport to that point, and emits the normal post-resize full frame. Follow-tail sessions still resize at the tail.

Recommended second implementation:

- Spike replacing or augmenting `lines_evicted` estimation with a small set of backend-owned tracked refs whose known stable ids can be converted back to current screen positions after each write.
- Keep the current `oldest_id` wire shape. If the tracked-ref model proves exact enough, it can be an internal producer for the same field.

Do not replace the `read_rows` pin-step serve yet. 0.2.0 still documents arbitrary `grid_ref` reads as unsuitable for render-loop style extraction, and our current band prefetch reads rows in viewport-sized chunks. Benchmark before changing this path.

### 2. Replace OSC color injection with default color APIs

`GhosttyTerminalState::set_default_colors` currently feeds synthetic OSC 10 and OSC 11 sequences into the terminal. 0.2.0 has first-class default color APIs:

- `set_default_fg_color`
- `set_default_bg_color`
- `set_default_cursor_color`
- `set_default_color_palette`
- effective and default getters for foreground, background, cursor, and palette

Implemented:

- Change `set_default_colors` to call the default color APIs instead of writing OSC.
- Add cursor color and cursor default style/blink configuration while we are there.
- Add an `on_color_scheme` callback so CLIs that query the terminal color scheme get an answer matching Reverie's active theme.

This is low risk and removes a synthetic-input workaround.

### 3. Move paste safety to libghostty

The frontend currently wraps pasted text in bracketed paste markers when the app requested bracketed paste. It does not use Ghostty's paste sanitizer.

0.2.0 exposes:

- `paste::is_safe`
- `paste::encode`

Implemented:

- Add a backend paste command that sends text to the terminal worker.
- On the worker, call `paste::encode(data, bracketed, buf)` using the live bracketed-paste mode from the terminal.
- Keep direct typed key input separate.

This should be prioritized because it strips unsafe control bytes and protects against bracketed-paste end-sequence injection.

### 4. Stop hand-maintaining terminal input protocol tables

The frontend currently owns key encoding, Kitty keyboard encoding, SGR wheel encoding, and part of mouse routing. 0.2.0 exposes canonical encoders:

- `key::Encoder`, configured from `Terminal::set_options_from_terminal`
- `mouse::Encoder`, configured from `Terminal::set_options_from_terminal`
- `focus::Event`

Recommended path:

- Keep app shortcuts in the frontend, such as Command-key menu behavior and selection copy.
- Send normalized input events to the backend worker for terminal-owned encoding.
- Let libghostty encode keys, mouse, focus, Kitty keyboard protocol, cursor-key mode, keypad mode, mouse formats, and future protocol changes.

This reduces drift with Ghostty and avoids growing our TypeScript keyboard protocol tables.

## Medium-value adoption

### 5. Use libghostty selection and formatting for copy fidelity

0.2.0 adds terminal-native selection and gesture APIs:

- `Terminal::select_all`, `select_word`, `select_line`, `select_output`
- `selection::gesture` for press, drag, release, autoscroll, deep press
- `Terminal::format_selection_buf` and `format_selection_alloc`
- row-level and cell-level selected state in the render API

Recommended path:

- Keep the frontend overlay for immediate pointer feedback.
- Add a backend copy/format command that takes selected endpoints, reconstructs a libghostty selection from grid refs, and formats text using Ghostty's selection rules.
- Later, consider moving double-click word selection and triple-click line selection to `selection::gesture`.

This gives better soft-wrap handling, wide-cell behavior, rectangular selection, semantic command-output selection, and future HTML copy. It should not become durable terminal history.

### 6. Surface terminal events that matter to Reverie's shell

0.2.0 has richer effects:

- `on_bell`
- `on_pwd_changed`
- `on_xtversion`
- `on_enquiry`
- `on_size`
- `on_device_attributes`

Recommended use:

- Treat BEL as an attention signal for the session, with throttling.
- Capture OSC 7 pwd as live terminal metadata, not as the stored session cwd.
- Answer device attributes deliberately instead of relying only on default behavior.
- Feed libghostty logs into the dev-channel terminal diagnostics file.

These are shell-quality improvements, not product model changes.

### 7. Add hyperlink and semantic metadata to rows

0.2.0 exposes hyperlink URI reads and semantic prompt/content data through grid refs and row/cell APIs.

Recommended path:

- Extend the wire model with optional hyperlink spans once copy and selection are stable.
- Use semantic prompt/content only for terminal interactions such as selecting command output or click-to-move-cursor support. Do not let this push Reverie toward IDE behavior.

## Deferred adoption

### Kitty graphics

0.2.0 adds a substantial Kitty graphics API behind the `kitty-graphics` feature. Reverie currently does not compile it in.

Adopting it would require:

- enabling the crate feature,
- installing a PNG decoder,
- setting storage limits and allowed media,
- extending the binary wire protocol for image placements and pixel data,
- adding WebGL texture rendering and clipping.

This is valuable for terminal completeness, but it is not the next best use of time for an agent-session workspace. Do it after text fidelity, anchors, paste safety, and input correctness are solid.

## Documentation cleanup

The terminal docs that described `libghostty-vt` 0.1.1 or said tracked pins were unreleased have been updated alongside the tracked-ref resize-anchor implementation:

- `docs/technical/terminal/why-libghostty.md`
- `docs/technical/terminal/libghostty-history-limits.md`
- `docs/technical/terminal/scrollback-coverage-design.md`
- `docs/technical/terminal/decisions.md` D8 and D9
