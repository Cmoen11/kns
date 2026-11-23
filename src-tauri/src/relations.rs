//! Relations tree: owners, owned objects, traffic, uses (§3 C3).
//!
//! `relations(ref)` returns one tree rooted at the object:
//! - **owner**: the controller chain upward (pod → ReplicaSet → Deployment), then the Flux object
//!   that applied the top one (`kustomize.toolkit.fluxcd.io/*`, `helm.toolkit.fluxcd.io/*` labels)
//!   and its source. Each owner is the child of the one below it.
//! - **owned**: what it controls (Deployment → ReplicaSets → pods, CronJob → Jobs → pods).
//! - **traffic**: Services that select its pods and the Ingresses in front of them; for a Service its
//!   pods and Ingresses; for an Ingress its backend Services and their pods.
//! - **uses**: ConfigMaps, Secrets, PVCs and the ServiceAccount named by the pod spec (references
//!   only: Secret bodies are never read, existence comes from metadata).
//!
//! Node and depth caps keep a large namespace cheap; a forbidden side read becomes a node status.
//! Every status passes the Redactor and `clean_untrusted`. The pure helpers are tested in
//! `relations/tests.rs`.
use std::collections::HashSet;

use crate::{
    ipc::{BackendError, Gvr, Json, ObjRef, RelationKind, RelationNode, Result, take_array},
    redact::{MAX_LINE, Redactor, clean_untrusted},
    session::{Session, api_path, with_query},
    state::AppState,
};

/// Children per node.
pub const MAX_CHILDREN: usize = 20;
/// Nodes per tree.
pub const MAX_NODES: usize = 150;
/// Owner levels followed upward (controller chain + Flux + source).
pub const MAX_OWNER_DEPTH: usize = 6;

fn s(v: &Json) -> &str {
    v.as_str().unwrap_or_default()
}

fn arr(v: &Json) -> &[Json] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}

pub fn name_of(o: &Json) -> &str {
    s(&o["metadata"]["name"])
}

fn uid_of(o: &Json) -> &str {
    s(&o["metadata"]["uid"])
}

// ───────────────────────── kinds ─────────────────────────

/// Built-in kinds kns knows without discovery: (group, version, resource, Kind).
const KNOWN: &[(&str, &str, &str, &str)] = &[
    ("", "v1", "pods", "Pod"),
    ("", "v1", "services", "Service"),
    ("", "v1", "configmaps", "ConfigMap"),
    ("", "v1", "secrets", "Secret"),
    ("", "v1", "persistentvolumeclaims", "PersistentVolumeClaim"),
    ("", "v1", "serviceaccounts", "ServiceAccount"),
    ("apps", "v1", "deployments", "Deployment"),
    ("apps", "v1", "replicasets", "ReplicaSet"),
    ("apps", "v1", "statefulsets", "StatefulSet"),
    ("apps", "v1", "daemonsets", "DaemonSet"),
    ("batch", "v1", "jobs", "Job"),
    ("batch", "v1", "cronjobs", "CronJob"),
    ("networking.k8s.io", "v1", "ingresses", "Ingress"),
];

/// Flux kinds by resource (their versions vary by cluster, so they come from discovery).
const FLUX_KINDS: &[(&str, &str)] = &[
    ("kustomizations", "Kustomization"),
    ("helmreleases", "HelmRelease"),
    ("gitrepositories", "GitRepository"),
    ("ocirepositories", "OCIRepository"),
    ("helmrepositories", "HelmRepository"),
    ("helmcharts", "HelmChart"),
    ("buckets", "Bucket"),
];

pub fn kind_of(gvr: &Gvr) -> String {
    KNOWN
        .iter()
        .find(|(g, _, r, _)| *g == gvr.group && *r == gvr.resource)
        .map(|k| k.3.to_string())
        .or_else(|| FLUX_KINDS.iter().find(|(r, _)| gvr.group.ends_with(".toolkit.fluxcd.io") && *r == gvr.resource).map(|k| k.1.to_string()))
        .unwrap_or_else(|| {
            // fallback: singular, capitalised (`kustomizations` → `Kustomization`)
            let one = gvr.resource.strip_suffix("ies").map(|x| format!("{x}y")).or_else(|| gvr.resource.strip_suffix('s').map(str::to_string)).unwrap_or_else(|| gvr.resource.clone());
            let mut c = one.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        })
}

pub fn known_gvr(kind: &str) -> Option<Gvr> {
    KNOWN.iter().find(|k| k.3 == kind).map(|(g, v, r, _)| Gvr::new(g, v, r))
}

fn gvr(group: &str, resource: &str) -> Gvr {
    KNOWN.iter().find(|(g, _, r, _)| *g == group && *r == resource).map(|(g, v, r, _)| Gvr::new(g, v, r)).unwrap_or_else(|| Gvr::new(group, "v1", resource))
}

// ───────────────────────── pure helpers ─────────────────────────

/// The controller owner reference (or the first one): (apiVersion, kind, name).
pub fn owner_ref(o: &Json) -> Option<(String, String, String)> {
    let refs = arr(&o["metadata"]["ownerReferences"]);
    let r = refs.iter().find(|r| r["controller"].as_bool() == Some(true)).or_else(|| refs.first())?;
    Some((s(&r["apiVersion"]).to_string(), s(&r["kind"]).to_string(), s(&r["name"]).to_string()))
}

/// The Flux object that applied this one, from its labels: (group, Kind, name, namespace).
pub fn flux_owner(o: &Json) -> Option<(&'static str, &'static str, String, String)> {
    let l = &o["metadata"]["labels"];
    for (prefix, group, kind) in [
        ("kustomize.toolkit.fluxcd.io", "kustomize.toolkit.fluxcd.io", "Kustomization"),
        ("helm.toolkit.fluxcd.io", "helm.toolkit.fluxcd.io", "HelmRelease"),
    ] {
        if let (Some(name), Some(ns)) = (l[format!("{prefix}/name")].as_str(), l[format!("{prefix}/namespace")].as_str()) {
            return Some((group, kind, name.to_string(), ns.to_string()));
        }
    }
    None
}

/// The pod spec of a pod or of a workload template.
pub fn pod_spec(o: &Json) -> Option<&Json> {
    [&o["spec"]["template"]["spec"], &o["spec"]["jobTemplate"]["spec"]["template"]["spec"], &o["spec"]]
        .into_iter()
        .find(|s| s["containers"].is_array())
}

/// The labels of the pods it runs (template labels, or the pod's own).
pub fn pod_labels(o: &Json) -> Option<&Json> {
    [&o["spec"]["template"]["metadata"]["labels"], &o["spec"]["jobTemplate"]["spec"]["template"]["metadata"]["labels"]]
        .into_iter()
        .find(|l| l.is_object())
        .or_else(|| o["spec"]["containers"].is_array().then_some(&o["metadata"]["labels"]))
}

/// ConfigMaps, Secrets, PVCs and the ServiceAccount named by a pod spec: (Kind, name), deduplicated, in order.
pub fn uses_of(spec: &Json) -> Vec<(&'static str, String)> {
    let mut out: Vec<(&'static str, String)> = Vec::new();
    let mut add = |kind: &'static str, name: &str| {
        if !name.is_empty() && !out.iter().any(|(k, n)| *k == kind && n == name) {
            out.push((kind, name.to_string()));
        }
    };
    for list in ["initContainers", "containers"] {
        for c in arr(&spec[list]) {
            for e in arr(&c["envFrom"]) {
                add("ConfigMap", s(&e["configMapRef"]["name"]));
                add("Secret", s(&e["secretRef"]["name"]));
            }
            for e in arr(&c["env"]) {
                add("ConfigMap", s(&e["valueFrom"]["configMapKeyRef"]["name"]));
                add("Secret", s(&e["valueFrom"]["secretKeyRef"]["name"]));
            }
        }
    }
    for v in arr(&spec["volumes"]) {
        add("ConfigMap", s(&v["configMap"]["name"]));
        add("Secret", s(&v["secret"]["secretName"]));
        add("PersistentVolumeClaim", s(&v["persistentVolumeClaim"]["claimName"]));
        for src in arr(&v["projected"]["sources"]) {
            add("ConfigMap", s(&src["configMap"]["name"]));
            add("Secret", s(&src["secret"]["name"]));
        }
    }
    for p in arr(&spec["imagePullSecrets"]) {
        add("Secret", s(&p["name"]));
    }
    let sa = spec["serviceAccountName"].as_str().or_else(|| spec["serviceAccount"].as_str()).unwrap_or("default");
    add("ServiceAccount", sa);
    out
}

/// A Service's plain selector matches these labels (an empty selector selects nothing).
pub fn service_selects(svc: &Json, labels: &Json) -> bool {
    let Some(sel) = svc["spec"]["selector"].as_object().filter(|m| !m.is_empty()) else { return false };
    sel.iter().all(|(k, v)| labels[k].as_str().is_some() && labels[k] == *v)
}

/// The Services an Ingress sends traffic to (default backend and rules), deduplicated.
pub fn ingress_services(ing: &Json) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |b: &Json| {
        if let Some(n) = b["service"]["name"].as_str()
            && !out.iter().any(|x| x == n)
        {
            out.push(n.to_string());
        }
    };
    add(&ing["spec"]["defaultBackend"]);
    for r in arr(&ing["spec"]["rules"]) {
        for p in arr(&r["http"]["paths"]) {
            add(&p["backend"]);
        }
    }
    out
}

fn ready_count(o: &Json) -> Option<(i64, i64)> {
    let st = &o["status"];
    let desired = o["spec"]["replicas"].as_i64().or_else(|| st["desiredNumberScheduled"].as_i64())?;
    let ready = st["readyReplicas"].as_i64().or_else(|| st["numberReady"].as_i64()).unwrap_or(0);
    Some((ready, desired))
}

/// A short status word for a node: `Running 1/1`, `2/3 ready`, `Ready`, `Bound`, `missing`.
pub fn status_of(kind: &str, o: &Json) -> Option<String> {
    if o.is_null() {
        return Some("missing".into());
    }
    let st = &o["status"];
    let cond = |t: &str| arr(&st["conditions"]).iter().find(|c| c["type"] == t).map(|c| s(&c["status"]).to_string());
    match kind {
        "Pod" => {
            let cs = arr(&st["containerStatuses"]);
            let ready = cs.iter().filter(|c| c["ready"].as_bool() == Some(true)).count();
            let waiting = cs.iter().find_map(|c| c["state"]["waiting"]["reason"].as_str());
            let phase = waiting.unwrap_or_else(|| s(&st["phase"]));
            Some(if cs.is_empty() { phase.to_string() } else { format!("{phase} {ready}/{}", cs.len()) })
        }
        "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet" => ready_count(o).map(|(r, d)| format!("{r}/{d} ready")),
        "Service" => Some(o["spec"]["type"].as_str().unwrap_or("ClusterIP").to_string()),
        "PersistentVolumeClaim" => st["phase"].as_str().map(str::to_string),
        "Job" => {
            if cond("Complete").as_deref() == Some("True") {
                Some("Complete".into())
            } else if cond("Failed").as_deref() == Some("True") {
                Some("Failed".into())
            } else {
                Some(format!("{} active", st["active"].as_i64().unwrap_or(0)))
            }
        }
        "CronJob" => Some(if o["spec"]["suspend"].as_bool() == Some(true) { "suspended".into() } else { s(&o["spec"]["schedule"]).to_string() }),
        "Ingress" => {
            let hosts: Vec<&str> = arr(&o["spec"]["rules"]).iter().filter_map(|r| r["host"].as_str()).take(2).collect();
            (!hosts.is_empty()).then(|| hosts.join(", "))
        }
        _ => match cond("Ready").as_deref() {
            Some("True") => Some(if o["spec"]["suspend"].as_bool() == Some(true) { "Ready · suspended".into() } else { "Ready".into() }),
            Some("False") => Some("not Ready".into()),
            Some(_) => Some("reconciling".into()),
            None => None,
        },
    }
}

// ───────────────────────── tree building ─────────────────────────

struct Builder {
    nodes: usize,
    seen: HashSet<(String, String, String, String)>,
    redactor: Redactor,
}

impl Builder {
    fn new() -> Self {
        Self { nodes: 1, seen: HashSet::new(), redactor: Redactor::new() }
    }

    /// A node, or None when the cap is reached or the object is already in the tree (cycle guard).
    fn node(&mut self, r: &ObjRef, relation: RelationKind, status: Option<String>) -> Option<RelationNode> {
        let key = (r.gvr.group.clone(), r.gvr.resource.clone(), r.namespace.clone().unwrap_or_default(), r.name.clone());
        if self.nodes >= MAX_NODES || !self.seen.insert(key) {
            return None;
        }
        self.nodes += 1;
        let status = status.map(|x| clean_untrusted(&self.redactor.text(&x), MAX_LINE));
        Some(RelationNode { obj_ref: r.clone(), kind: kind_of(&r.gvr), relation, status, children: vec![] })
    }

    fn root(&mut self, r: &ObjRef, o: &Json) -> RelationNode {
        let key = (r.gvr.group.clone(), r.gvr.resource.clone(), r.namespace.clone().unwrap_or_default(), r.name.clone());
        self.seen.insert(key);
        let kind = kind_of(&r.gvr);
        let status = status_of(&kind, o).map(|x| clean_untrusted(&self.redactor.text(&x), MAX_LINE));
        RelationNode { obj_ref: r.clone(), kind, relation: RelationKind::Self_, status, children: vec![] }
    }
}

fn child_ref(base: &ObjRef, gvr: Gvr, namespace: Option<&str>, name: &str) -> ObjRef {
    ObjRef { context: base.context.clone(), gvr, namespace: namespace.map(str::to_string), name: name.to_string() }
}

// ───────────────────────── fetch ─────────────────────────

struct Ctx<'a> {
    session: &'a Session,
    base: &'a ObjRef,
    b: Builder,
    /// per-namespace lists, read once
    services: Option<Option<Vec<Json>>>,
    ingresses: Option<Option<Vec<Json>>>,
}

async fn list(session: &Session, gvr: &Gvr, ns: Option<&str>, selector: Option<&str>) -> Result<Vec<Json>> {
    let params: Vec<(&str, &str)> = selector.map(|sel| vec![("labelSelector", sel)]).unwrap_or_default();
    Ok(take_array(&mut session.get(&with_query(&api_path(gvr, ns, None), &params)).await?, "items"))
}

fn not_read(e: &BackendError) -> String {
    match e.code {
        403 => "not readable (forbidden)".into(),
        404 => "missing".into(),
        _ => "not read".into(),
    }
}

impl Ctx<'_> {
    async fn services(&mut self) -> Option<&Vec<Json>> {
        if self.services.is_none() {
            let ns = self.base.namespace.clone();
            self.services = Some(list(self.session, &gvr("", "services"), ns.as_deref(), None).await.ok());
        }
        self.services.as_ref().and_then(Option::as_ref)
    }

    async fn ingresses(&mut self) -> Option<&Vec<Json>> {
        if self.ingresses.is_none() {
            let ns = self.base.namespace.clone();
            self.ingresses = Some(list(self.session, &gvr("networking.k8s.io", "ingresses"), ns.as_deref(), None).await.ok());
        }
        self.ingresses.as_ref().and_then(Option::as_ref)
    }

    async fn gvr_of_kind(&self, api_version: Option<&str>, group: &str, kind: &str) -> Option<Gvr> {
        if let Some(g) = known_gvr(kind)
            && (group.is_empty() || g.group == group)
        {
            return Some(g);
        }
        let d = self.session.discovery(None).await.ok()?;
        if let Some(av) = api_version {
            let (g, v) = av.split_once('/').unwrap_or(("", av));
            if let Some(r) = d.by_kind(g, v, kind) {
                return Some(r.gvr.clone());
            }
        }
        d.preferred.iter().find(|r| r.gvr.group == group && r.kind == kind).map(|r| r.gvr.clone())
    }

    /// The owner chain above `o` (each the child of the previous), ending in Flux and its source.
    async fn owners(&mut self, r: &ObjRef, o: &Json, depth: usize) -> Option<RelationNode> {
        if depth >= MAX_OWNER_DEPTH {
            return None;
        }
        // controller chain
        if let Some((av, kind, name)) = owner_ref(o) {
            let group = av.split_once('/').map(|(g, _)| g).unwrap_or("");
            let gvr = self.gvr_of_kind(Some(&av), group, &kind).await?;
            let oref = child_ref(self.base, gvr.clone(), r.ns(), &name);
            let (obj, status) = match self.session.get(&api_path(&gvr, r.ns(), Some(&name))).await {
                Ok(v) => {
                    let st = status_of(&kind, &v);
                    (v, st)
                }
                Err(e) => (Json::Null, Some(not_read(&e))),
            };
            let mut node = self.b.node(&oref, RelationKind::Owner, status)?;
            if !obj.is_null()
                && let Some(up) = Box::pin(self.owners(&oref, &obj, depth + 1)).await
            {
                node.children.push(up);
            }
            return Some(node);
        }
        // Flux applied it
        if let Some((group, kind, name, ns)) = flux_owner(o) {
            let gvr = self.gvr_of_kind(None, group, kind).await?;
            let fref = child_ref(self.base, gvr.clone(), Some(&ns), &name);
            let (obj, status) = match self.session.get(&api_path(&gvr, Some(&ns), Some(&name))).await {
                Ok(v) => {
                    let st = status_of(kind, &v);
                    (v, st)
                }
                Err(e) => (Json::Null, Some(not_read(&e))),
            };
            let mut node = self.b.node(&fref, RelationKind::Owner, status)?;
            if !obj.is_null() {
                if let Some(src) = self.source(&fref, &obj).await {
                    node.children.push(src);
                }
                // a Kustomization applied by another one
                if let Some(up) = Box::pin(self.owners(&fref, &obj, depth + 1)).await {
                    node.children.push(up);
                }
            }
            return Some(node);
        }
        None
    }

    async fn source(&mut self, fref: &ObjRef, o: &Json) -> Option<RelationNode> {
        let (av, kind, name, ns) = crate::diagnose::flux_source_ref(o)?;
        let gvr = self.gvr_of_kind(av.as_deref(), "source.toolkit.fluxcd.io", &kind).await?;
        let ns = ns.or_else(|| fref.namespace.clone());
        let sref = child_ref(self.base, gvr.clone(), ns.as_deref(), &name);
        let status = match self.session.get(&api_path(&gvr, ns.as_deref(), Some(&name))).await {
            Ok(v) => status_of(&kind, &v),
            Err(e) => Some(not_read(&e)),
        };
        self.b.node(&sref, RelationKind::Owner, status)
    }

    /// Children `o` controls: pods / ReplicaSets / Jobs it owns, two levels down.
    async fn owned(&mut self, r: &ObjRef, o: &Json, depth: usize) -> Vec<RelationNode> {
        let kind = kind_of(&r.gvr);
        let child_gvr = match kind.as_str() {
            "Deployment" => gvr("apps", "replicasets"),
            "CronJob" => gvr("batch", "jobs"),
            "ReplicaSet" | "StatefulSet" | "DaemonSet" | "Job" => gvr("", "pods"),
            _ => return vec![],
        };
        let sel = crate::diagnose::selector_string(&o["spec"]["selector"]);
        let items = match list(self.session, &child_gvr, r.ns(), if kind == "CronJob" { None } else { sel.as_deref() }).await {
            Ok(v) => v,
            Err(_) => return vec![],
        };
        let uid = uid_of(o);
        let mut mine: Vec<Json> = items.into_iter().filter(|x| arr(&x["metadata"]["ownerReferences"]).iter().any(|o| s(&o["uid"]) == uid)).collect();
        // Deployments: the ReplicaSets that still run pods, newest first
        if kind == "Deployment" {
            mine.retain(|x| x["spec"]["replicas"].as_i64().unwrap_or(0) > 0 || x["status"]["replicas"].as_i64().unwrap_or(0) > 0);
        }
        mine.sort_by_key(|x| std::cmp::Reverse(s(&x["metadata"]["creationTimestamp"]).to_string()));
        let mut out = Vec::new();
        for x in mine.into_iter().take(MAX_CHILDREN) {
            let cref = child_ref(self.base, child_gvr.clone(), r.ns(), name_of(&x));
            let ck = kind_of(&child_gvr);
            let Some(mut node) = self.b.node(&cref, RelationKind::Owned, status_of(&ck, &x)) else { continue };
            if depth == 0 {
                node.children = Box::pin(self.owned(&cref, &x, 1)).await;
            }
            out.push(node);
        }
        out
    }

    async fn ingress_nodes(&mut self, svc_name: &str) -> Vec<RelationNode> {
        let ings: Vec<Json> = self.ingresses().await.map(|v| v.iter().filter(|i| ingress_services(i).iter().any(|n| n == svc_name)).cloned().collect()).unwrap_or_default();
        let ns = self.base.namespace.clone();
        let mut out = Vec::new();
        for i in ings.into_iter().take(MAX_CHILDREN) {
            let iref = child_ref(self.base, gvr("networking.k8s.io", "ingresses"), ns.as_deref(), name_of(&i));
            if let Some(n) = self.b.node(&iref, RelationKind::Traffic, status_of("Ingress", &i)) {
                out.push(n);
            }
        }
        out
    }

    async fn pods_of_selector(&mut self, svc: &Json) -> Vec<RelationNode> {
        let Some(sel) = crate::diagnose::selector_string(&svc["spec"]["selector"]) else { return vec![] };
        let ns = self.base.namespace.clone();
        let pods = list(self.session, &gvr("", "pods"), ns.as_deref(), Some(&sel)).await.unwrap_or_default();
        let mut out = Vec::new();
        for p in pods.iter().take(MAX_CHILDREN) {
            let pref = child_ref(self.base, gvr("", "pods"), ns.as_deref(), name_of(p));
            if let Some(n) = self.b.node(&pref, RelationKind::Traffic, status_of("Pod", p)) {
                out.push(n);
            }
        }
        out
    }

    /// Services that select these labels, each with its Ingresses.
    async fn traffic_for_labels(&mut self, labels: &Json) -> Vec<RelationNode> {
        let svcs: Vec<Json> = self.services().await.map(|v| v.iter().filter(|x| service_selects(x, labels)).cloned().collect()).unwrap_or_default();
        let ns = self.base.namespace.clone();
        let mut out = Vec::new();
        for svc in svcs.into_iter().take(MAX_CHILDREN) {
            let sref = child_ref(self.base, gvr("", "services"), ns.as_deref(), name_of(&svc));
            let Some(mut node) = self.b.node(&sref, RelationKind::Traffic, status_of("Service", &svc)) else { continue };
            node.children = self.ingress_nodes(name_of(&svc)).await;
            out.push(node);
        }
        out
    }

    async fn traffic(&mut self, r: &ObjRef, o: &Json) -> Vec<RelationNode> {
        match kind_of(&r.gvr).as_str() {
            "Service" => {
                let mut out = self.ingress_nodes(&r.name).await;
                out.extend(self.pods_of_selector(o).await);
                out
            }
            "Ingress" => {
                let ns = self.base.namespace.clone();
                let mut out = Vec::new();
                for name in ingress_services(o).into_iter().take(MAX_CHILDREN) {
                    let sref = child_ref(self.base, gvr("", "services"), ns.as_deref(), &name);
                    let (svc, status) = match self.session.get(&api_path(&sref.gvr, ns.as_deref(), Some(&name))).await {
                        Ok(v) => {
                            let st = status_of("Service", &v);
                            (v, st)
                        }
                        Err(e) => (Json::Null, Some(not_read(&e))),
                    };
                    let Some(mut node) = self.b.node(&sref, RelationKind::Traffic, status) else { continue };
                    if !svc.is_null() {
                        node.children = self.pods_of_selector(&svc).await;
                    }
                    out.push(node);
                }
                out
            }
            _ => match pod_labels(o) {
                Some(l) => self.traffic_for_labels(&l.clone()).await,
                None => vec![],
            },
        }
    }

    async fn uses(&mut self, o: &Json) -> Vec<RelationNode> {
        let Some(spec) = pod_spec(o) else { return vec![] };
        let ns = self.base.namespace.clone();
        let mut out = Vec::new();
        for (kind, name) in uses_of(spec).into_iter().take(MAX_CHILDREN) {
            let Some(g) = known_gvr(kind) else { continue };
            let uref = child_ref(self.base, g.clone(), ns.as_deref(), &name);
            // metadata only: a Secret's values never reach kns
            let uri = api_path(&g, ns.as_deref(), Some(&name));
            let status = match self.session.get_as::<Json>(&uri, "application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1").await {
                Ok(_) if kind == "PersistentVolumeClaim" => match self.session.get(&uri).await {
                    Ok(v) => status_of(kind, &v),
                    Err(_) => None,
                },
                Ok(_) => None,
                Err(e) => Some(not_read(&e)),
            };
            if let Some(n) = self.b.node(&uref, RelationKind::Uses, status) {
                out.push(n);
            }
        }
        out
    }
}

pub async fn relations(state: &AppState, r: &ObjRef) -> Result<RelationNode> {
    let session = state.session(&r.context).await?;
    let o = crate::objects::get(&session, r).await?;
    let mut ctx = Ctx { session: &session, base: r, b: Builder::new(), services: None, ingresses: None };
    let mut root = ctx.b.root(r, &o);
    if let Some(up) = ctx.owners(r, &o, 0).await {
        root.children.push(up);
    }
    let owned = ctx.owned(r, &o, 0).await;
    root.children.extend(owned);
    let traffic = ctx.traffic(r, &o).await;
    root.children.extend(traffic);
    let uses = ctx.uses(&o).await;
    root.children.extend(uses);
    Ok(root)
}

pub mod cmd {
    use crate::ipc::{ObjRef, RelationNode, Result};
    use crate::state::AppState;

    #[tauri::command]
    pub async fn relations(state: tauri::State<'_, AppState>, obj_ref: ObjRef) -> Result<RelationNode> {
        super::relations(&state, &obj_ref).await
    }
}

#[cfg(test)]
mod tests;
