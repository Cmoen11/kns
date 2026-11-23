//! Clipboard for secrets (docs/plan-features.md §2.13): tokens, `.env` exports and connection
//! strings go to the clipboard from Rust only, marked so clipboard history and cloud sync skip
//! them, and are cleared after `clear_after` **only if the clipboard still holds what kns wrote**
//! (sha256 compare), so a later copy by the user survives.
//!
//! - Windows (`clipboard-win`): `CF_UNICODETEXT` plus the registered formats
//!   `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory` = 0 and
//!   `CanUploadToCloudClipboard` = 0.
//! - macOS (`NSPasteboard`): the string plus `org.nspasteboard.ConcealedType` and
//!   `org.nspasteboard.TransientType` (the nspasteboard.org convention clipboard managers honour).
//!   Compiled and tested in CI only (no Mac available).
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::ipc::{BackendError, Result};

/// What the write achieved; the UI says "kept out of clipboard history" only when `excluded`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Written {
    /// the history / cloud exclusion markers were set
    pub excluded: bool,
}

fn digest(text: &str) -> [u8; 32] {
    Sha256::digest(text.as_bytes()).into()
}

/// Writes `text` with the exclusion markers and schedules the conditional clear.
pub fn write_secret(text: &str, clear_after: Duration) -> Result<Written> {
    let written = platform::write(text)?;
    let want = digest(text);
    // One sleep per write, not an idle timer: it ends after `clear_after`.
    std::thread::spawn(move || {
        std::thread::sleep(clear_after);
        if platform::read().is_some_and(|now| digest(&now) == want) {
            let _ = platform::clear();
        }
    });
    Ok(written)
}

#[cfg(windows)]
mod platform {
    use clipboard_win::{Clipboard, options::NoClear, raw};

    use super::Written;
    use crate::ipc::{BackendError, Result};

    /// Registered clipboard formats that keep the entry out of Windows clipboard history,
    /// cloud clipboard and clipboard monitors. Any data works for the first; the others are DWORD 0.
    const MARKERS: [&str; 3] = ["ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory", "CanUploadToCloudClipboard"];

    fn err(what: &str, e: impl std::fmt::Display) -> BackendError {
        BackendError::new(0, "Clipboard", format!("{what}: {e}"))
    }

    pub fn write(text: &str) -> Result<Written> {
        let _open = Clipboard::new_attempts(10).map_err(|e| err("open clipboard", e))?;
        raw::empty().map_err(|e| err("empty clipboard", e))?;
        raw::set_string_with(text, NoClear).map_err(|e| err("set clipboard text", e))?;
        let mut excluded = true;
        for name in MARKERS {
            let set = raw::register_format(name).map(|format| raw::set_without_clear(format.get(), &0u32.to_le_bytes()).is_ok());
            excluded &= set == Some(true);
        }
        Ok(Written { excluded })
    }

    pub fn read() -> Option<String> {
        let _open = Clipboard::new_attempts(10).ok()?;
        let mut out = Vec::new();
        raw::get_string(&mut out).ok()?;
        String::from_utf8(out).ok()
    }

    pub fn clear() -> Result<()> {
        let _open = Clipboard::new_attempts(10).map_err(|e| err("open clipboard", e))?;
        raw::empty().map_err(|e| err("empty clipboard", e))
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    use super::Written;
    use crate::ipc::{BackendError, Result};

    const MARKERS: [&str; 2] = ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType"];

    pub fn write(text: &str) -> Result<Written> {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        // SAFETY: NSPasteboardTypeString is an immutable AppKit constant.
        let string_type = unsafe { NSPasteboardTypeString };
        if !pb.setString_forType(&NSString::from_str(text), string_type) {
            return Err(BackendError::new(0, "Clipboard", "the pasteboard refused the text"));
        }
        let mut excluded = true;
        for marker in MARKERS {
            excluded &= pb.setString_forType(&NSString::from_str(""), &NSString::from_str(marker));
        }
        Ok(Written { excluded })
    }

    pub fn read() -> Option<String> {
        let pb = NSPasteboard::generalPasteboard();
        // SAFETY: as above.
        pb.stringForType(unsafe { NSPasteboardTypeString }).map(|s| s.to_string())
    }

    pub fn clear() -> Result<()> {
        NSPasteboard::generalPasteboard().clearContents();
        Ok(())
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::Written;
    use crate::ipc::{BackendError, Result};

    pub fn write(_text: &str) -> Result<Written> {
        Err(BackendError::new(0, "Clipboard", "the secret clipboard is implemented for Windows and macOS only"))
    }
    pub fn read() -> Option<String> {
        None
    }
    pub fn clear() -> Result<()> {
        Ok(())
    }
}

/// `clear_after` from the setting (`clipboardClearSeconds`, default 60), bounded to 5 s .. 10 min.
pub fn clear_after(seconds: u64) -> Duration {
    Duration::from_secs(seconds.clamp(5, 600))
}

/// For callers that want to refuse empty secrets early.
pub fn check_not_empty(text: &str) -> Result<()> {
    if text.is_empty() { Err(BackendError::invalid("nothing to copy")) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_is_stable_and_distinct() {
        assert_eq!(digest("a"), digest("a"));
        assert_ne!(digest("a"), digest("b"));
    }

    #[test]
    fn clear_after_is_bounded() {
        assert_eq!(clear_after(0), Duration::from_secs(5));
        assert_eq!(clear_after(60), Duration::from_secs(60));
        assert_eq!(clear_after(100_000), Duration::from_secs(600));
    }

    #[test]
    fn empty_is_refused() {
        assert!(check_not_empty("").is_err());
        assert!(check_not_empty("x").is_ok());
    }
}
