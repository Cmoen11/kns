//! Auto-update (docs/auto-update.md). Checks the release feed 30 s after start and every 6 hours,
//! downloads a newer version in the background (the plugin verifies it against the minisign
//! public key in tauri.conf.json), and installs it only on `update_install`: kns holds
//! port-forwards, shells and the MCP server, so it never restarts on its own.
//!
//! The updater plugin is used from Rust only, like dialog/opener/notification: the window gets no
//! updater permission and the CSP is unchanged.
use std::{sync::Mutex, time::Duration};

use jiff::Timestamp;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{
    events,
    ipc::{BackendError, BackendEvent, Result, UpdateState, UpdateStatus},
    state::{AppState, lock},
};

const FIRST_CHECK: Duration = Duration::from_secs(30);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Default)]
pub struct UpdateSlot(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    status: UpdateStatus,
    /// the downloaded, verified bundle waiting for `install`
    pending: Option<(Update, Vec<u8>)>,
}

/// Why this build does not update itself, or None when it does.
fn disabled_reason(app: &tauri::AppHandle) -> Option<String> {
    if cfg!(debug_assertions) {
        return Some("development build".into());
    }
    if std::env::var_os("KNS_NO_UPDATE").is_some_and(|v| !v.is_empty()) {
        return Some("turned off by KNS_NO_UPDATE".into());
    }
    let pubkey = app.config().plugins.0.get("updater").and_then(|u| u.get("pubkey")).and_then(|k| k.as_str()).unwrap_or("");
    if pubkey.trim().is_empty() {
        return Some("this build has no update key".into());
    }
    None
}

/// Percent of `total`, when the size is known.
fn percent(done: u64, total: Option<u64>) -> Option<u8> {
    match total {
        Some(t) if t > 0 => Some((done.saturating_mul(100) / t).min(100) as u8),
        _ => None,
    }
}

fn now() -> String {
    Timestamp::now().strftime("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// Changes the status and tells the UI.
fn change(state: &AppState, f: impl FnOnce(&mut Inner)) {
    let status = {
        let slot = state.ext::<UpdateSlot>();
        let mut inner = lock(&slot.0);
        f(&mut inner);
        inner.status.clone()
    };
    events::emit(state, BackendEvent::Update { status });
}

pub fn status(state: &AppState) -> UpdateStatus {
    lock(&state.ext::<UpdateSlot>().0).status.clone()
}

/// Sets the first status and, unless updates are off for this build, starts the check loop.
pub fn start(state: &AppState) {
    let Some(app) = state.app() else { return };
    let current = app.package_info().version.to_string();
    let reason = disabled_reason(app);
    let on = reason.is_none();
    change(state, |i| {
        i.status = UpdateStatus {
            state: if on { UpdateState::Idle } else { UpdateState::Disabled },
            current,
            message: reason,
            ..Default::default()
        };
    });
    if !on {
        return;
    }
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            let _ = check(&state).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// Checks the feed and downloads a newer version. Network and feed errors end in the `error`
/// state (returned, not raised): the next scheduled check tries again.
pub async fn check(state: &AppState) -> Result<UpdateStatus> {
    {
        let slot = state.ext::<UpdateSlot>();
        let inner = lock(&slot.0);
        match inner.status.state {
            UpdateState::Disabled => {
                let why = inner.status.message.clone().unwrap_or_else(|| "updates are off".into());
                return Err(BackendError::invalid(format!("kns does not update itself: {why}")));
            }
            UpdateState::Checking | UpdateState::Downloading | UpdateState::Installing => return Ok(inner.status.clone()),
            _ => {}
        }
    }
    let app = state.app().cloned().ok_or_else(|| BackendError::internal("no app"))?;
    change(state, |i| {
        i.status.state = UpdateState::Checking;
        i.status.message = None;
    });

    let found = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    let update = match found {
        Err(e) => {
            change(state, |i| {
                i.status.state = UpdateState::Error;
                i.status.message = Some(e.to_string());
                i.status.checked_at = Some(now());
            });
            return Ok(status(state));
        }
        Ok(None) => {
            change(state, |i| {
                i.status = UpdateStatus { state: UpdateState::Idle, current: i.status.current.clone(), checked_at: Some(now()), ..Default::default() };
                i.pending = None;
            });
            return Ok(status(state));
        }
        Ok(Some(u)) => u,
    };

    // already downloaded at an earlier check
    let have = lock(&state.ext::<UpdateSlot>().0).pending.as_ref().is_some_and(|(p, _)| p.version == update.version);
    if have {
        change(state, |i| {
            i.status.state = UpdateState::Ready;
            i.status.checked_at = Some(now());
        });
        return Ok(status(state));
    }

    let (version, notes) = (update.version.clone(), update.body.clone());
    change(state, |i| {
        i.status.state = UpdateState::Downloading;
        i.status.version = Some(version);
        i.status.notes = notes;
        i.status.progress = Some(0);
        i.pending = None;
    });
    let mut done: u64 = 0;
    let mut last: Option<u8> = Some(0);
    let progress_state = state.clone();
    let downloaded = update
        .download(
            |chunk, total| {
                done += chunk as u64;
                let pct = percent(done, total);
                if pct != last {
                    last = pct;
                    change(&progress_state, |i| i.status.progress = pct);
                }
            },
            || {},
        )
        .await;
    match downloaded {
        Ok(bytes) => change(state, |i| {
            i.status.state = UpdateState::Ready;
            i.status.progress = None;
            i.status.checked_at = Some(now());
            i.pending = Some((update, bytes));
        }),
        Err(e) => change(state, |i| {
            i.status.state = UpdateState::Error;
            i.status.progress = None;
            i.status.message = Some(format!("download failed: {e}"));
            i.status.checked_at = Some(now());
        }),
    }
    Ok(status(state))
}

/// Installs the downloaded version and restarts. On Windows the NSIS installer takes over and the
/// process exits inside `install`; on macOS the bundle is replaced and kns restarts here.
pub async fn install(state: &AppState) -> Result<()> {
    let pending = {
        let slot = state.ext::<UpdateSlot>();
        let mut inner = lock(&slot.0);
        if inner.status.state != UpdateState::Ready {
            return Err(BackendError::invalid("no update is ready to install"));
        }
        inner.pending.take()
    };
    let Some((update, bytes)) = pending else {
        return Err(BackendError::invalid("no update is ready to install"));
    };
    let app = state.app().cloned().ok_or_else(|| BackendError::internal("no app"))?;
    change(state, |i| i.status.state = UpdateState::Installing);
    let installed = tauri::async_runtime::spawn_blocking(move || update.install(&bytes)).await;
    match installed {
        Ok(Ok(())) => app.restart(),
        Ok(Err(e)) => {
            let message = format!("install failed: {e}");
            change(state, |i| {
                i.status.state = UpdateState::Error;
                i.status.message = Some(message.clone());
            });
            Err(BackendError::internal(message))
        }
        Err(e) => {
            let message = format!("install failed: {e}");
            change(state, |i| {
                i.status.state = UpdateState::Error;
                i.status.message = Some(message.clone());
            });
            Err(BackendError::internal(message))
        }
    }
}

pub mod cmd {
    use crate::{
        ipc::{Result, UpdateStatus},
        state::AppState,
    };

    #[tauri::command]
    pub fn update_status(state: tauri::State<'_, AppState>) -> UpdateStatus {
        super::status(&state)
    }

    #[tauri::command]
    pub async fn update_check(state: tauri::State<'_, AppState>) -> Result<UpdateStatus> {
        super::check(&state).await
    }

    #[tauri::command]
    pub async fn update_install(state: tauri::State<'_, AppState>) -> Result<()> {
        super::install(&state).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_needs_a_known_size() {
        assert_eq!(percent(50, Some(200)), Some(25));
        assert_eq!(percent(300, Some(200)), Some(100));
        assert_eq!(percent(50, None), None);
        assert_eq!(percent(50, Some(0)), None);
    }

    #[tokio::test]
    async fn disabled_until_started_and_nothing_to_install() {
        let state = AppState::default();
        assert_eq!(status(&state).state, UpdateState::Disabled);
        assert!(check(&state).await.is_err());
        assert!(install(&state).await.is_err());
    }
}
