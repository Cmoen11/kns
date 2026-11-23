//! `start_forward` / `list_forwards` / `stop_forward` / `open_forward` / `resolve_forward_target`:
//! local TCP listeners tunnelled to a pod port (docs/plan-features.md §2.4). Owner: B-fwd.
//!
//! Forwards outlive any one view, so they are not streams: they live in `AppState::forwards`.
//!
//! Targets: a pod, a Service (EndpointSlices -> a ready endpoint, sticky to the last pod while it is
//! ready; a named targetPort maps through the slice's port) or a workload (selector -> a ready
//! pod). The target is resolved per accepted connection with a 5 s cache; with no ready pod the
//! forward is `waiting`: the listener stays bound and a client is held up to 10 s, then closed.
//! `list_forwards` refreshes stale resolutions, so `waiting` and the pod show without a client.
use std::{
    future::Future,
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    pin::pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};

use futures::FutureExt;
use k8s_openapi::api::core::v1::Pod;
use kube::api::Api;
use socket2::{Domain, Protocol, Socket, Type};
use tokio::{
    io::copy_bidirectional,
    net::{TcpListener, TcpStream},
    task::{JoinHandle, JoinSet},
    time::{sleep, timeout},
};
use tokio_util::sync::CancellationToken;

pub use crate::contract::fwd::ForwardQuery;
use crate::{
    events,
    ipc::{
        BackendError, BackendEvent, Forward, ForwardOwner, ForwardStatus, ForwardTarget, ForwardTargetInfo, Gvr, Json, PortHint, PortRef,
        ProposalPayload, Result, TargetPort,
    },
    proposals,
    session::{Session, api_path, timed, with_query},
    state::{AppState, lock},
};

/// A non-pinned requested port that is busy moves up to this many ports, then to a free one.
const PORT_FALLBACK: u16 = 20;
/// How long a resolution (Service/workload -> pod, port) is reused.
const CACHE: Duration = Duration::from_secs(5);
/// How long a client connection is held while no pod is ready.
const HOLD: Duration = Duration::from_secs(10);
/// How often the idle-stop watcher looks (only while agent-owned forwards with an idle stop exist).
const IDLE_TICK: Duration = Duration::from_secs(15);

fn now_ms() -> i64 {
    jiff::Timestamp::now().as_millisecond()
}

// ───────────────────────── addresses and ports ─────────────────────────

/// The bind address: an IP literal that is loopback, default 127.0.0.1. Host names (also
/// `localhost`), wildcard and LAN addresses are refused, for humans as well.
pub fn parse_address(address: Option<&str>) -> Result<IpAddr> {
    let text = address.map(str::trim).filter(|a| !a.is_empty());
    let Some(text) = text else { return Ok(IpAddr::V4(Ipv4Addr::LOCALHOST)) };
    let ip: IpAddr = text
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse()
        .map_err(|_| BackendError::invalid(format!("\"{text}\" is not an IP address; use 127.0.0.1 or ::1")))?;
    if !ip.is_loopback() {
        return Err(BackendError::invalid(format!("{ip} is not a loopback address; forwards bind to 127.0.0.1 or ::1 only")));
    }
    Ok(ip)
}

pub(crate) fn valid_label(label: &str) -> bool {
    (1..=40).contains(&label.len()) && label.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b' ' | b'.' | b'_' | b'-'))
}

/// `http://<address>:<port>/`, IPv6 in brackets.
pub fn forward_url(address: &str, port: u16) -> String {
    if address.contains(':') { format!("http://[{address}]:{port}/") } else { format!("http://{address}:{port}/") }
}

/// A socket bound to `addr` without `SO_REUSEADDR`; on Windows with `SO_EXCLUSIVEADDRUSE`, so no
/// other process can bind the same port on a more specific address. Not listening yet.
fn bind_socket(addr: SocketAddr) -> io::Result<Socket> {
    let socket = Socket::new(Domain::for_address(addr), Type::STREAM, Some(Protocol::TCP))?;
    #[cfg(windows)]
    exclusive(&socket)?;
    if addr.is_ipv6() {
        socket.set_only_v6(true)?;
    }
    socket.bind(&addr.into())?;
    Ok(socket)
}

#[cfg(windows)]
fn exclusive(socket: &Socket) -> io::Result<()> {
    use std::os::windows::io::AsRawSocket;
    use windows_sys::Win32::Networking::WinSock::{SO_EXCLUSIVEADDRUSE, SOL_SOCKET, setsockopt};
    let on: i32 = 1;
    // SAFETY: a valid socket handle, an option the API defines, and a 4-byte int that outlives the call.
    let rc = unsafe {
        setsockopt(socket.as_raw_socket() as usize, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (&on as *const i32).cast(), size_of::<i32>() as i32)
    };
    if rc == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

/// True when something already holds `port` on the wildcard address of either family, so a
/// local service on `*:port` is never shadowed by a loopback forward. A family the machine does
/// not have counts as free. Only binds (no listen), so no firewall prompt.
fn wildcard_busy(port: u16) -> bool {
    [IpAddr::V4(Ipv4Addr::UNSPECIFIED), IpAddr::V6(Ipv6Addr::UNSPECIFIED)]
        .into_iter()
        .any(|ip| matches!(bind_socket(SocketAddr::new(ip, port)), Err(e) if e.kind() == io::ErrorKind::AddrInUse))
}

fn listen_on(addr: SocketAddr, probe_wildcard: bool) -> io::Result<std::net::TcpListener> {
    if probe_wildcard && wildcard_busy(addr.port()) {
        return Err(io::Error::new(io::ErrorKind::AddrInUse, format!("port {} is in use", addr.port())));
    }
    let socket = bind_socket(addr)?;
    socket.listen(1024)?;
    socket.set_nonblocking(true)?;
    Ok(socket.into())
}

/// The listener for a forward: a free port when none was asked for; the asked port when pinned
/// (or `AddrInUse`); otherwise the asked port, the next `PORT_FALLBACK` ports, then a free one.
/// The returned listener's port is the truth.
pub fn choose_listener(address: IpAddr, requested: Option<u16>, pin: bool) -> Result<std::net::TcpListener> {
    let requested = requested.filter(|p| *p != 0);
    let Some(port) = requested else { return Ok(listen_on(SocketAddr::new(address, 0), false)?) };
    if pin {
        return listen_on(SocketAddr::new(address, port), true)
            .map_err(|e| BackendError::new(0, "AddrInUse", format!("local port {port} is not free ({e}); it is pinned")));
    }
    let last = port.saturating_add(PORT_FALLBACK);
    for candidate in port..=last {
        match listen_on(SocketAddr::new(address, candidate), true) {
            Ok(listener) => return Ok(listener),
            Err(e) if e.kind() == io::ErrorKind::AddrInUse || e.kind() == io::ErrorKind::PermissionDenied => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(listen_on(SocketAddr::new(address, 0), false)?)
}

// ───────────────────────── target resolution (pure, over API JSON) ─────────────────────────

fn str_at<'a>(v: &'a Json, path: &[&str]) -> Option<&'a str> {
    path.iter().try_fold(v, |v, k| v.get(k))?.as_str()
}

fn arr(v: Option<&Json>) -> &[Json] {
    v.and_then(Json::as_array).map(Vec::as_slice).unwrap_or_default()
}

fn port_num(v: Option<&Json>) -> Option<u16> {
    v.and_then(Json::as_u64).and_then(|n| u16::try_from(n).ok()).filter(|n| *n > 0)
}

/// Ready = condition `Ready` is `True` and the pod is not being deleted.
pub fn pod_ready(pod: &Json) -> bool {
    if pod.pointer("/metadata/deletionTimestamp").is_some_and(|d| !d.is_null()) {
        return false;
    }
    arr(pod.pointer("/status/conditions"))
        .iter()
        .any(|c| c.get("type").and_then(Json::as_str) == Some("Ready") && c.get("status").and_then(Json::as_str) == Some("True"))
}

/// The pod spec of a pod or of a workload's template (CronJob: its job template).
pub fn pod_spec(obj: &Json) -> Option<&Json> {
    let kind = obj.get("kind").and_then(Json::as_str).unwrap_or_default();
    match kind {
        "Pod" => obj.get("spec"),
        "CronJob" => obj.pointer("/spec/jobTemplate/spec/template/spec"),
        _ => obj.pointer("/spec/template/spec").or_else(|| obj.get("spec").filter(|s| s.get("containers").is_some())),
    }
}

/// TCP container ports (containers, then init containers / sidecars), first occurrence of each port.
pub fn container_ports(spec: &Json) -> Vec<TargetPort> {
    let mut out: Vec<TargetPort> = Vec::new();
    for c in arr(spec.get("containers")).iter().chain(arr(spec.get("initContainers"))) {
        for p in arr(c.get("ports")) {
            let Some(port) = port_num(p.get("containerPort")) else { continue };
            let protocol = p.get("protocol").and_then(Json::as_str).unwrap_or("TCP");
            if protocol != "TCP" || out.iter().any(|x| x.port == port) {
                continue;
            }
            let name = p.get("name").and_then(Json::as_str).filter(|n| !n.is_empty()).map(str::to_string);
            out.push(TargetPort { name, port, protocol: protocol.to_string() });
        }
    }
    out
}

/// The container port named `name` in a pod spec.
pub fn container_port_by_name(spec: &Json, name: &str) -> Option<u16> {
    container_ports(spec).into_iter().find(|p| p.name.as_deref() == Some(name)).map(|p| p.port)
}

/// One port of a Service: by number (`port`) or by name.
#[derive(Debug, Clone, PartialEq)]
pub struct SvcPort {
    pub name: Option<String>,
    pub port: u16,
    pub target: PortRef,
    pub protocol: String,
    pub app_protocol: Option<String>,
}

pub fn service_ports(svc: &Json) -> Vec<SvcPort> {
    arr(svc.pointer("/spec/ports"))
        .iter()
        .filter_map(|p| {
            let port = port_num(p.get("port"))?;
            let target = match p.get("targetPort") {
                Some(Json::String(s)) if s.parse::<u16>().is_ok() => PortRef::Number(s.parse().unwrap_or(port)),
                Some(Json::String(s)) if !s.is_empty() => PortRef::Name(s.clone()),
                Some(n) => port_num(Some(n)).map_or(PortRef::Number(port), PortRef::Number),
                None => PortRef::Number(port),
            };
            Some(SvcPort {
                name: p.get("name").and_then(Json::as_str).filter(|n| !n.is_empty()).map(str::to_string),
                port,
                target,
                protocol: p.get("protocol").and_then(Json::as_str).unwrap_or("TCP").to_string(),
                app_protocol: p.get("appProtocol").and_then(Json::as_str).map(str::to_string),
            })
        })
        .collect()
}

/// The Service port a forward's remote port means: a number matches `port` (or, failing that, a
/// numeric `targetPort`), a name matches the port's name.
pub fn service_port(svc: &Json, remote: &PortRef) -> Option<SvcPort> {
    let ports = service_ports(svc);
    match remote {
        PortRef::Number(n) => ports
            .iter()
            .find(|p| p.port == *n)
            .or_else(|| ports.iter().find(|p| p.target == PortRef::Number(*n)))
            .cloned(),
        PortRef::Name(name) => ports.into_iter().find(|p| p.name.as_deref() == Some(name)),
    }
}

// ───────────────────────── k9s port-forward annotations (B2) ─────────────────────────

pub const K9S_AUTO_PF: &str = "k9scli.io/auto-port-forwards";
pub const K9S_PF: &str = "k9scli.io/port-forwards";
const MAX_HINTS: usize = 20;

/// One spec of a k9s annotation: `[container::][local-port:]container-port`, the port a number or a
/// port name. Anything else is ignored. Only ports come from here, never an address.
fn k9s_spec(spec: &str, auto: bool) -> Option<PortHint> {
    let (container, rest) = match spec.split_once("::") {
        Some((c, r)) => (Some(c.trim()).filter(|c| !c.is_empty()), r.trim()),
        None => (None, spec.trim()),
    };
    if let Some(c) = container
        && (c.len() > 63 || !c.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
    {
        return None;
    }
    let (local, remote) = match rest.split_once(':') {
        Some((l, r)) => (Some(l.trim().parse::<u16>().ok().filter(|p| *p > 0)?), r.trim()),
        None => (None, rest),
    };
    let remote = match remote.parse::<u16>() {
        Ok(0) => return None,
        Ok(n) => PortRef::Number(n),
        Err(_)
            if (1..=15).contains(&remote.len())
                && remote.bytes().any(|b| b.is_ascii_lowercase())
                && remote.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') =>
        {
            PortRef::Name(remote.to_string())
        }
        Err(_) => return None,
    };
    Some(PortHint { container: container.map(str::to_string), remote_port: remote, local_port: local, auto })
}

/// The ports `k9scli.io/auto-port-forwards` (first) and `k9scli.io/port-forwards` ask for, from
/// any number of annotation maps (pod, workload template, workload, Service). Comma-separated specs;
/// each remote port once; at most 20.
pub fn k9s_hints<'a>(annotations: impl IntoIterator<Item = Option<&'a Json>>) -> Vec<PortHint> {
    let maps: Vec<&Json> = annotations.into_iter().flatten().collect();
    let mut out: Vec<PortHint> = Vec::new();
    for (key, auto) in [(K9S_AUTO_PF, true), (K9S_PF, false)] {
        for m in &maps {
            let Some(v) = m.get(key).and_then(Json::as_str) else { continue };
            for spec in v.split(',') {
                if let Some(h) = k9s_spec(spec, auto)
                    && out.len() < MAX_HINTS
                    && !out.iter().any(|x| x.remote_port == h.remote_port && x.container == h.container)
                {
                    out.push(h);
                }
            }
        }
    }
    out
}

/// Pod hints as Service hints: each container port maps to the Service port that targets it (by
/// targetPort number or name); a hint no Service port targets is dropped.
pub fn hints_to_service(hints: &[PortHint], ports: &[SvcPort], pod_spec: Option<&Json>) -> Vec<PortHint> {
    let named = |n: u16| pod_spec.map(container_ports).unwrap_or_default().into_iter().find(|p| p.port == n).and_then(|p| p.name);
    hints
        .iter()
        .filter_map(|h| {
            let sp = ports.iter().find(|sp| match (&sp.target, &h.remote_port) {
                (PortRef::Number(t), PortRef::Number(r)) => t == r,
                (PortRef::Name(t), PortRef::Name(r)) => t == r,
                (PortRef::Name(t), PortRef::Number(r)) => named(*r).as_deref() == Some(t.as_str()),
                (PortRef::Number(t), PortRef::Name(r)) => pod_spec.and_then(|s| container_port_by_name(s, r)) == Some(*t),
            })?;
            Some(PortHint { remote_port: PortRef::Number(sp.port), ..h.clone() })
        })
        .collect()
}

fn annotations(obj: &Json) -> Option<&Json> {
    obj.pointer("/metadata/annotations")
}

/// Template annotations of a workload (CronJob: its job template's pod template).
fn template_annotations(obj: &Json) -> Option<&Json> {
    obj.pointer("/spec/template/metadata/annotations").or_else(|| obj.pointer("/spec/jobTemplate/spec/template/metadata/annotations"))
}

/// A ready endpoint of a Service's EndpointSlices (a `List` JSON) and the target port number the
/// slice gives for the Service port named `port_name` (`""` for an unnamed port). The pod and
/// the port come from the same slice (named targetPorts can differ per slice). Sticky: `sticky`
/// wins while it is still a ready endpoint.
pub fn pick_endpoint(slices: &Json, port_name: Option<&str>, sticky: Option<&str>) -> Option<(String, Option<u16>)> {
    let want = port_name.unwrap_or("");
    let mut first: Option<(String, Option<u16>)> = None;
    for slice in arr(slices.get("items")) {
        let port = arr(slice.get("ports"))
            .iter()
            .find(|p| p.get("name").and_then(Json::as_str).unwrap_or("") == want)
            .and_then(|p| port_num(p.get("port")));
        for ep in arr(slice.get("endpoints")) {
            // ready absent = ready (EndpointSlice API: "nil should be interpreted as true")
            let ready = ep.pointer("/conditions/ready").and_then(Json::as_bool).unwrap_or(true);
            let terminating = ep.pointer("/conditions/terminating").and_then(Json::as_bool).unwrap_or(false);
            if !ready || terminating {
                continue;
            }
            if str_at(ep, &["targetRef", "kind"]) != Some("Pod") {
                continue;
            }
            let Some(pod) = str_at(ep, &["targetRef", "name"]) else { continue };
            if sticky == Some(pod) {
                return Some((pod.to_string(), port));
            }
            first.get_or_insert_with(|| (pod.to_string(), port));
        }
    }
    first
}

/// Ready and not-ready endpoint counts and the ready pod names, from EndpointSlices.
pub fn endpoint_counts(slices: &Json) -> (u32, u32, Vec<String>) {
    let (mut ready, mut not_ready, mut pods) = (0u32, 0u32, Vec::new());
    for slice in arr(slices.get("items")) {
        for ep in arr(slice.get("endpoints")) {
            let ok = ep.pointer("/conditions/ready").and_then(Json::as_bool).unwrap_or(true);
            if ok {
                ready += 1;
                if let Some(pod) = str_at(ep, &["targetRef", "name"]).filter(|_| str_at(ep, &["targetRef", "kind"]) == Some("Pod"))
                    && !pods.iter().any(|p| p == pod)
                {
                    pods.push(pod.to_string());
                }
            } else {
                not_ready += 1;
            }
        }
    }
    (ready, not_ready, pods)
}

/// A workload's label selector as a `labelSelector` query value (matchLabels + matchExpressions).
/// CronJobs and selector-less objects fall back to the pod template's labels.
pub fn selector_string(workload: &Json) -> Option<String> {
    let selector = workload.pointer("/spec/selector").filter(|s| s.is_object());
    let mut parts: Vec<String> = Vec::new();
    let labels = selector.and_then(|s| s.get("matchLabels")).and_then(Json::as_object).or_else(|| {
        if selector.is_some() {
            return None;
        }
        workload
            .pointer("/spec/template/metadata/labels")
            .or_else(|| workload.pointer("/spec/jobTemplate/spec/template/metadata/labels"))
            .and_then(Json::as_object)
    });
    for (k, v) in labels.into_iter().flatten() {
        parts.push(format!("{k}={}", v.as_str()?));
    }
    for e in arr(selector.and_then(|s| s.get("matchExpressions"))) {
        let key = e.get("key").and_then(Json::as_str)?;
        let values: Vec<&str> = arr(e.get("values")).iter().filter_map(Json::as_str).collect();
        match e.get("operator").and_then(Json::as_str)? {
            "In" => parts.push(format!("{key} in ({})", values.join(","))),
            "NotIn" => parts.push(format!("{key} notin ({})", values.join(","))),
            "Exists" => parts.push(key.to_string()),
            "DoesNotExist" => parts.push(format!("!{key}")),
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join(","))
}

/// A ready pod of a pod list (`List` JSON); `sticky` wins while it is ready. Sorted by name for
/// a stable choice.
pub fn pick_pod<'a>(pods: &'a Json, sticky: Option<&str>) -> Option<&'a Json> {
    let mut ready: Vec<&Json> = arr(pods.get("items")).iter().filter(|p| pod_ready(p)).collect();
    ready.sort_by_key(|p| str_at(p, &["metadata", "name"]).unwrap_or_default().to_string());
    ready.iter().find(|p| str_at(p, &["metadata", "name"]) == sticky && sticky.is_some()).or(ready.first()).copied()
}

/// True when a ticketed start matches the approved `forward` payload.
pub fn matches_proposal(payload: &ProposalPayload, query: &ForwardQuery) -> bool {
    matches!(payload, ProposalPayload::Forward { context, target, remote_port, local_port }
        if *context == query.context && *target == query.target && *remote_port == query.remote_port
            && local_port.is_none_or(|p| query.local_port == Some(p)))
}

// ───────────────────────── live resolution ─────────────────────────

pub(crate) fn pods_gvr() -> Gvr {
    Gvr::new("", "v1", "pods")
}
pub(crate) fn services_gvr() -> Gvr {
    Gvr::new("", "v1", "services")
}
pub(crate) fn slices_gvr() -> Gvr {
    Gvr::new("discovery.k8s.io", "v1", "endpointslices")
}

/// The last resolution of a target.
#[derive(Debug, Clone, Default)]
struct Cache {
    pod: Option<String>,
    port: Option<u16>,
    /// why there is no pod (no ready endpoint, the lookup failed)
    message: Option<String>,
    at: Option<Instant>,
}

/// Resolves one forward's target; shared by its accept loop and `list_forwards`.
struct Resolver {
    session: Arc<Session>,
    target: ForwardTarget,
    remote: PortRef,
    cache: Mutex<Cache>,
}

impl Resolver {
    fn cached(&self) -> Cache {
        lock(&self.cache).clone()
    }

    fn stale(&self) -> bool {
        lock(&self.cache).at.is_none_or(|at| at.elapsed() >= CACHE)
    }

    fn invalidate(&self) {
        lock(&self.cache).at = None;
    }

    /// The pod and port to connect to; `Ok(None)` while no pod is ready. Cached for `CACHE`.
    async fn resolve(&self) -> Result<Option<(String, u16)>> {
        let sticky = {
            let c = lock(&self.cache);
            if c.at.is_some_and(|at| at.elapsed() < CACHE) {
                return Ok(c.pod.clone().zip(c.port));
            }
            c.pod.clone()
        };
        let outcome = self.fetch(sticky.as_deref()).await;
        let mut c = lock(&self.cache);
        c.at = Some(Instant::now());
        match &outcome {
            Ok(Some((pod, port))) => (c.pod, c.port, c.message) = (Some(pod.clone()), Some(*port), None),
            Ok(None) => (c.pod, c.port, c.message) = (None, None, Some("no ready pod".into())),
            Err(e) => (c.pod, c.port, c.message) = (None, None, Some(e.message.clone())),
        }
        outcome
    }

    async fn fetch(&self, sticky: Option<&str>) -> Result<Option<(String, u16)>> {
        let s = &self.session;
        match &self.target {
            ForwardTarget::Pod { namespace, name } => {
                let pod = s.get(&api_path(&pods_gvr(), Some(namespace), Some(name))).await?;
                Ok(Some((name.clone(), port_on_pod(&pod, &self.remote)?)))
            }
            ForwardTarget::Service { namespace, name } => {
                let svc = s.get(&api_path(&services_gvr(), Some(namespace), Some(name))).await?;
                let sp = service_port(&svc, &self.remote)
                    .ok_or_else(|| BackendError::invalid(format!("service {name} has no port {}", self.remote)))?;
                let slices = s
                    .get(&with_query(&api_path(&slices_gvr(), Some(namespace), None), &[("labelSelector", &format!("kubernetes.io/service-name={name}"))]))
                    .await?;
                let Some((pod, port)) = pick_endpoint(&slices, sp.name.as_deref(), sticky) else { return Ok(None) };
                if let Some(port) = port {
                    return Ok(Some((pod, port)));
                }
                // the slice names no port: a numeric targetPort is the port, a named one is looked up
                match &sp.target {
                    PortRef::Number(n) => Ok(Some((pod, *n))),
                    PortRef::Name(_) => {
                        let json = s.get(&api_path(&pods_gvr(), Some(namespace), Some(&pod))).await?;
                        Ok(Some((pod, port_on_pod(&json, &sp.target)?)))
                    }
                }
            }
            ForwardTarget::Workload { gvr, namespace, name } => {
                let workload = s.get(&api_path(gvr, Some(namespace), Some(name))).await?;
                let selector =
                    selector_string(&workload).ok_or_else(|| BackendError::invalid(format!("{} {name} has no pod selector", gvr.resource)))?;
                let pods = s.get(&with_query(&api_path(&pods_gvr(), Some(namespace), None), &[("labelSelector", &selector)])).await?;
                let Some(pod) = pick_pod(&pods, sticky) else { return Ok(None) };
                let pod_name = str_at(pod, &["metadata", "name"]).unwrap_or_default().to_string();
                Ok(Some((pod_name, port_on_pod(pod, &self.remote)?)))
            }
        }
    }
}

/// A remote port on a pod: a number as is, a name through the container ports.
fn port_on_pod(pod: &Json, remote: &PortRef) -> Result<u16> {
    match remote {
        PortRef::Number(n) => Ok(*n),
        PortRef::Name(name) => pod_spec(pod)
            .and_then(|spec| container_port_by_name(spec, name))
            .ok_or_else(|| BackendError::invalid(format!("no container port named \"{name}\""))),
    }
}

// ───────────────────────── running forwards ─────────────────────────

pub struct ForwardEntry {
    /// Static part; connections, status, resolution and idle time are filled in when listed.
    info: Forward,
    shared: Arc<Shared>,
    resolver: Arc<Resolver>,
    cancel: CancellationToken,
    task: JoinHandle<()>,
}

struct Shared {
    /// Open client connections.
    connections: AtomicU32,
    /// Why the most recent connection failed, if it did.
    error: Mutex<Option<String>>,
    /// When the last connection closed (or the forward started), ms since epoch.
    idle_since: AtomicI64,
}

impl ForwardEntry {
    fn snapshot(&self) -> Forward {
        let message = lock(&self.shared.error).clone();
        let connections = self.shared.connections.load(Ordering::Relaxed);
        let c = self.resolver.cached();
        let pod_target = matches!(self.info.target, ForwardTarget::Pod { .. });
        let (status, message) = if !pod_target && c.pod.is_none() && c.at.is_some() {
            (ForwardStatus::Waiting, c.message.clone())
        } else if message.is_some() {
            (ForwardStatus::Error, message)
        } else {
            (ForwardStatus::Active, None)
        };
        let resolved_pod = c.pod.clone().or_else(|| pod_target.then(|| self.info.target.name().to_string()));
        Forward {
            pod: resolved_pod.clone().unwrap_or_else(|| format!("{}/{}", self.info.target.kind(), self.info.target.name())),
            resolved_pod,
            resolved_port: c.port.or(self.info.resolved_port),
            connections,
            status,
            message,
            idle_stop_at: idle_stop_at(&self.info.owner, connections, self.shared.idle_since.load(Ordering::Relaxed)),
            ..self.info.clone()
        }
    }
}

/// When an idle agent-owned forward stops: `idle_since + minutes`, only with no open connection.
pub fn idle_stop_at(owner: &ForwardOwner, connections: u32, idle_since: i64) -> Option<i64> {
    match owner {
        ForwardOwner::Agent { idle_stop_minutes, .. } if *idle_stop_minutes > 0 && connections == 0 => {
            Some(idle_since + i64::from(*idle_stop_minutes) * 60_000)
        }
        _ => None,
    }
}

/// Starts a forward owned by `owner` (§2.1 internal API; B-dev and H2 call it). Binds the local
/// port and starts accepting; bind failures are returned (`AddrInUse`, ...). A missing target or
/// port name is an error; a target with no ready pod starts as `waiting`.
pub async fn start(state: &AppState, query: ForwardQuery, owner: ForwardOwner) -> Result<Forward> {
    let requested_by = match &owner {
        ForwardOwner::Agent { client, .. } => Some(client.clone()),
        ForwardOwner::User => None,
    };
    start_with(state, query, owner, requested_by).await
}

/// `start` with an explicit `requested_by` (a ticketed start the human took ownership of keeps
/// the requesting client for display).
pub async fn start_with(state: &AppState, query: ForwardQuery, owner: ForwardOwner, requested_by: Option<String>) -> Result<Forward> {
    let address = parse_address(query.address.as_deref())?;
    if let Some(label) = &query.label
        && !valid_label(label)
    {
        return Err(BackendError::invalid("a forward label is 1-40 of A-Z a-z 0-9 space . _ -"));
    }
    let session = state.session(&query.context).await?;
    let resolver = Arc::new(Resolver {
        session: session.clone(),
        target: query.target.clone(),
        remote: query.remote_port.clone(),
        cache: Mutex::new(Cache::default()),
    });
    // a typo in the name or the port should fail here, not on the first connection
    let first = resolver.resolve().await?;

    let listener = TcpListener::from_std(choose_listener(address, query.local_port, query.pin.unwrap_or(false))?)?;
    let local_port = listener.local_addr()?.port();

    let shared = Arc::new(Shared { connections: AtomicU32::new(0), error: Mutex::new(None), idle_since: AtomicI64::new(now_ms()) });
    let cancel = CancellationToken::new();
    let conn = Conn { session, namespace: query.target.namespace().to_string(), resolver: resolver.clone(), shared: shared.clone() };
    let task = tokio::spawn(accept_loop(listener, conn, cancel.clone()));
    let agent_idle = matches!(&owner, ForwardOwner::Agent { idle_stop_minutes, .. } if *idle_stop_minutes > 0);
    let resolved_pod = first.as_ref().map(|(p, _)| p.clone());
    let info = Forward {
        id: state.next_id("f"),
        context: query.context.clone(),
        pod: resolved_pod.clone().unwrap_or_else(|| format!("{}/{}", query.target.kind(), query.target.name())),
        namespace: query.target.namespace().to_string(),
        resolved_pod,
        target: query.target.clone(),
        remote_port: query.remote_port.clone(),
        resolved_port: first.map(|(_, p)| p),
        local_port,
        address: address.to_string(),
        connections: 0,
        status: ForwardStatus::Active,
        message: None,
        label: query.label.clone(),
        dev_set: query.dev_set.clone(),
        owner,
        requested_by,
        started_at: now_ms(),
        idle_stop_at: None,
    };
    let entry = ForwardEntry { info, shared, resolver, cancel, task };
    let snapshot = entry.snapshot();
    state.forwards().insert(snapshot.id.clone(), entry);
    if agent_idle {
        ensure_idle_watch(state);
    }
    events::emit(state, BackendEvent::Forwards);
    Ok(snapshot)
}

/// The `start_forward` command: a human start, or step "forward" of an approved proposal (owner
/// from the gate ticket, the request must match the approved payload).
pub async fn start_forward(state: &AppState, query: ForwardQuery) -> Result<Forward> {
    let Some(id) = query.proposal_id.clone() else { return start(state, query, ForwardOwner::User).await };
    let ticket = proposals::gate(state, &id, "forward")?;
    if !matches_proposal(&ticket.payload, &query) {
        let error = BackendError::invalid(format!("the forward does not match proposal {id}"));
        let _ = proposals::finish_step(state, &ticket, Err(error.clone()));
        return Err(error);
    }
    let started = start_with(state, query, ticket.owner(), Some(ticket.client.clone())).await;
    let outcome = started
        .as_ref()
        .map(|f| serde_json::json!({ "localPort": f.local_port, "address": f.address }))
        .map_err(Clone::clone);
    proposals::finish_step(state, &ticket, outcome)?;
    started
}

/// All forwards, oldest first. Stale Service/workload resolutions are refreshed first (bounded),
/// so `waiting` and the current pod show without a client connecting.
pub async fn list_forwards(state: &AppState) -> Result<Vec<Forward>> {
    let stale: Vec<Arc<Resolver>> = state
        .forwards()
        .values()
        .filter(|e| !matches!(e.info.target, ForwardTarget::Pod { .. }) && e.resolver.stale())
        .map(|e| e.resolver.clone())
        .collect();
    if !stale.is_empty() {
        let refresh = futures::future::join_all(stale.iter().map(|r| r.resolve()));
        let _ = timeout(Duration::from_secs(3), refresh).await;
    }
    let mut forwards: Vec<Forward> = state.forwards().values().map(ForwardEntry::snapshot).collect();
    forwards.sort_by(|a, b| (a.id.len(), &a.id).cmp(&(b.id.len(), &b.id)));
    Ok(forwards)
}

/// Every forward as recorded now (no refresh), oldest first; the name proxy reads it per request.
pub fn snapshots(state: &AppState) -> Vec<Forward> {
    let mut forwards: Vec<Forward> = state.forwards().values().map(ForwardEntry::snapshot).collect();
    forwards.sort_by(|a, b| (a.id.len(), &a.id).cmp(&(b.id.len(), &b.id)));
    forwards
}

/// One forward's record, as listed.
pub fn get(state: &AppState, id: &str) -> Option<Forward> {
    state.forwards().get(id).map(ForwardEntry::snapshot)
}

/// Closes the listener and every open connection; the port is free when this returns.
/// An unknown id is not an error (the forward is gone either way).
pub async fn stop_forward(state: &AppState, id: &str) -> Result<()> {
    let entry = state.forwards().remove(id);
    if let Some(entry) = entry {
        entry.cancel.cancel();
        events::emit(state, BackendEvent::Forwards);
        if timeout(Duration::from_secs(5), entry.task).await.is_err() {
            return Err(BackendError::internal(format!("forward {id} did not stop in time")));
        }
    }
    Ok(())
}

/// Stops every forward still owned by the agent `client` (revocation, policy lowered to off);
/// forwards the human took over are left alone. Returns how many were stopped.
pub async fn stop_by_owner(state: &AppState, client: &str) -> Result<usize> {
    let ids: Vec<String> = state
        .forwards()
        .iter()
        .filter(|(_, e)| matches!(&e.info.owner, ForwardOwner::Agent { client: c, .. } if c == client))
        .map(|(id, _)| id.clone())
        .collect();
    for id in &ids {
        stop_forward(state, id).await?;
    }
    Ok(ids.len())
}

/// Opens `http://<address>:<localPort>/` of a running forward with the system browser, or its
/// `http://<name>.<ns>.localhost:<port>/` while the name proxy routes it. Rust builds the URL from
/// its own records; the webview has no opener permission.
pub fn open_forward(state: &AppState, id: &str) -> Result<()> {
    let f = get(state, id).ok_or_else(|| BackendError::new(404, "NotFound", format!("forward {id} is not running")))?;
    let url = crate::proxy::url_for(state, &f).unwrap_or_else(|| forward_url(&f.address, f.local_port));
    let app = state.app().ok_or_else(|| BackendError::internal("no window"))?;
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(url, None::<&str>).map_err(|e| BackendError::internal(format!("could not open the browser: {e}")))
}

/// How a target resolves right now, with the ports to offer (the `F` dialog).
pub async fn resolve_target(state: &AppState, context: &str, target: ForwardTarget) -> Result<ForwardTargetInfo> {
    let s = state.session(context).await?;
    let ns = target.namespace().to_string();
    let name = target.name().to_string();
    let (ports, resolved, message, hints) = match &target {
        ForwardTarget::Pod { .. } => {
            let pod = s.get(&api_path(&pods_gvr(), Some(&ns), Some(&name))).await?;
            let ready = pod_ready(&pod);
            let hints = k9s_hints([annotations(&pod)]);
            (pod_spec(&pod).map(container_ports).unwrap_or_default(), Some(name.clone()), (!ready).then(|| "the pod is not ready".to_string()), hints)
        }
        ForwardTarget::Service { .. } => {
            let svc = s.get(&api_path(&services_gvr(), Some(&ns), Some(&name))).await?;
            let svc_ports = service_ports(&svc);
            let ports = svc_ports
                .clone()
                .into_iter()
                .filter(|p| p.protocol == "TCP")
                .map(|p| TargetPort { name: p.name, port: p.port, protocol: p.protocol })
                .collect();
            let slices =
                s.get(&with_query(&api_path(&slices_gvr(), Some(&ns), None), &[("labelSelector", &format!("kubernetes.io/service-name={name}"))])).await?;
            let pod = pick_endpoint(&slices, None, None).or_else(|| endpoint_counts(&slices).2.first().map(|p| (p.clone(), None)));
            let pod = pod.map(|(p, _)| p);
            let message = pod.is_none().then(|| "no ready endpoint".to_string());
            // the Service's own annotations name Service ports; a backing pod's name container ports
            let mut hints = k9s_hints([annotations(&svc)]);
            if let Some(p) = &pod
                && let Ok(pod_json) = s.get(&api_path(&pods_gvr(), Some(&ns), Some(p))).await
            {
                for h in hints_to_service(&k9s_hints([annotations(&pod_json)]), &svc_ports, pod_spec(&pod_json)) {
                    if !hints.iter().any(|x| x.remote_port == h.remote_port) {
                        hints.push(h);
                    }
                }
            }
            (ports, pod, message, hints)
        }
        ForwardTarget::Workload { gvr, .. } => {
            let w = s.get(&api_path(gvr, Some(&ns), Some(&name))).await?;
            let ports = pod_spec(&w).map(container_ports).unwrap_or_default();
            let pod = match selector_string(&w) {
                Some(sel) => {
                    let pods = s.get(&with_query(&api_path(&pods_gvr(), Some(&ns), None), &[("labelSelector", &sel)])).await?;
                    pick_pod(&pods, None).and_then(|p| str_at(p, &["metadata", "name"])).map(str::to_string)
                }
                None => None,
            };
            let message = pod.is_none().then(|| "no ready pod".to_string());
            (ports, pod, message, k9s_hints([template_annotations(&w), annotations(&w)]))
        }
    };
    let hints = (!hints.is_empty()).then_some(hints);
    Ok(ForwardTargetInfo { ready: resolved.is_some() && message.is_none(), target, resolved_pod: resolved, ports, message, hints })
}

// ───────────────────────── idle stop ─────────────────────────

/// Whether the idle-stop watcher runs. It exists only while agent-owned forwards with an idle stop do.
#[derive(Default)]
struct IdleWatch(AtomicBool);

fn ensure_idle_watch(state: &AppState) {
    let watch = state.ext::<IdleWatch>();
    if watch.0.swap(true, Ordering::SeqCst) {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            sleep(IDLE_TICK).await;
            let now = now_ms();
            let (expired, remaining) = {
                let forwards = state.forwards();
                let mut expired = Vec::new();
                let mut remaining = 0usize;
                for (id, e) in forwards.iter() {
                    if !matches!(&e.info.owner, ForwardOwner::Agent { idle_stop_minutes, .. } if *idle_stop_minutes > 0) {
                        continue;
                    }
                    let connections = e.shared.connections.load(Ordering::Relaxed);
                    match idle_stop_at(&e.info.owner, connections, e.shared.idle_since.load(Ordering::Relaxed)) {
                        Some(at) if at <= now => expired.push(id.clone()),
                        _ => remaining += 1,
                    }
                }
                (expired, remaining)
            };
            for id in &expired {
                let _ = stop_forward(&state, id).await;
            }
            if remaining == 0 {
                watch.0.store(false, Ordering::SeqCst);
                // a forward started while this decided to stop: keep watching
                let again = state
                    .forwards()
                    .values()
                    .any(|e| matches!(&e.info.owner, ForwardOwner::Agent { idle_stop_minutes, .. } if *idle_stop_minutes > 0));
                if !again || watch.0.swap(true, Ordering::SeqCst) {
                    break;
                }
            }
        }
    });
}

// ───────────────────────── connections ─────────────────────────

#[derive(Clone)]
struct Conn {
    session: Arc<Session>,
    namespace: String,
    resolver: Arc<Resolver>,
    shared: Arc<Shared>,
}

async fn accept_loop(listener: TcpListener, conn: Conn, cancel: CancellationToken) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            // Reap finished connections so the set does not grow.
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            accepted = listener.accept() => match accepted {
                Ok((tcp, _)) => {
                    let _ = tcp.set_nodelay(true);
                    conn.shared.connections.fetch_add(1, Ordering::Relaxed);
                    connections.spawn(connection(tcp, conn.clone()));
                }
                // Per-connection failures (aborted handshake, out of descriptors): keep listening.
                Err(e) => {
                    *lock(&conn.shared.error) = Some(format!("accept: {e}"));
                    tokio::select! {
                        _ = cancel.cancelled() => break,
                        _ = sleep(Duration::from_millis(100)) => {}
                    }
                }
            },
        }
    }
    drop(listener);
    connections.shutdown().await;
}

/// Decrements the connection count on every way out of a connection, abort included; the last
/// one to close starts the idle clock.
struct Open(Arc<Shared>);

impl Drop for Open {
    fn drop(&mut self) {
        if self.0.connections.fetch_sub(1, Ordering::Relaxed) == 1 {
            self.0.idle_since.store(now_ms(), Ordering::Relaxed);
        }
    }
}

/// The pod and port for a new connection; with no ready pod, retried each second for `HOLD`.
async fn resolve_for_connection(resolver: &Resolver) -> Option<(String, u16)> {
    let deadline = Instant::now() + HOLD;
    loop {
        if let Ok(Some(found)) = resolver.resolve().await {
            return Some(found);
        }
        if Instant::now() >= deadline {
            return None;
        }
        sleep(Duration::from_secs(1)).await;
        resolver.invalidate();
    }
}

/// One client connection: its own port-forward stream to the resolved pod, copied both ways.
async fn connection(mut tcp: TcpStream, conn: Conn) {
    let _open = Open(conn.shared.clone());
    // no ready pod within HOLD: dropping the socket closes the client connection
    let Some((pod, port)) = resolve_for_connection(&conn.resolver).await else { return };
    let pods: Api<Pod> = Api::namespaced(conn.session.client.clone(), &conn.namespace);
    let outcome = async {
        let mut forwarder = timed(pods.portforward(&pod, &[port])).await?;
        let mut stream = forwarder.take_stream(port).ok_or_else(|| BackendError::internal("port-forward stream missing"))?;
        // The kubelet reports e.g. "connection refused" on the port's error channel.
        // Fused: once resolved it stays pending, so it can be polled again after the copy.
        let mut port_error = pin!(flatten(forwarder.take_error(port)).fuse());
        let message = tokio::select! {
            // I/O errors here are the client or the pod hanging up; not a fault of the forward.
            // The error message may arrive just after the data stream closed.
            _ = copy_bidirectional(&mut tcp, &mut stream) => {
                timeout(Duration::from_millis(100), &mut port_error).await.ok().flatten()
            }
            Some(message) = &mut port_error => Some(message),
        };
        message.map_or(Ok(()), |m| Err(BackendError::new(0, "PortForward", m)))
    }
    .await;
    if outcome.is_err() {
        // the pod may be gone (rollout): the next connection resolves again
        conn.resolver.invalidate();
    }
    *lock(&conn.shared.error) = outcome.err().map(|e| e.message);
}

async fn flatten(error: Option<impl Future<Output = Option<String>>>) -> Option<String> {
    match error {
        Some(e) => e.await,
        None => None,
    }
}

pub mod cmd {
    use super::{AppState, ForwardQuery};
    use crate::ipc::{Forward, ForwardTarget, ForwardTargetInfo, Result};

    #[tauri::command]
    pub async fn start_forward(state: tauri::State<'_, AppState>, query: ForwardQuery) -> Result<Forward> {
        super::start_forward(&state, query).await
    }

    #[tauri::command]
    pub async fn list_forwards(state: tauri::State<'_, AppState>) -> Result<Vec<Forward>> {
        super::list_forwards(&state).await
    }

    #[tauri::command]
    pub async fn stop_forward(state: tauri::State<'_, AppState>, id: String) -> Result<()> {
        super::stop_forward(&state, &id).await
    }

    /// Service -> EndpointSlice -> ready pod; workload -> selector -> ready pod.
    #[tauri::command]
    pub async fn resolve_forward_target(state: tauri::State<'_, AppState>, context: String, target: ForwardTarget) -> Result<ForwardTargetInfo> {
        super::resolve_target(&state, &context, target).await
    }

    /// Rust builds `http://<address>:<localPort>/` from its own record and opens it with
    /// tauri-plugin-opener (the webview has no opener permission).
    #[tauri::command]
    pub async fn open_forward(state: tauri::State<'_, AppState>, id: String) -> Result<()> {
        super::open_forward(&state, &id)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn query_wire_shape() {
        let q: ForwardQuery = serde_json::from_value(json!({
            "context": "default",
            "target": { "kind": "service", "namespace": "kafka", "name": "kafka" },
            "remotePort": "local", "localPort": 9094, "pin": true, "label": "kafka", "proposalId": "p1"
        }))
        .unwrap();
        assert_eq!(q.target, ForwardTarget::Service { namespace: "kafka".into(), name: "kafka".into() });
        assert_eq!(q.remote_port, PortRef::Name("local".into()));
        assert_eq!((q.pin, q.proposal_id.as_deref()), (Some(true), Some("p1")));
        let bad = json!({ "context": "c", "target": { "kind": "node", "name": "x" }, "remotePort": 1 });
        assert!(serde_json::from_value::<ForwardQuery>(bad).is_err());
        // the legacy shape is gone
        let legacy = json!({ "context": "c", "namespace": "n", "pod": "p", "remotePort": 80 });
        assert!(serde_json::from_value::<ForwardQuery>(legacy).is_err());
    }

    #[test]
    fn loopback_parsing() {
        for ok in ["127.0.0.1", "::1", "[::1]", "127.1.2.3", " 127.0.0.1 "] {
            assert!(parse_address(Some(ok)).is_ok(), "{ok}");
        }
        assert_eq!(parse_address(None).unwrap(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_eq!(parse_address(Some("")).unwrap(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        for bad in ["0.0.0.0", "localhost", "10.0.0.1", "::", "192.168.1.5", "example.com", "127.0.0.1:80"] {
            assert_eq!(parse_address(Some(bad)).unwrap_err().reason, "Invalid", "{bad}");
        }
    }

    #[test]
    fn labels_and_urls() {
        assert!(valid_label("kafka ui_1.x-y"));
        for bad in ["", "a/b", "x\u{202E}", &"a".repeat(41)] {
            assert!(!valid_label(bad), "{bad}");
        }
        assert_eq!(forward_url("127.0.0.1", 8080), "http://127.0.0.1:8080/");
        assert_eq!(forward_url("::1", 3000), "http://[::1]:3000/");
    }

    #[test]
    fn free_port_and_pinned_port() {
        let lo = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let free = choose_listener(lo, None, false).unwrap();
        let port = free.local_addr().unwrap().port();
        assert_ne!(port, 0);
        let err = choose_listener(lo, Some(port), true).unwrap_err();
        assert_eq!(err.reason, "AddrInUse", "a held port is not free when pinned");
        let moved = choose_listener(lo, Some(port), false).unwrap();
        let next = moved.local_addr().unwrap().port();
        assert_ne!(next, port, "unpinned moves on");
        assert!(next > port && next <= port.saturating_add(PORT_FALLBACK) || next != 0, "to a following or free port");
    }

    #[test]
    fn a_wildcard_listener_shadows_nothing() {
        // something holding *:p (all interfaces) must make p busy for a loopback forward.
        // Bound, not listening: a wildcard listener in a test would raise a firewall prompt.
        let blocker = bind_socket(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0)).unwrap();
        let port = blocker.local_addr().unwrap().as_socket().unwrap().port();
        assert!(wildcard_busy(port));
        assert_eq!(choose_listener(IpAddr::V4(Ipv4Addr::LOCALHOST), Some(port), true).unwrap_err().reason, "AddrInUse");
        let moved = choose_listener(IpAddr::V4(Ipv4Addr::LOCALHOST), Some(port), false).unwrap();
        assert_ne!(moved.local_addr().unwrap().port(), port, "unpinned skips the shadowed port");
    }

    fn ep(pod: &str, ready: Option<bool>) -> Json {
        let mut e = json!({ "addresses": ["10.0.0.1"], "targetRef": { "kind": "Pod", "name": pod } });
        if let Some(r) = ready {
            e["conditions"] = json!({ "ready": r });
        }
        e
    }

    fn slices() -> Json {
        json!({ "items": [
            { "ports": [{ "name": "internal", "port": 9092 }, { "name": "local", "port": 19094 }],
              "endpoints": [ep("kafka-0", Some(false)), ep("kafka-1", Some(true)), ep("kafka-2", None)] },
            { "ports": [{ "name": "local", "port": 29094 }],
              "endpoints": [ep("kafka-3", Some(true))] }
        ]})
    }

    #[test]
    fn endpoint_slices_choose_a_ready_pod_and_the_slice_port() {
        let s = slices();
        assert_eq!(pick_endpoint(&s, Some("local"), None), Some(("kafka-1".into(), Some(19094))), "first ready, not kafka-0");
        assert_eq!(pick_endpoint(&s, Some("local"), Some("kafka-3")), Some(("kafka-3".into(), Some(29094))), "sticky, port of its own slice");
        assert_eq!(pick_endpoint(&s, Some("local"), Some("kafka-0")), Some(("kafka-1".into(), Some(19094))), "sticky pod not ready: moves");
        assert_eq!(pick_endpoint(&s, Some("missing"), None), Some(("kafka-1".into(), None)), "no port of that name: caller falls back");
        let unnamed = json!({ "items": [{ "ports": [{ "name": "", "port": 8080 }], "endpoints": [ep("web-1", None)] }] });
        assert_eq!(pick_endpoint(&unnamed, None, None), Some(("web-1".into(), Some(8080))));
        let terminating = json!({ "items": [{ "endpoints": [{ "targetRef": { "kind": "Pod", "name": "x" }, "conditions": { "ready": true, "terminating": true } }] }] });
        assert_eq!(pick_endpoint(&terminating, None, None), None);
        assert_eq!(pick_endpoint(&json!({ "items": [] }), None, None), None, "no ready endpoint: waiting");
        assert_eq!(endpoint_counts(&s), (3, 1, vec!["kafka-1".to_string(), "kafka-2".to_string(), "kafka-3".to_string()]));
    }

    fn svc() -> Json {
        json!({ "spec": { "ports": [
            { "name": "internal", "port": 9092, "targetPort": 9092, "protocol": "TCP" },
            { "name": "local", "port": 9094, "targetPort": "local" },
            { "name": "metrics", "port": 80, "targetPort": "9404" }
        ]}})
    }

    #[test]
    fn service_ports_by_number_and_name() {
        let s = svc();
        let local = service_port(&s, &PortRef::Name("local".into())).unwrap();
        assert_eq!((local.port, local.target.clone()), (9094, PortRef::Name("local".into())));
        assert_eq!(service_port(&s, &PortRef::Number(9092)).unwrap().name.as_deref(), Some("internal"));
        assert_eq!(service_port(&s, &PortRef::Number(80)).unwrap().target, PortRef::Number(9404), "numeric string targetPort");
        assert_eq!(service_port(&s, &PortRef::Number(9404)).unwrap().port, 80, "a target port number finds its service port");
        assert!(service_port(&s, &PortRef::Number(1234)).is_none());
        assert!(service_port(&s, &PortRef::Name("nope".into())).is_none());
    }

    fn pod(name: &str, ready: bool) -> Json {
        json!({
            "kind": "Pod",
            "metadata": { "name": name },
            "spec": { "containers": [{ "name": "app", "ports": [{ "name": "http", "containerPort": 8080 }, { "containerPort": 9000, "protocol": "UDP" }] }],
                      "initContainers": [{ "name": "side", "ports": [{ "name": "metrics", "containerPort": 9404 }] }] },
            "status": { "conditions": [{ "type": "Ready", "status": if ready { "True" } else { "False" } }] }
        })
    }

    #[test]
    fn named_container_ports_and_readiness() {
        let p = pod("web-1", true);
        let spec = pod_spec(&p).unwrap();
        assert_eq!(container_port_by_name(spec, "http"), Some(8080));
        assert_eq!(container_port_by_name(spec, "metrics"), Some(9404), "sidecar ports count");
        assert_eq!(container_ports(spec).len(), 2, "UDP is not forwardable");
        assert_eq!(port_on_pod(&p, &PortRef::Name("http".into())).unwrap(), 8080);
        assert_eq!(port_on_pod(&p, &PortRef::Name("x".into())).unwrap_err().reason, "Invalid");
        assert!(pod_ready(&p));
        assert!(!pod_ready(&pod("web-2", false)));
        let mut deleting = pod("web-3", true);
        deleting["metadata"]["deletionTimestamp"] = json!("2026-11-22T10:00:00Z");
        assert!(!pod_ready(&deleting));
        let deploy = json!({ "kind": "Deployment", "spec": { "template": { "spec": { "containers": [{ "ports": [{ "name": "http", "containerPort": 80 }] }] } } } });
        assert_eq!(container_port_by_name(pod_spec(&deploy).unwrap(), "http"), Some(80));
        let cron = json!({ "kind": "CronJob", "spec": { "jobTemplate": { "spec": { "template": { "spec": { "containers": [{ "ports": [{ "containerPort": 81 }] }] } } } } } });
        assert_eq!(container_ports(pod_spec(&cron).unwrap())[0].port, 81);
    }

    #[test]
    fn workload_selectors_and_pod_choice() {
        let d = json!({ "spec": { "selector": { "matchLabels": { "app": "web" }, "matchExpressions": [
            { "key": "tier", "operator": "In", "values": ["a", "b"] }, { "key": "canary", "operator": "DoesNotExist" }
        ] } } });
        assert_eq!(selector_string(&d).as_deref(), Some("app=web,tier in (a,b),!canary"));
        let cron = json!({ "spec": { "jobTemplate": { "spec": { "template": { "metadata": { "labels": { "job": "x" } } } } } } });
        assert_eq!(selector_string(&cron).as_deref(), Some("job=x"));
        assert_eq!(selector_string(&json!({ "spec": {} })), None);
        let pods = json!({ "items": [pod("web-c", true), pod("web-a", false), pod("web-b", true)] });
        let name = |p: Option<&Json>| p.and_then(|p| str_at(p, &["metadata", "name"])).map(str::to_string);
        assert_eq!(name(pick_pod(&pods, None)).as_deref(), Some("web-b"), "first ready by name");
        assert_eq!(name(pick_pod(&pods, Some("web-c"))).as_deref(), Some("web-c"), "sticky");
        assert_eq!(name(pick_pod(&pods, Some("web-a"))).as_deref(), Some("web-b"), "sticky but not ready");
        assert_eq!(pick_pod(&json!({ "items": [pod("x", false)] }), None), None, "none ready: waiting");
    }

    #[test]
    fn idle_stop_only_for_idle_agent_forwards() {
        let agent = ForwardOwner::Agent { client: "claude-code".into(), idle_stop_minutes: 15 };
        assert_eq!(idle_stop_at(&agent, 0, 1_000), Some(1_000 + 15 * 60_000));
        assert_eq!(idle_stop_at(&agent, 1, 1_000), None, "an open connection is not idle");
        assert_eq!(idle_stop_at(&ForwardOwner::Agent { client: "c".into(), idle_stop_minutes: 0 }, 0, 1_000), None, "0 = never");
        assert_eq!(idle_stop_at(&ForwardOwner::User, 0, 1_000), None, "human forwards never idle-stop");
    }

    #[test]
    fn ticketed_starts_must_match_the_approved_forward() {
        let target = ForwardTarget::Service { namespace: "kafka".into(), name: "kafka".into() };
        let payload = ProposalPayload::Forward { context: "default".into(), target: target.clone(), remote_port: PortRef::Number(9094), local_port: Some(9094) };
        let q = ForwardQuery {
            context: "default".into(),
            target: target.clone(),
            remote_port: PortRef::Number(9094),
            local_port: Some(9094),
            pin: None,
            address: None,
            label: None,
            dev_set: None,
            proposal_id: Some("p1".into()),
        };
        assert!(matches_proposal(&payload, &q));
        assert!(!matches_proposal(&payload, &ForwardQuery { local_port: Some(1), ..q.clone() }), "other local port");
        assert!(!matches_proposal(&payload, &ForwardQuery { context: "staging".into(), ..q.clone() }), "other context");
        assert!(!matches_proposal(&payload, &ForwardQuery { remote_port: PortRef::Number(9092), ..q.clone() }));
        let any_local = ProposalPayload::Forward { context: "default".into(), target, remote_port: PortRef::Number(9094), local_port: None };
        assert!(matches_proposal(&any_local, &ForwardQuery { local_port: None, ..q }), "no local port in the proposal: any");
    }

    #[test]
    fn k9s_annotations() {
        let a = json!({
            "k9scli.io/auto-port-forwards": "zorg::5556",
            "k9scli.io/port-forwards": "bozo::9090:p1, 8080 ,web::http, bad port, 0, ::x:y, a::70000, BIG::80, 18081:8081",
        });
        let h = k9s_hints([Some(&a)]);
        let want = |c: Option<&str>, r: PortRef, l: Option<u16>, auto: bool| PortHint { container: c.map(Into::into), remote_port: r, local_port: l, auto };
        assert_eq!(
            h,
            vec![
                want(Some("zorg"), PortRef::Number(5556), None, true),
                want(Some("bozo"), PortRef::Name("p1".into()), Some(9090), false),
                want(None, PortRef::Number(8080), None, false),
                want(Some("web"), PortRef::Name("http".into()), None, false),
                want(None, PortRef::Number(8081), Some(18081), false),
            ]
        );
        assert!(k9s_hints([None, Some(&json!({"other": "x"}))]).is_empty());
        // pod (template) and workload maps: one remote port once
        let t = json!({"k9scli.io/port-forwards": "8080"});
        assert_eq!(k9s_hints([Some(&t), Some(&t)]).len(), 1);
    }

    #[test]
    fn k9s_hints_map_to_service_ports() {
        let svc = json!({"spec": {"ports": [
            {"name": "http", "port": 80, "targetPort": "web"},
            {"name": "metrics", "port": 9100, "targetPort": 9100},
        ]}});
        let spec = json!({"containers": [{"name": "app", "ports": [{"name": "web", "containerPort": 8080}, {"containerPort": 9100}]}]});
        let ports = service_ports(&svc);
        let pod_hints = vec![
            PortHint { container: None, remote_port: PortRef::Number(8080), local_port: Some(18080), auto: false },
            PortHint { container: None, remote_port: PortRef::Name("web".into()), local_port: None, auto: false },
            PortHint { container: None, remote_port: PortRef::Number(9100), local_port: None, auto: true },
            PortHint { container: None, remote_port: PortRef::Number(5000), local_port: None, auto: false },
        ];
        let mapped = hints_to_service(&pod_hints, &ports, Some(&spec));
        let remotes: Vec<_> = mapped.iter().map(|h| (h.remote_port.clone(), h.local_port)).collect();
        assert_eq!(remotes, vec![(PortRef::Number(80), Some(18080)), (PortRef::Number(80), None), (PortRef::Number(9100), None)]);
    }
}
