//! NetworkPolicy evaluation "by standard rules" (networking.k8s.io/v1 semantics), pure and
//! tri-state: `Some(true)` allowed, `Some(false)` denied, `None` kns cannot decide (namespace labels
//! not readable, an `ipBlock` without a pod IP). CNI-specific policy kinds are not read here.
use std::net::IpAddr;

use crate::ipc::Json;

pub type Tri = Option<bool>;

/// A pod as the evaluation sees it.
#[derive(Debug, Clone, Default)]
pub struct Peer<'a> {
    pub namespace: &'a str,
    pub labels: &'a Json,
    /// labels of the pod's namespace; None = not readable (only `kubernetes.io/metadata.name` is known)
    pub ns_labels: Option<&'a Json>,
    pub ip: Option<IpAddr>,
}

/// The destination port of the connection: the container port number and, when the container
/// declares it, its name (named ports in a policy refer to it).
#[derive(Debug, Clone, Copy)]
pub struct Port<'a> {
    pub number: u16,
    pub name: Option<&'a str>,
    /// "TCP" / "UDP" / "SCTP"
    pub protocol: &'a str,
}

fn and(a: Tri, b: Tri) -> Tri {
    match (a, b) {
        (Some(false), _) | (_, Some(false)) => Some(false),
        (Some(true), Some(true)) => Some(true),
        _ => None,
    }
}

/// Tri-state OR over many: true wins, else undecided wins over false. (Not a short-circuit: a later
/// `true` must still beat an earlier `None`.)
fn any(it: impl Iterator<Item = Tri>) -> Tri {
    let mut acc = Some(false);
    for v in it {
        acc = or(acc, v);
    }
    acc
}

fn or(a: Tri, b: Tri) -> Tri {
    match (a, b) {
        (Some(true), _) | (_, Some(true)) => Some(true),
        (Some(false), Some(false)) => Some(false),
        _ => None,
    }
}

/// A label selector against a label map. Empty selector = everything. Unknown operator = no match.
pub fn selector_matches(sel: &Json, labels: &Json) -> bool {
    let label = |k: &str| labels.get(k).and_then(Json::as_str);
    if let Some(ml) = sel["matchLabels"].as_object() {
        for (k, v) in ml {
            if label(k) != v.as_str() {
                return false;
            }
        }
    }
    for e in sel["matchExpressions"].as_array().map(Vec::as_slice).unwrap_or_default() {
        let key = e["key"].as_str().unwrap_or_default();
        let values: Vec<&str> = e["values"].as_array().map(|v| v.iter().filter_map(Json::as_str).collect()).unwrap_or_default();
        let ok = match e["operator"].as_str() {
            Some("In") => label(key).is_some_and(|v| values.contains(&v)),
            Some("NotIn") => label(key).is_none_or(|v| !values.contains(&v)),
            Some("Exists") => label(key).is_some(),
            Some("DoesNotExist") => label(key).is_none(),
            _ => false,
        };
        if !ok {
            return false;
        }
    }
    true
}

/// A namespaceSelector against a namespace. Without its labels only `kubernetes.io/metadata.name`
/// (set by the API server on every namespace) can be decided.
fn ns_selector_matches(sel: &Json, p: &Peer) -> Tri {
    if let Some(labels) = p.ns_labels {
        return Some(selector_matches(sel, labels));
    }
    let only_name = sel["matchExpressions"].as_array().is_none_or(Vec::is_empty)
        && sel["matchLabels"].as_object().is_some_and(|m| m.len() == 1 && m.contains_key("kubernetes.io/metadata.name"));
    if sel.as_object().is_some_and(|m| m.values().all(|v| v.as_object().is_some_and(|x| x.is_empty()) || v.as_array().is_some_and(|x| x.is_empty()))) {
        return Some(true); // {} or empty lists: every namespace
    }
    if only_name {
        return Some(sel["matchLabels"]["kubernetes.io/metadata.name"].as_str() == Some(p.namespace));
    }
    None
}

/// `cidr` (and its `except` list) contains `ip`.
pub fn cidr_contains(cidr: &str, ip: IpAddr) -> Option<bool> {
    let (addr, bits) = cidr.split_once('/')?;
    let addr: IpAddr = addr.parse().ok()?;
    let bits: u32 = bits.parse().ok()?;
    match (addr, ip) {
        (IpAddr::V4(a), IpAddr::V4(b)) if bits <= 32 => {
            let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
            Some(u32::from(a) & mask == u32::from(b) & mask)
        }
        (IpAddr::V6(a), IpAddr::V6(b)) if bits <= 128 => {
            let mask = if bits == 0 { 0 } else { u128::MAX << (128 - bits) };
            Some(u128::from(a) & mask == u128::from(b) & mask)
        }
        (IpAddr::V4(_), IpAddr::V6(_)) | (IpAddr::V6(_), IpAddr::V4(_)) => Some(false),
        _ => None,
    }
}

/// One `from` / `to` peer against the other pod. `policy_ns`: the policy's namespace.
fn peer_matches(peer: &Json, policy_ns: &str, p: &Peer) -> Tri {
    if let Some(block) = peer.get("ipBlock").filter(|b| b.is_object()) {
        let ip = p.ip?;
        let inside = cidr_contains(block["cidr"].as_str().unwrap_or_default(), ip)?;
        let except = block["except"].as_array().map(Vec::as_slice).unwrap_or_default();
        let excluded = except.iter().filter_map(Json::as_str).any(|c| cidr_contains(c, ip) == Some(true));
        return Some(inside && !excluded);
    }
    let pod_sel = peer.get("podSelector").filter(|s| s.is_object());
    let ns_sel = peer.get("namespaceSelector").filter(|s| s.is_object());
    match (pod_sel, ns_sel) {
        (Some(ps), None) => Some(p.namespace == policy_ns && selector_matches(ps, p.labels)),
        (None, Some(ns)) => ns_selector_matches(ns, p),
        (Some(ps), Some(ns)) => and(ns_selector_matches(ns, p), Some(selector_matches(ps, p.labels))),
        (None, None) => Some(false),
    }
}

/// One `ports` entry against the destination port.
fn port_matches(entry: &Json, port: &Port) -> bool {
    let proto = entry["protocol"].as_str().unwrap_or("TCP");
    if !proto.eq_ignore_ascii_case(port.protocol) {
        return false;
    }
    match &entry["port"] {
        Json::Null => true,
        Json::Number(n) => {
            let start = n.as_u64().unwrap_or(0);
            let end = entry["endPort"].as_u64().unwrap_or(start);
            (start..=end).contains(&u64::from(port.number))
        }
        Json::String(name) => match name.parse::<u16>() {
            Ok(n) => n == port.number,
            Err(_) => port.name == Some(name.as_str()),
        },
        _ => false,
    }
}

fn rule_matches(rule: &Json, peers_key: &str, policy_ns: &str, other: &Peer, port: &Port) -> Tri {
    let ports = rule["ports"].as_array().map(Vec::as_slice).unwrap_or_default();
    if !ports.is_empty() && !ports.iter().any(|e| port_matches(e, port)) {
        return Some(false);
    }
    let peers = rule[peers_key].as_array().map(Vec::as_slice).unwrap_or_default();
    if peers.is_empty() {
        return Some(true);
    }
    any(peers.iter().map(|peer| peer_matches(peer, policy_ns, other)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Ingress,
    Egress,
}

/// Does this policy constrain `dir` traffic of pods it selects? (`policyTypes` omitted: Ingress
/// always, Egress when the policy has an `egress` section.)
pub fn has_type(policy: &Json, dir: Direction) -> bool {
    let word = match dir {
        Direction::Ingress => "Ingress",
        Direction::Egress => "Egress",
    };
    match policy["spec"]["policyTypes"].as_array() {
        Some(types) if !types.is_empty() => types.iter().any(|t| t.as_str() == Some(word)),
        _ => dir == Direction::Ingress || policy["spec"].get("egress").is_some_and(|e| !e.is_null()),
    }
}

/// The verdict for one pod and one direction.
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub allowed: Tri,
    /// names of the policies that select the pod for this direction (empty: not isolated)
    pub selecting: Vec<String>,
    /// policies whose rules allow it (or might: undecided)
    pub allowing: Vec<String>,
}

/// `subject`: the pod the policies are about (destination for Ingress, source for Egress);
/// `other`: the far end. `policies` are the NetworkPolicies of the subject's namespace.
pub fn evaluate(policies: &[Json], dir: Direction, subject: &Peer, other: &Peer, port: &Port) -> Verdict {
    let (rules_key, peers_key) = match dir {
        Direction::Ingress => ("ingress", "from"),
        Direction::Egress => ("egress", "to"),
    };
    let mut selecting = Vec::new();
    let mut allowing = Vec::new();
    let mut allowed: Tri = Some(false);
    for p in policies {
        let ns = p["metadata"]["namespace"].as_str().unwrap_or(subject.namespace);
        if ns != subject.namespace || !has_type(p, dir) || !selector_matches(&p["spec"]["podSelector"], subject.labels) {
            continue;
        }
        let name = p["metadata"]["name"].as_str().unwrap_or_default().to_string();
        selecting.push(name.clone());
        let rules = p["spec"][rules_key].as_array().map(Vec::as_slice).unwrap_or_default();
        let v = any(rules.iter().map(|r| rule_matches(r, peers_key, ns, other, port)));
        if v != Some(false) {
            allowing.push(name);
        }
        allowed = or(allowed, v);
    }
    if selecting.is_empty() {
        allowed = Some(true);
    }
    Verdict { allowed, selecting, allowing }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pol(name: &str, ns: &str, spec: Json) -> Json {
        json!({ "metadata": { "name": name, "namespace": ns }, "spec": spec })
    }

    const TCP80: Port = Port { number: 80, name: Some("http"), protocol: "TCP" };

    fn web() -> Json {
        json!({ "app": "web" })
    }
    fn client() -> Json {
        json!({ "app": "client" })
    }
    fn nsl(name: &str) -> Json {
        json!({ "kubernetes.io/metadata.name": name, "team": "a" })
    }

    fn peers<'a>(dst_labels: &'a Json, src_labels: &'a Json, src_ns: &'a str, src_ns_labels: Option<&'a Json>) -> (Peer<'a>, Peer<'a>) {
        (
            Peer { namespace: "app", labels: dst_labels, ns_labels: None, ip: Some("10.42.0.10".parse().unwrap()) },
            Peer { namespace: src_ns, labels: src_labels, ns_labels: src_ns_labels, ip: Some("10.42.1.5".parse().unwrap()) },
        )
    }

    #[test]
    fn no_policy_selects_the_pod_allows() {
        let (w, c) = (web(), client());
        let (dst, src) = peers(&w, &c, "app", None);
        let other = pol("db-only", "app", json!({ "podSelector": { "matchLabels": { "app": "db" } }, "ingress": [] }));
        let v = evaluate(&[other], Direction::Ingress, &dst, &src, &TCP80);
        assert_eq!(v.allowed, Some(true));
        assert!(v.selecting.is_empty());
    }

    #[test]
    fn empty_ingress_denies_and_omitted_policy_types_mean_ingress() {
        let (w, c) = (web(), client());
        let (dst, src) = peers(&w, &c, "app", None);
        let deny = pol("deny-all", "app", json!({ "podSelector": {} }));
        let v = evaluate(std::slice::from_ref(&deny), Direction::Ingress, &dst, &src, &TCP80);
        assert_eq!(v.allowed, Some(false));
        assert_eq!(v.selecting, vec!["deny-all"]);
        // the same policy does not isolate egress (no egress section, no policyTypes)
        assert_eq!(evaluate(&[deny], Direction::Egress, &src, &dst, &TCP80).allowed, Some(true));
    }

    #[test]
    fn pod_selector_peer_and_named_port_and_end_port() {
        let (w, c) = (web(), client());
        let (dst, src) = peers(&w, &c, "app", None);
        let allow = pol("allow-client", "app", json!({
            "podSelector": { "matchLabels": { "app": "web" } },
            "ingress": [{ "from": [{ "podSelector": { "matchLabels": { "app": "client" } } }], "ports": [{ "port": "http" }] }]
        }));
        assert_eq!(evaluate(std::slice::from_ref(&allow), Direction::Ingress, &dst, &src, &TCP80).allowed, Some(true));
        let other_port = Port { number: 8080, name: None, protocol: "TCP" };
        assert_eq!(evaluate(std::slice::from_ref(&allow), Direction::Ingress, &dst, &src, &other_port).allowed, Some(false));
        // same labels in another namespace: a bare podSelector means the policy's namespace only
        let (dst2, src2) = peers(&w, &c, "other", None);
        assert_eq!(evaluate(&[allow], Direction::Ingress, &dst2, &src2, &TCP80).allowed, Some(false));
        let range = pol("range", "app", json!({ "podSelector": {}, "ingress": [{ "ports": [{ "port": 8000, "endPort": 8100 }] }] }));
        assert_eq!(evaluate(std::slice::from_ref(&range), Direction::Ingress, &dst, &src, &other_port).allowed, Some(true));
        assert_eq!(evaluate(&[range], Direction::Ingress, &dst, &src, &Port { number: 8080, name: None, protocol: "UDP" }).allowed, Some(false));
    }

    #[test]
    fn namespace_selector_with_and_without_labels() {
        let (w, c) = (web(), client());
        let labels = nsl("other");
        let by_team = pol("team-a", "app", json!({ "podSelector": {}, "ingress": [{ "from": [{ "namespaceSelector": { "matchLabels": { "team": "a" } } }] }] }));
        let (dst, src) = peers(&w, &c, "other", Some(&labels));
        assert_eq!(evaluate(std::slice::from_ref(&by_team), Direction::Ingress, &dst, &src, &TCP80).allowed, Some(true));
        // namespace labels not readable: undecided
        let (dst, src) = peers(&w, &c, "other", None);
        assert_eq!(evaluate(&[by_team], Direction::Ingress, &dst, &src, &TCP80).allowed, None);
        // ... but the metadata.name label is always known
        let by_name = pol("by-name", "app", json!({ "podSelector": {}, "ingress": [{ "from": [{
            "namespaceSelector": { "matchLabels": { "kubernetes.io/metadata.name": "other" } },
            "podSelector": { "matchExpressions": [{ "key": "app", "operator": "In", "values": ["client", "x"] }] }
        }] }] }));
        assert_eq!(evaluate(&[by_name], Direction::Ingress, &dst, &src, &TCP80).allowed, Some(true));
    }

    #[test]
    fn ip_block_with_except() {
        let (w, c) = (web(), client());
        let (dst, src) = peers(&w, &c, "app", None);
        let p = pol("cidr", "app", json!({ "podSelector": {}, "policyTypes": ["Ingress"], "ingress": [{ "from": [{ "ipBlock": { "cidr": "10.42.0.0/16", "except": ["10.42.1.0/24"] } }] }] }));
        assert_eq!(evaluate(std::slice::from_ref(&p), Direction::Ingress, &dst, &src, &TCP80).allowed, Some(false));
        let src_ok = Peer { ip: Some("10.42.2.9".parse().unwrap()), ..src.clone() };
        assert_eq!(evaluate(std::slice::from_ref(&p), Direction::Ingress, &dst, &src_ok, &TCP80).allowed, Some(true));
        let src_noip = Peer { ip: None, ..src };
        assert_eq!(evaluate(&[p], Direction::Ingress, &dst, &src_noip, &TCP80).allowed, None);
    }

    #[test]
    fn egress_policy_and_union_of_policies() {
        let (w, c) = (web(), client());
        let (dst, src) = peers(&w, &c, "app", None);
        let dns_only = pol("dns-only", "app", json!({ "podSelector": { "matchLabels": { "app": "client" } }, "policyTypes": ["Egress"], "egress": [{ "ports": [{ "port": 53, "protocol": "UDP" }] }] }));
        let v = evaluate(std::slice::from_ref(&dns_only), Direction::Egress, &src, &dst, &TCP80);
        assert_eq!(v.allowed, Some(false));
        let to_web = pol("to-web", "app", json!({ "podSelector": { "matchLabels": { "app": "client" } }, "policyTypes": ["Egress"], "egress": [{ "to": [{ "podSelector": { "matchLabels": { "app": "web" } } }] }] }));
        let v = evaluate(&[dns_only, to_web], Direction::Egress, &src, &dst, &TCP80);
        assert_eq!(v.allowed, Some(true));
        assert_eq!(v.selecting.len(), 2);
        assert_eq!(v.allowing, vec!["to-web"]);
    }

    #[test]
    fn selector_operators_and_cidr() {
        let l = json!({ "app": "web", "tier": "fe" });
        assert!(selector_matches(&json!({}), &l));
        assert!(selector_matches(&json!({ "matchExpressions": [{ "key": "tier", "operator": "NotIn", "values": ["be"] }] }), &l));
        assert!(!selector_matches(&json!({ "matchExpressions": [{ "key": "tier", "operator": "DoesNotExist" }] }), &l));
        assert!(!selector_matches(&json!({ "matchExpressions": [{ "key": "tier", "operator": "Bogus" }] }), &l));
        assert_eq!(cidr_contains("0.0.0.0/0", "1.2.3.4".parse().unwrap()), Some(true));
        assert_eq!(cidr_contains("fd00::/8", "fd12::1".parse().unwrap()), Some(true));
        assert_eq!(cidr_contains("10.0.0.0/8", "fd12::1".parse().unwrap()), Some(false));
        assert_eq!(cidr_contains("nonsense", "1.2.3.4".parse().unwrap()), None);
    }
}
