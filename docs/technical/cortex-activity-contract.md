# Cortex Code activity-state contract

> Authoritative spec for the per-session activity-state surface that Cortex Code writes and Reverie reads. This document is the single source of truth: cortex-mono is the producer, Reverie is the consumer. Either side changing the shape requires updating this file first.

## Goal

Let Reverie surface, non-hackily, the live activity state of every running Cortex Code session: `working`, `awaiting_input`, `awaiting_permission`, `awaiting_response`, `done`, `error`. State must be readable late (Reverie can start *after* a Cortex session is already running) and reactive (state changes are observable in near real-time via filesystem events).

Reverie does not need conversation content, model output, token usage, or costs. Cortex's existing `meta.json` / `history.json` already cover that. This surface is exclusively about *what is the agent doing right now*.

## Location

```text
~/.cortex/sessions/{sessionId}/
├── meta.json           ← existing
├── history.json        ← existing
├── observations.json   ← existing (when observational compaction is enabled)
└── activity/
    ├── state.json      ← authoritative current state
    ├── events.jsonl    ← append-only event log
    ├── events.1.jsonl  ← previous rotation
    └── …
```

`{sessionId}` is the same id Cortex already uses for the session directory and that `meta.json.id` carries.

## File permissions

Directories `0700`, files `0600`. Owned by the user running Cortex.

## `state.json` — current state

Authoritative snapshot of the session's live activity state. Written atomically (temp file + rename) on every transition. Reverie reads this file on startup to learn current state without replaying events.

### Schema

```json
{
  "version": 1,
  "sessionId": "uuid-or-existing-cortex-session-id",
  "status": "awaiting_permission",
  "updatedAt": "2026-05-28T12:34:56.789Z",
  "sequence": 42,
  "cwd": "/Users/user/Code/reverie",
  "turn": {
    "id": "turn-7",
    "status": "running",
    "startedAt": "2026-05-28T12:34:10.000Z",
    "endedAt": null
  },
  "activeTools": [
    {
      "toolCallId": "tc-1",
      "toolName": "Bash",
      "startedAt": "2026-05-28T12:34:30.000Z"
    }
  ],
  "awaitingPermission": {
    "id": "perm-1",
    "toolName": "Bash",
    "displaySummary": "Run shell: rm -rf foo/",
    "args": {
      "command": "rm -rf foo/"
    },
    "requestedAt": "2026-05-28T12:34:56.789Z"
  },
  "lastError": null,
  "finalExit": null
}
```

### Field reference

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `version` | `1` | yes | Schema version; bump on any breaking change. |
| `sessionId` | string | yes | Same id as the parent directory. |
| `status` | enum | yes | `working` \| `awaiting_input` \| `awaiting_permission` \| `awaiting_response` \| `done` \| `error`. (`awaiting_response` is the wire name for the `AwaitingResponse` variant in `activity.rs`, serialized via `#[serde(rename_all = "snake_case")]`.) |
| `updatedAt` | RFC 3339 timestamp | yes | Wall-clock time of this transition. |
| `sequence` | integer | yes | Monotonically increases across every event. Reverie uses this to detect missed events. |
| `cwd` | string | yes | Mirrors `meta.json.cwd`; included for fast filtering without reading meta. |
| `turn` | object \| null | when applicable | Current or most-recent turn. `null` before any turn has started. |
| `turn.id` | string | yes | Stable id Cortex assigns to the turn. |
| `turn.status` | enum | yes | `running` \| `completed` \| `aborted`. |
| `turn.startedAt` | timestamp | yes | When the turn began. |
| `turn.endedAt` | timestamp \| null | yes | Null while running. |
| `activeTools` | array | yes | Tools currently executing in this turn. Empty array when none. |
| `activeTools[].toolCallId` | string | yes | Stable id for correlation with events. |
| `activeTools[].toolName` | string | yes | E.g. `Bash`, `Edit`, `Read`. |
| `activeTools[].startedAt` | timestamp | yes | |
| `activeTools[].displaySummary` | string \| null | optional | Producer-supplied human-readable summary for this active tool, e.g. `"Run shell: npm test"`. Reverie renders this in the dashboard activity line so it doesn't need per-tool knowledge to phrase the running label. |
| `activeTools[].childTaskId` | string \| null | optional | Correlation id when the tool spawned a tracked sub-task. |
| `awaitingPermission` | object \| null | yes | Non-null iff `status == "awaiting_permission"`. |
| `awaitingPermission.id` | string | yes | Stable id for correlation with `permission_resolved` events. |
| `awaitingPermission.toolName` | string | yes | |
| `awaitingPermission.displaySummary` | string | yes | Human-readable, privacy-safe summary Cortex generates. **This is what Reverie shows by default.** E.g. `"Run shell: rm -rf foo/"`, `"Edit src/main.rs"`. Never includes large/sensitive args (file contents, secrets). |
| `awaitingPermission.args` | object | optional | Sanitized structured args for disclosure / debug UI. Reverie shows them behind an expand affordance, never in the default label (see `displaySummary`). The producer sanitizes large or sensitive values: e.g. for `Edit` / `Write`, `old_string` and `new_string` are replaced with `{ preview, bytes, lines, truncated }` summaries rather than the raw content. For `Bash` the `command` string is kept intact because it is the meaningful unit to display. |
| `awaitingPermission.requestedAt` | timestamp | yes | |
| `lastError` | object \| null | yes | Latest visible error since session start. Distinct from `done` so recoverable errors aren't conflated with shutdown. |
| `lastError.category` | enum | yes | `rate_limit` \| `authentication` \| `network` \| `context_overflow` \| `cancelled` \| `other`. |
| `lastError.message` | string | yes | Plain-language message. |
| `lastError.recoverable` | bool | yes | True if the session can continue. False means the session is effectively dead. |
| `lastError.occurredAt` | timestamp | yes | |
| `finalExit` | object \| null | yes | Non-null only when `status == "done"`. |
| `finalExit.code` | integer \| null | yes | Process exit code if available. |
| `finalExit.signal` | string \| null | yes | Signal name (e.g. `"SIGTERM"`) if the process was killed. |
| `finalExit.reason` | enum | yes | `user_quit` \| `shutdown_command` \| `eof` \| `error` \| `unknown`. |

### Atomic write protocol

Cortex must:

1. Serialize the complete JSON to bytes.
2. Write to a temp file in the same `activity/` directory: e.g. `state.json.tmp.{pid}.{rand}`.
3. `fsync` the temp file.
4. `rename` (POSIX atomic) the temp file over `state.json`.
5. Optionally `fsync` the parent directory.

Reverie may read `state.json` at any time and is guaranteed never to see a torn write.

### Status semantics

| Status | Meaning |
| --- | --- |
| `working` | An agent turn or tool call is currently active. |
| `awaiting_input` | Idle; the previous turn completed and Cortex is ready for the next user prompt. The session process is still alive. |
| `awaiting_permission` | Blocked on a user decision for a tool/command. `awaitingPermission` is non-null. |
| `awaiting_response` | Blocked mid-turn waiting for the user to answer a question or approve a plan (e.g. an MCP elicitation dialog, or Claude's AskUserQuestion / ExitPlanMode equivalents). The turn is still live and cannot proceed until the user responds, so it reads as attention. Unlike `awaiting_permission` it is not suppressed by auto-approve. |
| `done` | Cortex process or session exited normally. `finalExit` is non-null. |
| `error` | Unrecoverable or session-visible error. `lastError.recoverable` should be `false` for a session that's effectively dead; otherwise prefer keeping `status` at its previous value and just updating `lastError`. |

Transitions to watch:

- `awaiting_input` → `working`: a user prompt was submitted.
- `working` → `awaiting_permission`: a tool needs approval.
- `awaiting_permission` → `working`: permission resolved (allowed) and execution resumed.
- `awaiting_permission` → `awaiting_input`: permission resolved (denied/cancelled) and the turn ended.
- `working` → `awaiting_input`: turn completed.
- any → `done`: process exited.
- any → `error` (recoverable): session continues; `lastError` populated.

## `events.jsonl` — event stream (forward-looking; not yet consumed)

Append-only newline-delimited JSON. Each line is one event. This is the richer history signal for surfaces that want a timeline (per-card "what just happened" lines, timelines, debugging), but it is a forward-looking, optional surface that **Reverie does not consume today**. The current state is always available in `state.json`, and `state.json` is the only file the live watcher reads (see [`cortex_state.rs`](../../packages/reverie-core/src/cortex_state.rs)). The schema below is the agreed shape so a producer can start writing it; the typed reader exists in [`activity.rs`](../../packages/reverie-core/src/activity.rs) (`ActivityEvent`, `parse_event`, `parse_events`) and is exercised by tests, but no runtime code tails the file. When a consumer is built it will follow the schema and inode-tailing/rotation rules described here.

### Write atomicity

Cortex opens `events.jsonl` with `O_APPEND` and writes each event as a single `write(2)`. POSIX guarantees writes ≤ `PIPE_BUF` (4096 bytes on macOS/Linux) under `O_APPEND` are atomic. Event records are expected to fit well under this; if a record would exceed 4 KB it must be split or trimmed by the producer.

### Event envelope

```json
{
  "version": 1,
  "sequence": 43,
  "sessionId": "uuid",
  "type": "tool_call_started",
  "timestamp": "2026-05-28T12:35:00.000Z",
  "payload": { /* type-specific */ }
}
```

`sequence` must match the corresponding `state.json.sequence` after the event is applied.

### Event types

| `type` | When | Payload |
| --- | --- | --- |
| `status_changed` | Any top-level status transition. | `{ "from": Status, "to": Status }` |
| `turn_started` | New agent turn begins. | `{ "turnId": string, "trigger": "user_prompt" \| "auto" }` |
| `turn_ended` | Turn completes or aborts. | `{ "turnId": string, "outcome": "completed" \| "aborted", "durationMs": number }` |
| `tool_call_started` | Tool execution begins. | `{ "toolCallId": string, "toolName": string }` |
| `tool_call_ended` | Tool execution finishes. | `{ "toolCallId": string, "toolName": string, "isError": boolean, "durationMs"?: number }` |
| `permission_requested` | A tool requested user approval. | Same shape as `state.json.awaitingPermission`. |
| `permission_resolved` | The pending permission was answered. | `{ "id": string, "toolName": string, "resolution": "allowed" \| "denied" \| "cancelled" \| "expired" \| "error" }` |
| `error` | A session-visible error occurred. | Same shape as `state.json.lastError`. |

### Rotation policy

When `events.jsonl` exceeds **5 MB**, Cortex must:

1. Atomically rename `events.jsonl` → `events.1.jsonl` (and previous `events.1.jsonl` → `events.2.jsonl`, etc.).
2. Keep at most **5 rolled files** (`events.1.jsonl` … `events.5.jsonl`); older files are deleted.
3. Open a new `events.jsonl` for the next event.

A future `events.jsonl` consumer would tail the file by inode; when the inode changes it would pick up the new file. The rolled files exist purely for offline replay/debugging; a consumer may ignore them. (No code tails this file today; `state.json` is the only surface read.)

## Late-start discovery

Reverie may launch after a Cortex session is already running. Reverie does not enumerate or watch the whole `~/.cortex/sessions/*/` tree. The session-log engine ([`cortex_state.rs`](../../packages/reverie-core/src/cortex_state.rs)) watches only the active `state.json` files the launch path explicitly registers, so cost scales with active sessions rather than with the whole sessions directory. At boot Reverie registers the watch file for each session it already owns (via the native ref captured in its own store), and registers a session's file shortly after launching it. For each such session it:

1. Reads `meta.json` (already does this) and, if present, the sibling `activity/state.json`.
2. Treats `state.json` as authoritative current state. If the file is absent the session predates the activity surface; Reverie falls back to its current adapter behavior (treats as `done` if exited, `restorable` if a native ref exists, etc.).
3. Watches that one `activity/state.json` for changes via filesystem events.

The producer should still create `activity/` and write `state.json` even when a session was started before the surface existed, so the next time Reverie registers the file the snapshot is present.

## Reverie's responsibilities

- Watch the registered active sessions' `activity/state.json` files (not the whole `~/.cortex/sessions/*/` tree) via FSEvents (macOS) / inotify (Linux) / ReadDirectoryChangesW (Windows). The `notify` crate handles all three.
- Parse atomically. If a read returns invalid JSON, ignore and wait for the next change event (this should be impossible given the temp-file-rename protocol, but be defensive).
- Tolerate missing fields by treating older `version` files as best-effort.
- Surface state changes to the UI within ~200 ms of the file write.
- Never write to the activity directory. This is a one-way contract: Cortex writes, Reverie reads.

## Open contract questions

None at the time of writing. If new ones arise during implementation, add them here before changing either side.

## Reusability note

Claude's Agent View persists a similar per-session `~/.claude/jobs/{id}/state.json`. If the Reverie-side watcher is written generically (over a `(root_dir, schema_version, state_filename, events_filename)` config), the same code path can serve Claude's surface and any future CLI that adopts this pattern. We should keep the watcher CLI-agnostic for that reason.
