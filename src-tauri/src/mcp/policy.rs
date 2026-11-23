//! Agent policy per context (docs/plan-features.md §5.4). Pure functions: the inputs (stored
//! policy, context flags, "connected") are passed in, so the whole matrix is unit-tested.
//!
//! - Stored policy: `off | read | propose` (default `off`) plus an optional namespace allowlist,
//!   set only from the kns UI (`mcp_policy_set`).
//! - Effective policy, recomputed on every call: read-only caps at `read`; flags not loaded yet
//!   deny everything.
//! - Agents may only use contexts the human connected in this session: kns never builds a session
//!   (exec credential plugins, SSO) because an agent asked.
use serde::{Deserialize, Serialize};

use super::McpError;
use crate::{ctxflags::CtxFlags, ipc::McpPolicy};

/// What `rust/mcp.json` stores for one context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPolicy {
    pub policy: McpPolicy,
    /// `None` = every namespace
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespaces: Option<Vec<String>>,
}

impl Default for StoredPolicy {
    fn default() -> Self {
        Self { policy: McpPolicy::Off, namespaces: None }
    }
}

/// `min(stored, flags)`: a read-only context caps at `read`. `flags = None` (not loaded) → `None`.
pub fn effective(stored: McpPolicy, flags: Option<CtxFlags>) -> Option<McpPolicy> {
    let flags = flags?;
    Some(if flags.read_only { stored.min(McpPolicy::Read) } else { stored })
}

/// What a tool needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Need {
    Read,
    Propose,
}

/// Everything the access check reads about one context.
#[derive(Debug, Clone, Copy)]
pub struct Access<'a> {
    pub context: &'a str,
    pub stored: McpPolicy,
    /// `None` while kns has not read its settings
    pub flags: Option<CtxFlags>,
    /// the human connected this context in this session
    pub connected: bool,
}

/// Allows the call or says why not, with a hint naming what the human can do.
pub fn check(a: &Access<'_>, need: Need) -> Result<McpPolicy, McpError> {
    let Some(policy) = effective(a.stored, a.flags) else {
        return Err(McpError::new("NotLoaded", "kns has not read its settings yet").hint("try again in a few seconds"));
    };
    let ctx = a.context;
    if policy == McpPolicy::Off {
        return Err(McpError::new("PolicyDenied", format!("agents may not use context \"{ctx}\""))
            .hint(format!("ask the human to run \":mcp policy read {ctx}\" in kns (or \":mcp setup\")")));
    }
    if need == Need::Propose && policy != McpPolicy::Propose {
        let why = if a.flags.is_some_and(|f| f.read_only) { " (the context is read-only in kns)" } else { "" };
        return Err(McpError::new("PolicyDenied", format!("context \"{ctx}\" allows reading only{why}"))
            .hint(format!("ask the human to run \":mcp policy propose {ctx}\" in kns")));
    }
    if !a.connected {
        return Err(McpError::new("NotConnected", format!("kns is not connected to context \"{ctx}\""))
            .hint(format!("ask the human to open \"{ctx}\" in kns; kns never logs in because an agent asked")));
    }
    Ok(policy)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OFF: McpPolicy = McpPolicy::Off;
    const READ: McpPolicy = McpPolicy::Read;
    const PROPOSE: McpPolicy = McpPolicy::Propose;

    fn flags(protected: bool, read_only: bool) -> Option<CtxFlags> {
        Some(CtxFlags { protected, read_only })
    }

    #[test]
    fn effective_caps_read_only_and_denies_unloaded() {
        assert_eq!(effective(PROPOSE, flags(false, false)), Some(PROPOSE));
        assert_eq!(effective(PROPOSE, flags(true, false)), Some(PROPOSE), "protected does not lower the policy");
        assert_eq!(effective(PROPOSE, flags(false, true)), Some(READ));
        assert_eq!(effective(READ, flags(false, true)), Some(READ));
        assert_eq!(effective(OFF, flags(false, true)), Some(OFF));
        assert_eq!(effective(PROPOSE, None), None);
    }

    /// off/read/propose × protected/read-only × connected × need.
    #[test]
    fn matrix() {
        for stored in [OFF, READ, PROPOSE] {
            for protected in [false, true] {
                for read_only in [false, true] {
                    for connected in [false, true] {
                        for need in [Need::Read, Need::Propose] {
                            let a = Access { context: "c", stored, flags: flags(protected, read_only), connected };
                            let eff = effective(stored, a.flags).unwrap();
                            let got = check(&a, need);
                            let want_ok = eff != OFF && (need == Need::Read || eff == PROPOSE) && connected;
                            assert_eq!(got.is_ok(), want_ok, "{stored:?} p={protected} ro={read_only} conn={connected} {need:?}");
                            if let Err(e) = got {
                                assert!(!e.hint.as_deref().unwrap_or_default().is_empty(), "every denial has a hint");
                                let code = if eff == OFF || (need == Need::Propose && eff != PROPOSE) { "PolicyDenied" } else { "NotConnected" };
                                assert_eq!(e.code, code);
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn unloaded_flags_deny() {
        let a = Access { context: "c", stored: PROPOSE, flags: None, connected: true };
        assert_eq!(check(&a, Need::Read).unwrap_err().code, "NotLoaded");
    }

    #[test]
    fn hints_name_the_command() {
        let a = Access { context: "default", stored: READ, flags: flags(false, false), connected: true };
        let e = check(&a, Need::Propose).unwrap_err();
        assert!(e.hint.unwrap().contains(":mcp policy propose default"));
    }
}
