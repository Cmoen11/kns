//! Pod traffic: mirror of `src/ipc/contract/traffic.ts`. One reading of a pod's socket table
//! (`/proc/net/{tcp,tcp6,udp,udp6}` of its network namespace), with each peer address named.
//! Produced by `crate::traffic`; the UI adds readings up over time.
use serde::{Deserialize, Serialize};

use crate::ipc::ObjRef;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficRequest {
    /// the pod
    #[serde(rename = "ref")]
    pub obj_ref: ObjRef,
    /// the container to read through; default: a running kns debug container, else the first running one
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    /// where to look peers up when the user may not list pods in every namespace (a team's namespaces)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub namespaces: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrafficProto {
    Tcp,
    Udp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrafficDirection {
    /// a peer connected to a port this pod listens on
    In,
    /// this pod connected to the peer
    Out,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrafficPeerKind {
    Pod,
    Service,
    Node,
    /// 127.0.0.0/8, ::1: another container of the same pod (a sidecar)
    Loopback,
    /// the pod's own address
    #[serde(rename = "self")]
    Own,
    /// nothing in the cluster has the address
    External,
}

/// Who an address is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficPeer {
    pub kind: TrafficPeerKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    /// pod, Service or node name; the address itself for loopback and external
    pub name: String,
    /// a pod's workload (Deployment, StatefulSet, ...) as `Kind/name`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workload: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficConnection {
    pub proto: TrafficProto,
    pub direction: TrafficDirection,
    pub local_port: u16,
    pub remote_ip: String,
    pub remote_port: u16,
    /// ESTABLISHED, SYN_SENT, TIME_WAIT, ... (UDP: ESTABLISHED for a connected socket)
    pub state: String,
    pub peer: TrafficPeer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficListener {
    pub proto: TrafficProto,
    /// the bound address: 0.0.0.0 or :: for every one
    pub ip: String,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficSample {
    /// the container the table was read through (every container shares the pod's network)
    pub container: String,
    /// RFC 3339
    pub at: String,
    pub listening: Vec<TrafficListener>,
    pub connections: Vec<TrafficConnection>,
    /// why some peers have no name (pods or Services that could not be listed)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::drift::Fixtures;
    use crate::ipc::Gvr;

    #[test]
    fn drift() {
        let mut f = Fixtures::new("traffic");
        let pod = ObjRef { context: "default".into(), gvr: Gvr::new("", "v1", "pods"), namespace: Some("shop".into()), name: "orders-6d4f9-abcde".into() };
        f.add("requests", "TrafficRequest[]", &vec![TrafficRequest { obj_ref: pod.clone(), container: None, namespaces: vec![] }, TrafficRequest { obj_ref: pod, container: Some("app".into()), namespaces: vec!["shop".into(), "payments".into()] }]);
        f.add(
            "sample",
            "TrafficSample",
            &TrafficSample {
                container: "app".into(),
                at: "2026-11-25T10:00:00Z".into(),
                listening: vec![TrafficListener { proto: TrafficProto::Tcp, ip: "0.0.0.0".into(), port: 8080 }, TrafficListener { proto: TrafficProto::Udp, ip: "::".into(), port: 8125 }],
                connections: vec![
                    TrafficConnection { proto: TrafficProto::Tcp, direction: TrafficDirection::Out, local_port: 41234, remote_ip: "10.43.9.9".into(), remote_port: 5432, state: "ESTABLISHED".into(), peer: TrafficPeer { kind: TrafficPeerKind::Service, namespace: Some("payments".into()), name: "postgres".into(), workload: None } },
                    TrafficConnection { proto: TrafficProto::Tcp, direction: TrafficDirection::In, local_port: 8080, remote_ip: "10.42.0.17".into(), remote_port: 50122, state: "ESTABLISHED".into(), peer: TrafficPeer { kind: TrafficPeerKind::Pod, namespace: Some("shop".into()), name: "web-7f9c-xk2p1".into(), workload: Some("Deployment/web".into()) } },
                    TrafficConnection { proto: TrafficProto::Tcp, direction: TrafficDirection::Out, local_port: 39000, remote_ip: "127.0.0.1".into(), remote_port: 15001, state: "TIME_WAIT".into(), peer: TrafficPeer { kind: TrafficPeerKind::Loopback, namespace: None, name: "127.0.0.1".into(), workload: None } },
                    TrafficConnection { proto: TrafficProto::Udp, direction: TrafficDirection::Out, local_port: 53000, remote_ip: "10.42.0.1".into(), remote_port: 8125, state: "ESTABLISHED".into(), peer: TrafficPeer { kind: TrafficPeerKind::Node, namespace: None, name: "node-7f3a9c21".into(), workload: None } },
                    TrafficConnection { proto: TrafficProto::Tcp, direction: TrafficDirection::Out, local_port: 40000, remote_ip: "52.1.2.3".into(), remote_port: 443, state: "SYN_SENT".into(), peer: TrafficPeer { kind: TrafficPeerKind::External, namespace: None, name: "52.1.2.3".into(), workload: None } },
                    TrafficConnection { proto: TrafficProto::Tcp, direction: TrafficDirection::In, local_port: 8080, remote_ip: "10.42.0.9".into(), remote_port: 1, state: "CLOSE_WAIT".into(), peer: TrafficPeer { kind: TrafficPeerKind::Own, namespace: Some("shop".into()), name: "orders-6d4f9-abcde".into(), workload: None } },
                ],
                notes: vec!["pods: forbidden across all namespaces; looked in shop, payments".into()],
            },
        );
        f.check();
    }
}
