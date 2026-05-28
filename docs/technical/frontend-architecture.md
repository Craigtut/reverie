# Reverie Frontend Architecture

## Stack decision

Reverie's production app shell should use:

- React for product UI structure and stateful shell composition.
- Panda CSS for styling discipline, design tokens, recipes, and layout primitives.
- Motion for restrained app-shell animation: onboarding, view transitions, focus/session changes, panels, and presence.
- Phosphor Icons for the icon system.
- An imperative Canvas/WebGPU terminal renderer island for terminal frames.

React should own app layout and product state around the terminal. It should not reconcile terminal cells through the DOM.

```text
React app shell
  Workspace / Projects / Focuses / Sessions / settings
        ↓
Terminal component boundary
        ↓
Imperative Canvas/WebGPU renderer
        ↓
Ghostty-derived TerminalFrame event stream from Rust/Tauri
```

`@react-three/fiber` / `pmndrs/uikit` remains a serious option if Reverie later needs complex responsive canvas UI outside the terminal surface, but it is not the initial foundation. The current evidence says Canvas 2D is credible enough for the first v1 terminal renderer while React/Panda build the surrounding product shell.

## Current implementation boundary

The production-facing `apps/desktop/web/` shell is now a Vite + React app. It uses Panda CSS codegen for the app-shell style layer, Motion for restrained chrome animation, and Phosphor Icons for the icon system.

The terminal renderer remains isolated behind an imperative Canvas module:

- `apps/desktop/web/App.tsx` owns the React product shell, workspace/project/focus/session navigation, first create-focus/create-session buttons, metrics UI, and Tauri command/event subscriptions. Its visible selected-session launch path uses stable runtime commands/events: `workspace_shell`, `create_focus`, `create_session`, `start_session`, `terminal_stream_started`, `terminal_frame`, `terminal_exit`, and `terminal_failed`.
- `apps/desktop/src-tauri/src/app_shell.rs` provides a local persistence-backed shell store under the Tauri app data path. The seeded snapshot is now only the first-run bootstrap; subsequent workspace/focus/session changes round-trip through the store.
- `apps/desktop/web/terminal-canvas-renderer.ts` owns Canvas sizing, device-pixel-ratio setup, terminal cell painting, dirty-row selection, cursor painting, synthetic `TerminalFrame` generation, and benchmark percentile helpers.
- `apps/desktop/web/terminalTypes.ts` mirrors Reverie's serialized `TerminalFrame` shape for frontend consumption.
- The legacy JavaScript proof files remain as syntax-checked reference harnesses while the React shell takes over the visible app surface.

This preserves the important product boundary: React mounts the canvas and subscribes to Rust/Tauri frame events, but it does not reconcile terminal cells through the DOM.

## Terminal scrollback contract

The first product scrollback pass is deliberately small and frontend-owned until backend/Ghostty snapshot semantics are proven in real use:

- Runtime launch requests still pass a larger backend `maxScrollback` so Ghostty can retain history, but the visible React shell keeps only a bounded rendered buffer.
- The Canvas is allowed to grow taller than the live terminal viewport inside a native overflow container; React scrolls the container, not terminal cells. The rendered history remains capped under a browser-safe Canvas height budget so long sessions do not silently cross platform canvas limits.
- Live output follows the tail only while the user is already near the bottom. If the user scrolls upward, new frames must not snap them back to the tail.
- The terminal chrome must expose whether the surface is following live output or viewing history, because hidden scroll state makes sessions feel untrustworthy.
- This pass infers scrolled-off rows from adjacent viewport-frame overlap. That is acceptable as a product-feel foothold, not as the final terminal model.
- The next scrollback ownership move should be backend/Ghostty-driven so alternate screen, clears, and full-screen TUIs are modeled intentionally instead of guessed from rendered rows.

## Near-term frontend sequence

1. Keep `npm run build` green so Panda codegen, TypeScript, and Vite stay honest.
2. Expand the local persistence-backed shell store toward real repository/service APIs and durable session status updates.
3. Grow the first-run intent strip into proper create-focus/create-session forms while keeping Project selection optional and General sessions intentional.
4. Keep Motion animations outside the terminal hot path.
5. Only escalate the terminal renderer to WebGPU/WebGL2 if live production-session evidence shows Canvas 2D is the bottleneck.

## Guardrails

- Do not render terminal cells as React DOM.
- Do not let shell animation run inside the terminal paint loop.
- Do not let terminal implementation details leak into workspace/project/focus/session UI.
- Do not couple the app shell to Ghostty-specific APIs; the UI consumes Reverie's `TerminalFrame` event model.
- Do not introduce R3F/uikit until a canvas-scene UI need is clear enough to justify the complexity.
