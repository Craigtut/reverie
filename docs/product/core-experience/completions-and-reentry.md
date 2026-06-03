# Completion surface and the re-entry header

> Part of the [core experience](README.md). Introduces a shared primitive (the completion surface) and the first feature built on it (the re-entry header).

This doc covers two things: the small-completion capability Reverie needs (it has none today), and the re-entry header that uses it. The same primitive later powers dispatch classification and session titles.

## The completion surface (shared primitive)

Reverie needs to run small LLM completions: summarize a transcript, write a title, classify a dispatch request. The constraint is local-first and BYO-provider, with **no new account and no new provider relationship**. The user already authenticated a provider through the CLI they run. Reuse it.

### Approach: reuse the session's own CLI

A small Rust trait with one implementation per CLI, each shelling out to the already-authenticated install:

| CLI | One-shot command | Structured output |
| --- | --- | --- |
| **Claude Code** | `claude --bare -p "..." --output-format json` | `--json-schema` → `structured_output` |
| **Codex** | `codex exec --json "..."` (use `--sandbox read-only --ask-for-approval never --ephemeral`) | `--output-schema <file>` |
| **Cortex** | new `cortex complete "..."` subcommand (see below) | pass-through of `pi-ai` structured output |

Policy for which engine runs a given job:

- **Session-scoped jobs** (re-entry header, title for a session) use that session's own CLI, so it spends the provider the user already chose for that work.
- **Session-less jobs** (dispatch classification, before any session exists) use a configured default engine.

Rejected alternatives, for the record: **Apple Foundation Models** (Swift-only; Rust is beta FFI) and an embedded **PydanticAI sidecar** (Python runtime weight for two tiny jobs, and Cortex is not even PydanticAI). A Rust-native remote client (`rust-genai` / `async-openai`) stays available as a third path for a user who has a bare API key but no CLI, but it reintroduces a key relationship the CLIs already solved, so it is not the default.

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

The transcript is already on disk for every CLI and already scanned by the adapters: Claude `~/.claude/projects/<hash>/<session-id>.jsonl`, Codex `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, Cortex `~/.cortex/sessions/<id>/history.json`. The header is the completion surface applied to a windowed read of that file.

### When it regenerates

- On session open, if stale.
- After the agent completes a turn while unviewed (so the "what changed" line is fresh when you come back).
- Cache the result keyed to the transcript's last-seen offset so re-opening a session you just looked at is free.

## Builds on

- Nothing exists yet; Reverie has zero LLM integration today. This is the greenfield primitive.
- Transcript discovery already exists in the adapters (`agents.rs` and the per-CLI scanners).

## Open questions

- Default model/effort per CLI for these tiny jobs.
- Transcript windowing strategy (how much history the summary needs to be accurate without being expensive).
- Where the header is cached and how invalidation keys to transcript growth.
- The exact `cortex complete` flag shape and whether it streams or returns whole.
- Whether titles (currently OSC-derived) move to this surface or stay OSC-first with completion as a fallback.
