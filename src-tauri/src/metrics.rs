//! Pod and node usage from `metrics.k8s.io`. A cluster without metrics yields empty lists.
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use serde::Deserialize;

use crate::{
    ipc::{BackendError, Gvr, Json, NodeMetric, PodMetric, Result, take_array},
    session::{Allocatable, JSON, Session, api_path},
    state::{AppState, lock},
};

const GROUP: &str = "metrics.k8s.io";
/// Node allocatable hardly ever changes, and a Node object is tens of KiB (image list).
const ALLOCATABLE_TTL: Duration = Duration::from_secs(60);

/// Parses a Kubernetes quantity ("250m", "1.5Gi", "12345n", "1e3") into its base unit.
pub fn parse_quantity(q: &str) -> Option<f64> {
    let q = q.trim();
    if let Ok(v) = q.parse::<f64>() {
        return Some(v);
    }
    let split = q.find(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | '+' | '-')))?;
    let (number, suffix) = q.split_at(split);
    let factor = match suffix {
        "n" => 1e-9,
        "u" => 1e-6,
        "m" => 1e-3,
        "k" => 1e3,
        "M" => 1e6,
        "G" => 1e9,
        "T" => 1e12,
        "P" => 1e15,
        "E" => 1e18,
        "Ki" => 1024f64,
        "Mi" => 1024f64.powi(2),
        "Gi" => 1024f64.powi(3),
        "Ti" => 1024f64.powi(4),
        "Pi" => 1024f64.powi(5),
        "Ei" => 1024f64.powi(6),
        _ => return None,
    };
    Some(number.parse::<f64>().ok()? * factor)
}

fn cpu_milli(v: &Json) -> i64 {
    v.as_str().and_then(parse_quantity).map(|c| (c * 1000.0).round() as i64).unwrap_or(0)
}

fn mem_bytes(v: &Json) -> i64 {
    v.as_str().and_then(parse_quantity).map(|b| b.round() as i64).unwrap_or(0)
}

/// Items of a metrics list, or nothing when the metrics API is not served or not answering.
async fn metrics_items(session: &Session, resource: &str, namespace: Option<&str>) -> Result<Vec<Json>> {
    if !session.discovery(None).await?.has_group(GROUP) {
        return Ok(Vec::new());
    }
    match session.get(&api_path(&Gvr::new(GROUP, "v1beta1", resource), namespace, None)).await {
        Ok(mut list) => Ok(take_array(&mut list, "items")),
        Err(BackendError { code: 404 | 503, .. }) => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

fn text(v: &Json) -> String {
    v.as_str().unwrap_or_default().to_string()
}

pub async fn pod_metrics(state: &AppState, context: &str, namespace: Option<&str>) -> Result<Vec<PodMetric>> {
    let session = state.session(context).await?;
    let items = metrics_items(&session, "pods", namespace).await?;
    let list: Vec<PodMetric> = items
        .iter()
        .map(|pod| {
            let containers = pod["containers"].as_array().map(Vec::as_slice).unwrap_or_default();
            PodMetric {
                namespace: text(&pod["metadata"]["namespace"]),
                name: text(&pod["metadata"]["name"]),
                cpu_milli: containers.iter().map(|c| cpu_milli(&c["usage"]["cpu"])).sum(),
                mem_bytes: containers.iter().map(|c| mem_bytes(&c["usage"]["memory"])).sum(),
            }
        })
        .collect();
    // sparklines (C2): the history ring is fed from this path only
    crate::history::record(state, context, &list);
    Ok(list)
}

/// The parts of a Node list that `allocatable` needs; the rest is skipped unparsed.
#[derive(Default, Deserialize)]
#[serde(default)]
struct Nodes {
    items: Vec<Node>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Node {
    metadata: NodeMeta,
    status: NodeStatus,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct NodeMeta {
    name: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct NodeStatus {
    allocatable: Json,
}

/// Allocatable (cpu milli, memory bytes) per node name, cached for `ALLOCATABLE_TTL`.
async fn allocatable(session: &Session) -> Result<Allocatable> {
    if let Some((at, cached)) = lock(&session.allocatable).as_ref()
        && at.elapsed() < ALLOCATABLE_TTL
    {
        return Ok(cached.clone());
    }
    let nodes: Nodes = session.get_as(&api_path(&Gvr::new("", "v1", "nodes"), None, None), JSON).await?;
    let fresh: HashMap<_, _> = nodes
        .items
        .into_iter()
        .map(|n| {
            let alloc = &n.status.allocatable;
            (n.metadata.name, (cpu_milli(&alloc["cpu"]), mem_bytes(&alloc["memory"])))
        })
        .collect();
    let fresh = Arc::new(fresh);
    *lock(&session.allocatable) = Some((Instant::now(), fresh.clone()));
    Ok(fresh)
}

pub async fn node_metrics(state: &AppState, context: &str) -> Result<Vec<NodeMetric>> {
    let session = state.session(context).await?;
    let items = metrics_items(&session, "nodes", None).await?;
    if items.is_empty() {
        return Ok(Vec::new());
    }
    let allocatable = allocatable(&session).await?;
    Ok(items
        .iter()
        .map(|node| {
            let name = text(&node["metadata"]["name"]);
            let (cpu_alloc_milli, mem_alloc_bytes) = allocatable.get(&name).copied().unwrap_or_default();
            NodeMetric {
                cpu_milli: cpu_milli(&node["usage"]["cpu"]),
                mem_bytes: mem_bytes(&node["usage"]["memory"]),
                cpu_alloc_milli,
                mem_alloc_bytes,
                name,
            }
        })
        .collect())
}

pub mod cmd {
    use super::AppState;
    use crate::ipc::{NodeMetric, PodMetric, Result};

    #[tauri::command]
    pub async fn pod_metrics(
        state: tauri::State<'_, AppState>,
        context: String,
        namespace: Option<String>,
    ) -> Result<Vec<PodMetric>> {
        super::pod_metrics(&state, &context, namespace.as_deref()).await
    }

    #[tauri::command]
    pub async fn node_metrics(state: tauri::State<'_, AppState>, context: String) -> Result<Vec<NodeMetric>> {
        super::node_metrics(&state, &context).await
    }
}

#[cfg(test)]
mod tests {
    use super::parse_quantity;

    #[test]
    fn quantities() {
        let close = |q: &str, want: f64| {
            let got = parse_quantity(q).unwrap_or(f64::NAN);
            assert!((got - want).abs() <= want.abs() * 1e-12, "{q}: {got} != {want}");
        };
        close("250m", 0.25);
        close("12345678n", 0.012345678);
        close("500u", 0.0005);
        close("2", 2.0);
        close("1.5Gi", 1.5 * 1024.0 * 1024.0 * 1024.0);
        close("128Mi", 128.0 * 1024.0 * 1024.0);
        close("4039792Ki", 4039792.0 * 1024.0);
        close("1k", 1000.0);
        close("1e3", 1000.0);
        close("2E", 2e18);
        assert_eq!(parse_quantity("abc"), None);
        assert_eq!(parse_quantity("1Zi"), None);
    }
}
