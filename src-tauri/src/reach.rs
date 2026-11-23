//! `:reach`: can this pod talk to that Service (or pod)? Static chain and active probe (§3 C3).
//!
//! The chain is pure (`chain` over a [`ReachInput`]): Service → port → EndpointSlices → readiness →
//! target port → NetworkPolicies of both ends (`netpol`, "by standard rules") → DNS egress. A step
//! kns cannot decide is `ok: None`, never green. The fetch layer turns a forbidden side read into an
//! undecided step. Every `detail` passes the Redactor and `clean_untrusted`.
//!
//! The probe runs one fixed `sh -c` script in the source pod (an exec, confirmed tier 1 in the UI),
//! built only from a validated DNS name or IP literal and a resolved `u16` port.
pub mod netpol;

use std::net::IpAddr;

use crate::{
    ipc::{AccessQuery, BackendError, Gvr, Json, ObjRef, PortRef, ReachCheck, ReachProbeResult, ReachStep, Result, take_array},
    redact::{MAX_LINE, Redactor, clean_untrusted},
    session::{Session, api_path, with_query},
    state::AppState,
};
use netpol::{Direction, Peer, Port, Tri};

// ───────────────────────── input ─────────────────────────

#[derive(Debug, Clone, Default)]
pub struct ReachInput {
    pub from_pod: Json,
    /// the destination: a Service or a pod
    pub to: Json,
    pub to_is_service: bool,
    pub port: Option<PortRef>,
    /// pods behind the Service (or the destination pod itself)
    pub dest_pods: Vec<Json>,
    /// EndpointSlices of the Service (None: not read)
    pub slices: Option<Vec<Json>>,
    /// NetworkPolicies of the source / destination namespace (None: not read)
    pub src_policies: Option<Vec<Json>>,
    pub dst_policies: Option<Vec<Json>>,
    /// every namespace (labels for namespaceSelector); None: not readable
    pub namespaces: Option<Vec<Json>>,
    /// CNI policy kinds served by the cluster that kns does not evaluate (CiliumNetworkPolicy …)
    pub other_policy_kinds: Vec<String>,
}

fn s(v: &Json) -> &str {
    v.as_str().unwrap_or_default()
}

fn arr(v: &Json) -> &[Json] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}

fn ns_of(o: &Json) -> &str {
    s(&o["metadata"]["namespace"])
}

fn name_of(o: &Json) -> &str {
    s(&o["metadata"]["name"])
}

fn ready(pod: &Json) -> bool {
    arr(&pod["status"]["conditions"]).iter().any(|c| c["type"] == "Ready" && c["status"] == "True")
}

/// `"80"` from the webview arrives as a name: treat digit strings as numbers.
pub fn normalize_port(p: &PortRef) -> PortRef {
    match p {
        PortRef::Name(n) => n.parse::<u16>().map(PortRef::Number).unwrap_or_else(|_| p.clone()),
        other => other.clone(),
    }
}

/// The Service port the check is about: (index, port entry). Without a requested port: the only
/// port, else the first (the detail says so).
pub fn service_port<'a>(svc: &'a Json, want: Option<&PortRef>) -> Option<(usize, &'a Json)> {
    let ports = arr(&svc["spec"]["ports"]);
    match want.map(normalize_port) {
        None => ports.first().map(|p| (0, p)),
        Some(PortRef::Number(n)) => ports.iter().enumerate().find(|(_, p)| p["port"].as_u64() == Some(u64::from(n))),
        Some(PortRef::Name(name)) => ports.iter().enumerate().find(|(_, p)| p["name"].as_str() == Some(name.as_str())),
    }
}

/// The container port a target port means on one pod: (number, its name). A named target port
/// that the pod does not declare gives None.
pub fn container_port<'a>(pod: &'a Json, target: &Json) -> Option<(u16, Option<&'a str>)> {
    let ports = || arr(&pod["spec"]["containers"]).iter().flat_map(|c| arr(&c["ports"]));
    match target {
        Json::Number(n) => {
            let n = u16::try_from(n.as_u64()?).ok()?;
            let name = ports().find(|p| p["containerPort"].as_u64() == Some(u64::from(n))).and_then(|p| p["name"].as_str());
            Some((n, name))
        }
        Json::String(name) => match name.parse::<u16>() {
            Ok(n) => container_port(pod, &Json::from(n)),
            Err(_) => ports().find(|p| p["name"].as_str() == Some(name.as_str())).and_then(|p| Some((u16::try_from(p["containerPort"].as_u64()?).ok()?, p["name"].as_str()))),
        },
        _ => None,
    }
}

fn pod_ip(pod: &Json) -> Option<IpAddr> {
    pod["status"]["podIP"].as_str()?.parse().ok()
}

fn ns_labels<'a>(input: &'a ReachInput, ns: &str) -> Option<&'a Json> {
    input.namespaces.as_ref()?.iter().find(|n| name_of(n) == ns).map(|n| &n["metadata"]["labels"])
}

fn peer<'a>(input: &'a ReachInput, pod: &'a Json) -> Peer<'a> {
    Peer { namespace: ns_of(pod), labels: &pod["metadata"]["labels"], ns_labels: ns_labels(input, ns_of(pod)), ip: pod_ip(pod) }
}

fn step(name: impl Into<String>, ok: Tri, detail: impl Into<String>) -> ReachStep {
    ReachStep { name: name.into(), ok, detail: detail.into() }
}

fn plural(n: usize, one: &str) -> String {
    if n == 1 { format!("1 {one}") } else { format!("{n} {one}s") }
}

/// The kube-dns pods as a policy would see them (the usual labels; a cluster that names them
/// otherwise gets an undecided DNS step at worst).
fn dns_labels() -> Json {
    serde_json::json!({ "k8s-app": "kube-dns" })
}

/// A target port resolved on one pod: (container port, its declared name).
type Resolved<'a> = Option<(u16, Option<&'a str>)>;

// ───────────────────────── chain ─────────────────────────

/// The static chain. Pure; `finish` cleans and redacts it. `port` is the port that was checked:
/// the requested one, or the Service port picked when none was asked for (the probe uses it).
pub fn chain(from: &ObjRef, to: &ObjRef, input: &ReachInput) -> ReachCheck {
    let mut c = chain_steps(from, to, input);
    if c.port.is_none()
        && input.to_is_service
        && let Some((_, sp)) = service_port(&input.to, None)
        && let Some(n) = sp["port"].as_u64().and_then(|n| u16::try_from(n).ok())
    {
        c.port = Some(PortRef::Number(n));
    }
    c
}

fn chain_steps(from: &ObjRef, to: &ObjRef, input: &ReachInput) -> ReachCheck {
    let mut steps: Vec<ReachStep> = Vec::new();
    // critical steps decide the overall answer; an undecided non-critical one does not make it unknown
    let mut critical: Vec<Tri> = Vec::new();
    let src = &input.from_pod;
    let done = |steps: Vec<ReachStep>, critical: Vec<Tri>| {
        let ok = if steps.iter().any(|x| x.ok == Some(false)) {
            Some(false)
        } else if critical.iter().any(Option::is_none) {
            None
        } else {
            Some(true)
        };
        ReachCheck { from: from.clone(), to: to.clone(), port: input.port.clone(), steps, ok }
    };

    // source pod
    let phase = s(&src["status"]["phase"]);
    if phase != "Running" {
        steps.push(step("source pod", Some(false), format!("{} is {}, not Running: it cannot open connections", name_of(src), if phase.is_empty() { "unknown" } else { phase })));
        return done(steps, critical);
    }

    // destination and port: (target port as the Service names it, protocol)
    let (target, protocol): (Json, String);
    if input.to_is_service {
        let svc = &input.to;
        let spec = &svc["spec"];
        if s(&spec["type"]) == "ExternalName" {
            steps.push(step("Service", None, format!("ExternalName: DNS alias for {}; nothing in the cluster to check", s(&spec["externalName"]))));
            return done(steps, vec![None]);
        }
        let headless = s(&spec["clusterIP"]) == "None";
        steps.push(step(
            "Service",
            Some(true),
            format!("{} ({}){}", to.name, if spec["type"].is_string() { s(&spec["type"]) } else { "ClusterIP" }, if headless { ", headless: DNS returns the pod IPs" } else { "" }),
        ));
        let n_ports = arr(&spec["ports"]).len();
        let Some((_, sp)) = service_port(svc, input.port.as_ref()) else {
            let have: Vec<String> = arr(&spec["ports"])
                .iter()
                .map(|p| match p["name"].as_str() {
                    Some(n) => format!("{n} {}", p["port"]),
                    None => p["port"].to_string(),
                })
                .collect();
            let want = input.port.as_ref().map(|p| format!("no port {p}")).unwrap_or_else(|| "no ports".into());
            steps.push(step("port", Some(false), format!("{want}; the Service has {}", if have.is_empty() { "none".into() } else { have.join(", ") })));
            return done(steps, critical);
        };
        target = if sp["targetPort"].is_null() { sp["port"].clone() } else { sp["targetPort"].clone() };
        protocol = sp["protocol"].as_str().unwrap_or("TCP").to_string();
        let port_label = match sp["name"].as_str() {
            Some(n) => format!("{n} {}", sp["port"]),
            None => sp["port"].to_string(),
        };
        let more = if input.port.is_none() && n_ports > 1 { format!("; {n_ports} ports, checked the first (:reach {}:<port>)", to.name) } else { String::new() };
        let tp = match &target {
            Json::Number(n) => n.to_string(),
            other => s(other).to_string(),
        };
        steps.push(step("port", Some(true), format!("{port_label}/{protocol} → targetPort {tp}{more}")));

        // endpoints
        if s(&spec["selector"]).is_empty() && spec["selector"].as_object().is_none_or(|m| m.is_empty()) {
            steps.push(step("endpoints", None, "no selector: endpoints are managed outside the Service"));
            critical.push(None);
        } else if let Some(slices) = &input.slices {
            let port_name = sp["name"].as_str();
            let mut total = 0usize;
            let mut up = 0usize;
            for sl in slices {
                let serves = arr(&sl["ports"]).is_empty() || arr(&sl["ports"]).iter().any(|p| p["name"].as_str() == port_name || (port_name.is_none() && p["name"].is_null()));
                if !serves {
                    continue;
                }
                for e in arr(&sl["endpoints"]) {
                    total += 1;
                    if e["conditions"]["ready"].as_bool() != Some(false) {
                        up += 1;
                    }
                }
            }
            let ok = up > 0;
            steps.push(step("endpoints", Some(ok), if total == 0 { "no endpoints: the selector matches no pod with this port".to_string() } else { format!("{up} of {total} endpoints ready") }));
            critical.push(Some(ok));
        } else {
            let up = input.dest_pods.iter().filter(|p| ready(p)).count();
            let ok = up > 0;
            steps.push(step("endpoints", Some(ok), format!("EndpointSlices not readable; {up} of {} selected pods ready", input.dest_pods.len())));
            critical.push(Some(ok));
        }
    } else {
        let pod = &input.to;
        let ok = ready(pod);
        steps.push(step("destination pod", Some(ok), format!("{} {}", to.name, if ok { "is ready" } else { "is not ready" })));
        critical.push(Some(ok));
        let Some(p) = input.port.as_ref().map(normalize_port) else {
            steps.push(step("port", Some(false), "no port given (:reach pod/<name> <port>)"));
            return done(steps, critical);
        };
        target = match p {
            PortRef::Number(n) => Json::from(n),
            PortRef::Name(n) => Json::from(n),
        };
        protocol = "TCP".into();
    }

    // target port on the ready destination pods
    let ready_pods: Vec<&Json> = input.dest_pods.iter().filter(|p| ready(p)).collect();
    if ready_pods.is_empty() {
        return done(steps, critical);
    }
    let resolved: Vec<(&Json, Resolved)> = ready_pods.iter().map(|p| (*p, container_port(p, &target))).collect();
    let missing: Vec<&str> = resolved.iter().filter(|(_, c)| c.is_none()).map(|(p, _)| name_of(p)).collect();
    let declared = resolved.iter().filter(|(_, c)| c.is_some_and(|(_, n)| n.is_some())).count();
    match (&target, missing.is_empty()) {
        (Json::String(name), false) if name.parse::<u16>().is_err() => {
            steps.push(step("target port", Some(false), format!("{} of {} ready pods declare no container port named {name} ({})", missing.len(), resolved.len(), missing.join(", "))));
            return done(steps, critical);
        }
        _ => {
            let n = resolved.iter().find_map(|(_, c)| c.map(|(n, _)| n)).unwrap_or(0);
            if declared == resolved.len() {
                steps.push(step("target port", Some(true), format!("container port {n} on {}", plural(resolved.len(), "ready pod"))));
            } else {
                steps.push(step("target port", None, format!("{n} is not declared in the pod spec; kns cannot tell whether something listens (the probe can)")));
            }
        }
    }

    // NetworkPolicies, by standard rules
    let src_peer = peer(input, src);
    let note = " (by standard rules)";
    // egress of the source to each ready destination pod
    match &input.src_policies {
        None => {
            steps.push(step("egress from source", None, format!("NetworkPolicies of {} not readable{note}", ns_of(src))));
            critical.push(None);
        }
        Some(pols) => {
            let mut verdicts = Vec::new();
            for (p, c) in &resolved {
                let Some((n, name)) = c else { continue };
                let port = Port { number: *n, name: *name, protocol: &protocol };
                verdicts.push(netpol::evaluate(pols, Direction::Egress, &src_peer, &peer(input, p), &port));
            }
            let (ok, detail) = summarize(&verdicts, "egress", name_of(src));
            steps.push(step("egress from source", ok, format!("{detail}{note}")));
            critical.push(ok);

            // DNS: a Service is found by name, so egress to kube-dns port 53 must be open too
            if input.to_is_service && verdicts.iter().any(|v| !v.selecting.is_empty()) {
                let labels = dns_labels();
                let dns_ns_labels = ns_labels(input, "kube-system");
                let dns = Peer { namespace: "kube-system", labels: &labels, ns_labels: dns_ns_labels, ip: None };
                let udp = netpol::evaluate(pols, Direction::Egress, &src_peer, &dns, &Port { number: 53, name: Some("dns"), protocol: "UDP" });
                let ok = udp.allowed;
                let detail = match ok {
                    Some(true) => "egress to kube-dns on 53/UDP is allowed".to_string(),
                    Some(false) => format!("egress to port 53/UDP is not allowed by {}: name lookups of {}.{}.svc fail", udp.selecting.join(", "), to.name, to.ns().unwrap_or_default()),
                    None => "cannot tell whether egress to kube-dns on 53/UDP is allowed".to_string(),
                };
                steps.push(step("DNS", ok, format!("{detail}{note}")));
            }
        }
    }
    // ingress of each ready destination pod from the source
    match &input.dst_policies {
        None => {
            steps.push(step("ingress to destination", None, format!("NetworkPolicies of {} not readable{note}", to.ns().unwrap_or_default())));
            critical.push(None);
        }
        Some(pols) => {
            let mut verdicts = Vec::new();
            for (p, c) in &resolved {
                let Some((n, name)) = c else { continue };
                let port = Port { number: *n, name: *name, protocol: &protocol };
                verdicts.push(netpol::evaluate(pols, Direction::Ingress, &peer(input, p), &src_peer, &port));
            }
            let (ok, detail) = summarize(&verdicts, "ingress", &to.name);
            steps.push(step("ingress to destination", ok, format!("{detail}{note}")));
            critical.push(ok);
        }
    }
    if !input.other_policy_kinds.is_empty() {
        steps.push(step("other policy kinds", None, format!("{} also served here; kns does not evaluate them", input.other_policy_kinds.join(", "))));
    }
    done(steps, critical)
}

/// One line for the verdicts of a direction over the destination pods.
fn summarize(verdicts: &[netpol::Verdict], dir: &str, subject: &str) -> (Tri, String) {
    let selecting: Vec<&str> = {
        let mut v: Vec<&str> = verdicts.iter().flat_map(|x| x.selecting.iter().map(String::as_str)).collect();
        v.sort_unstable();
        v.dedup();
        v
    };
    if selecting.is_empty() {
        return (Some(true), format!("no NetworkPolicy limits {dir} of {subject}"));
    }
    let n = verdicts.len();
    let yes = verdicts.iter().filter(|v| v.allowed == Some(true)).count();
    let unknown = verdicts.iter().filter(|v| v.allowed.is_none()).count();
    let allowing: Vec<&str> = {
        let mut v: Vec<&str> = verdicts.iter().flat_map(|x| x.allowing.iter().map(String::as_str)).collect();
        v.sort_unstable();
        v.dedup();
        v
    };
    let by = selecting.join(", ");
    if yes == n {
        (Some(true), format!("allowed by {} (policies selecting it: {by})", allowing.join(", ")))
    } else if yes > 0 {
        (Some(true), format!("allowed to {yes} of {n} pods by {}; the rest are limited by {by}", allowing.join(", ")))
    } else if unknown > 0 {
        (None, format!("{by} select it; kns cannot decide the peer (namespace labels or IPs unknown)"))
    } else {
        (Some(false), format!("denied: {by} select{} it and no rule allows this peer and port", if selecting.len() == 1 { "s" } else { "" }))
    }
}

/// Redacted and cleaned copy of the check.
pub fn finish(mut c: ReachCheck) -> ReachCheck {
    let mut r = Redactor::new();
    for st in &mut c.steps {
        st.name = clean_untrusted(&st.name, MAX_LINE);
        st.detail = clean_untrusted(&r.text(&st.detail), MAX_LINE);
    }
    c
}

// ───────────────────────── fetch ─────────────────────────

fn pods_gvr() -> Gvr {
    Gvr::new("", "v1", "pods")
}

async fn list(session: &Session, gvr: &Gvr, ns: Option<&str>, selector: Option<&str>) -> Result<Vec<Json>> {
    let params: Vec<(&str, &str)> = selector.map(|sel| vec![("labelSelector", sel)]).unwrap_or_default();
    Ok(take_array(&mut session.get(&with_query(&api_path(gvr, ns, None), &params)).await?, "items"))
}

fn require(r: &ObjRef, resource: &str, what: &str) -> Result<()> {
    if r.gvr.group.is_empty() && r.gvr.resource == resource && r.ns().is_some() {
        Ok(())
    } else {
        Err(BackendError::invalid(format!("reach needs {what}")))
    }
}

fn require_to(from: &ObjRef, to: &ObjRef) -> Result<bool> {
    // both ends are read with the source's session: one context only
    if to.context != from.context {
        return Err(BackendError::invalid("reach checks two objects of one context"));
    }
    match (to.gvr.group.as_str(), to.gvr.resource.as_str()) {
        ("", "services") if to.ns().is_some() => Ok(true),
        ("", "pods") if to.ns().is_some() => Ok(false),
        _ => Err(BackendError::invalid("reach goes to a Service or a pod")),
    }
}

pub async fn input(state: &AppState, from: &ObjRef, to: &ObjRef, port: Option<PortRef>) -> Result<ReachInput> {
    require(from, "pods", "a pod to start from")?;
    let to_is_service = require_to(from, to)?;
    let session = state.session(&from.context).await?;
    let from_pod = crate::objects::get(&session, from).await?;
    let to_obj = crate::objects::get(&session, to).await?;
    let ns = to.ns();
    let mut inp = ReachInput { from_pod, to: to_obj, to_is_service, port, ..Default::default() };
    if to_is_service {
        if let Some(sel) = crate::diagnose::selector_string(&inp.to["spec"]["selector"]) {
            inp.dest_pods = list(&session, &pods_gvr(), ns, Some(&sel)).await.unwrap_or_default();
        }
        let slice_sel = format!("kubernetes.io/service-name={}", to.name);
        inp.slices = list(&session, &Gvr::new("discovery.k8s.io", "v1", "endpointslices"), ns, Some(&slice_sel)).await.ok();
    } else {
        inp.dest_pods = vec![inp.to.clone()];
    }
    let np = Gvr::new("networking.k8s.io", "v1", "networkpolicies");
    inp.src_policies = list(&session, &np, from.ns(), None).await.ok();
    inp.dst_policies = if from.ns() == ns { inp.src_policies.clone() } else { list(&session, &np, ns, None).await.ok() };
    inp.namespaces = list(&session, &Gvr::new("", "v1", "namespaces"), None, None).await.ok();
    if let Ok(d) = session.discovery(None).await {
        for (group, kind) in [("cilium.io", "CiliumNetworkPolicy"), ("crd.projectcalico.org", "NetworkPolicy (Calico)"), ("policy.networking.k8s.io", "AdminNetworkPolicy")] {
            if d.has_group(group) {
                inp.other_policy_kinds.push(kind.to_string());
            }
        }
    }
    Ok(inp)
}

pub async fn reach(state: &AppState, from: &ObjRef, to: &ObjRef, port: Option<PortRef>) -> Result<ReachCheck> {
    let inp = input(state, from, to, port).await?;
    Ok(finish(chain(from, to, &inp)))
}

// ───────────────────────── probe ─────────────────────────

/// DNS-1123 label: `[a-z0-9]([-a-z0-9]*[a-z0-9])?`, at most 63.
pub fn is_dns_label(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 63
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && b[0] != b'-'
        && b[b.len() - 1] != b'-'
}

/// The host and port the probe connects to: `<svc>.<ns>.svc` and the Service port, or the pod IP
/// and its container port. Everything is validated here; nothing else reaches the script.
pub fn probe_target(to: &ObjRef, to_obj: &Json, to_is_service: bool, port: &PortRef) -> Result<(String, u16)> {
    let port = normalize_port(port);
    if to_is_service {
        let ns = to.ns().unwrap_or_default();
        if !is_dns_label(&to.name) || !is_dns_label(ns) {
            return Err(BackendError::invalid("Service name or namespace is not a DNS label"));
        }
        let (_, sp) = service_port(to_obj, Some(&port)).ok_or_else(|| BackendError::invalid(format!("the Service has no port {port}")))?;
        let n = sp["port"].as_u64().and_then(|n| u16::try_from(n).ok()).filter(|n| *n > 0).ok_or_else(|| BackendError::invalid("bad Service port"))?;
        Ok((format!("{}.{ns}.svc", to.name), n))
    } else {
        let ip: IpAddr = s(&to_obj["status"]["podIP"]).parse().map_err(|_| BackendError::invalid("the pod has no IP yet"))?;
        let target = match &port {
            PortRef::Number(n) => Json::from(*n),
            PortRef::Name(n) => Json::from(n.as_str()),
        };
        let (n, _) = container_port(to_obj, &target).ok_or_else(|| BackendError::invalid(format!("the pod declares no port {port}")))?;
        if n == 0 {
            return Err(BackendError::invalid("bad port"));
        }
        Ok((ip.to_string(), n))
    }
}

/// The fixed probe script: `nc -z -w2`, else `wget -T2 --spider`, else bash `/dev/tcp`. It prints
/// one marker line `KNS_TOOL=<tool> KNS_RC=<code>`; `host` and `port` are validated by `probe_target`.
pub fn probe_script(host: &str, port: u16) -> String {
    let h = if host.contains(':') { format!("[{host}]") } else { host.to_string() };
    format!(
        "h='{host}'; p={port}\n\
         if command -v nc >/dev/null 2>&1; then nc -z -w2 \"$h\" \"$p\" 2>&1; echo \"KNS_TOOL=nc KNS_RC=$?\"\n\
         elif command -v wget >/dev/null 2>&1; then wget -T2 --spider 'http://{h}:{port}/' 2>&1; echo \"KNS_TOOL=wget KNS_RC=$?\"\n\
         elif command -v bash >/dev/null 2>&1; then bash -c 'exec 3<>/dev/tcp/'\"$h\"'/'\"$p\" 2>&1; echo \"KNS_TOOL=bash KNS_RC=$?\"\n\
         else echo 'KNS_TOOL=none KNS_RC=127'; fi"
    )
}

/// Reads the marker line: (tool, exit code of the tool).
pub fn parse_marker(out: &str) -> Option<(String, i32)> {
    let line = out.lines().rev().find(|l| l.starts_with("KNS_TOOL="))?;
    let mut tool = None;
    let mut rc = None;
    for part in line.split_whitespace() {
        if let Some(t) = part.strip_prefix("KNS_TOOL=") {
            tool = Some(t.to_string());
        } else if let Some(c) = part.strip_prefix("KNS_RC=") {
            rc = c.parse().ok();
        }
    }
    Some((tool?, rc?))
}

/// Connected? `wget` exits non-zero on an HTTP error or a non-HTTP answer although the TCP
/// connection worked; only network errors count as a failure there.
pub fn probe_ok(tool: &str, rc: i32, out: &str) -> bool {
    if rc == 0 {
        return true;
    }
    if tool != "wget" {
        return false;
    }
    let l = out.to_ascii_lowercase();
    let network = ["refused", "timed out", "timeout", "bad address", "unreachable", "no route", "can't connect", "unable to resolve", "name or service not known", "failed: connection"];
    !network.iter().any(|w| l.contains(w)) && (l.contains("server returned error") || l.contains("http/") || l.contains("error 4") || l.contains("error 5") || l.contains("response"))
}

/// What the human reads: the tool output without the marker line.
fn strip_marker(out: &str) -> String {
    out.lines().filter(|l| !l.starts_with("KNS_TOOL=")).collect::<Vec<_>>().join("\n").trim().to_string()
}

pub async fn probe(state: &AppState, from: &ObjRef, to: &ObjRef, port: &PortRef) -> Result<ReachProbeResult> {
    require(from, "pods", "a pod to start from")?;
    let to_is_service = require_to(from, to)?;
    let session = state.session(&from.context).await?;
    let to_obj = crate::objects::get(&session, to).await?;
    let (host, n) = probe_target(to, &to_obj, to_is_service, port)?;
    let script = probe_script(&host, n);
    let command = format!("{} {n}", if to_is_service { host.clone() } else { format!("pod {} ({host})", to.name) });
    let allowed = crate::rbac::can_i(
        state,
        &AccessQuery { context: from.context.clone(), verb: "create".into(), gvr: pods_gvr(), subresource: Some("exec".into()), namespace: from.namespace.clone(), name: Some(from.name.clone()) },
    )
    .await
    .unwrap_or(false);
    if !allowed {
        return Ok(ReachProbeResult { ok: false, command, output: "not allowed to exec into this pod (create pods/exec)".into(), tool: None, needs_debug: true });
    }
    let req = crate::ipc::SnippetRunRequest { obj_ref: from.clone(), container: None, command: script, timeout_seconds: Some(10) };
    let out = match crate::debug::snippet_run(state, &req).await {
        Ok(o) => o,
        Err(e) => {
            // no `sh` in the image (distroless) or the exec was refused
            let msg = clean_untrusted(&Redactor::new().text(&e.message), MAX_LINE);
            return Ok(ReachProbeResult { ok: false, command, output: format!("could not run the probe: {msg}"), tool: None, needs_debug: true });
        }
    };
    let Some((tool, rc)) = parse_marker(&out.output) else {
        let why = out.message.clone().unwrap_or_else(|| "no shell in the image".into());
        return Ok(ReachProbeResult { ok: false, command, output: format!("{why}\n{}", strip_marker(&out.output)).trim().to_string(), tool: None, needs_debug: true });
    };
    let text = strip_marker(&out.output);
    if tool == "none" {
        return Ok(ReachProbeResult { ok: false, command, output: "the image has none of nc, wget or bash".into(), tool: None, needs_debug: true });
    }
    let ok = probe_ok(&tool, rc, &text);
    let label = match tool.as_str() {
        "nc" => format!("nc -z -w2 {command}"),
        "wget" => format!("wget -T2 --spider {command}"),
        _ => format!("bash /dev/tcp {command}"),
    };
    Ok(ReachProbeResult { ok, command: label, output: if text.is_empty() { format!("exit {rc}") } else { text }, tool: Some(tool), needs_debug: false })
}

pub mod cmd {
    use crate::ipc::{ObjRef, PortRef, ReachCheck, ReachProbeResult, Result};
    use crate::state::AppState;

    #[tauri::command]
    pub async fn reach(state: tauri::State<'_, AppState>, from: ObjRef, to: ObjRef, port: Option<PortRef>) -> Result<ReachCheck> {
        super::reach(&state, &from, &to, port).await
    }

    #[tauri::command]
    pub async fn reach_probe(state: tauri::State<'_, AppState>, from: ObjRef, to: ObjRef, port: PortRef) -> Result<ReachProbeResult> {
        super::probe(&state, &from, &to, &port).await
    }
}

#[cfg(test)]
mod tests;
