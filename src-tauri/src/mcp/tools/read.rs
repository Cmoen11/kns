//! The read tools (policy `read`, docs/plan-features.md §5.3). Each body resolves its target
//! (policy, connection, kind, scope), fetches through the §2.1 internal API, and hands the raw data
//! to `shape.rs` or `scrub`. Tools whose package is not built yet answer `NotAvailableYet`.
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::{Cx, Reply, access, from_backend, parse, ref_out, resolve_kind, scrub, shape, text};
use crate::{
    ipc::{ApiResource, Json, McpPolicy, ObjRef, ProposalState},
    mcp::{
        McpError,
        describe::{
            CheckReachParams, DependenciesParams, Format, GetLogsParams, GetObjectParams, ListDevSetsParams, ListEventsParams, ListResourcesParams, NoParams, ProposalParams,
            RefArg, RefParams, TimelineParams, WaitProposalParams,
        },
        policy::Need,
    },
    redact::Redactor,
    state::AppState,
};

type R = Result<Reply, McpError>;

pub async fn run(state: &AppState, client: &str, name: &str, args: &Json, r: &mut Redactor) -> R {
    match name {
        "get_status" => {
            parse::<NoParams>(args)?;
            get_status(state).await
        }
        "get_selection" => {
            parse::<NoParams>(args)?;
            get_selection(state)
        }
        "list_resources" => list_resources(state, parse(args)?, r).await,
        "get_object" => get_object(state, parse(args)?, r).await,
        "describe_object" => describe_object(state, parse(args)?, r).await,
        "list_events" => list_events(state, parse(args)?, r).await,
        "get_logs" => get_logs(state, parse(args)?, r).await,
        "explain_why" => explain_why(state, parse(args)?, r).await,
        "get_timeline" => {
            let p: TimelineParams = parse(args)?;
            let (cx, obj, _) = target(state, &p.obj, r).await?;
            // C2: rows of other namespaces (and nodes, under an allowlist) are dropped and counted
            let rows = crate::timeline::timeline(state, &obj, p.since_minutes.unwrap_or(60).clamp(1, 1440)).await.map_err(|e| from_backend(e, r))?;
            let mut rows: Vec<Value> = rows.into_iter().filter_map(|row| serde_json::to_value(row).ok()).collect();
            let filtered = cx.scope.retain(&mut rows, |row| row["ref"]["namespace"].as_str());
            let mut v = json!({ "ref": ref_out(&obj), "rows": rows });
            scrub(r, &mut v);
            if filtered > 0 {
                v["filtered"] = json!(filtered);
            }
            Ok(Reply::new(v, &["rows.what"]))
        }
        "get_service_info" => get_service_info(state, parse(args)?, r).await,
        "get_workload_dependencies" => get_workload_dependencies(state, parse(args)?, r).await,
        "check_reach" => check_reach(state, parse(args)?, r).await,
        "list_forwards" => {
            parse::<NoParams>(args)?;
            list_forwards(state, r).await
        }
        "list_dev_sets" => list_dev_sets(state, client, parse(args)?, r).await,
        "get_proposal" => {
            let p: ProposalParams = parse(args)?;
            own_proposal(state, client, &p.id).map(proposal_reply)
        }
        "wait_proposal" => wait_proposal(state, client, parse(args)?).await,
        "make_pack" => {
            let p: crate::mcp::describe::MakePackParams = parse(args)?;
            if p.refs.is_empty() || p.refs.len() > 10 {
                return Err(McpError::new("Invalid", "make_pack takes 1-10 refs"));
            }
            // G: every ref passes policy, connection and scope; then one pack in one context
            let mut refs = Vec::with_capacity(p.refs.len());
            for a in &p.refs {
                refs.push(target(state, a, r).await?.1);
            }
            if refs.iter().any(|o| o.context != refs[0].context) {
                return Err(McpError::new("Invalid", "make_pack takes objects of one context"));
            }
            let req = crate::ipc::PackRequest { refs, logs: crate::ipc::PackLogs { tail: 50, previous: true }, sections: vec![] };
            let scope = access(state, Some(&req.refs[0].context), Need::Read)?.scope;
            let pack = crate::pack::build_with(state, &req, crate::pack::Limits::AGENT, r, |f| {
                hide_foreign_findings(&scope, f);
            })
            .await
            .map_err(|e| from_backend(e, r))?;
            let sections: Vec<Json> = pack.sections.iter().map(|s| json!({ "id": s.id, "title": s.title, "bytes": s.bytes })).collect();
            Ok(Reply::new(
                json!({ "id": pack.id, "context": pack.context, "markdown": pack.markdown, "bytes": pack.bytes, "approxTokens": pack.approx_tokens, "sections": sections }),
                &["markdown", "sections"],
            ))
        }
        "list_bundles" => {
            parse::<NoParams>(args)?;
            // C2: only bundles of contexts the agent may read, inside their allowlist
            let all = crate::trap::list_bundles(state).await.map_err(|e| from_backend(e, r))?;
            let mut filtered = 0;
            let mut bundles = Vec::new();
            for b in all {
                let ok = access(state, Some(&b.context), Need::Read).is_ok_and(|cx| cx.scope.allows(b.namespace.as_deref()));
                if !ok {
                    filtered += 1;
                    continue;
                }
                bundles.push(json!({ "id": b.id, "context": b.context, "target": ref_out(&b.target), "armedOn": ref_out(&b.armed_on), "trigger": b.trigger, "at": b.at, "uri": format!("kns://bundle/{}", b.id) }));
            }
            let mut v = json!({ "bundles": bundles });
            scrub(r, &mut v);
            if filtered > 0 {
                v["filtered"] = json!(filtered);
            }
            Ok(Reply::new(v, &["bundles.target", "bundles.armedOn"]))
        }
        other => Err(McpError::new("Invalid", format!("unknown tool \"{other}\""))),
    }
}

/// Resolves an agent's `ref`: policy and connection, kind through discovery, scope.
pub(super) async fn target(state: &AppState, a: &RefArg, r: &mut Redactor) -> Result<(Cx, ObjRef, ApiResource), McpError> {
    target_for(state, a, Need::Read, r).await
}

/// [`target`] for a tool that needs `need` (the propose tools pass `Need::Propose`).
pub(super) async fn target_for(state: &AppState, a: &RefArg, need: Need, r: &mut Redactor) -> Result<(Cx, ObjRef, ApiResource), McpError> {
    let cx = access(state, a.context.as_deref(), need)?;
    let res = resolve(state, &cx, &a.kind, r).await?;
    let namespace = a.namespace.clone().filter(|n| !n.is_empty());
    cx.scope.check(&cx.context, namespace.as_deref(), res.namespaced)?;
    if res.namespaced && namespace.is_none() {
        return Err(McpError::new("Invalid", format!("{} are namespaced: pass `namespace`", res.gvr.resource)));
    }
    if a.name.is_empty() || a.name.len() > 253 || a.name.contains('/') {
        return Err(McpError::new("Invalid", "invalid object name"));
    }
    let obj = ObjRef { context: cx.context.clone(), gvr: res.gvr.clone(), namespace: namespace.filter(|_| res.namespaced), name: a.name.clone() };
    Ok((cx, obj, res))
}

pub(super) async fn resolve(state: &AppState, cx: &Cx, kind: &str, r: &mut Redactor) -> Result<ApiResource, McpError> {
    // the context is connected (checked in `access`), so this reuses the human's session
    let session = state.session(&cx.context).await.map_err(|e| from_backend(e, r))?;
    let disc = session.discovery(None).await.map_err(|e| from_backend(e, r))?;
    resolve_kind(&disc.preferred, kind)
        .cloned()
        .ok_or_else(|| McpError::new("Invalid", format!("unknown kind \"{}\" in context {}", text(r, kind), cx.context)).hint("use the plural resource name, e.g. pods, deployments, services"))
}

async fn get_status(state: &AppState) -> R {
    let ui = crate::uistate::current(state);
    let cfg = crate::mcp::config(state).unwrap_or_default();
    let mut names: Vec<String> = cfg.policies.keys().cloned().chain(ui.connected.iter().cloned()).chain(ui.context.iter().cloned()).collect();
    names.sort();
    names.dedup();
    let entries: Vec<shape::CtxEntry> = names
        .iter()
        .map(|n| shape::CtxEntry {
            name: n.clone(),
            current: ui.context.as_deref() == Some(n),
            connected: crate::mcp::connected(state, n),
            flags: crate::ctxflags::effective(state, n).ok(),
            stored: cfg.policies.get(n).map_or(McpPolicy::Off, |p| p.policy),
        })
        .collect();
    let forwards = visible_forwards(state).await;
    let mut sets: Vec<String> = forwards.iter().filter_map(|f| f["devSet"].as_str().map(str::to_string)).collect();
    sets.sort();
    sets.dedup();
    Ok(Reply::new(shape::status(&entries, forwards.len(), &sets), &[]))
}

pub(crate) fn get_selection(state: &AppState) -> R {
    let ui = crate::uistate::current(state);
    let cx = access(state, ui.context.as_deref(), Need::Read)?;
    let allowed = |o: &&ObjRef| o.context == cx.context && cx.scope.allows(o.ns());
    let cursor = ui.cursor.as_ref().filter(allowed).map(ref_out);
    let marked_all = ui.marked.iter().filter(|o| o.context == cx.context).count();
    let marked: Vec<Json> = ui.marked.iter().filter(allowed).map(ref_out).collect();
    let mut v = json!({
        "context": cx.context,
        "pane": ui.pane.as_ref().map(|p| json!({ "kind": p.kind, "title": crate::redact::clean_untrusted(&p.title, 200) })),
        "cursor": cursor,
        "marked": marked,
        "filter": ui.filter.as_deref().map(|f| crate::redact::clean_untrusted(f, 200)),
        "namespace": ui.namespace,
    });
    let filtered = marked_all - v["marked"].as_array().map_or(0, Vec::len) + usize::from(ui.cursor.is_some() && v["cursor"].is_null());
    if filtered > 0 {
        v["filtered"] = json!(filtered);
    }
    Ok(Reply::new(v, &["pane.title", "filter", "cursor.name", "marked"]))
}

async fn list_resources(state: &AppState, p: ListResourcesParams, r: &mut Redactor) -> R {
    let cx = access(state, p.context.as_deref(), Need::Read)?;
    let res = resolve(state, &cx, &p.kind, r).await?;
    let namespace = match p.namespace.filter(|n| !n.is_empty()) {
        Some(ns) => Some(ns),
        None if res.namespaced => cx.scope.default_namespace()?,
        None => None,
    };
    cx.scope.check(&cx.context, namespace.as_deref(), res.namespaced)?;
    let limit = p.limit.unwrap_or(100).clamp(1, 200);
    let rows = crate::table::list_rows(state, &cx.context, &res.gvr, namespace.as_deref(), p.label_selector.as_deref(), limit)
        .await
        .map_err(|e| from_backend(e, r))?;
    let mut v = shape::rows(&rows.columns, rows.rows, rows.truncated, &cx.scope, r);
    v["kind"] = json!(res.kind);
    v["context"] = json!(cx.context);
    Ok(Reply::new(v, &["rows"]))
}

async fn fetch_redacted(state: &AppState, obj: &ObjRef, r: &mut Redactor) -> Result<Json, McpError> {
    let mut o = crate::objects::get_json(state, obj).await.map_err(|e| from_backend(e, r))?;
    crate::objects::strip_managed_fields(&mut o);
    r.object(&obj.gvr, &mut o);
    scrub(r, &mut o);
    Ok(o)
}

async fn get_object(state: &AppState, p: GetObjectParams, r: &mut Redactor) -> R {
    let (_, obj, _) = target(state, &p.obj, r).await?;
    let o = fetch_redacted(state, &obj, r).await?;
    let text = match p.format {
        Format::Json => serde_json::to_string_pretty(&o).unwrap_or_default(),
        Format::Yaml => crate::objects::to_yaml(o).await.map_err(|e| from_backend(e, r))?,
    };
    Ok(Reply::new(json!({ "ref": ref_out(&obj), "format": p.format_name(), "text": text }), &["text"]))
}

impl GetObjectParams {
    fn format_name(&self) -> &'static str {
        match self.format {
            Format::Yaml => "yaml",
            Format::Json => "json",
        }
    }
}

async fn object_events(state: &AppState, cx: &Cx, obj: &ObjRef, limit: usize, r: &mut Redactor) -> Result<Json, McpError> {
    let events = crate::objects::list_events(state, &cx.context, obj.ns(), Some(obj)).await.map_err(|e| from_backend(e, r))?;
    Ok(shape::events(events, limit, &cx.scope, r))
}

async fn describe_object(state: &AppState, p: RefParams, r: &mut Redactor) -> R {
    let (cx, obj, _) = target(state, &p.obj, r).await?;
    let o = fetch_redacted(state, &obj, r).await?;
    let events = object_events(state, &cx, &obj, 10, r).await.unwrap_or_else(|_| json!({ "events": [] }));
    let text = shape::describe(&o, events["events"].as_array().map(Vec::as_slice).unwrap_or_default());
    Ok(Reply::new(json!({ "ref": ref_out(&obj), "text": text }), &["text"]))
}

async fn list_events(state: &AppState, p: ListEventsParams, r: &mut Redactor) -> R {
    let limit = p.limit.unwrap_or(50).clamp(1, 100) as usize;
    if let Some(a) = &p.obj {
        let (cx, obj, _) = target(state, a, r).await?;
        let v = object_events(state, &cx, &obj, limit, r).await?;
        return Ok(Reply::new(v, &["events"]));
    }
    let cx = access(state, p.context.as_deref(), Need::Read)?;
    let namespace = match p.namespace.filter(|n| !n.is_empty()) {
        Some(ns) => Some(ns),
        None => cx.scope.default_namespace()?,
    };
    if namespace.is_none() {
        return Err(McpError::new("Invalid", "give `ref` or `namespace`"));
    }
    cx.scope.check(&cx.context, namespace.as_deref(), true)?;
    let events = crate::objects::list_events(state, &cx.context, namespace.as_deref(), None).await.map_err(|e| from_backend(e, r))?;
    Ok(Reply::new(shape::events(events, limit, &cx.scope, r), &["events"]))
}

async fn get_logs(state: &AppState, p: GetLogsParams, r: &mut Redactor) -> R {
    let (cx, obj, _) = target(state, &p.obj, r).await?;
    let pods = crate::objects::pods_for(state, &obj).await.map_err(|e| from_backend(e, r))?;
    let Some(pod) = pods.into_iter().find(|pod| cx.scope.allows(Some(&pod.namespace))) else {
        return Err(McpError::new("NotFound", "no pod behind this object").hint("explain_why says why"));
    };
    let container = match p.container.filter(|c| !c.is_empty()) {
        Some(c) if pod.containers.contains(&c) || pod.init_containers.contains(&c) => c,
        Some(c) => return Err(McpError::new("Invalid", format!("pod {} has no container \"{}\"", pod.name, text(r, &c))).hint(format!("containers: {}", pod.containers.join(", ")))),
        None => pod.containers.first().cloned().unwrap_or_default(),
    };
    let tail = p.tail.unwrap_or(200).clamp(1, shape::MAX_LOG_LINES as u32);
    let session = state.session(&cx.context).await.map_err(|e| from_backend(e, r))?;
    let api: kube::Api<k8s_openapi::api::core::v1::Pod> = kube::Api::namespaced(session.client.clone(), &pod.namespace);
    let params = kube::api::LogParams {
        container: Some(container.clone()).filter(|c| !c.is_empty()),
        previous: p.previous.unwrap_or(false),
        since_seconds: p.since_seconds.map(i64::from),
        // grep filters after redaction, so read more than the tail when grepping
        tail_lines: Some(if p.grep.is_some() { 5000 } else { i64::from(tail) }),
        limit_bytes: Some(4 * 1024 * 1024),
        ..Default::default()
    };
    let raw = tokio::time::timeout(Duration::from_secs(30), api.logs(&pod.name, &params))
        .await
        .map_err(|_| McpError::new("Timeout", "reading the logs took longer than 30 s"))?
        .map_err(|e| from_backend(e.into(), r))?;
    let (lines, truncated) = shape::logs(&raw, p.grep.as_deref(), tail as usize, r);
    Ok(Reply::new(json!({ "pod": pod.name, "namespace": pod.namespace, "container": container, "lines": lines, "truncated": truncated }), &["lines"]))
}

async fn explain_why(state: &AppState, p: RefParams, r: &mut Redactor) -> R {
    let (cx, obj, _) = target(state, &p.obj, r).await?;
    let mut d = crate::diagnose::diagnose(state, &cx.context, &obj).await.map_err(|e| from_backend(e, r))?;
    // a finding about an object in a namespace outside the allowlist (a Flux source or dependency,
    // a Certificate elsewhere) would carry that object's status text: dropped and counted
    let hidden = hide_foreign_findings(&cx.scope, &mut d.findings);
    let mut v = serde_json::to_value(d).unwrap_or(Value::Null);
    if let Some(m) = v.as_object_mut() {
        m.remove("redactions");
        if hidden > 0 {
            m.insert("hiddenFindings".into(), json!(hidden));
        }
    }
    scrub(r, &mut v);
    Ok(Reply::new(v, &["findings"]))
}

/// Drops findings whose evidence names a namespaced object the scope does not allow.
pub fn hide_foreign_findings(scope: &crate::mcp::scope::Scope, findings: &mut Vec<crate::ipc::Finding>) -> usize {
    use crate::ipc::Evidence;
    let visible = |r: &crate::ipc::ObjRef| r.namespace.as_deref().is_none_or(|ns| scope.allows(Some(ns)));
    let ok = |e: &Evidence| match e {
        Evidence::Object { obj_ref } | Evidence::Field { obj_ref, .. } => visible(obj_ref),
        Evidence::Diff { left_ref, right_ref, .. } => left_ref.iter().chain(right_ref.iter()).all(visible),
        Evidence::LogLine { .. } | Evidence::Event { .. } => true,
    };
    let before = findings.len();
    findings.retain(|f| f.evidence.iter().all(ok));
    before - findings.len()
}

async fn get_service_info(state: &AppState, p: RefParams, r: &mut Redactor) -> R {
    let (cx, obj, _) = target(state, &p.obj, r).await?;
    if obj.gvr.resource != "services" || !obj.gvr.group.is_empty() {
        return Err(McpError::new("Invalid", "get_service_info takes a Service (kind: services)"));
    }
    let info = crate::service::info(state, &cx.context, &obj).await.map_err(|e| from_backend(e, r))?;
    let mut v = serde_json::to_value(info).unwrap_or(Value::Null);
    scrub(r, &mut v);
    Ok(Reply::new(v, &["ports", "selector", "kafkaListeners"]))
}

async fn check_reach(state: &AppState, p: CheckReachParams, r: &mut Redactor) -> R {
    use crate::{
        ipc::{Gvr, PortRef},
        mcp::describe::PortArg,
    };
    let (cx, from_obj, _) = target(state, &p.from, r).await?;
    let (to_cx, to, _) = target(state, &p.to, r).await?;
    if to_cx.context != cx.context {
        return Err(McpError::new("Invalid", "`from` and `to` must be in one context"));
    }
    let from = if from_obj.gvr.group.is_empty() && from_obj.gvr.resource == "pods" {
        from_obj
    } else {
        let pods = crate::objects::pods_for(state, &from_obj).await.map_err(|e| from_backend(e, r))?;
        let Some(pod) = pods.into_iter().find(|pod| cx.scope.allows(Some(&pod.namespace))) else {
            return Err(McpError::new("NotFound", "no pod behind `from`").hint("explain_why says why"));
        };
        ObjRef { context: cx.context.clone(), gvr: Gvr::new("", "v1", "pods"), namespace: Some(pod.namespace), name: pod.name }
    };
    let port = p.port.map(|p| match p {
        PortArg::Number(n) => PortRef::Number(n),
        PortArg::Name(s) => PortRef::Name(s),
    });
    let check = crate::reach::reach(state, &from, &to, port).await.map_err(|e| from_backend(e, r))?;
    let mut v = serde_json::to_value(check).unwrap_or(Value::Null);
    scrub(r, &mut v);
    Ok(Reply::new(v, &["steps"]))
}

async fn get_workload_dependencies(state: &AppState, p: DependenciesParams, r: &mut Redactor) -> R {
    let (cx, obj, _) = target(state, &p.obj, r).await?;
    // a Service resolves to the workload behind it (and says so)
    let (obj, resolved) = super::propose::workload_of(state, &cx, obj, r).await?;
    let report = crate::env::resolve_masked(state, &cx.context, &obj, p.container.as_deref()).await.map_err(|e| from_backend(e, r))?;
    let mut v = serde_json::to_value(report).unwrap_or(Value::Null);
    if let Some(m) = v.as_object_mut() {
        m.remove("redactions");
    }
    // belt and braces: secret-sourced and masked rows never carry a value
    for row in v["rows"].as_array_mut().into_iter().flatten() {
        let secret = row["masked"] == true || row["source"] == "secret" || row["source"] == "secretRef";
        if secret && let Some(m) = row.as_object_mut() {
            m.remove("value");
        }
    }
    // cross-namespace dependencies outside the allowlist are dropped and counted
    let mut filtered = 0;
    if let Some(deps) = v["deps"].as_array_mut() {
        let before = deps.len();
        deps.retain(|d| cx.scope.allows(d["service"]["namespace"].as_str()));
        filtered = before - deps.len();
    }
    scrub(r, &mut v);
    if filtered > 0 {
        v["filteredDependencies"] = json!(filtered);
    }
    v["workload"] = ref_out(&obj);
    if let Some(via) = resolved {
        v["resolved"] = json!(via);
    }
    Ok(Reply::new(v, &["rows", "deps", "warnings"]))
}

/// Forwards in contexts the agent may read, inside the scope (JSON, picked fields only).
async fn visible_forwards(state: &AppState) -> Vec<Json> {
    let Ok(forwards) = crate::forward::list_forwards(state).await else { return vec![] };
    forwards
        .into_iter()
        .filter_map(|f| serde_json::to_value(f).ok())
        .filter(|f| {
            let ctx = f["context"].as_str().unwrap_or_default();
            let ns = f["namespace"].as_str();
            access(state, Some(ctx), Need::Read).is_ok_and(|cx| cx.scope.allows(ns))
        })
        .map(|f| {
            let mut out = serde_json::Map::new();
            for k in ["id", "context", "target", "remotePort", "localPort", "address", "status", "devSet", "owner", "requestedBy", "label"] {
                if let Some(v) = f.get(k).filter(|v| !v.is_null()) {
                    out.insert(k.into(), v.clone());
                }
            }
            Value::Object(out)
        })
        .collect()
}

async fn list_forwards(state: &AppState, r: &mut Redactor) -> R {
    let mut forwards = Value::Array(visible_forwards(state).await);
    scrub(r, &mut forwards);
    Ok(Reply::new(json!({ "forwards": forwards }), &["forwards.label"]))
}

async fn list_dev_sets(state: &AppState, client: &str, p: ListDevSetsParams, r: &mut Redactor) -> R {
    if let Some(c) = &p.context {
        access(state, Some(c), Need::Read)?;
    }
    let sets = crate::devset::list(state, p.context.as_deref()).await.map_err(|e| from_backend(e, r))?;
    let mut out = Vec::new();
    let mut filtered = 0;
    for set in sets {
        let Ok(cx) = access(state, Some(&set.context), Need::Read) else { continue };
        let mut v = serde_json::to_value(&set).unwrap_or(Value::Null);
        // every namespace the set reaches: forward targets, rewrite matches, the env workload
        let namespaces_ok = crate::devset::namespaces(&crate::devset::draft_of(&set)).iter().all(|ns| cx.scope.allows(Some(ns)));
        if !namespaces_ok {
            filtered += 1;
            continue;
        }
        if let Some(m) = v.as_object_mut() {
            m.remove("connSecrets");
            m.remove("approvedSnapshot");
        }
        v["createdByYou"] = json!(v["origin"]["by"] == "agent" && v["origin"]["client"] == client);
        v["approved"] = json!(v["approvedHash"].is_string() && v["approvedHash"] == v["hash"]);
        out.push(v);
    }
    let mut sets = Value::Array(out);
    scrub(r, &mut sets);
    let mut v = json!({ "sets": sets });
    if filtered > 0 {
        v["filtered"] = json!(filtered);
    }
    Ok(Reply::new(v, &["sets.name"]))
}

/// One of the client's own proposals; another client's is "not found" (ids are sequential).
pub(super) fn own_proposal(state: &AppState, client: &str, id: &str) -> Result<crate::ipc::Proposal, McpError> {
    match crate::proposals::get(state, id) {
        Ok(p) if p.client == client => Ok(p),
        _ => Err(McpError::new("NotFound", format!("you have no proposal \"{}\"", crate::redact::clean_untrusted(id, 40)))),
    }
}

pub(super) fn proposal_reply(p: crate::ipc::Proposal) -> Reply {
    let v = serde_json::to_value(p).unwrap_or(Value::Null);
    Reply::new(json!({ "proposal": v }), &["proposal.reason", "proposal.result.error.message", "proposal.result.message"])
}

async fn wait_proposal(state: &AppState, client: &str, p: WaitProposalParams) -> R {
    let timeout = Duration::from_secs(u64::from(p.timeout_seconds.unwrap_or(50).clamp(1, 60)));
    let first = own_proposal(state, client, &p.id)?;
    let start = first.state;
    let started = Instant::now();
    let mut now = first;
    // polls only while a call is waiting (bounded by the timeout); no idle timer
    while !now.state.is_final() && now.state == start && started.elapsed() < timeout {
        tokio::time::sleep(Duration::from_millis(400)).await;
        now = own_proposal(state, client, &p.id)?;
    }
    let mut reply = proposal_reply(now.clone());
    if matches!(now.state, ProposalState::Pending | ProposalState::Reviewing) {
        reply.data["hint"] = json!("the human has not decided yet: call wait_proposal again");
    }
    Ok(reply)
}

#[cfg(test)]
mod scope_tests {
    use super::hide_foreign_findings;
    use crate::ipc::{Evidence, Finding, Gvr, ObjRef, Severity};
    use crate::mcp::scope::Scope;

    fn finding(ns: Option<&str>) -> Finding {
        let obj_ref = ObjRef { context: "c".into(), gvr: Gvr::new("source.toolkit.fluxcd.io", "v1", "gitrepositories"), namespace: ns.map(str::to_string), name: "src".into() };
        Finding { severity: Severity::Error, title: "source not ready: a message from another namespace".into(), detail: None, evidence: vec![Evidence::Object { obj_ref }] }
    }

    /// §5.4 scope: a Flux source or dependency in a namespace outside the allowlist does not reach
    /// the agent through `explain_why`.
    #[test]
    fn findings_about_hidden_namespaces_are_dropped() {
        let mut f = vec![finding(Some("app")), finding(Some("flux-system")), finding(None)];
        assert_eq!(hide_foreign_findings(&Scope::new(Some(vec!["app".into()])), &mut f), 1);
        assert_eq!(f.len(), 2);
        let mut all = vec![finding(Some("flux-system"))];
        assert_eq!(hide_foreign_findings(&Scope::new(None), &mut all), 0);
    }
}
