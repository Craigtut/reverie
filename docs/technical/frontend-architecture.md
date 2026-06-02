# Reverie Frontend Architecture

## Stack decision

Reverie's production app shell should use:

- React for product UI structure and stateful shell composition.
- Panda CSS for styling discipline, design tokens, recipes, and layout primitives.
- Motion for restrained app-shell animation: onboarding, view transitions, focus/session changes, panels, and presence.
- Phosphor Icons for the icon system.
- An imperative WebGL2-first terminal renderer island for terminal frames, with Canvas 2D fallback and a WebGPU-ready backend boundary.

React should own app layout and product state around the terminal. It should not reconcile terminal cells through the DOM.

```text
React app shell
  Workspace / Projects / Focuses / Sessions / settings
        ↓
Terminal component boundary
        ↓
Imperative WebGL2 renderer, Canvas fallback, WebGPU-ready interface
        ↓
Frontend row mirror (bounded, near the viewport) fed by binary dirty-row frames + on-demand history ranges
```

`@react-three/fiber` / `pmndrs/uikit` remains a serious option if Reverie later needs complex responsive canvas UI outside the terminal surface, but it is not the initial terminal foundation. The terminal should stay a narrow imperative renderer boundary that can use WebGL2 today and WebGPU later when the runtime supports it.

## Current implementation boundary

The production-facing `apps/desktop/web/` shell is now a Vite + React app. It uses Panda CSS codegen for the app-shell style layer, Motion for restrained chrome animation, and Phosphor Icons for the icon system.

The terminal renderer remains isolated behind an imperative renderer module:

- `apps/desktop/web/App.tsx` owns the React product shell, workspace/project/focus/session navigation, first create-focus/create-session buttons, metrics UI, and Tauri command/event subscriptions. Its visible selected-session launch path uses stable runtime commands/events: `workspace_shell`, `create_focus`, `create_session`, `start_session`, `terminal_stream_started`, `terminal_frame`, `terminal_exit`, and `terminal_failed`.
- `apps/desktop/src-tauri/src/app_shell.rs` provides a local persistence-backed shell store under the Tauri app data path. The seeded snapshot is now only the first-run bootstrap; subsequent workspace/focus/session changes round-trip through the store.
- `apps/desktop/web/terminal-gpu-renderer.ts` owns the WebGL2-first renderer factory, backend selection, glyph atlas, GPU cell painting, cursor painting, overlays, Canvas fallback, and the WebGPU placeholder boundary. The synchronous factory remains the production WebGL2/Canvas path today; `createTerminalGpuRendererAsync` is the WebGPU-probe path and keeps WebGL2/Canvas fallback behind the same renderer contract.
- `apps/desktop/web/terminal-canvas-renderer.ts` remains the Canvas 2D fallback and synthetic `TerminalFrame` fixture helper.
- `apps/desktop/web/terminal/bufferModel.ts` owns the frontend terminal row mirror: a bounded copy of rows near the viewport, keyed by current buffer position and realigned by the backend's `oldestId` floor on eviction (the stable-id model, see [`terminal/decisions.md`](terminal/decisions.md) D8), with stateless coverage (`cachedRanges` UNION present-viewport rows), selection text, and frame snapshots for rendering. (The pre-rebuild `historyWindowing.ts` replay-window planner was deleted with deep-history replay; history now comes as on-demand row ranges, not replayed transcript windows.)
- `apps/desktop/web/terminal/wireDecode.ts` decodes the binary Channel frames and the history row bands (`decodeRowBand`); `frameModel.ts` and `frameCoalescing.ts` own the paint-window/overscan model and per-frame coalescing.
- `apps/desktop/web/terminal/interaction/mouseEncoding.ts` owns viewport-local SGR mouse sequence encoding for TUIs that enable terminal mouse tracking.
- `apps/desktop/web/terminal/terminalController.ts` owns renderer lifecycle, including WebGL context-loss remount and repaint from the current frontend buffer window, and emits paint samples for frame, scroll, overlay, history, and clear paths. Session metrics now include renderer backend, paint timing, rows/cells painted, WebGL draw calls, GPU upload bytes, and glyph-atlas churn.
- Terminal renderer instances expose typed capabilities (`backend`, GPU acceleration, fallback status, explicit resource ownership). This is the single renderer identity source; metrics and stress proofs read backend identity from this contract so WebGPU can land behind the same boundary without controller-specific backend guessing.
- Terminal renderer instances expose an explicit `dispose()` lifecycle hook. WebGL2 tears down buffers, programs, and glyph atlas textures when the controller remounts, swaps canvases, resets, or handles context loss; Canvas keeps the same boundary with a no-op dispose. This is a small but important WebGPU-ready seam.
- The terminal controller accepts synchronous or asynchronous renderer factories. WebGL2 and Canvas mount synchronously today; a future WebGPU backend can wait for adapter/device acquisition and then repaint the latest composite without changing terminal session or buffer ownership.
- The async WebGPU path now performs the real runtime readiness probe (`navigator.gpu`, a `webgpu` canvas context, adapter, and device acquisition), releases the acquired device, and falls back to WebGL2 until a WebGPU paint backend exists. Renderer backend planning keeps WebGPU out of the synchronous factory and makes the async plan WebGPU-first with WebGL2 and Canvas fallback.
- Renderer remount decisions use the full backing geometry, not just terminal columns: cols, display rows, cell width, cell height, and device pixel ratio. This keeps WebGL2 glyph atlases and future WebGPU resources aligned when the window moves between displays or the terminal font metrics change without a row/column change.
- Pending asynchronous renderer mounts are invalidated when surface geometry or device pixel ratio changes, so a future WebGPU device/adapter acquisition cannot resolve late into the wrong backing size.
- Renderer capabilities also declare partial-paint retention semantics. Canvas 2D can accept sparse dirty-row paints because the browser retains its bitmap, and WebGL2 now accepts sparse dirty-row paints because the renderer owns a retained GPU backbuffer and blits it to the default framebuffer after each update. A future WebGPU backend can choose the same retained semantics behind the same contract.
- The frontend batches incoming `terminal_frame` events onto `requestAnimationFrame`. Every Ghostty-derived frame is still ingested into the row mirror, but the active renderer paints at most once per browser frame. Metrics distinguish backend frames received from frontend frame batches, coalesced frames, and batch paint timings. Timing aggregation keeps exact count, average, and max while retaining a bounded sample window for p95, so long-running sessions do not grow unbounded metrics arrays.
- Rust extracts and serializes partial terminal frames as dirty-row payloads only. Full frames still include the complete visible viewport; partial frames carry only the rows Ghostty marked dirty, and the frontend row mirror preserves unchanged rows locally. (Frames cross a binary Tauri Channel, not the JSON event system; see [`terminal/wire-protocol.md`](terminal/wire-protocol.md).)
- Partial repaint invalidation is row-scoped. The controller adds both previous and current cursor rows to dirty primary-buffer and alternate-screen paints, and renderers only draw cursors on rows included in the current repaint. WebGL2 also scissor-clears rows before translucent partial paints, matching the Canvas fallback's replace-row semantics instead of accumulating old glyphs under alpha blending.
- The terminal surface keeps a hidden textarea as the browser focus and IME composition target. It is positioned on the rendered cursor cell, then committed text still flows through the normal `writeTerminalInput` path. The canvas remains the only visual terminal renderer.
- The frontend tells the Rust terminal runtime which live terminal is visible. The active terminal keeps a 16 ms frame cadence; background terminals keep consuming PTY output and updating their `libghostty` state but emit WebView frames at a lower cadence to avoid multi-session event pressure. (There is no transcript capture anymore; "ingesting" means feeding bytes into the live VT state, not writing a durable transcript.)
- `apps/desktop/web/terminalTypes.ts` mirrors Reverie's serialized `TerminalFrame` shape for frontend consumption.
- The legacy JavaScript proof files remain as syntax-checked reference harnesses while the React shell takes over the visible app surface.

This preserves the important product boundary: React mounts the canvas and subscribes to Rust/Tauri frame events, but it does not reconcile terminal cells through the DOM. Rust/libghostty-vt owns terminal emulation correctness; the frontend owns the renderer, viewport cache, scroll window, overlay paint, and animation-frame scheduling.

## Terminal scrollback contract

> This describes the **v0 rebuild** scroll-back path. The source of truth is [`terminal/frontend.md`](terminal/frontend.md) and [`terminal/scrollback-coverage-design.md`](terminal/scrollback-coverage-design.md); this is the frontend-architecture summary of it. The rebuild **removed** the previous transcript-replay model entirely: there is no durable transcript, no deep-history replay, no run-index segmentation, no legacy-Claude split, and no in-terminal find. Scroll-back is served only from `libghostty`'s in-memory buffer, and a restart resumes the CLI (it does not restore terminal state). Do not reintroduce those.

The scroll-back path is frontend-owned for the viewport and backend-owned for terminal truth:

- Rust/`libghostty-vt` keeps the authoritative grid and the in-memory scrollback and is the single source of history rows. The frontend never persists or parses; it mirrors.
- The frontend keeps a **bounded row mirror** near the viewport (`bufferModel.ts`), keyed by current buffer position. The backend reports an `oldestId` floor (rows evicted so far) on every frame; when it advances, the carried-over mirror and coverage ranges are **realigned** by the delta so each surviving row keeps its place, and history fetches convert position <-> stable id through that floor. This is the backend-computed `StableRowIndex` model (D8); below the scrollback cap `oldestId` is 0 and the machinery is inert.
- Coverage (render-vs-fetch per row) is **stateless and decided by provenance, never content**: a row is renderable without a fetch iff it is in the settled cached ranges or present in the current live viewport (a blank row in the live screen is real content, which is the Ink-tail fix). There is no Confirmed/Provisional state machine to thrash.
- Live primary-buffer views are reconstructed from the frontend mirror after frame ingestion, not from the latest raw backend frame, so a sparse dirty-row partial frame never blanks unchanged rows in the controller's current viewport.
- DOM scrolling moves a spacer and a translated canvas. Painting is windowed with overscan, and scroll repaint work is coalesced through `requestAnimationFrame`. Scrolling reads from the local mirror, so it is instant with no backend round-trip.
- Live output follows the tail only while the user is already near the bottom. If the user scrolls up, new frames land in the mirror without snapping the view; a jump-to-bottom button re-pins to the live tail.
- When the user scrolls beyond cached rows, the frontend prefetches a band of older rows by **stable id** via the `read_terminal_rows(terminalId, startId, count, generation)` command, decodes the returned binary band with `decodeRowBand`, and merges it into the mirror. The fetch is asynchronous and deduped per band; the scroll never waits on it. Reach stops at the oldest row `libghostty` still holds (the 100 MB byte dial); older rows have evicted and are gone.
- Live-scroll jumps into uncached history are latest-only on the frontend. A burst of wheel or scrollbar input keeps only the active fetch and the newest requested target, so it cannot fan out into many concurrent reads.
- The backend may return a wider band than the exact miss; the frontend caches each merged band by id so a given region is read from `libghostty` about once and nearby scroll does not re-fetch.
- On resize, the backend reflows (which renumbers rows), bumps the generation, and emits a fresh `Full` frame; the frontend adopts the new generation, drops the mirror, re-seeds from the snapshot, and re-issues range requests against the new generation. Trim does **not** bump the generation (it advances `oldestId`); clear and alt-screen do not bump it either.
- Frontend history requests are scoped by session id, surface columns/rows, generation, and a monotonic request sequence. A late band, or one whose generation no longer matches, is dropped, as is a band whose rows have since evicted (a negative converted position), so rows from two generations never mix.
- Selection, copy, and an in-view find are **local overlays** over the mirror (the current screen plus the mirrored rows). Cross-session and deep search are deferred to a separate product feature and are not part of the terminal.

## Near-term frontend sequence

1. Keep `npm run build` green so Panda codegen, TypeScript, and Vite stay honest.
2. Expand the local persistence-backed shell store toward real repository/service APIs and durable session status updates.
3. Grow the first-run intent strip into proper create-focus/create-session forms while keeping Project selection optional and General sessions intentional.
4. Keep Motion animations outside the terminal hot path.
5. Use render/scroll instrumentation around the WebGL2 terminal path to tune glyph batching, overlay invalidation, and history-range prefetch sizing. The scroll-back-collapse work that prompted this is fixed (free scroll with placeholders, no cache-wipe on a `total_rows` dip, viewport-sized bidirectional prefetch); see [`implementation-queue.md`](implementation-queue.md) and [`terminal/scrollback-coverage-design.md`](terminal/scrollback-coverage-design.md).
6. Keep WebGPU behind the renderer backend interface until Tauri's WebView runtime supports it reliably.

## Guardrails

- Do not render terminal cells as React DOM.
- Do not let shell animation run inside the terminal paint loop.
- Do not let terminal implementation details leak into workspace/project/focus/session UI.
- Do not couple the app shell to Ghostty-specific APIs; the UI consumes Reverie's `TerminalFrame` event model.
- Do not introduce R3F/uikit until a canvas-scene UI need is clear enough to justify the complexity.
