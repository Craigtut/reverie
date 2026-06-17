# Reverie Technical Architecture

## Stack

- Desktop shell: Tauri v2
- Backend/application core: Rust
- Frontend: React app shell in the Tauri webview, with Panda CSS, Motion, and Phosphor Icons
- Terminal strategy: Ghostty-quality v1 terminal, implemented behind a clean abstraction with an imperative Canvas/WebGPU renderer island so product architecture stays stable
- Persistence: local-first app storage, likely SQLite plus config files
- Target platform: macOS (Apple Silicon) only

## Architectural rule

The product/domain layer must not depend on the terminal renderer.

Reverie should be able to answer these questions without knowing whether the renderer is Ghostty-backed, xterm-backed, or another implementation:

- What projects exist?
- What foci exist?
- What sessions exist?
- Which native CLI session does a Reverie session map to?
- What command should be launched to create or resume an agent session?
- Is this session running, exited, restorable, or failed?

## High-level layers

```text
Tauri UI
  ↓ commands/events
Application services
  ↓
Domain model + persistence
  ↓                 ↓
Agent CLI adapters  Terminal service boundary
  ↓                 ↓
Process/PTY runtime Terminal renderer backend
```

## Domain model

### Workspace

Represents Reverie's local home. (General sessions get per-session scratch dirs under `~/.reverie/general-sessions/`; dev builds use `~/.reverie-dev/general-sessions/`. That path is a runtime concern, not a stored field.)

Fields:

- id
- name
- general_label
- default_dangerous_mode (the single workspace-wide auto-approve default)
- disabled_agent_kinds (CLIs the user switched off in settings)
- theme (persisted light/dark appearance)
- default_agent_kind (seeds the new-session composer's agent picker)
- terminal_font_size
- ui_view_state (opaque, frontend-owned: last selected focus/session, active surface, sidebar accordion)

### Project

Optional folder-backed context.

Fields:

- id
- name
- path
- archived (curation bit; see [Curation lifecycle](#curation-lifecycle-archive--restore--delete))
- sort_order (position in the left-nav project list, for drag-to-reorder)

Constraints:

- `path` must not require git.
- If a path becomes unavailable, the project remains in Reverie with a recoverable missing-folder state.

### Focus

The "Focus" entity, surfaced in the UI as a **Topic** (the user-facing noun). The data model and code still use `Focus`/`focusId`/`ShellFocus`; "Topic" is the label the shell renders. A masthead under either a project or the general workspace.

Fields:

- id
- project_id nullable
- title
- description nullable
- sort_order
- archived (curation bit; see [Curation lifecycle](#curation-lifecycle-archive--restore--delete))
- default_dangerous_mode nullable (topic-wide auto-approve default; falls through to the workspace default when unset)

A null `project_id` means the focus belongs to the general workspace.

### Session

A Reverie-owned session tab.

Fields:

- id
- focus_id
- title
- agent_kind
- cwd
- native_session_ref nullable
- launch_mode: `new` or `resume`
- dangerous_mode_override nullable
- status: `not_started`, `running`, `exited`, `restorable`, `restore_failed`
- last_exit_code nullable
- archived (curation bit; see [Curation lifecycle](#curation-lifecycle-archive--restore--delete))
- latest_activity nullable (denormalized cache of the last activity-state snapshot, so the dashboard paints immediately on app start)
- sort_order (position within its focus, for drag-to-reorder)

### NativeSessionRef

Serialized metadata controlled by each adapter. The struct fields are `kind`, `session_id` (nullable), `metadata_path` (nullable), and `adapter_payload` (free-form `serde_json::Value` for adapter-specific data). It serializes camelCase, so the wire keys are `kind`, `sessionId`, `metadataPath`, `adapterPayload` (snake_case aliases are accepted on read).

Common shape:

```json
{
  "kind": "cortexCode",
  "sessionId": "uuid",
  "metadataPath": "~/.cortex/sessions/{sessionId}/meta.json",
  "adapterPayload": {}
}
```

`adapter_payload` lets Reverie support different restore mechanisms without schema churn.

### Curation lifecycle (archive / restore / delete)

Where a node lives in the user's map is **one axis**, separate from a session's
runtime/activity state (`fresh / active / finished / idle / attention`, derived,
not stored). Every project, focus, and session carries a single boolean
`archived` bit, and three operations move a node along the axis:

- **Archive** (soft, reversible): set the node's own `archived` bit. Closing a
  session archives it; "Remove" archives a topic or project. Archiving a parent
  stops any running descendant processes but does **not** write the descendants'
  bits.
- **Restore**: clear the bit. Sessions restore from a focus's archived list;
  topics from the project dashboard's "Archived topics"; a project reconnects
  when its folder is re-added (see below).
- **Delete** (hard, permanent, always confirmed): `delete_session` /
  `delete_focus` (cascade to its sessions) / `delete_project` (cascade to its
  topics and their sessions). The project purge lives in Settings → Archived
  projects.

**Visibility is computed by walking ancestry, never by writing children.** A
node is *effectively archived* when its own bit is set OR any ancestor is
archived; Home, the sidebar, the dashboards, navigation, and the command palette
all show exactly the not-effectively-archived set (frontend `domain/archive.ts`).
Archiving a project therefore hides its whole subtree by flipping one bit, and
restoring it reveals the subtree exactly as it was, with any individually
archived descendant correctly staying archived. This is what keeps restore
lossless and stops the class of bug where a soft-hidden descendant leaks onto one
surface but not another. There is no separate per-session visibility flag.

**Project re-add reconnects.** A project is anchored to a folder, so re-adding
that folder is its restore: `create_project` compares the new path against
existing projects by canonical path and, if it matches an **archived** one,
clears that record's bit (reviving its topics and sessions) and floats it to the
top of the rail instead of creating a duplicate. An active-path match still
errors ("already in Reverie"). Because re-add is the restore path, archived
projects have no Restore button; Settings lists them with a permanent purge only.

## Persistence

Persistence is **SQLite**, and it is live (not a future pass). The storage seam is the `WorkspaceRepository` trait in `packages/reverie-core/src/repository.rs`; the SQLite implementation lives in the dedicated `packages/reverie-persistence` crate, which owns the only SQLite engine in the workspace.

- One long-lived `rusqlite::Connection` behind a `Mutex`, with WAL mode and `foreign_keys = ON`.
- **Incremental, by-id writes** (`upsert_project`, `upsert_focus`, `upsert_session`, ...). There is deliberately no bulk `save_snapshot`; rewriting the whole graph on every mutation was the previous design's central flaw. Callers mutate one entity at a time and `load_snapshot` reads the full `WorkspaceSnapshot` when they need it.
- Backend errors (`rusqlite`, serde) are flattened into the core `PersistenceError` so the trait and the service above it never depend on the concrete engine.
- `ensure_seeded` inserts the workspace row only if none exists, so first-run seeding is idempotent.
- Stored under the Tauri app data directory. General (project-less) sessions get a fresh per-session scratch workspace under `~/.reverie/general-sessions/` (or `~/.reverie-dev/general-sessions/` for dev builds), created on session start and removed on delete, so external CLIs do not need to read Reverie's macOS app-data directory.
- `InMemoryWorkspaceRepository` (in `reverie-core`) backs the service's unit tests and any headless/harness use, mirroring the frontend's fixture-runtime pattern.

Migrations are an ordered list keyed on `PRAGMA user_version`: entry `i` migrates `user_version` from `i` to `i + 1`, and a shipped entry is never edited (append a new one for each change). Current tables include `workspace`, `projects`, `focuses`, `sessions`, `connections`, `connection_messages`, and `session_transcript_chunk`.

Current schema (abbreviated; the migration list in `reverie-persistence/src/lib.rs` is authoritative):

```sql
workspace(id text primary key, name text not null, general_label text not null, default_dangerous_mode integer not null, disabled_agent_kinds text not null default '[]', theme text, default_agent_kind text, ...);
projects(id text primary key, name text not null, path text not null, archived integer not null);
focuses(id text primary key, project_id text references projects(id) on delete set null, title text not null, description text, sort_order integer not null, archived integer not null);
sessions(id text primary key, focus_id text not null references focuses(id) on delete cascade, title text not null, agent_kind text not null, cwd text not null, native_session_ref_json text, launch_mode text not null, dangerous_mode_override integer, status text not null, last_exit_code integer, tab_visible integer not null default 1, latest_activity_json text, archived integer not null default 0);
```

Note the table is `focuses` (not `foci`), and curation is a boolean `archived` column (not an `archived_at` timestamp). The connection tables (`connections`, `connection_messages`) back inter-agent connections; see [`inter-agent-connections.md`](inter-agent-connections.md). Migration discipline matters from the beginning because session persistence is Reverie's core promise.

## Agent adapter boundary

Each CLI adapter owns CLI-specific behavior and produces launch specs. It does not own terminal rendering or UI state. The adapter contract is: given a Reverie session record plus launch intent, build the exact CLI command; after launch, identify the CLI-native session by deterministic local evidence owned by that CLI, scoped by cwd and the launch window, and persist that as `NativeSessionRef`. Terminal output may become a useful signal later, but it should not be the only source of truth for Cortex because `~/.cortex/sessions/{sessionId}/meta.json` is already structured state.

Rust trait sketch:

```rust
pub trait AgentAdapter: Send + Sync {
    fn kind(&self) -> AgentKind;
    fn display_name(&self) -> &'static str;
    // Detection is defaulted on top of the executable candidate list.
    fn executable_candidates(&self) -> &'static [&'static str];
    fn detect(&self) -> AdapterDetection { /* default: find_executable(candidates) */ }

    fn build_new_command(&self, ctx: &LaunchContext) -> anyhow::Result<CommandSpec>;
    fn build_resume_command(
        &self,
        ctx: &LaunchContext,
        native: &NativeSessionRef,
    ) -> anyhow::Result<CommandSpec>;

    fn dangerous_mode_arg(&self) -> Option<&'static str> { None }

    // Whether the adapter accepts a Reverie-minted session id at spawn
    // (Claude's `--session-id`) instead of capturing it from disk afterward.
    fn mints_new_session_id(&self) -> bool { false }

    // Discover the native session this CLI created for `ctx.cwd`, if any.
    // Cortex via `meta.json`, Claude via its transcript scanner, Codex via the
    // rollout reader. The caller only persists the returned ref.
    fn discover_native_session(&self, ctx: &DiscoveryContext) -> anyhow::Result<Option<NativeSessionRef>> { Ok(None) }
}
```

(There is no `capture_native_session_ref`/`CaptureContext`; capture is `discover_native_session(&DiscoveryContext)`. `build_new_command`/`build_resume_command` take `&LaunchContext` by reference.)

### CommandSpec

```rust
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
}
```

### LaunchContext

```rust
pub struct LaunchContext {
    pub session_id: SessionId,
    pub cwd: PathBuf,
    pub dangerous_mode: bool,
    pub model: Option<String>,
    pub executable_path: Option<PathBuf>,
    // Set only for new launches of adapters that mint their own session id.
    pub new_session_id: Option<String>,
}
```

## Initial adapters

The built-in adapters are registered in priority order **Claude Code, then Codex CLI, then Cortex** (`built_in_adapters()` in `agents.rs`), and `Workspace::default_agent_kind` is `ClaudeCode`. (The "Cortex adapter first" framing below and in the implementation sequence is historical: Cortex was the first capture path proven, but Claude is now the default and first in priority.)

### Cortex Code adapter

Detection candidates:

- `cortex`
- `cortex-code`

New session:

```sh
cortex
```

Dangerous mode:

```sh
cortex --yolo
```

Resume:

```sh
cortex --resume <session-id>
```

Known storage:

```text
~/.cortex/sessions/{sessionId}/meta.json
~/.cortex/sessions/{sessionId}/history.json
~/.cortex/sessions/{sessionId}/observations.json
```

Capture strategy options:

1. Prefer reading newly created/updated `~/.cortex/sessions/*/meta.json` scoped by cwd and timestamp after session start/shutdown.
2. If Cortex exposes session ID in terminal output later, parse it from output as a stronger signal.
3. Store the UUID in `native_session_ref` once identified.

### Claude Code adapter

Command semantics from the public Claude Code CLI reference; this machine does not currently expose `claude` on `PATH`, so the next validation pass still needs an installed-CLI click-through before marking it as hardened:

```text
claude
claude --model <model>
claude --dangerously-skip-permissions
claude --resume <session-id>
claude --resume <session-id> --model <model>
claude --continue
claude --fork-session --resume <session-id>
```

Known local session state shape from existing transcripts:

```text
~/.claude/projects/{cwd-with-slashes-escaped-as-dashes}/{session-id}.jsonl
```

The JSONL filename is the native session id. Conversation records carry `sessionId`, `cwd`, `timestamp`, `version`, `gitBranch`, `entrypoint`, and permission-mode fields alongside message content. Capture should prefer a metadata-only JSONL scanner that reads those envelope fields and ignores message text. The adapter command path can use `claude --resume <session-id>` once Reverie has a `NativeSessionRef`; automatic capture is still separate work.

### Codex CLI adapter

Initial command semantics verified against `/opt/homebrew/bin/codex` / `codex-cli 0.133.0`:

```text
codex --cd <cwd>
codex --model <model> --cd <cwd>
codex --dangerously-bypass-approvals-and-sandbox --cd <cwd>
codex resume <session-id> --cd <cwd>
codex resume <session-id> --model <model> --cd <cwd>
```

Known storage:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl
```

The first JSONL record is `type=session_meta` and carries `payload.id`, `payload.cwd`, `payload.cli_version`, `payload.originator`, and model/provider metadata. Capture should prefer this deterministic local session metadata over terminal scraping, but it needs a separate JSONL scanner because Codex does not use Cortex's one-directory-per-session `meta.json` shape. Launch/resume command construction now runs through the same persisted `ShellSession` → built-in adapter → `TerminalSpawnSpec` path as Cortex, so Codex can use the production runtime before native-session capture is implemented.

### Adapter resume/capture matrix

This is the current consolidation point for v1 adapter behavior. The common product contract is stable: Reverie owns workspace/focus/session state, each CLI adapter owns launch/resume command construction, and native session capture should come from deterministic local CLI state rather than terminal-output scraping whenever possible.

| Adapter | Launch / resume mechanics | Local session evidence | Current implementation state | Main risks | Next proof gate |
| --- | --- | --- | --- | --- | --- |
| Cortex Code | `cortex`, `cortex --resume <session-id>`, optional `--model`, optional `--yolo` | `~/.cortex/sessions/{sessionId}/meta.json` plus history/observations files | Hardened first: executable detection, command building, explicit capture command, launch-time latest-metadata discovery by cwd/timestamp, runtime status normalization, and real desktop click-through for resume/input/resize/terminate | CLI-version drift around flags; ambiguous latest-session capture if multiple Cortex launches happen in the same cwd/window; non-zero exits must still read as resume-preserved when a native ref exists | Longer real-use Cortex run with launch, input, scrollback, terminate, relaunch/resume, and status review |
| Claude Code | `claude`, `claude --resume <session-id>`, `claude --continue`, optional `--model`, optional `--dangerously-skip-permissions`, optional fork via `--fork-session --resume <session-id>` | `~/.claude/projects/{escaped-cwd}/{session-id}.jsonl`; filename is the native id and records carry envelope fields such as `sessionId`, `cwd`, `timestamp`, `version`, `gitBranch`, `entrypoint`, and permission mode | Landed: launch attaches HTTP hooks via a per-session `--settings` file (no `CLAUDE_CONFIG_DIR` redirect, so login is untouched), and native id is captured from the SessionStart hook payload via `record_session_activity_by_id`. A hook-independent fallback (`ClaudeCodeAdapter::discover_native_session`) scans `~/.claude/projects/{escaped-cwd}/{session-id}.jsonl`, validating cwd from the in-file envelope | The escaped-cwd dir name is lossy (`/` and a literal `-` both map to `-`), so the scanner must validate via the in-file `cwd`, never the dir name; `--session-id` is unreliable in the interactive TUI, so we capture from the hook rather than minting; `--continue`/fork semantics still unmapped | Live click-through with installed `claude`: confirm hooks POST, the glyph moves working/awaiting_input/awaiting_permission, credentials stay intact, and resume uses the captured id |
| Codex CLI | `codex --cd <cwd>`, `codex resume <session-id> --cd <cwd>`, optional `--model`, optional `--dangerously-bypass-approvals-and-sandbox` | `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl`; first record is `type=session_meta` with `payload.id`, `payload.cwd`, `payload.cli_version`, originator/model/provider fields | Landed (codex 0.135.0): `codex_rollout` reader + `discover_latest_codex_rollout_for_cwd` capture (so `codex resume <id>` works), `codex_watcher` live working/idle/done/tool-detail, launch-time capture for first-run binding, and a best-effort `awaiting_permission` from escalated `function_call`s. NOT yet built: the definitive `PermissionRequest` command hook + guided `/hooks` trust + the dual-source aggregator | Codex has no HTTP hook type (command-only) and trust-gates command hooks by hash; the rollout records the escalated `function_call` (`with_escalated_permissions`) but no discrete approval-request record, so the watcher's approval is a heuristic and the definitive signal needs the trusted hook; the hook attach mechanism (profile vs `hooks.json`) is version-sensitive and must be validated live, not guessed; date-partitioned scan stays bounded by mtime | Live click-through with installed `codex`: confirm launch-time capture binds working/idle/done on first run, resume uses the captured id, and the escalated-call heuristic surfaces awaiting_permission; THEN validate the command-hook attach + `/hooks` trust against the live CLI before building the definitive approval path |

## Terminal/service boundary

The terminal service is responsible for terminal lifecycle, not product semantics.

> The canonical terminal design (the built v0 model: `libghostty-vt` native in the backend, a WebGL2 renderer in the WebView, a binary Tauri Channel carrying seed snapshots plus dirty-row diffs, and frontend-driven scrolling that fetches history ranges from `libghostty`'s in-memory buffer) lives in [`terminal/`](terminal/README.md). The `TerminalBackend` trait below and the `terminal_output` / `terminal_snapshot_changed` names in the command/event candidate lists predate that rebuild and are kept as the early product-boundary sketch; for the actual wire shape and frame model, defer to `terminal/`. Reverie persists no terminal history: a restart resumes the CLI (see the adapter resume mechanics), it does not restore terminal state.

Trait sketch:

```rust
pub trait TerminalBackend {
    fn spawn(&mut self, spec: TerminalSpawnSpec) -> anyhow::Result<TerminalId>;
    fn write_input(&mut self, terminal_id: TerminalId, bytes: &[u8]) -> anyhow::Result<()>;
    fn resize(&mut self, terminal_id: TerminalId, cols: u16, rows: u16) -> anyhow::Result<()>;
    fn snapshot(&self, terminal_id: TerminalId) -> anyhow::Result<TerminalSnapshot>;
    fn subscribe(&self, terminal_id: TerminalId) -> TerminalEventStream;
    fn terminate(&mut self, terminal_id: TerminalId) -> anyhow::Result<()>;
}
```

## PTY/runtime

Responsibilities:

- Spawn process in selected cwd.
- Attach PTY.
- Stream output bytes.
- Accept input bytes.
- Resize terminal.
- Track process exit.
- Clean up child processes.

Use `portable-pty` for PTY/process lifecycle. (It is cross-platform, which keeps the door open if Reverie's target ever broadens, but macOS on Apple Silicon is the only shipping target today.)

## Renderer strategy

### Ghostty-backed path

Target-quality path if the spike passes.

Requirements before committing:

- Build `libghostty-vt` bindings in the Rust/Tauri workspace.
- Feed PTY bytes into Ghostty VT state.
- Render visible terminal surface in Tauri.
- Support keyboard, paste, mouse, selection, resize.
- Confirm a credible macOS (Apple Silicon) build story.

### Fallback path

Allowed for v1 only behind the same terminal boundary if Ghostty embedding expands beyond product scope.

The fallback must not leak into product/domain architecture.

## Tauri command/event surface

The actual registered handlers live in `apps/desktop/src-tauri/src/main.rs` (the `generate_handler!` list), split between `commands` and `connection_commands`. There is no per-entity `list_*` command: the whole graph is read once via `workspace_shell`, and onboarding state is derived from `workspace_shell` + `list_agent_clis` rather than a dedicated command. Key commands, grouped:

- Workspace / graph: `workspace_shell`, `app_status`, `set_workspace_default_dangerous_mode`, `set_workspace_theme`, `set_workspace_default_agent_kind`, `set_workspace_nav_state`, `set_terminal_font_size`.
- CLIs: `list_agent_clis`, `set_agent_cli_enabled` (detection is folded into `list_agent_clis`, not a `detect_agent_clis`).
- Projects: `create_project`, `create_project_from_folder` (re-add reconnects an archived project), `choose_project_folder`, `resolve_project_folder`, `archive_project`, `delete_project`, `reorder_projects`.
- Focuses (Topics in the UI): `create_focus`, `archive_focus`, `restore_focus`, `delete_focus`, `reorder_focuses`.
- Sessions: `create_session`, `start_session` (resume is folded in via the session's launch mode / native ref, there is no separate `resume_session`), `set_session_archived`, `remove_session`, `set_session_dangerous_mode`, `mark_session_viewed`, `move_session`, `reorder_sessions`, `capture_cortex_session`, `terminate_session`.
- Terminal: `list_terminal_sessions`, `write_terminal_input`, `resize_terminal`, `read_terminal_rows`, `set_terminal_frontend_active`, `set_terminal_theme`, plus `hook_server_port`, `record_render_metrics`, `record_terminal_diagnostics`.
- Connections (`connection_commands::*`): `bridge_installation_status`, `install_/uninstall_{cortex,codex,claude}_bridge_command`, `list_pending_connection_requests`, `accept_/deny_connection_request`, `list_session_connections`, `user_open_connection`, `close_connection_command`, `connection_transcript`, `connection_policy`, `set_connection_policy`, and the focus-policy/pair-block helpers. See [`inter-agent-connections.md`](inter-agent-connections.md).

Events: terminal lifecycle uses `terminal_stream_started`, `terminal_frame` (binary, via a Tauri Channel), `terminal_exit`, `terminal_failed`, and `terminal_title_changed`; activity/connection state is forwarded to the frontend (see `connection_commands::forward_connection_event`). The early `terminal_output` / `terminal_snapshot_changed` / `session_status_changed` / `restore_failed` names predate the terminal v0 rebuild and are not the shipped events.

## Error handling expectations

User-facing errors should be plain and recoverable:

- CLI not installed: explain what is missing and where settings can point to a custom executable.
- Project folder missing: let user locate it, keep metadata intact.
- Native session missing: preserve Reverie session and offer restart/new-session options.
- Restore command failed: show command, cwd, exit status, and suggested next action.
- Dangerous mode unavailable for adapter: disable the control with explanation.

## First implementation sequence

1. Scaffold Tauri v2 app with Rust backend.
2. Add local persistence and migrations.
3. Implement domain model and services for projects, foci, and sessions.
4. Implement CLI detection for Cortex, Claude Code, and Codex CLI.
5. Implement Cortex adapter first because source behavior is known.
6. Add PTY runtime with minimal terminal output path.
7. Build onboarding and basic project/focus/session UI.
8. Implement session native-ref capture and restore for Cortex.
9. Research/implement Claude Code and Codex CLI restore adapters.
10. Run isolated Ghostty renderer spike and decide renderer path.
11. Harden restore failure states and lifecycle cleanup.

## Design constraint to protect

Reverie should never become a thin wrapper around a single terminal component.

The durable product is the user's organized, resumable map of agent work. Terminal implementation quality matters, but it serves that map.
