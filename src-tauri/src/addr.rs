//! Pure: finds the in-cluster Service addresses inside an env value and rewrites them to local
//! forwards (§3 B-dev). No commands. Owner: B-dev.
//!
//! Recognised spellings of a Service `name` in namespace `ns` (with or without `:port`):
//! `name` (same namespace as the workload), `name.ns`, `name.ns.svc`, `name.ns.svc.cluster.local`,
//! and a StatefulSet pod's `pod.name.ns.svc[.cluster.local]`. Inside URLs (userinfo, path and query
//! kept), JDBC URLs, DSNs (`host=… port=…`) and comma lists (Kafka bootstrap servers). A bare name
//! counts only where a host is expected: after `://`, `@`, `host=`, with a port, or as the whole
//! value / a list item of a key that names an address (`*HOST*`, `*URL`, `*BOOTSTRAP*` ...), so an
//! app name like `OTEL_SERVICE_NAME=web` never matches.
use std::sync::LazyLock;

use regex::Regex;

use crate::ipc::{Hit, ServiceKind};

/// A Service the value may name, with its ports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SvcAddr {
    pub name: String,
    pub namespace: String,
    pub ports: Vec<u16>,
}

/// Where a rewrite points: the matched Service port goes to `localhost:<local_port>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub service: String,
    pub namespace: String,
    pub port: u16,
    pub local_port: u16,
}

/// One address found in a value; spans are byte offsets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub service: String,
    pub namespace: String,
    pub port: u16,
    /// host (and `:port` when explicit)
    pub span: (usize, usize),
    /// the host alone
    pub host: (usize, usize),
    pub explicit_port: bool,
    /// the number of a DSN `port=N` this address took its port from
    pub dsn_port: Option<(usize, usize)>,
}

static HOST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z0-9][A-Za-z0-9.-]*(?::(\d{1,5}))?").expect("host regex"));
static DSN_PORT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bport\s*=\s*(\d{1,5})").expect("dsn port regex"));
static SCHEME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)([a-z][a-z0-9+.-]*)://[^/\s,]*$").expect("scheme regex"));

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// The scheme's usual port (`http` 80, `postgresql` 5432, ...).
fn scheme_port(scheme: &str) -> Option<u16> {
    let s = scheme.to_ascii_lowercase();
    let s = s.rsplit(':').next().unwrap_or(&s);
    Some(match s {
        "http" | "ws" => 80,
        "https" | "wss" => 443,
        "postgres" | "postgresql" | "pgsql" => 5432,
        "mysql" | "mariadb" => 3306,
        "redis" | "rediss" => 6379,
        "mongodb" => 27017,
        "amqp" | "amqps" => 5672,
        "kafka" | "plaintext" => 9092,
        "memcached" => 11211,
        _ => return None,
    })
}

/// `(name, namespace)` a host spells, if it is a Service address form.
fn service_of<'a>(host: &'a str, home_ns: &'a str) -> Option<(&'a str, &'a str)> {
    let parts: Vec<&str> = host.split('.').collect();
    let svc_tail = |from: usize| matches!(&parts[from..], [] | ["svc"] | ["svc", "cluster", "local"]);
    match parts.len() {
        1 => Some((parts[0], home_ns)),
        2 => Some((parts[0], parts[1])),
        _ if svc_tail(2) => Some((parts[0], parts[1])),
        // StatefulSet pod behind a headless Service: pod.svc.ns.svc[.cluster.local]
        _ if parts.len() >= 4 && parts[3] == "svc" && svc_tail(3) => Some((parts[1], parts[2])),
        _ => None,
    }
}

/// Env keys whose value is an address, so a bare Service name as the whole value counts.
pub fn address_key(key: &str) -> bool {
    let k = key.to_ascii_uppercase();
    ["HOST", "ADDR", "SERVER", "BROKER", "BOOTSTRAP", "URL", "URI", "ENDPOINT", "DSN"].iter().any(|w| k.contains(w))
}

/// Every Service address in `value`. `home_ns` is the workload's namespace (for bare names);
/// `addr_key`: the env key names an address (`address_key`).
pub fn find(value: &str, services: &[SvcAddr], home_ns: &str, addr_key: bool) -> Vec<Found> {
    let mut out = Vec::new();
    for m in HOST.captures_iter(value) {
        let whole = m.get(0).expect("match");
        let (start, end) = (whole.start(), whole.end());
        let before = &value[..start];
        let after = &value[end..];
        if before.chars().next_back().is_some_and(|c| is_word(c) || c == '.' || c == '-') {
            continue;
        }
        if after.chars().next().is_some_and(is_word) {
            continue;
        }
        let port_text = m.get(1);
        let host_end = port_text.map_or(end, |p| p.start() - 1);
        let host = value[start..host_end].trim_end_matches('.');
        let host_end = start + host.len();
        let lower = host.to_ascii_lowercase();
        let Some((name, ns)) = service_of(&lower, home_ns) else { continue };
        let Some(svc) = services.iter().find(|s| s.name == name && s.namespace == ns) else { continue };
        let bare = !lower.contains('.');
        if bare {
            let lb = before.to_ascii_lowercase();
            let strong = before.ends_with("://")
                || before.ends_with('@')
                || lb.trim_end().ends_with("host=")
                || lb.trim_end().ends_with("server=")
                || port_text.is_some()
                || (addr_key && (before.trim_end().is_empty() || before.trim_end().ends_with(',')) && (after.trim_start().is_empty() || after.trim_start().starts_with([',', '/'])));
            if !strong {
                continue;
            }
        }
        let explicit = port_text.and_then(|p| p.as_str().parse::<u16>().ok());
        let (port, dsn_port) = match explicit {
            Some(p) => (Some(p), None),
            None => {
                let dsn = DSN_PORT.captures(value).and_then(|c| c.get(1)).and_then(|g| g.as_str().parse::<u16>().ok().map(|n| (n, (g.start(), g.end()))));
                let scheme = SCHEME.captures(before).and_then(|c| scheme_port(&c[1]));
                match (dsn, scheme) {
                    (Some((n, span)), _) if svc.ports.contains(&n) => (Some(n), Some(span)),
                    (_, Some(p)) if svc.ports.contains(&p) => (Some(p), None),
                    _ if svc.ports.len() == 1 => (Some(svc.ports[0]), None),
                    _ => (None, None),
                }
            }
        };
        let Some(port) = port.filter(|p| svc.ports.contains(p)) else { continue };
        out.push(Found {
            service: svc.name.clone(),
            namespace: svc.namespace.clone(),
            port,
            span: (start, if explicit.is_some() { end } else { host_end }),
            host: (start, host_end),
            explicit_port: explicit.is_some(),
            dsn_port,
        });
    }
    out
}

/// UTF-16 index of a byte offset (spans go to the webview, where strings are UTF-16).
fn utf16_at(value: &str, byte: usize) -> usize {
    value[..byte].encode_utf16().count()
}

/// The hits of a value; `with_span: false` for secret-sourced values (nothing of them is echoed).
pub fn find_cluster_addresses(value: &str, services: &[SvcAddr], home_ns: &str, addr_key: bool, with_span: bool) -> Vec<Hit> {
    find(value, services, home_ns, addr_key)
        .into_iter()
        .map(|f| Hit {
            span: with_span.then(|| (utf16_at(value, f.span.0), utf16_at(value, f.span.1))),
            service: f.service,
            namespace: f.namespace,
            port: f.port,
        })
        .collect()
}

/// `value` with every address that a target matches pointed at `localhost:<local_port>`. Scheme,
/// userinfo, path and query stay; a DSN's `host=` becomes `localhost` and its `port=` the local port.
pub fn rewrite(value: &str, targets: &[Target], services: &[SvcAddr], home_ns: &str, addr_key: bool) -> String {
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for f in find(value, services, home_ns, addr_key) {
        let Some(t) = targets.iter().find(|t| t.service == f.service && t.namespace == f.namespace && t.port == f.port) else { continue };
        if f.explicit_port {
            edits.push((f.span.0, f.span.1, format!("localhost:{}", t.local_port)));
        } else if let Some((ps, pe)) = f.dsn_port {
            edits.push((f.host.0, f.host.1, "localhost".into()));
            edits.push((ps, pe, t.local_port.to_string()));
        } else {
            edits.push((f.host.0, f.host.1, format!("localhost:{}", t.local_port)));
        }
    }
    edits.sort_by_key(|e| std::cmp::Reverse(e.0));
    edits.dedup_by(|a, b| a.0 == b.0);
    let mut out = value.to_string();
    let mut floor = usize::MAX;
    for (s, e, text) in edits {
        // never apply overlapping edits (two addresses sharing one DSN port)
        if e > floor {
            continue;
        }
        out.replace_range(s..e, &text);
        floor = s;
    }
    out
}

// ───────────────────────── connection strings (B2, `pf.copyUrl`) ─────────────────────────

/// The host part for a forward's bind address: `localhost` for 127.0.0.1 (what Kafka's LOCAL
/// listener and the rewrites use), else the literal (IPv6 in brackets).
pub fn local_host(address: &str) -> String {
    match address {
        "" | "127.0.0.1" => "localhost".into(),
        a if a.contains(':') => format!("[{a}]"),
        a => a.into(),
    }
}

fn conn_scheme(kind: ServiceKind) -> Option<&'static str> {
    match kind {
        ServiceKind::Postgres => Some("postgres"),
        ServiceKind::Mysql => Some("mysql"),
        ServiceKind::Redis => Some("redis"),
        ServiceKind::Mongodb => Some("mongodb"),
        ServiceKind::Rabbitmq => Some("amqp"),
        ServiceKind::Http | ServiceKind::SchemaRegistry => Some("http"),
        ServiceKind::Kafka | ServiceKind::Memcached | ServiceKind::Unknown => None,
    }
}

/// The connection string without credentials: `postgres://localhost:15432/`, `http://…/`, and a
/// bare `host:port` for Kafka bootstrap, memcached and unknown kinds.
pub fn conn_plain(kind: ServiceKind, host: &str, port: u16) -> String {
    match conn_scheme(kind) {
        Some(s) => format!("{s}://{host}:{port}/"),
        None => format!("{host}:{port}"),
    }
}

/// Userinfo characters kept as they are (RFC 3986 unreserved); everything else is %-encoded.
const USERINFO: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

/// A URL-shaped value (`scheme://[userinfo@]hosts[/…]`, also `jdbc:`) pointed at `host:port`: the
/// whole host list goes, userinfo, path and query stay. `None` when the value is not a URL.
pub fn retarget_url(value: &str, host: &str, port: u16) -> Option<String> {
    let (prefix, rest) = value.strip_prefix("jdbc:").map_or(("", value), |r| ("jdbc:", r));
    let i = rest.find("://")?;
    let scheme = &rest[..i];
    let mut chars = scheme.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) || !chars.all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)) {
        return None;
    }
    let after = &rest[i + 3..];
    let end = after.find(['/', '?', '#']).unwrap_or(after.len());
    let (authority, tail) = after.split_at(end);
    let userinfo = authority.rfind('@').map(|at| &authority[..=at]).unwrap_or("");
    Some(format!("{prefix}{scheme}://{userinfo}{host}:{port}{tail}"))
}

static CONN_DSN_HOST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(^|\s)host=\S+").expect("dsn host"));
static CONN_DSN_PORT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(^|\s)port=\S+").expect("dsn port"));

/// A libpq-style DSN (`host=… port=… user=… password=…`) pointed at `host:port`. `None` without `host=`.
pub fn retarget_dsn(value: &str, host: &str, port: u16) -> Option<String> {
    if !CONN_DSN_HOST.is_match(value) {
        return None;
    }
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let out = CONN_DSN_HOST.replace(value, |c: &regex::Captures| format!("{}host={host}", &c[1])).into_owned();
    Some(if CONN_DSN_PORT.is_match(&out) {
        CONN_DSN_PORT.replace(&out, |c: &regex::Captures| format!("{}port={port}", &c[1])).into_owned()
    } else {
        format!("{out} port={port}")
    })
}

/// The connection string of a forward. `secret`: the value of the Secret key the human picked: a
/// full URL or DSN is pointed at the forward (credentials, database and options kept); anything else
/// is a password, put in the URL with `user` (a sibling key of the same Secret, when one exists).
/// Kafka has no URL form: a password there gives the plain bootstrap address.
pub fn conn_string(kind: ServiceKind, host: &str, port: u16, secret: Option<&str>, user: Option<&str>) -> String {
    let Some(value) = secret.map(str::trim).filter(|v| !v.is_empty()) else { return conn_plain(kind, host, port) };
    if let Some(url) = retarget_url(value, host, port).or_else(|| retarget_dsn(value, host, port)) {
        return url;
    }
    let pw = percent_encoding::utf8_percent_encode(value, USERINFO);
    let user = user.map(|u| percent_encoding::utf8_percent_encode(u.trim(), USERINFO).to_string()).unwrap_or_default();
    match conn_scheme(kind) {
        _ if kind == ServiceKind::Kafka => conn_plain(kind, host, port),
        Some("http") => format!("http://{user}:{pw}@{host}:{port}/"),
        Some(s) => format!("{s}://{user}:{pw}@{host}:{port}/"),
        None => format!("{user}:{pw}@{host}:{port}"),
    }
}

/// What the UI may show of [`conn_string`]: built with the mask in place of the secret parts, never
/// by scrubbing the real string. A URL or DSN keeps its shape with the whole userinfo masked (the
/// user may come from the Secret too) and its query / `password=` through the redactor; a password
/// becomes `•••:•••@host:port` (user and password masked).
pub fn conn_preview(kind: ServiceKind, host: &str, port: u16, secret: Option<&str>) -> String {
    use crate::redact::{MASK, Redactor};
    let Some(value) = secret.map(str::trim).filter(|v| !v.is_empty()) else { return conn_plain(kind, host, port) };
    let mut r = Redactor::new();
    let out = if let Some(url) = retarget_url(value, host, port) {
        // mask the userinfo of the retargeted URL: everything between "://" and the last "@" before the host
        let i = url.find("://").map_or(0, |i| i + 3);
        let host_at = url[i..].find(&format!("{host}:{port}")).map_or(url.len(), |h| i + h);
        let masked = match url[i..host_at].rfind('@') {
            Some(_) => format!("{}{MASK}@{}", &url[..i], &url[host_at..]),
            None => url.clone(),
        };
        r.text(&masked)
    } else if let Some(dsn) = retarget_dsn(value, host, port) {
        CONN_DSN_SECRET.replace_all(&r.text(&dsn), |c: &regex::Captures| format!("{}{}={MASK}", &c[1], &c[2])).into_owned()
    } else {
        match conn_scheme(kind) {
            _ if kind == ServiceKind::Kafka => conn_plain(kind, host, port),
            Some("http") => format!("http://{MASK}:{MASK}@{host}:{port}/"),
            Some(s) => format!("{s}://{MASK}:{MASK}@{host}:{port}/"),
            None => format!("{MASK}:{MASK}@{host}:{port}"),
        }
    };
    crate::redact::clean_untrusted(&out, crate::redact::MAX_LINE)
}

/// DSN fields a preview always masks (`user=`, `password=` and friends), whatever the redactor kept.
static CONN_DSN_SECRET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(^|\s)(user|password|passwd|pass|sslpassword|sslkey)=\S+").expect("dsn secret"));

/// The key of the same Secret that holds the user for the picked password key: `DB_PASSWORD` →
/// `DB_USER` / `DB_USERNAME`; else `username` / `user` / `*_USER(NAME)`. Case-insensitive.
pub fn user_key<'a>(picked: &str, keys: &'a [String]) -> Option<&'a str> {
    let up = picked.to_ascii_uppercase();
    let find = |want: &str| keys.iter().find(|k| k.eq_ignore_ascii_case(want)).map(String::as_str);
    for suffix in ["PASSWORD", "PASSWD", "PASS", "PWD"] {
        if let Some(prefix) = up.strip_suffix(suffix) {
            for u in ["USER", "USERNAME", "USER_NAME"] {
                if let Some(k) = find(&format!("{prefix}{u}")) {
                    return Some(k);
                }
            }
        }
    }
    ["username", "user"].iter().find_map(|w| find(w)).or_else(|| {
        keys.iter()
            .find(|k| {
                let l = k.to_ascii_lowercase();
                !l.contains("pass") && (l.ends_with("_user") || l.ends_with("username") || l.ends_with("-user"))
            })
            .map(String::as_str)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conn_strings() {
        let k = ServiceKind::Postgres;
        assert_eq!(conn_plain(k, "localhost", 15432), "postgres://localhost:15432/");
        assert_eq!(conn_plain(ServiceKind::Kafka, "localhost", 9094), "localhost:9094");
        assert_eq!(local_host("127.0.0.1"), "localhost");
        assert_eq!(local_host("127.0.1.7"), "127.0.1.7");
        assert_eq!(local_host("::1"), "[::1]");
        // a full URL: credentials, database and options kept; every host replaced
        assert_eq!(
            conn_string(k, "localhost", 15432, Some("postgres://app:p%40ss@db.kns-spike.svc:5432/app?sslmode=disable"), None),
            "postgres://app:p%40ss@localhost:15432/app?sslmode=disable"
        );
        assert_eq!(conn_string(k, "localhost", 15432, Some("jdbc:postgresql://db:5432/app"), None), "jdbc:postgresql://localhost:15432/app");
        assert_eq!(
            conn_string(ServiceKind::Mongodb, "localhost", 27017, Some("mongodb://u:p@m-0.m:27017,m-1.m:27017/db?replicaSet=rs0"), None),
            "mongodb://u:p@localhost:27017/db?replicaSet=rs0"
        );
        // a DSN
        assert_eq!(conn_string(k, "localhost", 15432, Some("host=db port=5432 user=app password=pw"), None), "host=localhost port=15432 user=app password=pw");
        assert_eq!(conn_string(k, "localhost", 15432, Some("host=db user=app"), None), "host=localhost user=app port=15432");
        // a password, with and without a user; reserved characters encoded
        assert_eq!(conn_string(k, "localhost", 15432, Some("p@ss:w/rd"), Some("app")), "postgres://app:p%40ss%3Aw%2Frd@localhost:15432/");
        assert_eq!(conn_string(ServiceKind::Redis, "localhost", 16379, Some("pw"), None), "redis://:pw@localhost:16379/");
        assert_eq!(conn_string(ServiceKind::Kafka, "localhost", 9094, Some("pw"), Some("u")), "localhost:9094", "Kafka: no URL form");
        assert_eq!(conn_string(ServiceKind::Unknown, "127.0.1.3", 5000, Some("pw"), None), ":pw@127.0.1.3:5000");
        assert_eq!(conn_string(k, "localhost", 15432, Some("  "), None), "postgres://localhost:15432/", "empty = plain");
    }

    #[test]
    fn conn_preview_never_shows_the_secret() {
        let pg = ServiceKind::Postgres;
        let p = conn_preview(pg, "localhost", 15432, Some("s3cr3t-value"));
        assert_eq!(p, "postgres://•••:•••@localhost:15432/", "user and password masked");
        let p = conn_preview(ServiceKind::Unknown, "127.0.1.3", 5000, Some("abc"));
        assert_eq!(p, "•••:•••@127.0.1.3:5000", "a short password on a kind without a scheme");
        assert!(!conn_preview(ServiceKind::Memcached, "localhost", 1, Some("x@y")).contains("x@y"));
        let url = "postgres://app:s3cr3t@db:5432/app?sslmode=disable&password=q1w2";
        let p = conn_preview(pg, "localhost", 15432, Some(url));
        assert!(p.starts_with("postgres://•••@localhost:15432/app?sslmode=disable"), "{p}");
        assert!(!p.contains("s3cr3t") && !p.contains("q1w2") && !p.contains("app:"), "{p}");
        let at_in_pw = "postgres://app:p@ss@db:5432/app";
        let p = conn_preview(pg, "localhost", 15432, Some(at_in_pw));
        assert_eq!(p, "postgres://•••@localhost:15432/app");
        let dsn = "host=db port=5432 user=app password=pw dbname=app";
        let p = conn_preview(pg, "localhost", 15432, Some(dsn));
        assert!(!p.contains("pw ") && !p.contains("user=app") && p.contains("host=localhost port=15432") && p.contains("dbname=app"), "{p}");
        assert_eq!(conn_preview(ServiceKind::Kafka, "localhost", 9094, Some("pw")), "localhost:9094");
        assert_eq!(conn_preview(pg, "localhost", 15432, None), "postgres://localhost:15432/");
    }

    #[test]
    fn user_keys() {
        let keys = |k: &[&str]| k.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(user_key("DB_PASSWORD", &keys(&["DB_PASSWORD", "DB_USER", "username"])), Some("DB_USER"));
        assert_eq!(user_key("password", &keys(&["password", "username"])), Some("username"));
        assert_eq!(user_key("POSTGRES_PASSWORD", &keys(&["POSTGRES_PASSWORD", "POSTGRES_USER"])), Some("POSTGRES_USER"));
        assert_eq!(user_key("pw", &keys(&["pw", "app_user"])), Some("app_user"));
        assert_eq!(user_key("pw", &keys(&["pw", "user_password"])), None);
    }

    fn services() -> Vec<SvcAddr> {
        let s = |name: &str, namespace: &str, ports: &[u16]| SvcAddr { name: name.into(), namespace: namespace.into(), ports: ports.to_vec() };
        vec![
            s("kafka", "kafka", &[9092, 9094]),
            s("kafka-headless", "kafka", &[9092]),
            s("schema-registry", "kafka", &[8081]),
            s("postgres", "payments", &[5432]),
            s("web", "kns-spike", &[80]),
            s("db", "kns-spike", &[5432]),
            s("redis", "shop", &[6379]),
            s("api", "shop", &[8080, 9090]),
        ]
    }

    /// (service, ns, port) of every hit.
    fn hits(value: &str, home: &str) -> Vec<(String, String, u16)> {
        hits_k(value, home, false)
    }

    fn hits_k(value: &str, home: &str, addr_key: bool) -> Vec<(String, String, u16)> {
        find(value, &services(), home, addr_key).into_iter().map(|f| (f.service, f.namespace, f.port)).collect()
    }

    fn one(value: &str, home: &str) -> (String, u16) {
        let h = hits(value, home);
        assert_eq!(h.len(), 1, "{value}: {h:?}");
        (h[0].0.clone(), h[0].2)
    }

    #[test]
    fn every_spelling() {
        assert_eq!(one("kafka.kafka.svc.cluster.local:9092", "shop"), ("kafka".into(), 9092));
        assert_eq!(one("kafka.kafka.svc:9092", "shop"), ("kafka".into(), 9092));
        assert_eq!(one("kafka.kafka:9094", "shop"), ("kafka".into(), 9094));
        assert_eq!(one("redis:6379", "shop"), ("redis".into(), 6379));
        assert_eq!(hits_k("redis", "shop", true), vec![("redis".into(), "shop".into(), 6379)], "a whole value of an address key; single port");
        assert!(hits("redis", "shop").is_empty(), "not for any key");
        assert_eq!(one("http://web.kns-spike.svc.cluster.local:80", "kns-spike"), ("web".into(), 80));
        assert_eq!(one("http://web.kns-spike.svc.cluster.local", "x"), ("web".into(), 80), "port from the scheme");
        assert_eq!(one("KAFKA.KAFKA.SVC:9092", "x"), ("kafka".into(), 9092), "case-insensitive");
        assert_eq!(one("web.kns-spike.svc.cluster.local.:80", "x"), ("web".into(), 80), "trailing root dot");
    }

    #[test]
    fn urls_dsns_jdbc_and_lists() {
        assert_eq!(one("postgres://app:pw@postgres.payments.svc:5432/app?sslmode=disable", "x"), ("postgres".into(), 5432));
        assert_eq!(one("postgres://app:pw@db/app", "kns-spike"), ("db".into(), 5432), "bare after @");
        assert_eq!(one("jdbc:postgresql://postgres.payments:5432/app", "x"), ("postgres".into(), 5432));
        assert_eq!(one("jdbc:postgresql://postgres.payments/app", "x"), ("postgres".into(), 5432), "jdbc scheme default");
        assert_eq!(one("host=db port=5432 dbname=app user=app", "kns-spike"), ("db".into(), 5432));
        assert_eq!(one("host=postgres.payments.svc dbname=app", "x"), ("postgres".into(), 5432), "single port");
        let list = hits("kafka-0.kafka-headless.kafka.svc.cluster.local:9092,kafka-1.kafka-headless.kafka.svc:9092", "x");
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|h| h.0 == "kafka-headless" && h.2 == 9092));
        assert_eq!(hits("kafka:9092, redis:6379", "kafka").len(), 1, "redis is not in namespace kafka");
        assert_eq!(hits("kafka.kafka:9092,schema-registry.kafka:8081", "x").len(), 2);
        assert_eq!(one("redis://:secret@redis.shop:6379/0", "x"), ("redis".into(), 6379));
        assert_eq!(one("http://schema-registry.kafka:8081/subjects", "x"), ("schema-registry".into(), 8081));
    }

    #[test]
    fn ordinary_text_never_matches() {
        for v in [
            "kafka-events",
            "use kafka for events",
            "my-web-app",
            "web_server",
            "api.github.com",
            "kafka.example.com:9092",
            "redis.shop.example:6379",
            "web.other-ns:80",
            "api.shop:7777",
            "db_host",
            "v1.web.kns-spike",
            "",
            "info",
        ] {
            assert!(hits(v, "kns-spike").is_empty() && hits(v, "shop").is_empty(), "{v}");
        }
        assert!(hits("api.shop", "x").is_empty(), "two ports and no hint: unknown port, no hit");
        // single-port Services in the home namespace: app names and prose stay text
        for v in ["web", "db", "use web for events", "web db", " web "] {
            assert!(hits(v, "kns-spike").is_empty(), "{v}");
        }
        assert!(hits_k("use web for events", "kns-spike", true).is_empty(), "prose, even for an address key");
        assert_eq!(hits_k("web, db", "kns-spike", true).len(), 2, "a list of an address key");
        assert!(address_key("DB_HOST") && address_key("KAFKA_BOOTSTRAP_SERVERS") && address_key("SCHEMA_REGISTRY_URL"));
        assert!(!address_key("OTEL_SERVICE_NAME") && !address_key("SPRING_APPLICATION_NAME"));
        assert!(hits("http://api.shop", "x").is_empty(), "scheme port 80 is not one of its ports");
    }

    #[test]
    fn spans_are_utf16_and_secret_hits_have_none() {
        let v = "é http://web.kns-spike:80/x";
        let h = find_cluster_addresses(v, &services(), "x", false, true);
        assert_eq!(h[0].span, Some((9, 25)), "é is one UTF-16 unit, two bytes");
        assert_eq!(find_cluster_addresses(v, &services(), "x", false, false)[0].span, None);
    }

    fn targets() -> Vec<Target> {
        let t = |service: &str, namespace: &str, port: u16, local_port: u16| Target { service: service.into(), namespace: namespace.into(), port, local_port };
        vec![
            t("kafka", "kafka", 9092, 9094),
            t("kafka-headless", "kafka", 9092, 9094),
            t("postgres", "payments", 5432, 15432),
            t("db", "kns-spike", 5432, 15433),
            t("web", "kns-spike", 80, 18080),
            t("schema-registry", "kafka", 8081, 18081),
        ]
    }

    fn rw(v: &str, home: &str) -> String {
        rewrite(v, &targets(), &services(), home, false)
    }

    #[test]
    fn rewrites_keep_scheme_userinfo_path_query() {
        assert_eq!(rw("kafka.kafka.svc.cluster.local:9092", "x"), "localhost:9094");
        assert_eq!(rw("postgres://app:pw@postgres.payments.svc:5432/app?sslmode=disable", "x"), "postgres://app:pw@localhost:15432/app?sslmode=disable");
        assert_eq!(rw("jdbc:postgresql://postgres.payments/app", "x"), "jdbc:postgresql://localhost:15432/app");
        assert_eq!(rw("http://web.kns-spike.svc.cluster.local", "x"), "http://localhost:18080");
        assert_eq!(rw("http://web.kns-spike.svc.cluster.local:80/health?x=1", "x"), "http://localhost:18080/health?x=1");
        assert_eq!(rw("host=db port=5432 dbname=app", "kns-spike"), "host=localhost port=15433 dbname=app");
        assert_eq!(
            rw("kafka-0.kafka-headless.kafka.svc.cluster.local:9092,kafka-1.kafka-headless.kafka.svc:9092", "x"),
            "localhost:9094,localhost:9094"
        );
        assert_eq!(rw("kafka.kafka:9092,schema-registry.kafka:8081", "x"), "localhost:9094,localhost:18081");
        assert_eq!(rw("redis.shop:6379", "x"), "redis.shop:6379", "no target: unchanged");
        assert_eq!(rw("kafka.kafka:9094", "x"), "kafka.kafka:9094", "another port of the Service: unchanged");
        assert_eq!(rw("plain text", "x"), "plain text");
    }
}
