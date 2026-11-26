//! Method name -> backend call. Names and parameter names are those of the Tauri commands
//! (`src/ipc/tauri.ts`, camelCase), so a socket client and the webview share one contract.
//!
//! Left out on purpose: calls that only make sense for the webview (`publish_ui_state`,
//! `save_state`) and calls that open a native dialog (`catalog_choose`, `pack_save`).
use serde::{Serialize, de::DeserializeOwned};

use super::{Conn, RpcSink};
use crate::{
    ipc::{BackendError, Json, ProposalPayload, Result},
    state::AppState,
};

/// `params[name]`, `null` when absent (so `Option<T>` parameters may be left out).
fn arg<T: DeserializeOwned>(p: &Json, name: &str) -> Result<T> {
    T::deserialize(p.get(name).unwrap_or(&Json::Null)).map_err(|e| BackendError::invalid(format!("parameter \"{name}\": {e}")))
}

fn ok<T: Serialize>(r: Result<T>) -> Result<Json> {
    r.and_then(|v| serde_json::to_value(v).map_err(BackendError::from))
}

/// Calls that change a cluster. Over the socket they honour the context flags the webview
/// enforces with dialogs: `readOnly` refuses, `protected` needs `confirm` = the context name.
pub const MUTATING: &[&str] = &[
    "apply_yaml",
    "delete_object",
    "patch_object",
    "scale",
    "restart",
    "trigger_cron_job",
    "debug_container",
    "debug_copy",
    "debug_pod_delete",
    "snippet_run",
];

/// The context a mutating call targets: `context`, `objRef.context`, `req.context` or
/// `req.objRef.context`.
fn target_context(p: &Json) -> Option<&str> {
    ["/context", "/objRef/context", "/req/context", "/req/objRef/context", "/req/target/context"]
        .iter()
        .find_map(|ptr| p.pointer(ptr).and_then(Json::as_str))
}

fn guard(state: &AppState, method: &str, p: &Json) -> Result<()> {
    if !MUTATING.contains(&method) {
        return Ok(());
    }
    // a server-side dry run changes nothing: the review before an apply needs no confirm
    if method == "apply_yaml" && p.pointer("/opts/dryRun").and_then(Json::as_bool) == Some(true) {
        return Ok(());
    }
    let context = target_context(p).ok_or_else(|| BackendError::invalid(format!("{method}: no context in the parameters")))?;
    let flags = crate::ctxflags::effective(state, context)?;
    if flags.read_only {
        return Err(BackendError::new(403, "ReadOnly", format!("context \"{context}\" is read-only in kns settings")));
    }
    if flags.protected && p.get("confirm").and_then(Json::as_str) != Some(context) {
        return Err(BackendError::new(
            428,
            "ConfirmRequired",
            format!("context \"{context}\" is protected: repeat the call with \"confirm\": \"{context}\""),
        ));
    }
    Ok(())
}

pub async fn call(state: &AppState, conn: &Conn, sub: &Json, method: &str, p: &Json) -> Result<Json> {
    guard(state, method, p)?;
    let s = state;
    use crate::*;
    match method {
        // ── socket only ──
        "hello" => Ok(super::hello()),
        "show_window" => {
            crate::background::show_window(s);
            Ok(Json::Null)
        }
        "connected_contexts" => Ok(serde_json::to_value(s.connected_contexts()).unwrap_or_default()),

        // ── base ──
        "list_contexts" => ok(session::list_contexts().await),
        "connect" => {
            let context: String = arg(p, "context")?;
            let info = session::connect(s, &context).await;
            if info.is_ok() {
                conn.human_connected(s, &context);
            }
            ok(info)
        }
        "aws_sso_login" => ok(awslogin::login(&arg::<String>(p, "context")?).await),
        "aws_sso_status" => ok(awslogin::status(&arg::<Vec<String>>(p, "contexts")?).await),
        "discover" => ok(discovery::discover(s, &arg::<String>(p, "context")?).await),
        "subscribe_table" => {
            let id = table::subscribe_table(s, arg(p, "query")?, RpcSink::new(conn, sub)).await?;
            conn.own_stream(&id);
            ok(Ok(id))
        }
        "stop_stream" => {
            s.stop_stream(&arg::<String>(p, "id")?);
            Ok(Json::Null)
        }
        "get_yaml" => ok(objects::get_yaml(s, &arg(p, "objRef")?, arg(p, "managedFields")?).await),
        "get_json" => ok(objects::get_json(s, &arg(p, "objRef")?).await),
        "get_json_masked" => ok(objects::get_json_masked(s, &arg(p, "objRef")?, &arg::<String>(p, "salt")?).await),
        "list_events" => {
            let namespace: Option<String> = arg(p, "namespace")?;
            let obj_ref: Option<ipc::ObjRef> = arg(p, "objRef")?;
            ok(objects::list_events(s, &arg::<String>(p, "context")?, namespace.as_deref(), obj_ref.as_ref()).await)
        }
        "pods_for" => ok(objects::pods_for(s, &arg(p, "objRef")?).await),
        "decode_secret" => ok(objects::decode_secret(s, &arg(p, "objRef")?).await),
        "apply_yaml" => {
            let context: String = arg(p, "context")?;
            let yaml: String = arg(p, "yaml")?;
            let opts: ipc::ApplyOptions = arg::<Option<_>>(p, "opts")?.unwrap_or_default();
            let proposal: Option<String> = arg(p, "proposalId")?;
            let matches = |q: &ProposalPayload| matches!(q, ProposalPayload::Apply { context: c, yaml: y, .. } if *c == context && *y == yaml);
            ok(proposals::run_step(s, proposal.as_deref(), "apply", matches, mutate::apply_yaml(s, &context, &yaml, &opts)).await)
        }
        "delete_object" => {
            let obj_ref: ipc::ObjRef = arg(p, "objRef")?;
            let opts: ipc::DeleteOptions = arg::<Option<_>>(p, "opts")?.unwrap_or_default();
            let proposal: Option<String> = arg(p, "proposalId")?;
            let matches = |q: &ProposalPayload| matches!(q, ProposalPayload::Delete { obj_ref: r } if *r == obj_ref);
            ok(proposals::run_step(s, proposal.as_deref(), "delete", matches, mutate::delete_object(s, &obj_ref, &opts)).await)
        }
        "patch_object" => {
            // Proposal-gated reconcile patches stay a webview path; a socket patch is the human's own.
            let obj_ref: ipc::ObjRef = arg(p, "objRef")?;
            let subresource: Option<String> = arg(p, "subresource")?;
            ok(mutate::patch_object(s, &obj_ref, &arg(p, "patch")?, arg(p, "patchType")?, subresource.as_deref()).await)
        }
        "scale" => ok(mutate::scale(s, &arg(p, "objRef")?, arg(p, "replicas")?).await),
        "restart" => ok(mutate::restart(s, &arg(p, "objRef")?).await),
        "trigger_cron_job" => ok(mutate::trigger_cron_job(s, &arg(p, "objRef")?).await),
        "pod_metrics" => {
            let namespace: Option<String> = arg(p, "namespace")?;
            ok(metrics::pod_metrics(s, &arg::<String>(p, "context")?, namespace.as_deref()).await)
        }
        "node_metrics" => ok(metrics::node_metrics(s, &arg::<String>(p, "context")?).await),
        "stream_logs" => {
            let id = logs::stream_logs(s, arg(p, "query")?, RpcSink::new(conn, sub)).await?;
            conn.own_stream(&id);
            ok(Ok(id))
        }
        "exec_start" => {
            let id = exec::exec_start(s, arg(p, "query")?, RpcSink::new(conn, sub)).await?;
            conn.own_stream(&id);
            ok(Ok(id))
        }
        "exec_write" => ok(exec::exec_write(s, &arg::<String>(p, "id")?, &arg::<String>(p, "data")?)),
        "exec_resize" => ok(exec::exec_resize(s, &arg::<String>(p, "id")?, arg(p, "cols")?, arg(p, "rows")?)),
        "start_forward" => ok(forward::start_forward(s, arg(p, "query")?).await),
        "list_forwards" => ok(forward::list_forwards(s).await),
        "stop_forward" => ok(forward::stop_forward(s, &arg::<String>(p, "id")?).await),
        "resolve_forward_target" => ok(forward::resolve_target(s, &arg::<String>(p, "context")?, arg(p, "target")?).await),
        "open_forward" => ok(forward::open_forward(s, &arg::<String>(p, "id")?)),
        "can_i" => ok(rbac::can_i(s, &arg(p, "query")?).await),
        "load_state" => {
            let dir = super::config_dir(s)?;
            ok(store::load_state(&dir, &arg::<String>(p, "key")?).await)
        }

        // ── A1 ──
        "redact_preview" => Ok(serde_json::to_value(redact::preview(&arg::<String>(p, "text")?)).unwrap_or_default()),
        "proposals_list" => ok(Ok(proposals::list(s))),
        "proposal_claim" => ok(proposals::claim(s, &arg::<String>(p, "id")?)),
        "proposal_unclaim" => ok(proposals::unclaim(s, &arg::<String>(p, "id")?)),
        "proposal_approve" => ok(proposals::approve(s, &arg::<String>(p, "id")?, arg(p, "choices")?).await),
        "proposal_resolve" => ok(proposals::resolve(s, &arg::<String>(p, "id")?, arg(p, "resolution")?)),

        // ── B ──
        "service_info" => {
            let obj_ref: ipc::ObjRef = arg(p, "objRef")?;
            ok(service::info(s, &obj_ref.context.clone(), &obj_ref).await)
        }
        "dev_sets_list" => {
            let context: Option<String> = arg(p, "context")?;
            ok(devset::list(s, context.as_deref()).await)
        }
        "dev_set_save" => {
            let proposal: Option<String> = arg(p, "proposalId")?;
            ok(devset::save_command(s, arg(p, "set")?, proposal.as_deref()).await)
        }
        "dev_set_delete" => {
            let proposal: Option<String> = arg(p, "proposalId")?;
            ok(devset::delete(s, &arg::<String>(p, "id")?, proposal.as_deref()).await)
        }
        "dev_set_up" => {
            let proposal: Option<String> = arg(p, "proposalId")?;
            ok(devset::up_command(s, &arg::<String>(p, "id")?, &arg::<String>(p, "hash")?, proposal.as_deref()).await)
        }
        "dev_set_down" => ok(devset::down(s, &arg::<String>(p, "id")?).await),
        "dev_set_failures" => ok(Ok(devset::failures(s, &arg::<Option<Vec<String>>>(p, "clear")?.unwrap_or_default()))),
        "env_resolve" => {
            let obj_ref: ipc::ObjRef = arg(p, "objRef")?;
            let container: Option<String> = arg(p, "container")?;
            ok(env::resolve_masked(s, &obj_ref.context.clone(), &obj_ref, container.as_deref()).await)
        }
        "env_reveal" => ok(env::reveal(s, &arg(p, "objRef")?, &arg::<String>(p, "container")?, &arg::<String>(p, "key")?).await),
        "env_export" => ok(env::export(s, arg(p, "req")?).await),
        "name_proxy_status" => ok(proxy::status(s).await),
        "name_proxy_set" => ok(proxy::set(s, arg(p, "on")?, arg(p, "port")?).await),
        "conn_secrets_list" => ok(devset::conn_secrets_list(s, &arg::<String>(p, "context")?, &arg::<String>(p, "namespace")?).await),
        "forward_conn_info" => ok(devset::conn_info(s, &arg::<String>(p, "forward")?).await),
        "forward_conn_copy" => ok(devset::conn_copy(s, arg(p, "req")?).await),
        "volumes_list" => {
            let container: Option<String> = arg(p, "container")?;
            ok(env::volumes_list(s, &arg(p, "objRef")?, container.as_deref()).await)
        }
        "volumes_export" => ok(env::volumes_export(s, arg(p, "req")?).await),

        // ── C ──
        "diagnose" => {
            let obj_ref: ipc::ObjRef = arg(p, "objRef")?;
            ok(diagnose::diagnose(s, &obj_ref.context.clone(), &obj_ref).await)
        }
        "timeline" => ok(timeline::timeline(s, &arg(p, "objRef")?, arg(p, "sinceMinutes")?).await),
        "journal_set" => ok(journal::set(s, &arg::<String>(p, "context")?, arg(p, "on")?).await),
        "journal_status" => ok(journal::status(s).await),
        "trap_arm" => ok(trap::arm(s, arg(p, "objRef")?, arg(p, "opts")?).await),
        "trap_list" => ok(Ok(trap::list(s))),
        "trap_disarm" => {
            trap::disarm(s, &arg::<String>(p, "id")?);
            Ok(Json::Null)
        }
        "bundle_get" => ok(trap::bundle_text(s, &arg::<String>(p, "id")?).await),
        "pod_metrics_history" => {
            let namespace: Option<String> = arg(p, "namespace")?;
            ok(Ok(s.ext::<history::History>().series(&arg::<String>(p, "context")?, namespace.as_deref())))
        }
        "reach" => ok(reach::reach(s, &arg(p, "from")?, &arg(p, "to")?, arg(p, "port")?).await),
        "reach_probe" => ok(reach::probe(s, &arg(p, "from")?, &arg(p, "to")?, &arg(p, "port")?).await),
        "relations" => ok(relations::relations(s, &arg(p, "objRef")?).await),

        // ── D / F / G ──
        "field_owners" => ok(ownership::field_owners(s, &arg(p, "objRef")?).await),
        "revisions" => ok(ownership::revisions(s, &arg(p, "objRef")?).await),
        "debug_container" => ok(debug::debug_container(s, &arg(p, "req")?).await),
        "debug_copy" => {
            let image: Option<String> = arg(p, "image")?;
            let target: Option<String> = arg(p, "target")?;
            ok(debug::debug_copy(s, &arg(p, "objRef")?, image.as_deref(), target.as_deref()).await)
        }
        "debug_pods_list" => ok(debug::debug_pods_list(s, &arg::<String>(p, "context")?).await),
        "debug_pod_delete" => ok(debug::debug_pod_delete(s, &arg(p, "objRef")?).await),
        "snippet_run" => ok(debug::snippet_run(s, &arg(p, "req")?).await),
        "context_pack" => ok(pack::build(s, &arg(p, "req")?, pack::Limits::UI, &mut redact::Redactor::new()).await),

        // ── H ──
        "mcp_status" => {
            mcp::ensure_loaded(s).await?;
            ok(Ok(mcp::status(s)))
        }
        "mcp_set_enabled" => ok(mcp::set_enabled(s, arg(p, "on")?).await),
        "mcp_set_port" => ok(mcp::set_port(s, arg(p, "port")?).await),
        "mcp_client_revoke" => ok(mcp::client_revoke(s, &arg::<String>(p, "name")?).await.map(|_| ())),
        "mcp_policy_set" => ok(mcp::policy_set(s, &arg::<String>(p, "context")?, arg(p, "policy")?, arg(p, "namespaces")?).await),
        "mcp_audit_tail" => ok(mcp::audit_tail(s, arg(p, "limit")?).await),

        // ── misc ──
        "subscribe_ns_health" => {
            let id = nshealth::subscribe_ns_health(s, arg(p, "context")?, arg(p, "namespaces")?, RpcSink::new(conn, sub)).await?;
            conn.own_stream(&id);
            ok(Ok(id))
        }
        "catalog_load" => {
            let dir = super::config_dir(s)?;
            let c = catalog::load(&dir).await?;
            catalog::remember_links(c.as_ref());
            ok(Ok(c))
        }
        "catalog_open" => {
            let url: String = arg(p, "url")?;
            if !catalog::knows_link(&url) {
                return Err(BackendError::invalid("not a link of the catalog"));
            }
            super::open_url(s, url)?;
            Ok(Json::Null)
        }
        "github_status" => ok(Ok(github::status().await)),
        "github_env_images" => ok(github::env_images(&arg::<String>(p, "repo")?, &arg::<String>(p, "imageFile")?).await),
        "github_compare" => ok(github::compare(&arg::<String>(p, "repo")?, &arg::<String>(p, "base")?, &arg::<String>(p, "head")?).await),
        "traffic_sample" => ok(traffic::sample(s, &arg(p, "req")?).await),
        "update_status" => ok(Ok(update::status(s))),
        "update_check" => ok(update::check(s).await),
        "background_status" => ok(Ok(crate::background::status(s))),
        "background_set" => ok(crate::background::set(s, arg(p, "keepRunning")?, arg(p, "launchAtLogin")?).await),
        "rpc_tcp_status" => ok(Ok(super::tcp::status(s))),
        "herdr_status" => ok(Ok(crate::herdr::status(s))),
        "herdr_install" => ok(crate::herdr::install(s).await),
        "herdr_uninstall" => ok(crate::herdr::uninstall(s).await),
        "context_flags" => ok(crate::ctxflags::effective(s, &arg::<String>(p, "context")?)),
        "rpc_tcp_set" => ok(super::tcp::set(s, arg(p, "enabled")?).await),
        _ => Err(BackendError::new(404, "UnknownMethod", format!("no method \"{method}\""))),
    }
}

/// Every method name `call` answers (for `hello` and `kns-tui call --list`).
pub const METHODS: &[&str] = &[
    "hello", "show_window", "connected_contexts", "background_status", "background_set", "rpc_tcp_status", "rpc_tcp_set", "context_flags", "herdr_status", "herdr_install", "herdr_uninstall",
    "list_contexts", "connect", "aws_sso_login", "aws_sso_status", "discover", "subscribe_table", "stop_stream",
    "get_yaml", "get_json", "get_json_masked", "list_events", "pods_for", "decode_secret",
    "apply_yaml", "delete_object", "patch_object", "scale", "restart", "trigger_cron_job",
    "pod_metrics", "node_metrics", "stream_logs", "exec_start", "exec_write", "exec_resize",
    "start_forward", "list_forwards", "stop_forward", "resolve_forward_target", "open_forward", "can_i", "load_state",
    "redact_preview", "proposals_list", "proposal_claim", "proposal_unclaim", "proposal_approve", "proposal_resolve",
    "service_info", "dev_sets_list", "dev_set_save", "dev_set_delete", "dev_set_up", "dev_set_down", "dev_set_failures",
    "env_resolve", "env_reveal", "env_export", "name_proxy_status", "name_proxy_set", "conn_secrets_list",
    "forward_conn_info", "forward_conn_copy", "volumes_list", "volumes_export",
    "diagnose", "timeline", "journal_set", "journal_status", "trap_arm", "trap_list", "trap_disarm", "bundle_get",
    "pod_metrics_history", "reach", "reach_probe", "relations",
    "field_owners", "revisions", "debug_container", "debug_copy", "debug_pods_list", "debug_pod_delete", "snippet_run", "context_pack",
    "mcp_status", "mcp_set_enabled", "mcp_set_port", "mcp_client_revoke", "mcp_policy_set", "mcp_audit_tail",
    "subscribe_ns_health", "catalog_load", "catalog_open", "github_status", "github_env_images", "github_compare",
    "traffic_sample", "update_status", "update_check",
];

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn target_context_finds_every_shape() {
        assert_eq!(target_context(&json!({ "context": "a" })), Some("a"));
        assert_eq!(target_context(&json!({ "objRef": { "context": "b" } })), Some("b"));
        assert_eq!(target_context(&json!({ "req": { "objRef": { "context": "c" } } })), Some("c"));
        assert_eq!(target_context(&json!({ "yaml": "x" })), None);
    }

    #[test]
    fn mutations_need_known_flags_and_confirm() {
        let state = AppState::default();
        // flags not loaded: refused (unknown = deny)
        assert!(guard(&state, "scale", &json!({ "objRef": { "context": "prod" } })).is_err());
        crate::ctxflags::set(
            &state,
            crate::ctxflags::parse_settings(&json!({ "data": { "contexts": { "prod": { "protected": true }, "ro": { "readOnly": true } } } })),
        );
        let e = guard(&state, "scale", &json!({ "objRef": { "context": "prod" } })).unwrap_err();
        assert_eq!(e.reason, "ConfirmRequired");
        assert!(guard(&state, "scale", &json!({ "objRef": { "context": "prod" }, "confirm": "prod" })).is_ok());
        assert_eq!(guard(&state, "delete_object", &json!({ "objRef": { "context": "ro" }, "confirm": "ro" })).unwrap_err().reason, "ReadOnly");
        assert!(guard(&state, "restart", &json!({ "objRef": { "context": "dev" } })).is_ok());
        // a dry run is a review, not a change: no confirm, also on a read-only context
        assert!(guard(&state, "apply_yaml", &json!({ "context": "prod", "opts": { "dryRun": true } })).is_ok());
        assert!(guard(&state, "apply_yaml", &json!({ "context": "ro", "opts": { "dryRun": true } })).is_ok());
        assert!(guard(&state, "apply_yaml", &json!({ "context": "prod", "opts": {} })).is_err());
        // reads never need flags
        assert!(guard(&AppState::default(), "get_yaml", &json!({})).is_ok());
    }

    #[test]
    fn every_mutating_method_is_listed() {
        for m in MUTATING {
            assert!(METHODS.contains(m), "{m}");
        }
    }
}
