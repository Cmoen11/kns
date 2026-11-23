//! The H2 tools (docs/plan-features.md §5.3, §5.5, §5.7): `show_in_kns`, dev-set authoring
//! (`draft_dev_set_from_workload`, `save_dev_set`, `delete_dev_set`, `stop_dev_set`) and the
//! proposals (`propose_*`, `cancel_proposal`).
//!
//! - Authoring is inert: a saved set opens nothing and changes nothing in the cluster; Rust's
//!   `devset::save` applies the agent rules (own sets only, autoStart/connSecrets/includeSecrets
//!   stripped, allowlist, side-effect overrides only, approval cleared).
//! - Every `propose_*` creates a pending proposal (`proposals::create`, which also asks for the
//!   human's attention) after the policy, scope, shape and `canI` checks; the human approves it in
//!   kns and the frontend runs it through the gated commands.
//! - Agent-written env specs in `envExport` and `devSetUpdate` proposals pass the same override
//!   rule as agent saves (`devset::agent_override_ok`), and never carry secret-key inclusion.
use serde_json::{Value, json};

use super::{
    Cx, Reply, access, from_backend, parse,
    read::{own_proposal, proposal_reply, target, target_for},
    resolve_kind,
};
use crate::{
    devset,
    ipc::{
        AccessQuery, AgentShowView, ApiResource, ApplyOptions, ApplyParsed, BackendError, BackendEvent, DevForward, DevSet, DevSetDraft, DevSetOrigin,
        EnvFormat, EnvOverride, EnvSpec, ExportEnv, ForwardTarget, Gvr, Json, ObjRef, PortRef, Proposal, ProposalPayload, Rewrite, RewriteMatch,
        RewriteTo, ShowView, Workload,
    },
    mcp::{
        McpError,
        describe::{
            DevForwardArg, DevSetArg, DevSetIdParams, DraftParams, StopDevSetParams, EnvArg, FormatArg, OverrideArg, PortArg, ProposalParams, ProposeApplyParams,
            ProposeDevSetUpParams, ProposeEnvExportParams, ProposeForwardParams, ProposeReconcileParams, ProposeRefParams, ProposeScaleParams,
            RewriteArg, SaveDevSetParams, ShowParams, ShowViewArg, TargetArg, WorkloadArg,
        },
        policy::Need,
    },
    proposals,
    redact::{Redactor, clean_untrusted},
    state::AppState,
};

type R = Result<Reply, McpError>;

/// The tools this module serves.
pub const NAMES: &[&str] = &[
    "show_in_kns",
    "draft_dev_set_from_workload",
    "save_dev_set",
    "delete_dev_set",
    "stop_dev_set",
    "propose_dev_set_up",
    "propose_forward",
    "propose_env_export",
    "propose_scale",
    "propose_restart",
    "propose_delete",
    "propose_reconcile",
    "propose_apply",
    "cancel_proposal",
];

pub fn handles(name: &str) -> bool {
    NAMES.contains(&name)
}

/// What the agent is told to do after a proposal was created.
pub const AFTER_PROPOSE: &str =
    "Tell the human to look at kns (\"agent 1\" in the bottom row, the Agent requests group, or leader y), then call wait_proposal with this id until the state is final.";

pub async fn run(state: &AppState, client: &str, name: &str, args: &Json, r: &mut Redactor) -> R {
    match name {
        "show_in_kns" => show(state, client, parse(args)?, r).await,
        "draft_dev_set_from_workload" => draft(state, parse(args)?, r).await,
        "save_dev_set" => save(state, client, parse(args)?, r).await,
        "delete_dev_set" => delete(state, client, parse(args)?, r).await,
        "stop_dev_set" => stop(state, client, parse(args)?, r).await,
        "propose_dev_set_up" => propose_up(state, client, parse(args)?, r).await,
        "propose_forward" => propose_forward(state, client, parse(args)?, r).await,
        "propose_env_export" => propose_env_export(state, client, parse(args)?, r).await,
        "propose_scale" => propose_scale(state, client, parse(args)?, r).await,
        "propose_restart" => propose_restart(state, client, parse(args)?, r).await,
        "propose_delete" => propose_delete(state, client, parse(args)?, r).await,
        "propose_reconcile" => propose_reconcile(state, client, parse(args)?, r).await,
        "propose_apply" => propose_apply(state, client, parse(args)?, r).await,
        "cancel_proposal" => {
            let p: ProposalParams = parse(args)?;
            own_proposal(state, client, &p.id)?;
            let done = proposals::cancel(state, &p.id, client).map_err(|e| from_backend(e, r))?;
            Ok(proposal_reply(done))
        }
        other => Err(McpError::new("Invalid", format!("unknown tool \"{}\"", clean_untrusted(other, 80)))),
    }
}

// ───────────────────────── conversions (pure) ─────────────────────────

const FORWARD_WORKLOADS: &[&str] = &["deployments", "statefulsets", "daemonsets", "replicasets"];
const ENV_WORKLOADS: &[&str] = &["deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "cronjobs", "pods"];

fn lower(s: &str) -> String {
    s.trim().to_ascii_lowercase()
}
fn is_pod(kind: &str) -> bool {
    matches!(lower(kind).as_str(), "pod" | "pods" | "po")
}
fn is_service(kind: &str) -> bool {
    matches!(lower(kind).as_str(), "service" | "services" | "svc")
}

/// A Kubernetes object name or namespace as an agent wrote it: short, no slash, no control text.
fn check_name(what: &str, s: &str) -> Result<(), McpError> {
    let ok = !s.is_empty() && s.len() <= 253 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_'));
    if ok { Ok(()) } else { Err(McpError::new("Invalid", format!("invalid {what} \"{}\"", clean_untrusted(s, 80)))) }
}

/// `resource` or `resource.group`, the way agents name kinds.
pub fn kind_name(gvr: &Gvr) -> String {
    if gvr.group.is_empty() { gvr.resource.clone() } else { format!("{}.{}", gvr.resource, gvr.group) }
}

pub fn target_in(t: &TargetArg, res: &[ApiResource]) -> Result<ForwardTarget, McpError> {
    check_name("namespace", &t.namespace)?;
    check_name("name", &t.name)?;
    let (namespace, name) = (t.namespace.clone(), t.name.clone());
    if is_pod(&t.kind) {
        return Ok(ForwardTarget::Pod { namespace, name });
    }
    if is_service(&t.kind) {
        return Ok(ForwardTarget::Service { namespace, name });
    }
    let r = resolve_kind(res, &t.kind)
        .filter(|r| r.gvr.group == "apps" && FORWARD_WORKLOADS.contains(&r.gvr.resource.as_str()))
        .ok_or_else(|| {
            McpError::new("Invalid", format!("cannot forward to kind \"{}\"", clean_untrusted(&t.kind, 60)))
                .hint("use kind service (preferred), pod, deployment, statefulset or daemonset")
        })?;
    Ok(ForwardTarget::Workload { gvr: r.gvr.clone(), namespace, name })
}

pub fn target_out(t: &ForwardTarget) -> TargetArg {
    match t {
        ForwardTarget::Pod { namespace, name } => TargetArg { kind: "pod".into(), namespace: namespace.clone(), name: name.clone() },
        ForwardTarget::Service { namespace, name } => TargetArg { kind: "service".into(), namespace: namespace.clone(), name: name.clone() },
        ForwardTarget::Workload { gvr, namespace, name } => TargetArg { kind: kind_name(gvr), namespace: namespace.clone(), name: name.clone() },
    }
}

fn workload_in(w: &WorkloadArg, res: &[ApiResource]) -> Result<Workload, McpError> {
    check_name("namespace", &w.namespace)?;
    check_name("name", &w.name)?;
    let gvr = if is_pod(&w.kind) {
        Gvr::new("", "v1", "pods")
    } else {
        resolve_kind(res, &w.kind)
            .filter(|r| ENV_WORKLOADS.contains(&r.gvr.resource.as_str()) && matches!(r.gvr.group.as_str(), "apps" | "batch"))
            .map(|r| r.gvr.clone())
            .ok_or_else(|| McpError::new("Invalid", format!("\"{}\" is not a workload kind", clean_untrusted(&w.kind, 60))).hint("use deployment, statefulset, daemonset, job, cronjob or pod"))?
    };
    Ok(Workload { gvr, namespace: w.namespace.clone(), name: w.name.clone() })
}

fn workload_out(w: &Workload) -> WorkloadArg {
    WorkloadArg { kind: kind_name(&w.gvr), namespace: w.namespace.clone(), name: w.name.clone() }
}

fn port_in(p: &PortArg) -> PortRef {
    match p {
        PortArg::Number(n) => PortRef::Number(*n),
        PortArg::Name(s) => PortRef::Name(s.clone()),
    }
}
fn port_out(p: &PortRef) -> PortArg {
    match p {
        PortRef::Number(n) => PortArg::Number(*n),
        PortRef::Name(s) => PortArg::Name(s.clone()),
    }
}
pub fn format_in(f: FormatArg) -> EnvFormat {
    match f {
        FormatArg::Dotenv => EnvFormat::Dotenv,
        FormatArg::Powershell => EnvFormat::Powershell,
        FormatArg::Posix => EnvFormat::Posix,
    }
}
fn format_out(f: EnvFormat) -> FormatArg {
    match f {
        EnvFormat::Dotenv => FormatArg::Dotenv,
        EnvFormat::Powershell => FormatArg::Powershell,
        EnvFormat::Posix => FormatArg::Posix,
    }
}

fn overrides_in(o: &Option<Vec<OverrideArg>>) -> Option<Vec<EnvOverride>> {
    o.as_ref().filter(|v| !v.is_empty()).map(|v| v.iter().map(|x| EnvOverride { key: x.key.clone(), value: x.value.clone() }).collect())
}

/// The rule `devset::save` applies to agent sets, for agent-written specs in proposals (§6.5):
/// only side-effect keys kns detects, with a plain value.
pub fn check_overrides(overrides: Option<&[EnvOverride]>) -> Result<(), McpError> {
    for o in overrides.unwrap_or_default() {
        if !devset::agent_override_ok(&o.key, &o.value) {
            return Err(McpError::new(
                "Invalid",
                format!("override {}: agents may only override consumer-group, Streams application and migration keys, with a plain value (A-Z a-z 0-9 . _ -)", clean_untrusted(&o.key, 80)),
            )
            .hint("drop the override, or ask the human to set it in kns"));
        }
    }
    Ok(())
}

fn env_in(e: &EnvArg, res: &[ApiResource]) -> Result<EnvSpec, McpError> {
    Ok(EnvSpec {
        workload: workload_in(&e.workload, res)?,
        container: e.container.clone().filter(|c| !c.is_empty()),
        include: e.include.clone(),
        exclude: e.exclude.clone(),
        include_secrets: None,
        overrides: overrides_in(&e.overrides),
        format: format_in(e.format),
    })
}

fn env_out(e: &EnvSpec) -> EnvArg {
    EnvArg {
        workload: workload_out(&e.workload),
        container: e.container.clone(),
        include: e.include.clone(),
        exclude: e.exclude.clone(),
        overrides: e.overrides.as_ref().map(|v| v.iter().map(|o| OverrideArg { key: o.key.clone(), value: o.value.clone() }).collect()),
        format: format_out(e.format),
    }
}

/// An agent's set as the draft `devset::save` takes. Never sets autoStart, connSecrets or
/// includeSecrets (Rust strips them anyway).
pub fn draft_in(a: &DevSetArg, context: &str, res: &[ApiResource]) -> Result<DevSetDraft, McpError> {
    let forwards = a
        .forwards
        .iter()
        .map(|f: &DevForwardArg| {
            Ok(DevForward { key: f.key.clone(), target: target_in(&f.target, res)?, remote_port: port_in(&f.remote_port), local_port: f.local_port, pin: f.pin, label: f.label.clone() })
        })
        .collect::<Result<Vec<_>, McpError>>()?;
    let rewrites = a
        .rewrites
        .iter()
        .map(|w: &RewriteArg| Rewrite {
            r#match: RewriteMatch { service: w.service.clone(), namespace: w.namespace.clone(), port: w.port },
            env_key: w.env_key.clone(),
            to: RewriteTo { forward: w.forward.clone() },
        })
        .collect();
    let env = a.env.as_ref().map(|e| env_in(e, res)).transpose()?;
    Ok(DevSetDraft {
        id: a.id.clone().filter(|i| !i.is_empty()),
        name: a.name.clone(),
        context: context.to_string(),
        forwards,
        rewrites,
        env,
        auto_start: false,
        conn_secrets: None,
    })
}

/// A set in the shape agents read and write (`save_dev_set` takes it back unchanged).
pub fn arg_out(set: &DevSet) -> DevSetArg {
    DevSetArg {
        id: Some(set.id.clone()).filter(|i| !i.is_empty()),
        name: set.name.clone(),
        context: Some(set.context.clone()),
        forwards: set
            .forwards
            .iter()
            .map(|f| DevForwardArg { key: f.key.clone(), target: target_out(&f.target), remote_port: port_out(&f.remote_port), local_port: f.local_port, pin: f.pin, label: f.label.clone() })
            .collect(),
        rewrites: set
            .rewrites
            .iter()
            .map(|w| RewriteArg { service: w.r#match.service.clone(), namespace: w.r#match.namespace.clone(), port: w.r#match.port, forward: w.to.forward.clone(), env_key: w.env_key.clone() })
            .collect(),
        env: set.env.as_ref().map(env_out),
    }
}

/// The content of a `devSetUpdate` proposal: the stored set with the agent's forwards, rewrites
/// and env; the human's own choices (autoStart, connSecrets, ticked secret keys) stay as they
/// are. `approvedSnapshot` holds the current content, so the dialog shows the change as a diff.
pub fn proposed_update(existing: &DevSet, draft: DevSetDraft) -> Result<DevSet, McpError> {
    devset::validate(&draft).map_err(|e| McpError::new("Invalid", clean_untrusted(&e.message, 300)))?;
    check_overrides(draft.env.as_ref().and_then(|e| e.overrides.as_deref()))?;
    if draft.context != existing.context {
        return Err(McpError::new("Invalid", format!("set {} is in context {}; a set cannot move to another context", existing.name, existing.context)));
    }
    let mut proposed = existing.clone();
    // the human's picks stay only for what they were made for: a connection Secret for a forward
    // whose key and target are unchanged, ticked secret keys for the same workload and container
    proposed.conn_secrets = existing.conn_secrets.as_ref().map(|picks| {
        picks
            .iter()
            .filter(|c| {
                let old = existing.forwards.iter().find(|f| f.key == c.forward).map(|f| &f.target);
                let new = draft.forwards.iter().find(|f| f.key == c.forward).map(|f| &f.target);
                old.is_some() && old == new
            })
            .cloned()
            .collect()
    });
    if proposed.conn_secrets.as_ref().is_some_and(Vec::is_empty) && existing.conn_secrets.as_ref().is_some_and(|v| !v.is_empty()) {
        proposed.conn_secrets = None;
    }
    proposed.forwards = draft.forwards;
    proposed.rewrites = draft.rewrites;
    let kept = existing.env.as_ref().and_then(|old| {
        let same = draft.env.as_ref().is_some_and(|new| new.workload == old.workload && new.container == old.container);
        if same { old.include_secrets.clone() } else { None }
    });
    proposed.env = draft.env.map(|mut e| {
        e.include_secrets = kept;
        e
    });
    proposed.approved_hash = None;
    proposed.approved_snapshot = Some(Box::new(devset::snapshot(existing)));
    proposed.hash = devset::hash_of(&proposed);
    if proposed.hash == existing.hash {
        return Err(McpError::new("Invalid", "the proposed content equals the saved set").hint("nothing to change"));
    }
    Ok(proposed)
}

// ───────────────────────── shared helpers ─────────────────────────

/// Fields of the agent-facing set whose values are structure, not cluster secrets: the key rule
/// would mask `envKey` (it ends in KEY), which breaks the round trip into `save_dev_set`. They are
/// still cleaned of control and invisible characters.
const STRUCTURAL: &[&str] = &["envKey"];

/// `scrub` for replies that carry a set in the `save_dev_set` shape (see STRUCTURAL).
pub fn scrub_set(r: &mut Redactor, v: &mut Json) {
    match v {
        Value::Object(map) => {
            for (k, child) in map.iter_mut() {
                match child {
                    Value::String(s) if STRUCTURAL.contains(&k.as_str()) => *s = clean_untrusted(s, 200),
                    Value::String(s) => *s = r.env_value(k, &clean_untrusted(s, crate::redact::MAX_LINE)),
                    _ => scrub_set(r, child),
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|i| scrub_set(r, i)),
        Value::String(s) => *s = r.text(&clean_untrusted(s, crate::redact::MAX_LINE)),
        _ => {}
    }
}

fn agent_origin(client: &str) -> DevSetOrigin {
    DevSetOrigin::Agent { client: client.into(), at: jiff::Timestamp::now().to_string() }
}

/// Backend errors of dev-set and proposal calls, with the codes and hints of §5.3 (the generic
/// mapping turns every 403 into `Forbidden`, which would hide `NotOwner` and `PolicyDenied`).
fn dev_error(e: BackendError, r: &mut Redactor) -> McpError {
    let message = r.text(&clean_untrusted(&e.message, 1024));
    match e.reason.as_str() {
        "NotOwner" => McpError::new("NotOwner", message).hint("save a copy (omit `id`, pick a new `name`), or pass `asProposal: true` to ask the human to accept the change"),
        "PolicyDenied" => McpError::new("PolicyDenied", message).hint("stay inside the namespaces get_status allows, or ask the human to widen the allowlist with \":mcp policy\""),
        "Conflict" => McpError::new("Conflict", message).hint("wait_proposal on your open proposal, or cancel_proposal it, then try again"),
        "RateLimited" => McpError::new("RateLimited", message).hint("call wait_proposal on your open proposal, or cancel_proposal it"),
        "NotConnected" => McpError::new("NotConnected", message).hint("ask the human to open that context in kns"),
        "NeedsApproval" => McpError::new("NeedsApproval", message).hint("the set changed; read it again with list_dev_sets"),
        "Invalid" => McpError::new("Invalid", message).hint("fix the field the message names; see the tool's input schema"),
        _ => from_backend(e, r),
    }
}

async fn kinds(state: &AppState, cx: &Cx, r: &mut Redactor) -> Result<Vec<ApiResource>, McpError> {
    let session = state.session(&cx.context).await.map_err(|e| from_backend(e, r))?;
    let disc = session.discovery(None).await.map_err(|e| from_backend(e, r))?;
    Ok(disc.preferred.clone())
}

/// Only conversions that name a kind other than pod/service need discovery.
fn needs_discovery(a: &DevSetArg) -> bool {
    a.forwards.iter().any(|f| !is_pod(&f.target.kind) && !is_service(&f.target.kind)) || a.env.as_ref().is_some_and(|e| !is_pod(&e.workload.kind))
}

pub(crate) const SET_HINT: &str = "list_dev_sets lists the ids you may use";

/// A dev set by an agent-supplied id, for a tool that needs `need`. The policy is checked before
/// the store is read (`access_any`), and a missing set answers exactly like one in a context or
/// namespace the client may not read, so an id cannot be probed (§6.6). A set the client may read
/// but not propose on gets the usual `PolicyDenied`: `list_dev_sets` shows it anyway.
async fn get_set(state: &AppState, id: &str, need: Need, r: &mut Redactor) -> Result<(DevSet, Cx), McpError> {
    super::access_any(state, need)?;
    let hidden = || super::not_visible("dev set", id, SET_HINT);
    let set = devset::get(state, id).await.map_err(|e| from_backend(e, r))?.ok_or_else(hidden)?;
    let read = access(state, Some(&set.context), Need::Read).map_err(|_| hidden())?;
    scope_set(&read, &set).map_err(|_| hidden())?;
    let cx = if need == Need::Read { read } else { access(state, Some(&set.context), need)? };
    Ok((set, cx))
}

/// Every namespace the set reaches must be visible to the agent.
fn scope_set(cx: &Cx, set: &DevSet) -> Result<(), McpError> {
    for ns in devset::namespaces(&devset::draft_of(set)) {
        cx.scope.check(&cx.context, Some(&ns), true)?;
    }
    Ok(())
}

fn own(set: &DevSet, client: &str) -> bool {
    matches!(&set.origin, DevSetOrigin::Agent { client: c, .. } if c == client)
}

/// `canI` at propose time (§5.4). An unknown answer (no session yet, review API down) lets the
/// proposal through: the human's own dialog checks again before anything runs.
async fn can(state: &AppState, context: &str, verb: &str, gvr: Gvr, subresource: Option<&str>, namespace: Option<&str>) -> Result<(), McpError> {
    let q = AccessQuery {
        context: context.into(),
        verb: verb.into(),
        gvr: gvr.clone(),
        subresource: subresource.map(str::to_string),
        namespace: namespace.map(str::to_string),
        name: None,
    };
    match crate::rbac::can_i(state, &q).await {
        Ok(false) => {
            let what = subresource.map_or_else(|| gvr.resource.clone(), |s| format!("{}/{s}", gvr.resource));
            Err(McpError::new("Forbidden", format!("the human's Kubernetes permissions do not allow {verb} {what}{}", namespace.map(|n| format!(" in {n}")).unwrap_or_default()))
                .hint("nothing kns can approve; pick something the human may do"))
        }
        _ => Ok(()),
    }
}

/// The reply of every `propose_*` tool.
fn proposed(p: Proposal) -> Reply {
    let mut reply = Reply::new(
        json!({
            "proposal": { "id": p.id, "state": "pending", "kind": proposals::kind(&p.payload), "expiresAt": p.expires_at },
            "next": AFTER_PROPOSE,
        }),
        &[],
    );
    reply.proposal_id = Some(p.id);
    reply
}

fn create(state: &AppState, client: &str, context: &str, payload: ProposalPayload, reason: Option<&str>, r: &mut Redactor) -> R {
    proposals::create(state, client, context, payload, reason).map(proposed).map_err(|e| dev_error(e, r))
}

/// A Service named where a workload is expected resolves to the workload behind it (its first
/// pod's controller chain), and says so.
pub(super) async fn workload_of(state: &AppState, cx: &Cx, obj: ObjRef, r: &mut Redactor) -> Result<(ObjRef, Option<String>), McpError> {
    if !(obj.gvr.group.is_empty() && obj.gvr.resource == "services") {
        return Ok((obj, None));
    }
    let pods = crate::objects::pods_for(state, &obj).await.map_err(|e| from_backend(e, r))?;
    let pod = pods.into_iter().next().ok_or_else(|| {
        McpError::new("NotFound", format!("service {} selects no pod", obj.name)).hint("pass the workload itself (kind: deployments, statefulsets …)")
    })?;
    let mut cur = ObjRef { context: obj.context.clone(), gvr: Gvr::new("", "v1", "pods"), namespace: Some(pod.namespace.clone()), name: pod.name.clone() };
    for _ in 0..3 {
        let o = crate::objects::get_json(state, &cur).await.map_err(|e| from_backend(e, r))?;
        let Some(owner) = o["metadata"]["ownerReferences"].as_array().and_then(|a| a.iter().find(|x| x["controller"] == true)) else { break };
        let gvr = match (owner["apiVersion"].as_str().unwrap_or_default(), owner["kind"].as_str().unwrap_or_default()) {
            ("apps/v1", "ReplicaSet") => Gvr::new("apps", "v1", "replicasets"),
            ("apps/v1", "Deployment") => Gvr::new("apps", "v1", "deployments"),
            ("apps/v1", "StatefulSet") => Gvr::new("apps", "v1", "statefulsets"),
            ("apps/v1", "DaemonSet") => Gvr::new("apps", "v1", "daemonsets"),
            ("batch/v1", "Job") => Gvr::new("batch", "v1", "jobs"),
            ("batch/v1", "CronJob") => Gvr::new("batch", "v1", "cronjobs"),
            _ => break,
        };
        let Some(name) = owner["name"].as_str() else { break };
        cur = ObjRef { name: name.to_string(), gvr, ..cur };
    }
    cx.scope.check(&cx.context, cur.ns(), true)?;
    let via = format!("service {} is backed by {}/{}", obj.name, cur.gvr.resource, cur.name);
    Ok((cur, Some(via)))
}

// ───────────────────────── show ─────────────────────────

async fn show(state: &AppState, client: &str, p: ShowParams, r: &mut Redactor) -> R {
    let view = match p.view {
        ShowViewArg::Describe => ShowView::Describe,
        ShowViewArg::Yaml => ShowView::Yaml,
        ShowViewArg::Logs => ShowView::Logs,
        ShowViewArg::Why => ShowView::Why,
        ShowViewArg::Timeline => ShowView::Timeline,
        ShowViewArg::Devset => ShowView::Devset,
    };
    let shown = if view == ShowView::Devset {
        let id = p.dev_set.as_deref().filter(|s| !s.is_empty()).ok_or_else(|| McpError::new("Invalid", "view devset needs `devSet`"))?;
        let (set, _) = get_set(state, id, Need::Read, r).await?;
        AgentShowView { view, obj_ref: None, dev_set: Some(set.id) }
    } else {
        let a = p.obj.as_ref().ok_or_else(|| McpError::new("Invalid", "this view needs `ref`"))?;
        let (_, obj, _) = target(state, a, r).await?;
        AgentShowView { view, obj_ref: Some(obj), dev_set: None }
    };
    crate::events::emit(state, BackendEvent::AgentShow { client: client.into(), view: shown });
    Ok(Reply::new(json!({ "shown": true, "note": "opened beside the human's focused pane, labelled AGENT; focus stays where it was" }), &[]))
}

// ───────────────────────── dev-set authoring ─────────────────────────

async fn draft(state: &AppState, p: DraftParams, r: &mut Redactor) -> R {
    let (cx, obj, _) = target_for(state, &p.obj, Need::Propose, r).await?;
    let (obj, via) = workload_of(state, &cx, obj, r).await?;
    if !ENV_WORKLOADS.contains(&obj.gvr.resource.as_str()) {
        return Err(McpError::new("Invalid", format!("{} is not a workload", kind_name(&obj.gvr))).hint("pass a Deployment, StatefulSet, DaemonSet, Job, CronJob, Pod or a Service in front of one"));
    }
    let report = crate::env::resolve_masked(state, &cx.context, &obj, None).await.map_err(|e| from_backend(e, r))?;
    // the same set devset::draft_from_workload builds (the human's `E` → `s`), minus what the
    // context's allowlist hides from the agent
    let wanted = |name: &str| p.include.as_ref().is_none_or(|inc| inc.iter().any(|i| i == name));
    let mut filtered = 0;
    let mut deps = Vec::new();
    for d in &report.deps {
        if !wanted(&d.service.name) {
            continue;
        }
        if !cx.scope.allows(d.service.ns()) || !cx.scope.allows(Some(d.suggested_forward.target.namespace())) {
            filtered += 1;
            continue;
        }
        deps.push(d);
    }
    let set = DevSet {
        id: String::new(),
        name: p.name.clone(),
        context: cx.context.clone(),
        forwards: deps.iter().map(|d| d.suggested_forward.clone()).collect(),
        rewrites: deps.iter().map(|d| d.suggested_rewrite.clone()).collect(),
        env: Some(EnvSpec {
            workload: Workload { gvr: obj.gvr.clone(), namespace: obj.ns().unwrap_or_default().to_string(), name: obj.name.clone() },
            container: Some(report.container.clone()),
            include: None,
            exclude: None,
            include_secrets: None,
            overrides: (!report.overrides.is_empty()).then(|| report.overrides.clone()),
            format: EnvFormat::Dotenv,
        }),
        auto_start: false,
        conn_secrets: None,
        origin: DevSetOrigin::User,
        hash: String::new(),
        approved_hash: None,
        approved_snapshot: None,
        updated_at: String::new(),
    };
    let mut warnings: Vec<String> = report.warnings.clone();
    let secret_keys: Vec<&str> = report.rows.iter().filter(|row| row.masked || matches!(row.source, crate::ipc::EnvSource::Secret)).map(|row| row.key.as_str()).collect();
    let dependencies: Vec<Json> = deps
        .iter()
        .map(|d| {
            json!({
                "service": { "namespace": d.service.ns(), "name": d.service.name },
                "port": d.port,
                "kind": d.kind,
                "ready": d.ready,
                "forward": d.suggested_forward.key,
                "notes": d.notes,
            })
        })
        .collect();
    for d in deps.iter().filter(|d| !d.ready) {
        warnings.push(format!("{}: no ready endpoints; a forward to it will wait (explain_why on the Service says why)", d.service.name));
    }
    let mut v = json!({
        "set": arg_out(&set),
        "warnings": warnings,
        "dependencies": dependencies,
        "secretKeys": secret_keys,
        "next": "Show the human the forwards and warnings, adjust if they want less, then save_dev_set with `set` (unchanged or edited).",
    });
    if let Some(via) = via {
        v["resolved"] = json!(via);
    }
    if filtered > 0 {
        v["filteredDependencies"] = json!(filtered);
    }
    scrub_set(r, &mut v);
    Ok(Reply::new(v, &["warnings", "dependencies.notes"]))
}

async fn save(state: &AppState, client: &str, p: SaveDevSetParams, r: &mut Redactor) -> R {
    let cx = access(state, p.set.context.as_deref(), Need::Propose)?;
    // the namespaces the agent wrote are checked before any cluster call (discovery below)
    let named = p.set.forwards.iter().map(|f| &f.target.namespace).chain(p.set.rewrites.iter().map(|w| &w.namespace)).chain(p.set.env.iter().map(|e| &e.workload.namespace));
    for ns in named {
        cx.scope.check(&cx.context, Some(ns), true)?;
    }
    let res = if needs_discovery(&p.set) { kinds(state, &cx, r).await? } else { Vec::new() };
    let draft = draft_in(&p.set, &cx.context, &res)?;
    for ns in devset::namespaces(&draft) {
        cx.scope.check(&cx.context, Some(&ns), true)?;
    }
    if let Some(id) = draft.id.clone() {
        let (existing, _) = get_set(state, &id, Need::Read, r).await?;
        if !own(&existing, client) {
            if p.as_proposal != Some(true) {
                return Err(McpError::new("NotOwner", format!("set \"{}\" was not created by you", existing.name))
                    .hint("save a copy (omit `id`, pick a new `name`), or pass `asProposal: true` to ask the human to accept the change"));
            }
            let a = access(state, Some(&existing.context), Need::Propose)?;
            scope_set(&a, &existing)?;
            let proposed = proposed_update(&existing, draft)?;
            let payload = ProposalPayload::DevSetUpdate { dev_set: existing.id.clone(), proposed: Box::new(proposed) };
            return create(state, client, &existing.context, payload, p.reason.as_deref(), r);
        }
    }
    let saved = devset::save(state, draft, agent_origin(client)).await.map_err(|e| dev_error(e, r))?;
    let mut v = json!({
        "set": arg_out(&saved.set),
        "id": saved.set.id,
        "approved": false,
        "warnings": saved.warnings,
        "next": format!("propose_dev_set_up with id \"{}\" (add exportEnv when the human runs the workload locally); optionally show_in_kns with view devset first", saved.set.id),
    });
    scrub_set(r, &mut v);
    Ok(Reply::new(v, &["warnings"]))
}

async fn delete(state: &AppState, client: &str, p: DevSetIdParams, r: &mut Redactor) -> R {
    let (set, _) = get_set(state, &p.id, Need::Propose, r).await?;
    let never_approved = set.approved_hash.is_none() && set.approved_snapshot.is_none();
    if own(&set, client) && never_approved {
        devset::delete(state, &set.id, None).await.map_err(|e| dev_error(e, r))?;
        return Ok(Reply::new(json!({ "deleted": true, "id": set.id }), &[]));
    }
    create(state, client, &set.context, ProposalPayload::DevSetDelete { dev_set: set.id.clone() }, p.reason.as_deref(), r)
}

async fn stop(state: &AppState, client: &str, p: StopDevSetParams, r: &mut Redactor) -> R {
    let (set, _) = get_set(state, &p.id, Need::Propose, r).await?;
    let running: Vec<_> = crate::forward::list_forwards(state).await.map_err(|e| from_backend(e, r))?.into_iter().filter(|f| f.dev_set.as_deref() == Some(set.id.as_str())).collect();
    if running.is_empty() {
        return Ok(Reply::new(json!({ "stopped": 0, "note": "the set is not running" }), &[]));
    }
    if running.iter().any(|f| f.requested_by.as_deref() != Some(client)) {
        return Err(McpError::new("PolicyDenied", format!("the human started dev set {} themselves", set.name)).hint("ask the human to run \":dev down\" in kns"));
    }
    devset::down(state, &set.id).await.map_err(|e| from_backend(e, r))?;
    Ok(Reply::new(json!({ "stopped": running.len(), "id": set.id }), &[]))
}

// ───────────────────────── proposals ─────────────────────────

async fn propose_up(state: &AppState, client: &str, p: ProposeDevSetUpParams, r: &mut Redactor) -> R {
    let (set, _) = get_set(state, &p.id, Need::Propose, r).await?;
    if p.export_env.is_some() && set.env.is_none() {
        return Err(McpError::new("Invalid", format!("dev set {} has no env to export", set.name)).hint("save it with `env` (draft_dev_set_from_workload builds one), or omit exportEnv"));
    }
    if set.forwards.is_empty() && p.export_env.is_none() {
        return Err(McpError::new("Invalid", format!("dev set {} has no forwards", set.name)));
    }
    let mut seen: Vec<&str> = Vec::new();
    for f in &set.forwards {
        let ns = f.target.namespace();
        if !seen.contains(&ns) {
            seen.push(ns);
            can(state, &set.context, "create", Gvr::new("", "v1", "pods"), Some("portforward"), Some(ns)).await?;
        }
    }
    let payload = ProposalPayload::DevSetUp { dev_set: set.id.clone(), hash: set.hash.clone(), export_env: p.export_env.map(|e| ExportEnv { format: format_in(e.format) }) };
    create(state, client, &set.context, payload, p.reason.as_deref(), r)
}

async fn propose_forward(state: &AppState, client: &str, p: ProposeForwardParams, r: &mut Redactor) -> R {
    let cx = access(state, p.context.as_deref(), Need::Propose)?;
    let res = if is_pod(&p.target.kind) || is_service(&p.target.kind) { Vec::new() } else { kinds(state, &cx, r).await? };
    let target = target_in(&p.target, &res)?;
    cx.scope.check(&cx.context, Some(target.namespace()), true)?;
    if let Some(port) = p.local_port
        && port < 1024
    {
        return Err(McpError::new("Invalid", format!("local port {port} is below 1024")));
    }
    if let PortArg::Name(n) = &p.remote_port {
        check_name("port name", n)?;
    }
    can(state, &cx.context, "create", Gvr::new("", "v1", "pods"), Some("portforward"), Some(target.namespace())).await?;
    let payload = ProposalPayload::Forward { context: cx.context.clone(), target, remote_port: port_in(&p.remote_port), local_port: p.local_port };
    create(state, client, &cx.context, payload, p.reason.as_deref(), r)
}

async fn propose_env_export(state: &AppState, client: &str, p: ProposeEnvExportParams, r: &mut Redactor) -> R {
    match (&p.dev_set, &p.obj) {
        (Some(id), None) => {
            if p.container.is_some() || p.include.is_some() || p.exclude.is_some() || p.overrides.is_some() {
                return Err(McpError::new("Invalid", "with `devSet` the set's env spec is used: container, include, exclude and overrides belong in the set (save_dev_set)"));
            }
            let (set, _) = get_set(state, id, Need::Propose, r).await?;
            let mut spec = set.env.clone().ok_or_else(|| McpError::new("Invalid", format!("dev set {} has no env", set.name)))?;
            spec.format = format_in(p.format);
            // the human ticks secret keys in the dialog; an agent never pre-selects them
            spec.include_secrets = None;
            if own(&set, client) {
                check_overrides(spec.overrides.as_deref())?;
            }
            let payload = ProposalPayload::EnvExport { dev_set: Some(set.id.clone()), spec, rewrites: set.rewrites.clone() };
            create(state, client, &set.context, payload, p.reason.as_deref(), r)
        }
        (None, Some(a)) => {
            let (cx, obj, _) = target_for(state, a, Need::Propose, r).await?;
            let (obj, _) = workload_of(state, &cx, obj, r).await?;
            if !ENV_WORKLOADS.contains(&obj.gvr.resource.as_str()) {
                return Err(McpError::new("Invalid", format!("{} is not a workload", kind_name(&obj.gvr))));
            }
            let overrides = overrides_in(&p.overrides);
            check_overrides(overrides.as_deref())?;
            let spec = EnvSpec {
                workload: Workload { gvr: obj.gvr.clone(), namespace: obj.ns().unwrap_or_default().to_string(), name: obj.name.clone() },
                container: p.container.clone().filter(|c| !c.is_empty()),
                include: p.include.clone(),
                exclude: p.exclude.clone(),
                include_secrets: None,
                overrides,
                format: format_in(p.format),
            };
            let payload = ProposalPayload::EnvExport { dev_set: None, spec, rewrites: Vec::new() };
            create(state, client, &cx.context, payload, p.reason.as_deref(), r)
        }
        _ => Err(McpError::new("Invalid", "give either `devSet` or `ref`")),
    }
}

async fn propose_scale(state: &AppState, client: &str, p: ProposeScaleParams, r: &mut Redactor) -> R {
    let (cx, obj, _) = target_for(state, &p.obj, Need::Propose, r).await?;
    if obj.gvr.group != "apps" || !matches!(obj.gvr.resource.as_str(), "deployments" | "statefulsets" | "replicasets") {
        return Err(McpError::new("Invalid", format!("{} cannot be scaled", kind_name(&obj.gvr))).hint("scale a Deployment, StatefulSet or ReplicaSet"));
    }
    if p.replicas > 100 {
        return Err(McpError::new("Invalid", "replicas is 0-100"));
    }
    can(state, &cx.context, "patch", obj.gvr.clone(), Some("scale"), obj.ns()).await?;
    let payload = ProposalPayload::Scale { obj_ref: obj, replicas: p.replicas };
    create(state, client, &cx.context, payload, p.reason.as_deref(), r)
}

async fn propose_restart(state: &AppState, client: &str, p: ProposeRefParams, r: &mut Redactor) -> R {
    let (cx, obj, _) = target_for(state, &p.obj, Need::Propose, r).await?;
    if obj.gvr.group != "apps" || !matches!(obj.gvr.resource.as_str(), "deployments" | "statefulsets" | "daemonsets") {
        return Err(McpError::new("Invalid", format!("{} cannot be restarted", kind_name(&obj.gvr))).hint("restart a Deployment, StatefulSet or DaemonSet; a pod is restarted by propose_delete"));
    }
    can(state, &cx.context, "patch", obj.gvr.clone(), None, obj.ns()).await?;
    create(state, client, &cx.context, ProposalPayload::Restart { obj_ref: obj }, p.reason.as_deref(), r)
}

async fn propose_delete(state: &AppState, client: &str, p: ProposeRefParams, r: &mut Redactor) -> R {
    let (cx, obj, res) = target_for(state, &p.obj, Need::Propose, r).await?;
    if !res.namespaced {
        return Err(McpError::new("PolicyDenied", "agents cannot propose deleting cluster-scoped objects"));
    }
    can(state, &cx.context, "delete", obj.gvr.clone(), None, obj.ns()).await?;
    create(state, client, &cx.context, ProposalPayload::Delete { obj_ref: obj }, p.reason.as_deref(), r)
}

async fn propose_reconcile(state: &AppState, client: &str, p: ProposeReconcileParams, r: &mut Redactor) -> R {
    let (cx, obj, _) = target_for(state, &p.obj, Need::Propose, r).await?;
    if !obj.gvr.group.ends_with("fluxcd.io") {
        return Err(McpError::new("Invalid", format!("{} is not a Flux object", kind_name(&obj.gvr))));
    }
    can(state, &cx.context, "patch", obj.gvr.clone(), None, obj.ns()).await?;
    let payload = ProposalPayload::Reconcile { obj_ref: obj, with_source: p.with_source.unwrap_or(false) };
    create(state, client, &cx.context, payload, p.reason.as_deref(), r)
}

/// Kinds an agent can never propose to apply (§5.3).
pub const APPLY_DENIED: &[&str] = &["CustomResourceDefinition", "ValidatingWebhookConfiguration", "MutatingWebhookConfiguration", "ClusterRole", "ClusterRoleBinding", "Namespace"];
pub const MAX_APPLY: usize = 256 * 1024;

/// The fields `propose_apply` needs from the one document (pure).
pub fn apply_fields(docs: &[Json]) -> Result<(String, String, String, String, String), McpError> {
    let [doc] = docs else {
        return Err(McpError::new("Invalid", format!("propose_apply takes exactly one YAML document, not {}", docs.len())).hint("make one proposal per object"));
    };
    let s = |v: &Value, what: &str| v.as_str().filter(|x| !x.is_empty()).map(str::to_string).ok_or_else(|| McpError::new("Invalid", format!("the document has no {what}")));
    let api = s(&doc["apiVersion"], "apiVersion")?;
    let kind = s(&doc["kind"], "kind")?;
    let name = s(&doc["metadata"]["name"], "metadata.name")?;
    let namespace = s(&doc["metadata"]["namespace"], "metadata.namespace").map_err(|e| e.hint("set metadata.namespace explicitly"))?;
    if APPLY_DENIED.contains(&kind.as_str()) {
        return Err(McpError::new("PolicyDenied", format!("agents cannot propose applying a {kind}")));
    }
    check_name("name", &name)?;
    check_name("namespace", &namespace)?;
    let (group, version) = api.rsplit_once('/').map_or((String::new(), api.clone()), |(g, v)| (g.to_string(), v.to_string()));
    Ok((group, version, kind, name, namespace))
}

async fn propose_apply(state: &AppState, client: &str, p: ProposeApplyParams, r: &mut Redactor) -> R {
    let cx = access(state, p.context.as_deref(), Need::Propose)?;
    if p.yaml.len() > MAX_APPLY {
        return Err(McpError::new("Invalid", format!("the YAML is over {} KiB", MAX_APPLY / 1024)));
    }
    let docs: Vec<Json> = crate::objects::from_yaml(p.yaml.clone()).await.map_err(|e| McpError::new("Invalid", format!("not valid YAML: {}", clean_untrusted(&e.message, 300))))?;
    let docs: Vec<Json> = docs.into_iter().filter(|d| !d.is_null()).collect();
    let (group, version, kind, name, namespace) = apply_fields(&docs)?;
    let res = kinds(state, &cx, r).await?;
    let api = res.iter().find(|x| x.gvr.group == group && x.kind == kind).ok_or_else(|| McpError::new("Invalid", format!("unknown kind {kind} in {}", if group.is_empty() { "the core group" } else { &group })))?;
    if !api.namespaced {
        return Err(McpError::new("PolicyDenied", format!("{kind} is cluster-scoped; agents cannot propose applying it")));
    }
    cx.scope.check(&cx.context, Some(&namespace), true)?;
    let gvr = Gvr::new(&group, &version, &api.gvr.resource);
    can(state, &cx.context, "patch", gvr.clone(), None, Some(&namespace)).await?;
    // a server dry run is still a write request (admission webhooks see it): none on a read-only
    // context, where the human can only reject anyway
    let read_only = crate::ctxflags::effective(state, &cx.context).map(|f| f.read_only).unwrap_or(true);
    let dry_run = if read_only {
        "skipped: the context is read-only in kns".to_string()
    } else {
        match crate::mutate::apply_yaml(state, &cx.context, &p.yaml, &ApplyOptions { dry_run: Some(true), force: None }).await {
            Ok(_) => "ok".to_string(),
            Err(e) => r.text(&clean_untrusted(&e.message, 500)),
        }
    };
    let payload = ProposalPayload::Apply { context: cx.context.clone(), yaml: p.yaml.clone(), parsed: ApplyParsed { gvr, namespace, name, dry_run } };
    create(state, client, &cx.context, payload, p.reason.as_deref(), r)
}

// ───────────────────────── resources (kns://devset/<id>) ─────────────────────────

/// One dev set as agents see it (`list_dev_sets` row, `kns://devset/<id>`): `None` when the
/// client may not see it.
pub fn visible_set(state: &AppState, client: &str, set: &DevSet) -> Option<Json> {
    let cx = access(state, Some(&set.context), Need::Read).ok()?;
    scope_set(&cx, set).ok()?;
    let mut v = serde_json::to_value(set).ok()?;
    if let Some(m) = v.as_object_mut() {
        m.remove("connSecrets");
        m.remove("approvedSnapshot");
    }
    v["createdByYou"] = json!(own(set, client));
    v["approved"] = json!(set.approved_hash.as_deref() == Some(set.hash.as_str()));
    v["asInput"] = serde_json::to_value(arg_out(set)).unwrap_or(Value::Null);
    Some(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ipc::{McpPolicy, UiState},
        mcp,
    };

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

    fn discovery() -> Vec<ApiResource> {
        vec![
            res("", "pods", "Pod", &["po"]),
            res("", "services", "Service", &["svc"]),
            res("apps", "deployments", "Deployment", &["deploy"]),
            res("apps", "statefulsets", "StatefulSet", &["sts"]),
            res("batch", "cronjobs", "CronJob", &["cj"]),
            res("", "configmaps", "ConfigMap", &["cm"]),
        ]
    }

    fn stored_set(origin: DevSetOrigin) -> DevSet {
        let mut set = DevSet {
            id: "ds-1".into(),
            name: "orders-dev".into(),
            context: "default".into(),
            forwards: vec![DevForward {
                key: "kafka".into(),
                target: ForwardTarget::Service { namespace: "kafka".into(), name: "kafka".into() },
                remote_port: PortRef::Number(9094),
                local_port: 9094,
                pin: true,
                label: None,
            }],
            rewrites: vec![Rewrite { r#match: RewriteMatch { service: "kafka".into(), namespace: "kafka".into(), port: 9092 }, env_key: None, to: RewriteTo { forward: "kafka".into() } }],
            env: Some(EnvSpec {
                workload: Workload { gvr: Gvr::new("apps", "v1", "deployments"), namespace: "shop".into(), name: "orders".into() },
                container: Some("orders".into()),
                include: None,
                exclude: None,
                include_secrets: Some(vec!["DATABASE_URL".into()]),
                overrides: Some(vec![EnvOverride { key: "SPRING_KAFKA_CONSUMER_GROUP_ID".into(), value: "orders-local-me".into() }]),
                format: EnvFormat::Dotenv,
            }),
            auto_start: true,
            conn_secrets: Some(vec![]),
            origin,
            hash: String::new(),
            approved_hash: None,
            approved_snapshot: None,
            updated_at: "t".into(),
        };
        set.hash = devset::hash_of(&set);
        set
    }

    /// The draft an agent gets back parses as `save_dev_set` input and converts back unchanged.
    #[test]
    fn draft_round_trips_through_save_input() {
        let set = stored_set(DevSetOrigin::User);
        let out = serde_json::to_value(arg_out(&set)).unwrap();
        let params: SaveDevSetParams = serde_json::from_value(json!({ "set": out })).expect("the draft parses as save_dev_set input");
        let draft = draft_in(&params.set, "default", &discovery()).unwrap();
        assert_eq!(draft.forwards, set.forwards);
        assert_eq!(draft.rewrites, set.rewrites);
        let env = draft.env.unwrap();
        assert_eq!(env.workload, set.env.as_ref().unwrap().workload);
        assert_eq!(env.include_secrets, None, "agents never carry secret inclusion");
        assert!(!draft.auto_start && draft.conn_secrets.is_none());
        // the human-only fields are not even accepted
        for extra in ["autoStart", "connSecrets", "hash", "origin"] {
            let mut bad = serde_json::to_value(arg_out(&set)).unwrap();
            bad[extra] = json!(true);
            assert!(serde_json::from_value::<SaveDevSetParams>(json!({ "set": bad })).is_err(), "{extra}");
        }
        let mut bad = serde_json::to_value(arg_out(&set)).unwrap();
        bad["env"]["includeSecrets"] = json!(["DATABASE_URL"]);
        assert!(serde_json::from_value::<SaveDevSetParams>(json!({ "set": bad })).is_err(), "includeSecrets");
    }

    /// What the agent really gets is the scrubbed reply: it must still parse and convert back
    /// unchanged (the key rule would otherwise mask `envKey`).
    #[test]
    fn scrubbed_draft_round_trips() {
        let mut set = stored_set(DevSetOrigin::User);
        set.rewrites[0].env_key = Some("KAFKA_BOOTSTRAP_SERVERS".into());
        set.forwards[0].label = Some("kafka local".into());
        let mut v = json!({ "set": arg_out(&set), "warnings": ["DB_PASSWORD=hunter2 seen"] });
        let mut r = Redactor::new();
        scrub_set(&mut r, &mut v);
        assert!(!v["warnings"].to_string().contains("hunter2"), "warnings are still redacted");
        let params: SaveDevSetParams = serde_json::from_value(json!({ "set": v["set"] })).unwrap();
        let draft = draft_in(&params.set, "default", &discovery()).unwrap();
        assert_eq!(draft.forwards, set.forwards);
        assert_eq!(draft.rewrites, set.rewrites);
        assert_eq!(draft.env.unwrap().overrides, set.env.unwrap().overrides);
    }

    /// `kns://devset/<id>` and `list_dev_sets` never carry connection secrets or the snapshot, and
    /// a human set's override values go through the redactor.
    #[tokio::test]
    async fn visible_set_must_not_contain() {
        let (state, base) = mcp::testing::state("propose-visible").await;
        crate::uistate::publish(&state, UiState { context: Some("default".into()), connected: vec!["default".into()], ..Default::default() });
        mcp::policy_set(&state, "default", McpPolicy::Read, None).await.unwrap();
        let mut set = stored_set(DevSetOrigin::User);
        set.conn_secrets = Some(vec![crate::ipc::ConnSecret {
            forward: "kafka".into(),
            secret: crate::ipc::SecretKeyRef { namespace: "kafka".into(), name: "creds".into(), key: "s3cr3t-key-name".into() },
        }]);
        set.env.as_mut().unwrap().overrides = Some(vec![EnvOverride { key: "DATABASE_URL".into(), value: "postgres://app:s3cr3t-value@db:5432/x".into() }]);
        devset::approve(&mut set);
        let mut v = visible_set(&state, "claude-code", &set).unwrap();
        let mut r = Redactor::new();
        scrub_set(&mut r, &mut v);
        let s = v.to_string();
        for bad in ["s3cr3t-value", "s3cr3t-key-name", "connSecrets", "approvedSnapshot"] {
            assert!(!s.contains(bad), "{bad}: {s}");
        }
        assert_eq!(v["approved"], true);
        assert_eq!(v["createdByYou"], false);
        // policy off → not visible at all
        mcp::policy_set(&state, "default", McpPolicy::Off, None).await.unwrap();
        assert!(visible_set(&state, "claude-code", &set).is_none());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn targets_and_workloads_convert() {
        let d = discovery();
        let t = |kind: &str| TargetArg { kind: kind.into(), namespace: "ns".into(), name: "x".into() };
        assert!(matches!(target_in(&t("svc"), &d).unwrap(), ForwardTarget::Service { .. }));
        assert!(matches!(target_in(&t("Pod"), &d).unwrap(), ForwardTarget::Pod { .. }));
        assert!(matches!(target_in(&t("deploy"), &d).unwrap(), ForwardTarget::Workload { ref gvr, .. } if gvr.resource == "deployments"));
        assert_eq!(target_in(&t("configmaps"), &d).unwrap_err().code, "Invalid");
        assert_eq!(target_in(&TargetArg { kind: "svc".into(), namespace: "a/b".into(), name: "x".into() }, &d).unwrap_err().code, "Invalid");
        let w = |kind: &str| WorkloadArg { kind: kind.into(), namespace: "ns".into(), name: "x".into() };
        assert_eq!(workload_in(&w("cj"), &d).unwrap().gvr.resource, "cronjobs");
        assert_eq!(workload_in(&w("pod"), &d).unwrap().gvr.resource, "pods");
        assert!(workload_in(&w("svc"), &d).is_err());
        let back = target_out(&target_in(&t("deploy"), &d).unwrap());
        assert_eq!(back.kind, "deployments.apps");
        assert!(target_in(&back, &d).is_ok(), "target_out output converts back");
    }

    /// §6.5: agent-written specs in proposals pass the override rule of agent saves.
    #[test]
    fn proposals_apply_the_override_rule() {
        let ov = |k: &str, v: &str| vec![EnvOverride { key: k.into(), value: v.into() }];
        assert!(check_overrides(Some(&ov("SPRING_KAFKA_CONSUMER_GROUP_ID", "orders-local-me"))).is_ok());
        assert!(check_overrides(Some(&ov("SPRING_FLYWAY_ENABLED", "false"))).is_ok());
        for (k, v) in [("DATABASE_URL", "postgres://u@evil:5432/x"), ("KAFKA_BOOTSTRAP_SERVERS", "evil:9092"), ("SPRING_KAFKA_CONSUMER_GROUP_ID", "a/b")] {
            assert_eq!(check_overrides(Some(&ov(k, v))).unwrap_err().code, "Invalid", "{k}={v}");
        }
        // devSetUpdate: the same rule, the human's choices stay, the diff base is the current set
        let mut existing = stored_set(DevSetOrigin::User);
        devset::approve(&mut existing);
        let mut draft = devset::draft_of(&existing);
        draft.env.as_mut().unwrap().overrides = Some(ov("DATABASE_URL", "postgres://u@evil:5432/x"));
        assert_eq!(proposed_update(&existing, draft).unwrap_err().code, "Invalid");
        let mut draft = devset::draft_of(&existing);
        draft.forwards[0].local_port = 19094;
        draft.env.as_mut().unwrap().include_secrets = Some(vec!["API_PASSWORD".into()]);
        draft.auto_start = false;
        let p = proposed_update(&existing, draft).unwrap();
        assert_eq!(p.env.as_ref().unwrap().include_secrets, existing.env.as_ref().unwrap().include_secrets, "only the human's ticked keys");
        assert!(p.auto_start && p.conn_secrets.is_some(), "autoStart and connSecrets stay the human's");
        assert_eq!(p.approved_snapshot.as_ref().unwrap().hash, existing.hash, "diff against the current content");
        assert_ne!(p.hash, existing.hash);
        assert_eq!(p.hash, devset::hash_of(&p));
        // the human's picks do not follow the agent to another workload or target
        let mut human = existing.clone();
        human.conn_secrets = Some(vec![crate::ipc::ConnSecret {
            forward: "kafka".into(),
            secret: crate::ipc::SecretKeyRef { namespace: "kafka".into(), name: "creds".into(), key: "password".into() },
        }]);
        let mut moved_env = devset::draft_of(&human);
        moved_env.env.as_mut().unwrap().workload.name = "billing".into();
        moved_env.forwards[0].target = ForwardTarget::Service { namespace: "kafka".into(), name: "other".into() };
        let p = proposed_update(&human, moved_env).unwrap();
        assert_eq!(p.env.as_ref().unwrap().include_secrets, None, "ticked keys were for orders");
        assert_eq!(p.conn_secrets, None, "the Secret was picked for svc/kafka");
        let mut same = devset::draft_of(&human);
        same.forwards[0].local_port = 19094;
        let p = proposed_update(&human, same).unwrap();
        assert_eq!(p.conn_secrets, human.conn_secrets, "same target keeps the pick");
        // unchanged content and context moves are refused
        assert!(proposed_update(&existing, devset::draft_of(&existing)).is_err());
        let mut moved = devset::draft_of(&existing);
        moved.context = "staging".into();
        moved.forwards[0].local_port = 19094;
        assert!(proposed_update(&existing, moved).is_err());
    }

    #[test]
    fn apply_parsing() {
        let doc = |v: Value| vec![v];
        let ok = json!({ "apiVersion": "apps/v1", "kind": "Deployment", "metadata": { "name": "web", "namespace": "kns-spike" } });
        assert_eq!(apply_fields(&doc(ok.clone())).unwrap(), ("apps".into(), "v1".into(), "Deployment".into(), "web".into(), "kns-spike".into()));
        assert_eq!(apply_fields(&[ok.clone(), ok]).unwrap_err().code, "Invalid", "multi-doc refused");
        let no_ns = json!({ "apiVersion": "v1", "kind": "ConfigMap", "metadata": { "name": "x" } });
        assert!(apply_fields(&doc(no_ns)).unwrap_err().hint.unwrap().contains("namespace"));
        for kind in APPLY_DENIED {
            let d = json!({ "apiVersion": "v1", "kind": kind, "metadata": { "name": "x", "namespace": "a" } });
            assert_eq!(apply_fields(&doc(d)).unwrap_err().code, "PolicyDenied", "{kind}");
        }
        let core = json!({ "apiVersion": "v1", "kind": "Secret", "metadata": { "name": "x", "namespace": "a" } });
        assert_eq!(apply_fields(&doc(core)).unwrap().0, "");
        assert!(proposals::tier2_kind(&ProposalPayload::Apply {
            context: "c".into(),
            yaml: String::new(),
            parsed: ApplyParsed { gvr: Gvr::new("", "v1", "secrets"), namespace: "a".into(), name: "x".into(), dry_run: "ok".into() }
        }));
    }

    /// The authoring and proposal tools need policy `propose` and a connected context; the
    /// errors carry the codes and hints of §5.3.
    #[tokio::test]
    async fn policy_and_ownership_errors() {
        let (state, base) = mcp::testing::state("propose-policy").await;
        crate::uistate::publish(&state, UiState { context: Some("default".into()), connected: vec!["default".into()], ..Default::default() });
        let set = serde_json::to_value(arg_out(&stored_set(DevSetOrigin::User))).unwrap();
        let call = |tool: &'static str, args: Value| {
            let state = state.clone();
            async move { super::super::call(&state, "claude-code", tool, args).await.result }
        };
        // read only → PolicyDenied with the command to run
        mcp::policy_set(&state, "default", McpPolicy::Read, None).await.unwrap();
        let e = call("save_dev_set", json!({ "set": set })).await.unwrap_err();
        assert_eq!(e.code, "PolicyDenied");
        assert!(e.hint.unwrap().contains(":mcp policy propose default"));
        // an unknown set id is an error (no store in this test)
        assert!(call("propose_dev_set_up", json!({ "id": "ds-x" })).await.is_err());
        // allowlist: a set reaching kafka is refused before anything is saved
        mcp::policy_set(&state, "default", McpPolicy::Propose, Some(vec!["shop".into()])).await.unwrap();
        let mut fresh = set.clone();
        fresh.as_object_mut().unwrap().remove("id");
        assert_eq!(call("save_dev_set", json!({ "set": fresh })).await.unwrap_err().code, "PolicyDenied");
        // unknown fields are refused (an agent cannot sneak in autoStart)
        let mut sneaky = fresh.clone();
        sneaky["autoStart"] = json!(true);
        assert_eq!(call("save_dev_set", json!({ "set": sneaky })).await.unwrap_err().code, "Invalid");
        // exactly one of devSet / ref
        assert_eq!(call("propose_env_export", json!({})).await.unwrap_err().code, "Invalid");
        // a foreign proposal id is not found
        assert_eq!(call("cancel_proposal", json!({ "id": "p1" })).await.unwrap_err().code, "NotFound");
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn proposals_are_created_one_at_a_time_and_audited() {
        let (state, base) = mcp::testing::state("propose-create").await;
        let mut r = Redactor::new();
        let payload = || ProposalPayload::DevSetDelete { dev_set: "ds-1".into() };
        let first = create(&state, "claude-code", "default", payload(), Some("cleanup \u{202E}now"), &mut r).unwrap();
        assert_eq!(first.data["proposal"]["state"], "pending");
        assert_eq!(first.proposal_id.as_deref(), Some("p1"));
        let p = proposals::get(&state, "p1").unwrap();
        assert!(!p.reason.unwrap().contains('\u{202E}'), "the agent's note is cleaned");
        let e = create(&state, "claude-code", "default", payload(), None, &mut r).unwrap_err();
        assert_eq!(e.code, "RateLimited");
        assert!(e.hint.unwrap().contains("wait_proposal"));
        // another client is independent, and cannot see or cancel the first one's proposal
        assert!(create(&state, "other", "default", payload(), None, &mut r).is_ok());
        assert!(own_proposal(&state, "other", "p1").is_err());
        let _ = std::fs::remove_dir_all(base);
    }

    /// §6.6: tools and resources that take a dev-set, bundle or pack id check the policy before
    /// they read the store, and answer a missing id exactly like one the client may not see.
    #[tokio::test]
    async fn ids_are_no_existence_oracle() {
        let (state, base) = mcp::testing::state("propose-oracle").await;
        crate::uistate::publish(&state, UiState { context: Some("default".into()), connected: vec!["default".into(), "other".into()], ..Default::default() });
        // the store file written directly: `devset::save` would check the namespaces in a cluster
        let mut stored = stored_set(agent_origin("claude-code"));
        stored.name = "secret-name-dev".into();
        stored.context = "other".into();
        let real = stored.id.clone();
        std::fs::create_dir_all(base.join("devsets")).unwrap();
        std::fs::write(base.join("devsets").join("devsets.json"), json!({ "schema": 1, "sets": [stored] }).to_string()).unwrap();
        devset::use_dir(&state, base.join("devsets"));
        assert!(devset::get(&state, &real).await.unwrap().is_some());
        let missing = "ds-missing";
        // the error an agent sees, with the id it passed replaced (the message names it)
        let err = |id: &str, tool: &'static str, args: Value| {
            let state = state.clone();
            let id = id.to_string();
            async move {
                let e = super::super::call(&state, "claude-code", tool, args).await.result.unwrap_err();
                assert!(!e.message.contains("secret-name-dev") && !e.message.contains("other"), "{tool}: {e:?}");
                (e.code, e.message.replace(&id, "<id>"), e.hint)
            }
        };
        let tools = |id: &str| -> Vec<(&'static str, Value)> {
            vec![
                ("propose_dev_set_up", json!({ "id": id })),
                ("delete_dev_set", json!({ "id": id })),
                ("stop_dev_set", json!({ "id": id })),
                ("show_in_kns", json!({ "view": "devset", "devSet": id })),
                ("propose_env_export", json!({ "devSet": id, "format": "dotenv" })),
            ]
        };
        let res = |uri: String| {
            let state = state.clone();
            async move { crate::mcp::resources::read(&state, "claude-code", &uri).await.unwrap_err() }
        };
        // every policy off: the same denial whether the id exists or not, before any read
        for ((tool, a), (_, b)) in tools(&real).into_iter().zip(tools(missing)) {
            let (x, y) = (err(&real, tool, a).await, err(missing, tool, b).await);
            assert_eq!(x.0, "PolicyDenied", "{tool}");
            assert_eq!(x, y, "{tool}");
        }
        for scheme in ["devset", "bundle", "pack"] {
            let (x, y) = (res(format!("kns://{scheme}/{real}")).await, res(format!("kns://{scheme}/{missing}")).await);
            assert_eq!((x.code.as_str(), x.hint.clone()), ("PolicyDenied", y.hint.clone()), "{scheme}");
        }
        // propose on `default`, `other` off: a set in `other` answers like a missing one
        mcp::policy_set(&state, "default", McpPolicy::Propose, None).await.unwrap();
        for ((tool, a), (_, b)) in tools(&real).into_iter().zip(tools(missing)) {
            let (x, y) = (err(&real, tool, a).await, err(missing, tool, b).await);
            assert_eq!(x.0, "NotFound", "{tool}: {x:?}");
            assert_eq!(x, y, "{tool}");
        }
        let (x, y) = (res(format!("kns://devset/{real}")).await, res(format!("kns://devset/{missing}")).await);
        assert_eq!((x.code, x.message.replace(&real, "<id>"), x.hint), (y.code, y.message.replace(missing, "<id>"), y.hint));
        // saving over that id is NotFound too, not NotOwner naming the set
        let set = json!({ "id": real, "name": "x", "context": "default", "forwards": [], "rewrites": [] });
        assert_eq!(err(&real, "save_dev_set", json!({ "set": set })).await.0, "NotFound");
        // an allowlist that hides the set's namespace hides the set
        mcp::policy_set(&state, "other", McpPolicy::Propose, Some(vec!["shop".into()])).await.unwrap();
        let (x, y) = (err(&real, "propose_dev_set_up", json!({ "id": real })).await, err(missing, "propose_dev_set_up", json!({ "id": missing })).await);
        assert_eq!((x.0.as_str(), &x), ("NotFound", &y));
        // readable but not proposable: the usual PolicyDenied (list_dev_sets shows the set anyway)
        mcp::policy_set(&state, "other", McpPolicy::Read, None).await.unwrap();
        let e = super::super::call(&state, "claude-code", "propose_dev_set_up", json!({ "id": real })).await.result.unwrap_err();
        assert_eq!(e.code, "PolicyDenied");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn every_name_is_in_the_tool_table() {
        for n in NAMES {
            let def = crate::mcp::describe::find(n).unwrap_or_else(|| panic!("{n}"));
            let want = if *n == "show_in_kns" { Need::Read } else { Need::Propose };
            assert_eq!(def.need, want, "{n}");
        }
    }
}
