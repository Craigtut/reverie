# Inter-Agent Connections

A first-class system for sessions running different agent CLIs to coordinate with each other under explicit user control.

This doc captures the product framing, the UX, the architecture, the required Cortex Code changes, and a phased build plan. It is the canonical plan for this feature. Build work for it should reference this doc rather than rederiving the design.

## Why this exists

Reverie runs many terminal-based agent sessions in parallel. Users frequently want one agent to coordinate with another: hand off a design summary, ask a peer to update a diagram, share progress, pull context from a sibling investigation. Today the user is the only path between sessions: they read one terminal, paste into another. This burns time and breaks the calm-workspace feel.

Inter-agent connections give sessions a way to talk to each other directly, under the user's explicit consent at the moment of connection, with the conversation persisting as part of the durable map of work. The product gain is the same as the product vision says: the user's organized, resumable map of agent work grows richer because now the *relationships* between sessions are first-class artifacts, not transient context the user has to reconstitute.

## Mental model

A **Connection** is a first-class object. It joins two sessions, persists until severed, and carries a transcript of everything the agents said to each other through it.

The unit of consent is the Connection, not the individual message. Once a connection is open, messages flow freely both ways without further prompts. The user retains the ability to close a connection at any time.

Initially, all connections are one-to-one. The domain types and tool surface are designed so a future group-connection variant can be added without renaming or restructuring; group connections are out of scope for v1.

The system has three policy modes the user can switch between: always ask, auto-allow inside the same focus, auto-allow inside the same project, auto-allow anywhere in the workspace. The default is always ask.

## User experience

### Lifecycle states

A Connection moves through four states:

| State | Meaning |
| --- | --- |
| `requested` | An agent has asked to open a connection; the user has not yet decided. |
| `open` | The user has allowed it (or policy auto-allowed it). Messages flow. |
| `closed` | Either side or the user has ended it. Transcript is preserved. |
| `denied` | The user declined the request. No transcript. |

### Initiating a connection

There are two paths:

**Agent-initiated**: the user tells an agent something like "hand the protocol summary to the Cortex session." The agent calls the Reverie Bridge tool `reverie.request_connection(target_address, reason)`. A connection request appears in the UI; the user accepts or denies. The agent receives the result and either starts messaging or backs off.

Agents are explicitly instructed in the bridge tool descriptions not to request a connection without an explicit user request. The system relies on this instruction plus the user's accept gate; speculative pings between agents are stopped at both layers.

**User-initiated**: the user opens a connection from Reverie's UI directly. Two gestures: a "Connect with..." action on a session card, or a drag of one session card onto another. User-initiated connections do not require an accept banner; the user's intent is the consent. Both agents are told they have been connected and given a brief reason supplied by the user.

### The connection request banner

The agent-initiated request banner uses the same visual family as the existing awaiting-permission banner (the breathing glyph and rim-lit panel), which the user already reads as "Reverie needs a decision."

The banner appears in three places simultaneously and the user can act from any one of them:

- The terminal view of the source session, anchored above the terminal pane.
- The terminal view of the target session, mirrored.
- The dashboard, with both session cards visibly attention-marked and a sticky banner near the top.

If Reverie is not the foreground app, a macOS user notification opens; clicking it deep-links to the source session view with the banner already focused.

Banner content for a same-focus request:

```
   Connection requested

   Claude   →   Cortex
   in  Reverie / Inter-agent handoff design

   Reason from Claude:
     Hand off the protocol summary so Cortex can update
     the architecture diagram.

   [ Always allow connections in this focus ]   off

     Deny                          Allow connection
```

Banner content for a cross-project request stacks the addresses on separate lines so the cross-project nature is unmissable, and the "always allow" toggle is forced off:

```
   Connection requested
   This request crosses projects.

   Claude  in  Reverie       / Inter-agent design
         →
   Cortex  in  Tunnel-API    / Auth refactor

   Reason from Claude:
     Pull the auth contract so I can align the protocol.

     Deny                          Allow connection
```

### Connected state

After accept, the request banner collapses into a thin **connection chip** that lives on both session cards. The chip shows the peer's short address; clicking it opens the connection panel; a small dismiss control closes the connection.

On the dashboard, when two session cards are connected, a faint dotted line is drawn between them in the shell layer (outside the terminal paint loop, as required by the design guardrail). The line is visible at a glance; users can see the graph of active connections in a focus without reading any text.

### Connection panel

The connection panel is the canonical "what did these two agents say to each other" surface. It opens from the chip, the dashboard line, or the focus's connection list.

The panel shows:

- The two participants by full address.
- Opened by (agent or user), opened at, reason.
- A flat timeline of messages with direction arrows and timestamps.
- Disconnect and mute controls.

Connections are persistable. When the user reopens Reverie later, closed connections are still visible in the focus's connection list with their full transcripts. This is part of the durable map of work, not transient state.

### Inter-agent messages inside the terminal

The realistic ceiling on rendering inside the CLI's transcript is low across Claude Code and Codex CLI: neither offers a role-customizable inbound message channel with visual styling. Reverie's policy is therefore to keep the in-terminal rendering deliberately minimal and let the shell-level chrome carry the visual weight of identifying inter-agent traffic.

The chrome carries:

- The persistent connection chip on the session card.
- The connection panel timeline.
- The dotted dashboard line.
- The macOS notification at delivery time, if Reverie is backgrounded.

The terminal carries:

- A short `[from cortex]` (or equivalent address) prefix on the message body so the user can read it in context with the agent's own reasoning, but no custom color or styling that the CLI does not natively provide.

This split keeps Reverie consistent across all three CLIs without depending on Claude-specific features like channels.

### Closing a connection

Three closure paths:

- User clicks `×` on the chip or **Disconnect** in the panel.
- Either agent calls `reverie.close_connection(connection_id, reason)`. The common case is "we are done"; the agent supplies a short reason.
- A participating session ends; its connections auto-close with a system-generated reason ("session ended").

Both sides get an inline marker in their transcripts so each agent knows the peer can no longer hear them. The closure event is recorded in the connection's activity log.

### Closed connections cannot silently reopen

If the user closed a connection (or denied a prior request), a new request between the same two sessions still goes through the full request flow. The user's prior denial or disconnect is not auto-applied to future requests; the gate is the prompt itself. Users who want looser behavior set a policy.

### Manual user-initiated connections

The "Connect with..." action and the drag-card-onto-card gesture open a connection without an accept banner. Both agents receive a single system message at open: "You have been connected with `<peer_address>` by the user. Reason: `<user_supplied>`." Either agent may then send the first message.

### Identifiers and addresses

A session's address is rendered uniformly throughout the system:

```
   <agent_kind>  in  <project_name>  /  <focus_title>  ·  #<short_id>
```

The `#<short_id>` is only shown when more than one session of the same kind exists in the same focus, to disambiguate. Otherwise it stays hidden. The address shape is identical in the banner, the chip, the panel, the dashboard endpoints, and the activity log, so users learn one mental shape.

For sessions in the general workspace (no project), the project segment is replaced with `General`.

### Edge cases that affect feel

- **Target is busy** (running a tool, awaiting permission). The request still appears immediately; on accept, the message is queued and delivered when the target reaches a sensible point. The panel shows "queued" so nothing looks lost.
- **One participant ends**. The chip on the remaining side turns muted and reads "session ended." The user may close the chip or leave it as history; the connection's transcript is preserved.
- **Agent denied**. The requesting agent is told "the user declined this connection," with the reason if the user supplied one. The agent decides how to respond in its reply (often: explain to the user, or try a different approach).
- **Repeat denial**. If the user denies a request and the same source asks again for the same target within ten minutes, the banner offers a "Block further requests for 10 min" option in addition to the standard Deny.
- **Multiple peers**. A session may participate in multiple connections at once. The card shows multiple chips. Past four simultaneous connections to one session, Reverie surfaces a soft hint in case it was unintentional.
- **Manual open into a busy target**. The receiving agent gets the same system message as in the normal manual-open path; no special handling is required because the message is queued by the framework's natural turn boundary.

## Settings and policy

The connection policy is workspace-scoped and may be overridden per focus.

```
   When an agent requests a connection...

     ⦿ Always ask before allowing
     ○ Auto-allow within the same focus
     ○ Auto-allow within the same project
     ○ Auto-allow anywhere in the workspace

   Show inter-agent messages in terminals:

     ⦿ Inline, marked as inter-agent
     ○ Only in the connection panel
```

Auto-allow modes apply only to in-scope requests; cross-scope requests (cross-focus inside same project, cross-project anywhere) always ask, regardless of policy. This is a load-bearing rule: it keeps the broader auto-allow modes from accidentally widening the consent surface.

A focus may override the workspace default with a single toggle. Focuses with a looser-than-workspace policy display a small open-lock indicator in the focus header so the user is always reminded.

## Architecture

### Layering

Inter-agent connections sit at the application-service layer, above the domain model and below the Tauri UI. They depend on persistence and the agent adapters; they do not depend on the terminal renderer.

```text
Tauri UI
  ↓ commands/events
Application services
  ↓
Connection service  ←→  Domain model + persistence
  ↓
Reverie Bridge (MCP server, local-socket transport)
  ↓
Agent adapters (CommandSpec.env injection at spawn)
```

The Reverie Bridge is the in-process MCP server that each agent CLI talks to. The connection service owns lifecycle, policy enforcement, identity resolution, and persistence. The UI consumes Tauri commands and events for banners, chips, and the panel.

### Domain types

These types live in `packages/reverie-core` alongside the existing `domain.rs` and `activity.rs`.

```rust
// ConnectionId / RequestId / MessageId are bare type aliases, not newtypes.
pub type ConnectionId = Uuid;
pub type RequestId = Uuid;
pub type MessageId = Uuid;

pub struct Connection {
    pub id: ConnectionId,
    // Participants are stored as two named fields in canonical (sorted) order,
    // not an array; either may have initiated.
    pub participant_a: SessionId,
    pub participant_b: SessionId,
    pub initiator: ConnectionInitiator,
    pub status: ConnectionStatus,
    pub reason_opened: String,
    pub policy_at_open: ConnectionPolicy,
    pub topic: Option<String>,
    pub created_at: String,          // ISO-8601 string; request time, or open time for user-opened
    pub accepted_at: Option<String>, // set once the connection has ever opened
    pub closed_at: Option<String>,
    pub closed_by: Option<ConnectionClosedBy>,
    pub reason_closed: Option<String>,
    // Request metadata lives in a separate struct, populated only while Requested.
    pub pending_request: Option<PendingRequest>,
    pub sequence: u64,
}

// A flat enum; the request metadata is carried by Connection.pending_request.
pub enum ConnectionStatus {
    Requested,
    Open,
    Closed,
    Denied,
}

pub struct PendingRequest {
    pub request_id: RequestId,
    pub requested_at: String,
    pub expires_at: String,
}

pub enum ConnectionInitiator {
    Agent { session_id: SessionId },
    User,
}

pub enum ConnectionClosedBy {
    Agent { session_id: SessionId },
    User,
    SessionEnded { session_id: SessionId },
    Policy { reason: String },
}

pub enum ConnectionPolicy {
    AlwaysAsk,
    AutoAllowFocus,
    AutoAllowProject,
    AutoAllowWorkspace,
}
```

A message in a connection is its own record so the timeline survives independently of the participant sessions' transcripts:

```rust
pub struct ConnectionMessage {
    pub id: MessageId,
    pub connection_id: ConnectionId,
    pub from_session: SessionId,
    pub to_session: SessionId,
    pub body: String,
    pub sent_at: String,                 // ISO-8601 string, matching the rest of the crate
    pub delivered_at: Option<String>,
    pub sequence: u64,
}
```

`topic` on `Connection` is derived from the opening reason on the first open and may be updated by either agent. Topic gives the connection list a scannable label, similar to how a focus has a title.

### Connection service contract

The service exposes a narrow API. UI, MCP bridge, and adapters all use the same surface. `ConnectionService` is a concrete struct over an `Arc<dyn ConnectionRepository>` (the repository is the trait seam, swapped for an in-memory impl in tests), not a trait itself. Time is passed in at each call (`now: impl Into<String>`) so the crate stays free of a time source.

```rust
pub struct ConnectionService { /* repo, registry, policy, pending, observer */ }

impl ConnectionService {
    pub fn list_peers(&self, caller: SessionId, scope: PeerScope) -> Result<Vec<PeerView>>;
    pub fn peer_status(&self, caller: SessionId, peer: SessionId) -> Result<Option<PeerView>>;

    pub fn request_connection(
        &self, initiator: SessionId, target: SessionId,
        reason: impl Into<String>, now: impl Into<String>,
    ) -> Result<RequestOutcome>;

    // Long-poll for the decision; poll_decision is the non-blocking fallback.
    pub fn wait_for_decision(&self, request_id: RequestId, timeout: Duration) -> WaitOutcome;
    pub fn poll_decision(&self, request_id: RequestId) -> Option<WaitOutcome>;

    pub fn accept_request(&self, request_id: RequestId, by: DecisionBy, now: impl Into<String>) -> Result<ConnectionId>;
    pub fn deny_request(&self, request_id: RequestId, by: DecisionBy, now: impl Into<String>, reason: Option<String>) -> Result<()>;

    pub fn user_open(&self, a: SessionId, b: SessionId, reason: impl Into<String>, now: impl Into<String>) -> Result<ConnectionId>;

    pub fn send_message(&self, caller: SessionId, connection_id: ConnectionId, body: impl Into<String>, now: impl Into<String>) -> Result<MessageId>;
    // Read-only view from a sequence cursor; does not stamp delivery.
    pub fn list_messages(&self, caller: SessionId, connection_id: ConnectionId, since_sequence: u64) -> Result<Vec<ConnectionMessage>>;
    // Returns undelivered inbound messages and stamps them delivered.
    pub fn pending_messages(&self, caller: SessionId, connection_id: ConnectionId, since_sequence: u64, now: impl Into<String>) -> Result<Vec<ConnectionMessage>>;

    pub fn close(&self, caller: ConnectionCaller, connection_id: ConnectionId, now: impl Into<String>, reason: Option<String>) -> Result<()>;
}
```

`request_connection` returns a `RequestOutcome`, one of: `Allowed { connection_id }` (policy auto-allowed, already `Open`), `Pending { connection_id, request_id }` (the user must decide; the bridge then `wait_for_decision`s on `request_id`), `AlreadyOpen { connection_id }` (the pair already has an open connection, reused), or `BlockedByPair { blocked_until_secs, reason }` (the user blocked this initiator-target pair for a window). `wait_for_decision` / `poll_decision` return a `WaitOutcome` (`Allowed`, `Denied`, `Timeout`, `Unknown`).

### The Reverie Bridge: MCP server surface

The bridge is the call surface every agent CLI sees. It exposes a small set of tools.

| Tool | Purpose |
| --- | --- |
| `reverie.list_peers(scope?)` | Returns currently active sibling sessions visible to the caller, by address and current activity summary. `scope` defaults to "focus" and may widen to "project" or "workspace". |
| `reverie.peer_status(peer)` | Returns richer state for one peer: current activity, last meaningful line, whether the caller already has an open connection to it. |
| `reverie.request_connection(target, reason)` | Returns `allowed`, `pending(request_id)` (the user has not decided yet), `already_open`, or `blocked_by_pair`. |
| `reverie.wait_for_decision(request_id)` | Long-poll for a pending request's outcome: blocks up to the configured wall-clock window, returning `allowed`, `denied`, or `timeout`. |
| `reverie.poll_decision(request_id)` | Non-blocking poll fallback for the same outcome. |
| `reverie.send_message(connection_id, message)` | Sends a message through an open connection. |
| `reverie.pending_messages(connection_id)` | Returns undelivered inbound messages and marks them delivered. |
| `reverie.close_connection(connection_id, reason?)` | Closes a connection. |
| `reverie.list_connections()` | Lists every connection the caller participates in, in every status. |
| `reverie.get_connection(connection_id)` | Fetches one connection by id, including its full record. |

Tool descriptions, which the model reads every turn, carry the behavioral hints. Examples:

> `reverie.request_connection` — Open a connection to another session so you and that session's agent can talk directly. Call this only when the user has explicitly asked you to coordinate with another agent. The user will be prompted to allow the connection.

> `reverie.list_peers` — List sibling agent sessions currently active in this workspace. Call this when the user mentions another session by name or asks you to coordinate with another agent.

This carries the "do not initiate without a user request" rule at the tool layer rather than as a one-time prompt at session start. The instruction is fresh every turn and travels with the tool.

### Transport: stdio MCP + local socket

The bridge is exposed to CLIs as a stdio MCP server. The helper that the CLI spawns is a small binary (`reverie-bridge`, shipped with the desktop app). The helper translates stdio MCP traffic into a local-socket protocol to the running Reverie desktop process. The Reverie process owns the connection service and the domain model; the helper is a thin proxy.

```text
Cortex Code / Claude Code / Codex CLI
  ↓ spawns
reverie-bridge (stdio MCP server)
  ↓ Unix socket / named pipe
Reverie desktop (Tauri process)
  ↓
ConnectionService → Domain → Persistence
```

This shape keeps the bridge logic in one place (the desktop process), avoids putting business logic into the helper, and means hot-reloading the bridge logic only requires restarting the desktop app, not all running CLI sessions.

If the desktop app is not running, the helper returns a clear error to the CLI ("Reverie is not running; connections are unavailable in this session"). The agent surfaces this to the user and continues without connections.

### Identity and authentication

Reverie spawns each agent CLI with three environment variables set in `CommandSpec.env`:

```
REVERIE_SESSION_ID=<uuid>
REVERIE_SESSION_SECRET=<random>
REVERIE_BRIDGE_SOCK=<path>
```

When the helper connects to the desktop over the local socket, it presents the session id and the secret. The desktop matches them against its registry. Sessions not spawned by Reverie (or sessions where the env was lost) fail authentication; their tool calls return a structured "not a recognized Reverie session" error.

This identity model is sufficient for v1. It assumes the desktop trusts subprocesses it has spawned; a future hardening pass could match the helper's PID against the spawned session's PID for stronger guarantees.

### Long-poll with progress heartbeat

`reverie.request_connection` returns immediately (`allowed` when policy auto-allows, otherwise `pending(request_id)`, plus `already_open` / `blocked_by_pair`). `reverie.wait_for_decision` is the tool that blocks waiting on a human. The pattern:

1. `request_connection` writes a `requested` row, computes `expires_at = now + 0.8 * configured_tool_timeout`, and returns `pending(request_id)`.
2. The agent calls `wait_for_decision(request_id)`, which blocks up to the window. While waiting, the bridge emits MCP `notifications/progress` with a "still waiting" message every 10 seconds. Any CLI that surfaces progress will show the user "still waiting on connection accept."
3. If the user accepts within the window, `wait_for_decision` returns `allowed(connection_id)`.
4. If the user denies, it returns `denied`.
5. If the window elapses without a decision, it returns `timeout`. The connection remains `requested`; the agent may call `poll_decision(request_id)` on later turns to retrieve the eventual outcome.

The configured tool timeouts (set per CLI at first-run consent, see below) determine the wall-clock window. Recommended values are 600s (Claude Code, Codex CLI) and the default-via-patch-plus-override for Cortex.

### Inbound delivery: telling an agent it has a message

The receiving agent does not poll for messages on its own. The system tells it at turn start when there is something to read. The mechanism is "prepend a short context note on the receiver's next user-prompt-submit" and the implementation per CLI:

| CLI | Mechanism | Source |
| --- | --- | --- |
| Claude Code | `UserPromptSubmit` hook returns `additionalContext` saying "You have N unread messages on connection `<label>` (id `<id>`). Call `reverie.pending_messages` with that connection id to read them." | Reverie hook server (`hook_server.rs`), reusing the existing translator pattern |
| Codex CLI | Same: `UserPromptSubmit` hook with `additionalContext` injection | Reverie hook server, same path |
| Cortex Code | A new generic Cortex pre-turn hook surface (see Cortex changes below), with the same payload | Cortex Code |

The agent then calls `reverie.pending_messages` and gets the message bodies (which also stamps them delivered). The body itself is prefixed `[from <peer_address>] <message>` so the model reads it as inter-agent context, distinct from user input, even when no styling is available.

The Claude/Codex `UserPromptSubmit` path is built: the hook server consults a `HookPushSource` (implemented by `ConnectionService`) on every `UserPromptSubmit` and returns the unread-message nudge as `additionalContext` (`hook_server.rs`). The Cortex pre-turn hook surface is the remaining producer-side piece.

Claude Code's MCP "channels" feature is available as an opt-in optimization for Claude users: when enabled, message delivery is push-immediate rather than next-turn. This is purely additive and not relied on by the core design, since channels are Claude-only and gated on Anthropic auth.

### Activity events and persistence

Connection lifecycle emits structured events that flow into the existing activity stream. These attach to both participant sessions' `events.jsonl` and also accumulate on the connection itself.

```text
connection_requested
connection_allowed
connection_denied
connection_message_sent
connection_message_received
connection_closed
```

This makes the connection's history queryable from the same machinery the dashboard already consumes to render `latest_activity`. Old connections become part of the focus's durable map of work without a separate persistence story.

Persistence shape (SQLite, mirroring the existing recommended schema):

```sql
connections(
  id text primary key,
  participant_a text not null,
  participant_b text not null,
  initiator_kind text not null,
  initiator_session_id text,
  status text not null,
  reason_opened text not null,
  reason_closed text,
  topic text,
  policy_at_open text not null,
  opened_at text not null,
  closed_at text,
  closed_by_kind text,
  closed_by_session_id text,
  sequence integer not null
);

connection_messages(
  id text primary key,
  connection_id text not null,
  from_session text not null,
  to_session text not null,
  body text not null,
  sent_at text not null,
  delivered_at text,
  sequence integer not null
);
```

## CLI registration: respecting the credential-home guardrail

The implementation-queue notes a paused Claude/Codex hook integration because redirecting `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `HOME` / `XDG_CONFIG_HOME` also redirects each CLI's credential and config home, which causes sign-in prompts and breaks user identity. `start_session` refuses launches that override those variables.

Inter-agent connections must respect that constraint. The chosen approach:

- Reverie does not redirect any credential or config home.
- Reverie registers the bridge once per CLI by writing a single namespaced entry to the user's existing global config, with explicit consent at first-run onboarding.
- Reverie injects only its own scoped environment variables (`REVERIE_SESSION_ID`, `REVERIE_SESSION_SECRET`, `REVERIE_BRIDGE_SOCK`) at session spawn. The `start_session` env guard is widened to allow these specific variables while continuing to refuse credential-home redirects.

The registration writes per CLI:

| CLI | Where Reverie writes | How |
| --- | --- | --- |
| Cortex Code | `~/.cortex/mcp.json` | Reverie writes the file directly (Cortex's expected config). Hot-reload in Cortex Code picks up changes in running sessions. |
| Claude Code | `~/.claude.json` | Reverie merges a `reverie_bridge` entry directly into the top-level `mcpServers` object (`write_claude_mcp_entry` in `bridge_installer.rs`), preserving the user's other keys. Uninstall is a direct file edit that removes only that key. |
| Codex CLI | `~/.codex/config.toml` | Reverie appends a `[mcp_servers.reverie_bridge]` entry with a clear Reverie-managed marker comment. |

Each write is preceded by an explicit consent prompt in Reverie's onboarding, with the exact text and file path shown. The prompt is one-time per CLI. Reverie also provides an "uninstall bridge from `<cli>`" affordance in settings that removes the entry.

Connection-time behavior at spawn:

1. The session's `CommandSpec.env` is built normally (no credential-home overrides).
2. Reverie injects the three `REVERIE_*` env vars.
3. Reverie registers the session id + secret with the bridge's in-memory registry.
4. The CLI launches; its MCP loader sees `reverie_bridge` already configured in the user's global config; the helper is spawned; the helper presents the env-supplied identity to the desktop; the session is authenticated.

If the user has not consented to bridge installation for a given CLI, sessions of that CLI launch normally with no bridge present; the agent's tool list does not include `reverie.*` and the rest of the system functions exactly as it does today.

## Cortex Code changes

We own Cortex Code, and the work needed to make inter-agent connections work end-to-end on Cortex is also the work needed to make Cortex's MCP and hook surfaces generically more useful. Three changes, all generic.

### 1. MCP `callTool` honors timeout and progress

`packages/cortex/src/mcp-client.ts` currently calls `client.callTool({ name, arguments })` with no timeout, no progress handler, and no `resetTimeoutOnProgress`. The default SDK timeout of 60 seconds applies, which is too short for human-decision tools like connection requests, and progress notifications are ignored.

Required change:

- Read a per-server `timeout` (ms) from the MCP server config; default to 60 seconds for backward compatibility.
- Pass `{ timeout, resetTimeoutOnProgress: true, onprogress }` to `callTool`.
- Surface `onprogress` messages through the existing event bridge so the TUI can show "still waiting" for long-running MCP tools.

This is a small, contained change. It benefits any slow MCP tool, not just the bridge.

### 2. Hot-reload of MCP server config between turns

`packages/cortex-code/src/session.ts` calls `connectMcpServersWithTrust()` once at startup. There is no watcher. Editing `.cortex/mcp.json` or `~/.cortex/mcp.json` mid-session has no effect until the user restarts.

The framework already supports the underlying mechanics:

- `CortexAgent.connectMcpServer(name, config)` and `disconnectMcpServer(name)` are public.
- `McpClientManager.onToolsChanged` fires when servers connect or disconnect, and is already wired to `CortexAgent.refreshTools()`.
- `refreshTools()` rewrites the agent's tool state between turns.

What is missing is the watcher and the diff logic in `cortex-code`. The change:

- Add a `chokidar` watcher on `~/.cortex/mcp.json` and `.cortex/mcp.json` scoped to the session's cwd.
- On change, debounce and re-discover servers.
- Diff against the live connection states.
- Connect added servers, disconnect removed servers, reconnect modified servers.
- Schedule the reload to apply between turns when `session.isRunning === true`, since `pi-agent-core` snapshots tool state at `prompt()` entry. Use the existing `loop_end` hook as the apply boundary.
- Apply Cortex Code's existing trust-on-first-use logic to newly-discovered project servers.
- Add a `/mcp-reload` slash command to manually trigger reconciliation (useful when iterating).

This benefits Cortex users generally: any user editing MCP config mid-session no longer has to restart.

### 3. Generic pre-turn hook surface

For inbound delivery on Cortex, the receiving agent needs a system-injected note at turn start saying "you have new messages." Today, Cortex Code has a single hardcoded `transformContext` that the consumer wires; there is no out-of-process hook surface analogous to Claude Code's `UserPromptSubmit`.

The right architectural move is to add a generic Cortex pre-turn hook surface, configured in a hooks file:

- Hooks defined in `~/.cortex/hooks.json` (user scope) and `.cortex/hooks.json` (project scope).
- Event names: `pre_turn`, `post_turn`, `pre_tool_use`, `post_tool_use`, `session_start`, `session_end`. v1 ships at least `pre_turn`; the others can land later.
- Handlers run as subprocesses receiving JSON on stdin and emitting JSON on stdout, mirroring Claude Code's contract for portability of mental model.
- A `pre_turn` handler may return `additional_context: string` that is prepended to the next user prompt as opaque context.

Reverie's bridge ships a small handler that the user installs at first-run consent ("Reverie wants to install a Cortex hook that checks for incoming messages before each turn"). The handler talks to the bridge over the same `REVERIE_BRIDGE_SOCK` and returns inbound-message context if any exists.

This is the largest of the three Cortex changes and the most architecturally consequential. It is also the right one: Cortex needs hook surfaces eventually for the same reasons Claude and Codex do, and Reverie should not special-case itself in Cortex Code in a way that prevents other consumers from doing the same thing later.

### 4. Tool-result rendering hint

Small UI tweak: when a tool result body starts with `[from <name>]`, render the prefix with the same dimmed treatment Cortex uses for system meta lines. This is a one-line styling pass; it gives the user a visible cue without changing semantics.

## Phased build plan

Each phase ends at a verifiable gate. Phases are not parallelizable except where called out: later phases assume earlier work has landed and been tested.

### Phase 0: Foundation in `reverie-core`

Goal: a working connection registry and bridge skeleton, no UI yet.

Work:

- Add `connection` module to `reverie-core` with `Connection`, `ConnectionMessage`, `ConnectionStatus`, `ConnectionPolicy`, etc.
- Define `ConnectionService` trait and an in-memory implementation.
- Define the bridge protocol (the local-socket request/response shapes between helper and desktop).
- Write the `reverie-bridge` helper binary that proxies stdio MCP to the local socket. Tools at first: `list_peers`, `peer_status`. No connections yet, just listing.
- Wire `REVERIE_*` env vars at spawn in `terminal_runtime` / `agent adapters`. Widen the `start_session` env guard to allow these three variables while still refusing credential-home overrides.

Gate:

- `cargo test` for `reverie-core::connection` passes, including a unit test that exercises `list_peers` across two mock sessions.
- Bridge helper handshake, identity check, and `list_peers` return work end-to-end in a Rust integration test that spawns the helper as a subprocess.
- The `start_session` env-guard tests still pass and still refuse credential-home overrides.

### Phase 1: Cortex Code generic patches

Goal: Cortex Code can call slow MCP tools, can hot-reload MCP config, and can run pre-turn hooks. These are prerequisites for the rest, and they are useful independently.

Work:

- Land the `mcp-client.ts` timeout/progress patch with tests.
- Land the `.cortex/mcp.json` watcher and diff/apply path with tests. Add `/mcp-reload`.
- Land the generic pre-turn hook surface with tests. Use a fake handler in tests; real handler comes later.

Gate:

- Cortex Code tests pass for all three patches.
- A test harness verifies: editing `mcp.json` while a session is idle hot-loads a new MCP server; calling a tool whose handler sleeps for 90s succeeds when `timeout: 120000` is configured; a configured `pre_turn` handler is invoked and its `additional_context` is prepended.
- A new Cortex Code release is cut.

This phase is the long pole. It should be done before Reverie depends on any of it.

### Phase 2: First end-to-end connection

Goal: two Cortex sessions in the same focus can open a connection, exchange a few messages, and close it. No UI yet; only the activity log.

Work:

- Onboarding consent flow for Cortex bridge registration: write `~/.cortex/mcp.json` after consent.
- Bridge tools `request_connection`, `wait_for_decision` / `poll_decision`, `accept_request` (driven from a temporary CLI in the desktop process), `send_message`, `pending_messages`, `close_connection`.
- Reverie's bridge ships the pre-turn hook handler installed alongside its config; consent extends to installing the hook.
- Persistence: connections and messages written to the existing JSON store; SQLite migration deferred until Phase 5.
- Activity events emitted to both participant sessions.

Gate:

- A scripted test launches two Cortex sessions, opens a connection between them via the bridge, exchanges three messages each way, closes the connection, and verifies the activity log contains the expected events on both sides.
- The connection is queryable from the connection service.

### Phase 3: Codex CLI integration

Work:

- Onboarding consent for Codex bridge registration: append `[mcp_servers.reverie_bridge]` to `~/.codex/config.toml`.
- Codex hook integration via the existing `hook_server.rs`: extend the translator to emit a `UserPromptSubmit` hook payload that nudges the agent to call `pending_messages` and returns `additionalContext`. Tool timeout in the bridge entry set to 600s.
- Configuration: per-session env injection mirrors Cortex.

Gate:

- A scripted test runs Codex CLI alongside a Cortex session, opens a connection, exchanges messages, closes. Inter-agent messages arrive via the hook mechanism, not a custom Codex pre-turn hook.

### Phase 4: Claude Code integration

Work:

- Onboarding consent for Claude bridge registration: merge a `reverie_bridge` entry into `~/.claude.json`'s `mcpServers` directly (`write_claude_mcp_entry`) with `timeout: 600000`.
- Hook integration via `hook_server.rs` `UserPromptSubmit` handler (same translator pattern, Claude payload).
- Channels: optional. If the user has enabled channels and the bridge declares `claude/channel`, deliver messages via push. Behind a feature flag for v1.

Gate:

- Three-way test: Claude, Codex, and Cortex sessions in the same workspace. Each can open a connection to each. All three exchange messages successfully.

### Phase 5: UI

Work:

- Connection request banner, reusing the awaiting-permission visual family.
- Connection chip on session cards.
- Connection panel with timeline.
- Dotted-line connection indicator on the dashboard (shell layer only, outside the terminal paint loop).
- Settings: policy selector, terminal rendering toggle.
- Macros: "Connect with..." action, drag-card-onto-card gesture for user-initiated connections.

Gate:

- A `npm run dev:harness` walkthrough exercises: opening a connection via the agent path; opening via user gesture; receiving and viewing messages in the panel; closing; reopening a previously-closed connection and seeing its history.
- The connection chip and dashboard line render correctly in light and dark.

### Phase 6: Persistence migration and durability

Work:

- Move connections and messages from the JSON store to SQLite per the schema sketch in this doc.
- Migration covers existing v1 JSON data.
- Connection history survives desktop restarts and is replayable from the panel.

Gate:

- The SQLite migration runs cleanly on stores that contain Phase 2-5 data.
- Connections opened before the migration appear correctly after restart.

### Phase 7: Cross-project and policy granularity

Work:

- Cross-project request banner with stacked addresses and the "always allow" toggle forced off.
- Focus-level policy override and the open-lock indicator on focus headers.
- Repeat-denial rate-limit affordance ("Block further requests for 10 min").

Gate:

- Cross-project request flow tested end-to-end.
- Policy overrides exercised in tests for all four levels.
- Rate-limit affordance verified in UI walkthrough.

## Risks

| Risk | Mitigation |
| --- | --- |
| Claude Code's hard per-tool timeout puts a low ceiling on how long a banner can wait. | Configure `timeout: 600000` in the bridge entry at registration. Pending-receipt fallback covers cases where the user takes longer. |
| Codex CLI MCP hook semantics drift across versions. | Pin behavior to verified Codex versions in `cortex-mono`-style fashion; document the verified versions in this file as Codex changes land. |
| Cortex pre-turn hook surface is generic infrastructure; scope creep could enlarge it past v1's needs. | Ship only `pre_turn` in Phase 1. Other event names can come in follow-up work without breaking this design. |
| Registration writes user config files. | Onboarding shows the exact file and entry to be written. Uninstall affordance removes the entry. Bridge entries are namespaced (`reverie_bridge`) so they cannot collide with user-defined servers. |
| Bridge helper binary distribution. | Shipped as a Tauri `externalBin` sidecar next to the main binary in `Contents/MacOS/`, code-signed with the app. The load-bearing invariant is "the helper lives beside the desktop binary", so registration just writes `current_exe().parent()/reverie-bridge`. `scripts/stage-bridge.mjs` builds the two helpers and stages them for both the bundle (`binaries/<name>-<triple>`) and dev (next to the dev exe). See [packaging-and-distribution.md](packaging-and-distribution.md). |
| A long-running MCP tool ties up an agent's turn in a way the user did not expect. | Heartbeat progress notifications keep the user informed when the CLI supports them. Pending-receipt fallback is the safety valve when wall-clock expires. |
| Cortex Code's `pi-agent-core` snapshots tool state at `prompt()` entry, so a mid-turn hot-add is invisible until the next turn. | Always apply hot-reload between turns (at `loop_end`). Documented in the Cortex changes section above. |

## Guardrails specific to this feature

In addition to the global Reverie guardrails:

- Connections are an explicit consent model. Auto-allow modes exist but are off by default and never cross focus or project boundaries without their own prompt.
- Agents must not initiate connections without an explicit user request, both as a tool description rule and as a runtime norm.
- Reverie does not redirect credential or config homes for any CLI. Registration writes one namespaced entry per CLI with one-time user consent, and is reversible.
- Bridge identity is per-session and verified against the desktop's session registry; sessions not spawned by Reverie cannot use the bridge.
- Inter-agent message rendering uses shell-level chrome for the visual identity and minimal in-terminal prefixes for content. Reverie does not depend on Claude-specific features (channels) for the core delivery path.
- Connections must never cross the terminal paint loop. The dotted dashboard line and the chip live in the shell layer.

## Open questions

These are not blockers; they should be revisited as the relevant phases land.

1. **Bridge helper distribution shape**. *Resolved.* The helper ships as a Tauri `externalBin` sidecar next to the main binary, built and staged by `scripts/stage-bridge.mjs`. `resolve_bridge_binaries` finds it via `current_exe().parent()` (with a dev-only fallback to the workspace target dir), and install refuses to write a path that does not exist on disk. See [packaging-and-distribution.md](packaging-and-distribution.md).
2. **Reason field at disconnect**. Optional vs required for agent-initiated close. Leaning optional with a "did you mean to say..." prompt to the agent if it omits one. Decide before Phase 2 closes.
3. **Topic derivation**. v1 derives topic from the opening reason. A future enhancement could ask one of the agents to propose a tighter topic after the first few messages.
4. **Multiple sessions of same kind in same focus**. The `#<short_id>` disambiguator works, but the address gets noisier. Consider letting users rename sessions so the disambiguation is human-meaningful.
5. **Group connections (v2 placeholder)**. The connection-id-centric tool surface keeps this door open. If group connections come, they will be a new connection variant (`participants: Vec<SessionId>` with a `@mention` send semantics) addressed by the same `connection_id`.
6. **Channels feature flag**. Whether Claude Code channels delivery should be opt-in (user enables in settings) or opt-out (Reverie tries channels first, falls back to hooks). Lean opt-in for v1 because channels are research-preview.

## Cross-references

- Product framing: [`docs/product-vision.md`](../product-vision.md)
- Visual language for banners and panels: [`docs/design-vision.md`](../design-vision.md)
- Domain types this builds on: [`docs/technical/technical-architecture.md`](technical-architecture.md)
- Activity state contract used for connection lifecycle events: [`docs/technical/cortex-activity-contract.md`](cortex-activity-contract.md)
- Current build queue and gate list: [`docs/technical/implementation-queue.md`](implementation-queue.md)
