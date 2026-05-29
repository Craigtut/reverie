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
        }
    }

    tauri_build::build();
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

fn io_error(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, message)
}
