//! Tool dispatch (docs/plan-features.md §5.3): argument parsing, the policy check, the scope
//! filter, redaction, output caps, the result envelope and the audit line live here, once, so a
//! tool body only fetches and shapes.
//!
//! Every successful result is a JSON object (`structuredContent`, and the same JSON as the text
//! block) carrying `untrusted` (the fields holding cluster text) and `redactions`
//! (`{count, byRule}`). Errors are tool errors (`isError: true`) with `{error: {code, message, hint}}`.
pub mod propose;
pub mod read;
pub mod shape;

use std::time::Instant;

use rmcp::model::{CallToolResult, ContentBlock};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::{McpError, describe, policy, scope::Scope};
use crate::{
    ipc::{ApiResource, AuditOutcome, BackendError, Json, McpPolicy, ObjRef},
    redact::{MAX_LINE, Redactor, clean_untrusted},
    state::AppState,
};

/// Per-result byte cap (§5.2).
pub const MAX_RESULT: usize = 256 * 1024;

/// What a tool body returns: its data object and the fields of it that hold cluster text.
#[derive(Debug)]
pub struct Reply {
    pub data: Json,
    pub untrusted: Vec<&'static str>,
    /// the proposal this call created (audit line)
    pub proposal_id: Option<String>,
}

impl Reply {
    pub fn new(data: Json, untrusted: &[&'static str]) -> Self {
        Self { data, untrusted: untrusted.to_vec(), proposal_id: None }
    }
}

/// A tool call's outcome before it becomes an MCP result.
pub struct Outcome {
    pub result: Result<Json, McpError>,
    pub redactions: u32,
}

impl From<Outcome> for rmcp::model::CallToolResponse {
    fn from(o: Outcome) -> Self {
        let r = match o.result {
            Ok(data) => {
                let mut r = CallToolResult::success(vec![ContentBlock::text(data.to_string())]);
                r.structured_content = Some(data);
                r
            }
            Err(e) => {
                let body = json!({ "error": e });
                let mut r = CallToolResult::error(vec![ContentBlock::text(body.to_string())]);
                r.structured_content = Some(body);
                r
            }
        };
        r.into()
    }
}

/// Maps a backend error to what an agent sees. API errors echo cluster text, so the message is
/// cleaned and redacted; packages not built yet answer `NotAvailableYet`.
pub fn from_backend(e: BackendError, r: &mut Redactor) -> McpError {
    let message = r.text(&clean_untrusted(&e.message, 1024));
    match (e.reason.as_str(), e.code) {
        ("NotImplemented", _) => McpError::new("NotAvailableYet", format!("this kns build cannot do that yet ({message})"))
            .hint("use another tool, or ask the human to look in kns"),
        (_, 403) | ("Forbidden", _) => McpError::new("Forbidden", message).hint("the human's own Kubernetes permissions do not allow this"),
        (_, 404) | ("NotFound", _) => McpError::new("NotFound", message).hint("check the name and namespace with list_resources"),
        ("NotLoaded", _) => McpError::new("NotLoaded", message).hint("try again in a few seconds"),
        (reason, _) => McpError::new(if reason.is_empty() { "Error" } else { reason }, message),
    }
}

/// Parses tool arguments; unknown fields and wrong types are `Invalid` with serde's message.
pub fn parse<T: DeserializeOwned>(args: &Json) -> Result<T, McpError> {
    serde_json::from_value(args.clone()).map_err(|e| McpError::new("Invalid", format!("bad arguments: {e}")).hint("see the tool's input schema"))
}

/// Runs one tool for `client` and writes the audit line.
pub async fn call(state: &AppState, client: &str, name: &str, args: Json) -> Outcome {
    let started = Instant::now();
    let mut redactor = Redactor::new();
    let result = match describe::find(name) {
        None => Err(McpError::new("Invalid", format!("unknown tool \"{}\"", clean_untrusted(name, 80))).hint("call tools/list")),
        Some(def) if propose::handles(def.name) => propose::run(state, client, def.name, &args, &mut redactor).await,
        Some(def) => read::run(state, client, def.name, &args, &mut redactor).await,
    };
    let proposal_id = result.as_ref().ok().and_then(|r| r.proposal_id.clone());
    let (result, outcome) = match result {
        Ok(reply) => match envelope(reply, &redactor) {
            Ok(v) => (Ok(v), AuditOutcome::Ok),
            Err(e) => (Err(e), AuditOutcome::Error),
        },
        Err(e) => {
            let outcome = if matches!(e.code.as_str(), "PolicyDenied" | "NotConnected" | "NotLoaded" | "Forbidden") { AuditOutcome::Denied } else { AuditOutcome::Error };
            (Err(e), outcome)
        }
    };
    let bytes = match &result {
        Ok(v) => v.to_string().len(),
        Err(e) => json!(e).to_string().len(),
    } as u64;
    let redactions = redactor.count;
    // an unknown name is the agent's own text: cleaned and capped before the audit file, the
    // `agentActivity` event and the Agents view show it
    let tool = describe::find(name).map_or_else(|| clean_untrusted(name, 80), |d| d.name.to_string());
    super::record_call(
        state,
        super::CallRecord { client, tool: &tool, args: &args, result_bytes: bytes, redactions, outcome, proposal_id, ms: started.elapsed().as_millis() as u64 },
    );
    Outcome { result, redactions }
}

/// Adds `untrusted` and `redactions` and enforces the size cap.
pub(crate) fn envelope(reply: Reply, r: &Redactor) -> Result<Json, McpError> {
    let mut data = match reply.data {
        Value::Object(m) => Value::Object(m),
        other => json!({ "value": other }),
    };
    data["untrusted"] = json!(reply.untrusted);
    data["redactions"] = serde_json::to_value(r.report()).unwrap_or(Value::Null);
    if data.to_string().len() > MAX_RESULT {
        return Err(McpError::new("TooLarge", format!("the result is over {} KiB", MAX_RESULT / 1024))
            .hint("narrow it: a namespace, a label selector, a smaller limit or tail"));
    }
    Ok(data)
}

/// Cleans (control/ANSI/bidi/zero-width, 4 KiB per line) and redacts every string leaf. A leaf
/// under a secret-looking key is masked; others go through the text patterns.
pub fn scrub(r: &mut Redactor, v: &mut Json) {
    match v {
        Value::Object(map) => {
            for (k, child) in map.iter_mut() {
                match child {
                    Value::String(s) => *s = r.env_value(k, &clean_untrusted(s, MAX_LINE)),
                    _ => scrub(r, child),
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|i| scrub(r, i)),
        Value::String(s) => *s = r.text(&clean_untrusted(s, MAX_LINE)),
        _ => {}
    }
}

/// Cleans and redacts one piece of cluster text.
pub fn text(r: &mut Redactor, s: &str) -> String {
    r.text(&clean_untrusted(s, MAX_LINE))
}

/// The `ref` an agent gets back: `kind` is the plural resource (`resource.group` outside core).
pub fn ref_out(o: &ObjRef) -> Json {
    let kind = if o.gvr.group.is_empty() { o.gvr.resource.clone() } else { format!("{}.{}", o.gvr.resource, o.gvr.group) };
    let mut v = json!({ "kind": kind, "name": o.name, "context": o.context });
    if let Some(ns) = o.ns() {
        v["namespace"] = json!(ns);
    }
    v
}

/// The resolved context a tool acts on.
pub struct Cx {
    pub context: String,
    pub policy: McpPolicy,
    pub scope: Scope,
}

/// Policy and connection check for `context` (default: the one the human is looking at).
pub fn access(state: &AppState, context: Option<&str>, need: policy::Need) -> Result<Cx, McpError> {
    let context = match context.filter(|c| !c.is_empty()) {
        Some(c) => c.to_string(),
        None => crate::uistate::current(state)
            .context
            .ok_or_else(|| McpError::new("Invalid", "kns has no current context").hint("pass `context`; get_status lists the ones you may use"))?,
    };
    let stored = super::stored_policy(state, &context)
        .ok_or_else(|| McpError::new("NotLoaded", "kns has not loaded its agent settings yet").hint("try again in a few seconds"))?;
    let a = policy::Access {
        context: &context,
        stored: stored.policy,
        flags: crate::ctxflags::effective(state, &context).ok(),
        connected: super::connected(state, &context),
    };
    let policy = policy::check(&a, need)?;
    Ok(Cx { context, policy, scope: Scope::new(stored.namespaces) })
}

/// The check before anything stored under an agent-supplied id (dev set, bundle, pack) is read:
/// the client must have `need` in at least one context. Only then is the store read, and an id
/// that is missing or belongs to a context or namespace the client may not read gets the same
/// [`not_visible`] answer, so a client cannot tell the two apart (§6.6 "existence oracle").
pub fn access_any(state: &AppState, need: policy::Need) -> Result<(), McpError> {
    let current = match access(state, None, need) {
        Ok(_) => return Ok(()),
        Err(e) => e,
    };
    let contexts: Vec<String> = super::config(state).map(|c| c.policies.into_keys().collect()).unwrap_or_default();
    if contexts.iter().any(|c| access(state, Some(c), need).is_ok()) {
        return Ok(());
    }
    if matches!(current.code.as_str(), "PolicyDenied" | "NotConnected" | "NotLoaded") {
        return Err(current);
    }
    let level = if need == policy::Need::Propose { "propose" } else { "read" };
    Err(McpError::new("PolicyDenied", "no context kns is connected to lets agents do this")
        .hint(format!("ask the human to run \":mcp policy {level} <context>\" in kns (or \":mcp setup\")")))
}

/// The one answer for an id that does not exist or that the client may not see.
pub fn not_visible(what: &str, id: &str, hint: &str) -> McpError {
    McpError::new("NotFound", format!("no {what} \"{}\" that you may see", clean_untrusted(id, 60))).hint(hint)
}

/// Finds the API resource an agent named: plural, singular, short name, Kind, or
/// `resource.group`. Ties go to the preferred version and the core group (discovery order).
pub fn resolve_kind<'a>(resources: &'a [ApiResource], kind: &str) -> Option<&'a ApiResource> {
    let k = kind.trim().to_ascii_lowercase();
    if let Some((res, group)) = k.split_once('.')
        && let Some(r) = resources.iter().find(|r| r.gvr.resource == res && r.gvr.group == group)
    {
        return Some(r);
    }
    resources.iter().find(|r| {
        r.gvr.resource == k || r.singular == k || r.kind.to_ascii_lowercase() == k || r.short_names.iter().any(|s| s.eq_ignore_ascii_case(&k))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::Gvr;

    fn res(group: &str, resource: &str, kind: &str, short: &[&str]) -> ApiResource {
        ApiResource {
            gvr: Gvr::new(group, "v1", resource),
            kind: kind.into(),
            singular: kind.to_ascii_lowercase(),
            namespaced: true,
            verbs: vec![],
            short_names: short.iter().map(|s| s.to_string()).collect(),
            categories: vec![],
            subresources: vec![],
        }
    }

    #[test]
    fn kinds_resolve_every_way() {
        let all = vec![res("", "pods", "Pod", &["po"]), res("apps", "deployments", "Deployment", &["deploy"]), res("events.k8s.io", "events", "Event", &[]), res("", "events", "Event", &["ev"])];
        for k in ["pods", "pod", "po", "Pod", "PODS"] {
            assert_eq!(resolve_kind(&all, k).unwrap().gvr.resource, "pods", "{k}");
        }
        assert_eq!(resolve_kind(&all, "deploy").unwrap().gvr.group, "apps");
        assert_eq!(resolve_kind(&all, "deployments.apps").unwrap().gvr.group, "apps");
        assert_eq!(resolve_kind(&all, "events.events.k8s.io").unwrap().gvr.group, "events.k8s.io");
        assert!(resolve_kind(&all, "nope").is_none());
    }

    #[test]
    fn scrub_masks_and_cleans() {
        let mut r = Redactor::new();
        let mut v = json!({ "password": "hunter2", "note": "ok\u{202E}evil", "list": ["Bearer abc.def-123", "fine"], "n": 3 });
        scrub(&mut r, &mut v);
        let s = v.to_string();
        assert!(!s.contains("hunter2") && !s.contains("abc.def-123") && !s.contains('\u{202E}'), "{s}");
        assert_eq!(v["list"][1], "fine");
        assert!(r.count >= 2);
    }

    #[test]
    fn backend_errors_map() {
        let mut r = Redactor::new();
        assert_eq!(from_backend(BackendError::not_implemented("diagnose"), &mut r).code, "NotAvailableYet");
        assert_eq!(from_backend(BackendError::new(403, "Forbidden", "no"), &mut r).code, "Forbidden");
        let e = from_backend(BackendError::new(404, "", "pods \"x\u{1b}[31m\" not found: Bearer abc.def-123"), &mut r);
        assert_eq!(e.code, "NotFound");
        assert!(!e.message.contains('\u{1b}') && !e.message.contains("abc.def-123"), "{}", e.message);
    }

    /// What `get_object` / `describe_object` do to an object (Redactor + scrub), over fixtures
    /// that must not leak.
    #[test]
    fn object_pipeline_must_not_contain() {
        let cases = [
            (Gvr::new("", "v1", "secrets"), json!({ "apiVersion": "v1", "kind": "Secret", "metadata": { "name": "db" }, "data": { "password": "czNjcjN0LXZhbHVl" }, "stringData": { "x": "s3cr3t-value" } })),
            (Gvr::new("", "v1", "configmaps"), json!({ "apiVersion": "v1", "kind": "ConfigMap", "metadata": { "name": "app" }, "data": {
                "application.yaml": "spring:\n  datasource:\n    password: s3cr3t-value\n", "DSN": "postgres://u:s3cr3t-value@db:5432/x" } })),
            (Gvr::new("apps", "v1", "deployments"), json!({ "apiVersion": "apps/v1", "kind": "Deployment", "metadata": { "name": "w", "annotations": {
                "kubectl.kubernetes.io/last-applied-configuration": "{\"password\":\"s3cr3t-value\"}" } },
                "spec": { "template": { "spec": { "containers": [{ "name": "c", "args": ["--db-password=s3cr3t-value"], "env": [{ "name": "API_TOKEN", "value": "s3cr3t-value" }] }] } } } })),
        ];
        for (gvr, mut obj) in cases {
            let mut r = Redactor::new();
            r.object(&gvr, &mut obj);
            scrub(&mut r, &mut obj);
            let s = obj.to_string();
            assert!(!s.contains("s3cr3t-value") && !s.contains("czNjcjN0LXZhbHVl"), "{gvr:?}: {s}");
            assert!(r.count > 0);
        }
    }

    #[tokio::test]
    async fn selection_is_scoped_denied_and_audited() {
        use crate::{ipc::UiState, mcp};
        let (state, base) = mcp::testing::state("tools-sel").await;
        let pod = |ns: &str, name: &str| ObjRef { context: "default".into(), gvr: Gvr::new("", "v1", "pods"), namespace: Some(ns.into()), name: name.into() };
        crate::uistate::publish(
            &state,
            UiState { context: Some("default".into()), cursor: Some(pod("kafka", "k")), marked: vec![pod("a", "x"), pod("kafka", "y")], connected: vec!["default".into()], ..Default::default() },
        );
        // policy off → denied with a hint
        let o = call(&state, "claude-code", "get_selection", json!({})).await;
        let e = o.result.unwrap_err();
        assert_eq!(e.code, "PolicyDenied");
        assert!(e.hint.unwrap().contains(":mcp policy"));
        // read with an allowlist → the kafka objects are dropped and counted
        mcp::policy_set(&state, "default", McpPolicy::Read, Some(vec!["a".into()])).await.unwrap();
        let v = call(&state, "claude-code", "get_selection", json!({})).await.result.unwrap();
        assert!(v["cursor"].is_null());
        assert_eq!(v["marked"].as_array().unwrap().len(), 1);
        assert_eq!(v["filtered"], 2);
        assert!(v["untrusted"].as_array().unwrap().iter().any(|f| f == "marked"));
        // not connected → NotConnected; unknown args → Invalid
        crate::uistate::publish(&state, UiState { context: Some("default".into()), ..Default::default() });
        assert_eq!(call(&state, "claude-code", "get_selection", json!({})).await.result.unwrap_err().code, "NotConnected");
        assert_eq!(call(&state, "claude-code", "get_status", json!({ "x": 1 })).await.result.unwrap_err().code, "Invalid");
        assert_eq!(call(&state, "claude-code", "rm_rf", json!({})).await.result.unwrap_err().code, "Invalid");
        let rows = mcp::audit_tail(&state, 10).await.unwrap();
        let tools: Vec<&str> = rows.iter().map(|r| r.tool.as_str()).collect();
        assert!(tools.contains(&"get_selection") && tools.contains(&"rm_rf"), "{tools:?}");
        assert!(rows.iter().any(|r| r.outcome == AuditOutcome::Denied));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn envelope_caps() {
        let r = Redactor::new();
        assert!(envelope(Reply::new(json!({ "x": "y".repeat(MAX_RESULT) }), &[]), &r).is_err());
        let v = envelope(Reply::new(json!({ "x": 1 }), &["x"]), &r).unwrap();
        assert_eq!(v["untrusted"], json!(["x"]));
        assert_eq!(v["redactions"]["count"], 0);
    }
}
