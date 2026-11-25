//! `:traffic`: who a pod talks to, in and out (docs/tools.md#traffic).
//!
//! The Kubernetes API has no traffic, so kns reads the pod's socket table: one exec of
//! `cat /proc/net/tcp /proc/net/tcp6 /proc/net/udp /proc/net/udp6` in a container of the pod. Every
//! container shares the pod's network namespace, so any one of them shows every socket of the pod.
//! A fixed command, nothing written; an image without `cat` (distroless) is read through a running
//! kns debug container (`B`), when the pod has one.
//!
//! Each reading is a snapshot of the open sockets: a connection that opens and closes between two
//! readings is not seen. The UI reads every few seconds and adds the readings up.
//!
//! Peer addresses are named from the pods, Services and nodes of the context (listed at most once a
//! minute): across all namespaces, or, where that is forbidden, in the namespaces the UI names.
use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::Mutex,
    time::{Duration, Instant},
};

use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, AttachParams};
use tokio::io::AsyncReadExt;

use crate::{
    contract::{TrafficConnection, TrafficDirection, TrafficListener, TrafficPeer, TrafficPeerKind, TrafficProto, TrafficRequest, TrafficSample},
    ipc::{BackendError, Gvr, Json, Result},
    redact::clean_untrusted,
    session::{Session, api_path, with_query},
    state::AppState,
};

const TABLES: [&str; 4] = ["/proc/net/tcp", "/proc/net/tcp6", "/proc/net/udp", "/proc/net/udp6"];
const READ_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_TABLE: u64 = 8 << 20;
/// How long the pods, Services and nodes of a context are reused.
const DIRECTORY_TTL: Duration = Duration::from_secs(60);
const MAX_NAMESPACES: usize = 40;
const MAX_CONNECTIONS: usize = 5000;
pub const NEEDS_DEBUG: &str = "NeedsDebug";

// ───────────────────────── the socket table (pure) ─────────────────────────

/// One socket of `/proc/net/{tcp,udp}[6]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Socket {
    pub proto: TrafficProto,
    pub local: (IpAddr, u16),
    pub remote: (IpAddr, u16),
    /// the kernel's state number
    pub state: u8,
}

/// `0100007F` (IPv4) or 32 hex digits (IPv6): words in host byte order, little-endian on every
/// platform Kubernetes runs on.
fn parse_ip(hex: &str) -> Option<IpAddr> {
    let word = |s: &str| u32::from_str_radix(s, 16).ok().map(u32::to_le_bytes);
    match hex.len() {
        8 => word(hex).map(|b| IpAddr::V4(Ipv4Addr::from(b))),
        32 => {
            let mut bytes = [0u8; 16];
            for i in 0..4 {
                bytes[i * 4..i * 4 + 4].copy_from_slice(&word(&hex[i * 8..i * 8 + 8])?);
            }
            let v6 = Ipv6Addr::from(bytes);
            // an IPv4 peer of a dual-stack socket: ::ffff:a.b.c.d
            Some(v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4))
        }
        _ => None,
    }
}

fn parse_addr(s: &str) -> Option<(IpAddr, u16)> {
    let (ip, port) = s.split_once(':')?;
    Some((parse_ip(ip)?, u16::from_str_radix(port, 16).ok()?))
}

/// Every socket in the output of `cat` over the four tables. Each table starts with its header
/// line; UDP's header ends in `drops`, TCP's does not.
pub fn parse_tables(text: &str) -> Vec<Socket> {
    let mut out = Vec::new();
    let mut proto = TrafficProto::Tcp;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("sl") {
            proto = if line.contains("drops") { TrafficProto::Udp } else { TrafficProto::Tcp };
            continue;
        }
        let mut f = line.split_whitespace();
        let (Some(_sl), Some(local), Some(remote), Some(state)) = (f.next(), f.next(), f.next(), f.next()) else { continue };
        let (Some(local), Some(remote), Ok(state)) = (parse_addr(local), parse_addr(remote), u8::from_str_radix(state, 16)) else { continue };
        out.push(Socket { proto, local, remote, state });
    }
    out
}

pub fn state_name(proto: TrafficProto, state: u8) -> &'static str {
    match (proto, state) {
        (TrafficProto::Udp, 1) => "ESTABLISHED",
        (TrafficProto::Udp, _) => "UNCONNECTED",
        (_, 1) => "ESTABLISHED",
        (_, 2) => "SYN_SENT",
        (_, 3) => "SYN_RECV",
        (_, 4) => "FIN_WAIT1",
        (_, 5) => "FIN_WAIT2",
        (_, 6) => "TIME_WAIT",
        (_, 7) => "CLOSE",
        (_, 8) => "CLOSE_WAIT",
        (_, 9) => "LAST_ACK",
        (_, 10) => "LISTEN",
        (_, 11) => "CLOSING",
        _ => "UNKNOWN",
    }
}

const TCP_LISTEN: u8 = 10;
const UDP_UNCONNECTED: u8 = 7;

fn is_listener(s: &Socket) -> bool {
    match s.proto {
        TrafficProto::Tcp => s.state == TCP_LISTEN,
        TrafficProto::Udp => s.state == UDP_UNCONNECTED && s.remote.0.is_unspecified() && s.remote.1 == 0,
    }
}

/// The listeners, and each other socket with a peer as a connection: inbound when its local port
/// is one the pod listens on (same protocol), outbound otherwise.
pub fn split(sockets: &[Socket]) -> (Vec<TrafficListener>, Vec<(TrafficDirection, &Socket)>) {
    let mut listening = Vec::new();
    let mut ports: HashSet<(TrafficProto, u16)> = HashSet::new();
    let mut seen = HashSet::new();
    for s in sockets.iter().filter(|s| is_listener(s)) {
        ports.insert((s.proto, s.local.1));
        if seen.insert((s.proto, s.local)) {
            listening.push(TrafficListener { proto: s.proto, ip: s.local.0.to_string(), port: s.local.1 });
        }
    }
    listening.sort_by_key(|l| (l.port, l.proto == TrafficProto::Udp));
    let conns = sockets
        .iter()
        .filter(|s| !is_listener(s) && !(s.remote.0.is_unspecified() && s.remote.1 == 0))
        .map(|s| (if ports.contains(&(s.proto, s.local.1)) { TrafficDirection::In } else { TrafficDirection::Out }, s))
        .collect();
    (listening, conns)
}

// ───────────────────────── naming peers ─────────────────────────

#[derive(Debug, Clone, Default)]
pub struct Directory {
    pub pods: HashMap<IpAddr, (String, String, Option<String>)>,
    pub services: HashMap<IpAddr, (String, String)>,
    pub nodes: HashMap<IpAddr, String>,
    pub notes: Vec<String>,
}

/// A pod's workload: its owner, a ReplicaSet named `<deployment>-<pod-template-hash>` as the Deployment.
pub fn workload_of(pod: &Json) -> Option<String> {
    let owner = pod["metadata"]["ownerReferences"].as_array()?.iter().find(|o| o["controller"].as_bool() == Some(true)).or_else(|| pod["metadata"]["ownerReferences"].as_array()?.first())?;
    let (kind, name) = (owner["kind"].as_str()?, owner["name"].as_str()?);
    let hash = pod["metadata"]["labels"]["pod-template-hash"].as_str();
    match (kind, hash.and_then(|h| name.strip_suffix(&format!("-{h}")))) {
        ("ReplicaSet", Some(deploy)) => Some(format!("Deployment/{deploy}")),
        _ => Some(format!("{kind}/{name}")),
    }
}

fn ips(values: impl Iterator<Item = Option<String>>) -> Vec<IpAddr> {
    values.flatten().filter_map(|s| s.parse().ok()).collect()
}

impl Directory {
    /// Adds the items of a pod, Service or node list.
    pub fn add(&mut self, resource: &str, list: &Json) {
        let items = list["items"].as_array().map(Vec::as_slice).unwrap_or_default();
        for it in items {
            let ns = it["metadata"]["namespace"].as_str().unwrap_or_default().to_string();
            let name = it["metadata"]["name"].as_str().unwrap_or_default().to_string();
            match resource {
                "pods" => {
                    // a host-network pod has its node's address: the node names it
                    if it["spec"]["hostNetwork"].as_bool() == Some(true) {
                        continue;
                    }
                    let mut all = ips(it["status"]["podIPs"].as_array().into_iter().flatten().map(|p| p["ip"].as_str().map(String::from)));
                    all.extend(ips(std::iter::once(it["status"]["podIP"].as_str().map(String::from))));
                    let w = workload_of(it);
                    for ip in all {
                        self.pods.insert(ip, (ns.clone(), name.clone(), w.clone()));
                    }
                }
                "services" => {
                    let mut all = ips(it["spec"]["clusterIPs"].as_array().into_iter().flatten().map(|p| p.as_str().map(String::from)));
                    all.extend(ips(std::iter::once(it["spec"]["clusterIP"].as_str().map(String::from))));
                    all.extend(ips(it["status"]["loadBalancer"]["ingress"].as_array().into_iter().flatten().map(|p| p["ip"].as_str().map(String::from))));
                    for ip in all {
                        self.services.insert(ip, (ns.clone(), name.clone()));
                    }
                }
                "nodes" => {
                    for ip in ips(it["status"]["addresses"].as_array().into_iter().flatten().map(|a| a["address"].as_str().map(String::from))) {
                        self.nodes.insert(ip, name.clone());
                    }
                }
                _ => {}
            }
        }
    }

    /// Who `ip` is, seen from the pod whose own addresses are `own`.
    pub fn peer(&self, ip: IpAddr, own: &HashSet<IpAddr>, own_pod: (&str, &str)) -> TrafficPeer {
        let plain = |kind| TrafficPeer { kind, namespace: None, name: ip.to_string(), workload: None };
        if ip.is_loopback() {
            return plain(TrafficPeerKind::Loopback);
        }
        if own.contains(&ip) {
            return TrafficPeer { kind: TrafficPeerKind::Own, namespace: Some(own_pod.0.to_string()), name: own_pod.1.to_string(), workload: None };
        }
        if let Some((ns, name)) = self.services.get(&ip) {
            return TrafficPeer { kind: TrafficPeerKind::Service, namespace: Some(ns.clone()), name: name.clone(), workload: None };
        }
        if let Some((ns, name, w)) = self.pods.get(&ip) {
            return TrafficPeer { kind: TrafficPeerKind::Pod, namespace: Some(ns.clone()), name: name.clone(), workload: w.clone() };
        }
        if let Some(name) = self.nodes.get(&ip) {
            return TrafficPeer { kind: TrafficPeerKind::Node, namespace: None, name: name.clone(), workload: None };
        }
        plain(TrafficPeerKind::External)
    }
}

/// The pods, Services and nodes of a context, per context and namespace list, reused for a minute.
type Cached = HashMap<String, (Instant, std::sync::Arc<Directory>)>;
static DIRECTORIES: Mutex<Option<Cached>> = Mutex::new(None);

fn gvr(resource: &str) -> Gvr {
    Gvr::new("", "v1", resource)
}

async fn list_into(session: &Session, dir: &mut Directory, resource: &str, namespaces: &[String]) {
    let path = |ns: Option<&str>| {
        let p = api_path(&gvr(resource), ns, None);
        if resource == "pods" { with_query(&p, &[("fieldSelector", "status.phase=Running")]) } else { p }
    };
    match session.get(&path(None)).await {
        Ok(list) => dir.add(resource, &list),
        Err(e) if resource == "nodes" => dir.notes.push(format!("nodes: {}", short(&e.message))),
        Err(e) if e.code == 403 && !namespaces.is_empty() => {
            let mut failed = 0;
            for ns in namespaces.iter().take(MAX_NAMESPACES) {
                match session.get(&path(Some(ns))).await {
                    Ok(list) => dir.add(resource, &list),
                    Err(_) => failed += 1,
                }
            }
            let shown = namespaces.iter().take(MAX_NAMESPACES).cloned().collect::<Vec<_>>().join(", ");
            dir.notes.push(format!("{resource}: forbidden across all namespaces; looked in {shown}{}", if failed > 0 { format!(" ({failed} refused)") } else { String::new() }));
        }
        Err(e) => dir.notes.push(format!("{resource}: {}", short(&e.message))),
    }
}

fn short(s: &str) -> String {
    clean_untrusted(s.lines().next().unwrap_or_default(), 200)
}

async fn directory(session: &Session, context: &str, namespaces: &[String]) -> std::sync::Arc<Directory> {
    let key = format!("{context}\u{1}{}", namespaces.join(","));
    if let Some((at, d)) = DIRECTORIES.lock().ok().and_then(|m| m.as_ref().and_then(|m| m.get(&key).cloned()))
        && at.elapsed() < DIRECTORY_TTL
    {
        return d;
    }
    let mut dir = Directory::default();
    for resource in ["pods", "services", "nodes"] {
        list_into(session, &mut dir, resource, namespaces).await;
    }
    let dir = std::sync::Arc::new(dir);
    if let Ok(mut m) = DIRECTORIES.lock() {
        let m = m.get_or_insert_with(HashMap::new);
        m.retain(|_, (at, _)| at.elapsed() < DIRECTORY_TTL);
        m.insert(key, (Instant::now(), dir.clone()));
    }
    dir
}

// ───────────────────────── reading the table ─────────────────────────

fn running(statuses: &Json, name: &str) -> bool {
    statuses.as_array().into_iter().flatten().any(|s| s["name"].as_str() == Some(name) && s["state"].get("running").is_some())
}

/// The containers to try, in order: the one asked for; else the running app containers, then a
/// running kns debug container (it has `cat` when the image has not).
pub fn containers_to_try(pod: &Json, asked: Option<&str>) -> Vec<String> {
    let names = |key: &str| pod["spec"][key].as_array().into_iter().flatten().filter_map(|c| c["name"].as_str().map(String::from)).collect::<Vec<_>>();
    if let Some(c) = asked {
        return names("containers").into_iter().chain(names("ephemeralContainers")).filter(|n| n == c).collect();
    }
    let mut out: Vec<String> = names("containers").into_iter().filter(|n| running(&pod["status"]["containerStatuses"], n)).collect();
    out.extend(names("ephemeralContainers").into_iter().filter(|n| n.starts_with(crate::debug::EPHEMERAL_PREFIX) && running(&pod["status"]["ephemeralContainerStatuses"], n)));
    out
}

/// `cat` over the tables in one container; Ok(None) when the container could not run it.
async fn cat_tables(session: &Session, namespace: &str, pod: &str, container: &str) -> Result<Option<String>> {
    let pods: Api<Pod> = Api::namespaced(session.client.clone(), namespace);
    let params = AttachParams { container: Some(container.to_string()), stdin: false, stdout: true, stderr: false, tty: false, ..Default::default() };
    let command: Vec<String> = std::iter::once("cat").chain(TABLES).map(String::from).collect();
    let run = async {
        let mut process = pods.exec(pod, command, &params).await.map_err(BackendError::from)?;
        let mut out = Vec::new();
        if let Some(stdout) = process.stdout() {
            stdout.take(MAX_TABLE).read_to_end(&mut out).await?;
        }
        Ok::<_, BackendError>(out)
    };
    match tokio::time::timeout(READ_TIMEOUT, run).await {
        Err(_) => Err(BackendError::new(0, "Network", format!("reading the socket table in {container} timed out"))),
        Ok(Err(e)) if e.code == 403 || e.code == 401 => Err(e),
        // no `cat` in the image (the exec fails or prints nothing)
        Ok(Err(_)) => Ok(None),
        Ok(Ok(out)) => {
            let text = String::from_utf8_lossy(&out).into_owned();
            Ok(text.lines().any(|l| l.trim_start().starts_with("sl")).then_some(text))
        }
    }
}

/// One reading of a pod's sockets, with its peers named.
pub async fn sample(state: &AppState, req: &TrafficRequest) -> Result<TrafficSample> {
    let obj = &req.obj_ref;
    let Some(ns) = obj.ns().filter(|_| obj.gvr.group.is_empty() && obj.gvr.resource == "pods") else {
        return Err(BackendError::invalid("traffic needs a pod"));
    };
    let session = state.session(&obj.context).await?;
    let pod = session.get(&api_path(&gvr("pods"), Some(ns), Some(&obj.name))).await?;
    let candidates = containers_to_try(&pod, req.container.as_deref().filter(|c| !c.is_empty()));
    if candidates.is_empty() {
        return Err(BackendError::invalid(match &req.container {
            Some(c) => format!("{} has no running container {c}", obj.name),
            None => format!("{} has no running container", obj.name),
        }));
    }
    let mut read = None;
    for c in &candidates {
        if let Some(text) = cat_tables(&session, ns, &obj.name, c).await? {
            read = Some((c.clone(), text));
            break;
        }
    }
    let Some((container, text)) = read else {
        return Err(BackendError::new(
            0,
            NEEDS_DEBUG,
            format!("no container of {} could run `cat` (a distroless image?): add a debug container (B on the pod) and kns reads the table through it", obj.name),
        ));
    };

    let sockets = parse_tables(&text);
    let (listening, conns) = split(&sockets);
    let mut namespaces = req.namespaces.clone();
    if !namespaces.iter().any(|n| n == ns) {
        namespaces.insert(0, ns.to_string());
    }
    let dir = directory(&session, &obj.context, &namespaces).await;
    let own: HashSet<IpAddr> = ips(pod["status"]["podIPs"].as_array().into_iter().flatten().map(|p| p["ip"].as_str().map(String::from)).chain(std::iter::once(pod["status"]["podIP"].as_str().map(String::from)))).into_iter().collect();
    let connections = conns
        .into_iter()
        .take(MAX_CONNECTIONS)
        .map(|(direction, s)| TrafficConnection {
            proto: s.proto,
            direction,
            local_port: s.local.1,
            remote_ip: s.remote.0.to_string(),
            remote_port: s.remote.1,
            state: state_name(s.proto, s.state).to_string(),
            peer: dir.peer(s.remote.0, &own, (ns, &obj.name)),
        })
        .collect();
    Ok(TrafficSample { container, at: jiff::Timestamp::now().round(jiff::Unit::Second).map(|t| t.to_string()).unwrap_or_default(), listening, connections, notes: dir.notes.clone() })
}

pub mod cmd {
    use crate::{
        contract::{TrafficRequest, TrafficSample},
        ipc::Result,
        state::AppState,
    };

    /// One reading of a pod's socket table, with its peers named.
    #[tauri::command]
    pub async fn traffic_sample(state: tauri::State<'_, AppState>, req: TrafficRequest) -> Result<TrafficSample> {
        super::sample(&state, &req).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // a pod 10.42.0.9 listening on 8080 (tcp) and 8125 (udp, v6), with a client inside, an outgoing
    // connection to a Service, a sidecar on loopback and a dual-stack inbound peer
    const TABLES_TEXT: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0
   1: 09002A0A:1F90 11002A0A:C3CA 01 00000000:00000000 00:00000000 00000000     0        0 2 1 0000000000000000 20 4 30 10 -1
   2: 09002A0A:A112 09092B0A:1538 01 00000000:00000000 00:00000000 00000000     0        0 3 1 0000000000000000 20 4 30 10 -1
   3: 0100007F:9858 0100007F:3A99 06 00000000:00000000 03:00000F8B 00000000     0        0 0 3 0000000000000000
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0000000000000000FFFF000009002A0A:1F90 0000000000000000FFFF00002A002A0A:D000 01 00000000:00000000 00:00000000 00000000     0        0 4 1 0000000000000000 20 4 30 10 -1
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
  1234: 09002A0A:CF08 01002A0A:1FBD 01 00000000:00000000 00:00000000 00000000     0        0 5 2 0000000000000000 0
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
  1235: 00000000000000000000000000000000:1FBD 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 6 2 0000000000000000 0
";

    #[test]
    fn parses_the_four_tables() {
        let s = parse_tables(TABLES_TEXT);
        assert_eq!(s.len(), 7);
        assert_eq!(s[0], Socket { proto: TrafficProto::Tcp, local: ("0.0.0.0".parse().unwrap(), 8080), remote: ("0.0.0.0".parse().unwrap(), 0), state: 10 });
        assert_eq!(s[1].local, ("10.42.0.9".parse().unwrap(), 8080));
        assert_eq!(s[1].remote, ("10.42.0.17".parse().unwrap(), 50122));
        assert_eq!(s[2].remote, ("10.43.9.9".parse().unwrap(), 5432));
        // the IPv4 peer of a dual-stack socket reads as IPv4
        assert_eq!(s[4].remote.0, "10.42.0.42".parse::<IpAddr>().unwrap());
        assert_eq!((s[5].proto, s[5].remote), (TrafficProto::Udp, ("10.42.0.1".parse().unwrap(), 8125)));
        assert_eq!((s[6].proto, s[6].local), (TrafficProto::Udp, ("::".parse().unwrap(), 8125)));
        assert_eq!(state_name(TrafficProto::Tcp, s[3].state), "TIME_WAIT");
    }

    #[test]
    fn splits_listeners_and_directions() {
        let s = parse_tables(TABLES_TEXT);
        let (listening, conns) = split(&s);
        assert_eq!(listening, vec![TrafficListener { proto: TrafficProto::Tcp, ip: "0.0.0.0".into(), port: 8080 }, TrafficListener { proto: TrafficProto::Udp, ip: "::".into(), port: 8125 }]);
        let dirs: Vec<_> = conns.iter().map(|(d, s)| (*d, s.remote.1)).collect();
        assert_eq!(
            dirs,
            vec![(TrafficDirection::In, 50122), (TrafficDirection::Out, 5432), (TrafficDirection::Out, 15001), (TrafficDirection::In, 53248), (TrafficDirection::Out, 8125)]
        );
    }

    #[test]
    fn names_peers() {
        let mut d = Directory::default();
        d.add(
            "pods",
            &json!({"items": [
                {"metadata": {"namespace": "shop", "name": "web-7f9c-xk2p1", "labels": {"pod-template-hash": "7f9c"}, "ownerReferences": [{"kind": "ReplicaSet", "name": "web-7f9c", "controller": true}]}, "spec": {}, "status": {"podIP": "10.42.0.17"}},
                {"metadata": {"namespace": "kube-system", "name": "aws-node-x"}, "spec": {"hostNetwork": true}, "status": {"podIP": "10.42.0.1"}},
                {"metadata": {"namespace": "data", "name": "pg-0", "ownerReferences": [{"kind": "StatefulSet", "name": "pg"}]}, "spec": {}, "status": {"podIPs": [{"ip": "10.42.0.42"}, {"ip": "fd00::42"}]}}
            ]}),
        );
        d.add("services", &json!({"items": [{"metadata": {"namespace": "payments", "name": "postgres"}, "spec": {"clusterIP": "10.43.9.9", "clusterIPs": ["10.43.9.9"]}}]}));
        d.add("nodes", &json!({"items": [{"metadata": {"name": "node-a"}, "status": {"addresses": [{"type": "InternalIP", "address": "10.42.0.1"}, {"type": "Hostname", "address": "ip-10-42-0-1"}]}}]}));
        let own: HashSet<IpAddr> = ["10.42.0.9".parse().unwrap()].into_iter().collect();
        let me = ("shop", "orders-1");
        let p = |ip: &str| d.peer(ip.parse().unwrap(), &own, me);
        assert_eq!(p("10.42.0.17"), TrafficPeer { kind: TrafficPeerKind::Pod, namespace: Some("shop".into()), name: "web-7f9c-xk2p1".into(), workload: Some("Deployment/web".into()) });
        assert_eq!(p("fd00::42").workload.as_deref(), Some("StatefulSet/pg"));
        assert_eq!(p("10.43.9.9").kind, TrafficPeerKind::Service);
        // the host-network pod does not hide the node
        assert_eq!(p("10.42.0.1"), TrafficPeer { kind: TrafficPeerKind::Node, namespace: None, name: "node-a".into(), workload: None });
        assert_eq!(p("127.0.0.1").kind, TrafficPeerKind::Loopback);
        assert_eq!(p("10.42.0.9").kind, TrafficPeerKind::Own);
        assert_eq!(p("52.1.2.3"), TrafficPeer { kind: TrafficPeerKind::External, namespace: None, name: "52.1.2.3".into(), workload: None });
    }

    #[test]
    fn picks_containers() {
        let pod = json!({
            "spec": {"containers": [{"name": "app"}, {"name": "istio-proxy"}, {"name": "stopped"}], "ephemeralContainers": [{"name": "kns-debug-ab1c2"}, {"name": "other-debug"}]},
            "status": {
                "containerStatuses": [{"name": "app", "state": {"running": {}}}, {"name": "istio-proxy", "state": {"running": {}}}, {"name": "stopped", "state": {"terminated": {}}}],
                "ephemeralContainerStatuses": [{"name": "kns-debug-ab1c2", "state": {"running": {}}}, {"name": "other-debug", "state": {"running": {}}}]
            }
        });
        assert_eq!(containers_to_try(&pod, None), vec!["app", "istio-proxy", "kns-debug-ab1c2"]);
        assert_eq!(containers_to_try(&pod, Some("istio-proxy")), vec!["istio-proxy"]);
        assert!(containers_to_try(&pod, Some("nope")).is_empty());
    }
}
