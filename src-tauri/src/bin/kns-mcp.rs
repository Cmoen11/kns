//! `kns-mcp`: the stdio shim for MCP clients that cannot speak HTTP (docs/plan-features.md §5.9).
//!
//! A console program (no `windows_subsystem`), so a client gets real stdin/stdout; starting
//! `kns.exe` itself would open the whole app. It talks to the running app over loopback HTTP and
//! never opens a cluster connection. The logic lives in `src/mcp/shim.rs`, compiled in here
//! directly so this binary links no Tauri or Kubernetes code. `tauri build` bundles every
//! `src/bin` binary next to the app (Windows: the install folder; macOS: `kns.app/Contents/MacOS`).
#[path = "../mcp/shim.rs"]
mod shim;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(shim::run(&args));
}
