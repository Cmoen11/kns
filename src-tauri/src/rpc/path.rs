//! Where the local socket lives. Std-only and `crate`-free: `kns-tui` compiles this file in
//! directly (`#[path]`), so client and server always agree on the path.
//!
//! - `KNS_SOCKET` when set (tests, a second instance in development).
//! - Linux: `$XDG_RUNTIME_DIR/kns.sock` when that is set.
//! - Else `<data_dir>/no.sixm.kns/kns.sock` (macOS: `~/Library/Application Support/no.sixm.kns/kns.sock`,
//!   Tauri's `app_data_dir`).
use std::path::PathBuf;

pub const IDENTIFIER: &str = "no.sixm.kns";
pub const FILE: &str = "kns.sock";
/// Bumped when a message shape changes incompatibly. The server sends it in its hello.
#[allow(dead_code)]
pub const PROTOCOL: u32 = 1;

/// Longest path a Unix socket address takes everywhere (`sun_path` is 104 bytes on macOS, 108 on Linux,
/// including the terminating NUL).
const MAX_LEN: usize = 100;

pub fn socket_path() -> Option<PathBuf> {
    preferred().map(shorten)
}

fn preferred() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("KNS_SOCKET").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    #[cfg(target_os = "linux")]
    if let Some(run) = std::env::var_os("XDG_RUNTIME_DIR").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(run).join(FILE));
    }
    dirs::data_dir().map(|d| d.join(IDENTIFIER).join(FILE))
}

/// A path too long for a socket address becomes `<temp_dir>/kns-<hash of the path>.sock`
/// (`$TMPDIR` is private to the user on macOS; the server also checks the peer's uid).
fn shorten(p: PathBuf) -> PathBuf {
    if p.as_os_str().len() <= MAX_LEN {
        return p;
    }
    // FNV-1a: stable across builds and processes, unlike `DefaultHasher`
    let hash = p.as_os_str().as_encoded_bytes().iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3));
    let short = std::env::temp_dir().join(format!("kns-{:012x}.sock", hash & 0xffff_ffff_ffff));
    if short.as_os_str().len() <= MAX_LEN { short } else { PathBuf::from(format!("/tmp/kns-{:012x}.sock", hash & 0xffff_ffff_ffff)) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_paths_get_a_short_stable_name() {
        let long = PathBuf::from(format!("/{}/kns.sock", "x".repeat(120)));
        let a = shorten(long.clone());
        assert_eq!(a, shorten(long));
        assert!(a.as_os_str().len() <= MAX_LEN);
        assert_ne!(a, shorten(PathBuf::from(format!("/{}/kns.sock", "y".repeat(120)))));
        assert_eq!(shorten(PathBuf::from("/a/kns.sock")), PathBuf::from("/a/kns.sock"));
    }
}
