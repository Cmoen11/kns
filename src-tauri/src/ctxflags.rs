//! Context flags (`protected`, `readOnly`) as Rust sees them (docs/plan-features.md §5.4).
//!
//! The flags are edited in the UI and persisted by the webview through `save_state("settings")`
//! as the envelope `{schema, data: Settings}` (src/store/persist.ts), so they sit at
//! `data.contexts.<name>.{protected, readOnly}`. Rust reads that file at start and again whenever
//! `save_state("settings")` writes it. Until it has been read, or when it cannot be parsed, every
//! check is denied (`NotLoaded`). A missing file is a fresh install: loaded, no flags set.
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, RwLock},
};

use serde::{Deserialize, Serialize};

use crate::{
    ipc::{BackendError, Json, Result},
    state::AppState,
};

pub const SETTINGS_KEY: &str = "settings";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CtxFlags {
    pub protected: bool,
    pub read_only: bool,
}

/// `None` = not loaded yet or unparsable (deny).
#[derive(Default)]
pub struct CtxFlagsState(RwLock<Option<HashMap<String, CtxFlags>>>);

/// Flags per context from the persisted settings value, or `None` when its shape is wrong.
/// Unknown fields are ignored; a missing or non-boolean flag reads as `false`, as in
/// `sanitizeSettings`.
pub fn parse_settings(value: &Json) -> Option<HashMap<String, CtxFlags>> {
    let data = value.get("data")?;
    if !data.is_object() {
        return None;
    }
    let mut out = HashMap::new();
    match data.get("contexts") {
        None | Some(Json::Null) => {}
        Some(Json::Object(contexts)) => {
            for (name, flags) in contexts {
                let flag = |k: &str| flags.get(k).and_then(Json::as_bool).unwrap_or(false);
                out.insert(name.clone(), CtxFlags { protected: flag("protected"), read_only: flag("readOnly") });
            }
        }
        Some(_) => return None,
    }
    Some(out)
}

fn slot(state: &AppState) -> Arc<CtxFlagsState> {
    state.ext::<CtxFlagsState>()
}

/// Replaces the known flags and returns the contexts whose flags changed (proposal cancellation).
pub fn set(state: &AppState, flags: Option<HashMap<String, CtxFlags>>) -> Vec<String> {
    let slot = slot(state);
    let mut guard = slot.0.write().unwrap_or_else(|e| e.into_inner());
    let changed = match (guard.as_ref(), flags.as_ref()) {
        (Some(old), Some(new)) => {
            let mut names: Vec<String> = old.keys().chain(new.keys()).cloned().collect();
            names.sort();
            names.dedup();
            names.into_iter().filter(|n| old.get(n).copied().unwrap_or_default() != new.get(n).copied().unwrap_or_default()).collect()
        }
        _ => Vec::new(),
    };
    *guard = flags;
    changed
}

/// Reads `<config_dir>/settings.json` (missing = no flags; unreadable or unparsable = not loaded).
pub async fn load_from(config_dir: &Path) -> Option<HashMap<String, CtxFlags>> {
    match tokio::fs::read(config_dir.join(format!("{SETTINGS_KEY}.json"))).await {
        Ok(bytes) => serde_json::from_slice::<Json>(&bytes).ok().as_ref().and_then(parse_settings),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(HashMap::new()),
        Err(_) => None,
    }
}

/// Called by `save_state` after it wrote the settings file. Changing a context's flags cancels
/// that context's open proposals (§2.6).
pub fn on_settings_saved(state: &AppState, value: &Json) {
    let changed = set(state, parse_settings(value));
    for context in changed {
        crate::proposals::cancel_context(state, &context, "the context's protected/read-only flag changed");
    }
}

/// Effective flags of a context; `NotLoaded` until the settings were read.
pub fn effective(state: &AppState, context: &str) -> Result<CtxFlags> {
    let slot = slot(state);
    let guard = slot.0.read().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some(flags) => Ok(flags.get(context).copied().unwrap_or_default()),
        None => Err(BackendError::new(0, "NotLoaded", "kns has not read its settings yet; try again in a moment")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_the_persisted_envelope() {
        let v = json!({ "schema": 1, "data": { "theme": "gronn", "contexts": {
            "prod": { "protected": true, "readOnly": false },
            "ro": { "readOnly": true },
            "odd": { "protected": "yes" },
        } } });
        let flags = parse_settings(&v).unwrap();
        assert_eq!(flags["prod"], CtxFlags { protected: true, read_only: false });
        assert_eq!(flags["ro"], CtxFlags { protected: false, read_only: true });
        assert_eq!(flags["odd"], CtxFlags::default());
        assert_eq!(parse_settings(&json!({ "schema": 1, "data": {} })).unwrap().len(), 0);
    }

    #[test]
    fn unparsable_settings_deny() {
        let state = AppState::default();
        assert_eq!(effective(&state, "default").unwrap_err().reason, "NotLoaded");
        for bad in [json!(null), json!([]), json!({ "contexts": {} }), json!({ "data": [] }), json!({ "data": { "contexts": [] } })] {
            set(&state, parse_settings(&bad));
            assert_eq!(effective(&state, "default").unwrap_err().reason, "NotLoaded", "{bad}");
        }
        set(&state, parse_settings(&json!({ "data": { "contexts": { "default": { "readOnly": true } } } })));
        assert!(effective(&state, "default").unwrap().read_only);
        assert_eq!(effective(&state, "other").unwrap(), CtxFlags::default());
    }

    #[test]
    fn reports_changed_contexts() {
        let state = AppState::default();
        let mk = |p: bool| parse_settings(&json!({ "data": { "contexts": { "a": { "protected": p }, "b": {} } } }));
        assert!(set(&state, mk(false)).is_empty(), "first load changes nothing");
        assert!(set(&state, mk(false)).is_empty());
        assert_eq!(set(&state, mk(true)), vec!["a".to_string()]);
    }

    #[tokio::test]
    async fn missing_file_is_loaded_without_flags() {
        let dir = std::env::temp_dir().join(format!("kns-ctxflags-{}", std::process::id()));
        assert_eq!(load_from(&dir).await, Some(HashMap::new()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("settings.json"), b"{broken").unwrap();
        assert_eq!(load_from(&dir).await, None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
