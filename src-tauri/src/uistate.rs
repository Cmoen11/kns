//! What the human is looking at, published by the webview for MCP `get_selection` (H1).
//! Rust only stores it; H1 passes it through the scope filter and the Redactor before an agent sees it.
use std::sync::Mutex;

use crate::{
    ipc::UiState,
    state::{AppState, lock},
};

#[derive(Default)]
pub struct UiStateSlot(Mutex<UiState>);

/// Cap on marked refs kept (the UI can mark thousands of rows).
const MAX_MARKED: usize = 200;

pub fn publish(state: &AppState, mut ui: UiState) {
    ui.marked.truncate(MAX_MARKED);
    *lock(&state.ext::<UiStateSlot>().0) = ui;
}

pub fn current(state: &AppState) -> UiState {
    lock(&state.ext::<UiStateSlot>().0).clone()
}

pub mod cmd {
    use super::AppState;
    use crate::ipc::{Result, UiState};

    #[tauri::command]
    pub fn publish_ui_state(app_state: tauri::State<'_, AppState>, state: UiState) -> Result<()> {
        super::publish(&app_state, state);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{Gvr, ObjRef};

    #[test]
    fn stores_the_last_state_and_caps_marks() {
        let state = AppState::default();
        assert_eq!(current(&state), UiState::default());
        let r = ObjRef { context: "default".into(), gvr: Gvr::new("", "v1", "pods"), namespace: Some("default".into()), name: "web".into() };
        publish(&state, UiState { context: Some("default".into()), marked: vec![r; 500], ..Default::default() });
        let now = current(&state);
        assert_eq!(now.context.as_deref(), Some("default"));
        assert_eq!(now.marked.len(), MAX_MARKED);
    }
}
