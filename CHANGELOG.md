# Changelog

All notable changes to Reverie are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-06-13

### Added
- In-app auto-updates via the Tauri v2 updater: silent background download, a
  toast and a persistent "Relaunch to update" affordance, a manual check plus
  auto-check/auto-download toggles in Settings, install-on-quit, and a relaunch
  that routes through the in-flight-work confirmation so live agent sessions are
  never torn down without consent. Production channel only.

### Fixed
- Reconcile the terminal grid on window focus, visibility change, and resize so a
  returning or resized window no longer shows a stale or misaligned grid.
- Stop trusting the webview for a session's launch program and working directory;
  the backend now resolves them, closing a session-launch trust gap.
- Re-point a session's native id on a CLI session-start boundary so resume and
  activity tracking follow the correct underlying session.

## [0.1.0] - 2026-06-07

First tagged release of Reverie, a local-first desktop workspace for running,
organizing, and resuming many terminal-based AI agent sessions in parallel.
Targets macOS (Apple Silicon).

### Added
- Local-first agentic workspace organized around the Workspace, Project, Focus,
  and Session model, with a left-nav map of agent work that survives reload and
  relaunch.
- Terminal pipeline backed by the libghostty-vt core with a WebGL2 renderer,
  scrollback, and resize reflow, painting many concurrent sessions at once.
- Agent CLI integration (Claude Code and Codex) with session launch, resume, and
  per-CLI lifecycle state tracking.
- Session lifecycle and curation: derived session states, plus archive, restore,
  and permanent delete across projects, focuses, and sessions.
- Inter-agent connection bridge that lets sibling agent sessions discover and
  coordinate with each other.
- Separate development and production channels so dev data, icon, and Dock
  identity never co-mingle with a real install.
- macOS packaging with the Ghostty dylib bundled via a baked rpath (no runtime
  `DYLD_LIBRARY_PATH`), wired for Developer ID signing and notarization.
- MIT license and open-source project documentation.
- Continuous integration and tag-triggered release build pipelines.
- Pre-commit linting/formatting (Biome, rustfmt) and Conventional Commit
  validation (commitlint) via Husky.

[Unreleased]: https://github.com/Craigtut/reverie/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Craigtut/reverie/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Craigtut/reverie/releases/tag/v0.1.0
