//! Workload env: resolution with masked secrets, reveal, export (§3 B-dev, §1 amendment). Owner: B-dev.
//!
//! - `resolve_masked`: every env key of a container (`env` and `envFrom`, later entries win),
//!   where it comes from, its value when it is a literal or a ConfigMap value (redacted), and
//!   which in-cluster Services it talks to. Secret values are read here only, to find addresses;
//!   a hit of a secret value is returned as `{service, namespace, port}` and nothing else of it.
//!   Warnings are computed over non-secret values only.
//! - `reveal`: one value, on an explicit human action.
//! - `export`: a `.env` / PowerShell / POSIX text with addresses rewritten to the set's forwards,
//!   to a file chosen in a native save dialog opened by Rust, or (humans only) to the clipboard.
//!   A path inside a git work tree that is not git-ignored is refused for agent proposals and needs
//!   a typed confirmation from a human (Rust keeps the path; the webview only gets a token).
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use base64::Engine;

use crate::{
    addr::{self, SvcAddr, Target},
    clip,
    forward::{pod_spec, service_ports},
    ipc::{
        BackendError, Dependency, DevForward, EnvExportRequest, EnvExportResult, EnvFormat, EnvOverride, EnvReport, EnvRow, EnvSource,
        EnvSpec, ExportConfirm, ExportDestination, ForwardTarget, Gvr, Json, ObjRef, PortRef, ProposalPayload, Result, Rewrite, RewriteMatch,
        RewriteTo, ServiceKind, VolumeInfo, VolumeReport, VolumeSource, VolumesExportRequest, VolumesExportResult,
    },
    kafka, proposals,
    redact::{self, Redactor},
    service,
    session::api_path,
    state::{AppState, lock},
};

/// How long a "write to this not-ignored path?" question stays answerable.
const CONFIRM_TTL: Duration = Duration::from_secs(300);

// ───────────────────────── raw env (pure) ─────────────────────────

/// One env key as the container sees it, with the raw value when known. Never leaves Rust.
#[derive(Debug, Clone, PartialEq)]
pub struct RawEnv {
    pub key: String,
    pub source: EnvSource,
    pub from: Option<String>,
    /// literal, ConfigMap or Secret value (decoded); None for field refs and unreadable sources
    pub value: Option<String>,
}

fn arr(v: Option<&Json>) -> &[Json] {
    v.and_then(Json::as_array).map(Vec::as_slice).unwrap_or_default()
}

fn s<'a>(v: &'a Json, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Json::as_str)
}

/// The containers of a pod spec, in order.
pub fn container_names(spec: &Json) -> Vec<String> {
    arr(spec.get("containers")).iter().filter_map(|c| s(c, "name").map(str::to_string)).collect()
}

fn find_container<'a>(spec: &'a Json, name: Option<&str>) -> Option<&'a Json> {
    let cs = arr(spec.get("containers"));
    match name {
        Some(n) => cs.iter().find(|c| s(c, "name") == Some(n)),
        None => cs.first(),
    }
}

/// ConfigMaps and Secrets a container's env reads: (configmaps, secrets) by name.
pub fn referenced(c: &Json) -> (Vec<String>, Vec<String>) {
    let (mut cms, mut secrets) = (Vec::new(), Vec::new());
    let add = |list: &mut Vec<String>, n: Option<&str>| {
        if let Some(n) = n
            && !list.iter().any(|x| x == n)
        {
            list.push(n.to_string());
        }
    };
    for e in arr(c.get("envFrom")) {
        if let Some(r) = e.get("configMapRef") {
            add(&mut cms, s(r, "name"));
        }
        if let Some(r) = e.get("secretRef") {
            add(&mut secrets, s(r, "name"));
        }
    }
    for e in arr(c.get("env")) {
        if let Some(r) = e.pointer("/valueFrom/configMapKeyRef") {
            add(&mut cms, s(r, "name"));
        }
        if let Some(r) = e.pointer("/valueFrom/secretKeyRef") {
            add(&mut secrets, s(r, "name"));
        }
    }
    (cms, secrets)
}

/// String data of a ConfigMap (`data`) or decoded Secret (`data` base64, `stringData`).
pub fn object_data(obj: &Json, secret: bool) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (k, v) in obj.get("data").and_then(Json::as_object).into_iter().flatten() {
        let Some(text) = v.as_str() else { continue };
        let value = if secret {
            match base64::engine::general_purpose::STANDARD.decode(text).ok().and_then(|b| String::from_utf8(b).ok()) {
                Some(v) => v,
                None => continue,
            }
        } else {
            text.to_string()
        };
        out.insert(k.clone(), value);
    }
    out
}

/// The env of a container: `envFrom` first, then `env` (which wins), each key once in first-seen
/// order. `cms` / `secrets`: the data of the objects that could be read.
pub fn collect_env(c: &Json, cms: &HashMap<String, BTreeMap<String, String>>, secrets: &HashMap<String, BTreeMap<String, String>>) -> Vec<RawEnv> {
    let mut out: Vec<RawEnv> = Vec::new();
    let mut put = |e: RawEnv| match out.iter_mut().find(|x| x.key == e.key) {
        Some(x) => *x = e,
        None => out.push(e),
    };
    for e in arr(c.get("envFrom")) {
        let prefix = s(e, "prefix").unwrap_or("");
        if let Some(name) = e.get("configMapRef").and_then(|r| s(r, "name")) {
            for (k, v) in cms.get(name).into_iter().flatten() {
                put(RawEnv { key: format!("{prefix}{k}"), source: EnvSource::ConfigMap, from: Some(format!("configmap/{name}")), value: Some(v.clone()) });
            }
        }
        if let Some(name) = e.get("secretRef").and_then(|r| s(r, "name")) {
            for (k, v) in secrets.get(name).into_iter().flatten() {
                put(RawEnv { key: format!("{prefix}{k}"), source: EnvSource::Secret, from: Some(format!("secret/{name}:{k}")), value: Some(v.clone()) });
            }
        }
    }
    for e in arr(c.get("env")) {
        let Some(key) = s(e, "name") else { continue };
        let key = key.to_string();
        if let Some(v) = s(e, "value") {
            put(RawEnv { key, source: EnvSource::Literal, from: None, value: Some(v.to_string()) });
        } else if let Some(r) = e.pointer("/valueFrom/configMapKeyRef") {
            let (name, k) = (s(r, "name").unwrap_or_default(), s(r, "key").unwrap_or_default());
            let value = cms.get(name).and_then(|d| d.get(k)).cloned();
            put(RawEnv { key, source: EnvSource::ConfigMap, from: Some(format!("configmap/{name}:{k}")), value });
        } else if let Some(r) = e.pointer("/valueFrom/secretKeyRef") {
            let (name, k) = (s(r, "name").unwrap_or_default(), s(r, "key").unwrap_or_default());
            let value = secrets.get(name).and_then(|d| d.get(k)).cloned();
            put(RawEnv { key, source: EnvSource::Secret, from: Some(format!("secret/{name}:{k}")), value });
        } else if let Some(r) = e.pointer("/valueFrom/fieldRef") {
            put(RawEnv { key, source: EnvSource::Field, from: s(r, "fieldPath").map(str::to_string), value: None });
        } else if let Some(r) = e.pointer("/valueFrom/resourceFieldRef") {
            put(RawEnv { key, source: EnvSource::ResourceField, from: s(r, "resource").map(str::to_string), value: None });
        } else {
            // `env: [{name: X}]` is an empty string
            put(RawEnv { key, source: EnvSource::Literal, from: None, value: Some(String::new()) });
        }
    }
    out
}

/// Every Service of a `List`, with its ports.
pub fn service_addrs(list: &Json) -> Vec<SvcAddr> {
    arr(list.get("items"))
        .iter()
        .filter_map(|svc| {
            let name = svc.pointer("/metadata/name")?.as_str()?.to_string();
            let namespace = svc.pointer("/metadata/namespace")?.as_str()?.to_string();
            Some(SvcAddr { name, namespace, ports: service_ports(svc).iter().map(|p| p.port).collect() })
        })
        .collect()
}

// ───────────────────────── side effects and suggestions (pure) ─────────────────────────

/// The user part of suggested overrides: `[a-z0-9-]`, from USERNAME / USER, else `me`.
pub fn local_user(get: impl Fn(&str) -> Option<String>) -> String {
    let raw = get("USERNAME").or_else(|| get("USER")).unwrap_or_default().to_ascii_lowercase();
    let cleaned: String = raw.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let cleaned = cleaned.trim_matches('-').chars().take(20).collect::<String>();
    if cleaned.is_empty() { "me".into() } else { cleaned }
}

/// Keys whose value makes a local run join the workload's consumer group or Streams application.
pub fn is_group_key(key: &str) -> bool {
    let k = key.to_ascii_uppercase();
    k.contains("GROUP_ID") || k.contains("CONSUMER_GROUP") || k.contains("APPLICATION_ID")
}

/// Keys that turn database migrations on for a local run.
pub fn is_migration_key(key: &str) -> bool {
    let k = key.to_ascii_uppercase();
    k.contains("MIGRATE") || k == "SPRING_FLYWAY_ENABLED" || k == "SPRING_LIQUIBASE_ENABLED" || ((k.starts_with("FLYWAY_") || k.starts_with("LIQUIBASE_")) && k.ends_with("ENABLED"))
}

/// Keys that make a local run act as the workload: consumer groups, stream app ids, migrations.
/// Warnings and overrides never use a secret value (a secret key is named, never echoed).
pub fn side_effects(rows: &[RawEnv], user: &str) -> (Vec<String>, Vec<EnvOverride>) {
    let (mut warnings, mut overrides) = (Vec::new(), Vec::new());
    for r in rows {
        let k = r.key.to_ascii_uppercase();
        let secret = r.source == EnvSource::Secret || redact::is_secret_key(&r.key);
        let value = if secret { None } else { r.value.as_deref() };
        if is_group_key(&r.key) {
            let what = if k.contains("APPLICATION_ID") { "Kafka Streams application" } else { "consumer group" };
            match value.filter(|v| !v.is_empty()) {
                Some(v) => {
                    let local = format!("{v}-local-{user}");
                    warnings.push(format!("{}={v}: a local run joins the in-cluster {what}; override suggested ({local})", r.key));
                    overrides.push(EnvOverride { key: r.key.clone(), value: local });
                }
                None => warnings.push(format!("{}: a local run may join the in-cluster {what}", r.key)),
            }
        } else if is_migration_key(&r.key) {
            let on = value.is_none_or(|v| !matches!(v.trim().to_ascii_lowercase().as_str(), "false" | "0" | "no" | "off"));
            if on {
                warnings.push(format!("{}: a local run may migrate the cluster's database; override suggested (false)", r.key));
                overrides.push(EnvOverride { key: r.key.clone(), value: "false".into() });
            }
        }
    }
    (warnings.into_iter().map(|w| redact::clean_untrusted(&w, 500)).collect(), overrides)
}

/// The local port for a Service port: +10000 (15432 for 5432, 10080 for 80), so local defaults
/// stay free; the exact port when that does not fit.
pub fn offset_port(port: u16) -> u16 {
    port.checked_add(10_000).unwrap_or(port).max(1024)
}

/// A forward key from a Service name, unique among `taken`.
pub fn forward_key(name: &str, namespace: &str, taken: &[String]) -> String {
    let slug = |t: &str| -> String {
        let s: String = t.to_ascii_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
        s.trim_matches('-').chars().take(40).collect()
    };
    let base = slug(name);
    if !taken.contains(&base) {
        return base;
    }
    let with_ns: String = slug(&format!("{name}-{namespace}"));
    if !taken.contains(&with_ns) {
        return with_ns;
    }
    (2..).map(|i| format!("{}-{i}", base.chars().take(36).collect::<String>())).find(|k| !taken.contains(k)).unwrap_or(base)
}

/// The forward, rewrite and notes for one dependency. Kafka with a listener advertising
/// `localhost:<p>` forwards that listener's port to the same local port (pinned: the broker sends
/// clients back there); everything else uses an offset local port. Every port is pinned so an
/// exported `.env` stays valid.
pub fn suggest(dep_service: &str, namespace: &str, port: u16, info: Option<&crate::ipc::ServiceInfo>, taken: &[String]) -> (DevForward, Rewrite, Vec<String>) {
    let key = forward_key(dep_service, namespace, taken);
    let target = ForwardTarget::Service { namespace: namespace.into(), name: dep_service.into() };
    let mut notes = Vec::new();
    let mut remote = port;
    let mut local = offset_port(port);
    if let Some(info) = info {
        // a k9scli.io/* annotation naming a local port for this Service port wins over the offset
        // (the Kafka LOCAL listener below still wins over both)
        if let Some(lp) = info
            .hints
            .iter()
            .flatten()
            .find(|h| h.remote_port == PortRef::Number(port))
            .and_then(|h| h.local_port)
            .filter(|lp| *lp >= 1024)
        {
            local = lp;
            notes.push(format!("local port {lp} from the k9scli.io port-forward annotation"));
        }
        if info.kind == ServiceKind::Kafka
            && let Some(listeners) = &info.kafka_listeners
        {
            let used = listeners.iter().find(|l| kafka::host_port(&l.advertised).is_some_and(|(_, p)| p == port));
            match kafka::local_listener(listeners) {
                Some((local_l, lp)) => {
                    let svc_port = info
                        .ports
                        .iter()
                        .find(|p| p.port == lp)
                        .or_else(|| info.ports.iter().find(|p| p.target_port == PortRef::Number(lp)))
                        .or_else(|| info.ports.iter().find(|p| matches!(&p.target_port, PortRef::Name(n) if n.eq_ignore_ascii_case(&local_l.name))));
                    if let Some(sp) = svc_port {
                        remote = sp.port;
                        local = lp;
                        let adv = used.map_or_else(|| format!("{dep_service}.{namespace}:{port}"), |l| l.advertised.clone());
                        notes.push(format!("advertised as {adv}; use listener {}, pinned {lp}", local_l.name));
                    } else {
                        notes.push(format!("listener {} advertises localhost:{lp}, but the Service has no port for it", local_l.name));
                    }
                }
                None => {
                    let adv = used.or(listeners.first()).map_or_else(String::new, |l| l.advertised.clone());
                    notes.push(format!(
                        "the broker advertises {adv}; clients reconnect there, which a forward cannot reach. Add a listener advertising localhost:{local}"
                    ));
                }
            }
        } else if info.kind == ServiceKind::Kafka {
            notes.push("Kafka listeners unknown (not literal env); a client may be sent to an address the forward cannot reach".into());
        }
        if info.endpoints.ready == 0 {
            notes.push("no ready endpoint: the forward waits until one is ready".into());
        }
    }
    let notes = notes.into_iter().map(|n| redact::clean_untrusted(&n, redact::MAX_LINE)).collect();
    let forward = DevForward { key: key.clone(), target, remote_port: PortRef::Number(remote), local_port: local, pin: true, label: None };
    let rewrite = Rewrite { r#match: RewriteMatch { service: dep_service.into(), namespace: namespace.into(), port }, env_key: None, to: RewriteTo { forward: key } };
    (forward, rewrite, notes)
}

// ───────────────────────── export text (pure) ─────────────────────────

fn quote_dotenv(v: &str) -> String {
    let plain = !v.is_empty() && v.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:@,+=%".contains(c));
    if plain {
        return v.to_string();
    }
    let escaped = v.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r").replace('$', "\\$");
    format!("\"{escaped}\"")
}

/// The export text; `header` is a comment line (no values).
pub fn format_env(entries: &[(String, String)], format: EnvFormat, header: &str) -> String {
    let mut out = match format {
        EnvFormat::Dotenv | EnvFormat::Posix => format!("# {header}\n"),
        EnvFormat::Powershell => format!("# {header}\r\n"),
    };
    for (k, v) in entries {
        match format {
            EnvFormat::Dotenv => out.push_str(&format!("{k}={}\n", quote_dotenv(v))),
            EnvFormat::Posix => out.push_str(&format!("export {k}='{}'\n", v.replace('\'', "'\\''"))),
            EnvFormat::Powershell => out.push_str(&format!("$env:{k} = '{}'\r\n", v.replace('\'', "''"))),
        }
    }
    out
}

/// Env keys are what a shell accepts: `[A-Za-z_][A-Za-z0-9_]*`. Others are skipped in exports.
pub fn valid_key(k: &str) -> bool {
    let mut c = k.chars();
    c.next().is_some_and(|f| f.is_ascii_alphabetic() || f == '_') && c.all(|x| x.is_ascii_alphanumeric() || x == '_')
}

/// What goes into an export: keys after include/exclude, secret keys only when allowed, field
/// refs skipped, values rewritten (per `envKey` when set), overrides last. Returns the entries
/// and how many came from secrets.
pub fn export_entries(
    rows: &[RawEnv],
    spec: &EnvSpec,
    allowed_secrets: &[String],
    rewrites: &[Rewrite],
    local_ports: &HashMap<String, u16>,
    services: &[SvcAddr],
    home_ns: &str,
) -> (Vec<(String, String)>, u32) {
    let included = |k: &str| {
        spec.include.as_ref().is_none_or(|inc| inc.iter().any(|x| x == k)) && !spec.exclude.as_ref().is_some_and(|ex| ex.iter().any(|x| x == k))
    };
    let mut entries: Vec<(String, String)> = Vec::new();
    let mut secret_keys = 0u32;
    for r in rows {
        if !included(&r.key) || !valid_key(&r.key) {
            continue;
        }
        let Some(value) = &r.value else { continue };
        if matches!(r.source, EnvSource::Field | EnvSource::ResourceField) {
            continue;
        }
        if r.source == EnvSource::Secret {
            if !allowed_secrets.iter().any(|k| k == &r.key) {
                continue;
            }
            secret_keys += 1;
        }
        let targets: Vec<Target> = rewrites
            .iter()
            .filter(|rw| rw.env_key.as_ref().is_none_or(|k| k == &r.key))
            .filter_map(|rw| {
                Some(Target {
                    service: rw.r#match.service.clone(),
                    namespace: rw.r#match.namespace.clone(),
                    port: rw.r#match.port,
                    local_port: *local_ports.get(&rw.to.forward)?,
                })
            })
            .collect();
        entries.push((r.key.clone(), addr::rewrite(value, &targets, services, home_ns, addr::address_key(&r.key))));
    }
    for o in spec.overrides.iter().flatten() {
        if !valid_key(&o.key) {
            continue;
        }
        match entries.iter_mut().find(|(k, _)| *k == o.key) {
            Some(e) => e.1 = o.value.clone(),
            None => entries.push((o.key.clone(), o.value.clone())),
        }
    }
    (entries, secret_keys)
}

// ───────────────────────── where a file may go (pure-ish, file system reads only) ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitCheck {
    NotInRepo,
    Ignored,
    NotIgnored { root: PathBuf },
}

/// Whether `path` is inside a git work tree and, if so, git-ignored: every `.gitignore` from the
/// file's directory up to the work tree root (deepest wins) and `.git/info/exclude`. No git process
/// (no repo config, hooks or fsmonitor). The global `core.excludesFile` is not read, which errs
/// toward refusing.
pub fn git_check(path: &Path) -> GitCheck {
    use ignore::gitignore::GitignoreBuilder;
    let Some(dir) = path.parent() else { return GitCheck::NotInRepo };
    let Some(root) = dir.ancestors().find(|d| d.join(".git").exists()) else { return GitCheck::NotInRepo };
    let mut matchers = Vec::new();
    for d in dir.ancestors() {
        let file = d.join(".gitignore");
        if file.is_file() {
            let mut b = GitignoreBuilder::new(d);
            if b.add(&file).is_none()
                && let Ok(gi) = b.build()
            {
                matchers.push(gi);
            }
        }
        if d == root {
            break;
        }
    }
    let exclude = root.join(".git").join("info").join("exclude");
    if exclude.is_file() {
        let mut b = GitignoreBuilder::new(root);
        if b.add(&exclude).is_none()
            && let Ok(gi) = b.build()
        {
            matchers.push(gi);
        }
    }
    for gi in &matchers {
        let m = gi.matched_path_or_any_parents(path, false);
        if m.is_ignore() {
            return GitCheck::Ignored;
        }
        if m.is_whitelist() {
            break;
        }
    }
    GitCheck::NotIgnored { root: root.to_path_buf() }
}

/// The sync service of a cloud-synced folder `path` is in (OneDrive incl. Known Folder Move,
/// Dropbox, iCloud Drive, Google Drive, macOS CloudStorage).
pub fn cloud_folder(path: &Path, get: impl Fn(&str) -> Option<String>, home: Option<&Path>) -> Option<&'static str> {
    for var in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Some(root) = get(var).filter(|r| !r.is_empty())
            && path.starts_with(root)
        {
            return Some("OneDrive");
        }
    }
    if let Some(home) = home {
        let under = [
            ("Dropbox", "Dropbox"),
            ("Library/Mobile Documents", "iCloud Drive"),
            ("iCloudDrive", "iCloud Drive"),
            ("Library/CloudStorage", "a cloud storage provider"),
            ("Google Drive", "Google Drive"),
            ("OneDrive", "OneDrive"),
        ];
        for (rel, what) in under {
            if path.starts_with(home.join(rel)) {
                return Some(what);
            }
        }
    }
    path.components().any(|c| c.as_os_str().to_string_lossy().starts_with("OneDrive")).then_some("OneDrive")
}

/// Writes the export; mode 0600 on Unix.
fn write_file(path: &Path, text: &str) -> Result<()> {
    write_bytes(path, text.as_bytes())
}

fn write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}

// ───────────────────────── mounted volumes (B2, humans only) ─────────────────────────

/// A ConfigMap / Secret a container mounts, as the pod spec says (a projected volume gives one per source).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VolSpec {
    pub id: String,
    pub source: VolumeSource,
    pub object: String,
    pub mount_path: Option<String>,
    /// `items`: key -> path; `None` = every key as its own file
    pub items: Option<Vec<(String, String)>>,
}

/// A relative path inside the chosen folder, or `None`: no absolute paths, drive or UNC prefixes,
/// backslashes, `.`/`..` segments, empty segments or control characters.
pub fn safe_rel_path(p: &str) -> Option<PathBuf> {
    if p.is_empty() || p.len() > 1024 || p.starts_with('/') || p.contains('\\') || p.contains(':') || p.chars().any(char::is_control) {
        return None;
    }
    let mut out = PathBuf::new();
    for seg in p.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.ends_with('.') || seg.ends_with(' ') {
            return None;
        }
        out.push(seg);
    }
    Some(out)
}

fn items_of(v: &Json) -> Option<Vec<(String, String)>> {
    let items = v.get("items")?.as_array()?;
    Some(items.iter().filter_map(|i| Some((s(i, "key")?.to_string(), s(i, "path")?.to_string()))).collect())
}

/// The ConfigMap / Secret volumes `container` mounts, in the pod spec's order.
pub fn volume_specs(spec: &Json, container: &Json) -> Vec<VolSpec> {
    let mounts = arr(container.get("volumeMounts"));
    let mount_of = |name: &str| mounts.iter().find(|m| s(m, "name") == Some(name)).and_then(|m| s(m, "mountPath")).map(str::to_string);
    let mut out = Vec::new();
    for v in arr(spec.get("volumes")) {
        let Some(name) = s(v, "name") else { continue };
        if !mounts.iter().any(|m| s(m, "name") == Some(name)) {
            continue;
        }
        let mount_path = mount_of(name);
        if let Some(cm) = v.get("configMap")
            && let Some(obj) = s(cm, "name")
        {
            out.push(VolSpec { id: name.into(), source: VolumeSource::ConfigMap, object: obj.into(), mount_path: mount_path.clone(), items: items_of(cm) });
        }
        if let Some(sec) = v.get("secret")
            && let Some(obj) = s(sec, "secretName")
        {
            out.push(VolSpec { id: name.into(), source: VolumeSource::Secret, object: obj.into(), mount_path: mount_path.clone(), items: items_of(sec) });
        }
        for src in arr(v.pointer("/projected/sources")) {
            for (k, source) in [("configMap", VolumeSource::ConfigMap), ("secret", VolumeSource::Secret)] {
                if let Some(x) = src.get(k)
                    && let Some(obj) = s(x, "name")
                {
                    out.push(VolSpec { id: format!("{name}/{obj}"), source, object: obj.into(), mount_path: mount_path.clone(), items: items_of(x) });
                }
            }
        }
    }
    out
}

/// Bytes per key of a ConfigMap (`data`, `binaryData`) or Secret (`data`, base64).
pub fn object_bytes(obj: &Json, secret: bool) -> BTreeMap<String, Vec<u8>> {
    let b64 = |t: &str| base64::engine::general_purpose::STANDARD.decode(t).ok();
    let mut out = BTreeMap::new();
    for (k, v) in obj.get("data").and_then(Json::as_object).into_iter().flatten() {
        let Some(t) = v.as_str() else { continue };
        let bytes = if secret { b64(t) } else { Some(t.as_bytes().to_vec()) };
        if let Some(b) = bytes {
            out.insert(k.clone(), b);
        }
    }
    if !secret {
        for (k, v) in obj.get("binaryData").and_then(Json::as_object).into_iter().flatten() {
            if let Some(b) = v.as_str().and_then(b64) {
                out.insert(k.clone(), b);
            }
        }
    }
    out
}

/// The files of one volume: (path relative to the volume, bytes). `items` picks and renames keys;
/// a key or path that is not a safe relative path is skipped.
pub fn volume_files(v: &VolSpec, data: &BTreeMap<String, Vec<u8>>) -> Vec<(PathBuf, Vec<u8>)> {
    let pairs: Vec<(&str, &str)> = match &v.items {
        Some(items) => items.iter().map(|(k, p)| (k.as_str(), p.as_str())).collect(),
        None => data.keys().map(|k| (k.as_str(), k.as_str())).collect(),
    };
    pairs.into_iter().filter_map(|(k, p)| Some((safe_rel_path(p)?, data.get(k)?.clone()))).collect()
}

/// A volume export waiting for the human: (folder, files, file count, secret files, asked at, text to type).
type PendingVolumes = (PathBuf, Vec<(PathBuf, Vec<u8>)>, u32, u32, Instant, String);

/// The typed confirmation of a pending export, checked in Rust (§6.5: not a UI-only guard).
pub fn confirm_text_ok(expected: &str, typed: Option<&str>) -> bool {
    typed.is_some_and(|t| t.trim() == expected)
}

fn confirm_mismatch(expected: &str) -> BackendError {
    BackendError::new(409, "ConfirmText", format!("type {expected} to confirm writing there"))
}

/// A human export from a protected context carries the workload name typed in the export dialog
/// (`confirmText` on the first request); checked here, not only in the UI (§6.6). Agent exports
/// are checked by the proposal gate instead (the approval dialog asks for the context name).
pub fn protected_confirm(state: &AppState, context: &str, expected: &str, typed: Option<&str>) -> Result<()> {
    if crate::ctxflags::effective(state, context)?.protected && !confirm_text_ok(expected, typed) {
        return Err(BackendError::new(409, "ConfirmText", format!("{context} is a protected context: type {expected} to export")));
    }
    Ok(())
}

#[derive(Default)]
struct PendingVolumeExports(Mutex<HashMap<String, PendingVolumes>>);

/// What a workload mounts and what can be read: the specs with their data.
async fn load_volumes(state: &AppState, obj_ref: &ObjRef, container: Option<&str>) -> Result<(String, Vec<String>, Vec<(VolSpec, std::result::Result<BTreeMap<String, Vec<u8>>, String>)>)> {
    let sess = state.session(&obj_ref.context).await?;
    let ns = workload_ns(obj_ref)?;
    let obj = sess.get(&api_path(&obj_ref.gvr, Some(&ns), Some(&obj_ref.name))).await?;
    let spec = pod_spec(&obj).ok_or_else(|| BackendError::invalid(format!("{} {} has no pod template", obj_ref.gvr.resource, obj_ref.name)))?;
    let containers = container_names(spec);
    let c = find_container(spec, container).ok_or_else(|| BackendError::invalid(format!("no container {}", container.unwrap_or("(none)"))))?;
    let name = s(c, "name").unwrap_or_default().to_string();
    let mut out = Vec::new();
    for v in volume_specs(spec, c) {
        let (resource, secret) = match v.source {
            VolumeSource::ConfigMap => ("configmaps", false),
            VolumeSource::Secret => ("secrets", true),
        };
        let data = sess
            .get(&api_path(&Gvr::new("", "v1", resource), Some(&ns), Some(&v.object)))
            .await
            .map(|o| object_bytes(&o, secret))
            .map_err(|e| redact::clean_untrusted(&e.reason, 200));
        out.push((v, data));
    }
    Ok((name, containers, out))
}

/// The ConfigMap / Secret volumes of a workload's container: file names only, never contents.
pub async fn volumes_list(state: &AppState, obj_ref: &ObjRef, container: Option<&str>) -> Result<VolumeReport> {
    let (container, containers, vols) = load_volumes(state, obj_ref, container).await?;
    let clean = |t: &str| redact::clean_untrusted(t, 256);
    let volumes = vols
        .into_iter()
        .map(|(v, data)| {
            let (files, readable, message) = match data {
                Ok(d) => (volume_files(&v, &d).into_iter().map(|(p, _)| clean(&p.to_string_lossy().replace('\\', "/"))).collect(), true, None),
                Err(e) => (Vec::new(), false, Some(e)),
            };
            VolumeInfo { id: clean(&v.id), source: v.source, object: clean(&v.object), mount_path: v.mount_path.as_deref().map(clean), files, readable, message }
        })
        .collect();
    Ok(VolumeReport { container, containers, volumes })
}

fn write_volumes(folder: &Path, files: &[(PathBuf, Vec<u8>)]) -> Result<()> {
    for (rel, bytes) in files {
        let path = folder.join(rel);
        if !path.starts_with(folder) {
            return Err(BackendError::invalid(format!("{} is outside the folder", rel.display())));
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        write_bytes(&path, bytes)?;
    }
    Ok(())
}

/// The native folder picker, opened by Rust; `None` when the human closed it.
async fn folder_dialog(state: &AppState) -> Result<Option<PathBuf>> {
    use tauri_plugin_dialog::DialogExt;
    let app = state.app().ok_or_else(|| BackendError::internal("no window for the folder dialog"))?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Folder for the mounted files");
    if let Some(home) = dirs::home_dir() {
        dialog = dialog.set_directory(home);
    }
    dialog.pick_folder(move |path| {
        let _ = tx.send(path.and_then(|p| p.into_path().ok()));
    });
    rx.await.map_err(|_| BackendError::internal("the folder dialog went away"))
}

fn volumes_result(files: u32, secret_files: u32) -> VolumesExportResult {
    VolumesExportResult { files, secret_files, path: None, cancelled: None, confirm: None, warnings: Vec::new() }
}

/// Why writing `files` under `folder` needs a typed confirmation: a target is not git-ignored
/// inside a work tree, or a file would be replaced. `None` = write at once.
pub fn volumes_confirm_reason(folder: &Path, files: &[(PathBuf, Vec<u8>)]) -> Option<String> {
    let targets: Vec<PathBuf> = files.iter().map(|(rel, _)| folder.join(rel)).collect();
    let tracked = targets.iter().find_map(|t| match git_check(t) {
        GitCheck::NotIgnored { root } => Some(format!("{} is inside the git work tree {} and is not git-ignored", t.display(), root.display())),
        _ => None,
    });
    let existing = targets.iter().filter(|t| t.exists()).count();
    match (tracked, existing) {
        (Some(t), 0) => Some(t),
        (Some(t), n) => Some(format!("{t}; {n} existing file(s) would be replaced")),
        (None, 0) => None,
        (None, n) => Some(format!("{n} file(s) under {} exist and would be replaced", folder.display())),
    }
}

/// `volumes_export`: humans only (there is no proposal path). The chosen volumes' files go to
/// `<folder>/<volume id>/<path>`, mode 0600 on Unix, with the `.env` guards: a not-ignored path in a
/// work tree (or replacing files) needs a typed confirmation, a cloud-synced folder warns.
pub async fn volumes_export(state: &AppState, req: VolumesExportRequest) -> Result<VolumesExportResult> {
    if let Some(token) = &req.confirm_token {
        let pending_store = state.ext::<PendingVolumeExports>();
        let mut map = lock(&pending_store.0);
        if let Some(p) = map.get(token)
            && p.4.elapsed() < CONFIRM_TTL
            && !confirm_text_ok(&p.5, req.confirm_text.as_deref())
        {
            return Err(confirm_mismatch(&p.5));
        }
        let pending = map.remove(token);
        drop(map);
        let Some((folder, files, n, secret_files, _, _)) = pending.filter(|p| p.4.elapsed() < CONFIRM_TTL) else {
            return Err(BackendError::invalid("that export question expired; export again"));
        };
        write_volumes(&folder, &files)?;
        return Ok(VolumesExportResult { path: Some(folder.display().to_string()), ..volumes_result(n, secret_files) });
    }
    if req.volumes.is_empty() {
        return Err(BackendError::invalid("pick at least one volume"));
    }
    protected_confirm(state, &req.obj_ref.context, &req.obj_ref.name, req.confirm_text.as_deref())?;
    let (_, _, vols) = load_volumes(state, &req.obj_ref, req.container.as_deref()).await?;
    let mut files: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    let mut secret_files = 0u32;
    for id in &req.volumes {
        let (v, data) = vols.iter().find(|(v, _)| &v.id == id).ok_or_else(|| BackendError::new(404, "NotFound", format!("no mounted volume {id}")))?;
        let data = data.as_ref().map_err(|e| BackendError::invalid(format!("volume {id} ({}) is not readable: {e}", v.object)))?;
        let dir = safe_rel_path(&v.id).ok_or_else(|| BackendError::invalid(format!("volume {id} has no usable folder name")))?;
        for (rel, bytes) in volume_files(v, data) {
            if v.source == VolumeSource::Secret {
                secret_files += 1;
            }
            files.push((dir.join(rel), bytes));
        }
    }
    let n = files.len() as u32;
    let Some(folder) = folder_dialog(state).await? else { return Ok(VolumesExportResult { cancelled: Some(true), ..volumes_result(0, 0) }) };
    let mut warnings = Vec::new();
    if let Some(what) = cloud_folder(&folder.join("x"), |k| std::env::var(k).ok(), dirs::home_dir().as_deref()) {
        warnings.push(format!("the folder is synced by {what}: the files are uploaded with it"));
    }
    if let Some(reason) = volumes_confirm_reason(&folder, &files) {
        let token = state.next_id("volumes-");
        let pending = state.ext::<PendingVolumeExports>();
        let mut map = lock(&pending.0);
        // expired questions hold secret bytes: drop them
        map.retain(|_, p| p.4.elapsed() < CONFIRM_TTL);
        let expect = req.obj_ref.name.clone();
        map.insert(token.clone(), (folder.clone(), files, n, secret_files, Instant::now(), expect.clone()));
        drop(map);
        return Ok(VolumesExportResult {
            confirm: Some(ExportConfirm { token, path: folder.display().to_string(), reason, type_to_confirm: expect }),
            warnings,
            ..volumes_result(n, secret_files)
        });
    }
    write_volumes(&folder, &files)?;
    Ok(VolumesExportResult { path: Some(folder.display().to_string()), warnings, ..volumes_result(n, secret_files) })
}

// ───────────────────────── live ─────────────────────────

/// What `load` read: the container's raw env and the cluster's Services.
pub struct Loaded {
    pub container: String,
    pub containers: Vec<String>,
    pub rows: Vec<RawEnv>,
    pub services: Vec<SvcAddr>,
    pub home_ns: String,
    pub warnings: Vec<String>,
}

fn workload_ns(obj_ref: &ObjRef) -> Result<String> {
    obj_ref.ns().map(str::to_string).ok_or_else(|| BackendError::invalid("the workload has no namespace"))
}

/// Reads a workload (or pod) and the ConfigMaps / Secrets its container's env references.
pub async fn load(state: &AppState, context: &str, obj_ref: &ObjRef, container: Option<&str>) -> Result<Loaded> {
    let sess = state.session(context).await?;
    let ns = workload_ns(obj_ref)?;
    let obj = sess.get(&api_path(&obj_ref.gvr, Some(&ns), Some(&obj_ref.name))).await?;
    let spec = pod_spec(&obj).ok_or_else(|| BackendError::invalid(format!("{} {} has no pod template", obj_ref.gvr.resource, obj_ref.name)))?;
    let containers = container_names(spec);
    let c = find_container(spec, container).ok_or_else(|| BackendError::invalid(format!("no container {}", container.unwrap_or("(none)"))))?;
    let name = s(c, "name").unwrap_or_default().to_string();
    let (cm_names, secret_names) = referenced(c);
    let mut warnings = Vec::new();
    let mut cms = HashMap::new();
    for n in cm_names {
        match sess.get(&api_path(&Gvr::new("", "v1", "configmaps"), Some(&ns), Some(&n))).await {
            Ok(o) => {
                cms.insert(n, object_data(&o, false));
            }
            Err(e) => warnings.push(redact::clean_untrusted(&format!("configmap {n}: {}", e.message), 300)),
        }
    }
    let mut secrets = HashMap::new();
    for n in secret_names {
        match sess.get(&api_path(&Gvr::new("", "v1", "secrets"), Some(&ns), Some(&n))).await {
            Ok(o) => {
                secrets.insert(n, object_data(&o, true));
            }
            Err(e) => warnings.push(format!("secret {n} is not readable ({}): its keys from envFrom are not listed", e.reason)),
        }
    }
    let rows = collect_env(c, &cms, &secrets);
    let services = service_addrs(&sess.get(&api_path(&Gvr::new("", "v1", "services"), None, None)).await.unwrap_or(Json::Null));
    Ok(Loaded { container: name, containers, rows, services, home_ns: ns, warnings })
}

/// The env of a workload's container with secret values masked (also MCP `get_workload_dependencies`).
pub async fn resolve_masked(state: &AppState, context: &str, obj_ref: &ObjRef, container: Option<&str>) -> Result<EnvReport> {
    let l = load(state, context, obj_ref, container).await?;
    let mut redactor = Redactor::new();
    let (rows, deps_wanted) = build_rows(&l.rows, &l.services, &l.home_ns, &mut redactor);
    let mut deps = Vec::new();
    let mut taken: Vec<String> = Vec::new();
    for (name, ns, port) in deps_wanted {
        let sref = ObjRef { context: context.into(), gvr: Gvr::new("", "v1", "services"), namespace: Some(ns.clone()), name: name.clone() };
        let info = service::info(state, context, &sref).await.ok();
        let (forward, rewrite, notes) = suggest(&name, &ns, port, info.as_ref(), &taken);
        taken.push(forward.key.clone());
        deps.push(Dependency {
            kind: info.as_ref().map_or(ServiceKind::Unknown, |i| i.kind),
            ready: info.as_ref().is_some_and(|i| i.endpoints.ready > 0),
            service: sref,
            port,
            suggested_forward: forward,
            suggested_rewrite: rewrite,
            notes,
        });
    }
    let user = local_user(|k| std::env::var(k).ok());
    let (mut warnings, overrides) = side_effects(&l.rows, &user);
    warnings.extend(l.warnings);
    Ok(EnvReport { container: l.container, containers: l.containers, rows, deps, warnings, overrides, redactions: redactor.report() })
}

/// The rows the webview / an agent sees: secret values never, other values through the redactor and
/// cleaned; hits of secret values without spans. Also returns the Services the values name.
pub fn build_rows(raw: &[RawEnv], services: &[SvcAddr], home_ns: &str, redactor: &mut Redactor) -> (Vec<EnvRow>, Vec<(String, String, u16)>) {
    let mut rows = Vec::new();
    let mut deps_wanted: Vec<(String, String, u16)> = Vec::new();
    for r in raw {
        let secret = r.source == EnvSource::Secret;
        let hits = r.value.as_deref().map(|v| addr::find_cluster_addresses(v, services, home_ns, addr::address_key(&r.key), !secret)).unwrap_or_default();
        for h in &hits {
            let k = (h.service.clone(), h.namespace.clone(), h.port);
            if !deps_wanted.contains(&k) {
                deps_wanted.push(k);
            }
        }
        let (value, masked, hits) = match (&r.value, secret) {
            (_, true) => (None, true, hits),
            (Some(v), false) => {
                let shown = redactor.env_value(&r.key, v);
                let masked = shown != *v;
                let shown = redact::clean_untrusted(&shown, redact::MAX_LINE);
                // spans index the raw value: drop them when the shown text differs
                let hits = if masked || shown != *v { hits.into_iter().map(|h| crate::ipc::Hit { span: None, ..h }).collect() } else { hits };
                (Some(shown), masked, hits)
            }
            (None, false) => (None, false, hits),
        };
        rows.push(EnvRow { key: redact::clean_untrusted(&r.key, 256), source: r.source, from: r.from.as_ref().map(|f| redact::clean_untrusted(f, 256)), value, masked, hits });
    }
    (rows, deps_wanted)
}

/// One raw value, on an explicit human action in the env view.
pub async fn reveal(state: &AppState, obj_ref: &ObjRef, container: &str, key: &str) -> Result<String> {
    let l = load(state, &obj_ref.context, obj_ref, Some(container)).await?;
    let row = l.rows.into_iter().find(|r| r.key == key).ok_or_else(|| BackendError::new(404, "NotFound", format!("no env key {key}")))?;
    row.value.ok_or_else(|| BackendError::invalid(format!("{key} has no value kns can read (a field reference or an unreadable source)")))
}

/// Pending "write to a not-ignored path" questions: token -> (path, text, counts, asked at).
#[derive(Default)]
struct PendingExports(Mutex<HashMap<String, Pending>>);

/// A file export waiting for the human: (path, text, keys, secret keys, asked at, text to type).
type Pending = (PathBuf, String, u32, u32, Instant, String);

/// The export a request asks for: spec, rewrites, forwards and allowed secret keys. With a
/// proposal everything comes from the approved payload and the ticket, never from the request.
struct Plan {
    context: String,
    spec: EnvSpec,
    rewrites: Vec<Rewrite>,
    forwards: Vec<DevForward>,
    allowed_secrets: Vec<String>,
}

async fn plan_for(state: &AppState, req: &EnvExportRequest, ticket: Option<&proposals::GateTicket>) -> Result<Plan> {
    let from_set = |id: &str| {
        let id = id.to_string();
        async move { crate::devset::get(state, &id).await?.ok_or_else(|| BackendError::new(404, "NotFound", format!("dev set {id} not found"))) }
    };
    if let Some(t) = ticket {
        return match &t.payload {
            ProposalPayload::EnvExport { dev_set, spec, rewrites } => {
                let forwards = match dev_set {
                    Some(id) => from_set(id).await?.forwards,
                    None => Vec::new(),
                };
                Ok(Plan { context: t.context.clone(), spec: spec.clone(), rewrites: rewrites.clone(), forwards, allowed_secrets: t.include_secrets().to_vec() })
            }
            ProposalPayload::DevSetUp { dev_set, export_env: Some(e), .. } => {
                let set = from_set(dev_set).await?;
                let mut spec = set.env.clone().ok_or_else(|| BackendError::invalid(format!("dev set {} has no env", set.name)))?;
                spec.format = e.format;
                Ok(Plan { context: set.context, spec, rewrites: set.rewrites, forwards: set.forwards, allowed_secrets: t.include_secrets().to_vec() })
            }
            _ => Err(BackendError::invalid(format!("proposal {} has no env export", t.proposal_id))),
        };
    }
    if let Some(id) = &req.dev_set {
        let set = from_set(id).await?;
        let spec = match &req.spec {
            Some(s) => s.clone(),
            None => set.env.clone().ok_or_else(|| BackendError::invalid(format!("dev set {} has no env", set.name)))?,
        };
        let allowed = spec.include_secrets.clone().unwrap_or_default();
        let rewrites = if req.rewrites.is_empty() { set.rewrites } else { req.rewrites.clone() };
        return Ok(Plan { context: set.context, spec, rewrites, forwards: set.forwards, allowed_secrets: allowed });
    }
    let spec = req.spec.clone().ok_or_else(|| BackendError::invalid("an export needs a dev set or an env spec"))?;
    let context = req.context.clone().ok_or_else(|| BackendError::invalid("an export of an env spec needs its context"))?;
    let allowed = spec.include_secrets.clone().unwrap_or_default();
    Ok(Plan { context, spec, rewrites: req.rewrites.clone(), forwards: req.forwards.clone().unwrap_or_default(), allowed_secrets: allowed })
}

/// Builds the text of an export.
async fn build(state: &AppState, context: &str, plan: &Plan) -> Result<(String, u32, u32)> {
    let w = &plan.spec.workload;
    let obj_ref = ObjRef { context: context.into(), gvr: w.gvr.clone(), namespace: Some(w.namespace.clone()), name: w.name.clone() };
    let l = load(state, context, &obj_ref, plan.spec.container.as_deref()).await?;
    let ports: HashMap<String, u16> = plan.forwards.iter().map(|f| (f.key.clone(), f.local_port)).collect();
    let (entries, secret_keys) = export_entries(&l.rows, &plan.spec, &plan.allowed_secrets, &plan.rewrites, &ports, &l.services, &l.home_ns);
    let header = format!("kns env export: {}/{} ({}) in {context}; {} keys, {secret_keys} from secrets", w.gvr.resource, w.name, l.container, entries.len());
    let text = format_env(&entries, plan.spec.format, &redact::clean_untrusted(&header, 300));
    Ok((text, entries.len() as u32, secret_keys))
}

/// The native save dialog, opened by Rust; `None` when the human closed it.
async fn save_dialog(state: &AppState) -> Result<Option<PathBuf>> {
    use tauri_plugin_dialog::DialogExt;
    let app = state.app().ok_or_else(|| BackendError::internal("no window for the save dialog"))?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_file_name(".env.kns");
    if let Some(home) = dirs::home_dir() {
        dialog = dialog.set_directory(home);
    }
    dialog.save_file(move |path| {
        let _ = tx.send(path.and_then(|p| p.into_path().ok()));
    });
    rx.await.map_err(|_| BackendError::internal("the save dialog went away"))
}

fn result(keys: u32, secret_keys: u32) -> EnvExportResult {
    EnvExportResult { keys, secret_keys, path: None, cancelled: None, clear_seconds: None, history_excluded: None, confirm: None, warnings: Vec::new() }
}

/// The `env_export` command (§3 B-dev): see the module docs for the rules.
pub async fn export(state: &AppState, req: EnvExportRequest) -> Result<EnvExportResult> {
    let ticket = match &req.proposal_id {
        Some(id) => Some(proposals::gate(state, id, "export")?),
        None => None,
    };
    let outcome = export_inner(state, &req, ticket.as_ref()).await;
    if let Some(t) = &ticket {
        let data = outcome.as_ref().map(|r| {
            if r.cancelled == Some(true) {
                serde_json::json!({ "cancelled": true })
            } else {
                serde_json::json!({ "keys": r.keys, "secretKeys": r.secret_keys, "path": r.path })
            }
        });
        proposals::finish_step(state, t, data.map_err(Clone::clone))?;
    }
    outcome
}

async fn export_inner(state: &AppState, req: &EnvExportRequest, ticket: Option<&proposals::GateTicket>) -> Result<EnvExportResult> {
    if ticket.is_some() && (req.destination != ExportDestination::File || req.confirm_token.is_some()) {
        return Err(BackendError::invalid("an agent's export goes to a file chosen in the save dialog"));
    }
    // a confirmed write to a path Rust asked about
    if let Some(token) = &req.confirm_token {
        let pending_store = state.ext::<PendingExports>();
        let mut map = lock(&pending_store.0);
        if let Some(p) = map.get(token)
            && p.4.elapsed() < CONFIRM_TTL
            && !confirm_text_ok(&p.5, req.confirm_text.as_deref())
        {
            return Err(confirm_mismatch(&p.5));
        }
        let pending = map.remove(token);
        drop(map);
        let Some((path, text, keys, secret_keys, _, _)) = pending.filter(|p| p.4.elapsed() < CONFIRM_TTL) else {
            return Err(BackendError::invalid("that export question expired; export again"));
        };
        write_file(&path, &text)?;
        return Ok(EnvExportResult { path: Some(path.display().to_string()), ..result(keys, secret_keys) });
    }
    let plan = plan_for(state, req, ticket).await?;
    if ticket.is_none() {
        protected_confirm(state, &plan.context, &plan.spec.workload.name, req.confirm_text.as_deref())?;
    }
    let (text, keys, secret_keys) = build(state, &plan.context, &plan).await?;
    match req.destination {
        ExportDestination::Clipboard => {
            let secs = req.clear_seconds.unwrap_or(60);
            let written = clip::write_secret(&text, clip::clear_after(u64::from(secs)))?;
            Ok(EnvExportResult { clear_seconds: Some(secs.clamp(5, 600)), history_excluded: Some(written.excluded), ..result(keys, secret_keys) })
        }
        ExportDestination::File => {
            let Some(path) = save_dialog(state).await? else { return Ok(EnvExportResult { cancelled: Some(true), ..result(0, 0) }) };
            let mut warnings = Vec::new();
            if let Some(what) = cloud_folder(&path, |k| std::env::var(k).ok(), dirs::home_dir().as_deref()) {
                warnings.push(format!("the folder is synced by {what}: the file is uploaded with it"));
            }
            if let GitCheck::NotIgnored { root } = git_check(&path) {
                let reason = format!("{} is inside the git work tree {} and is not git-ignored", path.display(), root.display());
                if ticket.is_some() {
                    return Err(BackendError::invalid(format!("{reason}; an agent's export must go to a git-ignored path")));
                }
                let token = state.next_id("export-");
                let pending = state.ext::<PendingExports>();
                let mut map = lock(&pending.0);
                // expired questions hold secret text: drop them
                map.retain(|_, p| p.4.elapsed() < CONFIRM_TTL);
                let expect = plan.spec.workload.name.clone();
                map.insert(token.clone(), (path.clone(), text, keys, secret_keys, Instant::now(), expect.clone()));
                drop(map);
                return Ok(EnvExportResult {
                    confirm: Some(ExportConfirm { token, path: path.display().to_string(), reason, type_to_confirm: expect }),
                    warnings,
                    ..result(keys, secret_keys)
                });
            }
            write_file(&path, &text)?;
            Ok(EnvExportResult { path: Some(path.display().to_string()), warnings, ..result(keys, secret_keys) })
        }
    }
}

pub mod cmd {
    use super::AppState;
    use crate::ipc::{EnvExportRequest, EnvExportResult, EnvReport, ObjRef, Result, VolumeReport, VolumesExportRequest, VolumesExportResult};

    #[tauri::command]
    pub async fn env_resolve(state: tauri::State<'_, AppState>, obj_ref: ObjRef, container: Option<String>) -> Result<EnvReport> {
        let context = obj_ref.context.clone();
        super::resolve_masked(&state, &context, &obj_ref, container.as_deref()).await
    }

    #[tauri::command]
    pub async fn env_reveal(state: tauri::State<'_, AppState>, obj_ref: ObjRef, container: String, key: String) -> Result<String> {
        super::reveal(&state, &obj_ref, &container, &key).await
    }

    #[tauri::command]
    pub async fn env_export(state: tauri::State<'_, AppState>, req: EnvExportRequest) -> Result<EnvExportResult> {
        super::export(&state, req).await
    }

    /// B2: the ConfigMap / Secret volumes a workload's container mounts (file names only).
    #[tauri::command]
    pub async fn volumes_list(state: tauri::State<'_, AppState>, obj_ref: ObjRef, container: Option<String>) -> Result<VolumeReport> {
        super::volumes_list(&state, &obj_ref, container.as_deref()).await
    }

    /// B2: humans only; writes the chosen volumes' files under a folder picked in a Rust dialog.
    #[tauri::command]
    pub async fn volumes_export(state: tauri::State<'_, AppState>, req: VolumesExportRequest) -> Result<VolumesExportResult> {
        super::volumes_export(&state, req).await
    }
}

#[cfg(test)]
mod tests {
    /// §6.6 f: the typed confirmation is compared in Rust.
    #[test]
    fn typed_confirm_is_checked_in_rust() {
        assert!(confirm_text_ok("orders", Some("orders")));
        assert!(confirm_text_ok("orders", Some(" orders ")));
        assert!(!confirm_text_ok("orders", Some("Orders")));
        assert!(!confirm_text_ok("orders", Some("")));
        assert!(!confirm_text_ok("orders", None));
    }

    /// §6.6 open item: a protected context's export needs the typed workload name, in Rust.
    #[test]
    fn protected_export_needs_the_typed_name_in_rust() {
        let state = AppState::default();
        assert_eq!(protected_confirm(&state, "prod", "web", Some("web")).unwrap_err().reason, "NotLoaded", "deny until the flags are read");
        let flags = HashMap::from([("prod".to_string(), crate::ctxflags::CtxFlags { protected: true, read_only: false })]);
        crate::ctxflags::set(&state, Some(flags));
        assert!(protected_confirm(&state, "default", "web", None).is_ok());
        assert_eq!(protected_confirm(&state, "prod", "web", None).unwrap_err().reason, "ConfirmText");
        assert_eq!(protected_confirm(&state, "prod", "web", Some("prod")).unwrap_err().reason, "ConfirmText");
        assert!(protected_confirm(&state, "prod", "web", Some(" web ")).is_ok());
    }

    use serde_json::json;

    use super::*;
    use crate::ipc::{Endpoints, KafkaListener, ServiceInfo, ServicePort, Workload};

    const SECRET: &str = "s3cr3t-pw-value";

    /// The envdemo / orders shape: literals, envFrom ConfigMap, secretKeyRef, envFrom secret, fields.
    fn container() -> Json {
        json!({
            "name": "app",
            "envFrom": [{ "configMapRef": { "name": "envdemo" } }, { "secretRef": { "name": "extra" }, "prefix": "X_" }],
            "env": [
                { "name": "WEB_URL", "value": "http://web.kns-spike.svc.cluster.local:80" },
                { "name": "PASSWORD", "valueFrom": { "secretKeyRef": { "name": "envdemo", "key": "PASSWORD" } } },
                { "name": "DATABASE_URL", "valueFrom": { "secretKeyRef": { "name": "envdemo", "key": "DATABASE_URL" } } },
                { "name": "KAFKA_CONSUMER_GROUP_ID", "value": "envdemo" },
                { "name": "LOG_LEVEL", "value": "debug" },
                { "name": "POD_IP", "valueFrom": { "fieldRef": { "fieldPath": "status.podIP" } } },
                { "name": "MEM", "valueFrom": { "resourceFieldRef": { "resource": "limits.memory" } } },
                { "name": "EMPTY" }
            ]
        })
    }

    type Data = HashMap<String, BTreeMap<String, String>>;

    fn data() -> (Data, Data) {
        let cm = object_data(&json!({ "data": { "LOG_LEVEL": "info", "application.yaml": "password: x\n", "DB_HOST": "db" } }), false);
        let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
        let secret = object_data(
            &json!({ "data": { "PASSWORD": b64(SECRET), "DATABASE_URL": b64(&format!("postgres://app:{SECRET}@db.kns-spike.svc:5432/app")), "BIN": "%%%" } }),
            true,
        );
        let extra = object_data(&json!({ "data": { "TOKEN": b64(SECRET) } }), true);
        (HashMap::from([("envdemo".to_string(), cm)]), HashMap::from([("envdemo".to_string(), secret), ("extra".to_string(), extra)]))
    }

    fn rows() -> Vec<RawEnv> {
        let (cms, secrets) = data();
        collect_env(&container(), &cms, &secrets)
    }

    fn services() -> Vec<SvcAddr> {
        vec![
            SvcAddr { name: "web".into(), namespace: "kns-spike".into(), ports: vec![80] },
            SvcAddr { name: "db".into(), namespace: "kns-spike".into(), ports: vec![5432] },
        ]
    }

    #[test]
    fn collects_env_with_precedence_and_sources() {
        let r = rows();
        let get = |k: &str| r.iter().find(|x| x.key == k).unwrap_or_else(|| panic!("{k}"));
        assert_eq!(get("LOG_LEVEL").source, EnvSource::Literal, "env wins over envFrom");
        assert_eq!(get("LOG_LEVEL").value.as_deref(), Some("debug"));
        assert_eq!(get("application.yaml").source, EnvSource::ConfigMap);
        assert_eq!(get("X_TOKEN").source, EnvSource::Secret, "envFrom secretRef keys are secret, with the prefix");
        assert_eq!(get("PASSWORD").from.as_deref(), Some("secret/envdemo:PASSWORD"));
        assert_eq!(get("POD_IP").source, EnvSource::Field);
        assert_eq!(get("MEM").source, EnvSource::ResourceField);
        assert_eq!(get("EMPTY").value.as_deref(), Some(""));
        assert!(r.iter().all(|x| x.key != "BIN"), "binary secret values are skipped");
        let (cms, secrets) = referenced(&container());
        assert_eq!((cms, secrets), (vec!["envdemo".to_string()], vec!["extra".to_string(), "envdemo".to_string()]));
        assert_eq!(container_names(&json!({ "containers": [{ "name": "a" }, { "name": "b" }] })), vec!["a", "b"]);
    }

    #[test]
    fn rows_never_carry_secret_values() {
        let mut raw = rows();
        raw.push(RawEnv { key: "DB_PASSWORD".into(), source: EnvSource::Literal, from: None, value: Some(SECRET.into()) });
        raw.push(RawEnv { key: "CALLBACK".into(), source: EnvSource::Literal, from: None, value: Some(format!("https://u:{SECRET}@web.kns-spike:80/cb")) });
        raw.push(RawEnv { key: "OTEL_SERVICE_NAME".into(), source: EnvSource::Literal, from: None, value: Some("web".into()) });
        let mut redactor = Redactor::new();
        let (out, deps) = build_rows(&raw, &services(), "kns-spike", &mut redactor);
        let json = serde_json::to_string(&out).unwrap();
        assert!(!json.contains(SECRET), "mustNotContain: {json}");
        let get = |k: &str| out.iter().find(|r| r.key == k).unwrap();
        assert!(get("PASSWORD").value.is_none() && get("PASSWORD").masked);
        assert_eq!(get("DATABASE_URL").hits.len(), 1, "the secret's address is found");
        assert!(get("DATABASE_URL").hits[0].span.is_none(), "but never located");
        assert!(get("DB_PASSWORD").masked, "a secret-named literal is masked");
        assert!(get("CALLBACK").hits.iter().all(|h| h.span.is_none()), "spans dropped when the shown value differs");
        assert!(get("OTEL_SERVICE_NAME").hits.is_empty(), "an app name is not an address");
        assert!(deps.contains(&("web".into(), "kns-spike".into(), 80)) && deps.contains(&("db".into(), "kns-spike".into(), 5432)));
        assert!(redactor.report().count >= 2);
    }

    #[test]
    fn side_effects_never_echo_secrets() {
        let mut r = rows();
        r.push(RawEnv { key: "STREAMS_APPLICATION_ID".into(), source: EnvSource::Secret, from: None, value: Some(SECRET.into()) });
        r.push(RawEnv { key: "SPRING_FLYWAY_ENABLED".into(), source: EnvSource::Literal, from: None, value: Some("true".into()) });
        r.push(RawEnv { key: "DB_MIGRATE".into(), source: EnvSource::Literal, from: None, value: Some("false".into()) });
        r.push(RawEnv { key: "CONSUMER_GROUP_TOKEN".into(), source: EnvSource::Literal, from: None, value: Some(SECRET.into()) });
        let (warnings, overrides) = side_effects(&r, "dev");
        assert!(warnings.iter().any(|w| w.contains("KAFKA_CONSUMER_GROUP_ID=envdemo") && w.contains("envdemo-local-dev")));
        assert!(warnings.iter().any(|w| w.starts_with("STREAMS_APPLICATION_ID:")));
        assert!(warnings.iter().any(|w| w.starts_with("SPRING_FLYWAY_ENABLED")));
        assert!(!warnings.iter().any(|w| w.starts_with("DB_MIGRATE")), "already off");
        assert!(overrides.contains(&EnvOverride { key: "KAFKA_CONSUMER_GROUP_ID".into(), value: "envdemo-local-dev".into() }));
        assert!(overrides.contains(&EnvOverride { key: "SPRING_FLYWAY_ENABLED".into(), value: "false".into() }));
        let all = format!("{warnings:?}{overrides:?}");
        assert!(!all.contains(SECRET), "mustNotContain");
        assert_eq!(local_user(|k| (k == "USERNAME").then(|| "C. Moen".to_string())), "c--moen");
        assert_eq!(local_user(|_| None), "me");
    }

    fn kafka_info(local: bool) -> ServiceInfo {
        let mut listeners = vec![KafkaListener { name: "INTERNAL".into(), advertised: "kafka.kafka.svc.cluster.local:9092".into(), protocol: None }];
        if local {
            listeners.push(KafkaListener { name: "LOCAL".into(), advertised: "localhost:9094".into(), protocol: None });
        }
        ServiceInfo {
            obj_ref: ObjRef { context: "default".into(), gvr: Gvr::new("", "v1", "services"), namespace: Some("kafka".into()), name: "kafka".into() },
            type_: "ClusterIP".into(),
            ports: vec![
                ServicePort { name: Some("internal".into()), port: 9092, target_port: PortRef::Number(9092), protocol: "TCP".into(), app_protocol: None },
                ServicePort { name: Some("local".into()), port: 9094, target_port: PortRef::Name("local".into()), protocol: "TCP".into(), app_protocol: None },
            ],
            selector: None,
            endpoints: Endpoints { ready: 1, not_ready: 0, pods: vec!["kafka-0".into()] },
            kind: ServiceKind::Kafka,
            kafka_listeners: Some(listeners),
            hints: None,
        }
    }

    #[test]
    fn suggestions_take_k9s_local_ports_but_kafka_local_wins() {
        let hint = |remote: u16, local: u16| crate::ipc::PortHint { container: None, remote_port: PortRef::Number(remote), local_port: Some(local), auto: false };
        let pg = ServiceInfo {
            kind: ServiceKind::Postgres,
            kafka_listeners: None,
            hints: Some(vec![hint(5432, 25432)]),
            ports: vec![ServicePort { name: None, port: 5432, target_port: PortRef::Number(5432), protocol: "TCP".into(), app_protocol: None }],
            ..kafka_info(false)
        };
        let (f, _, notes) = suggest("postgres", "payments", 5432, Some(&pg), &[]);
        assert_eq!((f.local_port, f.pin), (25432, true));
        assert!(notes[0].contains("k9scli.io"), "{notes:?}");
        let low = ServiceInfo { hints: Some(vec![hint(5432, 80)]), ..pg };
        assert_eq!(suggest("postgres", "payments", 5432, Some(&low), &[]).0.local_port, 15432, "below 1024: ignored");
        let kafka = ServiceInfo { hints: Some(vec![hint(9092, 29092)]), ..kafka_info(true) };
        assert_eq!(suggest("kafka", "kafka", 9092, Some(&kafka), &[]).0.local_port, 9094, "the LOCAL listener wins");
    }

    #[test]
    fn suggestions_offset_ports_and_kafka_local_listener() {
        let (f, rw, notes) = suggest("kafka", "kafka", 9092, Some(&kafka_info(true)), &[]);
        assert_eq!((f.remote_port.clone(), f.local_port, f.pin), (PortRef::Number(9094), 9094, true), "LOCAL listener, exact port, pinned");
        assert_eq!(rw.r#match.port, 9092, "the env value's address is what is rewritten");
        assert_eq!(notes, vec!["advertised as kafka.kafka.svc.cluster.local:9092; use listener LOCAL, pinned 9094".to_string()]);
        let (f, _, notes) = suggest("kafka", "kafka", 9092, Some(&kafka_info(false)), &[]);
        assert_eq!(f.local_port, 19092);
        assert!(notes[0].contains("Add a listener advertising localhost:19092"));
        let (pg, _, _) = suggest("postgres", "payments", 5432, None, &[]);
        assert_eq!((pg.local_port, pg.key.as_str()), (15432, "postgres"));
        assert_eq!(offset_port(80), 10080);
        assert_eq!(offset_port(60000), 60000);
        assert_eq!(forward_key("postgres", "payments", &["postgres".into()]), "postgres-payments");
        assert_eq!(forward_key("Kafka_UI", "kafka", &[]), "kafka-ui");
    }

    fn spec() -> EnvSpec {
        EnvSpec {
            workload: Workload { gvr: Gvr::new("apps", "v1", "deployments"), namespace: "kns-spike".into(), name: "envdemo".into() },
            container: None,
            include: None,
            exclude: Some(vec!["LOG_LEVEL".into()]),
            include_secrets: None,
            overrides: Some(vec![EnvOverride { key: "KAFKA_CONSUMER_GROUP_ID".into(), value: "envdemo-local-me".into() }]),
            format: EnvFormat::Dotenv,
        }
    }

    fn rewrites() -> Vec<Rewrite> {
        let rw = |service: &str, port: u16, to: &str| Rewrite {
            r#match: RewriteMatch { service: service.into(), namespace: "kns-spike".into(), port },
            env_key: None,
            to: RewriteTo { forward: to.into() },
        };
        vec![rw("web", 80, "web"), rw("db", 5432, "db")]
    }

    #[test]
    fn export_entries_follow_the_spec() {
        let ports = HashMap::from([("web".to_string(), 18080u16), ("db".to_string(), 15432u16)]);
        let (entries, secrets) = export_entries(&rows(), &spec(), &[], &rewrites(), &ports, &services(), "kns-spike");
        let get = |k: &str| entries.iter().find(|(x, _)| x == k).map(|(_, v)| v.as_str());
        assert_eq!(get("WEB_URL"), Some("http://localhost:18080"));
        assert_eq!(get("LOG_LEVEL"), None, "excluded");
        assert_eq!(get("PASSWORD"), None, "secrets only when allowed");
        assert_eq!(get("POD_IP"), None, "field refs cannot be known locally");
        assert_eq!(get("application.yaml"), None, "not an env key a shell accepts");
        assert_eq!(get("KAFKA_CONSUMER_GROUP_ID"), Some("envdemo-local-me"), "override");
        assert_eq!(secrets, 0);
        assert!(!format!("{entries:?}").contains(SECRET));
        let (entries, secrets) = export_entries(&rows(), &spec(), &["DATABASE_URL".into()], &rewrites(), &ports, &services(), "kns-spike");
        assert_eq!(secrets, 1);
        let url = entries.iter().find(|(k, _)| k == "DATABASE_URL").unwrap().1.clone();
        assert_eq!(url, format!("postgres://app:{SECRET}@localhost:15432/app"), "secret values are rewritten too");
        // envKey limits a rewrite to one key
        let mut only = rewrites();
        only[0].env_key = Some("OTHER".into());
        let (entries, _) = export_entries(&rows(), &spec(), &[], &only, &ports, &services(), "kns-spike");
        assert_eq!(entries.iter().find(|(k, _)| k == "WEB_URL").unwrap().1, "http://web.kns-spike.svc.cluster.local:80");
    }

    #[test]
    fn formats() {
        let e = vec![("A".to_string(), "plain".to_string()), ("B".to_string(), "it's \"x\" $y".to_string())];
        assert_eq!(format_env(&e, EnvFormat::Dotenv, "h"), "# h\nA=plain\nB=\"it's \\\"x\\\" \\$y\"\n");
        assert_eq!(format_env(&e, EnvFormat::Posix, "h"), "# h\nexport A='plain'\nexport B='it'\\''s \"x\" $y'\n");
        assert_eq!(format_env(&e, EnvFormat::Powershell, "h"), "# h\r\n$env:A = 'plain'\r\n$env:B = 'it''s \"x\" $y'\r\n");
        assert!(valid_key("_A1") && !valid_key("1A") && !valid_key("a.b") && !valid_key(""));
    }

    #[test]
    fn gitignore_matching() {
        let root = std::env::temp_dir().join(format!("kns-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".git/info")).unwrap();
        std::fs::create_dir_all(root.join("app/sub")).unwrap();
        std::fs::write(root.join(".gitignore"), ".env*\n!.env.example\n").unwrap();
        std::fs::write(root.join("app/.gitignore"), "!.env.keep\n").unwrap();
        std::fs::write(root.join(".git/info/exclude"), "local/\n").unwrap();
        assert_eq!(git_check(&root.join(".env.kns")), GitCheck::Ignored);
        assert_eq!(git_check(&root.join("app/sub/.env.kns")), GitCheck::Ignored, "a parent .gitignore covers subfolders");
        assert_eq!(git_check(&root.join(".env.example")), GitCheck::NotIgnored { root: root.clone() });
        assert_eq!(git_check(&root.join("app/.env.keep")), GitCheck::NotIgnored { root: root.clone() }, "a deeper negation wins");
        assert_eq!(git_check(&root.join("config.env")), GitCheck::NotIgnored { root: root.clone() });
        assert_eq!(git_check(&root.join("local/x.env")), GitCheck::Ignored, ".git/info/exclude");
        let outside = std::env::temp_dir().join(format!("kns-nogit-{}", std::process::id())).join(".env.kns");
        std::fs::create_dir_all(outside.parent().unwrap()).unwrap();
        assert_eq!(git_check(&outside), GitCheck::NotInRepo);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(outside.parent().unwrap());
    }

    #[test]
    fn cloud_folders() {
        let home = Path::new("/home/u");
        // `Path` only splits on '\\' on Windows, so the env-root case needs a native path per platform
        #[cfg(windows)]
        let (root, file) = ("C:\\Users\\u\\OneDrive", "C:\\Users\\u\\OneDrive\\Desktop\\.env");
        #[cfg(not(windows))]
        let (root, file) = ("/mnt/sync/u", "/mnt/sync/u/Desktop/.env");
        let env = |k: &str| (k == "OneDrive").then(|| root.to_string());
        assert_eq!(cloud_folder(Path::new(file), env, None), Some("OneDrive"));
        assert_eq!(cloud_folder(Path::new("/home/u/Dropbox/x/.env"), |_| None, Some(home)), Some("Dropbox"));
        assert_eq!(cloud_folder(Path::new("/home/u/Library/Mobile Documents/x/.env"), |_| None, Some(home)), Some("iCloud Drive"));
        assert_eq!(cloud_folder(Path::new("/home/u/Library/CloudStorage/GoogleDrive/.env"), |_| None, Some(home)), Some("a cloud storage provider"));
        assert_eq!(cloud_folder(Path::new("/home/u/OneDrive - Corp/.env"), |_| None, Some(home)), Some("OneDrive"));
        assert_eq!(cloud_folder(Path::new("/home/u/src/app/.env"), |_| None, Some(home)), None);
    }

    #[test]
    fn safe_relative_paths_only() {
        assert_eq!(safe_rel_path("application.yaml"), Some(PathBuf::from("application.yaml")));
        assert_eq!(safe_rel_path("conf/app.yaml"), Some(PathBuf::from("conf").join("app.yaml")));
        for bad in ["", "/etc/passwd", "../x", "a/../b", "a/./b", "a//b", "C:\\x", "C:x", "a\\b", "\\\\server\\share", "a/b.", "a\u{0}b", "con ", "x/.."] {
            assert_eq!(safe_rel_path(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn volumes_of_a_container() {
        let spec = json!({
            "containers": [{"name": "app", "volumeMounts": [
                {"name": "config", "mountPath": "/config"},
                {"name": "creds", "mountPath": "/creds"},
                {"name": "all", "mountPath": "/all"},
            ]}],
            "volumes": [
                {"name": "config", "configMap": {"name": "envdemo"}},
                {"name": "creds", "secret": {"secretName": "envdemo", "items": [{"key": "PASSWORD", "path": "db/password"}, {"key": "X", "path": "../evil"}]}},
                {"name": "all", "projected": {"sources": [{"configMap": {"name": "a"}}, {"secret": {"name": "b"}}, {"serviceAccountToken": {"path": "t"}}]}},
                {"name": "unmounted", "configMap": {"name": "other"}},
                {"name": "scratch", "emptyDir": {}},
            ],
        });
        let c = &spec["containers"][0];
        let v = volume_specs(&spec, c);
        let ids: Vec<(&str, VolumeSource)> = v.iter().map(|x| (x.id.as_str(), x.source)).collect();
        assert_eq!(ids, vec![("config", VolumeSource::ConfigMap), ("creds", VolumeSource::Secret), ("all/a", VolumeSource::ConfigMap), ("all/b", VolumeSource::Secret)]);
        assert_eq!(v[0].mount_path.as_deref(), Some("/config"));

        let cm = object_bytes(&json!({"data": {"application.yaml": "password: x"}, "binaryData": {"logo.bin": "AAE="}}), false);
        let files = volume_files(&v[0], &cm);
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|(p, b)| p == &PathBuf::from("logo.bin") && b == &vec![0u8, 1]));
        let secret = object_bytes(&json!({"data": {"PASSWORD": "czNjcjN0", "X": "eA=="}}), true);
        let files = volume_files(&v[1], &secret);
        assert_eq!(files, vec![(PathBuf::from("db").join("password"), b"s3cr3t".to_vec())], "items rename; an unsafe path is skipped");
    }

    #[test]
    fn volume_writes_ask_before_replacing_or_writing_into_a_repo() {
        let root = std::env::temp_dir().join(format!("kns-vol-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let folder = root.join("out");
        std::fs::create_dir_all(&folder).unwrap();
        let files = vec![(PathBuf::from("config").join("a.yaml"), b"x".to_vec())];
        assert_eq!(volumes_confirm_reason(&folder, &files), None, "outside a repo, nothing there");
        write_volumes(&folder, &files).unwrap();
        assert_eq!(std::fs::read(folder.join("config").join("a.yaml")).unwrap(), b"x");
        assert!(volumes_confirm_reason(&folder, &files).unwrap().contains("replaced"));
        // inside a work tree, not ignored
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let fresh = vec![(PathBuf::from("new").join("b"), b"y".to_vec())];
        assert!(volumes_confirm_reason(&folder, &fresh).unwrap().contains("not git-ignored"));
        std::fs::write(root.join(".gitignore"), "out/\n").unwrap();
        assert_eq!(volumes_confirm_reason(&folder, &fresh), None, "git-ignored");
        let _ = std::fs::remove_dir_all(&root);
    }
}
