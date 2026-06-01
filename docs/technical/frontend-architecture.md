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
Frontend terminal buffer/cache fed by Ghostty-derived TerminalFrame events
```

`@react-three/fiber` / `pmndrs/uikit` remains a serious option if Reverie later needs complex responsive canvas UI outside the terminal surface, but it is not the initial terminal foundation. The terminal should stay a narrow imperative renderer boundary that can use WebGL2 today and WebGPU later when the runtime supports it.

## Current implementation boundary

The production-facing `apps/desktop/web/` shell is now a Vite + React app. It uses Panda CSS codegen for the app-shell style layer, Motion for restrained chrome animation, and Phosphor Icons for the icon system.

The terminal renderer remains isolated behind an imperative renderer module:

- `apps/desktop/web/App.tsx` owns the React product shell, workspace/project/focus/session navigation, first create-focus/create-session buttons, metrics UI, and Tauri command/event subscriptions. Its visible selected-session launch path uses stable runtime commands/events: `workspace_shell`, `create_focus`, `create_session`, `start_session`, `terminal_stream_started`, `terminal_frame`, `terminal_exit`, and `terminal_failed`.
- `apps/desktop/src-tauri/src/app_shell.rs` provides a local persistence-backed shell store under the Tauri app data path. The seeded snapshot is now only the first-run bootstrap; subsequent workspace/focus/session changes round-trip through the store.
- `apps/desktop/web/terminal-gpu-renderer.ts` owns the WebGL2-first renderer factory, backend selection, glyph atlas, GPU cell painting, cursor painting, overlays, Canvas fallback, and the WebGPU placeholder boundary. The synchronous factory remains the production WebGL2/Canvas path today; `createTerminalGpuRendererAsync` is the WebGPU-probe path and keeps WebGL2/Canvas fallback behind the same renderer contract.
- `apps/desktop/web/terminal-canvas-renderer.ts` remains the Canvas 2D fallback and synthetic `TerminalFrame` fixture helper.
- `apps/desktop/web/terminal/bufferModel.ts` owns the frontend terminal row cache: live viewport ingestion, sparse history window merging, cached range tracking, selection text, and frame snapshots for rendering.
- `apps/desktop/web/terminal/historyWindowing.ts` owns bounded replay-window planning for lazy deep-history scroll and find navigation.
- `apps/desktop/web/terminal/interaction/mouseEncoding.ts` owns viewport-local SGR mouse sequence encoding for TUIs that enable terminal mouse tracking.
- `apps/desktop/web/terminal/terminalController.ts` owns renderer lifecycle, including WebGL context-loss remount and repaint from the current frontend buffer window, and emits paint samples for frame, scroll, overlay, history, and clear paths. Session metrics now include renderer backend, paint timing, rows/cells painted, WebGL draw calls, GPU upload bytes, and glyph-atlas churn.
- Terminal renderer instances expose typed capabilities (`backend`, GPU acceleration, fallback status, explicit resource ownership). This is the single renderer identity source; metrics and stress proofs read backend identity from this contract so WebGPU can land behind the same boundary without controller-specific backend guessing.
- Terminal renderer instances expose an explicit `dispose()` lifecycle hook. WebGL2 tears down buffers, programs, and glyph atlas textures when the controller remounts, swaps canvases, resets, or handles context loss; Canvas keeps the same boundary with a no-op dispose. This is a small but important WebGPU-ready seam.
- The terminal controller accepts synchronous or asynchronous renderer factories. WebGL2 and Canvas mount synchronously today; a future WebGPU backend can wait for adapter/device acquisition and then repaint the latest composite without changing terminal session or buffer ownership.
- The async WebGPU path now performs the real runtime readiness probe (`navigator.gpu`, a `webgpu` canvas context, adapter, and device acquisition), releases the acquired device, and falls back to WebGL2 until a WebGPU paint backend exists. Renderer backend planning keeps WebGPU out of the synchronous factory and makes the async plan WebGPU-first with WebGL2 and Canvas fallback.
- Renderer remount decisions use the full backing geometry, not just terminal columns: cols, display rows, cell width, cell height, and device pixel ratio. This keeps WebGL2 glyph atlases and future WebGPU resources aligned when the window moves between displays or the terminal font metrics change without a row/column change.
- Pending asynchronous renderer mounts are invalidated when surface geometry or device pixel ratio changes, so a future WebGPU device/adapter acquisition cannot resolve late into the wrong backing size.
- Renderer capabilities also declare partial-paint retention semantics. Canvas 2D can accept sparse dirty-row paints because the browser retains its bitmap, and WebGL2 now accepts sparse dirty-row paints because the renderer owns a retained GPU backbuffer and blits it to the default framebuffer after each update. A future WebGPU backend can choose the same retained semantics behind the same contract.
- The frontend batches incoming `terminal_frame` events onto `requestAnimationFrame`. Every Ghostty-derived frame is still ingested into the sparse buffer, but the active renderer paints at most once per browser frame. Metrics distinguish backend frames received from frontend frame batches, coalesced frames, and batch paint timings. Timing aggregation keeps exact count, average, and max while retaining a bounded sample window for p95, so long-running sessions do not grow unbounded metrics arrays.
- Rust extracts and serializes partial terminal frames as dirty-row payloads only. Full frames still include the complete visible viewport; partial frames carry only the rows Ghostty marked dirty, and the frontend sparse buffer preserves unchanged rows locally.
- Partial repaint invalidation is row-scoped. The controller adds both previous and current cursor rows to dirty primary-buffer and alternate-screen paints, and renderers only draw cursors on rows included in the current repaint. WebGL2 also scissor-clears rows before translucent partial paints, matching the Canvas fallback's replace-row semantics instead of accumulating old glyphs under alpha blending.
- The terminal surface keeps a hidden textarea as the browser focus and IME composition target. It is positioned on the rendered cursor cell, then committed text still flows through the normal `writeTerminalInput` path. The canvas remains the only visual terminal renderer.
- The frontend tells the Rust terminal runtime which live terminal is visible. The active terminal keeps a 16 ms frame cadence; background terminals continue ingesting PTY output and transcript bytes but emit WebView frames at a lower cadence to avoid multi-session event pressure.
- `apps/desktop/web/terminalTypes.ts` mirrors Reverie's serialized `TerminalFrame` shape for frontend consumption.
- The legacy JavaScript proof files remain as syntax-checked reference harnesses while the React shell takes over the visible app surface.

This preserves the important product boundary: React mounts the canvas and subscribes to Rust/Tauri frame events, but it does not reconcile terminal cells through the DOM. Rust/libghostty-vt owns terminal emulation correctness; the frontend owns the renderer, viewport cache, scroll window, overlay paint, and animation-frame scheduling.

## Terminal scrollback contract

The production scrollback path is frontend-owned for interaction and backend-owned for terminal truth:

- Rust/libghostty-vt keeps the authoritative terminal state and durable transcript replay path.
- Durable transcript replay must use the real surface rows and columns, not the larger frontend cache-window size. TUI output from Ink, Claude Code, and similar libraries can depend on viewport height for cursor movement, scroll regions, and wrapping; larger history windows are assembled from multiple correctly-sized replay snapshots.
- Durable transcript replay is segmented by fresh PTY launch. A resumed agent session appends to the same Reverie history, but Rust replays each launch in a new Ghostty state and stitches the rendered rows so stale VT state from an older launch cannot leak into Claude/Ink resume output.
- Legacy Claude transcripts created before persisted run indexes are split at Claude's fresh-launch terminal initialization marker during replay. The heuristic is limited to the first transcript run segment, so newer explicit resumed runs do not get split again by ordinary Claude startup bytes.
- The frontend keeps a bounded live row cache plus sparse replayed history windows keyed by absolute row id.
- Live primary-buffer views are reconstructed from the frontend buffer after frame ingestion, not from the latest raw backend frame. That keeps sparse dirty-row partial frames from blanking unchanged rows in the controller's current viewport state.
- DOM scrolling moves a spacer and translated canvas. Painting is windowed with overscan, and scroll repaint work is coalesced through `requestAnimationFrame`.
- Live output follows the tail only while the user is already near the bottom. If the user scrolls upward, new frames must not snap them back to the tail.
- When the user scrolls beyond cached rows, the frontend asks Rust for a bounded `terminal_history_window` replay and merges it into the sparse cache. Stale responses are rejected by generation id.
- Live-scroll jumps into uncached history are latest-only queued on the frontend. A burst of wheel or scrollbar input cannot fan out into many concurrent transcript replays; only the current replay and the newest requested target survive.
- Rust may return a wider history window than the exact frontend miss. Those prefetch windows are still replayed at the real terminal height, cached in the runtime by transcript shape and surface geometry, and merged into the frontend sparse row cache so nearby scroll does not replay the same Claude/Ink transcript repeatedly.
- Find searches the durable transcript through Rust and returns both match metadata and an initial paintable history window from the same replay, so the UI can jump to matches without loading the whole session.
- Live-buffer search and deep-history info, window, search, and search-window commands run terminal-worker waits, transcript reads, and Ghostty replay on Tauri's blocking runtime rather than the synchronous command handler path.
- Same-query find replays preserve the current active match when it still exists, so a late replay or resize refresh cannot snap navigation back to the first match.
- Find navigation scrolls by the frontend buffer's virtual history height rather than trusting DOM `scrollHeight`, which may lag spacer updates during deep-history swaps.
- Navigating to a find match outside the current sparse cache scrolls the virtual history viewport first, then requests the missing replay window through the same history-window path as manual scroll and merges it into the sparse cache.
- Frontend history requests are also scoped by session id, surface columns/rows, and a monotonic request sequence. A late full-history, search-window, jump, or missing-row response is ignored after a session switch, live-tail return, or geometry change.

## Near-term frontend sequence

1. Keep `npm run build` green so Panda codegen, TypeScript, and Vite stay honest.
2. Expand the local persistence-backed shell store toward real repository/service APIs and durable session status updates.
3. Grow the first-run intent strip into proper create-focus/create-session forms while keeping Project selection optional and General sessions intentional.
4. Keep Motion animations outside the terminal hot path.
5. Use render/scroll instrumentation around the WebGL2 terminal path to tune glyph batching, overlay invalidation, and replay window sizes.
6. Keep WebGPU behind the renderer backend interface until Tauri's WebView runtime supports it reliably.

## Guardrails

- Do not render terminal cells as React DOM.
- Do not let shell animation run inside the terminal paint loop.
- Do not let terminal implementation details leak into workspace/project/focus/session UI.
- Do not couple the app shell to Ghostty-specific APIs; the UI consumes Reverie's `TerminalFrame` event model.
- Do not introduce R3F/uikit until a canvas-scene UI need is clear enough to justify the complexity.
