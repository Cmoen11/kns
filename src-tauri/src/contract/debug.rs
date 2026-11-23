//! Debug containers, copies and exec snippets: mirror of `src/ipc/contract/debug.ts`. Owner F.
use serde::{Deserialize, Serialize};

use super::pack::RedactionReport;
use crate::ipc::ObjRef;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugRequest {
    #[serde(rename = "ref")]
    pub obj_ref: ObjRef,
    pub image: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DebugPodKind {
    Ephemeral,
    Copy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugPod {
    pub context: String,
    pub namespace: String,
    pub name: String,
    pub source: String,
    pub kind: DebugPodKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetRunRequest {
    #[serde(rename = "ref")]
    pub obj_ref: ObjRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetOutput {
    pub output: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub truncated: bool,
    pub millis: u64,
    pub redactions: RedactionReport,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{drift::Fixtures, fwd::fixtures::obj};

    #[test]
    fn drift() {
        let mut f = Fixtures::new("debug");
        f.add(
            "debugRequest",
            "DebugRequest",
            &DebugRequest { obj_ref: obj("pods", "default", "web-1"), image: "busybox:1.37".into(), target: Some("main".into()) },
        );
        f.add(
            "debugPods",
            "DebugPod[]",
            &vec![
                DebugPod {
                    context: "default".into(),
                    namespace: "default".into(),
                    name: "web-1".into(),
                    source: "web-1".into(),
                    kind: DebugPodKind::Ephemeral,
                    container: Some("kns-debug-abcde".into()),
                    created_at: "2026-11-22T10:00:00Z".into(),
                },
                DebugPod {
                    context: "default".into(),
                    namespace: "default".into(),
                    name: "crashy-debug-x1".into(),
                    source: "crashy".into(),
                    kind: DebugPodKind::Copy,
                    container: None,
                    created_at: "2026-11-22T10:00:00Z".into(),
                },
            ],
        );
        f.add(
            "snippetRunRequest",
            "SnippetRunRequest",
            &SnippetRunRequest {
                obj_ref: obj("pods", "default", "web-1"),
                container: Some("main".into()),
                command: "env | sort".into(),
                timeout_seconds: Some(30),
            },
        );
        f.add(
            "snippetOutputs",
            "SnippetOutput[]",
            &vec![
                SnippetOutput {
                    output: "HOME=/root\nPASSWORD=•••\n".into(),
                    exit_code: Some(0),
                    message: None,
                    truncated: false,
                    millis: 412,
                    redactions: RedactionReport { count: 1, by_rule: [("key".to_string(), 1)].into_iter().collect() },
                },
                SnippetOutput {
                    output: String::new(),
                    exit_code: None,
                    message: Some("timed out after 30s".into()),
                    truncated: true,
                    millis: 30000,
                    redactions: RedactionReport::default(),
                },
            ],
        );
        f.check();
    }
}
