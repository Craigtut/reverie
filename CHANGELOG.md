# Changelog

All notable changes to Reverie are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-06-16

### Added
- Paste an image from the clipboard straight into a session. Reverie saves it to a
  temporary file and inserts the file path, so you can hand a screenshot to an agent
  without saving it yourself first.
- Install guidance for agent CLIs. When a CLI is not detected, the empty session
  picker and Settings → Agents now offer a copyable install command and a link to
  that CLI's setup instructions.
- Reverie now follows a project folder that is renamed, moved, or deleted. It flags a
  missing folder and lets you relocate it, and on macOS it auto-reconnects a moved
  folder through a saved security-scoped bookmark.
- Sessions remember their scroll position and whether they were tailing the latest
  output as you switch between them, so returning to a session lands where you left off.
- Dashboard session cards now have the same right-click context menu as the left-nav
  rows.
- An ambient green mark breathes up the left-nav rollup while an agent is working, so
  active work is visible even when its branch is collapsed.

### Changed
- The nav row's removal options are collapsed into a single Archive action with
  clearer icons.
- The macOS bundle identifier is now com.muselab.reverie (com.muselab.reverie.dev on
  the dev channel). Because macOS stores application data per identifier, an existing
  install starts from an empty workspace after updating; previous data remains on disk
  under the old identifier.

### Fixed
- Resolved a high-CPU regression: the libghostty-vt terminal core now ships as an
  optimized ReleaseFast build instead of a debug build, which had kept CPU usage high
  and could make sessions feel stuck.
- Resumed sessions render reliably. They repaint at their exact width, restore their
  own frame generation, keep a clean alternate-screen view instead of blanking, and
  fetch missing history rows correctly.
- The ambient terminal glow spans the whole window instead of clipping to a hard edge
  on tall or portrait windows.
- Codex session titles and live state bind correctly again, by backfilling the
  session's rollout path from its native id, and the active Codex goal state is
  mirrored accurately.
- Agents that redraw their UI in place (Ink) no longer leave stale blank rows behind.
- A session needing your attention now takes visual priority over the working "breath"
  on the nav rollup marks.

## [0.4.0] - 2026-06-15

### Added
- Rename sessions, topics, and projects from the left nav. Double-click a row, or
  pick Rename from its right-click menu, to edit the name inline. A renamed session
  keeps its title even as the agent changes its own terminal title.
- A right-click context menu on nav rows, with Rename and "Reveal folder in Finder"
  for a session's working directory or a project's folder.
- Resize the left navigation panel by dragging its edge; the chosen width persists
  across launches.
- Archive a session directly from the left nav.

### Changed
- The nav's new-topic and new-session controls are now a per-row hover "+" instead
  of standalone lines.

### Fixed
- Sessions you have already viewed no longer flood back into "Ready for you" after
  closing and reopening the app.
- A crashed session no longer shows as still running after you reopen the app.
  Unclean shutdowns are detected with a runtime-active marker, and the boot watcher
  no longer re-registers a dead session's last state and resurrects it.
- A session whose agent CLI restarts itself mid-turn (resetting its own activity
  counter) no longer gets stuck in a stale state; activity updates are now ordered
  by wall-clock time.
- Resumed sessions no longer flicker on launch.
- The terminal no longer churns through a burst of resizes when a session starts;
  it now spawns at the measured viewport size and coalesces the startup layout into
  a single commit.
- Codex session titles now derive from the first prompt.
- Long project titles truncate cleanly beside their git line counts.

## [0.3.0] - 2026-06-14

### Added
- Git awareness for projects that are repositories: the dashboard and the left nav
  show live repo status, a dirty-repo glyph in the nav expands on hover to reveal
  added and removed line counts, and a background poll keeps it current. Backed by a
  new gix-based repo status reader in the core, with pull and push available from the
  terminal. Reverie never requires git; this only lights up when a project folder
  happens to be a repository.
- An About section in Settings showing the app version, license, and a link to the
  project on GitHub.
- Support for the kitty keyboard protocol, so Shift+Enter inserts a newline in an
  agent prompt instead of submitting it.
- Keep the Mac awake while agent sessions are running, so long jobs are not
  interrupted by system sleep.

### Changed
- Reorganized Settings into General, Agents, and Archived tabs.
- Sharper session state cells (larger, crisper dots in the sidebar rows and tabs,
  rounded lattice corners), a velocity-driven animated segmented tab selector, and
  window and panel corner rounding tuned closer to native.
- Disabled the native WebView context menu in production builds.

### Fixed
- Toast notifications now anchor to the bottom-right corner.
- Fresh sessions show "Starting" rather than "Resuming" in the launch overlay.

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

[Unreleased]: https://github.com/Craigtut/reverie/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Craigtut/reverie/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Craigtut/reverie/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Craigtut/reverie/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Craigtut/reverie/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Craigtut/reverie/releases/tag/v0.1.0
