//! Backend -> UI events (docs/plan-features.md §2.2): one Tauri event, `kns://event`, carrying a
//! `BackendEvent`. Events are hints: the UI re-lists on boot and on each event, so a lost event
//! (page reload, no window) costs nothing.
use tauri::Emitter;

use crate::{ipc::BackendEvent, state::AppState};

pub const EVENT: &str = "kns://event";

/// Sends `event` to the webview and to attached socket clients (rpc.rs). A no-op before `setup` ran (tests, examples) or without a window.
pub fn emit(state: &AppState, event: BackendEvent) {
    crate::rpc::broadcast(state, &event);
    if let Some(app) = state.app() {
        let _ = app.emit(EVENT, event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emit_without_app_is_a_no_op() {
        emit(&AppState::default(), BackendEvent::Forwards);
    }

    #[test]
    fn event_name_matches_the_ts_contract() {
        let ts = include_str!("../../src/ipc/contract/events.ts");
        assert!(ts.contains(&format!("BACKEND_EVENT = \"{EVENT}\"")));
    }
}
