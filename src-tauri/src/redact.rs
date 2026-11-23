//! Redaction layer (docs/plan-features.md §2.3): the one module every agent-facing path uses
//! (MCP, packs, trap bundles, `env_resolve`, describe text, error messages).
//!
//! Rules, in order:
//! 1. **Kind deny-list** (`DENY` plus Secrets): Secret `data`/`stringData` values masked (keys kept),
//!    Helm release Secrets and Rancher token/credential kinds reduced to apiVersion/kind/metadata,
//!    External Secrets data/provider and SealedSecret `encryptedData` dropped or masked.
//! 2. **Annotation** `kubectl.kubernetes.io/last-applied-configuration` masked.
//! 3. **Key rule** on every string leaf at any depth ([`is_secret_key`]). An env-style entry
//!    `{name, value}` uses `name` as the key of `value`. A bare `--password` flag in an array masks
//!    the next element.
//! 4. **URL userinfo** `scheme://user:pw@host` → `scheme://user:•••@host`, and secret-named query
//!    parameters (`?token=…`).
//! 5. **Text patterns** on every text and non-masked leaf: PEM blocks, JWTs, `Bearer`/`Basic`
//!    credentials, JSON `"<secret key>": "…"`, CLI flags `--<secret key>=…`, and YAML /
//!    properties / INI lines `<secret key>: …` (file-valued ConfigMaps, describe text).
//! 6. **Kubeconfig-shaped YAML** (`users:` with `token:` / `client-key-data:`): credential values masked.
//!
//! Redaction is best effort: an unknown CRD with a secret under an innocuous key leaks. The UI
//! says "redacted N values", never "safe". Known gaps: YAML block scalars (`password: |`) keep their
//! following lines; JSON nested inside JSON strings (escaped quotes) is not parsed.
use std::{collections::BTreeMap, sync::LazyLock};

use regex::{Captures, Regex};
use serde_json::{Map, json};

use crate::{
    contract::pack::{RedactionPreview, RedactionReport},
    ipc::{Gvr, Json},
};

/// What every masked value is replaced with.
pub const MASK: &str = "•••";
/// Standard per-line cap of [`clean_untrusted`].
pub const MAX_LINE: usize = 4096;

// ───────────────────────── key rule ─────────────────────────

static KEY_RULE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(^|[_.-])(PASS(WORD|WD)?|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIALS?|DSN|AUTH(_?TOKEN)?|COOKIE|SESSION_?(KEY|SECRET)?)([_.-]|$)")
        .expect("key rule")
});

/// Last segments that make a secret-sounding key a *reference* or setting, not a value:
/// `secretName`, `PASSWORD_FILE`, `TOKEN_URL`, `tokenPath`.
const REFERENCE_SUFFIXES: &[&str] = &["NAME", "NAMESPACE", "REF", "FILE", "PATH", "TYPE", "MODE", "ENABLED", "URL", "URI", "ENDPOINT", "TTL"];

/// `dbPassword` → `DB_PASSWORD`, `example.com/token` → `EXAMPLE.COM.TOKEN`: camelCase humps become
/// `_` segments and `/` becomes `.`, so the segment-anchored key rule sees them.
fn normalize(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    let mut prev: Option<char> = None;
    for c in key.chars() {
        if c == '/' {
            out.push('.');
        } else {
            if c.is_ascii_uppercase() && prev.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit()) {
                out.push('_');
            }
            out.push(c.to_ascii_uppercase());
        }
        prev = Some(c);
    }
    out
}

/// The key rule (§2.3 rule 3): true when a value stored under `key` is a credential.
///
/// Segment-anchored (`author`, `authority`, `bypass` do not match); camelCase is split first
/// (`dbPassword`, `apiKey`). Keys ending in `KEY` match too, except `PUBLIC_KEY`, `*_KEY_ID` and
/// the bare `key` (the field of a `secretKeyRef`). Reference-like last segments (`secretName`,
/// `PASSWORD_FILE`, `TOKEN_URL`) do not match.
pub fn is_secret_key(key: &str) -> bool {
    let norm = normalize(key);
    let last = norm.rsplit(['_', '.', '-']).next().unwrap_or_default();
    if last.len() < norm.len() && REFERENCE_SUFFIXES.contains(&last) {
        return false;
    }
    if KEY_RULE.is_match(&norm) {
        return true;
    }
    norm.len() > 3 && norm.ends_with("KEY") && !norm.ends_with("PUBLIC_KEY") && !norm.ends_with("PUBLICKEY")
}

// ───────────────────────── kind deny-list ─────────────────────────

enum Action {
    /// Keep only apiVersion, kind and identifying metadata.
    DropAll,
    /// Replace these JSON pointers with `{"redacted": "kind"}` when present.
    Drop(&'static [&'static str]),
    /// Mask every value of the object at this pointer, keys kept.
    MaskValues(&'static str),
}

struct Deny {
    /// exact group, or `*.suffix` for the group and its subgroups
    group: &'static str,
    /// exact resources; empty = any
    resources: &'static [&'static str],
    /// resource (or lowercased kind) contains one of these; empty = no check
    contains: &'static [&'static str],
    action: Action,
}

/// Kinds whose payload never leaves Rust. Secrets are handled first (Helm release Secrets dropped,
/// other Secrets' values masked). Extend by fixture (`tests/fixtures/redact/`).
const DENY: &[Deny] = &[
    // Rancher: tokens.management.cattle.io, cluster registration tokens, cloud credentials, ...
    Deny { group: "*.cattle.io", resources: &[], contains: &["token", "credential"], action: Action::DropAll },
    Deny {
        group: "external-secrets.io",
        resources: &["externalsecrets", "clusterexternalsecrets", "pushsecrets"],
        contains: &[],
        action: Action::Drop(&["/spec/data", "/spec/dataFrom", "/spec/externalSecretSpec/data", "/spec/externalSecretSpec/dataFrom"]),
    },
    Deny {
        group: "external-secrets.io",
        resources: &["secretstores", "clustersecretstores"],
        contains: &[],
        action: Action::Drop(&["/spec/provider"]),
    },
    Deny { group: "bitnami.com", resources: &["sealedsecrets"], contains: &[], action: Action::MaskValues("/spec/encryptedData") },
];

fn group_matches(pattern: &str, group: &str) -> bool {
    match pattern.strip_prefix("*.") {
        Some(suffix) => group == suffix || group.strip_suffix(suffix).is_some_and(|g| g.ends_with('.')),
        None => pattern == group,
    }
}

fn deny_for(gvr: &Gvr, kind: &str) -> Option<&'static Deny> {
    let kind = kind.to_ascii_lowercase();
    DENY.iter().find(|d| {
        group_matches(d.group, &gvr.group)
            && (d.resources.is_empty() || d.resources.contains(&gvr.resource.as_str()))
            && (d.contains.is_empty() || d.contains.iter().any(|c| gvr.resource.contains(c) || kind.contains(c)))
    })
}

/// apiVersion, kind, identifying metadata and `type`; everything else replaced by `redacted: kind`.
fn minimal(obj: &Json) -> Json {
    let mut meta = Map::new();
    for key in ["name", "namespace", "uid", "creationTimestamp", "labels"] {
        if let Some(v) = obj.pointer(&format!("/metadata/{key}")) {
            meta.insert(key.into(), v.clone());
        }
    }
    let mut out = json!({ "apiVersion": obj["apiVersion"], "kind": obj["kind"], "metadata": meta, "redacted": "kind" });
    if let Some(t) = obj.get("type") {
        out["type"] = t.clone();
    }
    out
}

// ───────────────────────── text patterns ─────────────────────────

static KUBE_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^([ \t]*(?:-[ \t]+)?(?:token|client-key-data|client-certificate-data|password|id-token|refresh-token|access-token)[ \t]*:[ \t]*)(\S[^\r\n]*)")
        .expect("kubeconfig")
});
static URL_USERINFO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([A-Za-z][A-Za-z0-9+.-]*://)([^:@/\s]*):([^@/\s]+)@").expect("userinfo"));
static URL_QUERY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"([?&])([A-Za-z0-9_.-]+)=([^&\s#"']+)"#).expect("query"));
static PEM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)-----BEGIN ([A-Z0-9 ]+)-----(.*?)-----END ([A-Z0-9 ]+)-----").expect("pem"));
static JWT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}").expect("jwt"));
static BEARER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(bearer|basic)([ \t]+)([A-Za-z0-9._~+/=-]{8,})").expect("bearer"));
static JSON_PAIR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""([A-Za-z0-9_.-]+)"(\s*:\s*)"((?:[^"\\]|\\.)*)""#).expect("json"));
static FLAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"--([A-Za-z0-9_.-]+)(=|[ \t]+)([^\s"',]+)"#).expect("flag"));
static BARE_FLAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^--?([A-Za-z0-9_.-]+)$").expect("bare flag"));
static LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^([ \t]*(?:-[ \t]+)?)([A-Za-z0-9_][A-Za-z0-9_.-]*)([ \t]*[:=][ \t]*)(\S[^\r\n]*)").expect("line")
});

/// `key: |` / `key: >-` opening a YAML block scalar; group 1 = indentation incl. a list dash.
/// `key=value` in the middle of a line (logfmt, "connecting with password=x"). The start of a line
/// is LINE's; the character before the key is captured because the regex crate has no lookbehind.
static PAIR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"([ \t,;(\[{])([A-Za-z0-9_][A-Za-z0-9_.-]*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;&"')\]}]+)"#).expect("pair")
});
static BLOCK_OPENER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([ \t]*(?:-[ \t]+)?)([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:[ \t]*[|>][-+0-9]*[ \t]*$").expect("block opener"));

/// Values a line rule leaves alone: empty literals and YAML block openers.
const NOT_A_VALUE: &[&str] = &["|", "|-", "|+", ">", ">-", ">+", "{}", "[]", "\"\"", "''", "~", "null"];

const LAST_APPLIED: &str = "/metadata/annotations/kubectl.kubernetes.io~1last-applied-configuration";

// ───────────────────────── Redactor ─────────────────────────

/// Applies the rules and counts what it masked. One per response; `report()` goes into it.
#[derive(Debug, Default, Clone)]
pub struct Redactor {
    pub count: u32,
    /// rule id → count: `kind`, `annotation`, `key`, `url`, `pem`, `jwt`, `bearer`, `json`, `flag`, `line`, `kubeconfig`
    pub by_rule: BTreeMap<&'static str, u32>,
}

impl Redactor {
    pub fn new() -> Self {
        Self::default()
    }

    fn bump(&mut self, rule: &'static str, n: u32) {
        if n > 0 {
            self.count += n;
            *self.by_rule.entry(rule).or_default() += n;
        }
    }

    /// Replaces each match for which `f` returns a replacement, counting them under `rule`.
    fn replace(&mut self, rule: &'static str, re: &Regex, s: &str, f: impl Fn(&Captures) -> Option<String>) -> String {
        let mut n = 0;
        let out = re
            .replace_all(s, |c: &Captures| match f(c) {
                Some(r) => {
                    n += 1;
                    r
                }
                None => c[0].to_string(),
            })
            .into_owned();
        self.bump(rule, n);
        out
    }

    /// Masks one string in place under `rule` (unless it already is the mask).
    fn mask(&mut self, rule: &'static str, s: &mut String) {
        if s != MASK {
            *s = MASK.to_string();
            self.bump(rule, 1);
        }
    }

    /// A whole Kubernetes object, in place (rules 1–6).
    pub fn object(&mut self, gvr: &Gvr, obj: &mut Json) {
        let kind = obj["kind"].as_str().unwrap_or_default().to_string();
        // rule 1: kinds
        let is_secret = (gvr.group.is_empty() && gvr.resource == "secrets")
            || (kind == "Secret" && obj["apiVersion"].as_str() == Some("v1"));
        if is_secret {
            if obj["type"].as_str() == Some("helm.sh/release.v1") {
                *obj = minimal(obj);
                self.bump("kind", 1);
                return;
            }
            for field in ["data", "stringData"] {
                self.mask_values(obj.get_mut(field));
            }
        } else if let Some(deny) = deny_for(gvr, &kind) {
            match deny.action {
                Action::DropAll => {
                    *obj = minimal(obj);
                    self.bump("kind", 1);
                    return;
                }
                Action::Drop(pointers) => {
                    for p in pointers {
                        if let Some(v) = obj.pointer_mut(p) {
                            *v = json!({ "redacted": "kind" });
                            self.bump("kind", 1);
                        }
                    }
                }
                Action::MaskValues(p) => self.mask_values(obj.pointer_mut(p)),
            }
        }
        // rule 2: last-applied (a full copy of the object as applied, Secret data included)
        if let Some(Json::String(s)) = obj.pointer_mut(LAST_APPLIED) {
            self.mask("annotation", s);
        }
        // rules 3–6 on every leaf
        self.walk(obj, None);
    }

    /// Masks every string value of an object (keys kept), counted as `kind`.
    fn mask_values(&mut self, v: Option<&mut Json>) {
        if let Some(Json::Object(map)) = v {
            for value in map.values_mut() {
                match value {
                    Json::String(s) => self.mask("kind", s),
                    Json::Null => {}
                    other => {
                        *other = Json::String(MASK.into());
                        self.bump("kind", 1);
                    }
                }
            }
        }
    }

    fn walk(&mut self, v: &mut Json, key: Option<&str>) {
        match v {
            Json::String(s) => self.leaf(key, s),
            Json::Array(items) => {
                // `["--api-key", "x"]`: a bare secret flag masks the element after it
                let mut mask_next = false;
                for item in items.iter_mut() {
                    if let Json::String(s) = item {
                        if mask_next {
                            mask_next = false;
                            self.mask("flag", s);
                            continue;
                        }
                        mask_next = BARE_FLAG.captures(s).is_some_and(|c| is_secret_key(&c[1]));
                    } else {
                        mask_next = false;
                    }
                    self.walk(item, key);
                }
            }
            Json::Object(map) => {
                // env-style entries: `{name: DB_PASSWORD, value: x}` keys `value` by its `name`
                let alias = match (map.get("name"), map.get("value")) {
                    (Some(Json::String(n)), Some(Json::String(_))) => Some(n.clone()),
                    _ => None,
                };
                for (k, child) in map.iter_mut() {
                    let effective = if k == "value" { alias.as_deref().unwrap_or(k) } else { k.as_str() };
                    self.walk(child, Some(effective));
                }
            }
            _ => {}
        }
    }

    fn leaf(&mut self, key: Option<&str>, s: &mut String) {
        if s == MASK {
            return;
        }
        if key.is_some_and(is_secret_key) {
            self.mask("key", s);
            return;
        }
        let scrubbed = self.text(s);
        if scrubbed != *s {
            *s = scrubbed;
        }
    }

    /// One env value: masked when the key is secret, else text patterns.
    pub fn env_value(&mut self, key: &str, value: &str) -> String {
        if is_secret_key(key) {
            if value != MASK {
                self.bump("key", 1);
            }
            return MASK.to_string();
        }
        self.text(value)
    }

    /// URL userinfo and secret-named query parameters (rule 4).
    pub fn url(&mut self, s: &str) -> String {
        let s = self.replace("url", &URL_USERINFO, s, |c| (&c[3] != MASK).then(|| format!("{}{}:{MASK}@", &c[1], &c[2])));
        self.replace("url", &URL_QUERY, &s, |c| (is_secret_key(&c[2]) && &c[3] != MASK).then(|| format!("{}{}={MASK}", &c[1], &c[2])))
    }

    /// Free text: logs, events, describe output, file contents, args (rules 4–6).
    pub fn text(&mut self, s: &str) -> String {
        let mut out = s.to_string();
        if out.contains("users:") && (out.contains("token:") || out.contains("client-key-data:")) {
            out = self.replace("kubeconfig", &KUBE_LINE, &out, |c| (!c[2].starts_with(MASK)).then(|| format!("{}{MASK}", &c[1])));
        }
        out = self.url(&out);
        out = self.replace("pem", &PEM, &out, |c| {
            (c[2].trim() != MASK).then(|| format!("-----BEGIN {}-----{MASK}-----END {}-----", &c[1], &c[3]))
        });
        out = self.replace("jwt", &JWT, &out, |_| Some(MASK.to_string()));
        out = self.replace("bearer", &BEARER, &out, |c| {
            // a credential has digits or base64/token punctuation; "Basic authentication" does not
            let token = &c[3];
            (token.chars().any(|ch| ch.is_ascii_digit() || "+/=._~-".contains(ch))).then(|| format!("{}{}{MASK}", &c[1], &c[2]))
        });
        out = self.replace("json", &JSON_PAIR, &out, |c| {
            (is_secret_key(&c[1]) && &c[3] != MASK).then(|| format!("\"{}\"{}\"{MASK}\"", &c[1], &c[2]))
        });
        out = self.replace("flag", &FLAG, &out, |c| {
            (is_secret_key(&c[1]) && &c[3] != MASK && !c[3].starts_with('-')).then(|| format!("--{}{}{MASK}", &c[1], &c[2]))
        });
        out = self.replace("pair", &PAIR, &out, |c| {
            let value = c[3].trim_matches(|ch| ch == '"' || ch == '\'');
            // a bare `auth=` mid-line is usually a mode or a result ("auth=ok"), not a credential
            let key = &c[2];
            (is_secret_key(key) && !key.eq_ignore_ascii_case("auth") && !value.is_empty() && !value.starts_with(MASK))
                .then(|| format!("{}{key}={MASK}", &c[1]))
        });
        let out = self.replace("line", &LINE, &out, |c| {
            let value = c[4].trim_end();
            (is_secret_key(&c[2]) && !value.starts_with(MASK) && !NOT_A_VALUE.contains(&value))
                .then(|| format!("{}{}{}{MASK}", &c[1], &c[2], &c[3]))
        });
        self.block_scalars(&out)
    }

    /// YAML block scalars under a secret key (`password: |` followed by indented lines): every
    /// content line becomes `MASK`, counted once per block under "line".
    fn block_scalars(&mut self, s: &str) -> String {
        if !s.contains(": |") && !s.contains(": >") && !s.contains(":|") && !s.contains(":>") {
            return s.to_string();
        }
        let mut out = String::with_capacity(s.len());
        // indentation of the secret key whose block is being masked, and whether it was counted
        let mut block: Option<(usize, bool)> = None;
        for line in s.split_inclusive('\n') {
            let body = line.trim_end_matches(['\n', '\r']);
            let indent = body.len() - body.trim_start().len();
            if let Some((key_indent, counted)) = block {
                if body.trim().is_empty() {
                    out.push_str(line);
                    continue;
                }
                if indent > key_indent {
                    if body.trim() != MASK {
                        if !counted {
                            *self.by_rule.entry("line").or_default() += 1;
                            self.count += 1;
                            block = Some((key_indent, true));
                        }
                        out.push_str(&body[..indent]);
                        out.push_str(MASK);
                        out.push_str(&line[body.len()..]);
                    } else {
                        out.push_str(line);
                    }
                    continue;
                }
                block = None;
            }
            if let Some(c) = BLOCK_OPENER.captures(body)
                && is_secret_key(&c[2])
            {
                block = Some((c[1].len(), false));
            }
            out.push_str(line);
        }
        out
    }

    pub fn report(&self) -> RedactionReport {
        RedactionReport { count: self.count, by_rule: self.by_rule.iter().map(|(k, v)| ((*k).to_string(), *v)).collect() }
    }
}

// ───────────────────────── untrusted text ─────────────────────────

static ANSI: LazyLock<Regex> = LazyLock::new(|| {
    // CSI, OSC (BEL or ST terminated, or unterminated to the end), and two-byte escapes
    Regex::new(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])").expect("ansi")
});

/// Characters that are invisible or reorder text: Unicode tags, bidi controls, zero-width.
fn is_hidden(c: char) -> bool {
    matches!(c,
        '\u{E0000}'..='\u{E007F}'
        | '\u{202A}'..='\u{202E}'
        | '\u{2066}'..='\u{2069}'
        | '\u{200E}' | '\u{200F}'
        | '\u{200B}'..='\u{200D}'
        | '\u{2060}' | '\u{FEFF}')
}

/// Cluster or agent text made safe to show and to hand to an agent: ANSI escapes, control
/// characters (except `\n` and `\t`), Unicode tag characters, bidi controls and zero-width
/// characters removed; every line capped at `max_line` bytes (on a char boundary).
pub fn clean_untrusted(s: &str, max_line: usize) -> String {
    let no_ansi = ANSI.replace_all(s, "");
    let mut out = String::with_capacity(no_ansi.len());
    let mut line_bytes = 0;
    for c in no_ansi.chars() {
        if c == '\n' {
            out.push(c);
            line_bytes = 0;
            continue;
        }
        if (c.is_control() && c != '\t') || is_hidden(c) {
            continue;
        }
        if line_bytes + c.len_utf8() > max_line {
            continue;
        }
        line_bytes += c.len_utf8();
        out.push(c);
    }
    out
}

/// What the Redactor makes of `text` (the preview behind the pack and "redacted N values" UI).
pub fn preview(text: &str) -> RedactionPreview {
    let mut r = Redactor::new();
    let text = r.text(&clean_untrusted(text, MAX_LINE));
    RedactionPreview { text, redactions: r.report() }
}

pub mod cmd {
    use crate::ipc::{RedactionPreview, Result};

    #[tauri::command]
    pub fn redact_preview(text: String) -> Result<RedactionPreview> {
        Ok(super::preview(&text))
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn fixtures() -> Vec<(String, Json)> {
        let dir: PathBuf = [env!("CARGO_MANIFEST_DIR"), "tests", "fixtures", "redact"].iter().collect();
        let mut out: Vec<(String, Json)> = std::fs::read_dir(&dir)
            .expect("fixture dir")
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .map(|p| {
                let name = p.file_stem().unwrap_or_default().to_string_lossy().into_owned();
                let text = std::fs::read_to_string(&p).expect("read fixture");
                let json: Json = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
                (name, json)
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// Runs one fixture's input; returns the output and the redactor.
    fn run(name: &str, fx: &Json) -> (Json, Redactor) {
        let mut r = Redactor::new();
        let input = &fx["input"];
        let output = if let Some(text) = input["text"].as_str() {
            Json::String(r.text(text))
        } else if let Some([k, v]) = input["env"].as_array().map(Vec::as_slice) {
            Json::String(r.env_value(k.as_str().unwrap_or_default(), v.as_str().unwrap_or_default()))
        } else {
            let gvr: Gvr = serde_json::from_value(input["gvr"].clone()).unwrap_or_else(|e| panic!("{name}: gvr: {e}"));
            let mut obj = input["object"].clone();
            r.object(&gvr, &mut obj);
            obj
        };
        (output, r)
    }

    fn strings(v: &Json) -> Vec<String> {
        v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default()
    }

    #[test]
    fn required_fixtures_exist() {
        let names: Vec<String> = fixtures().into_iter().map(|(n, _)| n).collect();
        for required in [
            "secret", "helm-release-secret", "helmrelease-values", "rancher-token", "external-secret", "secret-store",
            "sealed-secret", "configmap-files", "container-args", "describe-text", "envfrom-secretref", "logs-tokens",
            "url-userinfo", "kubeconfig", "author-kept", "json-log", "env-value",
        ] {
            assert!(names.iter().any(|n| n == required), "missing fixture {required}");
        }
    }

    #[test]
    fn fixtures_match() {
        for (name, fx) in fixtures() {
            let (out, r) = run(&name, &fx);
            if let Some(expected) = fx.get("expected") {
                assert_eq!(&out, expected, "{name}: output");
            }
            let flat = match &out {
                Json::String(s) => s.clone(),
                other => other.to_string(),
            };
            for needle in strings(&fx["mustContain"]) {
                assert!(flat.contains(&needle), "{name}: lost {needle:?} in {flat}");
            }
            if let Some(rules) = fx.get("rules").and_then(Json::as_object) {
                for (rule, n) in rules {
                    assert_eq!(r.by_rule.get(rule.as_str()).copied().unwrap_or(0), n.as_u64().unwrap_or(0) as u32, "{name}: rule {rule} ({:?})", r.by_rule);
                }
                assert_eq!(r.count, r.by_rule.values().sum::<u32>(), "{name}: count");
            }
            if let Some(count) = fx.get("count").and_then(Json::as_u64) {
                assert_eq!(r.count as u64, count, "{name}: count ({:?})", r.by_rule);
            }
        }
    }

    /// Property: no output ever contains a `mustNotContain` value, also after a second pass over
    /// the serialized output; and a second pass over redacted text finds nothing more.
    #[test]
    fn nothing_leaks() {
        for (name, fx) in fixtures() {
            let forbidden = strings(&fx["mustNotContain"]);
            let (out, _) = run(&name, &fx);
            let flat = match &out {
                Json::String(s) => s.clone(),
                other => serde_json::to_string_pretty(other).unwrap_or_default(),
            };
            let mut again = Redactor::new();
            let second = again.text(&flat);
            for needle in &forbidden {
                assert!(!flat.contains(needle.as_str()), "{name}: leaks {needle:?}:\n{flat}");
                assert!(!second.contains(needle.as_str()), "{name}: leaks {needle:?} after a second pass");
            }
            if out.is_string() {
                assert_eq!(again.count, 0, "{name}: second pass masked more ({:?}):\n{flat}", again.by_rule);
            }
        }
    }

    #[test]
    fn key_rule() {
        for yes in [
            "password", "DB_PASSWORD", "dbPassword", "passwd", "PASS", "secret", "CLIENT_SECRET", "token", "apiKey", "API_KEY",
            "apikey", "private_key", "privateKey", "credentials", "SENTRY_DSN", "auth", "AUTH_TOKEN", "authToken", "cookie",
            "SESSION_KEY", "session_secret", "tls.key", "sshKey", "spring.datasource.password", "--db-password", "example.com/token",
        ] {
            assert!(is_secret_key(yes), "{yes} should be secret");
        }
        for no in [
            "author", "authority", "AUTHOR_NAME", "authorization", "bypass", "username", "name", "key", "publicKey", "PUBLIC_KEY",
            "AWS_ACCESS_KEY_ID", "secretName", "PASSWORD_FILE", "TOKEN_URL", "tokenPath", "image", "host", "port", "LOG_LEVEL",
            "passport",
        ] {
            assert!(!is_secret_key(no), "{no} should not be secret");
        }
    }

    #[test]
    fn env_value_and_url() {
        let mut r = Redactor::new();
        assert_eq!(r.env_value("API_PASSWORD", "x"), MASK);
        assert_eq!(r.env_value("DATABASE_URL", "postgres://app:pw@db:5432/app"), "postgres://app:•••@db:5432/app");
        assert_eq!(r.env_value("LOG_LEVEL", "info"), "info");
        assert_eq!(r.url("https://h/x?a=1&access_token=abc#f"), "https://h/x?a=1&access_token=•••#f");
        assert_eq!(r.url("redis://:pw@redis:6379"), "redis://:•••@redis:6379");
        let report = r.report();
        assert_eq!(report.count, 4);
        assert_eq!(report.by_rule.get("key"), Some(&1));
        assert_eq!(report.by_rule.get("url"), Some(&3));
    }

    #[test]
    fn report_counts() {
        let mut r = Redactor::new();
        r.text("password: a\ntoken=b\n--api-key=c\nAuthorization: Bearer abc.def-123");
        let report = r.report();
        assert_eq!(report.count, 4);
        assert_eq!(report.by_rule.get("line"), Some(&2));
        assert_eq!(report.by_rule.get("flag"), Some(&1));
        assert_eq!(report.by_rule.get("bearer"), Some(&1));
    }

    #[test]
    fn mid_line_pairs() {
        let mut r = Redactor::new();
        assert_eq!(r.text("connecting user=app password=hunter2 host=db"), "connecting user=app password=••• host=db");
        assert_eq!(r.text(r#"level=info msg="login" api_key="abc 123" ok"#), r#"level=info msg="login" api_key=••• ok"#);
        assert_eq!(r.text("x (token=abc) y"), "x (token=•••) y");
        // not secret, already masked, empty
        assert_eq!(r.text("a passwordless=true secretName=db"), "a passwordless=true secretName=db");
        assert_eq!(r.text(r#"x password=••• y token="""#), r#"x password=••• y token="""#);
        // the start of a line stays LINE's, counted once
        let mut r = Redactor::new();
        assert_eq!(r.text("password=a b"), "password=•••");
        assert_eq!(r.report().count, 1);
    }

    #[test]
    fn untrusted_strips_hidden_characters() {
        // Unicode tag characters spelling "ignore" after visible text
        let tags: String = "ignore".chars().map(|c| char::from_u32(0xE0000 + c as u32).unwrap_or(' ')).collect();
        assert_eq!(clean_untrusted(&format!("ok{tags}"), MAX_LINE), "ok");
        // bidi override that would show "exe.txt" as "txt.exe"
        assert_eq!(clean_untrusted("file\u{202E}txt.exe\u{202C}", MAX_LINE), "filetxt.exe");
        assert_eq!(clean_untrusted("a\u{2066}b\u{2069}c\u{200E}d\u{200F}", MAX_LINE), "abcd");
        // zero-width
        assert_eq!(clean_untrusted("pa\u{200B}ss\u{200C}w\u{200D}o\u{2060}rd\u{FEFF}", MAX_LINE), "password");
        // ANSI colours, OSC title/hyperlink, control characters; \n and \t kept
        assert_eq!(clean_untrusted("\u{1b}[31mERROR\u{1b}[0m\tx\n\u{1b}]0;title\u{7}y\u{1b}]8;;http://e\u{1b}\\z\u{7}\r", MAX_LINE), "ERROR\tx\nyz");
        assert_eq!(clean_untrusted("a\u{0}b\u{85}c\u{7f}d", MAX_LINE), "abcd");
    }

    #[test]
    fn untrusted_caps_lines_on_char_boundaries() {
        assert_eq!(clean_untrusted("abcdef\nxy", 4), "abcd\nxy");
        // "é" is 2 bytes: 3 of them do not fit in 5 bytes
        assert_eq!(clean_untrusted("ééé", 5), "éé");
        let long = "x".repeat(MAX_LINE + 10);
        assert_eq!(clean_untrusted(&long, MAX_LINE).len(), MAX_LINE);
    }
}
