//! `:routes`: the HTTP routes of a namespace or a context, and where each one ends
//! (docs/tools.md#routes).
//!
//! Reads Ingresses and, where the Gateway API is served, HTTPRoutes and their Gateways, then follows
//! each host and path match to its Services: the Service and its port, the `targetPort` the port maps
//! to, the EndpointSlices behind it (ready / all) and the workload of their pods. The first broken
//! link of each backend is named (Service missing, port not on the Service, no ready endpoints), so
//! the view can show where a request stops.
//!
//! Only reads. Lists across namespaces, or, where that is forbidden, in the namespaces the UI names
//! (as `:traffic` does). A list that cannot be read becomes a note, not an error. Every free text
//! that comes from the cluster (hosts, paths, header values) passes `clean_untrusted`.
use std::collections::HashMap;

use crate::{
    contract::{RouteBackend, RouteEntry, RouteMap, RouteSource, RoutesRequest},
    ipc::{Gvr, Json, Result},
    redact::clean_untrusted,
    session::{Session, api_path},
    state::AppState,
};

/// Entries per map; a bigger cluster gets a note.
pub const MAX_ENTRIES: usize = 2000;
const MAX_NAMESPACES: usize = 40;
const MAX_TEXT: usize = 300;
const GATEWAY_GROUP: &str = "gateway.networking.k8s.io";

fn s(v: &Json) -> &str {
    v.as_str().unwrap_or_default()
}

fn arr(v: &Json) -> &[Json] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}

fn text(v: &str) -> String {
    clean_untrusted(v, MAX_TEXT)
}

fn ns_of(o: &Json) -> &str {
    s(&o["metadata"]["namespace"])
}

fn name_of(o: &Json) -> &str {
    s(&o["metadata"]["name"])
}

/// An int-or-string field as text (`8080`, `http`).
fn port_text(v: &Json) -> Option<String> {
    v.as_i64().map(|n| n.to_string()).or_else(|| v.as_str().filter(|x| !x.is_empty()).map(str::to_string))
}

/// The first load balancer address in a status (`status.loadBalancer.ingress`, `status.addresses`).
fn lb_address(o: &Json) -> Option<String> {
    let lb = arr(&o["status"]["loadBalancer"]["ingress"]).iter().find_map(|i| i["hostname"].as_str().or_else(|| i["ip"].as_str()));
    let gw = arr(&o["status"]["addresses"]).iter().find_map(|a| a["value"].as_str());
    lb.or(gw).filter(|x| !x.is_empty()).map(text)
}

// ───────────────────────── the cluster's objects, by namespace and name ─────────────────────────

/// What the routes are resolved against.
#[derive(Default)]
pub struct Objects {
    pub ingresses: Vec<Json>,
    pub httproutes: Vec<Json>,
    /// (namespace, name) → Gateway
    pub gateways: HashMap<(String, String), Json>,
    /// (namespace, name) → Service
    pub services: HashMap<(String, String), Json>,
    /// (namespace, Service name) → its EndpointSlices
    pub slices: HashMap<(String, String), Vec<Json>>,
    /// (namespace, pod name) → workload as `Kind/name`
    pub workloads: HashMap<(String, String), String>,
}

/// The workload of a pod from its controller owner (a ReplicaSet named `<deployment>-<hash>`
/// counts as its Deployment).
pub fn workload_of(pod: &Json) -> Option<String> {
    let refs = arr(&pod["metadata"]["ownerReferences"]);
    let r = refs.iter().find(|r| r["controller"].as_bool() == Some(true)).or_else(|| refs.first())?;
    let (kind, name) = (s(&r["kind"]), s(&r["name"]));
    if kind == "ReplicaSet" {
        let hash = s(&pod["metadata"]["labels"]["pod-template-hash"]);
        if let Some(d) = (!hash.is_empty()).then(|| name.strip_suffix(&format!("-{hash}"))).flatten() {
            return Some(format!("Deployment/{d}"));
        }
    }
    (!kind.is_empty() && !name.is_empty()).then(|| format!("{kind}/{name}"))
}

impl Objects {
    pub fn add_list(&mut self, resource: &str, list: &Json) {
        for o in arr(&list["items"]) {
            let key = (ns_of(o).to_string(), name_of(o).to_string());
            match resource {
                "ingresses" => self.ingresses.push(o.clone()),
                "httproutes" => self.httproutes.push(o.clone()),
                "gateways" => {
                    self.gateways.insert(key, o.clone());
                }
                "services" => {
                    self.services.insert(key, o.clone());
                }
                "endpointslices" => {
                    let svc = s(&o["metadata"]["labels"]["kubernetes.io/service-name"]);
                    if !svc.is_empty() {
                        self.slices.entry((key.0, svc.to_string())).or_default().push(o.clone());
                    }
                }
                "pods" => {
                    if let Some(w) = workload_of(o) {
                        self.workloads.insert(key, w);
                    }
                }
                _ => {}
            }
        }
    }

    /// Follow one backend reference to its Service and endpoints.
    pub fn backend(&self, ns: &str, service: &str, port: Option<String>, weight: Option<u32>) -> RouteBackend {
        let mut b = RouteBackend {
            namespace: ns.to_string(),
            service: service.to_string(),
            port: port.clone().unwrap_or_default(),
            target_port: None,
            weight,
            workload: None,
            external_name: None,
            ready: 0,
            total: 0,
            problem: None,
        };
        let Some(svc) = self.services.get(&(ns.to_string(), service.to_string())) else {
            b.problem = Some(format!("Service {service} not found"));
            return b;
        };
        if svc["spec"]["type"].as_str() == Some("ExternalName") {
            b.external_name = svc["spec"]["externalName"].as_str().map(text);
            if b.port.is_empty() {
                b.port = "any".into();
            }
            return b;
        }
        let ports = arr(&svc["spec"]["ports"]);
        let found = match &port {
            Some(p) => ports.iter().find(|sp| port_text(&sp["port"]).as_deref() == Some(p) || sp["name"].as_str() == Some(p)),
            // no port named: a Service with one port uses it (Gateway API requires a port; old Ingresses may not)
            None => (ports.len() == 1).then(|| &ports[0]),
        };
        match found {
            Some(sp) => {
                if b.port.is_empty() {
                    b.port = port_text(&sp["port"]).unwrap_or_default();
                }
                b.target_port = port_text(&sp["targetPort"]).or_else(|| port_text(&sp["port"]));
            }
            None => {
                b.problem = Some(match &port {
                    Some(p) => format!("port {p} is not a port of the Service"),
                    None => "no port given and the Service has several".into(),
                });
            }
        }
        let mut workload_votes: HashMap<&str, usize> = HashMap::new();
        for slice in self.slices.get(&(ns.to_string(), service.to_string())).map(Vec::as_slice).unwrap_or_default() {
            for e in arr(&slice["endpoints"]) {
                b.total += 1;
                // `ready` unset means ready (EndpointSlice API)
                if e["conditions"]["ready"].as_bool() != Some(false) {
                    b.ready += 1;
                }
                if e["targetRef"]["kind"].as_str() == Some("Pod")
                    && let Some(w) = self.workloads.get(&(ns.to_string(), s(&e["targetRef"]["name"]).to_string()))
                {
                    *workload_votes.entry(w).or_default() += 1;
                }
            }
        }
        b.workload = workload_votes.into_iter().max_by(|a, c| a.1.cmp(&c.1).then(c.0.cmp(a.0))).map(|(w, _)| w.to_string());
        if b.problem.is_none() {
            let has_selector = svc["spec"]["selector"].as_object().is_some_and(|m| !m.is_empty());
            if b.total == 0 {
                b.problem = Some(if has_selector { "the Service selects no running pods".into() } else { "the Service has no selector and no endpoints".into() });
            } else if b.ready == 0 {
                b.problem = Some(format!("no ready endpoints (0/{})", b.total));
            }
        }
        b
    }
}

// ───────────────────────── Ingress ─────────────────────────

fn ingress_backend(o: &Objects, ns: &str, backend: &Json) -> RouteBackend {
    if let Some(name) = backend["service"]["name"].as_str() {
        let port = port_text(&backend["service"]["port"]["number"]).or_else(|| port_text(&backend["service"]["port"]["name"]));
        return o.backend(ns, name, port, None);
    }
    let kind = s(&backend["resource"]["kind"]);
    RouteBackend {
        namespace: ns.to_string(),
        service: text(s(&backend["resource"]["name"])),
        port: String::new(),
        target_port: None,
        weight: None,
        workload: None,
        external_name: None,
        ready: 0,
        total: 0,
        problem: Some(if kind.is_empty() { "the backend names no Service".into() } else { format!("a {} backend, not a Service", text(kind)) }),
    }
}

pub fn ingress_entries(o: &Objects, ing: &Json) -> Vec<RouteEntry> {
    let ns = ns_of(ing);
    let spec = &ing["spec"];
    let via = spec["ingressClassName"].as_str().or_else(|| ing["metadata"]["annotations"]["kubernetes.io/ingress.class"].as_str()).map(text);
    let source = RouteSource { kind: "Ingress".into(), namespace: ns.to_string(), name: name_of(ing).to_string(), via, address: lb_address(ing) };
    let tls_hosts: Vec<&Json> = arr(&spec["tls"]).iter().collect();
    let tls_for = |host: &str| tls_hosts.iter().any(|t| arr(&t["hosts"]).is_empty() || arr(&t["hosts"]).iter().any(|h| s(h) == host || (s(h).starts_with("*.") && host.ends_with(&s(h)[1..]))));
    let mut out = Vec::new();
    for rule in arr(&spec["rules"]) {
        let host = rule["host"].as_str().filter(|h| !h.is_empty()).map(text).unwrap_or_else(|| "*".into());
        let tls = tls_for(&host);
        for p in arr(&rule["http"]["paths"]) {
            out.push(RouteEntry {
                source: source.clone(),
                host: host.clone(),
                tls,
                path: p["path"].as_str().filter(|x| !x.is_empty()).map(text).unwrap_or_else(|| "/".into()),
                match_type: p["pathType"].as_str().map(text).unwrap_or_else(|| "ImplementationSpecific".into()),
                conditions: vec![],
                filters: vec![],
                backends: vec![ingress_backend(o, ns, &p["backend"])],
            });
        }
    }
    if spec["defaultBackend"].is_object() {
        out.push(RouteEntry {
            source,
            host: "*".into(),
            tls: false,
            path: "/".into(),
            match_type: "default".into(),
            conditions: vec![],
            filters: vec![],
            backends: vec![ingress_backend(o, ns, &spec["defaultBackend"])],
        });
    }
    out
}

// ───────────────────────── HTTPRoute ─────────────────────────

/// The Gateway listeners a parentRef attaches to: (hostname, is HTTPS).
fn listeners<'a>(o: &'a Objects, route_ns: &str, parent: &Json) -> (Option<&'a Json>, Vec<(Option<String>, bool)>) {
    let kind = parent["kind"].as_str().unwrap_or("Gateway");
    if kind != "Gateway" {
        return (None, vec![]);
    }
    let ns = parent["namespace"].as_str().unwrap_or(route_ns);
    let Some(gw) = o.gateways.get(&(ns.to_string(), s(&parent["name"]).to_string())) else { return (None, vec![]) };
    let section = parent["sectionName"].as_str();
    let port = parent["port"].as_i64();
    let ls = arr(&gw["spec"]["listeners"])
        .iter()
        .filter(|l| section.is_none_or(|x| l["name"].as_str() == Some(x)) && port.is_none_or(|p| l["port"].as_i64() == Some(p)))
        .filter(|l| matches!(l["protocol"].as_str(), Some("HTTP" | "HTTPS")))
        .map(|l| (l["hostname"].as_str().map(text), l["protocol"].as_str() == Some("HTTPS")))
        .collect();
    (Some(gw), ls)
}

fn match_conditions(m: &Json) -> Vec<String> {
    let mut out = Vec::new();
    for h in arr(&m["headers"]) {
        let op = if h["type"].as_str() == Some("RegularExpression") { "~" } else { ":" };
        out.push(text(&format!("header {} {op} {}", s(&h["name"]), s(&h["value"]))).replace(" :", ":"));
    }
    if let Some(method) = m["method"].as_str() {
        out.push(format!("method {}", text(method)));
    }
    for q in arr(&m["queryParams"]) {
        out.push(text(&format!("query {}={}", s(&q["name"]), s(&q["value"]))));
    }
    out
}

fn filter_text(f: &Json) -> Option<String> {
    let t = s(&f["type"]);
    let out = match t {
        "RequestRedirect" => {
            let r = &f["requestRedirect"];
            let mut parts: Vec<String> = Vec::new();
            if let Some(x) = r["scheme"].as_str() {
                parts.push(x.to_string());
            }
            if let Some(x) = r["hostname"].as_str() {
                parts.push(x.to_string());
            }
            if let Some(x) = r["port"].as_i64() {
                parts.push(format!(":{x}"));
            }
            if let Some(x) = r["path"]["replaceFullPath"].as_str().or_else(|| r["path"]["replacePrefixMatch"].as_str()) {
                parts.push(x.to_string());
            }
            let code = r["statusCode"].as_i64().unwrap_or(302);
            format!("redirect → {} ({code})", if parts.is_empty() { "same URL".into() } else { parts.join(" ") })
        }
        "URLRewrite" => {
            let r = &f["urlRewrite"];
            let mut parts = Vec::new();
            if let Some(h) = r["hostname"].as_str() {
                parts.push(format!("host → {h}"));
            }
            if let Some(p) = r["path"]["replaceFullPath"].as_str() {
                parts.push(format!("path → {p}"));
            }
            if let Some(p) = r["path"]["replacePrefixMatch"].as_str() {
                parts.push(format!("prefix → {p}"));
            }
            format!("rewrite {}", parts.join(", "))
        }
        "RequestHeaderModifier" | "ResponseHeaderModifier" => {
            let m = if t == "RequestHeaderModifier" { &f["requestHeaderModifier"] } else { &f["responseHeaderModifier"] };
            let names: Vec<&str> = arr(&m["set"]).iter().chain(arr(&m["add"])).map(|h| s(&h["name"])).chain(arr(&m["remove"]).iter().map(s)).collect();
            format!("{} headers {}", if t == "RequestHeaderModifier" { "request" } else { "response" }, names.join(", "))
        }
        "RequestMirror" => format!("mirror → {}", s(&f["requestMirror"]["backendRef"]["name"])),
        "" => return None,
        other => other.to_string(),
    };
    Some(text(&out))
}

/// Percent shares of the weights; None when the rule has one backend with the default weight.
fn shares(weights: &[u32]) -> Vec<Option<u32>> {
    let sum: u32 = weights.iter().sum();
    if weights.len() < 2 && weights.iter().all(|w| *w == 1) {
        return weights.iter().map(|_| None).collect();
    }
    weights.iter().map(|w| Some(if sum == 0 { 0 } else { ((*w as f64) * 100.0 / sum as f64).round() as u32 })).collect()
}

pub fn httproute_entries(o: &Objects, route: &Json) -> Vec<RouteEntry> {
    let ns = ns_of(route);
    let spec = &route["spec"];
    let parents = arr(&spec["parentRefs"]);
    // hosts: the route's own, else the hostnames of the listeners it attaches to, else any
    let mut via = None;
    let mut address = None;
    let mut listener_hosts: Vec<(Option<String>, bool)> = Vec::new();
    for p in parents {
        let (gw, ls) = listeners(o, ns, p);
        if via.is_none() {
            let gns = p["namespace"].as_str().unwrap_or(ns);
            via = Some(format!("gateway {}/{}", text(gns), text(s(&p["name"]))));
            address = gw.and_then(lb_address);
        }
        listener_hosts.extend(ls);
    }
    let own: Vec<String> = arr(&spec["hostnames"]).iter().map(|h| text(s(h))).filter(|h| !h.is_empty()).collect();
    let any_https = listener_hosts.iter().any(|(_, tls)| *tls);
    let hosts: Vec<(String, bool)> = if !own.is_empty() {
        own.into_iter()
            .map(|h| {
                // TLS when an HTTPS listener takes this host (no hostname = every host)
                let tls = listener_hosts.iter().any(|(lh, tls)| *tls && lh.as_ref().is_none_or(|lh| lh == &h || (lh.starts_with("*.") && h.ends_with(&lh[1..]))));
                (h, tls)
            })
            .collect()
    } else {
        let mut hs: Vec<(String, bool)> = Vec::new();
        for (h, tls) in &listener_hosts {
            let h = h.clone().unwrap_or_else(|| "*".into());
            match hs.iter_mut().find(|(x, _)| *x == h) {
                Some(e) => e.1 |= *tls,
                None => hs.push((h, *tls)),
            }
        }
        if hs.is_empty() {
            hs.push(("*".into(), any_https));
        }
        hs
    };
    let source = RouteSource { kind: "HTTPRoute".into(), namespace: ns.to_string(), name: name_of(route).to_string(), via, address };

    let mut out = Vec::new();
    for rule in arr(&spec["rules"]) {
        let refs = arr(&rule["backendRefs"]);
        let weights: Vec<u32> = refs.iter().map(|r| r["weight"].as_u64().map(|w| w as u32).unwrap_or(1)).collect();
        let shares = shares(&weights);
        let backends: Vec<RouteBackend> = refs
            .iter()
            .zip(shares)
            .map(|(r, share)| {
                let kind = r["kind"].as_str().unwrap_or("Service");
                let group = s(&r["group"]);
                let bns = r["namespace"].as_str().unwrap_or(ns);
                if kind != "Service" || !group.is_empty() {
                    let mut b = o.backend(bns, s(&r["name"]), port_text(&r["port"]), share);
                    b.problem = Some(format!("a {} backend, not a Service", text(kind)));
                    return b;
                }
                o.backend(bns, s(&r["name"]), port_text(&r["port"]), share)
            })
            .collect();
        let filters: Vec<String> = arr(&rule["filters"]).iter().filter_map(filter_text).collect();
        let default_match = [Json::Null];
        let matches = if arr(&rule["matches"]).is_empty() { &default_match[..] } else { arr(&rule["matches"]) };
        for m in matches {
            let (match_type, path) = match m["path"].as_object() {
                Some(p) => {
                    let t = p.get("type").and_then(Json::as_str).unwrap_or("PathPrefix");
                    (if t == "PathPrefix" { "Prefix".to_string() } else { text(t) }, p.get("value").and_then(Json::as_str).map(text).unwrap_or_else(|| "/".into()))
                }
                None => ("Prefix".into(), "/".into()),
            };
            for (host, tls) in &hosts {
                out.push(RouteEntry {
                    source: source.clone(),
                    host: host.clone(),
                    tls: *tls,
                    path: path.clone(),
                    match_type: match_type.clone(),
                    conditions: match_conditions(m),
                    filters: filters.clone(),
                    backends: backends.clone(),
                });
            }
        }
    }
    out
}

/// Every entry, sorted by host (`*` last), then by path.
pub fn build(o: &Objects) -> Vec<RouteEntry> {
    let mut out: Vec<RouteEntry> = o.ingresses.iter().flat_map(|i| ingress_entries(o, i)).chain(o.httproutes.iter().flat_map(|r| httproute_entries(o, r))).collect();
    out.sort_by(|a, b| {
        (a.host == "*")
            .cmp(&(b.host == "*"))
            .then_with(|| a.host.cmp(&b.host))
            .then_with(|| (a.match_type == "default").cmp(&(b.match_type == "default")))
            .then_with(|| a.path.cmp(&b.path))
            .then_with(|| a.source.name.cmp(&b.source.name))
    });
    out
}

// ───────────────────────── reading ─────────────────────────

async fn list_into(session: &Session, objects: &mut Objects, notes: &mut Vec<String>, gvr: &Gvr, scope: Option<&str>, fallback: &[String]) {
    let resource = gvr.resource.as_str();
    match session.get(&api_path(gvr, scope, None)).await {
        Ok(list) => objects.add_list(resource, &list),
        Err(e) if e.code == 403 && scope.is_none() && !fallback.is_empty() => {
            let mut failed = 0;
            for ns in fallback.iter().take(MAX_NAMESPACES) {
                match session.get(&api_path(gvr, Some(ns), None)).await {
                    Ok(list) => objects.add_list(resource, &list),
                    Err(_) => failed += 1,
                }
            }
            let shown = fallback.iter().take(MAX_NAMESPACES).cloned().collect::<Vec<_>>().join(", ");
            notes.push(format!("{resource}: forbidden across all namespaces; looked in {shown}{}", if failed > 0 { format!(" ({failed} refused)") } else { String::new() }));
        }
        Err(e) if e.code == 403 => notes.push(format!("{resource}: forbidden")),
        Err(e) => notes.push(format!("{resource}: {}", clean_untrusted(e.message.lines().next().unwrap_or_default(), 200))),
    }
}

pub async fn route_map(state: &AppState, req: &RoutesRequest) -> Result<RouteMap> {
    let session = state.session(&req.context).await?;
    let mut notes = Vec::new();
    let mut objects = Objects::default();
    let scope = req.namespace.as_deref().filter(|n| !n.is_empty());

    // the Gateway API is a CRD: its version comes from discovery
    let discovery = session.discovery(None).await.ok();
    let served = |resource: &str| discovery.as_ref().and_then(|d| d.preferred.iter().find(|r| r.gvr.group == GATEWAY_GROUP && r.gvr.resource == resource).map(|r| r.gvr.clone()));
    let (httproutes, gateways) = (served("httproutes"), served("gateways"));
    if httproutes.is_none() {
        notes.push("Gateway API (HTTPRoute) is not installed: Ingresses only".into());
    }

    let mut lists: Vec<(Gvr, Option<&str>)> = vec![(Gvr::new("networking.k8s.io", "v1", "ingresses"), scope)];
    if let Some(g) = httproutes {
        lists.push((g, scope));
    }
    // Gateways often live in another namespace (infra): always across namespaces
    if let Some(g) = gateways {
        lists.push((g, None));
    }
    for (gvr, sc) in &lists {
        list_into(&session, &mut objects, &mut notes, gvr, *sc, &req.namespaces).await;
    }
    // backends may be in other namespaces (ReferenceGrant): read the namespaces the routes point at
    let mut backend_ns: Vec<String> = objects
        .ingresses
        .iter()
        .chain(objects.httproutes.iter())
        .map(|o| ns_of(o).to_string())
        .chain(objects.httproutes.iter().flat_map(|r| arr(&r["spec"]["rules"]).iter().flat_map(|rule| arr(&rule["backendRefs"]).iter().filter_map(|b| b["namespace"].as_str().map(str::to_string)))))
        .collect();
    backend_ns.sort();
    backend_ns.dedup();
    let backend_lists = [Gvr::new("", "v1", "services"), Gvr::new("discovery.k8s.io", "v1", "endpointslices"), Gvr::new("", "v1", "pods")];
    // a few namespaces: list in each; many: once across all of them (falling back to those)
    if backend_ns.len() <= 8 {
        for gvr in &backend_lists {
            for ns in &backend_ns {
                list_into(&session, &mut objects, &mut notes, gvr, Some(ns), &[]).await;
            }
        }
    } else {
        for gvr in &backend_lists {
            list_into(&session, &mut objects, &mut notes, gvr, None, &backend_ns).await;
        }
    }

    let mut entries = build(&objects);
    if entries.len() > MAX_ENTRIES {
        notes.push(format!("{} routes; showing the first {MAX_ENTRIES}", entries.len()));
        entries.truncate(MAX_ENTRIES);
    }
    Ok(RouteMap { entries, notes, at: jiff::Timestamp::now().round(jiff::Unit::Second).map(|t| t.to_string()).unwrap_or_default() })
}

pub mod cmd {
    use crate::{
        contract::{RouteMap, RoutesRequest},
        ipc::Result,
        state::AppState,
    };

    /// The HTTP routes of a namespace (or every namespace) and where each one ends.
    #[tauri::command]
    pub async fn route_map(state: tauri::State<'_, AppState>, req: RoutesRequest) -> Result<RouteMap> {
        super::route_map(&state, &req).await
    }
}

#[cfg(test)]
mod tests;
