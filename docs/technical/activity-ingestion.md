# Activity ingestion architecture

Reverie's durable job is to take session lifecycle signal from an open-ended set
of agent CLIs, each of which exposes that signal in a different way, and normalize
it into one internal model so the product (dashboard, glyphs, state rollups) stays
CLI-agnostic. This doc describes the ingestion spine: where signal enters, how it
is normalized, and how to add the Nth CLI.

The normalized model is [`ActivityState`](../../packages/reverie-core/src/activity.rs)
(status, sequence, cwd, active tools, awaiting-permission, last error, final exit).
`awaiting_permission` is a first-class UI state, so every adapter must be able to
produce it rather than degrade it.

## The spine

There is a fixed pipeline with exactly one pluggable stage. Only the **Source**
varies per CLI; everything downstream is shared and never per-CLI.

```
 transport engines (Sources)                       universal spine (never per-CLI)
 ───────────────────────────                       ─────────────────────────────────
 hook server  (PUSH)      ─┐
 session_log  (FILE)      ─┼─► ActivityUpdate ─► correlate() ─► WorkspaceService.persist
   ├─ Codex  (append-fold)│      { source,        - resolve SessionKey -> Reverie session
   └─ Cortex (snapshot)   │        key,            - capture native id on first sight
 [future: poll / in-band] ┘        fidelity,       - (deferred) merge by sequence + fidelity
                                    state }         - emit session_activity_changed
                                                    - emit session_record_changed on capture
```

The contract between the two halves is one type,
[`ActivityUpdate`](../../packages/reverie-core/src/activity_source.rs):

```rust
enum ActivityUpdate {
    State   { source: ActivitySourceKind, key: SessionKey, fidelity: Fidelity, state: ActivityState },
    Removed { source: ActivitySourceKind, key: SessionKey, native_session_id: String },
}
enum SessionKey { Reverie(SessionId), Native(String) }   // the two binding modes
enum Fidelity   { Coarse, Inferred, Definitive }         // Ord; higher wins ties
```

A source's only obligation: produce `ActivityUpdate`s and run a thin drain that
hands each to `correlate`. The binding, native-id capture, merge, and emit happen
once, in the [correlator](../../apps/desktop/src-tauri/src/correlator.rs), for
every CLI. The drains live in
[`activity_bridge.rs`](../../apps/desktop/src-tauri/src/activity_bridge.rs) and are
deliberately one-liners.

## The four orthogonal axes

A new CLI is classified on four independent axes. Most combinations reuse existing
machinery, so adding one is usually "pick the engine, write a thin wrapper."

1. **Transport** (how bytes arrive): `push` (the CLI POSTs to our hook server) |
   `file-watch` (the CLI writes a file we watch) | `poll` (we pull an API on an
   interval) | `in-band` (we parse the PTY/OSC stream we already render).
2. **Derivation**: `snapshot` (one small read is the whole current state) | `fold`
   (accumulate current state from a stream of deltas).
3. **Binding**: `token` → `SessionKey::Reverie(id)` (the source already knows the
   Reverie session, e.g. a per-session hook token) | `native-id` →
   `SessionKey::Native(String)` (the source only knows the CLI's own id; the
   launch-time capture poll attaches the native ref so it can bind).
4. **Fidelity**: how complete and real-time the signal is. Drives multi-source
   merge precedence (`Definitive` hook > `Inferred` log-tail > `Coarse` parse).

Snapshot-vs-fold is **one transport (file-watch) with two derivations**, which is
exactly why one engine serves both.

### Where the current CLIs sit

| CLI    | Transport  | Derivation | Binding   | Fidelity     | Engine |
| ------ | ---------- | ---------- | --------- | ------------ | ------ |
| Claude | push       | (event)    | token     | Definitive   | `hook_server` |
| Codex  | file-watch | fold       | native-id | Inferred\*   | `session_log` (`CodexLogSource`, Append) |
| Cortex | file-watch | snapshot   | native-id | Definitive   | `session_log` (`CortexStateSource`, Snapshot) |

\* Codex's rollout records are not first-class lifecycle transitions:
`awaiting_permission` is folded heuristically from `with_escalated_permissions`,
so the whole source is `Inferred` until the definitive `PermissionRequest` command
hook lands as a second source for it (see Deferred, below).

## The engines

### Push: the hook server

[`hook_server.rs`](../../packages/reverie-core/src/hook_server.rs) binds a localhost
HTTP server. The launch path mints a per-session token and registers it against the
owning `SessionId`; the CLI is configured to POST lifecycle events to
`/hooks/<cli>/<token>`. Each payload is translated to an `ActivityUpdate::State`
keyed `Reverie(id)` at `Definitive`. The native CLI id rides along in
`state.session_id` and is captured into the record on first sight. This is how
Claude works (via `claude --settings <file>`, no credential-home redirect).

The captured native id is **not immutable**. A CLI can switch the active
conversation inside one running process (Claude `/resume` of an externally
started session, or `/clear`), which surfaces as a `SessionStart` edge carrying a
*new* native id under the same token. The translator flags such edges with
`session_boundary: true` on the `ActivityUpdate::State`, and the correlator's
`record_session_activity_by_id_at_boundary` **re-points** the session's
`native_session_ref` to follow them. This is safe (not a folder-scan guess)
because the token authenticates the owning Reverie session directly, so the edge
is the live process telling us, authenticated, which conversation it now holds.
Without it the dashboard would freeze (activity routes by native id) and a later
resume would target the abandoned conversation. The re-point is CLI-agnostic: any
future push-hook CLI only has to set `session_boundary` on its own start edge.

### File: the session-log engine

[`session_log.rs`](../../packages/reverie-core/src/session_log.rs) watches only the
**active** session files it is told to (`SessionLogControl::register` /
`unregister`), tracks a byte offset per file, and feeds each `SessionLogFold` only
the bytes since the last read. Cost scales with new output, not accumulated history
(the difference between O(new bytes) and re-folding a 100 MB+ log on every append).

- A `SessionLogFold` is the thin per-CLI piece. It carries its own `source_kind`
  and `fidelity`, so one watcher can serve several CLIs at once. `Append` folds
  accumulate across `push` calls (keeping a partial-line buffer); `Snapshot` folds
  parse the whole (small) file each change.
- A `SessionLogSource` recognizes a CLI's files (`matches`) and builds a fold
  (`new_fold`). `CompositeLogSource` composes several, so a single watcher (one
  thread, one control) serves every file-transport CLI:
  [`CodexLogSource`](../../packages/reverie-core/src/codex_rollout.rs) (rollout,
  Append) and [`CortexStateSource`](../../packages/reverie-core/src/cortex_state.rs)
  (`activity/state.json`, Snapshot).

The launch path registers a session's watch file shortly after launch and at
boot for already-running persisted sessions (the old Cortex startup scan, now
scoped to sessions Reverie owns). `watch_path_for_ref` derives the file per CLI:
Codex's native ref points straight at the rollout; Cortex's points at `meta.json`,
so the engine watches the sibling `activity/state.json`.

## The correlator

[`correlate(app, update)`](../../apps/desktop/src-tauri/src/correlator.rs) is the
single consumer of `ActivityUpdate`. It:

- binds by `key`: `Reverie(id)` persists via `record_session_activity_by_id` (and
  captures the native id into `native_session_ref` on first sight); `Native(id)`
  persists via `record_session_activity` (which binds to whichever session carries
  that native ref).
- emits `session_activity_changed` for the frontend (`native_session_id` =
  the key's id for native-keyed updates, or `state.session_id` for hook updates;
  the payload is camelCase to match the web layer's `nativeSessionId`).
- emits `session_record_changed` on first native-id capture, so the dashboard
  refetches the snapshot and can bind the (native-id-keyed) live activity stream.
- is the home for the **multi-source fidelity merge** (deferred): when one session
  gains a second source at a different fidelity, this is where a definitive update
  must not be clobbered by a stale, lower-fidelity one. Today every session has
  exactly one source and the persistence layer already drops out-of-order updates
  by sequence, so no extra merge state exists yet; the `fidelity` carried on each
  update is the hook for that rule.

## How to add a new CLI

1. **What transport does it expose?**
   - It can POST lifecycle events → **push**. Add a route/translation in
     `hook_server` that emits `ActivityUpdate::State { key: Reverie(id), .. }`.
     Bind a per-session token at launch.
   - It writes a session file → **file-watch**. Continue to step 2.
   - It only has an API to poll, or only terminal output → **poll** / **in-band**.
     These transports are designed for but not built; see Deferred. Either still
     emits `ActivityUpdate` into `correlate`, so only the engine is new.
2. **Is the file a snapshot or an append-log?**
   - Snapshot (the file is the current state) → a `Snapshot` `SessionLogFold` that
     parses the whole file (model on `CortexStateFold`).
   - Append-log (a growing transcript) → an `Append` `SessionLogFold` that folds
     new records and keeps a partial-line buffer (model on `CodexRolloutFold`).
   Add a `SessionLogSource` for it and include it in the `CompositeLogSource` in
   `main.rs`. Register its watch file via `watch_path_for_ref` + the launch poll.
3. **How does an update bind to a Reverie session?**
   - The source knows the Reverie session (a token) → `SessionKey::Reverie`.
   - The source only knows the CLI's id → `SessionKey::Native`; make sure the
     adapter's `discover_native_session` captures the native ref so the launch
     poll can attach it.
4. **What fidelity is the signal?** Authoritative snapshot or hook → `Definitive`.
   Folded from non-transition records → `Inferred`. Parsed from terminal output →
   `Coarse`. This only matters once a session has more than one source.

That is the whole surface. Nothing in the spine changes.

## Deferred (designed for, not built)

- **Codex definitive `awaiting_permission`.** A trusted `PermissionRequest`
  command hook POSTing to the hook server, layered over the rollout watcher as a
  second source for the same session. This is what the correlator's fidelity merge
  is for (a `Definitive` approval signal must win over the `Inferred` log-tail).
  It needs live experimentation against the installed Codex (which config location
  actually fires hooks, whether the trust hash persists), not more design.
- **Poll and in-band transports.** Their only constraints are already satisfied:
  `ActivityState` tolerates low fidelity, and the correlator merges by fidelity.
  In-band would reuse the existing Ghostty/PTY stream and OSC parsing
  (`derive_session_title` already reads OSC titles from it).
