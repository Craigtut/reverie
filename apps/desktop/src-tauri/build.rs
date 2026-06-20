use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    // Reverie ships macOS (Apple Silicon) only. Bake an rpath so the bundled app
    // resolves `@rpath/libghostty-vt.dylib` from `Contents/Frameworks/` without
    // any runtime DYLD_LIBRARY_PATH. Development and tests do NOT need this:
    // `cargo run`/`cargo test` inject the build-output library directory into the
    // loader search path automatically. Applies to bins only (test binaries stay
    // clean) and keys off the build TARGET (so an explicit `--target` is fine).
    if target_os == "macos" {
        println!("cargo:rustc-link-arg-bins=-Wl,-rpath,@executable_path/../Frameworks");
    }

    // The on-device speech engine (reverie-speech, fluidaudio) builds a Swift
    // package in its own build script, so a Swift toolchain (Xcode Command Line
    // Tools) must be present. Fail loudly with install guidance now, rather than
    // letting the Swift build fail with a noisier error later. Mirrors the
    // "fail loudly" philosophy of the Zig 0.15 requirement.
    if target_os == "macos" {
        let has_swift = std::process::Command::new("xcrun")
            .args(["--find", "swift"])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);
        if !has_swift {
            panic!(
                "Swift toolchain not found (needed to build the on-device speech \
                 engine). Install the Xcode Command Line Tools: `xcode-select --install`."
            );
        }

        // The FluidAudio Swift bridge references the OS Swift runtime libraries
        // (e.g. `@rpath/libswift_Concurrency.dylib`), which live in `/usr/lib/swift`
        // (in the dyld shared cache). Bake that rpath so the app resolves them at
        // launch. A dependency's `rustc-link-arg` does not propagate, so this is
        // added here in addition to reverie-speech's own build script.
        println!("cargo:rustc-link-arg-bins=-Wl,-rpath,/usr/lib/swift");
    }

    // Compile the Objective-C folder-identity bookmark shim and link Foundation.
    // Backs project auto-reconnect (following a project folder across a rename or
    // move). macOS-only, like the rest of the app.
    if target_os == "macos" {
        cc::Build::new()
            .file("native/reverie_bookmark.m")
            .flag("-fobjc-arc")
            .compile("reverie_bookmark");
        println!("cargo:rerun-if-changed=native/reverie_bookmark.m");
        println!("cargo:rustc-link-lib=framework=Foundation");

        // Compile the clipboard-image shim and link AppKit (NSPasteboard,
        // NSBitmapImageRep, NSImage). Backs clipboard-image paste into terminals.
        cc::Build::new()
            .file("native/reverie_clipboard.m")
            .flag("-fobjc-arc")
            .compile("reverie_clipboard");
        println!("cargo:rerun-if-changed=native/reverie_clipboard.m");
        println!("cargo:rustc-link-lib=framework=AppKit");
    }

    // Stage the Ghostty dynamic library to a stable path that
    // `tauri.conf.json > bundle > macOS.frameworks` references, so the bundler
    // copies it into `Contents/Frameworks/` and signs it.
    //
    // This is done here, in build.rs, on purpose: `tauri_build::build()` below
    // validates that the configured framework files exist, and that check runs
    // at compile time, before any bundle phase (so a `beforeBundleCommand` would
    // be too late). Ordering is guaranteed because we depend on the
    // `links = "ghostty-vt"` crate `libghostty-vt-sys` directly: Cargo runs its
    // build script (which produces the dylib) before ours.
    //
    // Never ship a placeholder. v0.5.0 shipped a 0-byte `libghostty-vt.dylib`
    // because staging silently fell back to writing empty bytes, and dyld then
    // aborted the app at launch ("Library not loaded: @rpath/libghostty-vt.dylib").
    // If we cannot stage a real dylib, fail the build loudly instead.
    if target_os == "macos" {
        if let Err(err) = stage_ghostty_dylib() {
            panic!(
                "failed to stage libghostty-vt.dylib for bundling: {err}\n\
                 Refusing to build a desktop bundle without the real Ghostty dylib; \
                 it would abort at launch with a dyld \"Library not loaded\" error."
            );
        }
    }

    // Guarantee the reverie-bridge helper sidecars exist where `externalBin`
    // expects them. `tauri_build::build()` validates configured `externalBin`
    // files at COMPILE time (same as `frameworks`), so a bare `cargo check`,
    // rust-analyzer, or `npm run check` would fail without this. The real,
    // signed binaries are produced by `scripts/stage-bridge.mjs`, which runs
    // ahead of the bundle via `beforeBuildCommand`; here we only ensure a file
    // is present (copying the freshly built helper from the root workspace
    // target dir when available, otherwise a placeholder the bundle overwrites).
    if let Err(err) = ensure_bridge_external_bins() {
        println!("cargo:warning=failed to stage reverie-bridge sidecars: {err}");
    }

    tauri_build::build();
}

/// Ensure `binaries/<name>-<target-triple>` exists for each bridge helper so
/// Tauri's compile-time `externalBin` validation passes for any desktop build.
fn ensure_bridge_external_bins() -> std::io::Result<()> {
    const NAMES: [&str; 3] = [
        "reverie-bridge",
        "reverie-bridge-preturn-hook",
        "reverie-codex-hook",
    ];
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let triple = env::var("TARGET").expect("TARGET must be set in build scripts");
    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    let binaries_dir = manifest.join("binaries");
    fs::create_dir_all(&binaries_dir)?;

    // manifest = <root>/apps/desktop/src-tauri; the helper crate is a root
    // workspace member that builds into <root>/target/<profile>/.
    let workspace_root = manifest
        .ancestors()
        .nth(3)
        .ok_or_else(|| io_error("unexpected CARGO_MANIFEST_DIR layout"))?;
    let built_dir = workspace_root.join("target").join(&profile);

    for name in NAMES {
        let dest = binaries_dir.join(format!("{name}-{triple}"));
        // A non-empty file is a real binary (staged here or by stage-bridge.mjs).
        if fs::metadata(&dest).map(|m| m.len() > 0).unwrap_or(false) {
            continue;
        }
        let src = built_dir.join(name);
        if src.exists() {
            fs::copy(&src, &dest)?;
            println!("cargo:rerun-if-changed={}", src.display());
        } else {
            // Placeholder satisfies only the compile-time externalBin check;
            // the bundle overwrites it via scripts/stage-bridge.mjs first.
            fs::write(&dest, b"")?;
            println!(
                "cargo:warning=staged placeholder for {name}; run `npm run stage:bridge` before bundling"
            );
        }
    }
    Ok(())
}

/// Copy the built `libghostty-vt.dylib` (resolving its symlink chain to real
/// bytes) into `<crate>/frameworks/libghostty-vt.dylib` for bundling, verifying
/// the result is non-empty. Errors are fatal to the build (see `main`).
fn stage_ghostty_dylib() -> std::io::Result<()> {
    const LIB_NAME: &str = "libghostty-vt.dylib";

    let source = locate_ghostty_dylib()?;
    let real = fs::canonicalize(&source)?;
    let real_len = fs::metadata(&real)?.len();
    if real_len == 0 {
        return Err(io_error(&format!(
            "located libghostty-vt dylib is empty: {}",
            real.display()
        )));
    }

    let dest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("frameworks");
    fs::create_dir_all(&dest_dir)?;
    let dest = dest_dir.join(LIB_NAME);
    fs::copy(&real, &dest)?;

    // Defend against a truncated copy ever reaching the bundler.
    let dest_len = fs::metadata(&dest)?.len();
    if dest_len != real_len {
        return Err(io_error(&format!(
            "staged dylib is {dest_len} bytes but source is {real_len} bytes: {}",
            dest.display()
        )));
    }

    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-env-changed=DEP_GHOSTTY_VT_INCLUDE");
    Ok(())
}

/// Find the freshest built libghostty-vt dylib. Prefer the exact location from
/// the `libghostty-vt-sys` `links` metadata; fall back to scanning Cargo's build
/// output for the dependency's install dir.
fn locate_ghostty_dylib() -> std::io::Result<PathBuf> {
    if let Some(path) = ghostty_dylib_from_dep_metadata() {
        return Ok(path);
    }
    ghostty_dylib_from_build_scan()
}

/// `DEP_GHOSTTY_VT_INCLUDE` is `<sys-out>/ghostty-install/include`; the dylib
/// lives at the sibling `lib/`. Cargo sets this only for direct dependents of the
/// `links = "ghostty-vt"` crate, which is why we depend on `libghostty-vt-sys`
/// directly (see Cargo.toml).
fn ghostty_dylib_from_dep_metadata() -> Option<PathBuf> {
    let include = env::var_os("DEP_GHOSTTY_VT_INCLUDE")?;
    // The value may join multiple include dirs; the install include dir is first.
    let first = env::split_paths(&include).next()?;
    let lib_dir = first.parent()?.join("lib");
    newest_dylib_in(&lib_dir)
}

/// Fallback: scan Cargo's build output for a `libghostty-vt-sys-*` install dir.
fn ghostty_dylib_from_build_scan() -> std::io::Result<PathBuf> {
    // OUT_DIR = <target>/<profile>/build/reverie-desktop-<hash>/out
    // build dir = <target>/<profile>/build  (shared with libghostty-vt-sys-*).
    // Deriving it from OUT_DIR keeps this correct under `--target <triple>`,
    // where the path becomes target/<triple>/<profile>/build.
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR must be set"));
    let build_dir = out_dir
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| io_error("unexpected OUT_DIR layout"))?;

    let mut newest: Option<(SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(build_dir)? {
        let entry = entry?;
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with("libghostty-vt-sys-")
        {
            continue;
        }
        let lib_dir = entry.path().join("out/ghostty-install/lib");
        if let Some(candidate) = newest_dylib_in(&lib_dir) {
            if let Ok(modified) = fs::metadata(&candidate).and_then(|m| m.modified()) {
                if newest.as_ref().is_none_or(|(t, _)| modified > *t) {
                    newest = Some((modified, candidate));
                }
            }
        }
    }

    newest
        .map(|(_, path)| path)
        .ok_or_else(|| io_error("built libghostty-vt dylib not found in Cargo build output"))
}

/// Return the preferred libghostty-vt dylib in `lib_dir`: the unversioned
/// `libghostty-vt.dylib` symlink if present, else the newest `libghostty-vt*.dylib`.
/// The basename moved across versions (0.1.x emitted `libghostty-vt.0.1.0.dylib`,
/// 0.2.0 emits `libghostty-vt.dylib -> libghostty-vt.0.dylib`), so match by prefix.
fn newest_dylib_in(lib_dir: &Path) -> Option<PathBuf> {
    let preferred = lib_dir.join("libghostty-vt.dylib");
    if preferred.exists() {
        return Some(preferred);
    }
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(lib_dir).ok()?.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("libghostty-vt") && name.ends_with(".dylib") {
            let path = entry.path();
            if let Ok(modified) = fs::metadata(&path).and_then(|m| m.modified()) {
                if best.as_ref().is_none_or(|(t, _)| modified > *t) {
                    best = Some((modified, path));
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

fn io_error(message: &str) -> std::io::Error {
    std::io::Error::other(message)
}
