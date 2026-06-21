# Completion surface and the re-entry header

> Part of the [core experience](README.md). Introduces a shared primitive (the completion surface) and the first feature built on it (the re-entry header).

This doc covers two things: the small-completion capability Reverie needs, and the re-entry header that uses it. The same primitive also powers dispatch classification and session titles.

## The completion surface (shared primitive)

Reverie needs to run small LLM completions: summarize a transcript, write a title, classify a dispatch request. The constraint is local-first and BYO-provider, with **no new account and no new provider relationship**. The user already authenticated a provider through the CLI they run. Reuse it.

### Approach: reuse the session's own CLI

A small Rust trait with one implementation per CLI, each shelling out to the already-authenticated install:

| CLI | One-shot command | Structured output |
| --- | --- | --- |
| **Claude Code** | `claude --bare -p "..." --output-format json` | `--json-schema` → `structured_output` |
| **Codex** | `codex exec --json "..."` (use `--sandbox read-only --ask-for-approval never --ephemeral`) | `--output-schema <file>` |
| **Cortex** | new `cortex complete "..."` subcommand (see below) | pass-through of `pi-ai` structured output |

Current implementation status:

- The shared Rust completion helper is proven end to end for all three CLIs (Claude `claude -p --json-schema`, Codex `codex exec --output-schema`, Cortex `cortex complete --schema`). A dev smoke (`cargo run -p reverie-core --example completion-smoke`) round-trips structured output against each installed CLI.
- Codex session titles use it today as a fallback/generator, keyed off the session's rollout file. Title generation stays Codex-only by design; Claude and Cortex keep their OSC-derived titles.
- Title generation starts shortly after the first Codex user prompt once the rollout contains the prompt text, with the turn-complete signal kept as a fallback.
- The re-entry header is built (see below). Dispatch classification is still product work.

Policy for which engine runs a given job:

- **Session-scoped jobs** (re-entry header, title for a session) use that session's own CLI, so it spends the provider the user already chose for that work.
- **Session-less jobs** (dispatch classification, before any session exists) use a configured default engine.

Rejected alternatives, for the record: **Apple Foundation Models** (Swift-only; Rust is beta FFI) and an embedded 

### The Cortex command

Cortex (`cortex-mono`, TypeScript, on `@earendil-works/pi-ai`) already has the machinery: `provider-manager.ts` resolves a model and calls `piAi.completeSimple()` / `piAi.complete()`. Exposing it is a new subcommand in `packages/cortex-code/src/index.ts` (`parseArgs` + a handler in `main()`): load credentials, resolve the model, call `completeSimple`, print to stdout. Roughly 100-200 lines, mirroring how `claude -p` and `codex exec` behave. This also gives us the cleanest "unified auth" story, since Cortex's `~/.cortex/credentials.json` is the provider the user picked.

### Cost and privacy notes

- Make calls cheap: a small/fast model, bounded transcript window (recent turns plus the pending question, not the whole history), low effort.
- Watch quota: Claude `-p` draws from a separate Agent SDK credit (post 2026-06-15) and Codex `exec` spends the user's ChatGPT plan window. Preferring the session's own provider keeps this honest and visible. A fully-local model (Ollama) is a future opt-in for users who want zero network and zero quota cost.

## The re-entry header

### Problem

The real cost of switching among many agents is not the switch, it is the reorientation on return: rebuilding "what was this one doing, what did it decide, what is it asking." That reorientation is what the popular "23 minutes to refocus" figure is really about, and at ten agents it is the dominant tax.

### Design

When you open (or re-open) a session, pin a compact header above the terminal with four things, derived from the transcript:

1. **Where we left off** — the last two or three meaningful actions.
2. **Current goal** — the thread of work in one line.
3. **What changed since you left** — new since your last view (ties to the finished-unseen state).
4. **The pending decision** — the exact thing being asked, if blocked.

The transcript is on disk for every CLI: Claude `~/.claude/projects/<hash>/<session-id>.jsonl`, Codex `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, Cortex `~/.cortex/sessions/<id>/transcript.jsonl` (a new append-only log `cortex-code` writes alongside the lossy `history.json` snapshot, since the snapshot is not a usable conversation log). The header is the completion surface applied to a windowed read of that file, normalized per CLI into one shared `ReentryContext` (recent user/assistant turns plus tool actions, bounded).

### As built

The header is a catch-up artifact, not a live status bar:

- **Generated once, on the active -> rest transition while the user is away** (the same moment a session lands in the finished-unseen / "Ready for you" tier). Never per turn, never while the agent is active. The trigger rides the activity correlator (`reentry_summary.rs`, the all-CLI choke point), with a short settle delay; eligibility (still at rest, unseen, not already summarized) is re-checked at run time so a view during the delay wins.
- **Keyed to `state_timeline.resting_since`**, not a transcript byte offset. The summary stores the rest it was generated for; the frontend shows it only while that still equals the session's current resting marker. A new turn advances the marker and supersedes the summary (the header hides) without deleting it, so a resume-after-restart still shows the last one.
- **Persisted to the session record** (`reentry_summary_json`, migration v23), so it survives an app restart and is there when the user reopens the session later.
- **Small, dense, closable**, floating just below the session tab bar. Dismiss is per-rest (`dismiss_session_reentry`); the next unseen rest generates a fresh one. No manual refresh.

## Builds on

- Transcript discovery already exists in the adapters (`agents.rs` and the per-CLI scanners); the per-CLI re-entry readers are `codex_rollout::read_codex_reentry_context`, `agents::read_claude_reentry_context` (path derived by native id since Claude usually leaves `metadata_path` unset), and `cortex_transcript::read_cortex_reentry_context`.
- The CLI-backed structured-completion helper, first shipped for Codex session titles, now proven for all three CLIs (the header is its second consumer).

## Open questions

- Default model/effort per CLI for these tiny jobs.
- Transcript windowing strategy (how much history the summary needs to be accurate without being expensive); the current window is a bounded recent tail (`ReentryBudget`).
- Whether boot-reconciled (crash-rested) sessions should generate a header on startup; v1 skips them to avoid a startup completion stampede and shows the last persisted summary instead.
