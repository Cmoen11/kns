//! Database view (`:db`, docs/tools.md#database): browse a Postgres or MySQL/MariaDB server that
//! runs in a pod, from inside kns.
//!
//! - **Detect.** The pod spec says what runs: a container whose image is a database server
//!   (`postgres`, `bitnami/postgresql`, `cloudnative-pg/postgresql`, `mysql`, `mariadb`, ...; not
//!   exporters, poolers or operators), else one with the engine's env keys, else one listening on
//!   5432 / 3306. A workload or Service is opened through its running pod, the primary when the
//!   pod is labelled as one (CloudNativePG, Zalando, Crunchy, Bitnami).
//! - **Credentials.** From the container's env as Kubernetes resolves it (`env`, `envFrom`,
//!   Secret and ConfigMap refs, `*_FILE` pointing into a mounted Secret) and from the Secrets
//!   that Postgres operators write (CloudNativePG `<cluster>-app` / `-superuser`, Zalando and
//!   Crunchy user secrets). Passwords never leave Rust: the UI is told where one comes from.
//! - **Tunnel.** A port-forward stream to the pod, private to the connection: Postgres runs its
//!   protocol straight over the stream; MySQL gets a loopback listener that takes exactly one
//!   connection. Postgres TLS is used when the server offers it, without certificate checks: the
//!   stream already runs inside the API server's authenticated tunnel, and the certificate cannot
//!   name 127.0.0.1 (libpq's `sslmode=require`).
//! - **Read-only by default.** A query must be one statement (the server prepares it first) of a
//!   reading kind (SELECT, WITH, VALUES, TABLE, SHOW, EXPLAIN, DESCRIBE) and runs in a read-only
//!   transaction that is rolled back. `write: true` runs it read-write and commits; refused in a
//!   read-only context, and a protected context needs the database name typed (checked here).
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use k8s_openapi::api::core::v1::Pod;
use kube::api::Api;
use tokio::{io::copy_bidirectional, net::TcpListener, time::timeout};
use tokio_util::sync::CancellationToken;

use crate::{
    contract::{
        DbColumn, DbConnectRequest, DbCredential, DbEngine, DbIndex, DbQueryRequest, DbResult, DbResultColumn, DbRowsRequest, DbSchema, DbSchemaEntry, DbSession, DbTableEntry,
        DbTableInfo, DbTableRequest, DbTarget,
    },
    env::{self, RawEnv},
    forward::pod_spec,
    ipc::{BackendError, Gvr, Json, ObjRef, Result},
    objects, redact,
    session::{Session, api_path, with_query},
    state::{AppState, lock},
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Sessions nobody used for this long are closed when another one opens.
const IDLE_CLOSE: Duration = Duration::from_secs(30 * 60);
/// A cell longer than this is cut (characters).
const MAX_CELL: usize = 16 * 1024;
const DEFAULT_LIMIT: u32 = 500;
const MAX_LIMIT: u32 = 5000;
const STATEMENT_TIMEOUT_MS: u32 = 60_000;

// ───────────────────────── detection (pure) ─────────────────────────

fn arr(v: Option<&Json>) -> &[Json] {
    v.and_then(Json::as_array).map(Vec::as_slice).unwrap_or_default()
}

fn s<'a>(v: &'a Json, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Json::as_str)
}

/// The engine a container image runs, or `None` (also for a database's side tools: exporters,
/// poolers, operators, admin UIs, backup jobs).
pub fn engine_of_image(image: &str) -> Option<DbEngine> {
    let image = image.to_ascii_lowercase();
    // registry/path/name:tag@digest -> path/name
    let no_digest = image.split('@').next().unwrap_or_default();
    let path = match no_digest.rsplit_once(':') {
        Some((p, tag)) if !tag.contains('/') => p,
        _ => no_digest,
    };
    let name = path.rsplit('/').next().unwrap_or_default();
    const TOOLS: [&str; 14] = ["exporter", "operator", "bouncer", "pgadmin", "backup", "backrest", "pooler", "proxy", "router", "orchestrator", "phpmyadmin", "adminer", "metrics", "agent"];
    if TOOLS.iter().any(|t| name.contains(t)) {
        return None;
    }
    const PG: [&str; 7] = ["postgres", "postgis", "timescale", "pgvector", "spilo", "paradedb", "pgvecto"];
    const MY: [&str; 4] = ["mysql", "mariadb", "percona-server", "percona-xtradb"];
    if PG.iter().any(|w| name.contains(w)) || name == "pg" {
        return Some(DbEngine::Postgres);
    }
    if MY.iter().any(|w| name.contains(w)) {
        return Some(DbEngine::Mysql);
    }
    None
}

fn default_port(engine: DbEngine) -> u16 {
    match engine {
        DbEngine::Postgres => 5432,
        DbEngine::Mysql => 3306,
    }
}

/// The engine the env of a container is written for (the official and Bitnami images' keys).
fn engine_of_env(c: &Json) -> Option<DbEngine> {
    let keys: Vec<&str> = arr(c.get("env")).iter().filter_map(|e| s(e, "name")).collect();
    if keys.iter().any(|k| k.starts_with("POSTGRES_") || k.starts_with("POSTGRESQL_") || k.starts_with("PGDATA")) {
        return Some(DbEngine::Postgres);
    }
    if keys.iter().any(|k| k.starts_with("MYSQL_") || k.starts_with("MARIADB_")) {
        return Some(DbEngine::Mysql);
    }
    None
}

/// The port of the server in a container: a declared port with the engine's number or name, else
/// the engine's default port.
fn server_port(c: &Json, engine: DbEngine) -> u16 {
    let ports = arr(c.get("ports"));
    let want = default_port(engine);
    let names: &[&str] = match engine {
        DbEngine::Postgres => &["postgres", "postgresql", "tcp-postgresql", "pg", "tcp-postgres"],
        DbEngine::Mysql => &["mysql", "tcp-mysql", "mariadb", "tcp-mariadb"],
    };
    let number = |p: &Json| p.get("containerPort").and_then(Json::as_u64).and_then(|n| u16::try_from(n).ok());
    if ports.iter().any(|p| number(p) == Some(want)) {
        return want;
    }
    ports.iter().find(|p| s(p, "name").is_some_and(|n| names.contains(&n))).and_then(number).unwrap_or(want)
}

/// The container that runs a database server: (container name, image, engine, port).
pub fn detect_container(spec: &Json) -> Option<(String, String, DbEngine, u16)> {
    let cs = arr(spec.get("containers"));
    let found = |c: &Json, e: DbEngine| Some((s(c, "name")?.to_string(), s(c, "image").unwrap_or_default().to_string(), e, server_port(c, e)));
    // by image, then by env, then by a well-known port
    for c in cs {
        if let Some(e) = s(c, "image").and_then(engine_of_image) {
            return found(c, e);
        }
    }
    for c in cs {
        if let Some(e) = engine_of_env(c) {
            return found(c, e);
        }
    }
    for c in cs {
        for p in arr(c.get("ports")) {
            match p.get("containerPort").and_then(Json::as_u64) {
                Some(5432) => return found(c, DbEngine::Postgres),
                Some(3306) => return found(c, DbEngine::Mysql),
                _ => {}
            }
        }
    }
    None
}

/// A credential with its password (Rust only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cred {
    pub shown: DbCredential,
    pub password: Option<String>,
}

fn first<'a>(env: &'a [RawEnv], keys: &[&str]) -> Option<&'a RawEnv> {
    keys.iter().find_map(|k| env.iter().find(|e| e.key == *k && e.value.as_deref().is_some_and(|v| !v.is_empty())))
}

fn origin(e: &RawEnv) -> String {
    match &e.from {
        Some(f) => format!("env {} ({f})", e.key),
        None => format!("env {}", e.key),
    }
}

fn push(out: &mut Vec<Cred>, c: Cred) {
    if !out.iter().any(|x| x.shown.user == c.shown.user && x.password == c.password) {
        out.push(c);
    }
}

/// The users the env of the server's container configures, best first.
pub fn env_credentials(engine: DbEngine, env: &[RawEnv]) -> Vec<Cred> {
    let val = |e: Option<&RawEnv>| e.and_then(|e| e.value.clone());
    let mut out = Vec::new();
    match engine {
        DbEngine::Postgres => {
            let user_env = first(env, &["POSTGRES_USER", "POSTGRESQL_USERNAME", "POSTGRESQL_USER", "PGUSER"]);
            let user = val(user_env).unwrap_or_else(|| "postgres".into());
            let pass = first(env, &["POSTGRES_PASSWORD", "POSTGRESQL_PASSWORD", "PGPASSWORD"]);
            let db = val(first(env, &["POSTGRES_DB", "POSTGRESQL_DATABASE", "PGDATABASE"]));
            // the official image creates POSTGRES_DB, else a database named like the user
            let database = db.or_else(|| user_env.is_some().then(|| user.clone()));
            if let Some(p) = pass {
                push(&mut out, Cred { shown: DbCredential { user: user.clone(), database: database.clone(), from: Some(origin(p)) }, password: p.value.clone() });
            }
            // Bitnami: the postgres superuser's own password next to a custom user
            if let Some(p) = first(env, &["POSTGRESQL_POSTGRES_PASSWORD"]) {
                push(&mut out, Cred { shown: DbCredential { user: "postgres".into(), database: None, from: Some(origin(p)) }, password: p.value.clone() });
            }
            if out.is_empty() {
                // trust / peer authentication, or a password the human types
                push(&mut out, Cred { shown: DbCredential { user, database, from: None }, password: None });
            }
        }
        DbEngine::Mysql => {
            let db = val(first(env, &["MYSQL_DATABASE", "MARIADB_DATABASE"]));
            if let (Some(u), Some(p)) = (first(env, &["MYSQL_USER", "MARIADB_USER"]), first(env, &["MYSQL_PASSWORD", "MARIADB_PASSWORD"])) {
                push(&mut out, Cred { shown: DbCredential { user: u.value.clone().unwrap_or_default(), database: db.clone(), from: Some(origin(p)) }, password: p.value.clone() });
            }
            if let Some(p) = first(env, &["MYSQL_ROOT_PASSWORD", "MARIADB_ROOT_PASSWORD"]) {
                push(&mut out, Cred { shown: DbCredential { user: "root".into(), database: db.clone(), from: Some(origin(p)) }, password: p.value.clone() });
            } else if first(env, &["MYSQL_ALLOW_EMPTY_PASSWORD", "MARIADB_ALLOW_EMPTY_ROOT_PASSWORD", "ALLOW_EMPTY_PASSWORD"]).is_some() || out.is_empty() {
                push(&mut out, Cred { shown: DbCredential { user: "root".into(), database: db, from: None }, password: None });
            }
        }
    }
    out
}

/// `KEY_FILE=/path` entries whose file is a key of a mounted Secret: (KEY, secret, key in it).
pub fn file_refs(spec: &Json, container: &Json, env: &[RawEnv]) -> Vec<(String, String, String)> {
    let vols = env::volume_specs(spec, container);
    let mut out = Vec::new();
    for e in env {
        let (Some(key), Some(path)) = (e.key.strip_suffix("_FILE"), e.value.as_deref()) else { continue };
        for v in vols.iter().filter(|v| v.source == crate::ipc::VolumeSource::Secret) {
            let Some(mount) = v.mount_path.as_deref() else { continue };
            let Some(rel) = path.strip_prefix(mount.trim_end_matches('/')).and_then(|r| r.strip_prefix('/')) else { continue };
            let secret_key = match &v.items {
                Some(items) => items.iter().find(|(_, p)| p == rel).map(|(k, _)| k.clone()),
                None => (!rel.contains('/')).then(|| rel.to_string()),
            };
            if let Some(k) = secret_key {
                out.push((key.to_string(), v.object.clone(), k));
                break;
            }
        }
    }
    out
}

/// The primary of a database's pods, from the labels operators and charts put on it.
pub fn is_primary(labels: &Json) -> bool {
    let l = |k: &str| labels.get(k).and_then(Json::as_str);
    l("cnpg.io/instanceRole") == Some("primary")
        || l("role") == Some("primary")
        || l("spilo-role") == Some("master")
        || l("postgres-operator.crunchydata.com/role") == Some("master")
        || l("app.kubernetes.io/component") == Some("primary")
}

// ───────────────────────── SQL helpers (pure) ─────────────────────────

/// The first keyword of a statement, lowercase, after whitespace, comments and opening parentheses.
pub fn first_keyword(sql: &str) -> String {
    let mut rest = sql;
    loop {
        let t = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '(');
        if let Some(r) = t.strip_prefix("--") {
            rest = r.split_once('\n').map_or("", |(_, r)| r);
        } else if t.starts_with('#') {
            rest = t.split_once('\n').map_or("", |(_, r)| r);
        } else if let Some(r) = t.strip_prefix("/*") {
            rest = r.split_once("*/").map_or("", |(_, r)| r);
        } else {
            return t.chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>().to_ascii_lowercase();
        }
    }
}

/// Statements that only read; the rest needs writes turned on.
pub fn is_read_statement(engine: DbEngine, sql: &str) -> bool {
    let kw = first_keyword(sql);
    let ok = match engine {
        DbEngine::Postgres => matches!(kw.as_str(), "select" | "with" | "values" | "table" | "show" | "explain"),
        DbEngine::Mysql => matches!(kw.as_str(), "select" | "with" | "values" | "table" | "show" | "explain" | "describe" | "desc"),
    };
    let lower = sql.to_ascii_lowercase();
    ok && !(engine == DbEngine::Mysql && (lower.contains("into outfile") || lower.contains("into dumpfile")))
}

pub fn quote_ident(engine: DbEngine, name: &str) -> String {
    match engine {
        DbEngine::Postgres => format!("\"{}\"", name.replace('"', "\"\"")),
        DbEngine::Mysql => format!("`{}`", name.replace('`', "``")),
    }
}

/// The page of a table the data tab shows (one row more than asked, to know there are more).
pub fn rows_sql(engine: DbEngine, req: &DbRowsRequest) -> String {
    let limit = req.limit.clamp(1, 1000);
    let order = match &req.order_by {
        Some(c) => {
            let dir = if req.desc { "DESC" } else { "ASC" };
            let nulls = if engine == DbEngine::Postgres { " NULLS LAST" } else { "" };
            format!(" ORDER BY {} {dir}{nulls}", quote_ident(engine, c))
        }
        None => String::new(),
    };
    format!("SELECT * FROM {}.{}{order} LIMIT {} OFFSET {}", quote_ident(engine, &req.schema), quote_ident(engine, &req.table), limit + 1, req.offset)
}

fn cut(v: &str) -> String {
    match v.char_indices().nth(MAX_CELL) {
        Some((i, _)) => format!("{}…", &v[..i]),
        None => v.to_string(),
    }
}

fn result_limit(req: Option<u32>) -> usize {
    req.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as usize
}

// ───────────────────────── sessions ─────────────────────────

enum Conn {
    Pg(tokio_postgres::Client),
    My(mysql_async::Conn),
    Closed,
}

struct DbConn {
    engine: DbEngine,
    context: String,
    pod: ObjRef,
    port: u16,
    user: String,
    password: Option<String>,
    database: Mutex<String>,
    conn: tokio::sync::Mutex<Conn>,
    tunnel: Mutex<CancellationToken>,
    used: Mutex<Instant>,
}

impl DbConn {
    fn database(&self) -> String {
        lock(&self.database).clone()
    }
    fn touch(&self) {
        *lock(&self.used) = Instant::now();
    }
    fn close_tunnel(&self) {
        lock(&self.tunnel).cancel();
    }
}

#[derive(Default)]
struct DbSessions(Mutex<HashMap<String, Arc<DbConn>>>);

fn session_of(state: &AppState, id: &str) -> Result<Arc<DbConn>> {
    let s = state.ext::<DbSessions>();
    let c = lock(&s.0).get(id).cloned().ok_or_else(|| BackendError::new(404, "DbClosed", "the database connection is closed; open it again"))?;
    c.touch();
    Ok(c)
}

// ───────────────────────── errors ─────────────────────────

fn pg_err(e: tokio_postgres::Error) -> BackendError {
    if let Some(db) = e.as_db_error() {
        let code = db.code().code();
        let reason = if code.starts_with("28") { "DbAuth" } else if code == "3D000" { "DbNoDatabase" } else { "Database" };
        let mut msg = db.message().to_string();
        if let Some(d) = db.detail() {
            msg.push_str(&format!(" ({d})"));
        }
        if let Some(h) = db.hint() {
            msg.push_str(&format!(". Hint: {h}"));
        }
        if let Some(tokio_postgres::error::ErrorPosition::Original(n)) = db.position() {
            msg.push_str(&format!(" at character {n}"));
        }
        return BackendError::new(0, reason, redact::clean_untrusted(&msg, 2000));
    }
    BackendError::new(0, "DbConnect", redact::clean_untrusted(&e.to_string(), 2000))
}

fn my_err(e: mysql_async::Error) -> BackendError {
    match &e {
        mysql_async::Error::Server(se) => {
            let reason = match se.code {
                1045 | 1698 => "DbAuth",
                1049 => "DbNoDatabase",
                _ => "Database",
            };
            BackendError::new(0, reason, redact::clean_untrusted(&format!("{} ({})", se.message, se.code), 2000))
        }
        _ => BackendError::new(0, "DbConnect", redact::clean_untrusted(&e.to_string(), 2000)),
    }
}

fn timed_out(what: &str) -> BackendError {
    BackendError::new(0, "DbConnect", format!("{what} timed out"))
}

// ───────────────────────── detect ─────────────────────────

/// The pod to open: the object itself, else a running pod behind it (the primary first).
async fn pick_pod(state: &AppState, obj: &ObjRef) -> Result<(Arc<Session>, Json)> {
    let sess = state.session(&obj.context).await?;
    let pods_gvr = Gvr::new("", "v1", "pods");
    if obj.gvr.group.is_empty() && obj.gvr.resource == "pods" {
        let pod = sess.get(&api_path(&pods_gvr, obj.ns(), Some(&obj.name))).await?;
        return Ok((sess, pod));
    }
    // a CloudNativePG / other operator's cluster object: its pods by label
    let refs = if obj.gvr.group == "postgresql.cnpg.io" {
        let uri = with_query(&api_path(&pods_gvr, obj.ns(), None), &[("labelSelector", &format!("cnpg.io/cluster={}", obj.name))]);
        let list = sess.get(&uri).await?;
        arr(list.get("items")).iter().filter_map(|p| p.pointer("/metadata/name").and_then(Json::as_str).map(str::to_string)).collect::<Vec<_>>()
    } else {
        objects::pods_for(state, obj).await?.into_iter().filter(|p| p.phase == "Running").map(|p| p.name).collect()
    };
    let mut first: Option<Json> = None;
    for name in refs.iter().take(12) {
        let Ok(pod) = sess.get(&api_path(&pods_gvr, obj.ns(), Some(name))).await else { continue };
        if pod.pointer("/status/phase").and_then(Json::as_str) != Some("Running") {
            continue;
        }
        if pod.pointer("/metadata/labels").is_some_and(is_primary) {
            return Ok((sess, pod));
        }
        first.get_or_insert(pod);
    }
    first.map(|p| (sess.clone(), p)).ok_or_else(|| BackendError::new(404, "NotFound", format!("no running pod behind {} {}", obj.gvr.resource, obj.name)))
}

async fn read_secret(sess: &Session, ns: &str, name: &str) -> std::result::Result<std::collections::BTreeMap<String, String>, String> {
    sess.get(&api_path(&Gvr::new("", "v1", "secrets"), Some(ns), Some(name))).await.map(|o| env::object_data(&o, true)).map_err(|e| e.reason)
}

/// Credentials from the Secrets of Postgres operators, found from the pod's labels.
async fn operator_credentials(sess: &Session, ns: &str, labels: &Json, notes: &mut Vec<String>) -> Vec<Cred> {
    let l = |k: &str| labels.get(k).and_then(Json::as_str).map(str::to_string);
    let mut out = Vec::new();
    let from_secret = |name: &str, data: &std::collections::BTreeMap<String, String>, user_keys: &[&str]| -> Option<Cred> {
        let user = user_keys.iter().find_map(|k| data.get(*k))?.clone();
        let password = data.get("password").cloned();
        let database = data.get("dbname").cloned();
        Some(Cred { shown: DbCredential { user, database, from: Some(format!("secret/{name}")) }, password })
    };
    if let Some(cluster) = l("cnpg.io/cluster") {
        for suffix in ["app", "superuser"] {
            let name = format!("{cluster}-{suffix}");
            match read_secret(sess, ns, &name).await {
                Ok(d) => out.extend(from_secret(&name, &d, &["username", "user"])),
                Err(r) if r == "NotFound" => {}
                Err(r) => notes.push(format!("secret {name} is not readable ({r})")),
            }
        }
    }
    let selectors: Vec<String> = [
        l("cluster-name").filter(|_| l("application").as_deref() == Some("spilo")).map(|c| format!("application=spilo,cluster-name={c}")),
        l("postgres-operator.crunchydata.com/cluster").map(|c| format!("postgres-operator.crunchydata.com/cluster={c},postgres-operator.crunchydata.com/role=pguser")),
    ]
    .into_iter()
    .flatten()
    .collect();
    for sel in selectors {
        let uri = with_query(&api_path(&Gvr::new("", "v1", "secrets"), Some(ns), None), &[("labelSelector", &sel)]);
        match sess.get(&uri).await {
            Ok(list) => {
                for o in arr(list.get("items")) {
                    let name = o.pointer("/metadata/name").and_then(Json::as_str).unwrap_or_default();
                    out.extend(from_secret(name, &env::object_data(o, true), &["username", "user"]));
                }
            }
            Err(e) => notes.push(format!("the operator's user secrets are not readable ({})", e.reason)),
        }
    }
    out
}

/// What runs behind an object, with every credential kns can find (passwords included).
async fn detect_full(state: &AppState, obj: &ObjRef) -> Result<(DbTarget, Vec<Cred>)> {
    let (sess, pod) = pick_pod(state, obj).await?;
    let ns = pod.pointer("/metadata/namespace").and_then(Json::as_str).unwrap_or_default().to_string();
    let name = pod.pointer("/metadata/name").and_then(Json::as_str).unwrap_or_default().to_string();
    let spec = pod_spec(&pod).ok_or_else(|| BackendError::invalid("the pod has no spec"))?;
    let labels = pod.pointer("/metadata/labels").cloned().unwrap_or(Json::Null);
    let cnpg = labels.get("cnpg.io/cluster").is_some();
    let (container, image, engine, port) = match detect_container(spec) {
        Some(d) => d,
        None if cnpg => {
            let c = arr(spec.get("containers")).first().ok_or_else(|| BackendError::invalid("the pod has no containers"))?;
            (s(c, "name").unwrap_or_default().to_string(), s(c, "image").unwrap_or_default().to_string(), DbEngine::Postgres, 5432)
        }
        None => {
            return Err(BackendError::new(
                404,
                "NoDatabase",
                format!("no Postgres or MySQL/MariaDB server found in pod {name}: no container has a database image, the engine's env or port 5432 / 3306"),
            ));
        }
    };
    let pod_ref = ObjRef { context: obj.context.clone(), gvr: Gvr::new("", "v1", "pods"), namespace: Some(ns.clone()), name: name.clone() };
    let mut notes = Vec::new();
    let loaded = env::load(state, &obj.context, &pod_ref, Some(&container)).await?;
    notes.extend(loaded.warnings.iter().map(|w| redact::clean_untrusted(w, 300)));
    let mut raw = loaded.rows;
    // KEY_FILE pointing into a mounted Secret: read the key as KEY
    if let Some(c) = arr(spec.get("containers")).iter().find(|c| s(c, "name") == Some(container.as_str())) {
        for (key, secret, skey) in file_refs(spec, c, &raw) {
            if raw.iter().any(|e| e.key == key) {
                continue;
            }
            match read_secret(&sess, &ns, &secret).await {
                Ok(d) => {
                    if let Some(v) = d.get(&skey) {
                        raw.push(RawEnv { key: key.clone(), source: crate::ipc::EnvSource::Secret, from: Some(format!("file from secret/{secret}:{skey}")), value: Some(v.trim_end_matches(['\n', '\r']).to_string()) });
                    }
                }
                Err(r) => notes.push(format!("secret {secret} (for {key}_FILE) is not readable ({r})")),
            }
        }
    }
    let mut creds = Vec::new();
    if engine == DbEngine::Postgres {
        for c in operator_credentials(&sess, &ns, &labels, &mut notes).await {
            push(&mut creds, c);
        }
    }
    for c in env_credentials(engine, &raw) {
        // the env's passwordless fallback only when nothing better was found
        if c.shown.from.is_none() && !creds.is_empty() {
            continue;
        }
        push(&mut creds, c);
    }
    let shown = creds.iter().map(|c| c.shown.clone()).collect();
    Ok((DbTarget { engine, namespace: ns, pod: name, container, image, port, credentials: shown, notes }, creds))
}

pub async fn detect(state: &AppState, obj: &ObjRef) -> Result<DbTarget> {
    Ok(detect_full(state, obj).await?.0)
}

// ───────────────────────── connect ─────────────────────────

/// Where and as whom to log in.
struct Login<'a> {
    ns: &'a str,
    pod: &'a str,
    port: u16,
    user: &'a str,
    password: Option<&'a str>,
}

/// A port-forward to the pod that lives until `cancel`; returns its data stream.
async fn pod_stream(sess: &Session, ns: &str, pod: &str, port: u16, cancel: CancellationToken) -> Result<impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static> {
    let pods: Api<Pod> = Api::namespaced(sess.client.clone(), ns);
    let mut fwd = timeout(CONNECT_TIMEOUT, pods.portforward(pod, &[port])).await.map_err(|_| timed_out("the port-forward"))??;
    let stream = fwd.take_stream(port).ok_or_else(|| BackendError::internal("port-forward stream missing"))?;
    tokio::spawn(async move {
        cancel.cancelled().await;
        fwd.abort();
    });
    Ok(stream)
}

/// Accepts any certificate: see the module docs (the stream is already inside the API server's tunnel).
#[derive(Debug)]
struct AnyCert(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for AnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> std::result::Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn pg_tls() -> Result<tokio_postgres_rustls::MakeRustlsConnect> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| BackendError::internal(e.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AnyCert(provider)))
        .with_no_client_auth();
    Ok(tokio_postgres_rustls::MakeRustlsConnect::new(config))
}

async fn pg_connect(sess: &Session, login: &Login<'_>, database: &str, cancel: CancellationToken) -> Result<tokio_postgres::Client> {
    let stream = pod_stream(sess, login.ns, login.pod, login.port, cancel.clone()).await?;
    pg_handshake(stream, login, database, cancel).await
}

/// The Postgres startup over any stream: TLS when the server offers it, then authentication.
async fn pg_handshake<S>(stream: S, login: &Login<'_>, database: &str, cancel: CancellationToken) -> Result<tokio_postgres::Client>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    use tokio_postgres::tls::MakeTlsConnect;
    let mut cfg = tokio_postgres::Config::new();
    cfg.user(login.user).dbname(database).application_name("kns").ssl_mode(tokio_postgres::config::SslMode::Prefer);
    if let Some(p) = login.password {
        cfg.password(p);
    }
    let mut make = pg_tls()?;
    let tls = <tokio_postgres_rustls::MakeRustlsConnect as MakeTlsConnect<S>>::make_tls_connect(&mut make, "localhost").map_err(|e| BackendError::internal(e.to_string()))?;
    let connected = timeout(CONNECT_TIMEOUT, cfg.connect_raw(stream, tls)).await;
    let (client, connection) = match connected {
        Ok(r) => r.map_err(pg_err)?,
        Err(_) => {
            cancel.cancel();
            return Err(timed_out("connecting to Postgres"));
        }
    };
    tokio::spawn(async move {
        tokio::select! {
            _ = connection => {}
            _ = cancel.cancelled() => {}
        }
    });
    Ok(client)
}

async fn my_connect(sess: Arc<Session>, login: &Login<'_>, database: Option<&str>, cancel: CancellationToken) -> Result<mysql_async::Conn> {
    let (ns, pod, port) = (login.ns, login.pod, login.port);
    // a loopback listener for exactly one connection, piped to a port-forward stream
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| BackendError::internal(e.to_string()))?;
    let local = listener.local_addr().map_err(|e| BackendError::internal(e.to_string()))?.port();
    let (ns2, pod2, cancel2) = (ns.to_string(), pod.to_string(), cancel.clone());
    tokio::spawn(async move {
        let accepted = tokio::select! {
            r = listener.accept() => r,
            _ = cancel2.cancelled() => return,
            _ = tokio::time::sleep(CONNECT_TIMEOUT) => return,
        };
        drop(listener);
        let Ok((mut tcp, _)) = accepted else { return };
        let Ok(mut stream) = pod_stream(&sess, &ns2, &pod2, port, cancel2.clone()).await else { return };
        tokio::select! {
            _ = copy_bidirectional(&mut tcp, &mut stream) => {}
            _ = cancel2.cancelled() => {}
        }
        cancel2.cancel();
    });
    let opts = mysql_async::OptsBuilder::default()
        .ip_or_hostname("127.0.0.1")
        .tcp_port(local)
        .prefer_socket(false)
        .user(Some(login.user))
        .pass(login.password)
        .db_name(database);
    match timeout(CONNECT_TIMEOUT, mysql_async::Conn::new(opts)).await {
        Ok(Ok(c)) => Ok(c),
        Ok(Err(e)) => {
            cancel.cancel();
            Err(my_err(e))
        }
        Err(_) => {
            cancel.cancel();
            Err(timed_out("connecting to MySQL"))
        }
    }
}

fn my_text(v: &mysql_async::Value) -> Option<String> {
    use mysql_async::Value;
    match v {
        Value::NULL => None,
        Value::Bytes(b) => Some(cut(&String::from_utf8_lossy(b))),
        other => Some(cut(other.as_sql(true).trim_matches('\''))),
    }
}

async fn my_strings(conn: &mut mysql_async::Conn, sql: &str, params: Vec<mysql_async::Value>) -> Result<Vec<Vec<Option<String>>>> {
    use mysql_async::prelude::Queryable;
    let rows: Vec<mysql_async::Row> = if params.is_empty() { conn.query(sql).await.map_err(my_err)? } else { conn.exec(sql, params).await.map_err(my_err)? };
    Ok(rows.iter().map(|r| (0..r.len()).map(|i| r.as_ref(i).and_then(my_text)).collect()).collect())
}

async fn databases(conn: &mut Conn) -> Result<Vec<String>> {
    match conn {
        Conn::Pg(c) => {
            let rows = c.query("SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname", &[]).await.map_err(pg_err)?;
            Ok(rows.iter().map(|r| r.get::<_, String>(0)).collect())
        }
        Conn::My(c) => Ok(my_strings(c, "SHOW DATABASES", vec![]).await?.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect()),
        Conn::Closed => Err(BackendError::new(404, "DbClosed", "the connection is closed")),
    }
}

async fn server_version(conn: &mut Conn) -> String {
    match conn {
        Conn::Pg(c) => c.query_one("SHOW server_version", &[]).await.ok().and_then(|r| r.try_get::<_, String>(0).ok()).unwrap_or_default(),
        Conn::My(c) => my_strings(c, "SELECT VERSION()", vec![]).await.ok().and_then(|r| r.into_iter().next()).and_then(|r| r.into_iter().next().flatten()).unwrap_or_default(),
        Conn::Closed => String::new(),
    }
}

/// Opens a connection (a new tunnel) to `database`; a Postgres database that does not exist falls back to `postgres`.
async fn open(state: &AppState, c: &DbConnectRequest, password: Option<&str>) -> Result<(Conn, String, CancellationToken)> {
    let sess = state.session(&c.obj_ref.context).await?;
    let ns = c.obj_ref.ns().ok_or_else(|| BackendError::invalid("the pod has no namespace"))?;
    let login = Login { ns, pod: &c.obj_ref.name, port: c.port, user: &c.user, password };
    match c.engine {
        DbEngine::Postgres => {
            let db = c.database.clone().filter(|d| !d.is_empty()).unwrap_or_else(|| c.user.clone());
            let cancel = CancellationToken::new();
            match pg_connect(&sess, &login, &db, cancel.clone()).await {
                Ok(client) => Ok((Conn::Pg(client), db, cancel)),
                Err(e) if e.reason == "DbNoDatabase" && db != "postgres" => {
                    cancel.cancel();
                    let cancel = CancellationToken::new();
                    let client = pg_connect(&sess, &login, "postgres", cancel.clone()).await?;
                    Ok((Conn::Pg(client), "postgres".into(), cancel))
                }
                Err(e) => {
                    cancel.cancel();
                    Err(e)
                }
            }
        }
        DbEngine::Mysql => {
            let cancel = CancellationToken::new();
            let db = c.database.clone().filter(|d| !d.is_empty());
            let conn = my_connect(sess, &login, db.as_deref(), cancel.clone()).await?;
            Ok((Conn::My(conn), db.unwrap_or_default(), cancel))
        }
    }
}

pub async fn connect(state: &AppState, req: DbConnectRequest) -> Result<DbSession> {
    sweep(state).await;
    // a password the human did not type is read again from the credential's source
    let password = match &req.password {
        Some(p) => Some(p.clone()),
        None => {
            let (_, creds) = detect_full(state, &req.obj_ref).await?;
            creds.into_iter().find(|c| c.shown.user == req.user).and_then(|c| c.password)
        }
    };
    let (mut conn, database, cancel) = open(state, &req, password.as_deref()).await?;
    let version = server_version(&mut conn).await;
    let dbs = databases(&mut conn).await.unwrap_or_default();
    let id = state.next_id("db-");
    let dc = Arc::new(DbConn {
        engine: req.engine,
        context: req.obj_ref.context.clone(),
        pod: req.obj_ref.clone(),
        port: req.port,
        user: req.user.clone(),
        password,
        database: Mutex::new(database.clone()),
        conn: tokio::sync::Mutex::new(conn),
        tunnel: Mutex::new(cancel),
        used: Mutex::new(Instant::now()),
    });
    lock(&state.ext::<DbSessions>().0).insert(id.clone(), dc);
    Ok(DbSession { id, engine: req.engine, user: req.user, database, server_version: redact::clean_untrusted(&version, 200), databases: dbs })
}

/// Switches the database: Postgres reconnects, MySQL changes the default schema.
pub async fn use_database(state: &AppState, id: &str, database: &str) -> Result<DbSession> {
    let dc = session_of(state, id)?;
    let mut guard = dc.conn.lock().await;
    match dc.engine {
        DbEngine::Postgres => {
            let req = DbConnectRequest {
                obj_ref: dc.pod.clone(),
                engine: dc.engine,
                container: String::new(),
                port: dc.port,
                user: dc.user.clone(),
                password: None,
                database: Some(database.to_string()),
            };
            let (conn, db, cancel) = open(state, &req, dc.password.as_deref()).await?;
            if db != database {
                cancel.cancel();
                return Err(BackendError::new(404, "DbNoDatabase", format!("database {database} does not exist")));
            }
            dc.close_tunnel();
            *guard = conn;
            *lock(&dc.tunnel) = cancel;
        }
        DbEngine::Mysql => {
            use mysql_async::prelude::Queryable;
            let Conn::My(c) = &mut *guard else { return Err(BackendError::new(404, "DbClosed", "the connection is closed")) };
            c.query_drop(format!("USE {}", quote_ident(DbEngine::Mysql, database))).await.map_err(my_err)?;
        }
    }
    *lock(&dc.database) = database.to_string();
    let version = server_version(&mut guard).await;
    let dbs = databases(&mut guard).await.unwrap_or_default();
    Ok(DbSession { id: id.to_string(), engine: dc.engine, user: dc.user.clone(), database: database.to_string(), server_version: version, databases: dbs })
}

async fn shut(dc: &DbConn) {
    let mut g = dc.conn.lock().await;
    if let Conn::My(c) = std::mem::replace(&mut *g, Conn::Closed) {
        let _ = timeout(Duration::from_secs(2), c.disconnect()).await;
    }
    dc.close_tunnel();
}

pub async fn close(state: &AppState, id: &str) -> Result<()> {
    let dc = lock(&state.ext::<DbSessions>().0).remove(id);
    if let Some(dc) = dc {
        shut(&dc).await;
    }
    Ok(())
}

/// Closes sessions that were left open (a reloaded window).
async fn sweep(state: &AppState) {
    let stale: Vec<Arc<DbConn>> = {
        let s = state.ext::<DbSessions>();
        let mut map = lock(&s.0);
        let ids: Vec<String> = map.iter().filter(|(_, c)| lock(&c.used).elapsed() > IDLE_CLOSE).map(|(k, _)| k.clone()).collect();
        ids.iter().filter_map(|k| map.remove(k)).collect()
    };
    for dc in stale {
        shut(&dc).await;
    }
}

// ───────────────────────── browse ─────────────────────────

pub async fn schema(state: &AppState, id: &str) -> Result<DbSchema> {
    let dc = session_of(state, id)?;
    let mut guard = dc.conn.lock().await;
    let mut by: Vec<DbSchemaEntry> = Vec::new();
    let mut add = |schema: String, t: DbTableEntry| match by.iter_mut().find(|e| e.name == schema) {
        Some(e) => e.tables.push(t),
        None => by.push(DbSchemaEntry { name: schema, tables: vec![t] }),
    };
    match &mut *guard {
        Conn::Pg(c) => {
            // schemas without tables are listed too (the app's schema may still be empty)
            let schemas = c
                .query("SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%' ORDER BY nspname", &[])
                .await
                .map_err(pg_err)?;
            let rows = c
                .query(
                    "SELECT n.nspname, c.relname, c.relkind::text, CASE WHEN c.relkind IN ('r','m','p') THEN c.reltuples::bigint END \
                     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE c.relkind IN ('r','v','m','p','f') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog','information_schema') \
                     AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%' ORDER BY 1, 2",
                    &[],
                )
                .await
                .map_err(pg_err)?;
            for r in &schemas {
                let name: String = r.get(0);
                add(name.clone(), DbTableEntry { name: String::new(), kind: String::new(), rows: None });
            }
            for r in &rows {
                let kind = match r.get::<_, String>(2).as_str() {
                    "r" => "table",
                    "v" => "view",
                    "m" => "matview",
                    "p" => "partitioned",
                    "f" => "foreign",
                    _ => "table",
                };
                // -1: never analyzed
                let rows: Option<i64> = r.get::<_, Option<i64>>(3).filter(|n| *n >= 0);
                add(r.get(0), DbTableEntry { name: r.get(1), kind: kind.into(), rows });
            }
        }
        Conn::My(c) => {
            let rows = my_strings(
                c,
                "SELECT table_schema, table_name, table_type, table_rows FROM information_schema.tables \
                 WHERE table_schema NOT IN ('information_schema','performance_schema','mysql','sys') ORDER BY table_schema, table_name",
                vec![],
            )
            .await?;
            for d in databases(&mut guard).await.unwrap_or_default() {
                if !["information_schema", "performance_schema", "mysql", "sys"].contains(&d.as_str()) {
                    add(d, DbTableEntry { name: String::new(), kind: String::new(), rows: None });
                }
            }
            for r in rows {
                let get = |i: usize| r.get(i).cloned().flatten().unwrap_or_default();
                let kind = if get(2).contains("VIEW") { "view" } else { "table" };
                add(get(0), DbTableEntry { name: get(1), kind: kind.into(), rows: r.get(3).cloned().flatten().and_then(|n| n.parse().ok()) });
            }
        }
        Conn::Closed => return Err(BackendError::new(404, "DbClosed", "the connection is closed")),
    }
    // the placeholders that kept empty schemas
    for e in &mut by {
        e.tables.retain(|t| !t.name.is_empty());
    }
    Ok(DbSchema { schemas: by })
}

pub async fn table_info(state: &AppState, req: &DbTableRequest) -> Result<DbTableInfo> {
    let dc = session_of(state, &req.session)?;
    let mut guard = dc.conn.lock().await;
    match &mut *guard {
        Conn::Pg(c) => {
            let rel = format!("{}.{}", quote_ident(DbEngine::Postgres, &req.schema), quote_ident(DbEngine::Postgres, &req.table));
            let cols = c
                .query(
                    "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, pg_get_expr(d.adbin, d.adrelid), \
                     COALESCE((SELECT true FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)), false) \
                     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                     WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
                    &[&rel],
                )
                .await
                .map_err(pg_err)?;
            let idx = c.query("SELECT indexname::text, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname", &[&req.schema, &req.table]).await.map_err(pg_err)?;
            Ok(DbTableInfo {
                columns: cols.iter().map(|r| DbColumn { name: r.get(0), type_name: r.get(1), nullable: r.get(2), default: r.get(3), primary_key: r.get(4) }).collect(),
                indexes: idx.iter().map(|r| DbIndex { name: r.get(0), definition: r.get(1) }).collect(),
            })
        }
        Conn::My(c) => {
            let p = || vec![mysql_async::Value::from(req.schema.clone()), mysql_async::Value::from(req.table.clone())];
            let cols = my_strings(
                c,
                "SELECT column_name, column_type, is_nullable, column_default, column_key, extra FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
                p(),
            )
            .await?;
            let idx = my_strings(
                c,
                "SELECT index_name, MIN(non_unique), GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ', ') FROM information_schema.statistics \
                 WHERE table_schema = ? AND table_name = ? GROUP BY index_name ORDER BY index_name",
                p(),
            )
            .await?;
            let g = |r: &Vec<Option<String>>, i: usize| r.get(i).cloned().flatten();
            Ok(DbTableInfo {
                columns: cols
                    .iter()
                    .map(|r| {
                        let extra = g(r, 5).filter(|e| !e.is_empty());
                        DbColumn {
                            name: g(r, 0).unwrap_or_default(),
                            type_name: g(r, 1).unwrap_or_default(),
                            nullable: g(r, 2).as_deref() == Some("YES"),
                            default: g(r, 3).or(extra),
                            primary_key: g(r, 4).as_deref() == Some("PRI"),
                        }
                    })
                    .collect(),
                indexes: idx
                    .iter()
                    .map(|r| {
                        let name = g(r, 0).unwrap_or_default();
                        let unique = g(r, 1).as_deref() == Some("0");
                        DbIndex { definition: format!("{}INDEX {} ({})", if unique { "UNIQUE " } else { "" }, quote_ident(DbEngine::Mysql, &name), g(r, 2).unwrap_or_default()), name }
                    })
                    .collect(),
            })
        }
        Conn::Closed => Err(BackendError::new(404, "DbClosed", "the connection is closed")),
    }
}

// ───────────────────────── queries ─────────────────────────

/// Runs one statement inside a transaction (read-only and rolled back unless `write`).
async fn pg_run(c: &tokio_postgres::Client, sql: &str, write: bool, limit: usize) -> Result<DbResult> {
    use tokio_postgres::SimpleQueryMessage as M;
    let started = Instant::now();
    // the server parses it first: exactly one statement, and its column types
    let stmt = c.prepare(sql).await.map_err(pg_err)?;
    let types: Vec<(String, String)> = stmt.columns().iter().map(|col| (col.name().to_string(), col.type_().name().to_string())).collect();
    let begin = format!("BEGIN {}; SET LOCAL statement_timeout = {STATEMENT_TIMEOUT_MS}", if write { "READ WRITE" } else { "READ ONLY" });
    c.batch_execute(&begin).await.map_err(pg_err)?;
    let kw = first_keyword(sql);
    // a cursor fetches only what is shown, for statements that can have one
    let cursor = matches!(kw.as_str(), "select" | "values" | "table") || (kw == "with" && !write);
    let run = async {
        if cursor {
            c.batch_execute(&format!("DECLARE kns_cursor NO SCROLL CURSOR FOR {sql}")).await?;
            c.simple_query(&format!("FETCH {} FROM kns_cursor", limit + 1)).await
        } else {
            c.simple_query(sql).await
        }
    }
    .await;
    let msgs = match run {
        Ok(m) => m,
        Err(e) => {
            let _ = c.batch_execute("ROLLBACK").await;
            return Err(pg_err(e));
        }
    };
    let end = if write { "COMMIT" } else { "ROLLBACK" };
    c.batch_execute(end).await.map_err(pg_err)?;
    let mut columns: Vec<DbResultColumn> = types.iter().map(|(n, t)| DbResultColumn { name: n.clone(), type_name: Some(t.clone()) }).collect();
    let mut rows = Vec::new();
    let mut truncated = false;
    let mut count = None;
    for m in msgs {
        match m {
            M::RowDescription(desc) if columns.is_empty() => {
                columns = desc.iter().map(|d| DbResultColumn { name: d.name().to_string(), type_name: None }).collect();
            }
            M::Row(r) => {
                if rows.len() >= limit {
                    truncated = true;
                    continue;
                }
                rows.push((0..r.len()).map(|i| r.get(i).map(cut)).collect());
            }
            M::CommandComplete(n) => count = Some(n),
            _ => {}
        }
    }
    let n = if cursor { rows.len() as u64 } else { count.unwrap_or(rows.len() as u64) };
    let affected = if columns.is_empty() { count } else { None };
    Ok(DbResult {
        columns,
        rows,
        truncated,
        affected,
        command: (!kw.is_empty()).then(|| format!("{} {n}{}", kw.to_ascii_uppercase(), if truncated { "+" } else { "" })),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

async fn my_run(c: &mut mysql_async::Conn, sql: &str, write: bool, limit: usize) -> Result<DbResult> {
    use mysql_async::prelude::Queryable;
    let started = Instant::now();
    // one statement: the server prepares it (some statements cannot be prepared, and are one statement)
    match c.prep(sql).await {
        Ok(stmt) => {
            let _ = c.close(stmt).await;
        }
        Err(mysql_async::Error::Server(e)) if e.code == 1295 => {}
        Err(e) => return Err(my_err(e)),
    }
    c.query_drop(format!("SET SESSION sql_select_limit = {}", limit + 1)).await.map_err(my_err)?;
    c.query_drop(if write { "START TRANSACTION READ WRITE" } else { "START TRANSACTION READ ONLY" }).await.map_err(my_err)?;
    type Rows = (Vec<DbResultColumn>, Vec<Vec<Option<String>>>, u64);
    let outcome: std::result::Result<Rows, mysql_async::Error> = async {
        let mut result = c.query_iter(sql).await?;
        let columns: Vec<DbResultColumn> = result
            .columns_ref()
            .iter()
            .map(|col| DbResultColumn { name: col.name_str().to_string(), type_name: Some(format!("{:?}", col.column_type()).trim_start_matches("MYSQL_TYPE_").to_ascii_lowercase()) })
            .collect();
        let rows: Vec<mysql_async::Row> = result.collect().await?;
        let affected = result.affected_rows();
        drop(result);
        Ok((columns, rows.iter().map(|r| (0..r.len()).map(|i| r.as_ref(i).and_then(my_text)).collect()).collect(), affected))
    }
    .await;
    let end = match (&outcome, write) {
        (Ok(_), true) => "COMMIT",
        _ => "ROLLBACK",
    };
    let finish = c.query_drop(end).await;
    let _ = c.query_drop("SET SESSION sql_select_limit = DEFAULT").await;
    let (columns, mut rows, affected) = outcome.map_err(my_err)?;
    finish.map_err(my_err)?;
    let truncated = rows.len() > limit;
    rows.truncate(limit);
    let kw = first_keyword(sql);
    let has_rows = !columns.is_empty();
    let n = if has_rows { rows.len() as u64 } else { affected };
    Ok(DbResult {
        columns,
        rows,
        truncated,
        affected: (!has_rows).then_some(affected),
        command: (!kw.is_empty()).then(|| format!("{} {n}{}", kw.to_ascii_uppercase(), if truncated { "+" } else { "" })),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

async fn run(dc: &DbConn, sql: &str, write: bool, limit: usize) -> Result<DbResult> {
    let mut guard = dc.conn.lock().await;
    match &mut *guard {
        Conn::Pg(c) => pg_run(c, sql, write, limit).await,
        Conn::My(c) => my_run(c, sql, write, limit).await,
        Conn::Closed => Err(BackendError::new(404, "DbClosed", "the connection is closed")),
    }
}

pub async fn rows(state: &AppState, req: &DbRowsRequest) -> Result<DbResult> {
    let dc = session_of(state, &req.session)?;
    let limit = req.limit.clamp(1, 1000) as usize;
    let mut r = run(&dc, &rows_sql(dc.engine, req), false, limit).await?;
    r.command = None;
    Ok(r)
}

pub async fn query(state: &AppState, req: &DbQueryRequest) -> Result<DbResult> {
    let dc = session_of(state, &req.session)?;
    let sql = req.sql.trim().trim_end_matches(';').trim();
    if sql.is_empty() {
        return Err(BackendError::invalid("no statement"));
    }
    if req.write {
        let flags = crate::ctxflags::effective(state, &dc.context)?;
        if flags.read_only {
            return Err(BackendError::new(403, "ReadOnly", format!("{} is read-only: writes to the database are off", dc.context)));
        }
        let expected = dc.database();
        if flags.protected && !env::confirm_text_ok(&expected, req.confirm_text.as_deref()) {
            return Err(BackendError::new(409, "ConfirmText", format!("{} is a protected context: type {expected} to write", dc.context)));
        }
    } else if !is_read_statement(dc.engine, sql) {
        let kw = first_keyword(sql).to_ascii_uppercase();
        return Err(BackendError::new(403, "DbReadOnly", format!("{kw} can change data: turn writes on to run it (the view is read-only)")));
    }
    run(&dc, sql, req.write, result_limit(req.limit)).await
}

pub mod cmd {
    use crate::{
        contract::{DbConnectRequest, DbDetectRequest, DbQueryRequest, DbResult, DbRowsRequest, DbSchema, DbSession, DbTableInfo, DbTableRequest, DbTarget},
        ipc::Result,
        state::AppState,
    };

    #[tauri::command]
    pub async fn db_detect(state: tauri::State<'_, AppState>, req: DbDetectRequest) -> Result<DbTarget> {
        super::detect(&state, &req.obj_ref).await
    }
    #[tauri::command]
    pub async fn db_connect(state: tauri::State<'_, AppState>, req: DbConnectRequest) -> Result<DbSession> {
        super::connect(&state, req).await
    }
    #[tauri::command]
    pub async fn db_use(state: tauri::State<'_, AppState>, session: String, database: String) -> Result<DbSession> {
        super::use_database(&state, &session, &database).await
    }
    #[tauri::command]
    pub async fn db_close(state: tauri::State<'_, AppState>, session: String) -> Result<()> {
        super::close(&state, &session).await
    }
    #[tauri::command]
    pub async fn db_schema(state: tauri::State<'_, AppState>, session: String) -> Result<DbSchema> {
        super::schema(&state, &session).await
    }
    #[tauri::command]
    pub async fn db_table(state: tauri::State<'_, AppState>, req: DbTableRequest) -> Result<DbTableInfo> {
        super::table_info(&state, &req).await
    }
    #[tauri::command]
    pub async fn db_rows(state: tauri::State<'_, AppState>, req: DbRowsRequest) -> Result<DbResult> {
        super::rows(&state, &req).await
    }
    #[tauri::command]
    pub async fn db_query(state: tauri::State<'_, AppState>, req: DbQueryRequest) -> Result<DbResult> {
        super::query(&state, &req).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::EnvSource;
    use serde_json::json;

    fn env(pairs: &[(&str, &str, Option<&str>)]) -> Vec<RawEnv> {
        pairs
            .iter()
            .map(|(k, v, from)| RawEnv { key: k.to_string(), source: if from.is_some() { EnvSource::Secret } else { EnvSource::Literal }, from: from.map(str::to_string), value: Some(v.to_string()) })
            .collect()
    }

    #[test]
    fn images() {
        for (img, want) in [
            ("postgres:17", Some(DbEngine::Postgres)),
            ("docker.io/bitnami/postgresql:16.4.0-debian-12-r0", Some(DbEngine::Postgres)),
            ("ghcr.io/cloudnative-pg/postgresql:16.3", Some(DbEngine::Postgres)),
            ("timescale/timescaledb-ha:pg16", Some(DbEngine::Postgres)),
            ("registry.opensource.zalan.do/acid/spilo-16:3.3-p1", Some(DbEngine::Postgres)),
            ("pgvector/pgvector:pg17", Some(DbEngine::Postgres)),
            ("localhost:5000/postgres", Some(DbEngine::Postgres)),
            ("mysql:8.4", Some(DbEngine::Mysql)),
            ("mariadb@sha256:abc", Some(DbEngine::Mysql)),
            ("percona/percona-server:8.0", Some(DbEngine::Mysql)),
            ("quay.io/prometheuscommunity/postgres-exporter:v0.15.0", None),
            ("bitnami/pgbouncer:1", None),
            ("dpage/pgadmin4", None),
            ("ghcr.io/cloudnative-pg/cloudnative-pg:1.24", None),
            ("prom/mysqld-exporter", None),
            ("mysql/mysql-router:8", None),
            ("nginx:1.27", None),
        ] {
            assert_eq!(engine_of_image(img), want, "{img}");
        }
    }

    #[test]
    fn container_by_image_then_env_then_port() {
        let spec = json!({ "containers": [
            { "name": "exporter", "image": "postgres-exporter", "ports": [{ "containerPort": 9187 }] },
            { "name": "db", "image": "bitnami/postgresql:16", "ports": [{ "name": "tcp-postgresql", "containerPort": 5433 }] },
        ]});
        assert_eq!(detect_container(&spec), Some(("db".into(), "bitnami/postgresql:16".into(), DbEngine::Postgres, 5433)));
        let spec = json!({ "containers": [{ "name": "app", "image": "registry/acme/db:1", "env": [{ "name": "MARIADB_ROOT_PASSWORD", "value": "x" }] }]});
        assert_eq!(detect_container(&spec).map(|d| (d.2, d.3)), Some((DbEngine::Mysql, 3306)));
        let spec = json!({ "containers": [{ "name": "app", "image": "acme/db:1", "ports": [{ "containerPort": 5432 }] }]});
        assert_eq!(detect_container(&spec).map(|d| d.2), Some(DbEngine::Postgres));
        assert_eq!(detect_container(&json!({ "containers": [{ "name": "web", "image": "nginx" }] })), None);
    }

    #[test]
    fn postgres_credentials() {
        let c = env_credentials(DbEngine::Postgres, &env(&[("POSTGRES_USER", "app", None), ("POSTGRES_PASSWORD", "s3", Some("secret/pg:password")), ("POSTGRES_DB", "shop", None)]));
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].shown, DbCredential { user: "app".into(), database: Some("shop".into()), from: Some("env POSTGRES_PASSWORD (secret/pg:password)".into()) });
        assert_eq!(c[0].password.as_deref(), Some("s3"));
        // no POSTGRES_DB: the database is named like the user
        let c = env_credentials(DbEngine::Postgres, &env(&[("POSTGRES_USER", "app", None), ("POSTGRES_PASSWORD", "s3", None)]));
        assert_eq!(c[0].shown.database.as_deref(), Some("app"));
        // Bitnami: custom user and the superuser's own password
        let c = env_credentials(DbEngine::Postgres, &env(&[("POSTGRESQL_USERNAME", "app", None), ("POSTGRESQL_PASSWORD", "a", None), ("POSTGRESQL_POSTGRES_PASSWORD", "root", None)]));
        assert_eq!(c.iter().map(|c| (c.shown.user.as_str(), c.password.as_deref())).collect::<Vec<_>>(), vec![("app", Some("a")), ("postgres", Some("root"))]);
        // nothing: postgres without a password
        let c = env_credentials(DbEngine::Postgres, &[]);
        assert_eq!(c, vec![Cred { shown: DbCredential { user: "postgres".into(), database: None, from: None }, password: None }]);
        // an empty value does not count
        let c = env_credentials(DbEngine::Postgres, &env(&[("POSTGRES_PASSWORD", "", None)]));
        assert_eq!(c[0].password, None);
    }

    #[test]
    fn mysql_credentials() {
        let c = env_credentials(DbEngine::Mysql, &env(&[("MYSQL_USER", "app", None), ("MYSQL_PASSWORD", "a", Some("secret/db:pw")), ("MYSQL_ROOT_PASSWORD", "r", Some("secret/db:root")), ("MYSQL_DATABASE", "shop", None)]));
        assert_eq!(c.iter().map(|c| (c.shown.user.as_str(), c.password.as_deref(), c.shown.database.as_deref())).collect::<Vec<_>>(), vec![("app", Some("a"), Some("shop")), ("root", Some("r"), Some("shop"))]);
        let c = env_credentials(DbEngine::Mysql, &env(&[("MARIADB_ALLOW_EMPTY_ROOT_PASSWORD", "yes", None)]));
        assert_eq!(c[0].shown.user, "root");
        assert_eq!(c[0].password, None);
        assert_eq!(env_credentials(DbEngine::Mysql, &[]).len(), 1);
    }

    #[test]
    fn password_files_from_mounted_secrets() {
        let spec = json!({ "volumes": [
            { "name": "creds", "secret": { "secretName": "pg-creds" } },
            { "name": "picked", "secret": { "secretName": "other", "items": [{ "key": "root-pw", "path": "root" }] } },
        ]});
        let c = json!({ "name": "db", "volumeMounts": [{ "name": "creds", "mountPath": "/run/secrets/pg" }, { "name": "picked", "mountPath": "/etc/x/" }] });
        let e = env(&[("POSTGRES_PASSWORD_FILE", "/run/secrets/pg/password", None), ("MYSQL_ROOT_PASSWORD_FILE", "/etc/x/root", None), ("OTHER_FILE", "/nowhere/x", None)]);
        assert_eq!(
            file_refs(&spec, &c, &e),
            vec![("POSTGRES_PASSWORD".into(), "pg-creds".into(), "password".into()), ("MYSQL_ROOT_PASSWORD".into(), "other".into(), "root-pw".into())]
        );
    }

    #[test]
    fn primaries() {
        assert!(is_primary(&json!({ "cnpg.io/instanceRole": "primary" })));
        assert!(is_primary(&json!({ "spilo-role": "master" })));
        assert!(!is_primary(&json!({ "cnpg.io/instanceRole": "replica" })));
        assert!(!is_primary(&Json::Null));
    }

    #[test]
    fn keywords_and_reading() {
        assert_eq!(first_keyword("  -- note\n/* x */ (SELECT 1)"), "select");
        assert_eq!(first_keyword("# mysql comment\nshow tables"), "show");
        assert_eq!(first_keyword("/* unterminated"), "");
        assert!(is_read_statement(DbEngine::Postgres, "with x as (select 1) select * from x"));
        assert!(is_read_statement(DbEngine::Postgres, "EXPLAIN select 1"));
        assert!(!is_read_statement(DbEngine::Postgres, "update t set a = 1"));
        assert!(!is_read_statement(DbEngine::Postgres, "/* select */ delete from t"));
        assert!(!is_read_statement(DbEngine::Postgres, "describe t"));
        assert!(is_read_statement(DbEngine::Mysql, "describe t"));
        assert!(!is_read_statement(DbEngine::Mysql, "select * from t into outfile '/tmp/x'"));
        assert!(!is_read_statement(DbEngine::Mysql, "drop table t"));
    }

    #[test]
    fn quoting_and_pages() {
        assert_eq!(quote_ident(DbEngine::Postgres, "we\"ird"), "\"we\"\"ird\"");
        assert_eq!(quote_ident(DbEngine::Mysql, "we`ird"), "`we``ird`");
        let req = DbRowsRequest { session: "s".into(), schema: "public".into(), table: "orders".into(), offset: 200, limit: 100, order_by: Some("id".into()), desc: true };
        assert_eq!(rows_sql(DbEngine::Postgres, &req), "SELECT * FROM \"public\".\"orders\" ORDER BY \"id\" DESC NULLS LAST LIMIT 101 OFFSET 200");
        let req = DbRowsRequest { order_by: None, limit: 5000, ..req };
        assert_eq!(rows_sql(DbEngine::Mysql, &req), "SELECT * FROM `public`.`orders` LIMIT 1001 OFFSET 200");
    }

    #[test]
    fn long_cells_are_cut() {
        let long = "é".repeat(MAX_CELL + 10);
        let c = cut(&long);
        assert_eq!(c.chars().count(), MAX_CELL + 1);
        assert!(c.ends_with('…'));
        assert_eq!(cut("short"), "short");
    }

    // ── live servers: `KNS_TEST_PG="host=127.0.0.1 user=postgres password=pw dbname=shop"` and
    // `KNS_TEST_MYSQL="mysql://app:apppw@127.0.0.1:3306/shop"` (a `shop` database with `orders`).
    fn put(state: &AppState, engine: DbEngine, conn: Conn, database: &str) -> String {
        let dc = DbConn {
            engine,
            context: "test".into(),
            pod: ObjRef { context: "test".into(), gvr: Gvr::new("", "v1", "pods"), namespace: Some("ns".into()), name: "db-0".into() },
            port: 0,
            user: "u".into(),
            password: None,
            database: Mutex::new(database.into()),
            conn: tokio::sync::Mutex::new(conn),
            tunnel: Mutex::new(CancellationToken::new()),
            used: Mutex::new(Instant::now()),
        };
        lock(&state.ext::<DbSessions>().0).insert("s".into(), Arc::new(dc));
        "s".into()
    }

    fn q(sql: &str, write: bool) -> DbQueryRequest {
        DbQueryRequest { session: "s".into(), sql: sql.into(), write, confirm_text: None, limit: Some(10) }
    }

    async fn shared_checks(state: &AppState, engine: DbEngine, schema_name: &str) {
        let sch = schema(state, "s").await.unwrap();
        let s0 = sch.schemas.iter().find(|e| e.name == schema_name).expect("schema listed");
        assert!(s0.tables.iter().any(|t| t.name == "orders" && t.kind == "table"), "{s0:?}");
        let info = table_info(state, &DbTableRequest { session: "s".into(), schema: schema_name.into(), table: "orders".into() }).await.unwrap();
        assert!(info.columns.iter().any(|c| c.name == "id" && c.primary_key && !c.nullable), "{info:?}");
        assert!(!info.indexes.is_empty());
        let page = rows(state, &DbRowsRequest { session: "s".into(), schema: schema_name.into(), table: "orders".into(), offset: 0, limit: 2, order_by: Some("id".into()), desc: true }).await.unwrap();
        assert_eq!(page.rows.len(), 2);
        assert!(page.truncated);
        assert_eq!(page.columns[0].name, "id");
        // reading
        let r = query(state, &q("-- hi\nselect id, note from orders order by id", false)).await.unwrap();
        assert_eq!(r.rows.len(), 10);
        assert!(r.truncated);
        assert_eq!(r.command.as_deref(), Some("SELECT 10+"));
        let r = query(state, &q("select note from orders where note is null", false)).await.unwrap();
        assert_eq!(r.rows, vec![vec![None]]);
        // refused before it reaches the server
        assert_eq!(query(state, &q("delete from orders", false)).await.unwrap_err().reason, "DbReadOnly");
        // two statements: the server refuses to prepare them
        assert!(query(state, &q("select 1; delete from orders", false)).await.is_err());
        // a writing CTE is a read statement by keyword, and is refused by the server (cursor / read-only transaction)
        if engine == DbEngine::Postgres {
            assert!(query(state, &q("with d as (delete from orders where id = 1 returning id) select * from d", false)).await.is_err());
            assert_eq!(query(state, &q("select count(*) from orders where id = 1", false)).await.unwrap().rows[0][0].as_deref(), Some("1"));
        }
        // writes: flags not loaded = refused; read-only refused; protected needs the database name
        assert_eq!(query(state, &q("update orders set note = 'x', total = total + 1 where id = 3", true)).await.unwrap_err().reason, "NotLoaded");
        let set = |p: bool, ro: bool| crate::ctxflags::set(state, Some(HashMap::from([("test".to_string(), crate::ctxflags::CtxFlags { protected: p, read_only: ro })])));
        set(false, true);
        assert_eq!(query(state, &q("update orders set note = 'x', total = total + 1 where id = 3", true)).await.unwrap_err().reason, "ReadOnly");
        set(true, false);
        assert_eq!(query(state, &q("update orders set note = 'x', total = total + 1 where id = 3", true)).await.unwrap_err().reason, "ConfirmText");
        let r = query(state, &DbQueryRequest { confirm_text: Some("shop".into()), ..q("update orders set note = 'x', total = total + 1 where id = 3", true) }).await.unwrap();
        assert_eq!(r.affected, Some(1));
        assert!(r.columns.is_empty());
        let r = query(state, &q("select note from orders where id = 3", false)).await.unwrap();
        assert_eq!(r.rows, vec![vec![Some("x".into())]]);
        // a failed statement leaves the connection usable
        assert!(query(state, &q("select nope from orders", false)).await.is_err());
        assert!(query(state, &q("select 1", false)).await.is_ok());
    }

    #[tokio::test]
    async fn live_postgres() {
        let Ok(cfg) = std::env::var("KNS_TEST_PG") else { return };
        let (client, connection) = tokio_postgres::connect(&cfg, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(connection);
        let state = AppState::default();
        put(&state, DbEngine::Postgres, Conn::Pg(client), "shop");
        shared_checks(&state, DbEngine::Postgres, "public").await;
        let sch = schema(&state, "s").await.unwrap();
        // an empty schema is listed, a view is a view
        assert!(sch.schemas.iter().any(|e| e.name == "audit" && e.tables.iter().any(|t| t.name == "events")));
        assert!(sch.schemas.iter().any(|e| e.tables.iter().any(|t| t.name == "open_orders" && t.kind == "view")));
        let r = query(&state, &q("show server_version", false)).await.unwrap();
        assert_eq!(r.rows.len(), 1);
        let r = query(&state, &q("explain select * from orders", false)).await.unwrap();
        assert!(!r.rows.is_empty());
        // the handshake kns uses over the tunnel: TLS when offered (Ubuntu's server has a self-signed certificate)
        let tcp = tokio::net::TcpStream::connect(("127.0.0.1", 5432)).await.unwrap();
        let login = Login { ns: "", pod: "", port: 5432, user: "postgres", password: Some("pw") };
        let c = pg_handshake(tcp, &login, "shop", CancellationToken::new()).await.unwrap();
        let ssl: bool = c.query_one("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()", &[]).await.unwrap().get(0);
        assert!(ssl);
        let tcp = tokio::net::TcpStream::connect(("127.0.0.1", 5432)).await.unwrap();
        let e = pg_handshake(tcp, &Login { password: Some("wrong"), ..login }, "shop", CancellationToken::new()).await.unwrap_err();
        assert_eq!(e.reason, "DbAuth");
        let r = query(&state, &q("select id::int8, total from orders order by id limit 1", false)).await.unwrap();
        assert_eq!(r.columns[0].type_name.as_deref(), Some("int8"));
        assert_eq!(r.rows[0], vec![Some("1".into()), Some("1.50".into())]);
    }

    #[tokio::test]
    async fn live_mysql() {
        let Ok(url) = std::env::var("KNS_TEST_MYSQL") else { return };
        let conn = mysql_async::Conn::new(mysql_async::Opts::from_url(&url).unwrap()).await.unwrap();
        let state = AppState::default();
        put(&state, DbEngine::Mysql, Conn::My(conn), "shop");
        shared_checks(&state, DbEngine::Mysql, "shop").await;
        let r = query(&state, &q("show tables", false)).await.unwrap();
        assert!(r.rows.len() >= 2);
        let r = query(&state, &q("describe orders", false)).await.unwrap();
        assert!(r.rows.iter().any(|row| row[0].as_deref() == Some("id")));
        let r = query(&state, &q("select total, created from orders order by id limit 1", false)).await.unwrap();
        assert_eq!(r.rows[0][0].as_deref(), Some("1.50"));
        assert!(r.rows[0][1].is_some());
        // sql_select_limit is reset after each query
        let r = query(&state, &DbQueryRequest { limit: Some(1), ..q("select id from orders", false) }).await.unwrap();
        assert!(r.truncated);
        let r = query(&state, &q("select count(*) from orders", false)).await.unwrap();
        assert_eq!(r.rows[0][0].as_deref(), Some("23"));
    }
}
