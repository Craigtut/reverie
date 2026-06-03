# Home: the attention router

> Part of the [core experience](README.md). Depends on principle 1: the router never ranks by intelligence.

## Problem

Today the home shows every non-archived session, grouped by state into rails. Open the app with a dozen sessions and you face a wall of mostly-idle tiles, each demanding a scan, none telling you what actually needs you. That is the orchestration layer failing its one job: it should *minimize* attention, and instead it spends it.

The fix is to stop treating the home as a session directory and treat it as an attention router that answers one question on sight: **what needs me, and in what order?** When the answer is "nothing," the home should be quiet, not full.

## The ordering: objective state tiers

The vertical order is derived from facts, never judged. This is what makes it trustworthy: the user can always predict where a session will sit, because there is no cleverness in it.

| Tier | Meaning | Visual weight | Action on the card |
| --- | --- | --- | --- |
| **Errored** | Unrecoverable error; the agent is stuck | Large, full context | Retry / open / dismiss |
| **Blocked on approval** | Agent cannot proceed without a decision | Large, shows the exact ask | Approve / deny inline (see [approval-cards.md](approval-cards.md)) |
| **Finished, unseen** | Produced a result you have not looked at | Medium, one-line summary | Opens and clears on view |
| **Working** | Mid-turn, nothing required of you | Ambient strip, one-line "now doing X" | None |
| **Idle** | At rest, already seen | Thin row, or collapsed into the nav | None |
| **Fresh** | Never launched | Off the home entirely; lives in the nav | None |

Two consequences:

- **Visual weight follows the tier, and the tier is objective**, so the sizing is always defensible. Things that need you are large and carry context, a reason, and (where the CLI allows) the action itself. Things that do not need you shrink or disappear. This is the hierarchy the product owner asked for, and it is safe precisely because state is factual.
- **A tile must earn its place on the home by needing something.** Idle and fresh sessions do not shout from the home; they live in the nav. That alone dissolves the "sixteen idle tiles" feeling, because most of those sixteen should not be on the home at all.

## The "finished, unseen" tier

This is the tier that makes the parallel-agent map pay off: a glanceable list of "what produced something I have not seen." It is the in-flight T1 work (the `finished` session state that enters when a turn completes while you are not viewing the session, and clears when you view it; persisted via `lastViewedAt` vs the activity's turn-completion timestamp so it survives relaunch). The router design assumes that state exists and gives it its own tier between "blocked" and "idle." See the finished-state ticket in [`ideas-and-tickets.md`](../../ideas-and-tickets.md).

## The only place the model appears: captions

Per principle 1, the LLM never orders this surface. It may write the one-line caption on a card ("Refactoring the auth module," "Wants to run `rm -rf build/`"). That caption is a labeling job, recoverable if wrong. Ordering stays mechanical. The caption can come from the [completion surface](completions-and-reentry.md) or, more cheaply, from the activity state's existing `displaySummary` and active-tool data where that is enough.

## What we deliberately did not build

- **No pins or stars.** A "focus these one or two agents" control sounds right but pushes a management chore onto the user every time their focus shifts. The cost is constant; the benefit is occasional. Rejected.
- **No topic/project importance weighting.** Inferring that the topic you are sitting in is "more important" reintroduces a guess into the ordering, which is exactly what breaks trust. Rejected.

The user's real "I am focused on one or two of these" need is served instead by the conversation layer (the session you are in is the one you are in) and by the fact that the home only surfaces what objectively needs attention, so the background agents stay quiet until they actually block.

## Calm when empty

When nothing is errored, blocked, or unseen, the home is near-empty: an "all caught up" state, the ambient working strip if anything is running, and the dot field. Emptiness is the product working, not a blank to fill.

## Builds on

- `apps/desktop/web/domain/activity.ts` (`deriveSessionState`, `groupSessionsByState`, rollups) and the dashboard rail components. This is largely a reshape of the existing state grouping: collapse idle/fresh off the home, give finished its own tier, scale card weight by tier.
- The finished-state work already underway.

## Open questions

- Debounce for autonomous multi-turn agents so "finished" does not flicker between turns.
- The errored/recoverable boundary: which errors are "stuck, surface large" vs transient/self-recovering.
- Density of the ambient working strip when many agents run at once (it must stay glanceable, not become a second wall).
- Whether idle lives as a thin collapsed section on the home or moves entirely to the nav.
