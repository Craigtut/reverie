<div align="center">

<img src="branding/Mac%20Icon%20Update.png" alt="Reverie" width="120" />

# Reverie

**Run many agents in parallel, and stay on top of all of them.**

For every kind of work, not just engineering.

[Download for macOS](https://github.com/Craigtut/reverie/releases/latest) · [Overview](#run-the-whole-fleet) · [Features](#why-youll-keep-it-open)

</div>

---

## Run the whole fleet

Reverie is a local-first desktop app for running, organizing, and resuming many terminal-based AI agents at once. Point it at any folder on your Mac, launch agents using the CLI tools you already use, and stay on top of everything they are working on from one place.

It was born out of a simple need: a place to run a whole fleet of agentic CLI tools side by side, each one working on a different task at the same time, with a way to keep track of all of them and step in on whichever one needs me.

And those tasks are not always engineering. On any given project you might be working on branding one minute, product requirements the next, then design exploration, then the actual code. Reverie is built for all of it.

## More than code

Most of the tools in this space are really agentic IDEs. They are sharp, but they are built for software engineers and only software engineers. They tend to assume a git repository, lean on git worktrees as the unit of work, and shape everything around repos, branches, and pull requests.

That leaves out almost everyone else, and it leaves out half of what a single person actually does on a project.

Reverie takes a different stance:

- **Folders, not repos.** Any folder on your computer can be a project. Git is always optional, never required.
- **Every kind of work.** Branding, product design, requirements, research, writing, workshopping ideas, and yes, code. Agents are no longer a developer-only tool, so Reverie is not a developer-only app.
- **Nothing gets lost.** Reverie keeps every session organized and resumable, so the cost of stepping away from your agent work approaches zero.

## Why you'll keep it open

### See every agent at a glance

Reverie gives you a dashboard of everything you have running: which agents are live, what each one is working on, and which ones are waiting on you. When an agent gets stuck or needs a decision, it surfaces for attention so you can jump straight in, unblock it, and move on. The rest of the time you can sit back and watch the whole board from a distance.

### Bring your own agents

Reverie runs the command-line agents you already use. Install the ones you want, and Reverie detects what is available and lights them up. Supported today:

- **[Claude Code](https://www.anthropic.com/claude-code)**
- **[Codex CLI](https://openai.com/codex/)**
- **[Cortex Code](https://github.com/Craigtut/cortex-mono)**

Each agent is a swappable adapter under the hood, more agent CLI harnesses to come in the future.

### Agents that talk to each other

Working in parallel, you constantly need one agent to hand context or instructions to another. So cross-agent communication is a first-class feature in Reverie: agents can discover their siblings, pass along context, and hold a short conversation to coordinate. Ask one session to brief another, and it can.

### Resume exactly where you left off

Every session is stored as you go. Close the app, come back tomorrow, and pick up your agent work right where it was, with full context intact.

> More features are on the way.

## Get Reverie

Reverie is a native macOS app for **Apple Silicon** (M1 and later). It is built with [Tauri](https://tauri.app/) and rides on the system WebView instead of bundling a browser engine, so the whole app is a native download under 25 MB.

### [⬇︎ Download the latest release](https://github.com/Craigtut/reverie/releases/latest)

You will want at least one supported agent CLI installed so Reverie has something to launch.

> macOS only, Apple Silicon only, for now.

## Run it from source

Prefer to build it yourself? You will need a Mac on Apple Silicon with [Rust](https://rustup.rs/), [Node.js](https://nodejs.org/), and [Zig 0.15.x](https://ziglang.org/) installed (Zig powers the terminal core). Then:

```bash
git clone https://github.com/Craigtut/reverie.git
cd reverie
npm install
npm run dev      # run the app in development
npm run build    # or build a production app
```

That is the short version. Deeper setup notes, the checks to keep green, and contribution guidelines live in [`CONTRIBUTING.md`](CONTRIBUTING.md), and the full documentation index is in [`docs/`](docs/README.md).

## License & acknowledgements

Reverie's source code is [MIT licensed](LICENSE). The Reverie name and the brand assets in [`branding/`](branding/) are not covered by that license; all rights reserved. If you fork Reverie and ship your own build, please give it a different name and branding so users can tell it apart from the official project.

Reverie's terminal core is built on [Ghostty](https://ghostty.org/)'s VT engine, and the desktop shell is built with [Tauri](https://tauri.app/). See [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) for third-party components and their licenses.

© 2026 Craig Tuttle.
