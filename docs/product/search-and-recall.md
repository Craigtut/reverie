# Search and Recall

> How Reverie helps you re-find agent work by content, not just by title: "I was working on something with some agent, I don't remember which session or where, surface it for me and let me jump back in." This doc covers the job to be done, the on-disk research that shapes the design, the architecture (a Reverie-owned conversation index), discovered/external sessions, and the unified command-palette UX.
>
> Status: design. Validated against real on-disk CLI session files (see "Research findings"). Not yet built.

## 1. The job to be done

The product promise is "come back later and pick up exactly where your agent work left off." Search is the **index into that map**. Today the map has no content index, so the central recall job is unserved:

> I was setting up Claude Code hooks with some agent a few days ago. I don't remember which session it was or which topic it lived under. Let me search "hooks" and have Reverie surface the session, the agent, and where it lives, then let me resume it.

Three things make this **recall**, not in-session find:

1. The unit of the answer is a **session** (an agent + a place + a time), not a line of text.
2. The query is **content** ("hooks"), but the payload the user wants is **identity and location** ("that was Codex, in the *dev-tooling* topic, three days ago").
3. The end action is **resume**, not "highlight match 3 of 12".

Nothing serves this today. In-session Find (Cmd-F) is single-session and renderer-based. The command palette (`apps/desktop/web/domain/palette.ts`) matches only titles, breadcrumb, cwd, and agent kind, so "hooks" finds nothing unless a title happens to contain it.

## 2. Background: Reverie already has two histories

There are two separate history representations, and choosing the right one is the whole game.

**History A: the byte transcript (the renderer's history).** Reverie persists the raw PTY byte stream per session into `session_transcript_chunk` (`packages/reverie-persistence/src/lib.rs`), written off the hot path by a per-session writer (`apps/desktop/src-tauri/src/terminal/transcript.rs`). To read it you replay the bytes through a headless Ghostty (`apps/desktop/src-tauri/src/terminal/history.rs`) and extract plaintext. This is what today's Find uses. It exists to repaint a screen faithfully: it is complete but noisy (spinners, redraws, box-drawing, wrapped lines) and it cannot tell you who said what.

**History B: the CLIs' own native session files.** Each agent CLI writes its own transcript to disk, and Reverie already has the seam to locate it: every session can carry a `NativeSessionRef { session_id, metadata_path, adapter_payload }` (`packages/reverie-core/src/domain.rs`), produced by the per-CLI `AgentAdapter` (`packages/reverie-core/src/agents.rs`).

The instinct is to index History B (clean, role-tagged, semantic) and leave History A for visual scrollback. That instinct is right, but with a critical caveat the research below uncovered: **History B is not uniformly complete across CLIs.**

## 3. Research findings: native-file completeness is not uniform

Validated by inspecting real session files on this machine (`~/.claude`, `~/.codex`, `~/.cortex`) and the Cortex source (`/Users/user/Code/cortex-mono`).

| CLI | On-disk shape | Complete history? | How turns are tagged | Notes |
| --- | --- | --- | --- | --- |
| **Claude Code** | `~/.claude/projects/{escaped-cwd}/{session-id}.jsonl` | **Yes.** Append-only. One file = one self-rooted session (every inspected file starts at `parentUuid: null`). Compaction is recorded inline (`isCompactSummary`), never truncates the file. | `type: "user"` / `"assistant"`, content under `.message.content`. | Rich envelope per record: `cwd`, `gitBranch`, `sessionId`, `timestamp`, `version`. Bonus semantic records: `ai-title` (generated titles) and `last-prompt`. |
| **Codex CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | **Yes.** Append-only event log. In a 90,577-line / 177 MB sample, `context_compacted` appears 77 times as a **bare marker** (no text) interleaved with all original records still present; first compaction is at line 1,127. Nothing is deleted. | `payload.type: "user_message"` (human), `"agent_message"` (assistant), `"message"` (model-facing, role-tagged), plus `reasoning`, `function_call*`. | First line is `session_meta` with `id`, `cwd`, `cli_version`, `git`. Files get large; must tail incrementally. |
| **Cortex Code** | `~/.cortex/sessions/{id}/history.json` (+ `meta.json`, `observations.json`, `activity/events.jsonl`) | **No (lossy for long sessions).** `history.json` is the agent's **current in-context message array**, fully overwritten on every save, and **mutated in place by compaction**: classic summarization replaces older turns with one `<compaction-summary>` (keeps ~6 recent verbatim); observational mode deletes observed messages entirely. Complete only for short, never-compacted sessions. | `AgentMessage { role, content, ... }`, plain JSON. `details` is stripped on save. | The only append-only file is `activity/events.jsonl`, which carries event metadata + short summaries, not full message text (see [`technical/cortex-activity-contract.md`](../technical/cortex-activity-contract.md)). |

**The load-bearing conclusion:** we cannot make Reverie's search quality depend on each vendor's persistence choices. Two of three CLIs keep complete logs; one compacts in place. And any of these formats can change between CLI versions. So the design must not *delegate the completeness guarantee* to the CLIs.

## 4. Architecture: Reverie owns the conversation index

The guarantee lives in Reverie, not in the vendor file. Native files are **sources we tail into our own durable store**, not the system of record.

### 4.1 A Reverie-owned, normalized conversation store

A new durable, append-only table (its own SQLite migration; the migration array is in `packages/reverie-persistence/src/lib.rs`, currently at v8, this is v9):

```
conversation_turn {
  reverie_session_id   // ties to topic -> project -> agent_kind: the whole map
  native_session_id
  agent_kind
  ordinal              // position within the conversation
  ts
  role                 // user | assistant | tool | system
  text                 // searchable content
  source               // native_file | byte_transcript  (provenance / fidelity)
  // optional facets later: tool_name, model
}
```

Plus an **FTS5 virtual table** over `text`. FTS5 gives `bm25()` ranking and `snippet()`/`highlight()` for matched context for free, all local, no new datastore.

This table is the **system of record for search**. It is append-only and never compacted, so once a turn is captured it stays captured even if the CLI later rewrites or compacts its own file.

### 4.2 Per-CLI tailers (sources), with watermarks

Extend the adapter contract from "discover a session" to "read new turns since a watermark". The adapter is the only place CLI-format knowledge lives.

```rust
trait AgentAdapter {
    // existing: fn discover_native_session(&self, ctx) -> Option<NativeSessionRef>;
    fn read_conversation(&self, native_ref: &NativeSessionRef, since: Watermark)
        -> Result<ConversationDelta>; // new turns + advanced watermark
}
```

Reuse the proven incremental pattern from the transcript writer (`seq` + `byte_offset` + resync-on-drift):

- **Codex tailer:** tail the rollout JSONL from the last byte offset. Emit turns from `user_message` and `agent_message`. Skip `function_call*`, `token_count`, `thread_goal_updated` noise. (`reasoning` optional, default off.)
- **Claude tailer:** tail the JSONL from the last byte offset (one file = one session). Emit from `user` / `assistant` records (`.message.content`). Capture `ai-title` and `last-prompt` as enrichment for titles/snippets.
- **Cortex tailer:** because `history.json` is overwrite + compacted, this source is lossy if read only after the fact. For Reverie-launched sessions we instead rely on the backstop below, and treat `history.json` as best-effort role enrichment. (Upgrade path: watch `history.json` and capture deltas continuously while the session is live, so we grab turns before compaction removes them. Not required for v1.)

### 4.3 The byte-transcript backstop (the completeness guarantee)

Reverie already captures History A (raw PTY bytes) **append-only for every session it launches, at the terminal layer, before any CLI-side compaction**. That makes it the one source guaranteed complete for every CLI and every plain shell.

Source priority per session:

1. **Native file** when it is complete and clean (Codex, Claude): best quality, role-tagged.
2. **Byte transcript** otherwise (Cortex long sessions, any unsupported harness, generic shells): replay -> plaintext -> turns. Lower fidelity (no reliable roles), but always complete for Reverie-hosted sessions.

So the answer to "are we delegating product functionality and hoping the CLIs keep full history?" is **no**. Native files are an *optimization for quality*, not a *dependency for completeness*. The completeness floor is Reverie's own byte transcript, which we already capture.

### 4.4 Format-fragility posture (principal-engineer decision)

**Decision: treat native-file parsing as best-effort enrichment behind a per-adapter, versioned, defensively-tolerant parser, and never let a parse failure break capture or search.**

1. Each adapter owns its parser. Parsers are tolerant: unknown record types are skipped, missing fields default, and one bad line never aborts a tail (log once, skip, advance the watermark).
2. The `conversation_turn` store is a **disposable derived cache**: schema-versioned and fully rebuildable from sources. A parser upgrade can wipe and reindex.
3. Record the CLI version we captured under (we already have `cli_version` / `version` in metadata) so the indexer can branch parser behavior and detect drift.
4. Because of continuous capture plus the byte-transcript backstop, a CLI changing its format **degrades gracefully**: worst case we fall back to transcript-derived turns until the parser is updated. Search is never empty; we only lose role fidelity temporarily.

Posture in one line: optimistic about native files for quality, pessimistic about depending on them for correctness.

### 4.5 The indexer and the search command

- An **indexer service** in `reverie-core`, off the hot path (its own task, like the transcript writer). Per-session watermark. Triggered on native-session capture, on session exit, on app focus, periodically while a session is live, and lazily on first search if cold.
- A search command:

```
search_workspace(query, facets) -> Vec<SessionHit>
SessionHit {
  reverie_session_id, agent_kind, project/topic breadcrumb,
  state, last_active, match_count, provenance (managed | external),
  snippets: [{ role, text_with_highlights, ordinal }]
}
```

One `... MATCH ...` query, grouped by session, ranked by a blend of `bm25()` relevance and recency. Milliseconds across thousands of sessions.

## 5. Discovered (external) sessions

Reverie should also surface sessions that were started **outside Reverie** but in folders Reverie already knows as projects, so it becomes the search-and-resume home for your agent work, not only for sessions it launched.

### 5.1 Scope: only project folders, never the whole history

We index an external session **only if its cwd matches an existing Reverie project path** (the project root or a descendant). We do not crawl every session a CLI ever wrote. This was a deliberate product constraint and it is also the cheap path:

- **Claude Code:** the directory name *is* the escaped cwd (`~/.claude/projects/-Users-user-Code-reverie/`), so finding a project's external sessions is a single directory listing. Each file's first record carries `sessionId`, `cwd`, `timestamp`, `gitBranch`.
- **Codex:** scan `~/.codex/sessions/**/*.jsonl` and read only the **first line** (`session_meta`) for `cwd`, `id`, `timestamp`. One cheap line per file; date partitioning bounds it.
- **Cortex:** scan `~/.cortex/sessions/*/meta.json` (tiny files) for `cwd`, `id`, timestamps.

All three expose cwd in a cheap-to-read location, so discovery scoped to known projects is viable and inexpensive.

### 5.2 Naming (wordsmith recommendation)

We need to tell users a session "isn't currently inside Reverie but you've been working in it."

- **Badge: "External".** Recommended. Reads instantly, states the one thing that matters (it is outside Reverie's management), and stays accurate (everything is still local; "external" means external to Reverie, not remote).
- **Microcopy on the row:** "Discovered in {project} · not yet in Reverie."
- **Action verb: "Add to Reverie".** Plain and persona-plural. Under the hood this links the discovered session into a topic by attaching a `NativeSessionRef`; the internal concept is "adopt/link", but the user-facing verb stays "Add to Reverie".
- **After adoption:** the badge clears; it is just a session.

Warmer alternative if "External" reads too cold: **"Discovered"** as the badge (it explains *why* the row appeared). Recommendation stands on "External" for clarity, with "Discovered" as the fallback if user testing says otherwise.

External sessions index at the fidelity their source allows: Claude/Codex external sessions are complete (clean files); Cortex external sessions are best-effort (post-compaction file only, since Reverie was not hosting them to capture the byte transcript). That asymmetry is acceptable and worth a small "partial history" hint on Cortex external results.

## 6. UX: one unified command palette (Cmd-K)

Decision: **merge recall into the existing command palette** rather than adding a separate search surface. Cmd-K becomes the single place to search across commands, projects, topics, sessions, **session content**, and **discovered sessions**.

In-session **Find (Cmd-F) stays exactly as it is**: visual, scoped to the current session's scrollback. The split is clean: Cmd-F = find inside this session; Cmd-K = search across everything.

### 6.1 Result model: sectioned, progressive, streaming

Typing in Cmd-K produces results in calm, labeled sections:

1. **Actions** (when the query matches a command) — synchronous, today's behavior.
2. **Jump to** (projects, topics, sessions by title / path / agent) — synchronous, in-memory, today's behavior, renders instantly.
3. **In conversations** — the new content matches from the FTS index. Async, debounced (~120 to 150 ms), streamed in below the instant results with a subtle pending affordance. Each row: agent glyph, session title, breadcrumb (Project › Topic), relative time, and a one-line snippet with the match highlighted and a role label ("you:" / agent name). A "5 mentions" rollup when a session matches many times.
4. **Discovered** — external sessions in your projects, each with the **External** badge and an **Add to Reverie** affordance.

Empty or short query keeps today's behavior (recent sessions + commands). Content results populate as the query grows. Async results must never block typing and must cancel stale queries.

### 6.2 The bridge back into the moment

Selecting a content result **opens/resumes the session and pre-seeds the in-session Find (Cmd-F) with the query**. This reuses History A's strength (visual match-and-scroll) to land the user near the moment, and sidesteps the hard problem of mapping a native-file turn back to a byte offset in the rendered transcript. The two search systems collaborate instead of duplicating.

### 6.3 Power-user scoping (progressive disclosure)

Optional lightweight filter tokens typed into the same field: `agent:codex`, `project:reverie`, `who:me`, `in:content`. Plain by default, powerful when needed. The "who:me vs who:agent" filter is uniquely valuable here and only possible because we indexed role-tagged turns: "where did *I* ask about hooks" vs "where did the agent talk about hooks".

### 6.4 Design language

Calm, monochrome, status-colors-only (see [`../design-vision.md`](../design-vision.md)). Reuse `AgentGlyph` for identity, the derived session-state chip for status, subtle highlight for matched terms (not loud color), the dot field for the empty state.

## 7. Ranking, and why no embeddings yet

Decision: **no embeddings in v1.** FTS5 lexical search with `bm25()` plus a recency boost is enough for this job, because the recall query is almost always a remembered term ("hooks", "OSC title", "rpath"). Embeddings add a model dependency, indexing cost, and a local-first footprint for a marginal gain on fuzzy paraphrase. Defer until there is evidence lexical recall is missing real queries. Re-evaluate as a Phase C enhancement, not a v1 requirement.

Ranking inputs for v1: lexical relevance (`bm25()`), recency (last-active), a small boost for matches in user turns over tool output, and a small boost for managed over external sessions.

## 8. Build sequence and dependencies

**Phase A: palette metadata search (cheap, ships the surface).** Extend the palette to cover topic + project + session titles, cwd, and agent (mostly present in `palette.ts`). Establishes the unified-palette shape. Does not yet serve the content-recall job.

**Phase B: the conversation index (the real solution).**
- B1: finish native-session capture for Claude + Codex (already roadmapped in [`../technical/implementation-queue.md`](../technical/implementation-queue.md); this gives that work a second, higher-value payoff).
- B2: add `read_conversation` to the adapter trait; implement per-CLI tailers (Codex, Claude native; Cortex via byte-transcript backstop, with native enrichment best-effort). Tolerant, versioned parsers.
- B3: v9 migration: `conversation_turn` + FTS5. Indexer service with per-session watermark. Byte-transcript fallback path.
- B4: `search_workspace` command with snippets + facets.
- B5: wire content results + discovered sessions into Cmd-K, plus the "open + seed Find" bridge.

**Phase C: discovered sessions + enrichments.** External-session discovery scoped to project cwds and the "Add to Reverie" adopt flow; the who:me/who:agent facet; a touched-files facet ("sessions that edited `hooks.json`"); ranking tuning. Embeddings only if justified.

Dependency note: B1 gates content quality for Claude/Codex, but the **byte-transcript backstop means Phase B can ship useful search before native capture is complete** (lower fidelity, still complete for Reverie-hosted sessions).

## 9. Open items to validate during implementation

- Claude resume/fork edge cases: confirm whether resuming ever forks a logical conversation across multiple files (inspected files were all self-rooted; `isCompactSummary` is rare). If so, key on `sessionId` and follow `leafUuid`.
- Codex turn extraction: dedupe between `message` (model-facing) and `user_message`/`agent_message` (surfaced) so a turn is not indexed twice; decide whether `reasoning` is ever indexed.
- Cortex: decide if/when to build continuous `history.json` delta capture (4.2 upgrade path) for higher-fidelity external Cortex sessions; until then, label them "partial history".
- Indexer cost on very large Codex rollouts (177 MB observed): confirm byte-offset tailing keeps reindex bounded.
- cwd matching rule for discovery: exact project path vs descendant; confirm the descendant rule is the right default.

## 10. Guardrail check

- **Keep the product/domain layer independent of the terminal renderer.** Indexing native files (and a Reverie-owned turn store) honors this; the byte-transcript fallback is the only renderer touchpoint, and it is a fallback, not the foundation.
- **Local-first only.** The index is a local SQLite table; nothing leaves the machine.
- **Never require git.** Discovery is keyed on cwd/project folders, not repos or branches. `gitBranch` is captured only as optional metadata.
- **Don't turn Reverie into an IDE.** Search returns *sessions in the map*, reinforcing the resumable-map thesis rather than adding IDE features.
- **Calm by default.** Recall lives in the existing palette, sectioned and quiet, not a new loud surface.
