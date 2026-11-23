//! Dev sets and env: mirror of `src/ipc/contract/dev.ts` (docs/plan-features.md §2.5, §3 B-dev).
//! Written by A1; owner B-dev.
use serde::{Deserialize, Serialize};

use crate::ipc::{Gvr, ObjRef};

use super::{
    fwd::{ForwardTarget, PortRef, ServiceKind},
    pack::RedactionReport,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevForward {
    pub key: String,
    pub target: ForwardTarget,
    pub remote_port: PortRef,
    pub local_port: u16,
    pub pin: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteMatch {
    pub service: String,
    pub namespace: String,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteTo {
    pub forward: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rewrite {
    pub r#match: RewriteMatch,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_key: Option<String>,
    pub to: RewriteTo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvOverride {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EnvFormat {
    Dotenv,
    Powershell,
    Posix,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workload {
    pub gvr: Gvr,
    pub namespace: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvSpec {
    pub workload: Workload,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exclude: Option<Vec<String>>,
    /// Secret-sourced keys the human ticked; agents cannot set this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_secrets: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overrides: Option<Vec<EnvOverride>>,
    pub format: EnvFormat,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "by", rename_all = "camelCase")]
pub enum DevSetOrigin {
    User,
    Agent { client: String, at: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretKeyRef {
    pub namespace: String,
    pub name: String,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnSecret {
    pub forward: String,
    pub secret: SecretKeyRef,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevSet {
    pub id: String,
    pub name: String,
    pub context: String,
    pub forwards: Vec<DevForward>,
    pub rewrites: Vec<Rewrite>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<EnvSpec>,
    pub auto_start: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conn_secrets: Option<Vec<ConnSecret>>,
    pub origin: DevSetOrigin,
    pub hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_hash: Option<String>,
    /// Always stored without its own `approvedSnapshot`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_snapshot: Option<Box<DevSet>>,
    pub updated_at: String,
}

/// What the UI sends to `dev_set_save`; Rust sets id (when new), origin, hash, approval, updatedAt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevSetDraft {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    pub context: String,
    pub forwards: Vec<DevForward>,
    pub rewrites: Vec<Rewrite>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<EnvSpec>,
    pub auto_start: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conn_secrets: Option<Vec<ConnSecret>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevSetSaved {
    pub set: DevSet,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub service: String,
    pub namespace: String,
    pub port: u16,
    /// `[start, end)` in the value; absent for secret-sourced values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span: Option<(usize, usize)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EnvSource {
    Literal,
    ConfigMap,
    Secret,
    Field,
    ResourceField,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvRow {
    pub key: String,
    pub source: EnvSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// literal/configMap only, redacted
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub masked: bool,
    pub hits: Vec<Hit>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    pub service: ObjRef,
    pub port: u16,
    pub kind: ServiceKind,
    pub ready: bool,
    pub suggested_forward: DevForward,
    pub suggested_rewrite: Rewrite,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvReport {
    /// the container the rows are of
    pub container: String,
    /// every container of the pod template (the view offers to switch)
    pub containers: Vec<String>,
    pub rows: Vec<EnvRow>,
    pub deps: Vec<Dependency>,
    pub warnings: Vec<String>,
    /// suggested literal overrides for side effects (consumer groups, migrations)
    pub overrides: Vec<EnvOverride>,
    pub redactions: RedactionReport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportDestination {
    File,
    Clipboard,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvExportRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_set: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<EnvSpec>,
    pub rewrites: Vec<Rewrite>,
    pub destination: ExportDestination,
    /// the context of `spec` when there is no dev set
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// the forwards the rewrites point at when there is no saved set (the env view before `s`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forwards: Option<Vec<DevForward>>,
    /// clipboard: clear after this many seconds (setting `clipboardClearSeconds`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear_seconds: Option<u32>,
    /// a human confirmed writing to the path Rust asked about (`EnvExportResult.confirm`); never with a proposal
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_token: Option<String>,
    /// the text the human typed: with `confirmToken` the answer to `ExportConfirm.typeToConfirm`;
    /// on the first request of a protected context the workload name from the export dialog
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_id: Option<String>,
}

/// Rust holds the chosen path and the text; the human must confirm (tier 2) to write it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportConfirm {
    pub token: String,
    pub path: String,
    pub reason: String,
    /// what the human types to confirm (the workload name); the request repeats it as `confirmText`
    /// and Rust compares, so the typed confirmation is not a UI-only guard
    pub type_to_confirm: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvExportResult {
    pub keys: u32,
    pub secret_keys: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    /// clipboard: when it clears, and whether the history / cloud exclusion was set
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear_seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_excluded: Option<bool>,
    /// the path is not git-ignored inside a work tree: nothing was written yet
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm: Option<ExportConfirm>,
    /// e.g. the path is in a cloud-synced folder
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

// ───────────────────────── B2: connection strings, volumes ─────────────────────────

/// A Secret's key names (never values) and type, for the connection-string picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretKeys {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub keys: Vec<String>,
}

/// Where a remembered pick lives: the dev set's `connSecrets`, or this forward until it stops.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnMemory {
    Set,
    Forward,
}

/// What `C` knows about a forward before copying: its kind, the plain URL and a remembered pick.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnInfo {
    pub forward: String,
    pub kind: ServiceKind,
    /// the connection string without credentials (`postgres://localhost:15432/`)
    pub plain: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remembered: Option<SecretKeyRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<ConnMemory>,
    /// the forward belongs to this dev set; a pick can be stored in it only while it is approved
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_set: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_set_approved: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnCopyRequest {
    pub forward: String,
    /// no credentials, even when a pick is remembered
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plain: Option<bool>,
    /// the Secret key the human picked now; absent = the remembered one (or none)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<SecretKeyRef>,
    /// keep `secret` (in the dev set when the forward is in an approved human set, else for this forward)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remember: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear_seconds: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnCopyResult {
    /// what was copied, with the secret part masked and run through the redactor
    pub preview: String,
    /// Rust wrote the clipboard (with a secret); false: `text` is plain and the UI copies it
    pub copied: bool,
    /// only without a secret
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<SecretKeyRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear_seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_excluded: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remembered: Option<ConnMemory>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VolumeSource {
    ConfigMap,
    Secret,
}

/// A ConfigMap or Secret a container mounts (a projected volume lists one per source).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    /// unique: the volume name, `<volume>/<object>` for a projected source
    pub id: String,
    pub source: VolumeSource,
    /// the ConfigMap / Secret name
    pub object: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mount_path: Option<String>,
    /// file paths relative to the volume (`items` applied); empty when unreadable
    pub files: Vec<String>,
    pub readable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeReport {
    pub container: String,
    pub containers: Vec<String>,
    pub volumes: Vec<VolumeInfo>,
}

/// Humans only (no `proposalId`): the chosen volumes' files go to `<folder>/<volume id>/<path>`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumesExportRequest {
    #[serde(rename = "ref")]
    pub obj_ref: ObjRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    pub volumes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_token: Option<String>,
    /// the text the human typed: with `confirmToken` the answer to `ExportConfirm.typeToConfirm`;
    /// on the first request of a protected context the workload name from the export dialog
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_text: Option<String>,
}

/// A dev set that failed to come up by itself (`autoStart` after connect). Kept in Rust until the
/// set comes up or the human clears it, so a reload still shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevSetFailure {
    pub dev_set: String,
    pub name: String,
    pub context: String,
    pub message: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumesExportResult {
    pub files: u32,
    pub secret_files: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    /// a target is not git-ignored inside a work tree, or files exist: nothing was written yet
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm: Option<ExportConfirm>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use crate::contract::fwd::fixtures::{service, workload};

    pub fn rewrite() -> Rewrite {
        Rewrite {
            r#match: RewriteMatch { service: "kafka".into(), namespace: "kafka".into(), port: 9092 },
            env_key: Some("KAFKA_BOOTSTRAP_SERVERS".into()),
            to: RewriteTo { forward: "kafka".into() },
        }
    }
    pub fn forward() -> DevForward {
        DevForward { key: "kafka".into(), target: service(), remote_port: PortRef::Number(9094), local_port: 9094, pin: true, label: Some("kafka".into()) }
    }
    pub fn env_spec() -> EnvSpec {
        EnvSpec {
            workload: Workload { gvr: Gvr::new("apps", "v1", "deployments"), namespace: "shop".into(), name: "orders".into() },
            container: Some("orders".into()),
            include: None,
            exclude: Some(vec!["JAVA_OPTS".into()]),
            include_secrets: Some(vec!["DATABASE_URL".into()]),
            overrides: Some(vec![EnvOverride { key: "SPRING_KAFKA_CONSUMER_GROUP_ID".into(), value: "orders-local-me".into() }]),
            format: EnvFormat::Dotenv,
        }
    }
    pub fn dev_set() -> DevSet {
        let mut snapshot = DevSet {
            id: "ds1".into(),
            name: "orders-dev".into(),
            context: "default".into(),
            forwards: vec![
                forward(),
                DevForward {
                    key: "app".into(),
                    target: workload(),
                    remote_port: PortRef::Name("http".into()),
                    local_port: 18080,
                    pin: false,
                    label: None,
                },
            ],
            rewrites: vec![rewrite()],
            env: Some(env_spec()),
            auto_start: false,
            conn_secrets: Some(vec![ConnSecret {
                forward: "kafka".into(),
                secret: SecretKeyRef { namespace: "kafka".into(), name: "kafka-user".into(), key: "password".into() },
            }]),
            origin: DevSetOrigin::User,
            hash: "aa".into(),
            approved_hash: Some("aa".into()),
            approved_snapshot: None,
            updated_at: "2026-11-22T10:00:00Z".into(),
        };
        let mut set = snapshot.clone();
        snapshot.origin = DevSetOrigin::Agent { client: "claude-code".into(), at: "2026-11-22T09:00:00Z".into() };
        set.approved_snapshot = Some(Box::new(snapshot));
        set.hash = "bb".into();
        set
    }
}

#[cfg(test)]
mod tests {
    use super::{fixtures::*, *};
    use crate::contract::{drift::Fixtures, fwd::fixtures::obj};

    #[test]
    fn drift() {
        let mut f = Fixtures::new("dev");
        f.add("devSet", "DevSet", &dev_set());
        f.add(
            "devSetDraft",
            "DevSetDraft",
            &DevSetDraft {
                id: None,
                name: "orders-dev".into(),
                context: "default".into(),
                forwards: vec![forward()],
                rewrites: vec![rewrite()],
                env: None,
                auto_start: true,
                conn_secrets: None,
            },
        );
        f.add(
            "devSetFailures",
            "DevSetFailure[]",
            &vec![DevSetFailure { dev_set: "ds1".into(), name: "orders-dev".into(), context: "default".into(), message: "local port 9094 is taken".into(), at: "2026-11-22T10:00:00Z".into() }],
        );
        f.add("devSetSaved", "DevSetSaved", &DevSetSaved { set: dev_set(), warnings: vec!["rewrite matched nothing".into()] });
        f.add(
            "envReport",
            "EnvReport",
            &EnvReport {
                container: "orders".into(),
                containers: vec!["orders".into(), "istio-proxy".into()],
                rows: vec![
                    EnvRow {
                        key: "KAFKA_BOOTSTRAP_SERVERS".into(),
                        source: EnvSource::Literal,
                        from: None,
                        value: Some("kafka.kafka.svc.cluster.local:9092".into()),
                        masked: false,
                        hits: vec![Hit { service: "kafka".into(), namespace: "kafka".into(), port: 9092, span: Some((0, 34)) }],
                    },
                    EnvRow {
                        key: "DATABASE_URL".into(),
                        source: EnvSource::Secret,
                        from: Some("secret/orders:DATABASE_URL".into()),
                        value: None,
                        masked: true,
                        hits: vec![Hit { service: "postgres".into(), namespace: "payments".into(), port: 5432, span: None }],
                    },
                    EnvRow { key: "APP_CM".into(), source: EnvSource::ConfigMap, from: Some("configmap/orders".into()), value: Some("x".into()), masked: false, hits: vec![] },
                    EnvRow { key: "POD_IP".into(), source: EnvSource::Field, from: Some("status.podIP".into()), value: None, masked: false, hits: vec![] },
                    EnvRow { key: "MEM".into(), source: EnvSource::ResourceField, from: Some("limits.memory".into()), value: None, masked: false, hits: vec![] },
                ],
                deps: vec![Dependency {
                    service: obj("services", "kafka", "kafka"),
                    port: 9092,
                    kind: ServiceKind::Kafka,
                    ready: true,
                    suggested_forward: forward(),
                    suggested_rewrite: rewrite(),
                    notes: vec!["listener INTERNAL advertises kafka.kafka.svc.cluster.local:9092; use LOCAL, pinned 9094".into()],
                }],
                warnings: vec!["SPRING_KAFKA_CONSUMER_GROUP_ID=orders: a local run joins the in-cluster consumer group".into()],
                overrides: vec![EnvOverride { key: "SPRING_KAFKA_CONSUMER_GROUP_ID".into(), value: "orders-local-me".into() }],
                redactions: crate::contract::pack::fixtures::report(),
            },
        );
        f.add(
            "envExportRequests",
            "EnvExportRequest[]",
            &vec![
                EnvExportRequest {
                    dev_set: Some("ds1".into()),
                    spec: None,
                    rewrites: vec![],
                    destination: ExportDestination::File,
                    context: None,
                    forwards: None,
                    clear_seconds: None,
                    confirm_token: None,
                    confirm_text: None,
                    proposal_id: Some("p1".into()),
                },
                EnvExportRequest {
                    dev_set: None,
                    spec: Some(env_spec()),
                    rewrites: vec![rewrite()],
                    destination: ExportDestination::Clipboard,
                    context: Some("default".into()),
                    forwards: Some(vec![forward()]),
                    clear_seconds: Some(60),
                    confirm_token: Some("t1".into()),
                    confirm_text: Some("orders".into()),
                    proposal_id: None,
                },
            ],
        );
        f.add(
            "envExportResults",
            "EnvExportResult[]",
            &vec![
                EnvExportResult {
                    keys: 14,
                    secret_keys: 1,
                    path: Some("C:\\work\\orders\\.env.kns".into()),
                    cancelled: None,
                    clear_seconds: None,
                    history_excluded: None,
                    confirm: None,
                    warnings: vec!["the folder is synced by OneDrive".into()],
                },
                EnvExportResult {
                    keys: 0,
                    secret_keys: 0,
                    path: None,
                    cancelled: Some(true),
                    clear_seconds: None,
                    history_excluded: None,
                    confirm: None,
                    warnings: vec![],
                },
                EnvExportResult {
                    keys: 14,
                    secret_keys: 9,
                    path: None,
                    cancelled: None,
                    clear_seconds: Some(60),
                    history_excluded: Some(true),
                    confirm: None,
                    warnings: vec![],
                },
                EnvExportResult {
                    keys: 0,
                    secret_keys: 0,
                    path: None,
                    cancelled: None,
                    clear_seconds: None,
                    history_excluded: None,
                    confirm: Some(ExportConfirm { token: "t1".into(), path: "C:\\work\\repo\\.env.kns".into(), reason: "not git-ignored in C:\\work\\repo".into(), type_to_confirm: "orders".into() }),
                    warnings: vec![],
                },
            ],
        );
        f.add("envFormats", "EnvFormat[]", &vec![EnvFormat::Dotenv, EnvFormat::Powershell, EnvFormat::Posix]);
        let pick = SecretKeyRef { namespace: "payments".into(), name: "postgres".into(), key: "DATABASE_URL".into() };
        f.add("secretKeys", "SecretKeys", &SecretKeys { name: "postgres".into(), type_: "Opaque".into(), keys: vec!["DATABASE_URL".into(), "PASSWORD".into()] });
        f.add(
            "connInfo",
            "ConnInfo",
            &ConnInfo {
                forward: "f1".into(),
                kind: ServiceKind::Postgres,
                plain: "postgres://localhost:15432/".into(),
                remembered: Some(pick.clone()),
                memory: Some(ConnMemory::Set),
                dev_set: Some("ds1".into()),
                dev_set_approved: Some(true),
            },
        );
        f.add("connMemories", "ConnMemory[]", &vec![ConnMemory::Set, ConnMemory::Forward]);
        f.add(
            "connCopyRequest",
            "ConnCopyRequest",
            &ConnCopyRequest { forward: "f1".into(), plain: Some(false), secret: Some(pick.clone()), remember: Some(true), clear_seconds: Some(60) },
        );
        f.add(
            "connCopyResults",
            "ConnCopyResult[]",
            &vec![
                ConnCopyResult {
                    preview: "postgres://app:•••@localhost:15432/app".into(),
                    copied: true,
                    text: None,
                    secret: Some(pick),
                    clear_seconds: Some(60),
                    history_excluded: Some(true),
                    remembered: Some(ConnMemory::Forward),
                },
                ConnCopyResult {
                    preview: "localhost:9094".into(),
                    copied: false,
                    text: Some("localhost:9094".into()),
                    secret: None,
                    clear_seconds: None,
                    history_excluded: None,
                    remembered: None,
                },
            ],
        );
        f.add(
            "volumeReport",
            "VolumeReport",
            &VolumeReport {
                container: "orders".into(),
                containers: vec!["orders".into()],
                volumes: vec![
                    VolumeInfo {
                        id: "config".into(),
                        source: VolumeSource::ConfigMap,
                        object: "orders".into(),
                        mount_path: Some("/config".into()),
                        files: vec!["application.yaml".into()],
                        readable: true,
                        message: None,
                    },
                    VolumeInfo {
                        id: "creds/db".into(),
                        source: VolumeSource::Secret,
                        object: "db".into(),
                        mount_path: None,
                        files: vec![],
                        readable: false,
                        message: Some("forbidden".into()),
                    },
                ],
            },
        );
        f.add(
            "volumesExportRequest",
            "VolumesExportRequest",
            &VolumesExportRequest { obj_ref: obj("deployments", "shop", "orders"), container: None, volumes: vec!["config".into()], confirm_token: Some("t1".into()), confirm_text: Some("orders".into()) },
        );
        f.add(
            "volumesExportResults",
            "VolumesExportResult[]",
            &vec![
                VolumesExportResult { files: 3, secret_files: 1, path: Some("C:\\work\\vol".into()), cancelled: None, confirm: None, warnings: vec![] },
                VolumesExportResult {
                    files: 3,
                    secret_files: 1,
                    path: None,
                    cancelled: None,
                    confirm: Some(ExportConfirm { token: "t1".into(), path: "C:\\work\\repo\\vol".into(), reason: "not git-ignored".into(), type_to_confirm: "orders".into() }),
                    warnings: vec!["the folder is synced by OneDrive".into()],
                },
                VolumesExportResult { files: 0, secret_files: 0, path: None, cancelled: Some(true), confirm: None, warnings: vec![] },
            ],
        );
        f.add("volumeSources", "VolumeSource[]", &vec![VolumeSource::ConfigMap, VolumeSource::Secret]);
        f.check();
    }
}
