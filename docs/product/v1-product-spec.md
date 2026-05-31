# Reverie V1 Product Spec

## Product thesis

Reverie is an agent session organizer, not an IDE.

Its job is to help people create, organize, monitor, and resume terminal-based AI agent sessions across time. Some users will work in code repositories, but v1 must also serve designers, product managers, writers, operators, and other people using agent CLIs against folders, notes, assets, or general workspaces.

The central promise: **come back later and pick up exactly where your agent work left off.**

## Target users

### Primary

- Power users running multiple CLI agents for real work.
- Engineers using Claude Code, Codex CLI, and Cortex Code across codebases.
- Product/design/ops users who want agentic terminal workflows without being forced into git or software-development concepts.

### Secondary

- People experimenting with multiple agent CLIs who need a calmer way to keep sessions organized.
- Teams that may eventually want synced settings/session state, though this is explicitly out of scope for v1.

## Product principles

1. **Fast, native-quality terminal experience is core product value** — Reverie exists partly because competing tools make the terminal feel slow, brittle, or unpleasant. V1 must make terminal performance and fidelity a first-class requirement, not a nice-to-have.
2. **Session continuity over feature sprawl** — the product value is persistent organization and restoration without becoming an overloaded IDE.
3. **No git requirement** — folders can be projects, but git is optional.
4. **Projects are helpful, not mandatory** — first run must not force a project.
5. **Generic language first** — avoid overindexing on issues, branches, worktrees, pull requests, or other developer-only concepts.
6. **Progressive disclosure** — developer-specific features can appear later as opt-in affordances.
7. **Local-first trust** — v1 stores state locally and does not require accounts or cloud services.
8. **Dangerous mode is explicit** — off by default, opt-in during onboarding/settings, overridable per session.

## Core information architecture

```text
Workspace
├── General workspace
│   └── Focus
│       └── Session tabs
└── Projects
    └── Project
        └── Focus
            └── Session tabs
```

### Workspace

The user's local Reverie home. Stores app settings, detected CLIs, project list, general workspace foci, sessions, restore metadata, and terminal/session preferences.

Local path (macOS):

```text
~/Library/Application Support/com.animus.reverie/
```

General (project-less) sessions each get a fresh, temporary scratch working directory under `general-sessions/` in that same app data directory, created when the session starts and removed when the session is deleted.

### Project

An optional folder-backed context. A project can be a code repo, design folder, notes vault, campaign folder, research directory, or any other folder.

Rules:

- Must not require git.
- Can later expose git/developer features only when relevant.
- Has many foci.

### Focus

A user-defined masthead for a cluster of related sessions.

Examples:

- Security
- Branding
- Marketing launch
- Legacy cleanup
- Product notes
- Research synthesis
- Bug triage

`Focus` is preferred over `Task` because it is less ticket-like and supports broader work.

### Session

A resumable agent CLI tab inside a focus.

A session has:

- Reverie-owned ID
- agent kind: Claude Code, Codex CLI, Cortex Code
- optional native CLI session ID/reference
- cwd/project context
- title
- created/updated timestamps
- terminal status
- restore status
- dangerous-mode override

## First-run experience

First run should not force users into a project.

Recommended onboarding flow:

1. Welcome: explain Reverie as a place to organize and resume agent sessions.
2. CLI detection: show installed/available CLIs and missing CLIs.
3. Safety preference: choose whether dangerous / YOLO mode is enabled by default. Default is off.
4. Starting point:
   - Start a general workspace session
   - Add/open a project folder
   - Explore with no session yet

Projects are introduced as useful context, not as a gate.

## Main user flows

### Start a general workspace session

1. User chooses `New Focus` in the general workspace.
2. User names the focus.
3. User creates a session tab.
4. Reverie asks which installed CLI to use.
5. Reverie launches the CLI in a fresh, temporary scratch workspace created for that session.
6. Reverie stores mapping between the Reverie session and the CLI-native session metadata once available.

### Add a project

1. User chooses `Add Project`.
2. User selects any folder.
3. Reverie creates a project record without requiring git.
4. User creates foci and sessions inside that project.

### Resume work

1. User opens Reverie.
2. App shows recent foci/sessions across general workspace and projects.
3. User selects a focus.
4. Previous session tabs are visible with restore state.
5. User clicks a session tab.
6. Reverie launches the correct CLI resume command using stored native session metadata.

### Create another agent tab in same focus

1. User is inside a focus.
2. User clicks `New Session`.
3. User selects an available CLI.
4. Reverie launches a new CLI session in the same context.
5. Multiple sessions can coexist as tabs under the same focus.

## V1 supported CLIs

### Cortex Code

Known behavior from `Cortex-Mono`:

```sh
cortex
cortex --resume [session-id]
cortex --model <model>
cortex --compaction <observational|classic>
cortex --yolo
```

Persistence:

```text
~/.cortex/sessions/{sessionId}/history.json
~/.cortex/sessions/{sessionId}/meta.json
~/.cortex/sessions/{sessionId}/observations.json
```

Reverie should store the Cortex UUID as the native session ref and restore with:

```sh
cortex --resume <session-id>
```

### Claude Code

Needs dedicated adapter research for:

- executable name/path detection
- new session command
- resume command and native session ID behavior
- dangerous-mode flag behavior
- how to discover the native session identifier after launch

### Codex CLI

Needs dedicated adapter research for:

- executable name/path detection
- new session command
- resume command and native session ID behavior
- dangerous-mode flag behavior
- how to discover the native session identifier after launch

## V1 requirements

### Must have

- Tauri v2 desktop app shell.
- Rust-side app/domain/persistence backend.
- Local app database/config under Reverie-owned storage.
- General workspace support.
- Project support with arbitrary folders and no git requirement.
- Focus creation/editing/deletion.
- Session creation under a focus.
- CLI detection for Claude Code, Codex CLI, Cortex Code.
- CLI adapter model for launching new sessions and restoring sessions.
- Per-session terminal process lifecycle.
- Persistent mapping from Reverie sessions to native CLI session refs.
- Onboarding with dangerous-mode opt-in, default off.
- Per-session dangerous-mode override.
- Basic terminal UX: input, output, resize, copy/paste, restart/restore affordances.

### Should have

- Recent sessions/foci view on launch.
- Clear unavailable-CLI setup messages.
- Restore failure states with understandable recovery options.
- App-level settings for default workspace path, default dangerous mode, and CLI paths.
- Session status indicators: running, exited, restorable, restore failed.

### Could have after core v1

- Worktree support as opt-in developer feature.
- Project templates.
- Session notes or summaries.
- MCP/skills management.
- Cloud sync for settings/session state.
- Team/account features.

## Explicit non-goals for v1

- No accounts.
- No cloud sync.
- No GitHub/Linear issue integration.
- No mandatory worktrees.
- No mandatory git repositories.
- No MCP connector UI.
- No attempt to become a full developer IDE.
- No developer-only information architecture.

## Open product decisions

1. Exact visual layout: sidebar-first, command-center-first, or hybrid.
2. Whether `Focus` is final product language or should be softened further in UI copy.
3. How much terminal chrome to expose around each session tab.
4. Whether a session can move between foci/projects in v1.
5. Whether closing a session tab means hide, stop process, archive, or user-selectable behavior.
