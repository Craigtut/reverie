// The FluidAudio Swift bridge (pulled in by the `asr` feature) uses Swift
// Concurrency, so the linked binary references `@rpath/libswift_Concurrency.dylib`
// (and friends). Those runtime libraries live in the OS Swift runtime directory
// `/usr/lib/swift` (present in the dyld shared cache even though the physical
// files are not on disk on recent macOS). Without an rpath pointing there, the
// loader cannot resolve them and the process aborts at launch. Add the standard
// rpath so test/bin targets of this crate load. Only needed with the Swift
// (`asr`) feature, on macOS. `cargo:rustc-link-arg` applies to this package's own
// binaries/tests; the desktop app adds the same rpath in its build script.
fn main() {
    let asr_enabled = std::env::var_os("CARGO_FEATURE_ASR").is_some();
    let is_macos = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos");
    if asr_enabled && is_macos {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
}
