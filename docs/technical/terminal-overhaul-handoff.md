# Terminal Overhaul Handoff

This is the focused handoff for the terminal renderer overhaul. It exists to stop the broad iteration loop and give the next session a clear target list.

## Original Direction

The target architecture is still sound:

1. Keep terminal emulation in Rust with `libghostty-vt`.
2. Keep Reverie's product/domain layer renderer-agnostic. The UI consumes `TerminalFrame`.
3. Let the frontend own a sparse row cache, scroll position, selection/find/link overlays, and paint scheduling.
4. Render terminal cells through an imperative canvas island. WebGL2 is the current primary renderer, Canvas 2D is fallback, and WebGPU remains a future backend behind the same renderer contract.
5. Preserve terminal behavior for line-oriented CLIs and Ink-style TUIs, including character animations, cursor movement, alternate screen, scrollback, find, copy, links, and history replay.

Do not move terminal cells to React DOM. Do not continue broad architecture research unless a concrete failing test proves the current shape cannot support the product.

## Current State

### Backend

Implemented or materially in place:

- `apps/desktop/src-tauri/src/terminal/ghostty.rs` owns the Ghostty-backed terminal state and emits `TerminalFrame`.
- Backend partial frames now serialize only changed rows.
- PTY lifecycle, input, resize, theme defaults, and terminal frame events are in the Tauri runtime.
- Durable raw PTY transcript capture exists.
- Transcript chunks have `run_index`, so resumed PTY launches can replay as separate Ghostty states.
- Deep-history commands can return total rows, replayed windows, and search-plus-window responses.
- History replay preserves real viewport height instead of replaying a taller fake terminal, which matters for Ink-style apps.

Important caveat: raw PTY replay is not the same as a semantic conversation transcript. Claude Code can redraw a screen using cursor moves and Ink. Replaying every byte can preserve intermediate visual states that users do not think of as history.

### Frontend Model

Implemented or materially in place:

- `apps/desktop/web/terminal/bufferModel.ts` owns a sparse absolute-row cache.
- `apps/desktop/web/terminal/terminalController.ts` owns scroll state, history mode, dirty row application, overlays, and renderer lifecycle.
- Live primary-buffer frames are rebuilt from the frontend cache, so sparse partial payloads are not treated as full snapshots.
- Find, selection text, link overlay, and lazy missing-history-row loading are buffer-backed.
- History jumps use a latest-only queue so rapid scroll does not trigger one replay per intermediate row.
- Height-only resizes preserve row caches. Column changes still reset because rows reflow.

### Renderer

Implemented or materially in place:

- `apps/desktop/web/terminal-gpu-renderer.ts` is the WebGL2-first renderer.
- `apps/desktop/web/terminal-canvas-renderer.ts` is the Canvas fallback.
- Renderer capabilities now include `retainedPartialPaint`.
- Canvas declares retained partial paint.
- WebGL2 now owns a retained GPU backbuffer and declares retained partial paint.
- The controller no longer forces full-window paints just because the backend is WebGL2.
- The controller avoids scheduling an extra tail repaint when retained dirty-row paint is already aligned at the bottom.

Latest local fix: the WebGL2 path now clears and paints into an offscreen framebuffer, then blits to the default framebuffer. This is meant to fix the black flashes seen during typing and single-cell animations, because browsers do not guarantee default framebuffer contents across frames when `preserveDrawingBuffer` is false.

## Checks Already Run

These passed after the latest renderer/backbuffer work:

```sh
npm run test:unit -- gpuRenderer terminalController
npm run typecheck
REVERIE_HARNESS_SCENARIO=terminal-render-performance npm run test:web:harness:smoke
npm run build:web
```

The WebGL2 harness reported dirty-row paints preserving untouched rows and staying well under a 60 FPS frame budget. This is browser-harness evidence, not yet a full Tauri desktop verification.

## Known Problems

### 1. Black Flash During Updates

User symptom:

- While typing or while a CLI animates one changing cell, the terminal briefly flashes pure black and all glyphs disappear.

Current assessment:

- This likely came from treating WebGL2 partial paints as retained while drawing directly to the default framebuffer.
- The latest WebGL2 retained backbuffer work should address this.

What remains:

1. Verify in the actual Tauri app, not only the browser harness.
2. If flashes remain, instrument renderer mount/dispose frequency. A renderer remount will resize the canvas and clear its backing store, which can still look like a flash.
3. Check `useTerminalSession.ts` and `terminalController.ts` for paths that call `resetRenderer()` or `disposeRenderer()` during ordinary frame updates.
4. Add a desktop or harness assertion that typing-level partial updates do not remount the renderer.

Primary files:

- `apps/desktop/web/terminal-gpu-renderer.ts`
- `apps/desktop/web/terminal/terminalController.ts`
- `apps/desktop/web/hooks/useTerminalSession.ts`
- `apps/desktop/web/terminal/gpuRenderer.test.ts`
- `apps/desktop/web/terminal/terminalController.test.ts`
- `apps/desktop/web/harnessSmoke.ts`

### 2. Claude Code / Ink History Corruption

User symptom:

- Claude Code scrollback repeats the same content over and over.
- Some rows are visually corrupted.
- Scrolling through that history can freeze.
- Codex and Cortex appear much healthier.

Current assessment:

- This is probably not the same bug as the black flash.
- Claude uses an Ink-style renderer. It redraws terminal screens with cursor movement and dynamic regions.
- Raw PTY replay may preserve visual redraw artifacts that line-oriented CLIs do not produce.
- There is also still risk in replay segmentation. The code supports explicit `run_index`, and has a legacy Claude marker splitter, but Claude startup/control sequences can appear multiple times inside one process.

Local evidence gathered:

- The local Reverie SQLite store shows Claude sessions with multiple explicit transcript runs.
- Some Claude transcript runs include multiple Claude startup/control prefixes inside one run.
- That means "split on every Claude-looking prefix" would be unsafe without a failing replay test, because the same process can emit similar setup bytes more than once.

What remains:

1. Reproduce with a minimal transcript fixture. Prefer a sanitized or synthetic byte fixture checked into tests, not private local transcript content.
2. Add a failing Rust test in `apps/desktop/src-tauri/src/terminal/history.rs` that captures the repeated/corrupt Claude replay behavior.
3. Decide whether the fix is replay segmentation, frontend window merge/indexing, or a product-level distinction between visual terminal history and Claude semantic conversation history.
4. If the issue is segmentation, make the legacy Claude splitter more robust and prove it does not split ordinary in-run setup bytes.
5. If the issue is raw Ink replay itself, stop treating Claude raw terminal bytes as the only deep-history source. Use Claude's JSONL transcript for semantic history/search, while keeping Ghostty frames for live terminal rendering.
6. Add browser/controller coverage that scrolling a replayed Claude-like history window does not duplicate the same window slice.

Primary files:

- `apps/desktop/src-tauri/src/terminal/history.rs`
- `apps/desktop/src-tauri/src/terminal/ghostty.rs`
- `apps/desktop/src-tauri/src/terminal/transcript.rs`
- `packages/reverie-persistence/src/lib.rs`
- `apps/desktop/web/terminal/bufferModel.ts`
- `apps/desktop/web/terminal/terminalController.ts`
- `apps/desktop/web/hooks/useTerminalSession.ts`

## Recommended Next Work

### P0: Lock Down the Black Flash Fix

This is the smallest and most likely completed fix.

Tasks:

1. Run the app in Tauri and test typing in Claude, Codex, and Cortex.
2. Confirm no black flash during partial updates.
3. If it still flashes, log renderer creation/disposal and canvas backing-size changes.
4. Add a unit or harness test that fails if ordinary partial frames remount WebGL2.

Exit criteria:

- No visible black flashes during typing or single-cell animations.
- WebGL2 renderer is not remounted during ordinary terminal updates.
- Existing renderer/controller/harness checks stay green.

### P0: Turn Claude Corruption Into a Failing Test

Do not continue guessing here. The next agent should produce a small replay test first.

Tasks:

1. Create a synthetic Claude/Ink-like transcript that clears/redraws status panels and resumes across runs.
2. Add a Rust history replay test that proves the current duplicate/corrupt behavior.
3. Add a frontend history-window merge test if the Rust replay output is correct but the UI repeats slices.

Exit criteria:

- One failing test explains the screenshot-level symptom.
- The fix can be implemented against that test without private user data.

### P1: Decide the Claude History Product Model

There are two plausible models:

1. Visual history: replay raw PTY bytes and show what the terminal emulator says happened.
2. Conversation history: use Claude's native JSONL as the durable source for older content, and reserve raw PTY frames for the live viewport.

The current implementation mostly assumes model 1. The user-visible bug suggests Claude may need model 2 for deep history and find, or at least a filtered visual replay.

Exit criteria:

- A written decision in `terminal-strategy.md` or this handoff doc.
- Find/search behavior is explicit: search visual terminal rows, semantic conversation records, or both.
- Claude, Codex, and Cortex do not need identical history sources if their native outputs differ.

### P1: Harden History Windowing

Tasks:

1. Add debug metrics for history-window requests: requested start, returned start, row count, total rows, generation, and cache hit/miss.
2. Assert stale generations cannot merge into the active buffer.
3. Add coverage for rapid scroll while a history replay is in flight.
4. Check that `frameFromBufferWindow()` and `mergeHistoryWindowIntoBuffer()` never turn one returned replay window into repeated visual rows.

Exit criteria:

- Rapid scroll through long history does not freeze.
- Missing-row loading cannot thrash on the same uncached request.
- Returned history windows are visibly distinct when their requested row ranges are distinct.

### P2: Finish the Long-Term Renderer Track

Tasks:

1. Keep WebGL2 as primary and Canvas as fallback.
2. Leave WebGPU behind the async factory until the Tauri WebView supports it reliably.
3. Improve atlas strategy only after the correctness bugs above are closed.
4. Keep terminal motion out of the paint loop.

Exit criteria:

- WebGL2 remains stable under normal app use.
- WebGPU work has a clean backend slot, but no product behavior depends on it.

## Useful Commands

```sh
npm run test:unit -- gpuRenderer terminalController bufferModel
npm run typecheck
REVERIE_HARNESS_SCENARIO=terminal-render-performance npm run test:web:harness:smoke
npm run build:web
PATH="/opt/homebrew/opt/zig@0.15/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml terminal::history
```

Run broader checks only after the focused tests pass:

```sh
npm run check
```

## Stop Conditions

Stop and report instead of continuing to iterate if:

- Claude corruption cannot be reproduced with a small transcript fixture.
- The black flash persists even when renderer remounts are proven absent.
- Fixing Claude requires choosing between raw visual history and native semantic conversation history.

Those are product/architecture decisions, not more renderer tuning.
