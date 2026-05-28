# Reverie Technical Architecture

## Stack

- Desktop shell: Tauri v2
- Backend/application core: Rust
- Frontend: React app shell in the Tauri webview, with Panda CSS, Motion, and Phosphor Icons
- Terminal strategy: Ghostty-quality v1 terminal, implemented behind a clean abstraction with an imperative Canvas/WebGPU renderer island so product architecture stays stable
- Persistence: local-first app storage, likely SQLite plus config files
- Target platforms: macOS, Windows, Linux

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

Represents Reverie's local home.

Fields:

- id
- app data path
- general workspace path, likely `~/.reverie/workspace`
- default dangerous mode preference
- created_at
- updated_at

### Project

Optional folder-backed context.

Fields:

- id
- name
- path
- created_at
- updated_at
- last_opened_at
- archived_at nullable

Constraints:

- `path` must not require git.
- If a path becomes unavailable, the project remains in Reverie with a recoverable missing-folder state.

### Focus

Masthead/topic under either a project or the general workspace.

Fields:

- id
- project_id nullable
- title
- description nullable
- sort_order
- created_at
- updated_at
- archived_at nullable

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
- created_at
- updated_at
- last_started_at nullable
- last_restored_at nullable

### NativeSessionRef

Serialized metadata controlled by each adapter.

Common shape:

```json
{
  "kind": "cortex",
  "session_id": "uuid",
  "metadata_path": "~/.cortex/sessions/{sessionId}/meta.json"
}
```

Adapter-specific data should be stored as JSON so Reverie can support different restore mechanisms without schema churn.

## Persistence

Current first pass:

- `apps/desktop/src-tauri/src/app_shell.rs` stores the workspace shell snapshot as a versioned JSON document under the Tauri app data directory.
- `workspace_shell`, `create_focus`, and `create_session` now read/write that local store.
- The seeded workspace/project/focus/session snapshot is used only to bootstrap a first-run store.

Recommended next pass:

- Move durable domain records into SQLite once the service API stabilizes.
- Keep JSON/TOML config for user preferences if simpler than database migrations.
- Store under Tauri app data directory, with general workspace files under `~/.reverie` if product wants user-visible locality.

Future SQLite table sketch:

```sql
workspace_settings(key text primary key, value json not null);
projects(id text primary key, name text not null, path text not null, created_at text not null, updated_at text not null, last_opened_at text, archived_at text);
foci(id text primary key, project_id text, title text not null, description text, sort_order integer not null, created_at text not null, updated_at text not null, archived_at text);
sessions(id text primary key, focus_id text not null, title text not null, agent_kind text not null, cwd text not null, native_session_ref json, dangerous_mode_override boolean, status text not null, last_exit_code integer, created_at text not null, updated_at text not null, last_started_at text, last_restored_at text);
```

Migration discipline matters from the beginning because session persistence is Reverie's core promise.

## Agent adapter boundary

Each CLI adapter owns CLI-specific behavior and produces launch specs. It does not own terminal rendering or UI state. The adapter contract is: given a Reverie session record plus launch intent, build the exact CLI command; after launch, identify the CLI-native session by deterministic local evidence owned by that CLI, scoped by cwd and the launch window, and persist that as `NativeSessionRef`. Terminal output may become a useful signal later, but it should not be the only source of truth for Cortex because `~/.cortex/sessions/{sessionId}/meta.json` is already structured state.

Rust trait sketch:

```rust
pub trait AgentAdapter: Send + Sync {
    fn kind(&self) -> AgentKind;
    fn display_name(&self) -> &'static str;
    fn detect(&self) -> AdapterDetection;
    fn build_new_command(&self, ctx: LaunchContext) -> anyhow::Result<CommandSpec>;
    fn build_resume_command(
        &self,
        ctx: LaunchContext,
        native: &NativeSessionRef,
    ) -> anyhow::Result<CommandSpec>;
    fn dangerous_mode_arg(&self) -> Option<&'static str>;
    fn capture_native_session_ref(&self, ctx: CaptureContext) -> anyhow::Result<Option<NativeSessionRef>>;
}
```

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
    pub session_id: ReverieSessionId,
    pub cwd: PathBuf,
    pub dangerous_mode: bool,
    pub model: Option<String>,
}
```

## Initial adapters

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
| Claude Code | `claude`, `claude --resume <session-id>`, `claude --continue`, optional `--model`, optional `--dangerously-skip-permissions`, optional fork via `--fork-session --resume <session-id>` | `~/.claude/projects/{escaped-cwd}/{session-id}.jsonl`; filename is the native id and records carry envelope fields such as `sessionId`, `cwd`, `timestamp`, `version`, `gitBranch`, `entrypoint`, and permission mode | Command adapter exists from public CLI semantics and local transcript shape; no installed `claude` executable was available on today's PATH, so capture remains design-not-code | Public docs may differ from installed behavior; escaped-cwd path rules need exact validation; `--continue` and fork semantics may not map cleanly to Reverie's explicit session model; transcript scanner must ignore message content | Installed-CLI click-through, then metadata-only JSONL scanner for cwd/timestamp/sessionId without parsing conversation text |
| Codex CLI | `codex --cd <cwd>`, `codex resume <session-id> --cd <cwd>`, optional `--model`, optional `--dangerously-bypass-approvals-and-sandbox` | `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl`; first record is `type=session_meta` with `payload.id`, `payload.cwd`, `payload.cli_version`, originator/model/provider fields | Command semantics verified against `codex-cli 0.133.0`; shared adapter launch path can synthesize Codex terminal specs from persisted `ShellSession`; native capture scanner not implemented yet | Date-partitioned scan can get expensive without bounding; launch-window matching must handle clock/timestamp formats; resume flags may be version-sensitive; dangerous-mode wording is intentionally scary and should stay explicit | Implement bounded JSONL `session_meta` scanner, then run desktop Codex launch/resume through the same product runtime |

## Terminal/service boundary

The terminal service is responsible for terminal lifecycle, not product semantics.

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

Evaluate `portable-pty` first because Reverie needs macOS, Windows, and Linux coverage.

## Renderer strategy

### Ghostty-backed path

Target-quality path if the spike passes.

Requirements before committing:

- Build `libghostty-vt` bindings in the Rust/Tauri workspace.
- Feed PTY bytes into Ghostty VT state.
- Render visible terminal surface in Tauri.
- Support keyboard, paste, mouse, selection, resize.
- Confirm credible Windows/Linux build story.

### Fallback path

Allowed for v1 only behind the same terminal boundary if Ghostty embedding expands beyond product scope.

The fallback must not leak into product/domain architecture.

## Tauri command/event surface

Initial command candidates:

- `get_onboarding_state`
- `set_onboarding_preferences`
- `detect_agent_clis`
- `list_projects`
- `add_project`
- `archive_project`
- `list_foci`
- `create_focus`
- `update_focus`
- `archive_focus`
- `list_sessions`
- `create_session`
- `start_session`
- `resume_session`
- `write_terminal_input`
- `resize_terminal`
- `terminate_session`

Initial event candidates:

- `cli_detection_changed`
- `session_status_changed`
- `terminal_output`
- `terminal_snapshot_changed`
- `terminal_exit`
- `restore_failed`

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
