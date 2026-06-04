# Packaging and Distribution

How Reverie is built into a distributable desktop app, how the Ghostty terminal
core is shipped without runtime `DYLD_LIBRARY_PATH` hacks, and how releases are
cut. Read this before touching the release pipeline, `tauri.conf.json` bundling,
or anything that links `libghostty-vt`.

## The problem today

Reverie links the Ghostty VT core through `libghostty-vt` / `libghostty-vt-sys`.
The `-sys` build script runs `zig build -Demit-lib-vt`, which produces a shared
library, and then tells Cargo to link it dynamically:

```
cargo:rustc-link-search=native=<OUT_DIR>/ghostty-install/lib
cargo:rustc-link-lib=dylib=ghostty-vt
```

It does **not** emit any rpath. As a result:

- The dylib's install name is `@rpath/libghostty-vt.dylib`.
- The Reverie binary records a load command for `@rpath/libghostty-vt.dylib`
  but carries **no `LC_RPATH`** entries, so `@rpath` resolves to nothing.
- `cargo run` and `cargo test` still work, because Cargo automatically adds the
  `rustc-link-search` native directory to the dynamic loader path for processes
  it launches. This masks the missing rpath during development.
- A binary launched directly (for example `npm run run:release`) or one inside
  a packaged `.app` gets no such help, so it fails to find the dylib. The
  current workaround is to set `DYLD_LIBRARY_PATH` to the hashed build-output
  directory at runtime.

`DYLD_LIBRARY_PATH` at runtime is a development crutch, not an architecture. It
cannot survive packaging (the build-output path is hashed and absent from a
shipped app), and it was the reason app bundling stayed disabled. This has been
fixed (see "How it works" below): `DYLD_LIBRARY_PATH` no longer appears anywhere
in the runtime story, for development or for production bundles.

This is a build-and-link-layer problem. It is **not** an application-level
re-architecture: the domain, runtime, terminal-boundary, and UI layers are
unaffected. Only the native-link and packaging seam needs to change.

## Evidence

From the current release build (`otool`):

- Dylib install name: `@rpath/libghostty-vt.dylib`.
- Binary reference: `@rpath/libghostty-vt.dylib`, with **no `LC_RPATH`**.
- The dylib's only external dependency is `/usr/lib/libSystem.B.dylib`. Zig
  statically folds simdutf, Highway, and compiler-rt into the dylib, so it is
  fully self-contained.

The build also emits a static archive, `libghostty-vt.a`, alongside the dylib.

## How it works (implemented and verified)

The dylib is the clean artifact: it depends only on `libSystem`, so it is copied
into the app bundle and resolved with a normal rpath. No `DYLD_LIBRARY_PATH`
anywhere, in development or production.

**1. Baked rpath (`apps/desktop/src-tauri/build.rs`).** The build script emits,
for macOS bins only:

```
cargo:rustc-link-arg-bins=-Wl,-rpath,@executable_path/../Frameworks
```

That resolves `@rpath/libghostty-vt.dylib` to
`Reverie.app/Contents/Frameworks/libghostty-vt.dylib`. It targets bins only (so
test binaries stay clean) and keys off `CARGO_CFG_TARGET_OS`. Reverie ships
macOS (Apple Silicon) only, so this is the only rpath emitted.

**2. Dylib staging (same `build.rs`).** Staging is done in `build.rs`, *not* in a
`beforeBundleCommand`, on purpose: `tauri_build::build()` validates that the
configured `macOS.frameworks` files exist, and that check runs at **compile**
time, before any bundle phase (a `beforeBundleCommand` would be too late, and a
plain `cargo build` would fail the validation). Our `libghostty-vt-sys`
dependency builds the dylib earlier in the same `cargo` invocation, so by the
time `build.rs` runs the dylib already exists. `build.rs` finds the freshest
`<target>/<profile>/build/libghostty-vt-sys-*/out/ghostty-install/lib/libghostty-vt.dylib`
(derived from `OUT_DIR`, so it stays correct under `--target <triple>`, where the
path becomes `target/<triple>/<profile>/build`), resolves the symlink chain to
real bytes, and copies it to `apps/desktop/src-tauri/frameworks/libghostty-vt.dylib`
(gitignored). The staged file keeps the name `libghostty-vt.dylib` because that
is the dylib's install id (`@rpath/libghostty-vt.dylib`).

Note: the `libghostty-vt` bindings crate has no build script, so the
`DEP_GHOSTTY_VT_*` metadata that the `-sys` crate exports is not forwarded to
`reverie-desktop`. That is why staging globs the build directory rather than
reading a dependency variable.

**3. Bundling (`tauri.conf.json`).** `bundle.active` is `true` and the staged
dylib is listed under the macOS frameworks:

```jsonc
"bundle": {
  "active": true,
  "macOS": { "frameworks": ["frameworks/libghostty-vt.dylib"] }
}
```

Tauri copies it into `Contents/Frameworks` and signs it (ad-hoc without a
Developer ID, real signing when one is configured).

**Monorepo hook directory.** Tauri runs `beforeBuildCommand` /
`beforeBundleCommand` from the **parent of the `tauri.conf.json` directory**,
which in this repo is `apps/desktop` (not `src-tauri`, and not the repo root).
So `beforeBuildCommand` is `npm --prefix ../.. run build:web` (`../..` from
`apps/desktop` is the repo root). Getting this wrong fails the build with an
`npm ENOENT ... package.json` error pointing at the wrong directory.

**4. No DYLD in the scripts.** `dev:desktop`, `dev:tauri`, and `run:release` use
`cargo run`, which injects the dylib search path for the process it launches, so
none of them set `DYLD_LIBRARY_PATH`. `npm run bundle` produces the `.app` and
`.dmg` (it runs `tauri build` from `apps/desktop/src-tauri`).

**Verified.** `npm run bundle` produced `Reverie.app` (with
`Contents/Frameworks/libghostty-vt.dylib`) and `Reverie_0.1.0_aarch64.dmg`. The
bundled binary carries the `@executable_path/../Frameworks` rpath, and launching
it with no `DYLD_*` set produced no `Library not loaded` error (a load-time
linked dylib aborts at startup if unresolved, so this is conclusive). The app and
the dylib are ad-hoc signed.

## The reverie-bridge helper sidecar

The inter-agent connection bridge hands each agent CLI (Claude Code, Codex,
Cortex) an absolute path to a helper binary (`reverie-bridge`) and lets the CLI
spawn it as a stdio MCP server. A second helper, `reverie-bridge-preturn-hook`,
backs the pre-turn lifecycle hook. Both must exist on disk at the path written
into the CLI's config, or the agent reports `MCP client failed to start: No
such file or directory`.

The load-bearing invariant is **the helper lives next to the desktop binary**.
`resolve_bridge_binaries` (in `connection_commands.rs`) writes
`current_exe().parent()/reverie-bridge`, with a dev-only fallback to the root
workspace target dir. `install_*_bridge` refuses to write a path that does not
exist (`BridgeBinaries::ensure_present`), so a half-built tree fails loudly
instead of poisoning a user's config.

Two facts make staging necessary. First, the helpers are members of the **root**
cargo workspace and build into `<repo>/target`, while the desktop app is its own
nested workspace and builds into `apps/desktop/src-tauri/target`, so they never
land in the same directory on their own. Second, a bundled `.app` needs the
helper inside `Contents/MacOS/`, signed. Both are solved by
`scripts/stage-bridge.mjs`, which builds the helper crate (`cargo build -p
reverie-bridge`, no Zig needed) and copies each binary to:

- `apps/desktop/src-tauri/binaries/<name>-<target-triple>` (gitignored) — the
  Tauri `externalBin` staging location. `tauri.conf.json > bundle > externalBin`
  lists `binaries/reverie-bridge` and `binaries/reverie-bridge-preturn-hook`; the
  bundler copies them into `Contents/MacOS/` (triple suffix stripped) and signs
  them next to the main binary.
- `apps/desktop/src-tauri/target/<profile>/<name>` — next to the dev/run desktop
  binary, so `current_exe().parent()` resolves in `npm run dev` / `run:release`.

Staging is wired in two ways. The cargo-direct scripts (`dev:desktop`,
`dev:tauri`, `build:desktop`, `run:release`) call `npm run stage:bridge`
themselves; `npm run bundle` and the release CI go through Tauri, so
`beforeBuildCommand` / `beforeDevCommand` stage the helpers (with the fixed
`--triple aarch64-apple-darwin`, matching the bundle target).

`tauri_build::build()` validates configured `externalBin` files at **compile**
time, the same as `frameworks` (a bare `cargo check` of the desktop crate fails
with `resource path binaries/reverie-bridge-<triple> doesn't exist` otherwise).
So `build.rs` also ensures those files exist: for each helper it copies the
freshly built binary from `<root>/target/<profile>/` when present, and otherwise
writes a zero-byte placeholder (logged as a warning). That keeps bare `cargo
check`, rust-analyzer, and `npm run check` green without a prior staging step.
The placeholder is never shipped: `beforeBuildCommand` runs `stage-bridge.mjs`
ahead of the bundle, so by the time the bundler copies `externalBin` the real
signed binary is in place. `build.rs` does **not** build the helper crate
(cargo cannot reentrantly build a sibling crate); `stage-bridge.mjs` owns the
build.

## Why not static linking (yet)

It is tempting to link `libghostty-vt.a` and ship a single self-contained
binary with no dylib, no rpath, and no bundling. That is the ideal end state,
but the archive that exists today is not self-contained:

- Its undefined symbols include the C++ runtime (`__cxa_throw`,
  `_Unwind_Resume`, `operator delete`, `std::exception::what`), because simdutf
  and Highway are C++.
- It needs compiler-rt builtins (`__extendxftf2`, `__udivti3`, `__umodti3`),
  UBSan handlers (`__ubsan_handle_*`), and stack-protector symbols
  (`__stack_chk_*`).
- It references simdutf and Highway symbols (`simdutf::...`, `hwy::...`) whose
  object code Zig kept in separate archives and folded into the dylib, but did
  **not** include in `libghostty-vt.a`.

So a working static link would need to: gather all of Zig's component archives
(ghostty-vt + simdutf + highway + compiler-rt), link `libc++`, and declare the
extra system libraries. The `-sys` crate does not expose those today. Making
this clean is a worthwhile upstream contribution to `libghostty-vt-sys` (emit a
complete static bundle, or a `static` feature that lists every required link
input), and would remove the entire dylib/bundling concern on all platforms.
Until then, bundling the self-contained dylib is the lower-risk path.

Tracking item: file an upstream issue/PR on `libghostty-vt-sys` for a complete
static-link option, then revisit.

## Other platforms (out of scope)

Reverie targets **macOS (Apple Silicon) only**. Windows and Linux are not
release targets, and the CI/release pipelines build only macOS.

Windows could not ship today even if it were in scope: `libghostty-vt-sys` 0.1.1
(the latest published version) has no Windows build path. Its build script
asserts a `.so`/`.dylib` output and `panic!`s on any non-darwin/non-linux Zig
target, so a Windows build fails at the library step. The VT core itself is
portable Zig and upstream lists Windows as a *planned* target, so this could
change. If Reverie ever revisits Windows, packaging is simple: Windows has no
rpath, and its loader searches the executable's own directory first, so the DLL
ships next to the `.exe` via a `bundle.resources` map (the installer co-locates
them, so users still get a single installer). Linux would mirror macOS with an
`$ORIGIN`-relative rpath. Neither is in scope now.

## Code signing and notarization

- **macOS**: distribution outside the App Store requires a Developer ID
  certificate, signing the app and the bundled dylib, then notarizing. Tauri
  signs `Contents/Frameworks` contents when a signing identity is configured.
  The release workflow wires these via repository secrets:
  `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
  `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`. Without them the build is
  ad-hoc signed and users hit Gatekeeper warnings.

## Dev vs production channels

The app ships from one base config (`tauri.conf.json` = production,
`com.animus.reverie`). To keep a `npm run dev` build from co-mingling its data,
icon, and Dock identity with a real install, the **dev channel** runs under a
separate bundle identifier.

- **Identity.** `scripts/tauri-channel.mjs dev` merges
  `apps/desktop/src-tauri/tauri.dev.conf.json` (`identifier`
  `com.animus.reverie.dev`, `productName` "Reverie Dev", a badged icon set in
  `icons-dev/`) over the base config. macOS namespaces Application Support,
  Caches, and Preferences by identifier, so the dev build's database, General
  scratch workspaces, and diagnostics land in
  `~/Library/Application Support/com.animus.reverie.dev/` and never touch the
  production folder. The agent CLI homes (`~/.claude`, `~/.codex`, `~/.cortex`)
  are deliberately shared: those sessions belong to the CLIs, not to Reverie.

- **Mechanism.** The overlay is passed through the `TAURI_CONFIG` env var, a
  JSON string that `tauri-build` reads at compile time and merge-patches
  (RFC 7396) over the file config. This is the same merge the Tauri CLI's
  `--config` flag performs, but it works through our `cargo run` dev path
  without routing through the Tauri CLI. `tauri-build` emits
  `rerun-if-env-changed=TAURI_CONFIG`, so switching channels recompiles the
  embedded context; dev (debug profile) and prod (release profile) keep separate
  build artifacts, so they never thrash each other.

- **Production stays default.** `npm run build` and `npm run bundle` pass no
  overlay, so a local `npm run build` produces a genuine production app you can
  install and test. Only `npm run dev` carries the dev identity.

- **Runtime adornment.** A `cargo run` dev build is a bare binary with no app
  bundle, so the badged Dock icon is set at runtime (`set_macos_dock_icon` in
  `main.rs`) and the window title gets a " Dev" suffix. Both are gated on
  `commands::is_dev_channel` (identifier ends in `.dev`), as are the terminal
  renderer diagnostics.

- **Helpers.** `npm run dev:reset` wipes the dev data folder (only ever the
  `.dev` path) for a clean schema slate; `npm run icon:dev` regenerates the
  badged icon from the production master after it changes.

## Release flow

Releases are cut by pushing a version tag, which triggers
`.github/workflows/release.yml`.

1. Make sure `main` is green and `npm run check` passes.
2. **Update `CHANGELOG.md`**: move the `Unreleased` entries into a new
   `## [X.Y.Z]` section, summarizing changes from the commits since the previous
   tag (`git log <prev-tag>..HEAD`). Group by Conventional Commit type
   (Added/Changed/Fixed). Commit as `docs(release): changelog for vX.Y.Z`.
3. Bump every manifest in lockstep with
   `npm run version:set -- X.Y.Z` (updates `package.json`,
   `apps/desktop/src-tauri/tauri.conf.json`, and the crate `Cargo.toml` files;
   then `npm run check` refreshes `Cargo.lock`).
4. Tag and push:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. The release workflow builds the macOS (Apple Silicon, `aarch64-apple-darwin`)
   app, signs/notarizes it if the Apple secrets are present, and creates a draft
   GitHub Release with the artifacts. Review the draft, then publish.

The macOS target is Apple Silicon only. A universal or Intel build would be a
later addition and would require building the Ghostty native library for both
architectures and lipo-ing the dylib.

## Status checklist

- [x] `build.rs` bakes `@executable_path/../Frameworks` rpath (macOS).
- [x] Dylib staged to a stable path for bundling.
- [x] `bundle.active = true` with icons and `macOS.frameworks` wired.
- [x] App launches from a clean environment with no `DYLD_*` set.
- [x] `DYLD_LIBRARY_PATH` removed from `npm run` scripts.
- [x] macOS `.app` + `.dmg` produced locally via `npm run bundle`.
- [ ] Apple signing/notarization secrets added in repo settings (for signed, notarized releases).
- [ ] (Later, optional) upstream `libghostty-vt-sys` static-link option evaluated.
