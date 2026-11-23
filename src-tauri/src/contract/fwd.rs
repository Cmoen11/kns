//! Forwards and their targets: mirror of `src/ipc/contract/fwd.ts` (docs/plan-features.md §2.4).
//! Written by A1; owner B-fwd.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::ipc::{Gvr, ObjRef};

/// What `start_forward` accepts (§2.4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForwardQuery {
    pub context: String,
    pub target: ForwardTarget,
    pub remote_port: PortRef,
    /// 0 / absent = a free port
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_port: Option<u16>,
    /// true: fail with `AddrInUse` instead of moving to the next free port
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin: Option<bool>,
    /// loopback IP literal only: 127.0.0.1 (default), ::1, or 127.x.y.z
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    /// `[A-Za-z0-9 ._-]{1,40}`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_set: Option<String>,
    /// set when the human executes an agent proposal; Rust gates on it and takes the owner from the ticket
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ForwardStatus {
    Active,
    /// no ready pod behind a Service/workload target; the listener stays bound
    Waiting,
    Error,
}

/// A running forward.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Forward {
    pub id: String,
    pub context: String,
    pub target: ForwardTarget,
    /// compat for existing readers: the resolved pod, else `<kind>/<name>`
    pub pod: String,
    pub namespace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_pod: Option<String>,
    pub remote_port: PortRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_port: Option<u16>,
    pub local_port: u16,
    pub address: String,
    pub connections: u32,
    pub status: ForwardStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_set: Option<String>,
    pub owner: ForwardOwner,
    /// the client whose proposal started it, kept after ownership moved to the human
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<String>,
    /// ms since epoch
    pub started_at: i64,
    /// agent-owned with an idle stop and no open connection: when it stops (ms since epoch)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_stop_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ForwardTarget {
    Pod { namespace: String, name: String },
    Service { namespace: String, name: String },
    Workload { gvr: Gvr, namespace: String, name: String },
}

impl ForwardTarget {
    pub fn namespace(&self) -> &str {
        match self {
            Self::Pod { namespace, .. } | Self::Service { namespace, .. } | Self::Workload { namespace, .. } => namespace,
        }
    }
    pub fn name(&self) -> &str {
        match self {
            Self::Pod { name, .. } | Self::Service { name, .. } | Self::Workload { name, .. } => name,
        }
    }
    /// `pod`, `service` or `workload`.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Pod { .. } => "pod",
            Self::Service { .. } => "service",
            Self::Workload { .. } => "workload",
        }
    }
}

/// A port number, or a named port (Service port name or container port name).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PortRef {
    Number(u16),
    Name(String),
}

impl std::fmt::Display for PortRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Number(n) => write!(f, "{n}"),
            Self::Name(s) => f.write_str(s),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "by", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ForwardOwner {
    User,
    Agent { client: String, idle_stop_minutes: u32 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicePort {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub port: u16,
    pub target_port: PortRef,
    pub protocol: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_protocol: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceKind {
    Postgres,
    Mysql,
    Redis,
    Memcached,
    Kafka,
    SchemaRegistry,
    Mongodb,
    Rabbitmq,
    Http,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaListener {
    pub name: String,
    pub advertised: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoints {
    pub ready: u32,
    pub not_ready: u32,
    pub pods: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    #[serde(rename = "ref")]
    pub obj_ref: ObjRef,
    #[serde(rename = "type")]
    pub type_: String,
    pub ports: Vec<ServicePort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<BTreeMap<String, String>>,
    pub endpoints: Endpoints,
    pub kind: ServiceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kafka_listeners: Option<Vec<KafkaListener>>,
    /// ports a backing pod's `k9scli.io/*` annotations ask for, mapped to Service ports (B2)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hints: Option<Vec<PortHint>>,
}

/// A port a `k9scli.io/auto-port-forwards` / `k9scli.io/port-forwards` annotation asks for (B2).
/// Only ports: an annotation never chooses an address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortHint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    /// a container port (number or name); on a Service target the Service port it maps to
    pub remote_port: PortRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_port: Option<u16>,
    /// from `auto-port-forwards` (k9s starts it without asking; kns only preselects it)
    pub auto: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetPort {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub port: u16,
    pub protocol: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardTargetInfo {
    pub target: ForwardTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_pod: Option<String>,
    pub ports: Vec<TargetPort>,
    pub ready: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// ports the target's `k9scli.io/*` annotations ask for; the first is the dialog's preselection (B2)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hints: Option<Vec<PortHint>>,
}

/// One name the proxy routes: `http://<host>:<port>/` -> a forward.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyName {
    /// `<label>.<namespace>.localhost`
    pub host: String,
    pub forward: String,
}

/// The `*.localhost` name proxy (B2, `proxy.rs`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NameProxyStatus {
    pub on: bool,
    pub port: u16,
    pub names: Vec<ProxyName>,
    /// why it is off although it was left on (the port was taken at start)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    pub fn pod() -> ForwardTarget {
        ForwardTarget::Pod { namespace: "kafka".into(), name: "kafka-0".into() }
    }
    pub fn service() -> ForwardTarget {
        ForwardTarget::Service { namespace: "kafka".into(), name: "kafka".into() }
    }
    pub fn workload() -> ForwardTarget {
        ForwardTarget::Workload { gvr: Gvr::new("apps", "v1", "deployments"), namespace: "shop".into(), name: "orders".into() }
    }
    pub fn obj(resource: &str, namespace: &str, name: &str) -> ObjRef {
        let gvr = match resource {
            "deployments" => Gvr::new("apps", "v1", "deployments"),
            other => Gvr::new("", "v1", other),
        };
        ObjRef { context: "default".into(), gvr, namespace: Some(namespace.into()), name: name.into() }
    }
}

#[cfg(test)]
mod tests {
    use super::{fixtures::*, *};
    use crate::contract::drift::Fixtures;

    #[test]
    fn drift() {
        let mut f = Fixtures::new("fwd");
        f.add("forwardTargets", "ForwardTarget[]", &vec![pod(), service(), workload()]);
        f.add("portRefs", "PortRef[]", &vec![PortRef::Number(9094), PortRef::Name("http".into())]);
        f.add(
            "forwardOwners",
            "ForwardOwner[]",
            &vec![ForwardOwner::User, ForwardOwner::Agent { client: "claude-code".into(), idle_stop_minutes: 15 }],
        );
        f.add(
            "serviceInfo",
            "ServiceInfo",
            &ServiceInfo {
                obj_ref: obj("services", "kafka", "kafka"),
                type_: "ClusterIP".into(),
                ports: vec![
                    ServicePort { name: Some("internal".into()), port: 9092, target_port: PortRef::Number(9092), protocol: "TCP".into(), app_protocol: None },
                    ServicePort { name: Some("local".into()), port: 9094, target_port: PortRef::Name("local".into()), protocol: "TCP".into(), app_protocol: Some("kafka".into()) },
                ],
                selector: Some(BTreeMap::from([("app".into(), "kafka".into())])),
                endpoints: Endpoints { ready: 1, not_ready: 0, pods: vec!["kafka-0".into()] },
                kind: ServiceKind::Kafka,
                kafka_listeners: Some(vec![KafkaListener { name: "LOCAL".into(), advertised: "localhost:9094".into(), protocol: Some("PLAINTEXT".into()) }]),
                hints: Some(vec![PortHint { container: None, remote_port: PortRef::Number(9094), local_port: Some(9094), auto: false }]),
            },
        );
        f.add(
            "forwardTargetInfo",
            "ForwardTargetInfo",
            &ForwardTargetInfo {
                target: service(),
                resolved_pod: Some("kafka-0".into()),
                ports: vec![TargetPort { name: Some("local".into()), port: 9094, protocol: "TCP".into() }],
                ready: true,
                message: None,
                hints: Some(vec![
                    PortHint { container: Some("kafka".into()), remote_port: PortRef::Name("local".into()), local_port: Some(9094), auto: true },
                    PortHint { container: None, remote_port: PortRef::Number(9092), local_port: None, auto: false },
                ]),
            },
        );
        f.add(
            "forwardQuery",
            "ForwardQuery",
            &ForwardQuery {
                context: "default".into(),
                target: service(),
                remote_port: PortRef::Name("local".into()),
                local_port: Some(9094),
                pin: Some(true),
                address: Some("127.0.0.1".into()),
                label: Some("kafka".into()),
                dev_set: Some("ds1".into()),
                proposal_id: Some("p1".into()),
            },
        );
        let forward = Forward {
            id: "f1".into(),
            context: "default".into(),
            target: service(),
            pod: "kafka-0".into(),
            namespace: "kafka".into(),
            resolved_pod: Some("kafka-0".into()),
            remote_port: PortRef::Number(9094),
            resolved_port: Some(9094),
            local_port: 9094,
            address: "127.0.0.1".into(),
            connections: 1,
            status: ForwardStatus::Active,
            message: None,
            label: Some("kafka".into()),
            dev_set: Some("ds1".into()),
            owner: ForwardOwner::Agent { client: "claude-code".into(), idle_stop_minutes: 15 },
            requested_by: Some("claude-code".into()),
            started_at: 1_763_800_000_000,
            idle_stop_at: Some(1_763_800_900_000),
        };
        let waiting = Forward {
            id: "f2".into(),
            target: workload(),
            pod: "workload/orders".into(),
            namespace: "shop".into(),
            resolved_pod: None,
            remote_port: PortRef::Name("http".into()),
            resolved_port: None,
            status: ForwardStatus::Waiting,
            message: Some("no ready pod".into()),
            owner: ForwardOwner::User,
            requested_by: None,
            idle_stop_at: None,
            label: None,
            dev_set: None,
            ..forward.clone()
        };
        let error = Forward { id: "f3".into(), status: ForwardStatus::Error, message: Some("connection refused".into()), ..waiting.clone() };
        f.add("forwards", "Forward[]", &vec![forward, waiting, error]);
        f.add(
            "nameProxyStatus",
            "NameProxyStatus",
            &NameProxyStatus { on: true, port: 7080, names: vec![ProxyName { host: "kafka-ui.kafka.localhost".into(), forward: "f3".into() }], error: None },
        );
        f.check();
    }

    #[test]
    fn port_ref_wire() {
        assert_eq!(serde_json::from_str::<PortRef>("8080").unwrap(), PortRef::Number(8080));
        assert_eq!(serde_json::from_str::<PortRef>("\"http\"").unwrap(), PortRef::Name("http".into()));
        assert!(serde_json::from_str::<PortRef>("70000").is_err());
    }
}
