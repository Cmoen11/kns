//! Namespace health: mirror of `src/ipc/contract/health.ts` (status-colors package).
//! Counts per namespace only; produced by `crate::nshealth`.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NsHealthState {
    Syncing,
    Live,
    Reconnecting,
    Partial,
    Forbidden,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkloadKind {
    Deployments,
    Statefulsets,
    Daemonsets,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadFaults {
    pub kind: WorkloadKind,
    pub down: u32,
    pub degraded: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NsHealth {
    pub namespace: String,
    pub pods_failing: u32,
    pub pods_warn: u32,
    pub workloads: Vec<WorkloadFaults>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NsHealthSnapshot {
    pub context: String,
    pub state: NsHealthState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub namespaces: Vec<NsHealth>,
    pub pods: u32,
    pub workloads: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::drift::Fixtures;

    #[test]
    fn drift() {
        let mut f = Fixtures::new("health");
        f.add(
            "snapshots",
            "NsHealthSnapshot[]",
            &vec![
                NsHealthSnapshot { context: "default".into(), state: NsHealthState::Syncing, message: None, namespaces: vec![], pods: 0, workloads: 0 },
                NsHealthSnapshot {
                    context: "default".into(),
                    state: NsHealthState::Live,
                    message: None,
                    namespaces: vec![NsHealth {
                        namespace: "kns-spike".into(),
                        pods_failing: 2,
                        pods_warn: 1,
                        workloads: vec![
                            WorkloadFaults { kind: WorkloadKind::Deployments, down: 1, degraded: 1 },
                            WorkloadFaults { kind: WorkloadKind::Statefulsets, down: 0, degraded: 1 },
                            WorkloadFaults { kind: WorkloadKind::Daemonsets, down: 1, degraded: 0 },
                        ],
                    }],
                    pods: 40,
                    workloads: 12,
                },
                NsHealthSnapshot { context: "default".into(), state: NsHealthState::Reconnecting, message: Some("watch: connection reset".into()), namespaces: vec![], pods: 3, workloads: 1 },
                NsHealthSnapshot { context: "default".into(), state: NsHealthState::Partial, message: Some("daemonsets: forbidden".into()), namespaces: vec![], pods: 3, workloads: 1 },
                NsHealthSnapshot { context: "default".into(), state: NsHealthState::Forbidden, message: Some("pods: forbidden".into()), namespaces: vec![], pods: 0, workloads: 0 },
                NsHealthSnapshot { context: "default".into(), state: NsHealthState::Error, message: Some("boom".into()), namespaces: vec![], pods: 0, workloads: 0 },
            ],
        );
        f.check();
    }
}
