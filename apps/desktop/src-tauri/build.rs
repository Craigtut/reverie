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
    }

    // Stage the Ghostty dynamic library to a stable path that
    // `tauri.conf.json > bundle > macOS.frameworks` references, so the bundler
    // copies it into `Contents/Frameworks/` and signs it.
    //
    // This is done here, in build.rs, on purpose: `tauri_build::build()` below
    // validates that the configured framework files exist, and that check runs
    // at compile time, before any bundle phase (so a `beforeBundleCommand` would
    // be too late). By the time this runs, our `libghostty-vt-sys` dependency has
    // already produced the dylib in the Cargo build output, so we can copy it.
    if target_os == "macos" {
        if let Err(err) = stage_ghostty_dylib() {
            println!("cargo:warning=failed to stage libghostty-vt.dylib for bundling: {err}");
            // `tauri_build::build()` validates bundle.macOS.frameworks at COMPILE
            // time, so the file must exist even for `cargo check`/clippy/test on a
            // clean checkout where the dylib has not been built yet (otherwise the
            // build script fails hard). Stage an empty placeholder, the same way the
            // reverie-bridge externalBin handling does; a real bundling build
            // rebuilds the dylib and overwrites it with real bytes.
            if let Err(err) = ensure_ghostty_framework_placeholder() {
                println!("cargo:warning=failed to stage libghostty-vt.dylib placeholder: {err}");
            }
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

/// Copy the freshest built `libghostty-vt.dylib` (resolving its symlink chain to
/// real bytes) into `<crate>/frameworks/libghostty-vt.dylib`.
fn stage_ghostty_dylib() -> std::io::Result<()> {
    const LIB_NAME: &str = "libghostty-vt.dylib";

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
        let candidate = entry.path().join("out/ghostty-install/lib").join(LIB_NAME);
        if let Ok(modified) = fs::metadata(&candidate).and_then(|m| m.modified()) {
            if newest.as_ref().is_none_or(|(t, _)| modified > *t) {
                newest = Some((modified, candidate));
            }
        }
    }

    let source = newest
        .map(|(_, path)| path)
        .ok_or_else(|| io_error("built libghostty-vt.dylib not found in Cargo build output"))?;
    let real = fs::canonicalize(&source)?;

    let dest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("frameworks");
    fs::create_dir_all(&dest_dir)?;
    fs::copy(&real, dest_dir.join(LIB_NAME))?;

    println!("cargo:rerun-if-changed={}", source.display());
    Ok(())
}

/// Ensure `frameworks/libghostty-vt.dylib` exists so Tauri's compile-time
/// `frameworks` validation passes even when the real dylib has not been built
/// yet (e.g. `cargo check`/clippy/test on a clean checkout). A real bundling
/// build stages the actual dylib and overwrites this placeholder.
fn ensure_ghostty_framework_placeholder() -> std::io::Result<()> {
    const LIB_NAME: &str = "libghostty-vt.dylib";
    let dest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("frameworks");
    fs::create_dir_all(&dest_dir)?;
    let dest = dest_dir.join(LIB_NAME);
    // Keep a real (non-empty) dylib if one is already staged.
    if fs::metadata(&dest).map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(());
    }
    fs::write(&dest, b"")?;
    Ok(())
}

fn io_error(message: &str) -> std::io::Error {
    std::io::Error::other(message)
}
