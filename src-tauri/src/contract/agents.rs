//! Agents: mirror of `src/ipc/contract/agents.ts` (docs/plan-features.md §2.6, §5).
//! Written by A1; owner H.
use serde::{Deserialize, Serialize};

use crate::ipc::{BackendError, Gvr, Json, ObjRef};

use super::{
    dev::{DevSet, EnvFormat, EnvSpec, Rewrite},
    fwd::{ForwardTarget, PortRef},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneInfo {
    pub kind: String,
    pub title: String,
}

/// What the human is looking at (MCP `get_selection`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane: Option<PaneInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<ObjRef>,
    #[serde(default)]
    pub marked: Vec<ObjRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    /// contexts the human connected in this session (agents may use only these, §5.4)
    #[serde(default)]
    pub connected: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEnv {
    pub format: EnvFormat,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyParsed {
    pub gvr: Gvr,
    pub namespace: String,
    pub name: String,
    /// `"ok"` or the server's dry-run error message
    pub dry_run: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ProposalPayload {
    DevSetUp {
        dev_set: String,
        hash: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        export_env: Option<ExportEnv>,
    },
    Forward {
        context: String,
        target: ForwardTarget,
        remote_port: PortRef,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        local_port: Option<u16>,
    },
    EnvExport {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dev_set: Option<String>,
        spec: EnvSpec,
        rewrites: Vec<Rewrite>,
    },
    DevSetDelete {
        dev_set: String,
    },
    DevSetUpdate {
        dev_set: String,
        proposed: Box<DevSet>,
    },
    Scale {
        #[serde(rename = "ref")]
        obj_ref: ObjRef,
        replicas: u32,
    },
    Restart {
        #[serde(rename = "ref")]
        obj_ref: ObjRef,
    },
    Delete {
        #[serde(rename = "ref")]
        obj_ref: ObjRef,
    },
    Reconcile {
        #[serde(rename = "ref")]
        obj_ref: ObjRef,
        with_source: bool,
    },
    Apply {
        context: String,
        yaml: String,
        parsed: ApplyParsed,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProposalState {
    Pending,
    Reviewing,
    Executing,
    Approved,
    Rejected,
    Expired,
    Failed,
    Cancelled,
}

impl ProposalState {
    /// No further transition is possible.
    pub fn is_final(self) -> bool {
        matches!(self, Self::Approved | Self::Rejected | Self::Expired | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "by", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChoiceOwner {
    User,
    Agent { idle_stop_minutes: u32 },
}

/// What the human decided in the dialog. Rust stores it on the proposal; commands read it from
/// the gate ticket, never from their own arguments.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalChoices {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<ChoiceOwner>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_secrets: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typed: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shown_hash: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<BackendError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Json>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub client: String,
    pub context: String,
    pub created_at: String,
    pub expires_at: String,
    pub state: ProposalState,
    /// agent-written, untrusted, cleaned, max 500 chars
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub payload: ProposalPayload,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<ProposalResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
}

/// `{kind: "rejected", reason?}` | `{kind: "done", ok: true}` | `{kind: "done", ok: false, error}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProposalResolution {
    Rejected {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Done {
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<BackendError>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpPolicy {
    Off,
    Read,
    Propose,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClient {
    pub name: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    pub connected: bool,
    pub calls: u64,
    pub bytes: u64,
    pub redactions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    pub title: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub on: bool,
    pub port: u16,
    pub clients: Vec<McpClient>,
    pub tools: Vec<McpTool>,
    /// stored policy per context (contexts without an entry are `off`)
    #[serde(default)]
    pub policies: Vec<McpContextPolicy>,
    /// why the server is not running although it was turned on (port taken, ...)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpContextPolicy {
    pub context: String,
    pub policy: McpPolicy,
    /// namespace allowlist; absent = every namespace
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespaces: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuditOutcome {
    Ok,
    Error,
    Denied,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditRow {
    pub ts: String,
    pub client: String,
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Json>,
    pub result_bytes: u64,
    pub redactions: u32,
    pub outcome: AuditOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_id: Option<String>,
    pub ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShowView {
    Describe,
    Yaml,
    Logs,
    Why,
    Timeline,
    Devset,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentShowView {
    pub view: ShowView,
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub obj_ref: Option<ObjRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_set: Option<String>,
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use crate::contract::{
        dev::fixtures::{dev_set, env_spec, rewrite},
        fwd::fixtures::{obj, service},
    };

    pub fn payloads() -> Vec<ProposalPayload> {
        let deploy = obj("deployments", "default", "web");
        vec![
            ProposalPayload::DevSetUp { dev_set: "ds1".into(), hash: "bb".into(), export_env: Some(ExportEnv { format: EnvFormat::Dotenv }) },
            ProposalPayload::Forward { context: "default".into(), target: service(), remote_port: PortRef::Number(9094), local_port: Some(9094) },
            ProposalPayload::EnvExport { dev_set: None, spec: env_spec(), rewrites: vec![rewrite()] },
            ProposalPayload::DevSetDelete { dev_set: "ds1".into() },
            ProposalPayload::DevSetUpdate { dev_set: "ds1".into(), proposed: Box::new(dev_set()) },
            ProposalPayload::Scale { obj_ref: deploy.clone(), replicas: 2 },
            ProposalPayload::Restart { obj_ref: deploy.clone() },
            ProposalPayload::Delete { obj_ref: deploy.clone() },
            ProposalPayload::Reconcile { obj_ref: deploy.clone(), with_source: true },
            ProposalPayload::Apply {
                context: "default".into(),
                yaml: "apiVersion: v1\nkind: ConfigMap\n".into(),
                parsed: ApplyParsed { gvr: Gvr::new("", "v1", "configmaps"), namespace: "default".into(), name: "x".into(), dry_run: "ok".into() },
            },
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::{fixtures::payloads, *};
    use crate::contract::{drift::Fixtures, fwd::fixtures::obj};

    #[test]
    fn drift() {
        let pod = obj("pods", "default", "web-1");
        let mut f = Fixtures::new("agents");
        f.add(
            "uiState",
            "UiState",
            &UiState {
                context: Some("default".into()),
                pane: Some(PaneInfo { kind: "table".into(), title: "pods".into() }),
                cursor: Some(pod.clone()),
                marked: vec![pod.clone()],
                filter: Some("web".into()),
                namespace: Some("default".into()),
                connected: vec!["default".into()],
            },
        );
        f.add("payloads", "ProposalPayload[]", &payloads());
        f.add(
            "proposalStates",
            "ProposalState[]",
            &vec![
                ProposalState::Pending,
                ProposalState::Reviewing,
                ProposalState::Executing,
                ProposalState::Approved,
                ProposalState::Rejected,
                ProposalState::Expired,
                ProposalState::Failed,
                ProposalState::Cancelled,
            ],
        );
        f.add(
            "approvalChoices",
            "ApprovalChoices[]",
            &vec![
                ApprovalChoices {
                    owner: Some(ChoiceOwner::User),
                    include_secrets: Some(vec!["DATABASE_URL".into()]),
                    typed: Some("orders".into()),
                    shown_hash: Some("bb".into()),
                },
                ApprovalChoices { owner: Some(ChoiceOwner::Agent { idle_stop_minutes: 15 }), ..Default::default() },
            ],
        );
        f.add(
            "proposal",
            "Proposal",
            &Proposal {
                id: "p1".into(),
                client: "claude-code".into(),
                context: "default".into(),
                created_at: "2026-11-22T10:00:00Z".into(),
                expires_at: "2026-11-22T10:10:00Z".into(),
                state: ProposalState::Failed,
                reason: Some("forwards for running orders locally".into()),
                payload: payloads().remove(0),
                result: Some(ProposalResult {
                    message: Some("up failed".into()),
                    error: Some(BackendError::new(0, "AddrInUse", "port 9094 is in use")),
                    data: Some(serde_json::json!({ "forwards": [{ "key": "kafka", "localPort": 9094 }] })),
                }),
                resolved_at: Some("2026-11-22T10:01:00Z".into()),
            },
        );
        f.add(
            "resolutions",
            "ProposalResolution[]",
            &vec![
                ProposalResolution::Rejected { reason: Some("not now".into()) },
                ProposalResolution::Done { ok: true, error: None },
                ProposalResolution::Done { ok: false, error: Some(BackendError::new(403, "Forbidden", "no")) },
            ],
        );
        f.add("policies", "McpPolicy[]", &vec![McpPolicy::Off, McpPolicy::Read, McpPolicy::Propose]);
        f.add(
            "mcpStatus",
            "McpStatus",
            &McpStatus {
                on: true,
                port: 7099,
                clients: vec![McpClient {
                    name: "claude-code".into(),
                    created_at: "2026-11-22T10:00:00Z".into(),
                    last_used_at: Some("2026-11-22T10:01:00Z".into()),
                    connected: true,
                    calls: 3,
                    bytes: 2048,
                    redactions: 1,
                }],
                tools: vec![McpTool { name: "get_status".into(), title: "Status".into(), description: "Start here.".into() }],
                policies: vec![
                    McpContextPolicy { context: "default".into(), policy: McpPolicy::Propose, namespaces: None },
                    McpContextPolicy { context: "staging".into(), policy: McpPolicy::Read, namespaces: Some(vec!["kns-spike".into()]) },
                ],
                error: Some("port 7099 is in use".into()),
            },
        );
        f.add(
            "auditRows",
            "AuditRow[]",
            &[AuditOutcome::Ok, AuditOutcome::Error, AuditOutcome::Denied]
                .into_iter()
                .map(|outcome| AuditRow {
                    ts: "2026-11-22T10:00:00Z".into(),
                    client: "claude-code".into(),
                    tool: "get_logs".into(),
                    args: Some(serde_json::json!({ "tail": 100 })),
                    result_bytes: 512,
                    redactions: 0,
                    outcome,
                    proposal_id: None,
                    ms: 12,
                })
                .collect::<Vec<_>>(),
        );
        f.add(
            "showViews",
            "AgentShowView[]",
            &[ShowView::Describe, ShowView::Yaml, ShowView::Logs, ShowView::Why, ShowView::Timeline, ShowView::Devset]
                .into_iter()
                .map(|view| AgentShowView { view, obj_ref: Some(pod.clone()), dev_set: None })
                .collect::<Vec<_>>(),
        );
        f.check();
    }
}
