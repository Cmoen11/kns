fn main() {
    let mut attributes = tauri_build::Attributes::new();
    // tauri-build embeds the Windows app manifest (Common Controls v6) into the app binary only.
    // tauri-plugin-dialog links comctl32 v6 entry points (TaskDialogIndirect), so test and example
    // binaries without that manifest die at load with STATUS_ENTRYPOINT_NOT_FOUND. Embed the same
    // manifest into every linked target instead.
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|e| e == "msvc");
    if std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "windows") && msvc {
        attributes = attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        println!("cargo:rustc-link-arg=/WX");
    }
    tauri_build::try_build(attributes).expect("tauri build");
}
