//! Dev sets: validation, ownership, hash, approval, up/down (§2.5). Owner: B-dev.
//! Rust is the single writer of `rust/devsets.json` (`{schema: 1, sets}`).
//!
//! - **Hash**: sha256 of the canonical JSON (keys sorted) of the whole set except `name`,
//!   `updatedAt`, `origin`, `approvedHash`, `hash`, `approvedSnapshot`; so it covers the context,
//!   every forward, rewrite, the env spec and `autoStart`.
//! - **Human saves** are approved as saved (`approvedHash = hash`, snapshot kept) and become the
//!   human's (`origin: user`).
//! - **Agent saves** may only update sets of the same client; `autoStart` is forced off,
//!   `connSecrets` and `env.includeSecrets` are stripped, namespaces must pass the context's
//!   allowlist, a set with an open proposal is refused, and the approval is cleared.
//! - **Up** refuses unless the caller shows the current hash (`NeedsApproval`). A human start of a
//!   set that is not approved happens after the approval list (the UI shows it and passes the hash
//!   it displayed), so a successful human `up` records the approval; so does an approved proposal.
//!   Forwards start in order; the first failure stops the ones already started and names the forward.
use std::{path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    events, forward,
    ipc::{
        BackendError, BackendEvent, ConnCopyRequest, ConnCopyResult, ConnInfo, ConnMemory, ConnSecret, DevForward, DevSet, DevSetDraft, DevSetOrigin,
        DevSetSaved, EnvSpec, Forward, ForwardOwner, ForwardQuery, ForwardTarget, Gvr, Json, ObjRef, ProposalPayload, ProposalState, Result,
        SecretKeyRef, SecretKeys, ServiceKind, ServicePort,
    },
    proposals::{self, GateTicket},
    rustfiles,
    session::api_path,
    state::{AppState, lock},
};

const FILE: &str = "devsets";
const SCHEMA: u32 = 1;
pub const MAX_FORWARDS: usize = 20;

/// Options of [`draft_from_workload`].
#[derive(Debug, Clone, Default)]
pub struct DraftOpts {
    pub name: String,
    /// dependency service names to include; `None` = all
    pub include: Option<Vec<String>>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoreFile {
    schema: u32,
    sets: Vec<DevSet>,
}

/// The loaded sets; `None` until first read. The async mutex serialises read-modify-write.
#[derive(Default)]
struct Store {
    sets: tokio::sync::Mutex<Option<Vec<DevSet>>>,
    /// tests: the directory instead of the app's `rust/`
    dir: Mutex<Option<PathBuf>>,
}

fn dir(state: &AppState) -> Result<PathBuf> {
    if let Some(d) = lock(&state.ext::<Store>().dir).clone() {
        return Ok(d);
    }
    rustfiles::dir(state.app().ok_or_else(|| BackendError::internal("dev sets need the app"))?)
}

#[cfg(test)]
pub(crate) fn use_dir(state: &AppState, d: PathBuf) {
    *lock(&state.ext::<Store>().dir) = Some(d);
}

async fn loaded(state: &AppState, slot: &mut Option<Vec<DevSet>>) -> Result<()> {
    if slot.is_none() {
        let file: Option<StoreFile> = rustfiles::read(&dir(state)?, FILE).await?;
        *slot = Some(file.map(|f| f.sets).unwrap_or_default());
    }
    Ok(())
}

/// Runs `f` on the sets; writes them back when it returns `changed = true`.
async fn with_sets<T>(state: &AppState, f: impl FnOnce(&mut Vec<DevSet>) -> Result<(T, bool)>) -> Result<T> {
    let store = state.ext::<Store>();
    let mut guard = store.sets.lock().await;
    loaded(state, &mut guard).await?;
    let sets = guard.as_mut().expect("loaded");
    let mut next = sets.clone();
    let (out, changed) = f(&mut next)?;
    if changed {
        rustfiles::write(&dir(state)?, FILE, &StoreFile { schema: SCHEMA, sets: next.clone() }).await?;
        *sets = next;
    }
    Ok(out)
}

// ───────────────────────── pure rules ─────────────────────────

fn canonical(v: Json) -> Json {
    match v {
        Json::Object(m) => {
            let mut keys: Vec<(String, Json)> = m.into_iter().collect();
            keys.sort_by(|a, b| a.0.cmp(&b.0));
            Json::Object(keys.into_iter().map(|(k, v)| (k, canonical(v))).collect())
        }
        Json::Array(a) => Json::Array(a.into_iter().map(canonical).collect()),
        other => other,
    }
}

/// sha256 (hex) of the set's content (see the module docs for what is left out).
pub fn hash_of(set: &DevSet) -> String {
    let mut v = serde_json::to_value(set).unwrap_or(Json::Null);
    if let Json::Object(m) = &mut v {
        for k in ["name", "updatedAt", "origin", "approvedHash", "hash", "approvedSnapshot"] {
            m.remove(k);
        }
    }
    let text = serde_json::to_string(&canonical(v)).unwrap_or_default();
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn slug(s: &str, max: usize) -> bool {
    (1..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// An override an agent may set: only the side-effect keys kns itself suggests (consumer group,
/// Streams application id, migrations), with a plain value (`orders-local-me`,
/// `com.example.app-local-me`, `false`). Anything else (`DATABASE_URL`, a broker list) could point
/// a local run at another host after the structured rewrites. Humans set anything.
pub fn agent_override_ok(key: &str, value: &str) -> bool {
    let plain = value.len() <= 200 && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'));
    plain && (crate::env::is_group_key(key) || crate::env::is_migration_key(key))
}

/// The rules that need no cluster: names, labels, caps, ports, keys, rewrite targets.
pub fn validate(d: &DevSetDraft) -> Result<()> {
    let bad = |m: String| Err(BackendError::invalid(m));
    if !slug(&d.name, 40) {
        return bad(format!("a set name is 1-40 of a-z 0-9 -, not \"{}\"", crate::redact::clean_untrusted(&d.name, 60)));
    }
    if d.context.trim().is_empty() {
        return bad("a set needs a context".into());
    }
    if d.forwards.len() > MAX_FORWARDS {
        return bad(format!("a set has at most {MAX_FORWARDS} forwards"));
    }
    let mut keys: Vec<&str> = Vec::new();
    let mut ports: Vec<u16> = Vec::new();
    for f in &d.forwards {
        if !slug(&f.key, 40) {
            return bad(format!("a forward key is 1-40 of a-z 0-9 -, not \"{}\"", crate::redact::clean_untrusted(&f.key, 60)));
        }
        if keys.contains(&f.key.as_str()) {
            return bad(format!("two forwards are called \"{}\"", f.key));
        }
        keys.push(&f.key);
        if f.local_port < 1024 {
            return bad(format!("forward {}: local port {} is below 1024", f.key, f.local_port));
        }
        if ports.contains(&f.local_port) {
            return bad(format!("local port {} is used twice", f.local_port));
        }
        ports.push(f.local_port);
        if let Some(l) = &f.label
            && !forward::valid_label(l)
        {
            return bad(format!("forward {}: a label is 1-40 of A-Z a-z 0-9 space . _ -", f.key));
        }
        if f.target.namespace().is_empty() || f.target.name().is_empty() {
            return bad(format!("forward {} has no target", f.key));
        }
    }
    for r in &d.rewrites {
        if !keys.contains(&r.to.forward.as_str()) {
            return bad(format!("a rewrite points at \"{}\", which is not a forward of the set", r.to.forward));
        }
        if r.r#match.port == 0 || r.r#match.service.is_empty() || r.r#match.namespace.is_empty() {
            return bad("a rewrite matches a Service, a namespace and a port".into());
        }
    }
    if let Some(env) = &d.env {
        if env.workload.namespace.is_empty() || env.workload.name.is_empty() {
            return bad("the env spec names no workload".into());
        }
        for o in env.overrides.iter().flatten() {
            if !crate::env::valid_key(&o.key) {
                return bad(format!("\"{}\" is not an env key", o.key));
            }
        }
    }
    Ok(())
}

/// The draft a stored set was saved from (for [`namespaces`] and re-validation).
pub fn draft_of(set: &DevSet) -> DevSetDraft {
    DevSetDraft {
        id: Some(set.id.clone()),
        name: set.name.clone(),
        context: set.context.clone(),
        forwards: set.forwards.clone(),
        rewrites: set.rewrites.clone(),
        env: set.env.clone(),
        auto_start: set.auto_start,
        conn_secrets: set.conn_secrets.clone(),
    }
}

/// Every namespace the set reaches (targets, rewrites, the env workload).
pub fn namespaces(d: &DevSetDraft) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let all = d
        .forwards
        .iter()
        .map(|f| f.target.namespace().to_string())
        .chain(d.rewrites.iter().map(|r| r.r#match.namespace.clone()))
        .chain(d.env.iter().map(|e| e.workload.namespace.clone()));
    for ns in all {
        if !out.contains(&ns) {
            out.push(ns);
        }
    }
    out
}

/// An agent's set may only reach namespaces of the context's allowlist (`None` = every namespace).
pub fn check_allowlist(namespaces: &[String], allowed: Option<&[String]>) -> Result<()> {
    if let Some(allowed) = allowed
        && let Some(ns) = namespaces.iter().find(|ns| !allowed.contains(ns))
    {
        return Err(BackendError::new(403, "PolicyDenied", format!("namespace {ns} is outside this context's allowlist")));
    }
    Ok(())
}

/// The set without its snapshot: what an approval stores.
pub fn snapshot(set: &DevSet) -> DevSet {
    DevSet { approved_snapshot: None, ..set.clone() }
}

/// Marks `set` approved as it is now.
pub fn approve(set: &mut DevSet) {
    set.approved_hash = Some(set.hash.clone());
    set.approved_snapshot = Some(Box::new(snapshot(set)));
}

/// What a save stores (pure part of [`save`]): ownership, stripping, hash and approval.
/// `existing`: the stored set with the draft's id; `open_proposal`: one is pending/reviewing.
pub fn apply_save(existing: Option<&DevSet>, draft: DevSetDraft, origin: DevSetOrigin, id: String, now: String, open_proposal: bool) -> Result<DevSet> {
    validate(&draft)?;
    let agent = matches!(origin, DevSetOrigin::Agent { .. });
    if let DevSetOrigin::Agent { client, .. } = &origin {
        if let Some(prev) = existing {
            let own = matches!(&prev.origin, DevSetOrigin::Agent { client: c, .. } if c == client);
            if !own {
                return Err(BackendError::new(
                    403,
                    "NotOwner",
                    format!("set \"{}\" was not created by {client}; save a copy under a new name, or propose the change", prev.name),
                ));
            }
        }
        if open_proposal {
            return Err(BackendError::new(409, "Conflict", "a proposal for this set is waiting for the human; wait for it or cancel it first"));
        }
    }
    let mut env = draft.env;
    if agent && let Some(e) = &mut env {
        e.include_secrets = None;
        // overrides are written last, after the structured rewrites: an agent's value must not be
        // able to point a local run at another host (`DATABASE_URL=postgres://…@elsewhere`)
        if let Some(o) = e.overrides.iter().flatten().find(|o| !agent_override_ok(&o.key, &o.value)) {
            return Err(BackendError::invalid(format!(
                "override {}: an agent may only override consumer-group, Streams application and migration keys, with a plain value (A-Z a-z 0-9 . _ -); ask the human to set it",
                o.key
            )));
        }
    }
    let mut set = DevSet {
        id,
        name: draft.name,
        context: draft.context,
        forwards: draft.forwards,
        rewrites: draft.rewrites,
        env,
        auto_start: !agent && draft.auto_start,
        conn_secrets: if agent { None } else { draft.conn_secrets },
        origin,
        hash: String::new(),
        approved_hash: None,
        approved_snapshot: None,
        updated_at: now,
    };
    set.hash = hash_of(&set);
    if agent {
        // an agent's update keeps the last approved content, for the "changed since" diff
        set.approved_snapshot = existing.and_then(|p| p.approved_snapshot.clone());
    } else {
        approve(&mut set);
    }
    Ok(set)
}

/// Sets that come up once after the first successful connect of `context`: opted in and approved
/// as they are.
pub fn autostart_sets<'a>(sets: &'a [DevSet], context: &str) -> Vec<&'a DevSet> {
    sets.iter().filter(|s| s.context == context && s.auto_start && s.approved_hash.as_deref() == Some(s.hash.as_str())).collect()
}

/// The forward query of one dev-set forward.
pub fn query_for(set: &DevSet, f: &DevForward) -> ForwardQuery {
    ForwardQuery {
        context: set.context.clone(),
        target: f.target.clone(),
        remote_port: f.remote_port.clone(),
        local_port: Some(f.local_port),
        pin: Some(f.pin),
        address: None,
        label: Some(f.label.clone().unwrap_or_else(|| f.key.clone())),
        dev_set: Some(set.id.clone()),
        proposal_id: None,
    }
}

fn now_iso() -> String {
    jiff::Timestamp::now().to_string()
}

// ───────────────────────── API ─────────────────────────

/// Saved sets, optionally of one context.
pub async fn list(state: &AppState, context: Option<&str>) -> Result<Vec<DevSet>> {
    with_sets(state, |sets| Ok((sets.iter().filter(|s| context.is_none_or(|c| s.context == c)).cloned().collect(), false))).await
}

/// One set; `Ok(None)` when it does not exist.
pub async fn get(state: &AppState, id: &str) -> Result<Option<DevSet>> {
    with_sets(state, |sets| Ok((sets.iter().find(|s| s.id == id).cloned(), false))).await
}

fn open_proposal_for(state: &AppState, id: &str) -> bool {
    proposals::list(state).iter().any(|p| {
        matches!(p.state, ProposalState::Pending | ProposalState::Reviewing)
            && matches!(&p.payload,
                ProposalPayload::DevSetUp { dev_set, .. } | ProposalPayload::DevSetDelete { dev_set } | ProposalPayload::DevSetUpdate { dev_set, .. }
                    if dev_set == id)
    })
}

/// The cluster checks of a save: every namespace exists, every rewrite names an existing Service
/// port; an agent's namespaces pass the context's allowlist.
async fn check_cluster(state: &AppState, d: &DevSetDraft, agent: bool) -> Result<()> {
    let namespaces = namespaces(d);
    if agent {
        let allowed = crate::mcp::stored_policy(state, &d.context).and_then(|p| p.namespaces);
        check_allowlist(&namespaces, allowed.as_deref())?;
        // §5.4: an agent call never builds a session (no credential plugin, no SSO)
        if !crate::mcp::connected(state, &d.context) {
            return Err(BackendError::new(409, "NotConnected", format!("context {} is not connected in kns; ask the human to open it", d.context)));
        }
    }
    let s = state.session(&d.context).await?;
    for ns in &namespaces {
        s.get(&api_path(&Gvr::new("", "v1", "namespaces"), None, Some(ns)))
            .await
            .map_err(|e| BackendError::invalid(format!("namespace {ns}: {}", e.message)))?;
    }
    for r in &d.rewrites {
        let m = &r.r#match;
        let svc = s
            .get(&api_path(&Gvr::new("", "v1", "services"), Some(&m.namespace), Some(&m.service)))
            .await
            .map_err(|e| BackendError::invalid(format!("rewrite: service {}/{}: {}", m.namespace, m.service, e.message)))?;
        if !forward::service_ports(&svc).iter().any(|p| p.port == m.port) {
            return Err(BackendError::invalid(format!("rewrite: service {}/{} has no port {}", m.namespace, m.service, m.port)));
        }
    }
    Ok(())
}

/// Validates and stores a set (humans and agents; agent rules per §2.5). Expires open proposals about
/// it when its content changed, and emits `devSets`.
pub async fn save(state: &AppState, draft: DevSetDraft, origin: DevSetOrigin) -> Result<DevSetSaved> {
    validate(&draft)?;
    let agent = matches!(origin, DevSetOrigin::Agent { .. });
    check_cluster(state, &draft, agent).await?;
    let open = draft.id.as_deref().is_some_and(|id| open_proposal_for(state, id));
    let new_id = state.next_id("ds-");
    let now = now_iso();
    let (set, changed_content) = with_sets(state, |sets| {
        let existing = draft.id.as_deref().and_then(|id| sets.iter().find(|s| s.id == id));
        if draft.id.is_some() && existing.is_none() {
            return Err(BackendError::new(404, "NotFound", "that dev set no longer exists"));
        }
        if sets.iter().any(|s| s.name == draft.name && s.context == draft.context && Some(&s.id) != draft.id.as_ref()) {
            return Err(BackendError::new(409, "Conflict", format!("a set named {} exists in {}", draft.name, draft.context)));
        }
        let id = existing.map_or_else(|| unique_id(&new_id, sets), |s| s.id.clone());
        let before = existing.map(|s| s.hash.clone());
        let set = apply_save(existing, draft, origin, id, now, open)?;
        let changed = before.as_deref() != Some(set.hash.as_str());
        match sets.iter_mut().find(|s| s.id == set.id) {
            Some(slot) => *slot = set.clone(),
            None => sets.push(set.clone()),
        }
        Ok(((set, changed), true))
    })
    .await?;
    if changed_content {
        proposals::expire_dev_set(state, &set.id);
    }
    events::emit(state, BackendEvent::DevSets { context: set.context.clone() });
    Ok(DevSetSaved { set, warnings: Vec::new() })
}

/// `ds-<n>` ids restart at 1 with the process: skip the ones the file already has.
fn unique_id(candidate: &str, sets: &[DevSet]) -> String {
    let mut id = candidate.to_string();
    let mut n = 0;
    while sets.iter().any(|s| s.id == id) {
        n += 1;
        id = format!("{candidate}-{n}");
    }
    id
}

/// The `dev_set_save` command: a human save, or step "update" of an approved `devSetUpdate`
/// proposal (the proposed content is stored as the human's, approved).
pub async fn save_command(state: &AppState, draft: DevSetDraft, proposal_id: Option<&str>) -> Result<DevSetSaved> {
    let Some(id) = proposal_id else { return save(state, draft, DevSetOrigin::User).await };
    let matches = |p: &ProposalPayload| matches!(p, ProposalPayload::DevSetUpdate { dev_set, proposed } if Some(dev_set) == draft.id.as_ref() && proposed.forwards == draft.forwards && proposed.rewrites == draft.rewrites && proposed.env == draft.env && proposed.context == draft.context
        // the human-only fields must be the ones the proposal carries (proposed_update keeps the
        // human's own), so a step cannot slip in other connection Secrets or autoStart
        && proposed.name == draft.name && proposed.auto_start == draft.auto_start && proposed.conn_secrets == draft.conn_secrets);
    let d = draft.clone();
    proposals::run_step(state, Some(id), "update", matches, async move { save(state, d, DevSetOrigin::User).await }).await
}

/// Deletes a set (stopping its forwards first); step "delete" of a `devSetDelete` proposal with
/// `proposal_id`.
pub async fn delete(state: &AppState, id: &str, proposal_id: Option<&str>) -> Result<()> {
    let matches = |p: &ProposalPayload| matches!(p, ProposalPayload::DevSetDelete { dev_set } if dev_set == id);
    proposals::run_step(state, proposal_id, "delete", matches, async {
        down(state, id).await?;
        let context = with_sets(state, |sets| {
            let before = sets.len();
            let context = sets.iter().find(|s| s.id == id).map(|s| s.context.clone());
            sets.retain(|s| s.id != id);
            Ok((context, sets.len() != before))
        })
        .await?;
        if let Some(context) = context {
            proposals::expire_dev_set(state, id);
            events::emit(state, BackendEvent::DevSets { context });
        }
        Ok(())
    })
    .await
}

/// Builds an unsaved set from a workload's dependencies (the `E` -> `s` path and H2's tool).
pub async fn draft_from_workload(state: &AppState, context: &str, obj_ref: &ObjRef, opts: DraftOpts) -> Result<DevSetSaved> {
    let report = crate::env::resolve_masked(state, context, obj_ref, None).await?;
    let deps: Vec<_> = report.deps.iter().filter(|d| opts.include.as_ref().is_none_or(|inc| inc.contains(&d.service.name))).collect();
    let ns = obj_ref.ns().unwrap_or_default().to_string();
    let env = EnvSpec {
        workload: crate::ipc::Workload { gvr: obj_ref.gvr.clone(), namespace: ns, name: obj_ref.name.clone() },
        container: Some(report.container.clone()),
        include: None,
        exclude: None,
        include_secrets: None,
        overrides: (!report.overrides.is_empty()).then(|| report.overrides.clone()),
        format: crate::ipc::EnvFormat::Dotenv,
    };
    let mut set = DevSet {
        id: String::new(),
        name: opts.name,
        context: context.into(),
        forwards: deps.iter().map(|d| d.suggested_forward.clone()).collect(),
        rewrites: deps.iter().map(|d| d.suggested_rewrite.clone()).collect(),
        env: Some(env),
        auto_start: false,
        conn_secrets: None,
        origin: DevSetOrigin::User,
        hash: String::new(),
        approved_hash: None,
        approved_snapshot: None,
        updated_at: now_iso(),
    };
    set.hash = hash_of(&set);
    let mut warnings = report.warnings.clone();
    warnings.extend(deps.iter().flat_map(|d| d.notes.iter().map(move |n| format!("{}: {n}", d.service.name))));
    Ok(DevSetSaved { set, warnings })
}

/// Starts the set's forwards in order; refuses (`NeedsApproval`) unless `hash` is current; owner
/// from the ticket when executing a proposal. A set already up returns its forwards.
pub async fn up(state: &AppState, id: &str, hash: &str, ticket: Option<&GateTicket>) -> Result<Vec<Forward>> {
    let set = get(state, id).await?.ok_or_else(|| BackendError::new(404, "NotFound", format!("dev set {id} not found")))?;
    if set.hash != hash {
        return Err(BackendError::new(409, "NeedsApproval", format!("dev set \"{}\" changed since it was shown; review it again", set.name)));
    }
    let running: Vec<Forward> = forward::list_forwards(state).await?.into_iter().filter(|f| f.dev_set.as_deref() == Some(id)).collect();
    if !running.is_empty() {
        return Ok(running);
    }
    let (owner, requested_by) = match ticket {
        Some(t) => (t.owner(), Some(t.client.clone())),
        None => (ForwardOwner::User, None),
    };
    let mut started: Vec<Forward> = Vec::new();
    for f in &set.forwards {
        match forward::start_with(state, query_for(&set, f), owner.clone(), requested_by.clone()).await {
            Ok(fw) => started.push(fw),
            Err(e) => {
                for s in &started {
                    let _ = forward::stop_forward(state, &s.id).await;
                }
                return Err(BackendError::new(e.code, e.reason.clone(), format!("forward {}: {}; nothing of set {} was started", f.key, e.message, set.name)));
            }
        }
    }
    if clear_failure(state, id) {
        events::emit(state, BackendEvent::DevSets { context: set.context.clone() });
    }
    // the human started exactly this content (after the approval list, or by approving a proposal)
    if set.approved_hash.as_deref() != Some(hash) {
        with_sets(state, |sets| {
            let changed = match sets.iter_mut().find(|s| s.id == id && s.hash == hash) {
                Some(s) => {
                    approve(s);
                    true
                }
                None => false,
            };
            Ok(((), changed))
        })
        .await?;
        events::emit(state, BackendEvent::DevSets { context: set.context.clone() });
    }
    Ok(started)
}

/// The `dev_set_up` command: a human start, or step "up" of an approved `devSetUp` proposal.
pub async fn up_command(state: &AppState, id: &str, hash: &str, proposal_id: Option<&str>) -> Result<Vec<Forward>> {
    let Some(pid) = proposal_id else { return up(state, id, hash, None).await };
    let ticket = proposals::gate(state, pid, "up")?;
    let ok = matches!(&ticket.payload, ProposalPayload::DevSetUp { dev_set, hash: h, .. } if dev_set == id && h == hash);
    if !ok {
        let e = BackendError::invalid(format!("the start does not match proposal {pid}"));
        let _ = proposals::finish_step(state, &ticket, Err(e.clone()));
        return Err(e);
    }
    let started = up(state, id, hash, Some(&ticket)).await;
    let data = started.as_ref().map(|fs| {
        serde_json::json!({ "forwards": fs.iter().map(|f| serde_json::json!({ "key": f.label, "localPort": f.local_port })).collect::<Vec<_>>() })
    });
    proposals::finish_step(state, &ticket, data.map_err(Clone::clone))?;
    started
}

/// Stops the set's forwards.
pub async fn down(state: &AppState, id: &str) -> Result<()> {
    for f in forward::list_forwards(state).await? {
        if f.dev_set.as_deref() == Some(id) {
            forward::stop_forward(state, &f.id).await?;
        }
    }
    Ok(())
}

// ───────────────────────── autoStart failures (shown in the UI, §6.6 d) ─────────────────────────

#[derive(Default)]
struct Failures(Mutex<Vec<crate::ipc::DevSetFailure>>);

/// Remembers that set `id` failed to come up by itself; the UI lists it (toast, Activity) until
/// the set comes up or the human clears it. The message is cleaned and redacted.
pub fn record_failure(state: &AppState, id: &str, name: &str, context: &str, message: &str) {
    let mut r = crate::redact::Redactor::new();
    let message = r.text(&crate::redact::clean_untrusted(message, 500));
    let f = crate::ipc::DevSetFailure { dev_set: id.into(), name: crate::redact::clean_untrusted(name, 120), context: context.into(), message, at: jiff::Timestamp::now().to_string() };
    {
        let store = state.ext::<Failures>();
        let mut list = lock(&store.0);
        list.retain(|x| x.dev_set != id);
        list.push(f);
    }
    events::emit(state, BackendEvent::DevSets { context: context.into() });
}

fn clear_failure(state: &AppState, id: &str) -> bool {
    let store = state.ext::<Failures>();
    let mut list = lock(&store.0);
    let before = list.len();
    list.retain(|x| x.dev_set != id);
    before != list.len()
}

/// The failures still to show, after dropping `clear`.
pub fn failures(state: &AppState, clear: &[String]) -> Vec<crate::ipc::DevSetFailure> {
    let store = state.ext::<Failures>();
    let mut list = lock(&store.0);
    list.retain(|x| !clear.contains(&x.dev_set));
    list.clone()
}

/// Brings up the `autoStart` sets of `context` that are approved as they are. Call once after the
/// first successful connect of a context (integrator: from `session::connect`). Failures are
/// returned per set; nothing is retried.
pub async fn autostart(state: &AppState, context: &str) -> Vec<(String, Result<Vec<Forward>>)> {
    let sets = list(state, Some(context)).await.unwrap_or_default();
    let mut out = Vec::new();
    for s in autostart_sets(&sets, context) {
        let r = up(state, &s.id, &s.hash, None).await;
        if let Err(e) = &r {
            record_failure(state, &s.id, &s.name, context, &e.message);
        }
        out.push((s.name.clone(), r));
    }
    out
}

/// Forward targets of a set as text (for messages): `svc/kafka:9094`.
pub fn target_text(t: &ForwardTarget) -> String {
    match t {
        ForwardTarget::Pod { name, .. } => format!("pod/{name}"),
        ForwardTarget::Service { name, .. } => format!("svc/{name}"),
        ForwardTarget::Workload { gvr, name, .. } => format!("{}/{name}", gvr.resource),
    }
}

// ───────────────────────── connection strings (B2, `pf.copyUrl`) ─────────────────────────

/// Picks for forwards outside an approved set, until the forward stops: forward id -> Secret key.
#[derive(Default)]
struct ConnPicks(Mutex<std::collections::HashMap<String, SecretKeyRef>>);

/// `set` with `secret` as the connection Secret of its forward `key`, re-approved. Only an approved,
/// unchanged set takes one (else storing it would approve content nobody reviewed); the pick is
/// human-only, so agent saves strip it again.
pub fn apply_conn_secret(set: &DevSet, key: &str, secret: SecretKeyRef) -> Result<DevSet> {
    if set.approved_hash.as_deref() != Some(set.hash.as_str()) {
        return Err(BackendError::new(409, "NeedsApproval", format!("dev set {} changed since it was approved; start it once to review it", set.name)));
    }
    if !set.forwards.iter().any(|f| f.key == key) {
        return Err(BackendError::new(404, "NotFound", format!("dev set {} has no forward {key}", set.name)));
    }
    let mut next = set.clone();
    let mut list: Vec<ConnSecret> = next.conn_secrets.take().unwrap_or_default().into_iter().filter(|c| c.forward != key).collect();
    list.push(ConnSecret { forward: key.to_string(), secret });
    next.conn_secrets = Some(list);
    next.updated_at = now_iso();
    next.hash = hash_of(&next);
    approve(&mut next);
    Ok(next)
}

/// The set forward a running forward came from (dev-set starts label it with the key or label).
pub fn set_forward_key(set: &DevSet, f: &Forward) -> Option<String> {
    set.forwards.iter().find(|d| d.target == f.target && f.label.as_deref() == Some(d.label.as_deref().unwrap_or(&d.key))).map(|d| d.key.clone())
}

async fn forward_set(state: &AppState, f: &Forward) -> Result<Option<(DevSet, String)>> {
    let Some(id) = &f.dev_set else { return Ok(None) };
    let Some(set) = get(state, id).await? else { return Ok(None) };
    Ok(set_forward_key(&set, f).map(|k| (set, k)))
}

fn remembered(state: &AppState, f: &Forward, set: Option<&(DevSet, String)>) -> Option<(SecretKeyRef, ConnMemory)> {
    let in_set = set.and_then(|(s, k)| s.conn_secrets.iter().flatten().find(|c| &c.forward == k)).map(|c| (c.secret.clone(), ConnMemory::Set));
    in_set.or_else(|| {
        let picks = state.ext::<ConnPicks>();
        let mut map = lock(&picks.0);
        // forget picks of forwards that stopped
        let running: Vec<String> = state.forwards().keys().cloned().collect();
        map.retain(|id, _| running.contains(id));
        map.get(&f.id).cloned().map(|s| (s, ConnMemory::Forward))
    })
}

/// The kind of what a forward reaches: the Service's detected kind, else by port.
async fn forward_kind(state: &AppState, f: &Forward) -> ServiceKind {
    if let ForwardTarget::Service { namespace, name } = &f.target {
        let r = ObjRef { context: f.context.clone(), gvr: Gvr::new("", "v1", "services"), namespace: Some(namespace.clone()), name: name.clone() };
        if let Ok(i) = crate::service::info(state, &f.context, &r).await {
            return i.kind;
        }
    }
    let port = f.resolved_port.or(match f.remote_port {
        crate::ipc::PortRef::Number(n) => Some(n),
        crate::ipc::PortRef::Name(_) => None,
    });
    let ports: Vec<ServicePort> = port
        .map(|p| ServicePort { name: None, port: p, target_port: crate::ipc::PortRef::Number(p), protocol: "TCP".into(), app_protocol: None })
        .into_iter()
        .collect();
    crate::service::detect_kind(&ports, &[])
}

fn running(state: &AppState, id: &str) -> Result<Forward> {
    forward::get(state, id).ok_or_else(|| BackendError::new(404, "NotFound", format!("forward {id} is not running")))
}

/// What `C` knows about a forward: kind, plain URL, the remembered pick and where it lives.
pub async fn conn_info(state: &AppState, id: &str) -> Result<ConnInfo> {
    let f = running(state, id)?;
    let kind = forward_kind(state, &f).await;
    let set = forward_set(state, &f).await?;
    let rem = remembered(state, &f, set.as_ref());
    Ok(ConnInfo {
        forward: f.id.clone(),
        kind,
        plain: crate::addr::conn_plain(kind, &crate::addr::local_host(&f.address), f.local_port),
        remembered: rem.as_ref().map(|r| r.0.clone()),
        memory: rem.map(|r| r.1),
        dev_set_approved: set.as_ref().map(|(s, _)| s.approved_hash.as_deref() == Some(s.hash.as_str())),
        dev_set: set.map(|(s, _)| s.id),
    })
}

/// Secrets of a namespace with their key names and type (values never leave Rust). Helm release
/// records are left out.
pub async fn conn_secrets_list(state: &AppState, context: &str, namespace: &str) -> Result<Vec<SecretKeys>> {
    let list = state.session(context).await?.get(&api_path(&Gvr::new("", "v1", "secrets"), Some(namespace), None)).await?;
    let mut out: Vec<SecretKeys> = list
        .get("items")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let name = s.pointer("/metadata/name")?.as_str()?.to_string();
            let type_ = s.get("type").and_then(Json::as_str).unwrap_or("Opaque").to_string();
            if type_ == "helm.sh/release.v1" {
                return None;
            }
            let mut keys: Vec<String> = s.get("data").and_then(Json::as_object).map(|m| m.keys().cloned().collect()).unwrap_or_default();
            keys.sort();
            Some(SecretKeys { name: crate::redact::clean_untrusted(&name, 256), type_: crate::redact::clean_untrusted(&type_, 256), keys })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Stores a pick: in the forward's set when it is approved, else for this forward until it stops.
async fn remember(state: &AppState, f: &Forward, set: Option<&(DevSet, String)>, secret: &SecretKeyRef) -> Result<ConnMemory> {
    if let Some((s, key)) = set
        && s.approved_hash.as_deref() == Some(s.hash.as_str())
    {
        if open_proposal_for(state, &s.id) {
            return Err(BackendError::new(409, "Conflict", format!("an agent request about {} is open; answer it first", s.name)));
        }
        let (id, key, secret) = (s.id.clone(), key.clone(), secret.clone());
        let saved = with_sets(state, |sets| {
            let slot = sets.iter_mut().find(|x| x.id == id).ok_or_else(|| BackendError::new(404, "NotFound", "that dev set no longer exists"))?;
            *slot = apply_conn_secret(slot, &key, secret)?;
            Ok((slot.clone(), true))
        })
        .await?;
        proposals::expire_dev_set(state, &saved.id);
        events::emit(state, BackendEvent::DevSets { context: saved.context.clone() });
        return Ok(ConnMemory::Set);
    }
    lock(&state.ext::<ConnPicks>().0).insert(f.id.clone(), secret.clone());
    Ok(ConnMemory::Forward)
}

/// `pf.copyUrl`: builds the forward's connection string. Without a Secret the plain text goes back
/// for the UI to copy; with one, Rust reads the key, builds the string and writes it to the
/// clipboard (history/cloud exclusion, cleared later); the UI gets a masked preview only.
pub async fn conn_copy(state: &AppState, req: ConnCopyRequest) -> Result<ConnCopyResult> {
    let f = running(state, &req.forward)?;
    let kind = forward_kind(state, &f).await;
    let host = crate::addr::local_host(&f.address);
    let set = forward_set(state, &f).await?;
    if let Some(p) = &req.secret
        && p.namespace != f.namespace
    {
        return Err(BackendError::invalid(format!("the Secret must be in the forward's namespace {}", f.namespace)));
    }
    let pick = if req.plain == Some(true) { None } else { req.secret.clone().or_else(|| remembered(state, &f, set.as_ref()).map(|r| r.0)) };
    let Some(p) = pick else {
        let text = crate::addr::conn_plain(kind, &host, f.local_port);
        return Ok(ConnCopyResult { preview: text.clone(), copied: false, text: Some(text), secret: None, clear_seconds: None, history_excluded: None, remembered: None });
    };
    let obj = state.session(&f.context).await?.get(&api_path(&Gvr::new("", "v1", "secrets"), Some(&p.namespace), Some(&p.name))).await?;
    let data = crate::env::object_data(&obj, true);
    let value = data.get(&p.key).ok_or_else(|| BackendError::new(404, "NotFound", format!("secret {} has no key {}", p.name, p.key)))?;
    let keys: Vec<String> = data.keys().cloned().collect();
    let user = crate::addr::user_key(&p.key, &keys).filter(|k| *k != p.key).and_then(|k| data.get(k));
    let text = crate::addr::conn_string(kind, &host, f.local_port, Some(value), user.map(String::as_str));
    let preview = crate::addr::conn_preview(kind, &host, f.local_port, Some(value));
    let secs = req.clear_seconds.unwrap_or(60);
    let written = crate::clip::write_secret(&text, crate::clip::clear_after(u64::from(secs)))?;
    // only a pick that worked is kept
    let remembered_in = match (&req.secret, req.remember) {
        (Some(p), Some(true)) => Some(remember(state, &f, set.as_ref(), p).await?),
        _ => None,
    };
    Ok(ConnCopyResult {
        preview,
        copied: true,
        text: None,
        secret: Some(p),
        clear_seconds: Some(secs.clamp(5, 600)),
        history_excluded: Some(written.excluded),
        remembered: remembered_in,
    })
}

pub mod cmd {
    use super::AppState;
    use crate::ipc::{ConnCopyRequest, ConnCopyResult, ConnInfo, DevSet, DevSetDraft, DevSetSaved, Forward, Result, SecretKeys};

    /// B2: Secrets of a namespace with their key names (no values).
    #[tauri::command]
    pub async fn conn_secrets_list(state: tauri::State<'_, AppState>, context: String, namespace: String) -> Result<Vec<SecretKeys>> {
        super::conn_secrets_list(&state, &context, &namespace).await
    }

    /// B2 `pf.copyUrl`: what `C` knows about a forward.
    #[tauri::command]
    pub async fn forward_conn_info(state: tauri::State<'_, AppState>, forward: String) -> Result<ConnInfo> {
        super::conn_info(&state, &forward).await
    }

    /// B2 `pf.copyUrl`: copies the connection string (Rust writes the clipboard when a Secret is used).
    #[tauri::command]
    pub async fn forward_conn_copy(state: tauri::State<'_, AppState>, req: ConnCopyRequest) -> Result<ConnCopyResult> {
        super::conn_copy(&state, req).await
    }

    /// autoStart failures still to show; `clear` drops those set ids first.
    #[tauri::command]
    pub fn dev_set_failures(state: tauri::State<'_, AppState>, clear: Option<Vec<String>>) -> Vec<crate::ipc::DevSetFailure> {
        super::failures(&state, &clear.unwrap_or_default())
    }

    #[tauri::command]
    pub async fn dev_sets_list(state: tauri::State<'_, AppState>, context: Option<String>) -> Result<Vec<DevSet>> {
        super::list(&state, context.as_deref()).await
    }

    #[tauri::command]
    pub async fn dev_set_save(state: tauri::State<'_, AppState>, set: DevSetDraft, proposal_id: Option<String>) -> Result<DevSetSaved> {
        super::save_command(&state, set, proposal_id.as_deref()).await
    }

    #[tauri::command]
    pub async fn dev_set_delete(state: tauri::State<'_, AppState>, id: String, proposal_id: Option<String>) -> Result<()> {
        super::delete(&state, &id, proposal_id.as_deref()).await
    }

    #[tauri::command]
    pub async fn dev_set_up(state: tauri::State<'_, AppState>, id: String, hash: String, proposal_id: Option<String>) -> Result<Vec<Forward>> {
        super::up_command(&state, &id, &hash, proposal_id.as_deref()).await
    }

    #[tauri::command]
    pub async fn dev_set_down(state: tauri::State<'_, AppState>, id: String) -> Result<()> {
        super::down(&state, &id).await
    }
}

#[cfg(test)]
mod tests {
    /// §6.6 d: an autoStart failure is kept (cleaned, redacted) until cleared.
    #[test]
    fn autostart_failures_are_kept_until_cleared() {
        let state = AppState::default();
        let rlo = char::from_u32(0x202e).unwrap();
        record_failure(&state, "ds-1", &format!("dev {rlo}set"), "default", "forward db: password=s3cr3t-value refused");
        record_failure(&state, "ds-2", "other", "default", "local port 9094 is taken");
        let first = failures(&state, &[]);
        assert!(!first[0].name.contains(rlo) && !first[0].message.contains("s3cr3t"), "{first:?}");
        record_failure(&state, "ds-1", "dev set", "default", "again");
        let list = failures(&state, &[]);
        assert_eq!((list.len(), list[1].message.as_str()), (2, "again"), "one row per set, newest last");
        assert_eq!(failures(&state, &["ds-2".into()]).len(), 1);
        assert!(clear_failure(&state, "ds-1"));
        assert!(failures(&state, &[]).is_empty());
    }

    use super::*;
    use crate::ipc::{EnvFormat, PortRef, Rewrite, RewriteMatch, RewriteTo, Workload};

    fn fwd(key: &str, port: u16) -> DevForward {
        DevForward {
            key: key.into(),
            target: ForwardTarget::Service { namespace: "kafka".into(), name: key.into() },
            remote_port: PortRef::Number(port),
            local_port: port + 10000,
            pin: true,
            label: None,
        }
    }

    fn draft() -> DevSetDraft {
        DevSetDraft {
            id: None,
            name: "orders-dev".into(),
            context: "default".into(),
            forwards: vec![fwd("kafka", 9094), fwd("postgres", 5432)],
            rewrites: vec![Rewrite {
                r#match: RewriteMatch { service: "kafka".into(), namespace: "kafka".into(), port: 9092 },
                env_key: None,
                to: RewriteTo { forward: "kafka".into() },
            }],
            env: Some(EnvSpec {
                workload: Workload { gvr: Gvr::new("apps", "v1", "deployments"), namespace: "shop".into(), name: "orders".into() },
                container: None,
                include: None,
                exclude: None,
                include_secrets: Some(vec!["DATABASE_URL".into()]),
                overrides: None,
                format: EnvFormat::Dotenv,
            }),
            auto_start: true,
            conn_secrets: None,
        }
    }

    fn agent(client: &str) -> DevSetOrigin {
        DevSetOrigin::Agent { client: client.into(), at: "2026-11-22T10:00:00Z".into() }
    }

    fn save_as(existing: Option<&DevSet>, d: DevSetDraft, origin: DevSetOrigin) -> Result<DevSet> {
        apply_save(existing, d, origin, "ds-1".into(), "2026-11-22T10:00:00Z".into(), false)
    }

    #[test]
    fn validation_rules() {
        assert!(validate(&draft()).is_ok());
        let mut d = draft();
        d.name = "Orders Dev".into();
        assert!(validate(&d).is_err(), "name");
        let mut d = draft();
        d.forwards[1].local_port = d.forwards[0].local_port;
        assert!(validate(&d).unwrap_err().message.contains("used twice"));
        let mut d = draft();
        d.forwards[1].key = "kafka".into();
        assert!(validate(&d).unwrap_err().message.contains("two forwards"));
        let mut d = draft();
        d.forwards[0].local_port = 80;
        assert!(validate(&d).unwrap_err().message.contains("below 1024"));
        let mut d = draft();
        d.forwards[0].label = Some("a/b".into());
        assert!(validate(&d).is_err(), "label");
        let mut d = draft();
        d.rewrites[0].to.forward = "nope".into();
        assert!(validate(&d).unwrap_err().message.contains("not a forward of the set"));
        let mut d = draft();
        d.forwards = (0..21).map(|i| fwd(&format!("f{i}"), 2000 + i)).collect();
        d.rewrites.clear();
        assert!(validate(&d).unwrap_err().message.contains("at most 20"));
        let mut d = draft();
        d.env.as_mut().unwrap().overrides = Some(vec![crate::ipc::EnvOverride { key: "BAD KEY".into(), value: "x".into() }]);
        assert!(validate(&d).is_err(), "override key");
        assert_eq!(namespaces(&draft()), vec!["kafka".to_string(), "shop".to_string()]);
    }

    #[test]
    fn allowlist() {
        let ns = namespaces(&draft());
        assert!(check_allowlist(&ns, None).is_ok());
        assert!(check_allowlist(&ns, Some(&["kafka".into(), "shop".into()])).is_ok());
        assert_eq!(check_allowlist(&ns, Some(&["kafka".into()])).unwrap_err().reason, "PolicyDenied", "the env workload's namespace counts too");
    }

    #[test]
    fn human_saves_are_approved_and_kept() {
        let set = save_as(None, draft(), DevSetOrigin::User).unwrap();
        assert!(set.auto_start);
        assert_eq!(set.approved_hash.as_deref(), Some(set.hash.as_str()));
        assert_eq!(set.approved_snapshot.as_ref().unwrap().hash, set.hash);
        assert!(set.approved_snapshot.as_ref().unwrap().approved_snapshot.is_none());
        assert_eq!(set.env.as_ref().unwrap().include_secrets.as_deref(), Some(&["DATABASE_URL".to_string()][..]));
    }

    #[test]
    fn agent_saves_are_stripped_and_unapproved() {
        let mut d = draft();
        d.conn_secrets = Some(vec![]);
        let set = save_as(None, d, agent("claude-code")).unwrap();
        assert!(!set.auto_start, "autoStart forced off");
        assert!(set.conn_secrets.is_none());
        assert!(set.env.as_ref().unwrap().include_secrets.is_none(), "includeSecrets stripped");
        assert!(set.approved_hash.is_none());
        // an agent may override only side-effect keys, with a plain value; a human anything
        let ov = |k: &str, v: &str| {
            let mut d = draft();
            d.env.as_mut().unwrap().overrides = Some(vec![crate::ipc::EnvOverride { key: k.into(), value: v.into() }]);
            d
        };
        for (k, v) in [("DATABASE_URL", "postgres://u@evil:5432/db"), ("KAFKA_BOOTSTRAP_SERVERS", "evil.example"), ("SPRING_KAFKA_CONSUMER_GROUP_ID", "host:9092"), ("SPRING_KAFKA_CONSUMER_GROUP_ID", "a/b")] {
            assert_eq!(save_as(None, ov(k, v), agent("claude-code")).unwrap_err().reason, "Invalid", "{k}={v}");
        }
        // kns's own suggestions pass, dotted group ids included
        assert!(save_as(None, ov("SPRING_KAFKA_CONSUMER_GROUP_ID", "com.example.orders-local-me"), agent("claude-code")).is_ok());
        assert!(save_as(None, ov("SPRING_FLYWAY_ENABLED", "false"), agent("claude-code")).is_ok());
        assert!(save_as(None, ov("DATABASE_URL", "postgres://localhost:5432/x"), DevSetOrigin::User).is_ok());
        // the same client may update it; the hash covers the change
        let mut d2 = draft();
        d2.id = Some(set.id.clone());
        d2.forwards[0].local_port = 29094;
        let updated = save_as(Some(&set), d2.clone(), agent("claude-code")).unwrap();
        assert_ne!(updated.hash, set.hash);
        // another client may not, nor may an agent touch a human set
        assert_eq!(save_as(Some(&set), d2.clone(), agent("other")).unwrap_err().reason, "NotOwner");
        let human = save_as(None, draft(), DevSetOrigin::User).unwrap();
        assert_eq!(save_as(Some(&human), d2.clone(), agent("claude-code")).unwrap_err().reason, "NotOwner");
        // refused while its proposal waits
        let open = apply_save(Some(&set), d2, agent("claude-code"), "ds-1".into(), "t".into(), true);
        assert_eq!(open.unwrap_err().reason, "Conflict");
    }

    #[test]
    fn agent_update_of_an_approved_set_keeps_the_snapshot_for_the_diff() {
        let mut set = save_as(None, draft(), agent("claude-code")).unwrap();
        approve(&mut set);
        let mut d = draft();
        d.id = Some(set.id.clone());
        d.forwards.pop();
        let updated = save_as(Some(&set), d, agent("claude-code")).unwrap();
        assert!(updated.approved_hash.is_none(), "approval cleared");
        assert_eq!(updated.approved_snapshot.as_ref().unwrap().hash, set.hash, "the last approved content stays for the diff");
    }

    #[test]
    fn hash_covers_content_not_name_or_origin() {
        let a = save_as(None, draft(), DevSetOrigin::User).unwrap();
        let mut renamed = draft();
        renamed.name = "other-name".into();
        assert_eq!(save_as(None, renamed, agent("x")).map(|s| s.hash).unwrap(), {
            // agent strips includeSecrets: compare against a human save without it
            let mut d = draft();
            d.env.as_mut().unwrap().include_secrets = None;
            d.auto_start = false;
            save_as(None, d, DevSetOrigin::User).unwrap().hash
        });
        for change in [
            |d: &mut DevSetDraft| d.context = "staging".into(),
            |d: &mut DevSetDraft| d.auto_start = false,
            |d: &mut DevSetDraft| d.env.as_mut().unwrap().format = EnvFormat::Posix,
            |d: &mut DevSetDraft| d.forwards[0].pin = false,
            |d: &mut DevSetDraft| d.rewrites[0].env_key = Some("X".into()),
        ] {
            let mut d = draft();
            change(&mut d);
            assert_ne!(save_as(None, d, DevSetOrigin::User).unwrap().hash, a.hash);
        }
    }

    #[test]
    fn hash_is_pinned() {
        // canonical JSON, keys sorted: a change of field order or serde layout shows up here
        let set = save_as(None, draft(), DevSetOrigin::User).unwrap();
        assert_eq!(set.hash.len(), 64);
        assert_eq!(set.hash, hash_of(&set));
        assert_eq!(set.hash, "b5a5ef71fb1383c31397c5500df3c57119a2f48b603381565d54783ab8934881", "update when the contract changes on purpose");
    }

    #[test]
    fn autostart_only_approved_unchanged_sets() {
        let mut a = save_as(None, draft(), DevSetOrigin::User).unwrap();
        let mut b = a.clone();
        b.id = "ds-2".into();
        b.hash = "changed".into();
        let mut c = a.clone();
        c.id = "ds-3".into();
        c.auto_start = false;
        let all = vec![a.clone(), b, c];
        assert_eq!(autostart_sets(&all, "default").iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec![a.id.as_str()]);
        assert!(autostart_sets(&all, "staging").is_empty());
        a.approved_hash = None;
        assert!(autostart_sets(&[a], "default").is_empty());
    }

    #[test]
    fn forward_queries_carry_the_set() {
        let set = save_as(None, draft(), DevSetOrigin::User).unwrap();
        let q = query_for(&set, &set.forwards[0]);
        assert_eq!((q.local_port, q.pin, q.dev_set.as_deref(), q.label.as_deref()), (Some(19094), Some(true), Some(set.id.as_str()), Some("kafka")));
    }

    fn pick(key: &str) -> SecretKeyRef {
        SecretKeyRef { namespace: "kafka".into(), name: "pg".into(), key: key.into() }
    }

    #[test]
    fn conn_secrets_are_human_only_and_in_the_hash() {
        let mut d = draft();
        d.conn_secrets = Some(vec![ConnSecret { forward: "postgres".into(), secret: pick("PASSWORD") }]);
        let human = save_as(None, d.clone(), DevSetOrigin::User).unwrap();
        assert_eq!(human.conn_secrets.as_ref().map(Vec::len), Some(1));
        let without = save_as(None, draft(), DevSetOrigin::User).unwrap();
        assert_ne!(human.hash, without.hash, "a pick changes the hash");
        let agent_set = save_as(None, d, agent("claude-code")).unwrap();
        assert!(agent_set.conn_secrets.is_none(), "stripped on agent saves");
    }

    #[test]
    fn a_pick_is_stored_only_in_an_approved_set() {
        let set = save_as(None, draft(), DevSetOrigin::User).unwrap();
        let next = apply_conn_secret(&set, "postgres", pick("PASSWORD")).unwrap();
        assert_ne!(next.hash, set.hash);
        assert_eq!(next.approved_hash.as_deref(), Some(next.hash.as_str()), "re-approved as it is");
        assert_eq!(next.conn_secrets.as_ref().unwrap()[0].secret.key, "PASSWORD");
        let again = apply_conn_secret(&next, "postgres", pick("DATABASE_URL")).unwrap();
        assert_eq!(again.conn_secrets.as_ref().unwrap().len(), 1, "replaced, not added");
        assert_eq!(apply_conn_secret(&set, "nope", pick("x")).unwrap_err().reason, "NotFound");
        let unapproved = save_as(None, draft(), agent("claude-code")).unwrap();
        assert_eq!(apply_conn_secret(&unapproved, "postgres", pick("x")).unwrap_err().reason, "NeedsApproval");
    }

    #[test]
    fn running_forwards_map_to_set_forwards() {
        let set = save_as(None, draft(), DevSetOrigin::User).unwrap();
        let q = query_for(&set, &set.forwards[1]);
        let f = Forward {
            id: "f1".into(),
            context: q.context.clone(),
            target: q.target.clone(),
            pod: "p".into(),
            namespace: "kafka".into(),
            resolved_pod: None,
            remote_port: q.remote_port.clone(),
            resolved_port: None,
            local_port: 15432,
            address: "127.0.0.1".into(),
            connections: 0,
            status: crate::ipc::ForwardStatus::Active,
            message: None,
            label: q.label.clone(),
            dev_set: q.dev_set.clone(),
            owner: ForwardOwner::User,
            requested_by: None,
            started_at: 0,
            idle_stop_at: None,
        };
        assert_eq!(set_forward_key(&set, &f).as_deref(), Some("postgres"));
        assert_eq!(set_forward_key(&set, &Forward { label: Some("other".into()), ..f }), None);
    }

    #[tokio::test]
    async fn store_round_trip_and_human_up_approval() {
        let state = AppState::default();
        let d = std::env::temp_dir().join(format!("kns-devset-{}", std::process::id()));
        use_dir(&state, d.clone());
        assert!(list(&state, None).await.unwrap().is_empty());
        // write an agent set straight into the store (save() needs a cluster for its checks)
        let set = save_as(None, draft(), agent("claude-code")).unwrap();
        with_sets(&state, |sets| {
            sets.push(set.clone());
            Ok(((), true))
        })
        .await
        .unwrap();
        // a fresh state reads the file
        let other = AppState::default();
        use_dir(&other, d.clone());
        let back = get(&other, &set.id).await.unwrap().unwrap();
        assert_eq!(back.hash, set.hash);
        // up with a stale hash is refused before anything starts
        assert_eq!(up(&other, &set.id, "stale", None).await.unwrap_err().reason, "NeedsApproval");
        let _ = std::fs::remove_dir_all(&d);
    }
}
