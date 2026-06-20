# Reverie Implementation Queue

This is the immediate build queue. It exists so the next work session starts from evidence instead of rediscovering the map. The terminal section below is current as of the v0 rebuild; the non-terminal sections predate that rebuild and carry a dated caveat where they sit.

## Terminal (v0 rebuild): current state

> The canonical, durable terminal design is [`terminal/`](terminal/README.md) (README, architecture, backend, wire-protocol, frontend, scrollback-coverage-design, libghostty-history-limits, resize-reflow-anchoring, decisions D1-D9, performance-and-acceptance). That folder is the source of truth for the model; this section is just the build-status summary. Read `terminal/` before doing terminal work.

The terminal was **rebuilt from scratch** on branch `refactor/terminal-overhaul`. The rebuild is **done, dual-reviewed, and `npm run check` is green**, but the branch is **not merged** (the open queue below gates the merge). The commit history is the rebuild record (`git log --oneline --reverse main..HEAD`), in order: P0 removed in-terminal find/search; P1 removed transcript capture and deep-history replay; P2 moved frames onto a binary Tauri Channel with a generation marker; P3 made scrolling frontend-driven with backend-served history ranges; P4 cleaned up dead code; then the stable-id scroll-back coverage work (backend-computed `StableRowIndex`, D8).

### The model now

- `libghostty-vt` runs **native in the Rust backend** as the single source of terminal truth: VT parsing, the authoritative grid, the in-memory scrollback, wrap/reflow, and dirty-row tracking (D1).
- A **WebGL2 canvas** (Canvas 2D fallback, WebGPU-ready behind the same contract) renders dirty-row frames in the WebView. It holds a bounded mirror of rows near the viewport, not the whole buffer.
- Frames cross a **binary Tauri Channel** as seed snapshots plus dirty-row diffs, carrying a **generation marker** so a stale post-reflow/reseed frame cannot merge (wire-protocol, P2).
- The **frontend owns the viewport and drives scrolling.** It scrolls over its local row mirror (instant, local) and, as the view nears the top of the mirror, prefetches more rows by asking the backend for a history **range**. The backend reads that range from `libghostty`'s buffer and returns it; it never moves `libghostty`'s viewport in response to a scroll (D6, P3).
- Scroll-back is served **only from `libghostty`'s in-memory buffer**, sized by a byte dial `SCROLLBACK_LIMIT_BYTES` (currently **100 MB** per session, lazily allocated; `ghostty.rs`). Rows are addressed by a **backend-computed stable row id** (`id = buffer_position + lines_evicted`), so the frontend cache and view anchor stay coherent across trim/eviction without a re-seed (D7, D8, scrollback-coverage-design).
- **Resume is the CLI's job, not Reverie's.** A resume relaunches the agent CLI with its own resume flag (for example `claude --resume <id>`) using the stored CLI-native session id; the CLI repaints its own output into a fresh terminal. Reverie persists no terminal state (architecture: How resume works, D5).

### Removed by the rebuild (do not reintroduce)

These are not deferred milestones; they are no longer how Reverie's terminal works:

- **In-terminal search** and any in-terminal content index (P0). Cross-session recall, if built, is a separate product feature that sources from the CLIs' own session files, not from terminal state. See [`../product/search-and-recall.md`](../product/search-and-recall.md).
- **Transcript capture** (the durable raw-PTY transcript) and **deep-history replay** (replaying saved bytes through a fresh Ghostty state to reconstruct old scrollback), along with the old frontend replayed-transcript cache and its `terminal_history_window` replay path (P1). Scroll-back reach is now exactly the in-memory buffer.
- All the run-index / fresh-launch-boundary / legacy-Claude-split machinery that existed only to make replayed transcripts coherent (P1). With no replay, there is nothing to stitch.

### Open terminal queue

In rough priority order:

1. **Scroll-back collapse (fixed, verified in the running app).** Scrolling up moved only a few rows and could not reach the top; resumed Claude sessions showed blank scroll-back until a resize forced a refill. Three compounding causes, all fixed: (a) the synthetic scroll path *refused* to move into uncached rows, so scroll-back was hard-capped at the cached tail. It now scrolls freely and paints blank placeholders while the prefetch fills async, matching the documented "never block the gesture" model (`scrollBufferedToTop`). (b) A `total_rows` dip wiped the whole row mirror; since Ink redraws its bottom region every frame, `total_rows` oscillates and the cache was destroyed (then re-fetched) constantly, which read as blank/looping scroll-back. A redraw dip now KEEPS the mirror; only a genuine collapse to one screen (`totalRows <= viewportRows`), a reflow (cols change), or a metadata-less fresh frame resets it (`bufferModel.ts`). (c) Paint overscan was a fixed 3 rows and the prefetch led only upward; overscan is now ~one viewport each side and the prefetch leads both directions (`bufferPaintWindow`, `historyPrefetchBand`). Verified by hand: Cortex and Codex scroll-back are smooth, Claude resume scroll-back fills correctly.
2. **Claude Code (Ink) resize reflow is an accepted limitation (D9), not a bug.** Resizing width while scrolled back reflows cleanly for line-oriented CLIs (Codex, Cortex) but jumbles a redraw-heavy TUI's history: widening does not refill the space, narrowing overflow-wraps characters to new lines. This is inherent, not our bug: Ink hard-wraps its output, so its scroll-back is frozen pre-wrapped lines that no terminal can re-flow. Confirmed against Ghostty's own macOS app, which reflows scrolled-back history identically. We do not attempt to fix the content. A position-only re-anchor across reflow now uses libghostty 0.2 tracked grid refs for the top visible row while scrolled back on the primary screen. It fixes the scroll jump, not the content jumble. Full findings + decision: [`terminal/resize-reflow-anchoring.md`](terminal/resize-reflow-anchoring.md) and D9.
3. **Interactive in-app manual pass + the branch merge decision.** macOS WKWebView cannot be WebDriver-automated, so the visual/interaction pass is by hand in the running desktop app. Confirmed so far: scroll-back through long history (Cortex, Codex, Claude resume), and the Ink resize behavior understood and accepted (item 2). Still to confirm before merging `refactor/terminal-overhaul` into `main`: input latency, and behavior across many concurrent sessions. A `freshProbe` build marker in `terminalController.ts` (behind a diagnostics flag) stamps trace events so the diagnostics log can prove a fresh WebView bundle is loaded when investigating; harmless, leave it off by default.

The yardstick for "faithful to the design" is [`terminal/performance-and-acceptance.md`](terminal/performance-and-acceptance.md).

## Process reaping on close/delete: Tier 1 landed, Tier 2 follow-up

**Tier 1 (landed 2026-06-03, commit `8298f91`).** Agent processes used to orphan because `set_session_archived` / `remove_session` only flipped DB flags; all termination relied on the frontend calling `terminate_session(terminalId)` with an **in-memory, frontend-only** binding that an HMR/store reset, a cold reload, or a crash drops. The backend is now authoritative: `TerminalSessionRuntime::terminate_for_session(session_id)` (`terminal/runtime.rs`) filters the live `sessions` map by session id and graceful-tree-kills each controller (the same `killpg`-on-setsid-leader path as `shutdown_all`). It is wired into three commands: `set_session_archived` (reap on archive), `remove_session` (reap before delete), and `start_session` (reap any stale process for the session *before* relaunch, so a lost binding can't leave two CLIs resuming one conversation). The focus/project cascade deletes (`delete_focus` / `delete_project`) reuse the same path via the shared `reap_session_runtime` helper, so purging a subtree leaves no orphaned CLI or live hook token. Companion to the frontend view/input desync fix (commit `3d00014`).

**Tier 2 (follow-up, not built).** Tier 1 only reaps processes the *current* app run still tracks. A process that survives a **crash or force-quit** (which skips the graceful `shutdown_all` / `kill_all_now` on `RunEvent::Exit`) outlives the app: after restart the in-process `sessions` map is empty, so nothing can find it. Observed in the wild: a codex `resume` from a days-old session still running after an app restart, untied to any DB row. Closing this needs **boot-time orphan reaping**: persist each spawn's process-group id plus enough identity (recorded cwd/argv) to survive PID reuse at launch, clear the record on clean exit, and on startup `SIGKILL` any survivor from a prior run whose session is gone/archived, verifying recorded identity before killing so a PID reused by an unrelated process is never hit. Related to the native-session-id collision cross-session guard still owed (two same-CLI sessions in one folder can adopt one native id via cwd+mtime discovery and both `--resume` into one conversation).

## Stack decisions now treated as settled

- Tauri v2 desktop shell.
- Rust backend/application core.
- React app shell once a package manager is available.
- Panda CSS for tokens, recipes, and layout discipline.
- Motion for restrained shell animation outside the terminal hot path.
- Phosphor Icons for app-shell iconography.
- Imperative WebGL2 terminal renderer island, Canvas fallback, and WebGPU-ready backend boundary.
- Ghostty/libghostty-backed terminal state behind Reverie's terminal boundary.

## Immediate implementation order

> **Dated caveat (2026-06-01, partially reconciled 2026-06-12): everything from here down predates the terminal v0 rebuild.** The sections below (PTY runtime, Ghostty frame extraction, session lifecycle, persistence, the initial Tauri command/event surface, the React/Panda scaffold, adapter hardening, and the per-CLI lifecycle state) describe the build status *before* `refactor/terminal-overhaul`. They are kept because the non-terminal work (lifecycle, persistence, commands, adapters, activity ingestion) is still broadly valid and was not the target of the rebuild. The terminal-runtime/backend file paths and the persistence section have since been corrected (the terminal runtime is now `terminal/runtime.rs`, the Ghostty backend `terminal/ghostty.rs`, and persistence is the SQLite `reverie-persistence` crate). But the rebuild touched the frame model, the wire transport, and the frontend renderer/cache directly, so other terminal-adjacent claims here may still be stale. **Re-verify against the code and against [`terminal/`](terminal/README.md) before relying on these.** Where a claim here contradicts the terminal section above or `terminal/`, the terminal section wins.

### 1. Promote PTY runtime from proof code into core/app services

Status: core PTY scaffold exists in `packages/reverie-core/src/pty.rs`, the live Tauri stream proof now uses `PtyProcess`, and `apps/desktop/src-tauri/src/terminal/runtime.rs` owns the app-level terminal session runtime.

Current shape:

- PTY code remains byte-oriented: spawn, read, write, resize, wait, terminate.
- `PtyProcess::split()` separates the blocking output reader from a cloneable `PtyController`, so UI/runtime commands can write input, resize, and terminate without owning the reader loop.
- Ghostty state remains below the backend boundary.
- The app runtime now registers `SessionId? → TerminalId` stream records, stores live PTY controllers separately from serializable session records, emits stable `terminal_frame` / `terminal_exit` events, and keeps legacy proof events only as compatibility aliases.
- The proof command now routes through the runtime instead of owning its own PTY/Ghostty/event loop.
- Real Tauri command seams now exist for `start_session`, `write_terminal_input`, `resize_terminal`, and `terminate_session`.
- `resize_terminal` now keeps PTY and Ghostty dimensions aligned by queuing a Ghostty resize that the stream worker applies before rendering the next frame.

Next steps:

- The React terminal surface now starts live sessions through the stable `start_session` command and consumes stable `terminal_stream_started`, `terminal_frame`, `terminal_exit`, and `terminal_failed` events instead of the proof-only stream command.
- Connect runtime status changes to durable session records once persistence lands.
- Frontend-driven resize now resizes the PTY immediately, queues the Ghostty render-state resize, and applies that pending Ghostty resize before the next emitted frame.

### 2. Split Ghostty frame extraction into a reusable backend

Status: lives in `apps/desktop/src-tauri/src/terminal/ghostty.rs`.

The Ghostty frame extraction logic is now isolated behind `GhosttyTerminalState`, which consumes VT byte streams and emits Reverie `TerminalFrame` values without knowing about Tauri commands/events or product session semantics. The proof harness now calls this backend instead of owning Ghostty render extraction directly.

Next steps:

- `GhosttyTerminalState` is now connected to the reusable `PtyProcess` runtime through the app-level terminal runtime.
- Stable `terminal_frame`, `terminal_exit`, `terminal_stream_started`, and `terminal_failed` event shapes now exist alongside proof compatibility events.
- Keep Ghostty-specific APIs below the terminal backend boundary.
- Preserve the existing proof harness until the production runtime covers the same gates.

### 3. Define the session lifecycle service

The app needs a durable service boundary before UI buildout:

- create session
- start session
- resume session
- write terminal input
- resize terminal
- terminate session
- observe exit
- mark restorable/restore failed

This service should coordinate domain records, agent adapters, PTY runtime, and terminal backend without letting the UI know CLI-specific details.

### 4. Add local persistence

Status: SQLite persistence has landed.

Current shape:

- `packages/reverie-persistence/src/lib.rs` is a SQLite-backed `WorkspaceRepository` (implementing the repository trait from `reverie-core`): one long-lived connection behind a `Mutex`, incremental by-id writes, WAL, and foreign keys on.
- Schema upgrades run through ordered migrations keyed on `PRAGMA user_version` (append a new entry per change; never edit a shipped one).
- This replaces the earlier Tauri app-data JSON document (`workspace-shell.v1.json`); the seeded snapshot is first-run bootstrap data, not the ongoing source of truth.
- Backend errors (`rusqlite`, serde) are flattened into the core `PersistenceError` so callers never depend on SQLite.

Next steps:

- Persist runtime-driven session status changes and native session refs.
- Keep this local-first only; do not add cloud/account/sync seams.

### 5. Wire initial Tauri commands/events

Once services exist, expose a narrow app API:

Commands:

- `detect_agent_clis`
- `list_projects`
- `list_foci`
- `list_sessions`
- `create_focus`
- `create_session`
- `start_session`
- `write_terminal_input`
- `resize_terminal`
- `terminate_session`

Events:

- `session_status_changed`
- `terminal_frame`
- `terminal_exit`
- `restore_failed`

### 6. React/Panda frontend scaffold

Status: product shell navigation stubs are in place.

Completed:

- `package.json` / `package-lock.json` now define the frontend package manager baseline.
- Vite root is `apps/desktop/web/`, with build output at `apps/desktop/web/dist` for Tauri.
- React 19 app shell wraps the terminal surface.
- Panda CSS codegen and CSS extraction are wired into `npm run build`.
- Motion and Phosphor Icons are present in the shell.
- The terminal renderer is mounted imperatively through a canvas-backed WebGL2 renderer, not React DOM cells.
- `workspace_shell` provides local persistence-backed workspace/project/focus/session navigation data from Tauri.
- `create_focus` and `create_session` command flows are wired from the React shell and keep Project selection optional.
- The visible shell now has General workspace navigation, optional Project navigation, Focus lanes, Session selection, and selected-session launch through the stable `start_session` runtime path.
- The selected-session launch path now omits proof-only shell scripts and lets Tauri synthesize adapter-built launch/resume specs from the persisted `ShellSession` record through the generic agent-adapter boundary, with Cortex and Codex command shapes covered by tests.
- The selected-session runtime flow is no longer treated as a short benchmark promise: React now tracks an active terminal id, keeps the session alive until exit/termination, and records render/runtime metrics when the process exits.
- Canvas keyboard and paste input now route through the stable `write_terminal_input` command only after `terminal_stream_started` confirms the PTY controller is live; the first terminate control is wired through `terminate_session` once input/control is armed.
- The React Canvas viewport now observes real layout size, recreates the imperative renderer with the derived cell dimensions, and forwards live size changes through `resize_terminal` so PTY/Ghostty/frontend dimensions stay aligned during window resize.
- Runtime-backed sessions now persist `running`/`exited`/failed status changes into the local shell store and refresh the React shell after terminal lifecycle events.
- `ShellSession` carries a nullable native session reference field so Cortex/Claude/Codex restore metadata has a stable product-model slot.
- The first Cortex native-session capture boundary now exists: `capture_cortex_session` reads `~/.cortex/sessions/{sessionId}/meta.json`, validates session id + cwd, and stores a `NativeSessionRef` without tying terminal parsing to the app shell.
- Launch-time Cortex discovery now has a deterministic local-state path: `CortexSessionMetadata::discover_latest_for_cwd` scans `~/.cortex/sessions/*/meta.json` by cwd and launch timestamp, and the terminal runtime attempts capture after a launched shell session exits before marking it finally restorable/exited.
- Session lists, terminal chrome, detail metrics, and the primary launch button now treat native-session-backed records as resumable product objects instead of generic ended processes: captured sessions surface their native session id, restorable status, and resume/retry action language.
- First terminal scrollback foothold is in place on the React/Canvas side: `apps/desktop/web/terminalScrollback.ts` now carries the explicit rows/viewport/tail-follow contract, runtime frames keep a bounded rendered scrollback buffer, the Canvas grows inside an overflow viewport, live-follow stays pinned while output streams, user scroll switches the terminal chrome into viewing-history mode instead of snapping back unexpectedly, and a small `Follow live` control snaps back to the tail deliberately.
- Scrollback invariants after the wheel/resize proof: runtime frames remain visible-viewport snapshots, rendered history is derived only from trustworthy row overlap, Canvas growth is capped by `MAX_CANVAS_HEIGHT_PX`/`MAX_RENDERED_SCROLLBACK_ROWS`, and window resize must repaint the current frame at the new surface without fabricating extra history.

Next frontend milestones:

- Continue hardening the frontend-owned terminal cache plus backend replay-window contract, especially around alternate screen, full clears, resize reflow, and very long sessions.
- Replace generated-name create buttons with proper create-focus and create-session forms.
- First UX-shape pass hardened: the shell now has an actionable first-run intent panel for General work, preserved native resumes, optional Project context, and explicit YOLO safety. Session rows also show compact status chips so resumable/running/ended states read as product state instead of raw adapter residue.
- Private product-texture pass added clearer empty states, focus descriptions, session cwd context, and explicit safety/input affordance copy so the shell reads less like a proof harness while keeping the create flows intentionally narrow.
- Evening product-form pass added a selected-session runway above the terminal: intent, cwd context, native resume state, YOLO posture, and terminal readiness are visible before launch, making the create/resume/status path read as application state instead of hidden runtime mechanics.
- Add fuller onboarding/create surfaces next: project/focus/session creation should move from compact forms into a more deliberate flow, then terminal interaction should gain visible focus state, copy semantics, and clearer active-session controls.
- Continue using render/scroll instrumentation from real sessions to tune WebGL2 glyph batching, overlay invalidation, and history-window sizes.
- Keep the terminal renderer boundary narrow while backend session services solidify.

### 7. Adapter hardening

Cortex remains first because the behavior is known.

Current status:

- Executable detection exists for Cortex, Claude Code, and Codex CLI.
- Cortex metadata parsing is in core via `CortexSessionMetadata`.
- The desktop shell can explicitly attach a Cortex native session ref from `~/.cortex/sessions/{sessionId}/meta.json` once the session id is known.
- The runtime can now infer the likely Cortex session id after launch by selecting the latest matching Cortex metadata for the Reverie session cwd inside the launch window, avoiding brittle terminal scraping as the first implementation path.
- Local Cortex CLI behavior is verified for `/opt/homebrew/bin/cortex` v0.2.4: `cortex`, `cortex --resume [session-id]`, `--model`, and `--yolo` are supported.
- Desktop UI click-through has exercised the real Cortex adapter path: selected-session launch produced `cortex --resume <session-id>`, Canvas focus accepted keyboard input, and the session remained controllable through resize and terminate.
- Window resize during an active Cortex session did not wedge the process or runtime control path; the follow-up terminated run persisted the captured session back to `restorable` with a non-zero exit code instead of making it look dead.
- Native session refs now serialize to the Tauri/frontend boundary as camelCase while still decoding earlier snake_case JSON-store records.
- Store normalization now treats sessions with a native session ref as resume/restorable instead of leaving captured sessions visually dead after an exit, and demotes persisted `running` sessions on load so a killed/restarted desktop process cannot show stale live status without an attached runtime controller.

Next steps:

- Harden any Cortex CLI-version-specific edge cases that show up under longer real use.
- Codex command semantics are now verified against `codex-cli 0.133.0` and folded into the core adapter: new launch uses `codex --cd <cwd>`, resume uses `codex resume <session-id> --cd <cwd>`, model uses `--model`, and dangerous mode maps to `--dangerously-bypass-approvals-and-sandbox`.
- The Tauri `start_session` fallback is no longer Cortex-only: it selects the built-in adapter from `ShellSession.agent_kind`, detects the executable, and builds the launch/resume `TerminalSpawnSpec` through the shared adapter contract. This gives Codex a real product-runtime foothold before native-session capture lands.
- Add Codex native-session capture as the next focused follow-up: scan `~/.codex/sessions/YYYY/MM/DD/*.jsonl`, read only the first `session_meta` record, match `payload.cwd` plus launch window, and store `payload.id` as a `codex_cli` native session ref.
- Claude Code resume semantics are now narrowed from docs + local transcript shape: launch is `claude`, resume is `claude --resume <session-id>`, continue is `claude --continue`, dangerous mode is `--dangerously-skip-permissions`, and persisted transcripts live at `~/.claude/projects/{escaped-cwd}/{session-id}.jsonl` with envelope fields including `sessionId`, `cwd`, `timestamp`, `version`, and `permissionMode`. No local `claude` executable was present on today's PATH, so the next Claude step is installed-CLI click-through and a metadata-only JSONL capture scanner, not more architecture.
- Adapter research is now consolidated in `docs/technical-architecture.md` as a resume/capture matrix covering Cortex, Claude Code, and Codex CLI mechanics, local evidence, current implementation state, risks, and the next proof gate. The adapter layer is no longer a broad unknown; the next build work should be proof-gated scanners/click-throughs rather than more architecture expansion.

## Afternoon stabilization note: 2026-05-26

Stable stopping point:

- Terminal basics are no longer the broad risk: Ghostty-backed PTY rendering, input, resize, scrollback/follow-live, and desktop click-through have all passed real-use checks.
- Product shell texture has a first bounded pass: first-run intent, session status chips, native-resume language, empty states, cwd context, and safety/input affordance copy are present without turning the app into an IDE.
- Cortex is the proven adapter path; Codex has command/runtime foothold; Claude is narrowed to installed-CLI validation plus metadata-only transcript capture.
- Current next build work should be small and proof-gated: hide/relocate proof controls, replace temporary create buttons with real forms, add Codex/Claude capture scanners behind tests, and keep one adapter path boring before widening product behavior.
- No Slack update needed unless one of those turns into a real product milestone, decision, or blocker.

## Private hardening list

Keep these as local builder notes unless they become a decision, blocker, or meaningful product milestone:

- Re-check Cortex CLI version edges under longer sessions, especially `--resume`, `--model`, and dangerous/YOLO flag interactions across installed versions.
- Tighten session-status language so captured/restorable sessions never read as dead after a controlled terminate or non-zero adapter exit. First UI hardening pass completed: session lists, terminal surface labels, and detail panels now derive status from the full session record, and native-session-backed exits show as resume-preserved instead of simply ended.
- Watch resize timing during active terminals: frontend cell measurement, queued Ghostty resize, PTY resize, current Canvas renderer selection, and next-frame emission should stay visibly aligned under repeated window changes. First hardening pass completed: live `terminal_frame` handling now resolves the current renderer per frame instead of holding a pre-resize renderer reference.
- Verify input affordances with real hands: focus state, paste behavior, interrupt/escape/control sequences, and terminate semantics should feel intentional rather than proof-harness-like. First small input hardening pass completed: key and paste handlers now only consume events once an active PTY has armed input, so the Canvas no longer swallows mapped terminal keys while no session is ready.
- Interaction invariants from the first Cortex input pass: click only focuses the Canvas; keyboard and paste both travel through `write_terminal_input`; paste is ignored unless a live PTY has armed input; unsupported/browser-reserved keys fall through for now; terminate stays an explicit control instead of a hidden keybinding until the fuller terminal interaction layer defines copy/interrupt semantics deliberately.
- Fresh-eyes product-friction backlog after the texture pass:
  - Rename the desktop window/title away from proof-harness language. First pass completed in Tauri config: the main window title is now simply `Reverie`.
  - Decide when proof controls (`Paint proof`, `Ghostty proof`) graduate behind a developer/diagnostics affordance instead of staying beside primary session controls. First pass completed: primary session actions now show only run/resume + terminate, proof controls live inside a Developer diagnostics disclosure, and the app shell can use a right-side inspector column on wider screens. Second pass completed: metrics and runtime log now live inside the diagnostics disclosure too, with a plain `Next action` card taking their default inspector slot.
  - Replace the temporary `Focus`/`Session` create buttons with real forms that capture user intent, CLI choice, cwd, and dangerous-mode override without forcing Project setup. First pass completed: Focus creation now accepts a user title, Session creation captures title, agent kind, cwd, and per-session YOLO before persisting through the existing Tauri commands.
  - Make adapter failure/exit language user-facing rather than exposing raw `childSuccess=false`-style metrics too prominently.
  - Keep the next build seam focused on Cortex hardening before opening Claude/Codex adapter research, so one real adapter path becomes boring before the product widens.
- Keep Slack quiet: share only decisions, blockers, meaningful milestones, or direct questions for Craig.

## Per-CLI lifecycle state: asymmetric by necessity

The original design assumed all three CLIs could be driven through one HTTP hook
server with `CLAUDE_CONFIG_DIR` / `CODEX_HOME` redirection. Ground truth says that
is wrong, and it is why the earlier attempt stalled: redirecting those env vars
relocates the CLI's credential home and forces a fresh sign-in. The correct shape
is one mechanism per CLI, converging on the shared `ActivityState` model:

- **Claude Code** supports `type:"http"` hooks AND a per-session `--settings <file>`
  flag that merges additively and leaves `~/.claude` (credentials) untouched.
- **Codex** has no HTTP hook type (command-only) and its command hooks are
  trust-gated by hash, but its append-only rollout JSONL is a Cortex-shaped local
  state stream. So Codex uses a rollout-file watcher (baseline) plus a trusted
  `PermissionRequest` command hook (the definitive `awaiting_permission` signal).
- **Cortex** writes a small `state.json` snapshot per transition; it now folds
  through the shared `session_log` engine (the `Snapshot` read mode), not its own
  bespoke watcher (which was deleted).

### Activity observation: one spine, four axes (the extensibility seam)

The full design lives in [`activity-ingestion.md`](activity-ingestion.md). In
short: every transport emits one `ActivityUpdate` (source, `SessionKey`,
`Fidelity`, `ActivityState`) into a single shell-side `correlate()` spine that
binds it to a Reverie session, captures native ids, and emits the frontend events.
Adding a CLI is a short decision tree, classified on four orthogonal axes:
**transport** (push | file-watch | poll | in-band), **derivation** (snapshot |
fold), **binding** (token → `SessionKey::Reverie` | native-id →
`SessionKey::Native`), and **fidelity** (`Definitive` > `Inferred` > `Coarse`, for
multi-source merge). Two engines exist:

1. **Push** (`hook_server`): the CLI POSTs lifecycle events; translated to an
   update keyed by the owning Reverie session at `Definitive`. Claude uses this.
2. **File** (`session_log`): watches only the *active* files registered via
   `SessionLogControl`, tails only new bytes (O(new output), not O(history)), and
   folds each via a per-file `SessionLogFold` that carries its own source kind and
   fidelity. One `CompositeLogSource` serves both file CLIs on one thread: Codex
   (`CodexLogSource`, `LogReadMode::Append`, rollout JSONL) and Cortex
   (`CortexStateSource`, `LogReadMode::Snapshot`, `activity/state.json`). The launch
   path registers a session's watch file (derived per CLI by `watch_path_for_ref`)
   at launch capture and at boot for already-running sessions, and unregisters at
   exit.

**Why one engine serves both file CLIs:** snapshot-vs-append-log is one transport
(file-watch) with two derivations. Cortex pre-computes a tiny snapshot (re-read is
O(1)); Codex makes us fold a growing log (a 177 MB log folds in hundreds of ms, so
the incremental tail keeps it O(new bytes), ×N sessions on one thread).

### Phase 1: Claude Code (landed)

- `hook_config.rs::build_claude_settings` writes the correct
  `{ matcher, hooks: [{type:"http", url}] }` shape (`matcher:"*"` for the tool
  events; no matcher for `SessionStart`/`SessionEnd`/`Stop`/`StopFailure`/
  `UserPromptSubmit`, so `SessionStart` fires on resume too). Files live under a
  private `~/.reverie/session-hooks/<id>/claude/settings.json`
  (`~/.reverie-dev/...` in dev, `0700`/`0600`).
- `start_session` mints a token, registers it (`HookServerControl` +
  `HookTokenRegistry`), writes the settings file, and appends `--settings <file>`
  via the adapter seam `AgentAdapter::hook_config_args`. No `CLAUDE_CONFIG_DIR` is
  set, so `assert_safe_cli_env` still passes and the user stays logged in.
  Relaunch revokes the prior token; `remove_session` revokes + deletes the dir.
- **Native id capture** comes from the SessionStart hook payload (the interactive
  TUI ignores `--session-id`): `record_session_activity_by_id` writes activity and
  captures the CLI `session_id` into `nativeSessionRef` on first sight, then emits
  `session_record_changed` so the dashboard refetches and binds the now-live
  session. A hook-independent fallback (`ClaudeCodeAdapter::discover_native_session`
  scanning `~/.claude/projects/<encoded-cwd>/*.jsonl`, cwd-validated from the file
  envelope since the dir name is a lossy encoding) captures the id if hooks never
  fire. `PreToolUse`/`PostToolUse` now carry tool detail so the card reads
  "Run shell: …" rather than a bare "Working".

### Phase 2: Codex CLI (landed, except the definitive approval hook)

- `codex_rollout` (core) folds the append-only rollout JSONL into `ActivityState`
  (`session_meta`→id+cwd, `task_started`→working, `function_call`→working+tool,
  `*_output`→clear, `task_complete`/`turn_aborted`→idle, `error`→error). The
  `sequence` is the folded-record count, so each re-read after the file grows is
  strictly newer. `discover_latest_codex_rollout_for_cwd` reads the first
  `session_meta` (cwd-validated, launch-window bounded) so `codex resume <id>`
  works; `CodexCliAdapter::discover_native_session` uses it.
- `codex_watcher` (core) + `drain_codex_activity` (shell) mirror the Cortex
  watcher: watch `~/.codex/sessions/**/rollout-*.jsonl`, fold on change, emit by
  native id through the same bridge path. Started in `main.rs` like Cortex.
- **Approval (baseline):** the reader surfaces a real `awaiting_permission` from
  the rollout: an escalated `function_call` (`with_escalated_permissions:true`)
  with no matching output yet means the user is being prompted. This is
  best-effort (can't always distinguish "approving" from "running long"); the
  definitive signal is still the command hook below.
- **Approval (definitive): NOT yet built, needs live validation.** A trusted
  `PermissionRequest` `type:"command"` forwarder routed into the existing
  `/hooks/codex` server route. The attach mechanism (`~/.codex/reverie.config.toml`
  + `codex --profile reverie` vs `hooks.json`) and the `/hooks` trust-hash
  behavior are version-sensitive (codex 0.135.0) and must be validated against a
  live `codex` session before building, not guessed. When it lands, a per-session
  aggregator unifies watcher + hook under one sequence (sticky `awaiting_permission`)
  so a stale `working` cannot clobber a live approval.

### Cross-CLI parity: launch-time capture (landed)

Capture/attach used to run only at exit, so a file-watched session (Cortex,
Codex) bound its live state only after exiting once. `spawn_launch_capture_poll`
(runtime) now polls adapter discovery for ~10s after launch and attaches the
native ref as soon as the CLI writes its session file, then emits
`session_record_changed`. This is generic, so Cortex and Codex both bind live on
the first run, at parity with Claude (which binds live via the hook). It needed
no changes to cortex-mono or Codex itself: those CLIs already persist their
session metadata at start; Reverie just reads it sooner. Exit-time capture stays
as the backstop.

## Guardrails

- Do not turn Reverie into a generic IDE.
- Do not require git.
- Do not render terminal cells through React DOM.
- Do not let terminal proof code become the production architecture by accident.
- Do not add cloud/account/sync seams in v1.
- Do not hide dangerous/YOLO behavior behind defaults; it stays explicit.
- Do not move the production terminal path to WebGPU until Tauri's WebView runtime supports it reliably and the WebGL2 path has shown a measured bottleneck.

## Checks to keep green

`npm run check` is the gate. It runs the frontend checks (`lint` + `typecheck` + `build:web`) and then the Rust checks (the workspace `cargo test`, the Zig-wrapped desktop `cargo test`, and the Zig-wrapped desktop `cargo check`). The desktop crate links `libghostty-vt`, so its `cargo` invocations must go through `scripts/run-with-zig.mjs`, which resolves a Zig `0.15.x` toolchain; a raw `cargo` against that manifest can mis-link.

```bash
npm run check
```

Note the desktop `cargo` legs now also build the on-device speech engine
(`reverie-speech` with `capture` + `asr`), which compiles a Swift package via
`fluidaudio-rs` and so needs the Xcode Command Line Tools (in addition to Zig).
The root `cargo test` stays Swift-free because `reverie-speech`'s native deps are
feature-gated and the root build enables no features.

Useful subsets while iterating (all are covered by `npm run check`):

```bash
npm run test:unit                                                              # Vitest (frontend unit/smoke)
node scripts/run-with-zig.mjs cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml   # Zig-wrapped desktop Rust tests
cargo test                                                                     # core (reverie-core) tests
cargo test -p reverie-speech --features capture                                # speech resampling unit tests (no mic)
```

The on-device speech engine end-to-end smoke test is **`#[ignore]` by default**
(it downloads ~500MB and ANE-compiles the model on first run), so it is not part
of `npm run check`. Run it deliberately on an Apple Silicon Mac:

```bash
cargo test -p reverie-speech --features asr -- --ignored
```

## On-device speech-to-text foundation (landed)

The STT **foundation** is built: `reverie-core::speech` contracts + `voice_*`
workspace settings, the `reverie-speech` engine (cpal capture → rubato → Parakeet
on the ANE via `fluidaudio-rs`), the Tauri command/event/`Channel` seam, and the
frontend client (`speechApi`, `speechEngineStore`, `useSpeechEngine`,
`useSpeechCapture`) plus a Settings `VoiceSection`. The model is downloaded at
runtime (eager on first launch) and the engine returns a transcript and routes it
nowhere. See [voice input](../product/core-experience/voice-input.md).

**Follow-on features (not built):** the in-terminal floating voice button (routes
the transcript through `write_input` bracketed-paste) and the dispatch global
shortcut (routes it to the completion/classification surface). Dispatch's intent
classification depends on the completion surface, tracked separately. Streaming
partials and VAD endpointing are wired as seams (the reserved `CaptureSignal::Partial`
and fluidaudio's `streaming_asr_*`/`init_vad`) for a future voice mode.

Manual terminal stress route (a hidden multi-terminal route, not part of `npm run check`):

```bash
npm run dev:terminal-stress
```

This launches the desktop app into the hidden multi-terminal stress route (`REVERIE_TERMINAL_STRESS=1` → the `tauriTerminalStress=1` window). Note this route is a pre-rebuild proof surface; treat its results as indicative, and confirm real behavior in the running app (WKWebView cannot be automated). The Rust/Tauri tests above remain the source of truth for persistence, commands, CLI detection, and native session launch.
