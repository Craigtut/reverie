# Backlog: ideas, to-dos, and open tickets

A holding place for things we want to build, change, or revisit but are not actively
working yet. Not a spec and not a commitment: it is the parking lot. When a ticket
graduates into real work, move the detail into the relevant doc (product spec,
frontend/technical architecture, design vision, or the implementation queue) and
leave a one-line pointer here.

Keep entries short and self-contained. Each one should answer: what, why, the UX
shape, and the open questions that still need a decision.

## How to add a ticket

Copy this skeleton:

```
### Tn. <short title>

- Area: web | terminal | core | desktop | adapters | design | product
- Status: idea | shaping | ready | parked

**What.** One or two sentences.

**Why.** The user-facing reason it matters.

**UX shape.** How it should feel and behave.

**Open questions.** The decisions we still owe ourselves.
```

---

### T1. A "finished" session state (the agent is done and you have not seen it yet)

- Area: product + web + design
- Status: shaping

**What.** Add a session state that sits between `active` (the agent is working) and
`idle` (at rest). It fires the moment an agent's process moves from working to
at-rest *while you are not looking at that session*, and it means: "I finished, there
is something new here, come take a look." It is cleared automatically when you open
and view that session. Viewing is the acknowledgement.

**Why this is central, not polish.** Reverie's whole thesis is running many agents in
parallel and keeping an organized, resumable map of them (see
[`product-vision.md`](product-vision.md)). The single most important question a user
has when they return to the app is "which of my agents did something I need to look
at?" Today the model cannot answer that. `idle` deliberately collapses two very
different situations into one bucket: "just finished a turn, you have not seen the
result" and "been sitting here for an hour, you already read it." Splitting them turns
the workspace into a real triage surface. This is the payoff of the parallel-agent
map, so it deserves a first-class state.

**Today's states (for grounding).** The derived enum is
`SessionState = attention | active | idle | fresh`
(`apps/desktop/web/domain/types.ts`, derived in `domain/activity.ts`
`deriveSessionState`):

- `active`: a positive working signal, the agent is mid-turn (green).
- `idle`: at rest, waiting for you. Covers turn-done, awaiting-input, and
  exited-but-resumable. This is the bucket we want to split (neutral / dim).
- `attention`: a *blocking* ask (permission) or a hard, unrecoverable error (amber /
  red). This is the key distinction below.
- `fresh`: never launched, no conversation to reopen yet (dim seed).

**Why not just reuse `attention`.** `attention` means the agent is *blocked* and
literally cannot proceed without you: a permission prompt, or a fatal error. The new
state is the opposite of blocked: the agent succeeded and made you something. If we
fold "come look at the result" into the same amber alarm we use for "stuck, act now,"
we dilute the urgency signal and train people to ignore amber. The new state must read
as quieter and invitational, not alarming. Suggested priority ordering for rollups and
sorting: `attention` (act now) first, then this new finished state (look when you can),
then `active` (busy, nothing owed from you), then `idle`, then `fresh`.

**The mechanic is "unread", layered on idle.** Think of it like an unread badge in
email or chat. There are really two orthogonal axes that today's model collapses:

1. What is the agent doing? working / done-a-turn / blocked / never-started.
2. Have you seen the latest? seen / unseen.

The new state is just the *unseen* variant of idle. Concretely:

- Enter: a session's activity transitions `working` to `done` or `awaiting_input`
  while that session is not the one you are currently viewing.
- Clear: you open and view that session. Selecting it as the active terminal counts as
  seen.
- If you were already viewing the session when it finished, it goes straight to plain
  `idle`. Never badge something the user is actively watching. The ambient
  `active>idle` settle bloom in the cell still plays, but no persistent "come look"
  marker is raised.

**Good news: the renderer is already half-built for this.** `apps/desktop/web/stateField.ts`
already defines a `finished` `CellState` ("bloom once, settle to even lattice", neutral
color at `colors.finished`) and an `active>idle` "settle" transition ("the working
energy releases outward and the cell comes to rest"). No derived product state drives
them yet, so the visual primitive exists and is currently dormant. Wiring this ticket
is partly a matter of connecting a real product state to scaffolding that already
exists. One needed tweak: today the `finished` cell decays to static after
`FINISHED_SETTLE_MS`; for a *persistent* unseen marker it should come to rest at a
subtly elevated, distinct still state (a little brighter / more present than `idle`)
and hold there until seen, rather than fully collapsing into the idle dot.

**Naming.** This is the open call. Candidates and tradeoffs:

- `finished` (leaning recommendation for the internal enum value). Matches the word
  used in the request and the existing `CellState.finished`, so it keeps the renderer
  and the product model in sync. Risk: "finished" can be misread as "the session is
  over," but in Reverie sessions are never over (close = archive, open always
  re-attaches or resumes), so the lifecycle reading does not really apply here.
- `ready`. The warmest user-facing word ("Ready for you"). Risk: collides with
  `fresh`, whose copy is already "Ready to start."
- `done`. Too lifecycle-flavored, and it already exists as an `ActivityState.status`
  value, so it would overload the term.
- `unseen` / `unread`. Most accurate to the mechanic, but feels inbox-y and loses the
  warmth of "your agent accomplished something."

Proposed split: name the enum value `finished` for internal consistency with the
renderer, and use warmer surface copy like "Ready for you" or "Done, take a look" on
cards and rows. If we would rather the enum match the copy exactly, `ready` is the
fallback. Decide before implementing.

**Where it shows up (UX surfaces).**

- StateCell / dot field glyph: drive the existing `finished` cell state; hold a
  distinct resting look until seen (see renderer note above).
- Status dot (SessionRow, dashboard cards): needs its own tone. Design is monochrome
  plus status colors only (see [`design-vision.md`](design-vision.md)), and the two
  status hues are taken: amber for attention, green for active. So do not invent a
  hue. Distinguish `finished` from `idle` by *weight and presence* instead: a brighter
  or filled neutral dot, or a subtle ring, versus idle's dim dot. This is the cleanest
  fit with the monochrome guardrail. Confirm the treatment with design.
- Plain-language status text (`plainLanguageStatus`): something like "Ready for you" or
  "Finished, take a look", distinct from idle's current "Waiting for you". Watch the
  copy collision.
- Rollups (focus / project rows, `rollupSessionStates` / `SessionRollup`): add a
  finished count so a row can say "2 ready". This is the big parallel-agent payoff: a
  glanceable "what produced something" tally per focus and project.
- Home / focus dashboard grouping (`groupSessionsByState`): add a section, ordered just
  under "Needs you" and above "Working", so returning users get a clean triage list of
  what is waiting for their eyes.
- Out of scope here but related: a dock badge count and / or a system notification when
  a turn finishes off-screen (ties into `PushNotification`). Capture as follow-on, do
  not block v1.

**Open questions (decisions we still owe ourselves).**

1. Name: `finished` enum + "Ready for you" copy, or `ready` for both? (See above.)
2. Persistence. Is the unseen flag in-memory live state only, or persisted across
   reload and relaunch? The killer use case ("I left five agents running overnight,
   which ones produced something?") needs persistence. The robust model: persist a
   per-session `lastViewedAt`, compare it to the activity feed's last
   turn-completion timestamp, and treat `lastTurnCompletedAt > lastViewedAt` (and not
   currently viewed) as unseen. This survives restarts and is binary. Recommend this
   over the simpler in-memory-only version.
3. Cold-boot behaviour. If we persist, avoid mass-badging every session as "finished"
   on launch. The `lastViewedAt` vs `lastTurnCompletedAt` comparison handles this
   correctly as long as both timestamps are real; spell out the boot path so a fresh
   launch does not light up the whole map.
4. Autonomous multi-turn runs. An agent that finishes a turn, then continues on its
   own (long tool batches) should not strobe the cell or flicker the rollup count
   between finished and active. Likely resolution: enter finished on the working to
   at-rest transition; if it flips back to working it is simply `active` again. Decide
   whether the rollup count needs debounce.
5. What clears it besides viewing? Proposed: archiving or closing the session (filing
   it is acknowledgement), and typing a new prompt into it (you are clearly looking).
   Confirm.
6. `awaiting_input` vs `done`. Both currently map to idle and both should be able to
   become finished-unseen when off-screen (the agent paused for you and you do not
   know yet). Confirm we treat them the same here.
7. Definition of "viewing". v1: the session is the active / selected terminal. If we
   ever show multiple terminals at once, any visible one counts as seen. Keep v1
   simple.

**Rough implementation sketch (when this graduates).**

- Add `finished` to `SessionState` (`domain/types.ts`) and handle it everywhere the
  enum is switched: `deriveSessionState`, `dashboardToneForState`, `cellStateFor`,
  `rollupSessionStates`, `groupSessionsByState`, `plainLanguageStatus`,
  `statusDotColor`, `glyphStateFor`.
- Track `lastViewedAt` per session (persisted), updated when a session becomes the
  active terminal. Track / derive `lastTurnCompletedAt` from the activity feed.
- In `deriveSessionState`, an `idle` session that is unseen and not currently viewed
  derives `finished` instead.
- Wire the renderer's existing `finished` cell state and adjust its resting look to
  persist until seen (`stateField.ts`).
- Decide and implement the persistence model from open question 2.

**Related.** `domain/activity.ts`, `domain/types.ts`, `stateField.ts`,
`components/glyphs/StateCell.tsx`, [`design-vision.md`](design-vision.md),
[`product-vision.md`](product-vision.md),
[`technical/activity-ingestion.md`](technical/activity-ingestion.md).

---

### T2. Typography component user text selection toggle

- Area: web
- Status: idea

**What.** Add a property to the Typography component that controls whether the user can select (click-and-drag highlight) its text, the same way native web text selection works. This should be **off by default**: Typography text is not selectable unless the property explicitly opts in.

**Why.** By default in the browser, text can be highlighted by clicking and dragging across it. In a desktop app shell most text is chrome (labels, status, nav, headings) where accidental selection is noise and feels un-app-like. But some text is genuinely content the user may want to copy (messages, output, paths, IDs). Giving Typography a single, consistent switch for selectability lets us keep the app feeling native while still allowing copyable text where it matters, without every consumer reaching for ad-hoc `user-select` CSS.

**UX shape.** A boolean prop, e.g. `selectable?: boolean` (default `false`). When `false`, the component applies `user-select: none` so click-and-drag does nothing and the cursor stays the default arrow. When `true`, text behaves like normal selectable web text (`user-select: text`, text cursor, drag highlights, copy works). Selection highlight color should come from the theme and respect the monochrome + status palette (see [`design-vision.md`](design-vision.md)). The switch lives on the `<Typography>` primitive (`apps/desktop/web/components/primitives/Typography.tsx`) so it is the single place selectability is decided.

**Open questions.**

1. Default scope: confirm app-wide default is non-selectable, and that we are comfortable auditing existing content text (messages, output, paths) to flip those to `selectable`.
2. Granularity: is a single boolean enough, or do we want richer modes (e.g. `all` vs `none` vs `double-click-word-only`)?
3. Inheritance: if a selectable Typography contains nested Typography, does selectability cascade, or is each node independent?
4. Should the terminal and other non-Typography surfaces be out of scope here (they manage their own selection)? Assume yes, but confirm the boundary.

---

### T3. Scrollbar hover-triggered fade behavior

- Area: web + design
- Status: idea

**What.** Scrollbars in every scrollable container should fade in when the user hovers over that container, stay fully visible the whole time the cursor is inside it, then once the cursor leaves remain for four seconds and fade back out. Fades use a ~200ms transition. This applies to all scrollable containers, not a select few.

**Why.** Scrollbars are essential affordances for scroll position and access, but always-on bars clutter the UI and fight the calm, app-native feel. A hover-triggered, time-aware fade keeps them discoverable exactly when the user is engaged with a region, and quietly recedes when they move on, preserving whitespace and visual clarity.

**UX shape.**

- Scope: **all scrollable containers** in the app.
- On `mouseenter` of a scrollable container, its scrollbar fades in over ~200ms and stays fully visible for as long as the cursor remains inside the container. Hovering keeps it visible indefinitely; there is no timeout while hovered.
- On `mouseleave`, start a 4-second timer. When it elapses, the scrollbar fades out over ~200ms.
- If the cursor re-enters before the 4 seconds elapse, cancel the timer and keep the scrollbar visible.
- Fade duration is fixed at ~200ms and is **not** configurable.
- Styling respects the monochrome palette: a neutral, semi-transparent bar subtly distinct from the background.

**Resolved decisions (UX designer calls).**

1. Scope: all scrollable containers. (Confirmed.)
2. Hold duration: 4 seconds after the cursor leaves. (Confirmed.)
3. Fade duration: ~200ms, not configurable.
4. Keyboard navigation: scrolling via keyboard (arrows, Page Down) while focused should reveal the scrollbar and reset the 4-second timer, so keyboard users get the same feedback as mouse users even without hover.
5. Scroll event interaction: actively scrolling (wheel, trackpad, keyboard) reveals the scrollbar and resets the 4-second hide timer. Any scroll interaction counts as engagement.
6. Always-visible override: no user-facing or per-component override in v1. One consistent behavior everywhere keeps it predictable; revisit only if an accessibility need surfaces.
7. Platform consistency: this aligns with macOS's auto-hide scrollbar precedent (reveal on interaction, hide when idle), so the behavior should feel native rather than novel.

**Open questions.**

1. Implementation surface: is this best done as a shared scroll-container component/hook that owns the hover + timer + fade logic, or as a global CSS/utility applied to existing scroll regions? A shared primitive is likely cleaner so the behavior stays uniform.
2. Reduced-motion: under `prefers-reduced-motion`, should the fade be replaced with an instant show/hide (still respecting the 4-second hold)? Assume yes.
