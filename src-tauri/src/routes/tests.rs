//! The route builder: Ingress and HTTPRoute entries followed to Services, ports and endpoints.
use serde_json::json;

use super::*;

fn objects() -> Objects {
    let mut o = Objects::default();
    o.add_list(
        "services",
        &json!({"items": [
            {"metadata": {"namespace": "shop", "name": "api"}, "spec": {"selector": {"app": "api"}, "ports": [{"name": "http", "port": 80, "targetPort": 8080}]}},
            {"metadata": {"namespace": "shop", "name": "web"}, "spec": {"selector": {"app": "web"}, "ports": [{"port": 80, "targetPort": "http"}, {"name": "metrics", "port": 9090}]}},
            {"metadata": {"namespace": "shop", "name": "web-canary"}, "spec": {"selector": {"app": "web-canary"}, "ports": [{"port": 80}]}},
            {"metadata": {"namespace": "shop", "name": "legacy"}, "spec": {"type": "ExternalName", "externalName": "legacy.example.net"}},
            {"metadata": {"namespace": "shop", "name": "empty"}, "spec": {"selector": {"app": "gone"}, "ports": [{"port": 80}]}}
        ]}),
    );
    o.add_list(
        "endpointslices",
        &json!({"items": [
            {"metadata": {"namespace": "shop", "name": "api-x1", "labels": {"kubernetes.io/service-name": "api"}},
             "endpoints": [
                {"conditions": {"ready": true}, "targetRef": {"kind": "Pod", "name": "api-6d4f9-a"}},
                {"conditions": {}, "targetRef": {"kind": "Pod", "name": "api-6d4f9-b"}},
                {"conditions": {"ready": false}, "targetRef": {"kind": "Pod", "name": "api-6d4f9-c"}}
             ]},
            {"metadata": {"namespace": "shop", "name": "web-x1", "labels": {"kubernetes.io/service-name": "web"}},
             "endpoints": [{"conditions": {"ready": false}, "targetRef": {"kind": "Pod", "name": "web-0"}}]}
        ]}),
    );
    o.add_list(
        "pods",
        &json!({"items": [
            {"metadata": {"namespace": "shop", "name": "api-6d4f9-a", "labels": {"pod-template-hash": "6d4f9"}, "ownerReferences": [{"kind": "ReplicaSet", "name": "api-6d4f9", "controller": true}]}},
            {"metadata": {"namespace": "shop", "name": "api-6d4f9-b", "labels": {"pod-template-hash": "6d4f9"}, "ownerReferences": [{"kind": "ReplicaSet", "name": "api-6d4f9", "controller": true}]}},
            {"metadata": {"namespace": "shop", "name": "web-0", "ownerReferences": [{"kind": "StatefulSet", "name": "web", "controller": true}]}}
        ]}),
    );
    o
}

#[test]
fn follows_a_backend_to_its_endpoints() {
    let o = objects();
    let b = o.backend("shop", "api", Some("80".into()), None);
    assert_eq!((b.target_port.as_deref(), b.ready, b.total, b.workload.as_deref(), b.problem.as_deref()), (Some("8080"), 2, 3, Some("Deployment/api"), None));
    // a port by name, and a named targetPort
    assert_eq!(o.backend("shop", "api", Some("http".into()), None).target_port.as_deref(), Some("8080"));
    assert_eq!(o.backend("shop", "web", Some("80".into()), None).target_port.as_deref(), Some("http"));
    // a port without targetPort maps to itself
    assert_eq!(o.backend("shop", "web", Some("metrics".into()), None).target_port.as_deref(), Some("9090"));
}

#[test]
fn names_the_first_broken_link() {
    let o = objects();
    assert_eq!(o.backend("shop", "nope", Some("80".into()), None).problem.as_deref(), Some("Service nope not found"));
    assert_eq!(o.backend("shop", "api", Some("8080".into()), None).problem.as_deref(), Some("port 8080 is not a port of the Service"));
    assert_eq!(o.backend("shop", "web", None, None).problem.as_deref(), Some("no port given and the Service has several"));
    assert_eq!(o.backend("shop", "web", Some("80".into()), None).problem.as_deref(), Some("no ready endpoints (0/1)"));
    assert_eq!(o.backend("shop", "empty", Some("80".into()), None).problem.as_deref(), Some("the Service selects no running pods"));
    let ext = o.backend("shop", "legacy", None, None);
    assert_eq!((ext.external_name.as_deref(), ext.problem.as_deref()), (Some("legacy.example.net"), None));
}

#[test]
fn ingress_rules_tls_and_default_backend() {
    let o = objects();
    let ing = json!({
        "metadata": {"namespace": "shop", "name": "web", "annotations": {"kubernetes.io/ingress.class": "traefik"}},
        "spec": {
            "tls": [{"hosts": ["*.example.com"], "secretName": "wild"}],
            "rules": [
                {"host": "shop.example.com", "http": {"paths": [
                    {"path": "/api", "pathType": "Prefix", "backend": {"service": {"name": "api", "port": {"number": 80}}}},
                    {"pathType": "Prefix", "backend": {"service": {"name": "web", "port": {"name": "metrics"}}}}
                ]}},
                {"host": "other.test", "http": {"paths": [{"path": "/", "pathType": "Exact", "backend": {"resource": {"kind": "StorageBucket", "name": "static"}}}]}}
            ],
            "defaultBackend": {"service": {"name": "web-canary", "port": {"number": 80}}}
        },
        "status": {"loadBalancer": {"ingress": [{"ip": "203.0.113.10"}]}}
    });
    let e = ingress_entries(&o, &ing);
    assert_eq!(e.len(), 4);
    assert_eq!((e[0].host.as_str(), e[0].tls, e[0].path.as_str(), e[0].match_type.as_str()), ("shop.example.com", true, "/api", "Prefix"));
    assert_eq!((e[0].source.via.as_deref(), e[0].source.address.as_deref()), (Some("traefik"), Some("203.0.113.10")));
    assert_eq!(e[1].path, "/");
    assert!(!e[2].tls);
    assert_eq!(e[2].backends[0].problem.as_deref(), Some("a StorageBucket backend, not a Service"));
    assert_eq!((e[3].host.as_str(), e[3].match_type.as_str(), e[3].backends[0].service.as_str()), ("*", "default", "web-canary"));
}

#[test]
fn httproute_hosts_from_the_gateway_weights_and_filters() {
    let mut o = objects();
    o.add_list(
        "gateways",
        &json!({"items": [{
            "metadata": {"namespace": "infra", "name": "public"},
            "spec": {"listeners": [
                {"name": "http", "port": 80, "protocol": "HTTP", "hostname": "shop.example.com"},
                {"name": "https", "port": 443, "protocol": "HTTPS", "hostname": "shop.example.com"},
                {"name": "tcp", "port": 5432, "protocol": "TCP"}
            ]},
            "status": {"addresses": [{"type": "Hostname", "value": "lb-1.elb.example"}]}
        }]}),
    );
    let route = json!({
        "metadata": {"namespace": "shop", "name": "web"},
        "spec": {
            "parentRefs": [{"name": "public", "namespace": "infra"}],
            "rules": [
                {"matches": [{"path": {"type": "PathPrefix", "value": "/"}}],
                 "backendRefs": [{"name": "web", "port": 80, "weight": 90}, {"name": "web-canary", "port": 80, "weight": 10}]},
                {"matches": [{"path": {"type": "Exact", "value": "/beta"}, "headers": [{"name": "x-canary", "value": "1"}], "method": "GET"}],
                 "filters": [{"type": "URLRewrite", "urlRewrite": {"path": {"type": "ReplacePrefixMatch", "replacePrefixMatch": "/"}}}],
                 "backendRefs": [{"name": "api", "port": 80}]},
                {"matches": [{"path": {"value": "/old"}}],
                 "filters": [{"type": "RequestRedirect", "requestRedirect": {"scheme": "https", "statusCode": 301}}]}
            ]
        }
    });
    let e = httproute_entries(&o, &route);
    assert_eq!(e.len(), 3);
    assert_eq!((e[0].host.as_str(), e[0].tls), ("shop.example.com", true));
    assert_eq!((e[0].source.via.as_deref(), e[0].source.address.as_deref()), (Some("gateway infra/public"), Some("lb-1.elb.example")));
    assert_eq!(e[0].backends.iter().map(|b| b.weight).collect::<Vec<_>>(), vec![Some(90), Some(10)]);
    assert_eq!((e[1].match_type.as_str(), e[1].conditions.clone()), ("Exact", vec!["header x-canary: 1".to_string(), "method GET".to_string()]));
    assert_eq!(e[1].filters, vec!["rewrite prefix → /".to_string()]);
    assert_eq!(e[1].backends[0].weight, None);
    assert!(e[2].backends.is_empty());
    assert_eq!((e[2].match_type.as_str(), e[2].filters.clone()), ("Prefix", vec!["redirect → https (301)".to_string()]));
}

#[test]
fn httproute_own_hostnames_and_sorting() {
    let mut o = objects();
    o.add_list(
        "httproutes",
        &json!({"items": [{
            "metadata": {"namespace": "shop", "name": "api"},
            "spec": {"parentRefs": [{"name": "missing"}], "hostnames": ["b.test", "a.test"], "rules": [{"backendRefs": [{"name": "api", "port": 80}]}]}
        }]}),
    );
    o.add_list(
        "ingresses",
        &json!({"items": [{"metadata": {"namespace": "shop", "name": "any"}, "spec": {"rules": [{"http": {"paths": [{"path": "/z", "pathType": "Prefix", "backend": {"service": {"name": "api", "port": {"number": 80}}}}]}}]}}]}),
    );
    let e = build(&o);
    assert_eq!(e.iter().map(|x| (x.host.as_str(), x.path.as_str())).collect::<Vec<_>>(), vec![("a.test", "/"), ("b.test", "/"), ("*", "/z")]);
    // a Gateway that cannot be read still names the route's parent
    assert_eq!(e[0].source.via.as_deref(), Some("gateway shop/missing"));
}

#[test]
fn workload_of_pods() {
    assert_eq!(workload_of(&json!({"metadata": {"labels": {"pod-template-hash": "abc"}, "ownerReferences": [{"kind": "ReplicaSet", "name": "web-abc"}]}})).as_deref(), Some("Deployment/web"));
    assert_eq!(workload_of(&json!({"metadata": {"ownerReferences": [{"kind": "ReplicaSet", "name": "bare"}]}})).as_deref(), Some("ReplicaSet/bare"));
    assert_eq!(workload_of(&json!({"metadata": {}})), None);
}

#[test]
fn grpcroute_methods_headers_and_backends() {
    let mut o = objects();
    o.add_list(
        "gateways",
        &json!({"items": [{"metadata": {"namespace": "infra", "name": "public"}, "spec": {"listeners": [{"name": "https", "port": 443, "protocol": "HTTPS"}]}}]}),
    );
    o.add_list(
        "grpcroutes",
        &json!({"items": [{
            "metadata": {"namespace": "shop", "name": "orders"},
            "spec": {
                "parentRefs": [{"name": "public", "namespace": "infra"}],
                "hostnames": ["api.example.com"],
                "rules": [
                    {"matches": [{"method": {"service": "shop.v1.Orders"}}], "backendRefs": [{"name": "api", "port": 80}]},
                    {"matches": [{"method": {"service": "shop.v1.Orders", "method": "Cancel"}, "headers": [{"name": "x-tenant", "value": "acme"}]}],
                     "backendRefs": [{"name": "nope", "port": 9090}]},
                    {"matches": [{"method": {"type": "RegularExpression", "service": "grpc\\.health.*"}}], "backendRefs": [{"name": "api", "port": "http"}]},
                    {"backendRefs": [{"name": "api", "port": 80}]}
                ]
            }
        }]}),
    );
    let e = build(&o);
    let got: Vec<_> = e.iter().map(|x| (x.source.kind.as_str(), x.match_type.as_str(), x.path.as_str(), x.tls)).collect();
    assert_eq!(
        got,
        vec![
            ("GRPCRoute", "gRPC", "*", true),
            ("GRPCRoute", "RegularExpression", "grpc\\.health.*/*", true),
            ("GRPCRoute", "gRPC", "shop.v1.Orders/*", true),
            ("GRPCRoute", "gRPC", "shop.v1.Orders/Cancel", true),
        ]
    );
    let cancel = &e[3];
    assert_eq!(cancel.conditions, vec!["header x-tenant: acme".to_string()]);
    assert_eq!(cancel.backends[0].problem.as_deref(), Some("Service nope not found"));
    assert_eq!((e[2].backends[0].ready, e[2].backends[0].target_port.as_deref()), (2, Some("8080")));
    assert_eq!(e[0].source.via.as_deref(), Some("gateway infra/public"));
}
