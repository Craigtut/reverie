# Approval cards

> Part of the [core experience](README.md). The richest example of principle 2: capability-tiered, graceful degradation across CLIs.

## Problem

When an agent wants to run a command or apply a patch that needs permission, the approval happens inside the CLI's own TUI. To clear several blocked agents you must open each terminal, read it, and answer in place: N context switches for N trivial yes/no decisions. We want to answer from a native card on the home, without leaving the orchestration layer, and without giving up the real TUI (which is non-negotiable product value).

The complication is that the CLIs differ in what they let us do, and we will keep adding more. So this is not "build an approval UI for three CLIs." It is "build one capability-tiered abstraction that each CLI opts into, with an honest fallback."

## The breakthrough: all three current CLIs can answer approvals while showing their TUI

This was the open risk, and the answer is yes for all three (verified against current sources):

- **Claude Code** — a `PreToolUse` hook (HTTP) fires before the TUI's permission prompt and can return `allow` / `deny`, short-circuiting it. Works in interactive TUI mode.
- **Codex** — a stable, default-on `PermissionRequest` hook (`Feature::CodexHooks`, `Stage::Stable`) fires in core, in the interactive TUI's approval path, *before* the prompt is drawn. A host-installed hook command can block up to ~10 minutes (`timeout_sec`, default 600s) and return allow/deny to short-circuit it. If it declines, times out, or errors, Codex falls through to the in-TUI prompt, so it degrades safely.
- **Cortex** — ours. `Session.onToolPermissionRequest()` in `cortex-mono/packages/cortex-code/src/session.ts` records the request and shows the TUI prompt; we can have it also await an external decision (a decision file it polls, or a bridge call) before falling back to the prompt.

So the asymmetry is smaller than feared: Claude and Codex use the same shape (a hook that POSTs to our existing hook server and blocks for the answer), and Cortex we wire directly.

## The abstraction: capability descriptor + one card

The card UI is a single component. What sits behind it is chosen by the CLI's declared capabilities. A new harness plugs in at whatever tier it supports.

```
ApprovalCapability (per adapter)
  answer:   "hook-http" | "hook-command" | "file" | "bridge" | "none"
  detect:   "hook" | "osc9" | "notify" | "filewatch" | "none"
  context:  what the request payload carries (command, patch, args, reason)
```

### Tiers

1. **Answer from the card (full).** The request is intercepted, surfaced as a card with the exact command/patch and a reason, and Approve/Deny routes a decision back that short-circuits the TUI prompt. Claude, Codex, Cortex today.
2. **Signpost and jump (detect-only).** We cannot answer externally, but we can detect "blocked on approval" and raise a card that says what is pending and focuses/scrolls the terminal to the prompt; the user answers in the TUI. The fallback for a CLI with detection but no answer channel, or when a hook is not installed.
3. **None.** No card; the session simply shows as blocked in the tier order and the user opens the terminal. The floor for any new CLI before integration work.

### Per-CLI bindings (current)

| CLI | Answer channel | Detect channel | Notes |
| --- | --- | --- | --- |
| **Cortex** | `bridge` or decision `file` (ours) | activity `state.json` (`awaiting_permission`) | Showcase integration; cleanest, since we own it |
| **Claude Code** | `PreToolUse` hook → `/hooks/claude/<token>` | same hook + Notification hook | Hook config passed via `--settings` (already wired in `agents.rs`) |
| **Codex** | `PermissionRequest` hook command → `/hooks/codex/<token>` | OSC 9 bytes in the PTY (Ghostty), fast and zero-config | Set Codex `notification_condition = "always"` so OSC 9 fires while focused; hook has a trust/hash gate to handle |

## The decision round-trip

The request data already arrives in Reverie (`hook_server.rs` translates `awaiting_permission` with `displaySummary` + sanitized `args` into an `ActivityUpdate` today). What is unbuilt is the *answer* path:

1. The CLI's hook (Claude/Codex) or permission handler (Cortex) raises the request and **blocks**.
2. For hooks, the request lands on the existing localhost hook server, which holds the connection open and emits the card to the UI.
3. The user clicks Approve / Deny on the card.
4. The decision returns to the blocked hook (HTTP response with the permission decision) or to Cortex (decision file / bridge `wait_for_decision`), and the TUI prompt is never shown.

The bridge already defines `wait_for_decision` / `poll_decision` (`bridge_protocol.rs`); the hook server already routes per-session tokens. This is wiring plus UI, not new infrastructure. Caveat: prior hook round-trip code is flagged as possibly dead and must be verified before building on it.

## Safety

- **Deny-safe fallback.** Any failure in the answer path (IPC down, timeout) returns "no decision," and the CLI shows its own in-TUI prompt. We never strand a blocked agent.
- **Dangerous actions always break through.** Irreversible or high-blast-radius operations (per the dangerous-mode model) are a distinct interrupt class that surfaces loudly regardless of batching. This is the one case where interrupting the user mid-flow is correct, because the cost of not interrupting is unrecoverable.
- **Hook trust.** Codex hooks carry a trusted-hash / managed-vs-user gate; a host-installed hook may need to be marked trusted. Pin a Codex version and add a smoke test that asserts the hook fires and short-circuits, since this is recent surface area.

## Builds on

- `packages/reverie-core/src/hook_server.rs` (per-session tokens, Claude/Codex endpoints, `awaiting_permission` already flowing).
- `packages/reverie-core/src/bridge_protocol.rs` (`wait_for_decision` / `poll_decision`).
- `packages/reverie-core/src/agents.rs` (`AgentAdapter`; add the `ApprovalCapability` descriptor here).
- Cortex: `session.ts` `onToolPermissionRequest`, `activity/session-activity.ts`.

## Open questions

- How a host-installed Codex hook gets marked trusted without a fragile per-machine setup step.
- Version pinning and smoke coverage across CLI upgrades (the hook schemas are evolving).
- Card affordances for a Codex session when the hook is not installed (tier 2 signpost via OSC 9) vs installed (tier 1 answer).
- Whether "approve and do not ask again this session" (acceptForSession) is exposed on the card and how it is represented per CLI.
