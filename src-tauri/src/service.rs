//! Service details for forwards and dependencies (§2.4, §3 B-fwd): ports, targetPorts,
//! EndpointSlice readiness, the detected kind (by image and port) and Kafka listeners. Owner: B-fwd.
use crate::{
    forward::{endpoint_counts, pod_spec, pods_gvr, service_ports, services_gvr, slices_gvr},
    ipc::{Endpoints, Json, ObjRef, PortRef, Result, ServiceInfo, ServiceKind, ServicePort},
    kafka,
    session::{api_path, with_query},
    state::AppState,
};

/// Well-known ports, in the order they are checked.
const PORT_KINDS: [(u16, ServiceKind); 10] = [
    (5432, ServiceKind::Postgres),
    (3306, ServiceKind::Mysql),
    (6379, ServiceKind::Redis),
    (11211, ServiceKind::Memcached),
    (9092, ServiceKind::Kafka),
    (9094, ServiceKind::Kafka),
    (8081, ServiceKind::SchemaRegistry),
    (27017, ServiceKind::Mongodb),
    (5672, ServiceKind::Rabbitmq),
    (15672, ServiceKind::Rabbitmq),
];

/// Image name fragments, checked before ports (an image is the stronger signal).
const IMAGE_KINDS: [(&str, ServiceKind); 13] = [
    ("schema-registry", ServiceKind::SchemaRegistry),
    ("postgres", ServiceKind::Postgres),
    ("postgis", ServiceKind::Postgres),
    ("cloudnative-pg", ServiceKind::Postgres),
    ("mysql", ServiceKind::Mysql),
    ("mariadb", ServiceKind::Mysql),
    ("redis", ServiceKind::Redis),
    ("valkey", ServiceKind::Redis),
    ("memcached", ServiceKind::Memcached),
    ("kafka", ServiceKind::Kafka),
    ("redpanda", ServiceKind::Kafka),
    ("mongo", ServiceKind::Mongodb),
    ("rabbitmq", ServiceKind::Rabbitmq),
];

/// What a Service most likely is: by image (the repository part, so `kafka-ui` is not Kafka),
/// then by port, then `http` for web ports / appProtocol, else `unknown`.
pub fn detect_kind(ports: &[ServicePort], images: &[String]) -> ServiceKind {
    for image in images {
        let repo = image.rsplit('/').next().unwrap_or(image);
        let repo = repo.split([':', '@']).next().unwrap_or(repo).to_ascii_lowercase();
        if repo.contains("-ui") || repo.contains("console") || repo.contains("exporter") {
            return ServiceKind::Http;
        }
        if let Some((_, kind)) = IMAGE_KINDS.iter().find(|(frag, _)| repo.contains(frag)) {
            return *kind;
        }
    }
    for (port, kind) in PORT_KINDS {
        if ports.iter().any(|p| p.port == port || p.target_port == PortRef::Number(port)) {
            return kind;
        }
    }
    let web = ports.iter().any(|p| {
        matches!(p.port, 80 | 443 | 8080 | 8000 | 3000)
            || p.app_protocol.as_deref().is_some_and(|a| a.starts_with("http") || a == "kubernetes.io/h2c")
            || p.name.as_deref().is_some_and(|n| n.starts_with("http") || n == "web")
    });
    if web { ServiceKind::Http } else { ServiceKind::Unknown }
}

/// Container images of a pod.
fn images(pod: &Json) -> Vec<String> {
    pod_spec(pod)
        .and_then(|s| s.get("containers"))
        .and_then(Json::as_array)
        .map(|cs| cs.iter().filter_map(|c| c.get("image").and_then(Json::as_str).map(str::to_string)).collect())
        .unwrap_or_default()
}

/// `ClusterIP`, `NodePort`, `LoadBalancer`, `ExternalName`, or `Headless` (clusterIP None).
fn service_type(svc: &Json) -> String {
    if svc.pointer("/spec/clusterIP").and_then(Json::as_str) == Some("None") {
        return "Headless".into();
    }
    svc.pointer("/spec/type").and_then(Json::as_str).unwrap_or("ClusterIP").to_string()
}

/// Builds the info from the Service, its EndpointSlices and (optionally) one backing pod.
pub fn build(obj_ref: ObjRef, svc: &Json, slices: &Json, pod: Option<&Json>) -> ServiceInfo {
    let ports: Vec<ServicePort> = service_ports(svc)
        .into_iter()
        .map(|p| ServicePort { name: p.name, port: p.port, target_port: p.target, protocol: p.protocol, app_protocol: p.app_protocol })
        .collect();
    let selector = svc.pointer("/spec/selector").and_then(Json::as_object).map(|m| {
        m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect()
    });
    let (ready, not_ready, pods) = endpoint_counts(slices);
    let imgs = pod.map(images).unwrap_or_default();
    let kind = detect_kind(&ports, &imgs);
    let kafka_listeners = if kind == ServiceKind::Kafka { pod.and_then(kafka::listeners) } else { None };
    // k9scli.io/* annotations: the Service's own name Service ports; a backing pod's name container ports
    let mut hints = crate::forward::k9s_hints([svc.pointer("/metadata/annotations")]);
    if let Some(pod) = pod {
        let svc_ports = service_ports(svc);
        for h in crate::forward::hints_to_service(&crate::forward::k9s_hints([pod.pointer("/metadata/annotations")]), &svc_ports, pod_spec(pod)) {
            if !hints.iter().any(|x| x.remote_port == h.remote_port) {
                hints.push(h);
            }
        }
    }
    let hints = (!hints.is_empty()).then_some(hints);
    ServiceInfo { obj_ref, type_: service_type(svc), ports, selector, endpoints: Endpoints { ready, not_ready, pods }, kind, kafka_listeners, hints }
}

/// Ports, targetPorts, EndpointSlice readiness, detected kind and Kafka listeners.
pub async fn info(state: &AppState, context: &str, obj_ref: &ObjRef) -> Result<ServiceInfo> {
    let s = state.session(context).await?;
    let ns = obj_ref.ns();
    let svc = s.get(&api_path(&services_gvr(), ns, Some(&obj_ref.name))).await?;
    let slices = s
        .get(&with_query(&api_path(&slices_gvr(), ns, None), &[("labelSelector", &format!("kubernetes.io/service-name={}", obj_ref.name))]))
        .await?;
    let (_, _, pods) = endpoint_counts(&slices);
    // one backing pod tells the image and the broker env; a failure here only loses the kind
    let pod = match pods.first() {
        Some(p) => s.get(&api_path(&pods_gvr(), ns, Some(p))).await.ok(),
        None => None,
    };
    let mut r = obj_ref.clone();
    r.context = context.to_string();
    Ok(build(r, &svc, &slices, pod.as_ref()))
}

pub mod cmd {
    use super::AppState;
    use crate::ipc::{ObjRef, Result, ServiceInfo};

    #[tauri::command]
    pub async fn service_info(state: tauri::State<'_, AppState>, obj_ref: ObjRef) -> Result<ServiceInfo> {
        let context = obj_ref.context.clone();
        super::info(&state, &context, &obj_ref).await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::ipc::Gvr;

    fn port(port: u16, name: Option<&str>) -> ServicePort {
        ServicePort { name: name.map(str::to_string), port, target_port: PortRef::Number(port), protocol: "TCP".into(), app_protocol: None }
    }

    #[test]
    fn kinds_by_image_then_port() {
        let img = |s: &str| vec![s.to_string()];
        assert_eq!(detect_kind(&[port(80, None)], &img("docker.io/library/postgres:16")), ServiceKind::Postgres);
        assert_eq!(detect_kind(&[port(8080, None)], &img("provectuslabs/kafka-ui:v0.7")), ServiceKind::Http, "kafka-ui is not kafka");
        assert_eq!(detect_kind(&[port(8081, None)], &img("confluentinc/cp-schema-registry:7")), ServiceKind::SchemaRegistry);
        assert_eq!(detect_kind(&[port(9092, None)], &img("apache/kafka:4.1.0")), ServiceKind::Kafka);
        assert_eq!(detect_kind(&[port(9187, None)], &img("prometheuscommunity/postgres-exporter")), ServiceKind::Http);
        for (p, kind) in [
            (5432, ServiceKind::Postgres),
            (3306, ServiceKind::Mysql),
            (6379, ServiceKind::Redis),
            (11211, ServiceKind::Memcached),
            (9094, ServiceKind::Kafka),
            (8081, ServiceKind::SchemaRegistry),
            (27017, ServiceKind::Mongodb),
            (5672, ServiceKind::Rabbitmq),
        ] {
            assert_eq!(detect_kind(&[port(p, None)], &[]), kind, "{p}");
        }
        assert_eq!(detect_kind(&[port(80, None)], &[]), ServiceKind::Http);
        assert_eq!(detect_kind(&[port(7000, Some("http-api"))], &[]), ServiceKind::Http);
        assert_eq!(detect_kind(&[port(7000, Some("grpc"))], &[]), ServiceKind::Unknown);
    }

    #[test]
    fn build_from_api_json() {
        let svc = json!({ "spec": { "selector": { "app": "kafka" }, "ports": [
            { "name": "internal", "port": 9092, "targetPort": 9092 }, { "name": "local", "port": 9094, "targetPort": "local" }
        ] } });
        let slices = json!({ "items": [{ "ports": [{ "name": "local", "port": 9094 }], "endpoints": [
            { "targetRef": { "kind": "Pod", "name": "kafka-0" }, "conditions": { "ready": true } },
            { "targetRef": { "kind": "Pod", "name": "kafka-1" }, "conditions": { "ready": false } }
        ] }] });
        let pod = json!({ "kind": "Pod", "spec": { "containers": [{ "image": "apache/kafka:4.1.0", "env": [
            { "name": "KAFKA_ADVERTISED_LISTENERS", "value": "INTERNAL://kafka.kafka.svc.cluster.local:9092,LOCAL://localhost:9094" }
        ] }] } });
        let r = ObjRef { context: "default".into(), gvr: Gvr::new("", "v1", "services"), namespace: Some("kafka".into()), name: "kafka".into() };
        let info = build(r, &svc, &slices, Some(&pod));
        assert_eq!(info.type_, "ClusterIP");
        assert_eq!(info.kind, ServiceKind::Kafka);
        assert_eq!((info.endpoints.ready, info.endpoints.not_ready, info.endpoints.pods.clone()), (1, 1, vec!["kafka-0".to_string()]));
        assert_eq!(info.ports[1].target_port, PortRef::Name("local".into()));
        assert_eq!(info.kafka_listeners.as_ref().map(Vec::len), Some(2));
        assert_eq!(info.selector.unwrap()["app"], "kafka");
        let headless = build(info.obj_ref.clone(), &json!({ "spec": { "clusterIP": "None" } }), &json!({ "items": [] }), None);
        assert_eq!((headless.type_.as_str(), headless.kind, headless.endpoints.ready), ("Headless", ServiceKind::Unknown, 0));
    }
}
