# Reverie Product Vision

> The high-level "why" behind Reverie. For concrete v1 scope, flows, and requirements see [`product/v1-product-spec.md`](product/v1-product-spec.md).

## One sentence

Reverie is a local-first **agentic workspace** — a calm home for running, organizing, and resuming many terminal-based AI agent sessions in parallel, for anyone, not just software engineers.

## The problem we are reacting to

A growing class of tools wraps agentic coding CLIs in a desktop or web shell. They are good, but they share assumptions that quietly exclude most people:

- They are **narrowly focused on software engineering**.
- They usually **require git**, and frequently default to **git worktrees** as the unit of work.
- Their information architecture is built from developer concepts — repos, branches, PRs, issues, worktrees.

That framing makes sense for engineers and excludes everyone else. But terminal agents are no longer a developer-only tool. Designers, product managers, writers, researchers, and operators increasingly run agent CLIs against folders of assets, notes, and documents. They deserve a first-class home too.

## What Reverie is

Reverie is a **generic agentic workspace environment**. Its durable value is the user's organized, resumable map of agent work — not any single terminal component, and not any one kind of work.

The central promise:

> **Come back later and pick up exactly where your agent work left off.**

## Who it's for

Reverie is deliberately persona-plural. Engineers are *a* primary persona, not *the* persona.

- **Engineers** — Claude Code / Codex / Cortex across codebases.
- **Product designers & PMs** — agent sessions against design folders, specs, and notes.
- **Writers, researchers, operators** — agentic work against documents, assets, and general folders.

The shared trait is "person running multiple agent CLIs for real work who wants a calmer way to keep those sessions organized and resumable."

## The core mental model

Reverie organizes agent work into a small, deliberately generic hierarchy:

```
Workspace
└── Project            (a folder on your computer; git optional, never required)
    └── Focus          (a logical grouping / area of work)
        └── Session     (a live agent CLI session, stored as resumable metadata)
```

- **Workspace** — the top of the hierarchy. It exists in the model but is intentionally underexpressed in the UI today; users mostly live in projects and focuses.
- **Project** — essentially just a folder on your computer. There is also a **General** project that defaults to a `.reverie` folder, for work that isn't tied to a specific folder. **Projects never require git.**
- **Focus** — a set of things you want to work on: a logical grouping or area. Examples: *security updates*, *branding*, *product design*, *UX design*, *login*, *sign-up*. It's a masthead for related sessions, intentionally looser than a "task" or "ticket."
- **Session** — an actual CLI session with a supported agentic harness. Each session gives you a terminal running that harness, and the session is stored as metadata attached to its tab so you can leave and resume it later with full context.

## Supported agent harnesses (v1)

Reverie launches and resumes sessions against installed agent CLIs. The first three:

1. **Claude Code**
2. **Codex CLI**
3. **Cortex Code**

Users install the CLIs themselves; Reverie detects what's available and enables it. The architecture treats each CLI as a swappable adapter, so more harnesses can be added without touching the product model.

## Why "run many agents in parallel" is the point

The unit of value is parallelism plus continuity. A user might have a security audit running under one focus, branding exploration under another, and a writing session in a general workspace — all as live or resumable tabs. Reverie keeps every one of those sessions stored, organized, and ready to continue, so the cost of stepping away from agent work approaches zero.

## Product principles

1. **Generic before developer-specific.** Avoid overindexing on repos, branches, worktrees, PRs, or issues. Developer features can appear later as opt-in, progressive disclosure.
2. **No git requirement, ever, in the core flow.** Folders can be projects; git is optional.
3. **Projects are helpful, not mandatory.** First run must not force a project.
4. **Session continuity over feature sprawl.** The product is a resumable map of agent work, not an IDE.
5. **A fast, native-quality terminal is core product value**, not a nice-to-have. See [`technical/terminal-strategy.md`](technical/terminal-strategy.md).
6. **Local-first trust.** v1 stores state locally; no accounts, no cloud sync.
7. **Dangerous / YOLO mode is explicit.** Off by default, opt-in, overridable per session.
8. **Calm by default.** The interface should feel quiet and focused; the work is the agent output, not our chrome. See [`design-vision.md`](design-vision.md).

## What Reverie is *not* (v1)

- Not an IDE and not a thin wrapper around a single terminal component.
- Not git-, worktree-, or repo-gated.
- Not an issue tracker, PR tool, or developer-only information architecture.
- No accounts, cloud sync, or team features yet.

## How this evolves

This vision will keep developing. The shape that's settled: a persona-plural, local-first, folder-based agentic workspace with a Workspace → Project → Focus → Session model and a genuinely good terminal. The parts still moving are UI language (e.g. how much "Workspace" and "Focus" surface), which harnesses we add next, and which developer affordances graduate from opt-in to mainstream.
