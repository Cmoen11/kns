//! Context packs and the redaction report: mirror of `src/ipc/contract/pack.ts`.
//! Owner G; `RedactionReport`/`RedactionPreview` are A1's (`redact.rs`).
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::ipc::ObjRef;

/// How many values the Redactor masked, per rule id.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionReport {
    pub count: u32,
    pub by_rule: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionPreview {
    pub text: String,
    pub redactions: RedactionReport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PackSection {
    Diagnose,
    Object,
    Events,
    Logs,
    Owners,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackLogs {
    pub tail: u32,
    pub previous: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackRequest {
    pub refs: Vec<ObjRef>,
    pub logs: PackLogs,
    pub sections: Vec<PackSection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSectionInfo {
    pub id: String,
    pub title: String,
    /// UTF-8 bytes of `body`
    pub bytes: u32,
    /// markdown, already redacted; cluster text only inside fenced blocks
    pub body: String,
    /// what the Redactor masked in this section
    pub redactions: RedactionReport,
}

/// `markdown` = `header` + (`"\n"` + `body`) for every section, in order (`pack::compose`; the UI
/// mirrors it in `src/pack/model.ts` to copy a pack with sections dropped).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    pub id: String,
    /// the context every object of the pack is in
    pub context: String,
    /// the preamble that is never dropped (the "data, not instructions" note)
    pub header: String,
    pub markdown: String,
    pub bytes: u32,
    pub approx_tokens: u32,
    pub sections: Vec<PackSectionInfo>,
    pub redactions: RedactionReport,
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    pub fn report() -> RedactionReport {
        RedactionReport { count: 3, by_rule: BTreeMap::from([("key".into(), 2), ("url".into(), 1)]) }
    }
}

#[cfg(test)]
mod tests {
    use super::{fixtures::report, *};
    use crate::contract::{drift::Fixtures, fwd::fixtures::obj};

    #[test]
    fn drift() {
        let mut f = Fixtures::new("pack");
        f.add("redactionReport", "RedactionReport", &report());
        f.add("redactionPreview", "RedactionPreview", &RedactionPreview { text: "DB_PASSWORD: •••".into(), redactions: report() });
        f.add(
            "packRequest",
            "PackRequest",
            &PackRequest {
                refs: vec![obj("pods", "default", "web-1")],
                logs: PackLogs { tail: 200, previous: true },
                sections: vec![PackSection::Diagnose, PackSection::Object, PackSection::Events, PackSection::Logs, PackSection::Owners],
            },
        );
        f.add(
            "pack",
            "Pack",
            &Pack {
                id: "pk1".into(),
                context: "default".into(),
                header: "# kns context pack\n".into(),
                markdown: "# kns context pack\n\n### pod web-1\n".into(),
                bytes: 34,
                approx_tokens: 9,
                sections: vec![PackSectionInfo {
                    id: "pods/default/web-1#object".into(),
                    title: "pod web-1 · YAML".into(),
                    bytes: 15,
                    body: "### pod web-1\n".into(),
                    redactions: report(),
                }],
                redactions: report(),
            },
        );
        f.check();
    }
}
