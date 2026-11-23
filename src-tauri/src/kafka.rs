//! Pure: Kafka advertised-listener parsing from a broker pod spec and the suggested `LOCAL`
//! listener (§3 B-dev). No commands. Owner: B-dev (B-fwd's `service::info` reads it).
//!
//! Only literal env values are read (`KAFKA_ADVERTISED_LISTENERS` / `KAFKA_CFG_ADVERTISED_LISTENERS`
//! and the protocol map); a `valueFrom` makes the listeners unknown.
use crate::ipc::{Json, KafkaListener};

const ADVERTISED: [&str; 2] = ["KAFKA_ADVERTISED_LISTENERS", "KAFKA_CFG_ADVERTISED_LISTENERS"];
const PROTOCOL_MAP: [&str; 2] = ["KAFKA_LISTENER_SECURITY_PROTOCOL_MAP", "KAFKA_CFG_LISTENER_SECURITY_PROTOCOL_MAP"];

/// A literal env value of any container of a pod spec (or pod / workload object).
fn literal_env<'a>(obj: &'a Json, names: &[&str]) -> Option<&'a str> {
    let spec = crate::forward::pod_spec(obj).unwrap_or(obj);
    let containers = spec.get("containers").and_then(Json::as_array)?;
    containers.iter().flat_map(|c| c.get("env").and_then(Json::as_array).into_iter().flatten()).find_map(|e| {
        let name = e.get("name").and_then(Json::as_str)?;
        if !names.contains(&name) {
            return None;
        }
        e.get("value").and_then(Json::as_str)
    })
}

/// `NAME://host:port,...` -> listeners, with protocols from `NAME:PROTO,...`.
pub fn parse_listeners(advertised: &str, protocol_map: Option<&str>) -> Vec<KafkaListener> {
    let protocols: Vec<(String, String)> = protocol_map
        .unwrap_or_default()
        .split(',')
        .filter_map(|p| p.trim().split_once(':').map(|(n, proto)| (n.trim().to_ascii_uppercase(), proto.trim().to_string())))
        .collect();
    advertised
        .split(',')
        .filter_map(|l| {
            let (name, rest) = l.trim().split_once("://")?;
            let name = name.trim().to_ascii_uppercase();
            if name.is_empty() || rest.is_empty() {
                return None;
            }
            let protocol = protocols.iter().find(|(n, _)| *n == name).map(|(_, p)| p.clone()).or_else(|| {
                // a listener named after its protocol (PLAINTEXT://, SASL_SSL://) needs no map
                ["PLAINTEXT", "SSL", "SASL_PLAINTEXT", "SASL_SSL"].contains(&name.as_str()).then(|| name.clone())
            });
            Some(KafkaListener { name, advertised: rest.trim().to_string(), protocol })
        })
        .collect()
}

/// The listeners a broker pod (or its workload) advertises; `None` when not literal / not set.
pub fn listeners(obj: &Json) -> Option<Vec<KafkaListener>> {
    let advertised = literal_env(obj, &ADVERTISED)?;
    let list = parse_listeners(advertised, literal_env(obj, &PROTOCOL_MAP));
    (!list.is_empty()).then_some(list)
}

/// `host:port` -> (host, port).
pub fn host_port(advertised: &str) -> Option<(&str, u16)> {
    let (host, port) = advertised.rsplit_once(':')?;
    Some((host.trim_start_matches('[').trim_end_matches(']'), port.parse().ok()?))
}

/// The listener a local client can use through a forward: one advertising `localhost` /
/// `127.0.0.1`. Its port must be the forward's local port (the broker tells clients to reconnect
/// there), so it is pinned.
pub fn local_listener(listeners: &[KafkaListener]) -> Option<(&KafkaListener, u16)> {
    listeners.iter().find_map(|l| {
        let (host, port) = host_port(&l.advertised)?;
        matches!(host, "localhost" | "127.0.0.1" | "::1").then_some((l, port))
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// The owner's apps/kafka/kafka.yaml shape: INTERNAL on the cluster name, LOCAL on localhost:9094.
    fn broker() -> Json {
        json!({ "kind": "StatefulSet", "spec": { "template": { "spec": { "containers": [{ "name": "kafka", "env": [
            { "name": "KAFKA_NODE_ID", "value": "1" },
            { "name": "KAFKA_LISTENERS", "value": "INTERNAL://:9092,CONTROLLER://:9093,LOCAL://:9094" },
            { "name": "KAFKA_ADVERTISED_LISTENERS", "value": "INTERNAL://kafka.kafka.svc.cluster.local:9092,LOCAL://localhost:9094" },
            { "name": "KAFKA_LISTENER_SECURITY_PROTOCOL_MAP", "value": "INTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT,LOCAL:PLAINTEXT" }
        ] }] } } } })
    }

    #[test]
    fn owner_broker_shape() {
        let l = listeners(&broker()).unwrap();
        assert_eq!(l.len(), 2);
        assert_eq!((l[0].name.as_str(), l[0].advertised.as_str(), l[0].protocol.as_deref()), ("INTERNAL", "kafka.kafka.svc.cluster.local:9092", Some("PLAINTEXT")));
        let (local, port) = local_listener(&l).unwrap();
        assert_eq!((local.name.as_str(), port), ("LOCAL", 9094));
    }

    #[test]
    fn bitnami_names_value_from_and_plain_protocols() {
        let bitnami = json!({ "kind": "Pod", "spec": { "containers": [{ "env": [
            { "name": "KAFKA_CFG_ADVERTISED_LISTENERS", "value": "PLAINTEXT://kafka-0.kafka-headless:9092, EXTERNAL://127.0.0.1:19092" }
        ] }] } });
        let l = listeners(&bitnami).unwrap();
        assert_eq!(l[0].protocol.as_deref(), Some("PLAINTEXT"));
        assert_eq!(l[1].protocol, None);
        assert_eq!(local_listener(&l).map(|(l, p)| (l.name.clone(), p)), Some(("EXTERNAL".into(), 19092)));
        let from_ref = json!({ "kind": "Pod", "spec": { "containers": [{ "env": [
            { "name": "KAFKA_ADVERTISED_LISTENERS", "valueFrom": { "configMapKeyRef": { "name": "x", "key": "y" } } }
        ] }] } });
        assert_eq!(listeners(&from_ref), None, "valueFrom = unknown");
        assert_eq!(listeners(&json!({ "kind": "Pod", "spec": { "containers": [{}] } })), None);
        assert!(local_listener(&parse_listeners("INTERNAL://kafka:9092", None)).is_none());
        assert_eq!(host_port("[::1]:9094"), Some(("::1", 9094)));
    }
}
