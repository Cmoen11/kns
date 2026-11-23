//! MCP resources (docs/plan-features.md §5.3): `kns://selection`, `kns://devset/<id>`,
//! `kns://bundle/<id>`, `kns://pack/<id>`. Read-only, redacted, through the same policy and
//! scope checks as the tools, and audited like a tool call (`resources/read`).
//!
//! Bundles come from C2 (`trap::bundle_for_agent`), packs from G (`pack::get`, kept 10 minutes);
//! both were redacted when they were built and are cleaned and redacted again here.
use std::time::Instant;

use rmcp::model::{Resource, ResourceTemplate};
use serde_json::json;

use super::{
    McpError,
    policy::Need,
    tools::{self, Reply},
};
use crate::{ipc::{AuditOutcome, Json}, redact::{Redactor, clean_untrusted}, state::AppState};

pub const SELECTION: &str = "kns://selection";
const DEVSET: &str = "kns://devset/";
const BUNDLE: &str = "kns://bundle/";
const PACK: &str = "kns://pack/";

/// The concrete resources the client may read now: the selection and every visible dev set.
pub async fn list(state: &AppState, client: &str) -> Vec<Resource> {
    let mut out = vec![Resource::new(SELECTION, "selection")
        .with_title("What the human is looking at in kns")
        .with_description("Same as the get_selection tool: context, focused pane, cursor object and marked objects.")
        .with_mime_type("application/json")];
    for set in crate::devset::list(state, None).await.unwrap_or_default() {
        if tools::propose::visible_set(state, client, &set).is_some() {
            out.push(
                Resource::new(format!("{DEVSET}{}", set.id), format!("devset {}", clean_untrusted(&set.name, 60)))
                    .with_description("A saved dev set: forwards, rewrites, env spec, origin and approval.")
                    .with_mime_type("application/json"),
            );
        }
    }
    out
}

pub fn templates() -> Vec<ResourceTemplate> {
    vec![
        ResourceTemplate::new(format!("{DEVSET}{{id}}"), "devset").with_description("A saved dev set by id (list_dev_sets).").with_mime_type("application/json"),
        ResourceTemplate::new(format!("{BUNDLE}{{id}}"), "bundle").with_description("An incident bundle captured by a trap (list_bundles).").with_mime_type("text/markdown"),
        ResourceTemplate::new(format!("{PACK}{{id}}"), "pack").with_description("A context pack made with make_pack.").with_mime_type("text/markdown"),
    ]
}

/// Reads one resource as JSON text; audited like a tool call.
pub async fn read(state: &AppState, client: &str, uri: &str) -> Result<String, McpError> {
    let started = Instant::now();
    let mut r = Redactor::new();
    let result = read_inner(state, client, uri, &mut r).await.and_then(|reply| tools::envelope(reply, &r));
    let (bytes, outcome) = match &result {
        Ok(v) => (v.to_string().len() as u64, AuditOutcome::Ok),
        Err(e) => (json!(e).to_string().len() as u64, if matches!(e.code.as_str(), "PolicyDenied" | "NotConnected" | "NotLoaded") { AuditOutcome::Denied } else { AuditOutcome::Error }),
    };
    let args = json!({ "uri": clean_untrusted(uri, 200) });
    super::record_call(
        state,
        super::CallRecord { client, tool: "resources/read", args: &args, result_bytes: bytes, redactions: r.count, outcome, proposal_id: None, ms: started.elapsed().as_millis() as u64 },
    );
    result.map(|v| v.to_string())
}

async fn read_inner(state: &AppState, client: &str, uri: &str, r: &mut Redactor) -> Result<Reply, McpError> {
    if uri == SELECTION {
        return tools::read::get_selection(state);
    }
    // ids: the policy is checked before anything is read (`access_any`), and a missing id answers
    // exactly like one in a context or namespace the client may not read (§6.6)
    if let Some(id) = uri.strip_prefix(DEVSET) {
        tools::access_any(state, Need::Read)?;
        let hidden = || tools::not_visible("dev set", id, tools::propose::SET_HINT);
        let set = crate::devset::get(state, id).await.map_err(|e| tools::from_backend(e, r))?.ok_or_else(hidden)?;
        // policy and scope: the set's context must allow reading, every namespace it reaches visible
        let mut v: Json = tools::propose::visible_set(state, client, &set).ok_or_else(hidden)?;
        tools::propose::scrub_set(r, &mut v);
        return Ok(Reply::new(v, &["name"]));
    }
    if let Some(id) = uri.strip_prefix(BUNDLE) {
        tools::access_any(state, Need::Read)?;
        let hidden = || tools::not_visible("bundle", id, "list_bundles lists the ids you may read");
        // C2: the markdown was redacted when it was written; the scope filter uses its index entry
        let (meta, markdown) = crate::trap::bundle_for_agent(state, id).await.map_err(|_| hidden())?;
        let cx = tools::access(state, Some(&meta.context), Need::Read).map_err(|_| hidden())?;
        cx.scope.check(&cx.context, meta.namespace.as_deref(), true).map_err(|_| hidden())?;
        let markdown = tools::text(r, &markdown);
        return Ok(Reply::new(json!({ "id": meta.id, "context": meta.context, "markdown": markdown }), &["markdown"]));
    }
    if let Some(id) = uri.strip_prefix(PACK) {
        tools::access_any(state, Need::Read)?;
        let hidden = || tools::not_visible("pack", id, "packs are kept 10 minutes; make a new one with make_pack");
        // G: packs live 10 minutes in memory; every object of the pack must be visible
        let stored = crate::pack::get(state, id).ok_or_else(hidden)?;
        let cx = tools::access(state, Some(&stored.context), Need::Read).map_err(|_| hidden())?;
        for ns in &stored.namespaces {
            cx.scope.check(&cx.context, ns.as_deref(), ns.is_some()).map_err(|_| hidden())?;
        }
        let markdown = tools::text(r, &stored.pack.markdown);
        return Ok(Reply::new(json!({ "id": stored.pack.id, "context": stored.context, "markdown": markdown }), &["markdown"]));
    }
    Err(McpError::new("NotFound", format!("unknown resource \"{}\"", clean_untrusted(uri, 120))).hint("resources/list names the readable ones"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ipc::{McpPolicy, UiState}, mcp};

    #[tokio::test]
    async fn selection_resource_is_scoped_and_audited() {
        let (state, base) = mcp::testing::state("res-sel").await;
        crate::uistate::publish(&state, UiState { context: Some("default".into()), connected: vec!["default".into()], ..Default::default() });
        assert_eq!(read(&state, "claude-code", SELECTION).await.unwrap_err().code, "PolicyDenied");
        mcp::policy_set(&state, "default", McpPolicy::Read, None).await.unwrap();
        let text = read(&state, "claude-code", SELECTION).await.unwrap();
        let v: Json = serde_json::from_str(&text).unwrap();
        assert_eq!(v["context"], "default");
        assert!(v["redactions"].is_object());
        assert!(read(&state, "claude-code", "kns://bundle/b1").await.is_err());
        assert_eq!(read(&state, "claude-code", "kns://pack/nope").await.unwrap_err().code, "NotFound");
        assert_eq!(read(&state, "claude-code", "file:///etc/passwd").await.unwrap_err().code, "NotFound");
        let rows = mcp::audit_tail(&state, 10).await.unwrap();
        assert!(rows.iter().all(|r| r.tool == "resources/read" || r.tool == "policy"));
        assert!(rows.iter().any(|r| r.outcome == AuditOutcome::Denied));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn templates_name_every_scheme() {
        let t: Vec<String> = templates().into_iter().map(|t| t.uri_template).collect();
        assert_eq!(t, vec!["kns://devset/{id}", "kns://bundle/{id}", "kns://pack/{id}"]);
    }
}
