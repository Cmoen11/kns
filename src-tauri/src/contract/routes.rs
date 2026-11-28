//! HTTP routes: mirror of `src/ipc/contract/routes.ts`. Every way into the cluster over HTTP that
//! Ingresses and Gateway API HTTPRoutes describe, one entry per host and path match, each with the
//! Services it ends at and how many of their endpoints are ready. Produced by `crate::routes`.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutesRequest {
    pub context: String,
    /// one namespace; none: every namespace
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    /// where to look when listing across namespaces is forbidden (a team's namespaces)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub namespaces: Vec<String>,
}

/// The object that declares a route.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteSource {
    /// `Ingress` or `HTTPRoute`
    pub kind: String,
    pub namespace: String,
    pub name: String,
    /// what serves it: the IngressClass (`nginx`) or the Gateway (`gateway infra/public`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    /// the address clients reach it at (load balancer IP or hostname), from the object's status
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
}

/// Where one route ends: a Service port, and what is behind it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteBackend {
    pub namespace: String,
    pub service: String,
    /// the Service port as the route names it: a number or a port name
    pub port: String,
    /// the container port it maps to (`targetPort`), when the Service has the port
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_port: Option<String>,
    /// share of the requests in percent, when a rule splits between backends
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<u32>,
    /// the workload of the endpoints' pods as `Kind/name` (Deployment/web)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workload: Option<String>,
    /// an ExternalName Service: the DNS name it points at
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_name: Option<String>,
    pub ready: u32,
    pub total: u32,
    /// the first broken link: Service missing, port not on the Service, no ready endpoints
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

/// One host and path match of an Ingress rule or HTTPRoute rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteEntry {
    pub source: RouteSource,
    /// the host header it matches; `*` for any
    pub host: String,
    /// served over TLS (an Ingress tls entry for the host, an HTTPS listener of the Gateway)
    pub tls: bool,
    pub path: String,
    /// `Prefix`, `Exact`, `RegularExpression`, `ImplementationSpecific`, or `default` (an Ingress default backend)
    pub match_type: String,
    /// further conditions of an HTTPRoute match: `header x-canary: 1`, `method POST`, `query v=2`
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conditions: Vec<String>,
    /// what the route does on the way: `redirect → https:443 (301)`, `rewrite path → /`
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filters: Vec<String>,
    /// empty for a rule that only redirects
    pub backends: Vec<RouteBackend>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteMap {
    pub entries: Vec<RouteEntry>,
    /// what could not be read (forbidden lists, Gateway API not installed, a cap)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
    /// RFC 3339
    pub at: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::drift::Fixtures;

    #[test]
    fn drift() {
        let mut f = Fixtures::new("routes");
        f.add(
            "requests",
            "RoutesRequest[]",
            &vec![
                RoutesRequest { context: "default".into(), namespace: None, namespaces: vec![] },
                RoutesRequest { context: "team-test".into(), namespace: Some("shop".into()), namespaces: vec!["shop".into(), "payments".into()] },
            ],
        );
        let ing = RouteSource { kind: "Ingress".into(), namespace: "shop".into(), name: "web".into(), via: Some("nginx".into()), address: Some("203.0.113.10".into()) };
        f.add(
            "map",
            "RouteMap",
            &RouteMap {
                entries: vec![
                    RouteEntry {
                        source: ing.clone(),
                        host: "shop.example.com".into(),
                        tls: true,
                        path: "/api".into(),
                        match_type: "Prefix".into(),
                        conditions: vec![],
                        filters: vec![],
                        backends: vec![RouteBackend { namespace: "shop".into(), service: "api".into(), port: "80".into(), target_port: Some("8080".into()), weight: None, workload: Some("Deployment/api".into()), external_name: None, ready: 3, total: 3, problem: None }],
                    },
                    RouteEntry {
                        source: RouteSource { kind: "HTTPRoute".into(), namespace: "shop".into(), name: "checkout".into(), via: Some("gateway infra/public".into()), address: None },
                        host: "*".into(),
                        tls: false,
                        path: "/checkout".into(),
                        match_type: "Exact".into(),
                        conditions: vec!["header x-canary: 1".into()],
                        filters: vec!["rewrite path → /".into()],
                        backends: vec![
                            RouteBackend { namespace: "shop".into(), service: "checkout".into(), port: "http".into(), target_port: None, weight: Some(90), workload: None, external_name: None, ready: 0, total: 0, problem: Some("Service not found".into()) },
                            RouteBackend { namespace: "shop".into(), service: "legacy".into(), port: "80".into(), target_port: Some("80".into()), weight: Some(10), workload: None, external_name: Some("legacy.example.net".into()), ready: 0, total: 0, problem: None },
                        ],
                    },
                    RouteEntry { source: ing, host: "*".into(), tls: false, path: "/".into(), match_type: "default".into(), conditions: vec![], filters: vec!["redirect → https (301)".into()], backends: vec![] },
                ],
                notes: vec!["httproutes: Gateway API is not installed".into()],
                at: "2026-11-28T10:00:00Z".into(),
            },
        );
        f.check();
    }
}
