# Reverie Implementation Queue

This is the immediate build queue after the terminal-quality spike. It exists so the next work session starts from evidence instead of rediscovering the map.

## Current evidence baseline

The Ghostty-backed terminal path is credible enough to continue as the preferred v1 path:

- `libghostty-vt` builds in the Reverie workspace with Zig `0.15.2` on `PATH`.
- Static VT bytes render into Reverie's `TerminalFrame` model.
- Live PTY output feeds Ghostty state and renders through the same frame model.
- Interactive PTY input/write works.
- Resize/reflow works.
- Long-lived process lifecycle works.
- Sustained output/backpressure proof handled a 2,000-line PTY flood without deadlock.
- Tauri WebView Canvas renders Ghostty-derived frames at credible paint times.
- Live PTY → Ghostty → Tauri event streaming passes with no dropped frames in the controlled proof.

Canvas 2D remains the near-term terminal surface. WebGPU/WebGL2 is reserved for evidence-driven escalation, not taste.

## Stack decisions now treated as settled

- Tauri v2 desktop shell.
- Rust backend/application core.
- React app shell once a package manager is available.
- Panda CSS for tokens, recipes, and layout discipline.
- Motion for restrained shell animation outside the terminal hot path.
- Phosphor Icons for app-shell iconography.
- Imperative Canvas/WebGPU terminal renderer island.
- Ghostty/libghostty-backed terminal state behind Reverie's terminal boundary.

## Immediate implementation order

### 1. Promote PTY runtime from proof code into core/app services

Status: core PTY scaffold exists in `packages/reverie-core/src/pty.rs`, the live Tauri stream proof now uses `PtyProcess`, and `apps/desktop/src-tauri/src/terminal_runtime.rs` owns the app-level terminal session runtime.

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

Status: started in `apps/desktop/src-tauri/src/terminal_backend.rs`.

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

Status: first persistence-backed shell slice exists.

Current shape:

- `apps/desktop/src-tauri/src/app_shell.rs` now owns `AppShellStore`, a local Tauri app-data JSON document at `workspace-shell.v1.json`.
- `workspace_shell` loads from that store instead of returning only seeded in-memory data.
- `create_focus` and `create_session` persist local shell changes and return updated snapshots.
- The seeded snapshot is now first-run bootstrap data, not the ongoing source of truth.
- Tests cover store seeding, focus round-tripping, and rejecting sessions for unknown focuses.

Next steps:

- Move from JSON-document persistence to SQLite or a repository layer once the domain API stabilizes.
- Persist runtime-driven session status changes and native session refs.
- Add migrations or schema-version upgrade handling before broadening stored fields.
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
- The terminal renderer is mounted imperatively through Canvas, not React DOM cells.
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

- Move scrollback ownership toward the backend/Ghostty snapshot boundary once the initial product feel is verified, so alternate-screen/full-clear behavior is modeled deliberately instead of inferred from viewport overlap.
- Replace generated-name create buttons with proper create-focus and create-session forms.
- First UX-shape pass hardened: the shell now has an actionable first-run intent panel for General work, preserved native resumes, optional Project context, and explicit YOLO safety. Session rows also show compact status chips so resumable/running/ended states read as product state instead of raw adapter residue.
- Private product-texture pass added clearer empty states, focus descriptions, session cwd context, and explicit safety/input affordance copy so the shell reads less like a proof harness while keeping the create flows intentionally narrow.
- Evening product-form pass added a selected-session runway above the terminal: intent, cwd context, native resume state, YOLO posture, and terminal readiness are visible before launch, making the create/resume/status path read as application state instead of hidden runtime mechanics.
- Add fuller onboarding/create surfaces next: project/focus/session creation should move from compact forms into a more deliberate flow, then terminal interaction should gain visible focus state, copy semantics, and clearer active-session controls.
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

## Afternoon stabilization note — 2026-05-26

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

## Guardrails

- Do not turn Reverie into a generic IDE.
- Do not require git.
- Do not render terminal cells through React DOM.
- Do not let terminal proof code become the production architecture by accident.
- Do not add cloud/account/sync seams in v1.
- Do not hide dangerous/YOLO behavior behind defaults; it stays explicit.
- Do not move to WebGPU until production-session evidence says Canvas is the bottleneck.

## Checks to keep green

```bash
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" npm run build
cargo test
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
node --check apps/desktop/web/terminal-render-proof.js
node --check apps/desktop/web/terminal-canvas-renderer.js
```
