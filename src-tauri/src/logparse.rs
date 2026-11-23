//! Pure: level, message and fields of one log line (docs/plan-features.md §3 E). No commands.
//!
//! Detected forms, in this order:
//! - a JSON object (`{"level":"info","msg":"..",..}`; pino/bunyan numeric levels too)
//! - logfmt (`level=info msg="a b" k=v`), also as trailing pairs after free text
//!   (`INFO  request completed path=/x status=200`)
//! - a leading level word (`WARN`, `[error]`, `E0102 15:04:05` klog), also inside ANSI colours
//!
//! Plain lines give `None`. Fields keep line order (JSON keys too), at most [`MAX_FIELDS`] pairs,
//! values cut at [`MAX_VALUE`] bytes on a char boundary.
use std::fmt;

use serde::de::{Deserializer, MapAccess, Visitor};
use serde_json::Value;

use crate::contract::logs::LogLevel;

pub const MAX_FIELDS: usize = 32;
pub const MAX_VALUE: usize = 1024;
const MAX_KEY: usize = 128;
/// a level word is looked for in this many leading tokens of the free text
const LEVEL_TOKENS: usize = 3;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Parsed {
    pub level: Option<LogLevel>,
    pub msg: Option<String>,
    pub fields: Vec<(String, String)>,
}

const LEVEL_KEYS: &[&str] = &["level", "lvl", "severity", "loglevel", "log.level", "levelname", "level_name", "@l", "@level"];
const MSG_KEYS: &[&str] = &["msg", "message", "@m", "@message", "event"];

fn is_key(k: &str, set: &[&str]) -> bool {
    set.iter().any(|s| s.eq_ignore_ascii_case(k))
}

/// `info`, `WARNING`, `E` ... -> a level. `strict`: only the forms that are unambiguous in free text.
fn level_word(w: &str, strict: bool) -> Option<LogLevel> {
    let upper = w.to_ascii_uppercase();
    // in free text a lowercase "error" is prose; upper case or a bracket marks it as a level
    if strict && upper != w {
        return None;
    }
    Some(match upper.as_str() {
        "TRACE" | "TRC" => LogLevel::Trace,
        "DEBUG" | "DBG" | "DEBU" => LogLevel::Debug,
        "INFO" | "INF" | "INFORMATION" | "NOTICE" => LogLevel::Info,
        "WARN" | "WARNING" | "WRN" => LogLevel::Warn,
        "ERROR" | "ERR" | "ERRO" => LogLevel::Error,
        "FATAL" | "FTL" | "CRIT" | "CRITICAL" | "PANIC" | "EMERG" | "ALERT" => LogLevel::Fatal,
        _ => return None,
    })
}

/// pino / bunyan: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal
fn level_number(n: f64) -> LogLevel {
    match n {
        n if n <= 10.0 => LogLevel::Trace,
        n if n <= 20.0 => LogLevel::Debug,
        n if n <= 30.0 => LogLevel::Info,
        n if n <= 40.0 => LogLevel::Warn,
        n if n <= 50.0 => LogLevel::Error,
        _ => LogLevel::Fatal,
    }
}

fn cap(mut s: String, max: usize) -> String {
    if s.len() > max {
        s.truncate(s.floor_char_boundary(max));
    }
    s
}

/// Removes ANSI escape sequences (CSI and OSC); everything else is kept.
pub fn strip_ansi(s: &str) -> std::borrow::Cow<'_, str> {
    if !s.contains('\u{1b}') {
        return s.into();
    }
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match it.peek() {
            Some('[') => {
                it.next();
                // parameters and intermediates, then one final byte in @..~
                for c in it.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                it.next();
                // up to BEL or ST (ESC \)
                while let Some(c) = it.next() {
                    if c == '\u{7}' || (c == '\u{1b}' && it.next_if_eq(&'\\').is_some()) {
                        break;
                    }
                }
            }
            Some(_) => {
                it.next();
            }
            None => {}
        }
    }
    out.into()
}

/// Level, message and fields of a line, or `None` for a plain line.
pub fn parse(text: &str) -> Option<Parsed> {
    let clean = strip_ansi(text);
    let line = clean.trim();
    if line.is_empty() {
        return None;
    }
    if line.starts_with('{')
        && line.ends_with('}')
        && let Some(p) = parse_json(line)
    {
        return Some(p);
    }
    parse_text(line)
}

// ── JSON ─────────────────────────────────────────────────────────────────────

/// A JSON object with its keys in document order (serde_json's `Map` sorts them).
struct Ordered(Vec<(String, Value)>);

impl<'de> serde::Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Ordered;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Ordered, A::Error> {
                let mut out = Vec::new();
                while let Some((k, v)) = map.next_entry::<String, Value>()? {
                    out.push((k, v));
                }
                Ok(Ordered(out))
            }
        }
        d.deserialize_map(V)
    }
}

fn value_text(v: Value) -> String {
    match v {
        Value::String(s) => s,
        other => other.to_string(),
    }
}

fn parse_json(line: &str) -> Option<Parsed> {
    let Ordered(pairs) = serde_json::from_str(line).ok()?;
    let mut p = Parsed::default();
    for (k, v) in pairs {
        if p.level.is_none() && is_key(&k, LEVEL_KEYS) {
            let level = match &v {
                Value::String(s) => level_word(s, false),
                Value::Number(n) => n.as_f64().map(level_number),
                _ => None,
            };
            if level.is_some() {
                p.level = level;
                continue;
            }
        }
        if p.msg.is_none()
            && is_key(&k, MSG_KEYS)
            && let Value::String(s) = v
        {
            p.msg = Some(cap(s, MAX_VALUE));
            continue;
        }
        if p.fields.len() < MAX_FIELDS {
            p.fields.push((cap(k, MAX_KEY), cap(value_text(v), MAX_VALUE)));
        }
    }
    Some(p)
}

// ── logfmt and free text ─────────────────────────────────────────────────────

struct Token<'a> {
    start: usize,
    /// `key=value` with the value unquoted
    pair: Option<(&'a str, String)>,
    word: &'a str,
}

fn valid_key(k: &str) -> bool {
    let mut chars = k.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '@')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '/' | '@'))
}

/// Splits on whitespace; a `key="quoted value"` stays one token.
fn tokens(line: &str) -> Vec<Token<'_>> {
    let b = line.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        let start = i;
        let mut eq = None;
        while i < b.len() && !b[i].is_ascii_whitespace() {
            if b[i] == b'=' && eq.is_none() {
                eq = Some(i);
                if b.get(i + 1) == Some(&b'"') {
                    // quoted value: up to the closing quote, backslash escapes
                    let mut j = i + 2;
                    while j < b.len() && b[j] != b'"' {
                        j += if b[j] == b'\\' { 2 } else { 1 };
                    }
                    i = (j + 1).min(b.len());
                    continue;
                }
            }
            i += 1;
        }
        let word = &line[start..i];
        let pair = eq.and_then(|e| {
            let key = &line[start..e];
            if !valid_key(key) {
                return None;
            }
            let raw = &line[e + 1..i];
            let value = match raw.strip_prefix('"') {
                Some(q) => unquote(q.strip_suffix('"').unwrap_or(q)),
                None => raw.to_string(),
            };
            Some((key, value))
        });
        out.push(Token { start, pair, word });
    }
    out
}

fn unquote(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            match it.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(o) => out.push(o),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// klog header: `E0102 15:04:05.000000 ...`
fn klog(line: &str) -> Option<LogLevel> {
    let b = line.as_bytes();
    let ok = b.len() >= 14
        && b[1..5].iter().all(u8::is_ascii_digit)
        && b[5] == b' '
        && b[6..8].iter().all(u8::is_ascii_digit)
        && b[8] == b':';
    if !ok {
        return None;
    }
    match b[0] {
        b'I' => Some(LogLevel::Info),
        b'W' => Some(LogLevel::Warn),
        b'E' => Some(LogLevel::Error),
        b'F' => Some(LogLevel::Fatal),
        _ => None,
    }
}

fn parse_text(line: &str) -> Option<Parsed> {
    if let Some(level) = klog(line) {
        return Some(Parsed { level: Some(level), ..Default::default() });
    }
    let toks = tokens(line);
    // the longest run of pairs at the end of the line
    let split = toks.iter().rposition(|t| t.pair.is_none()).map_or(0, |i| i + 1);
    let mut p = Parsed::default();
    let pure = split == 0;
    for t in toks.into_iter().skip(split) {
        let Some((k, v)) = t.pair else { continue };
        if p.level.is_none()
            && is_key(k, LEVEL_KEYS)
            && let Some(level) = level_word(&v, false)
        {
            p.level = Some(level);
            continue;
        }
        if p.msg.is_none() && is_key(k, MSG_KEYS) {
            p.msg = Some(cap(v, MAX_VALUE));
            continue;
        }
        if p.fields.len() < MAX_FIELDS {
            p.fields.push((cap(k.to_string(), MAX_KEY), cap(v, MAX_VALUE)));
        }
    }
    // a single pair alone is not logfmt ("retries=3"), unless it is a level or message
    if pure && p.level.is_none() && p.msg.is_none() && p.fields.len() < 2 {
        return None;
    }
    if !pure {
        let head_end = tokens_start(line, split);
        let head = line[..head_end].trim_end();
        let words: Vec<(usize, &str)> = tokens(head).into_iter().take(LEVEL_TOKENS).map(|t| (t.start, t.word)).collect();
        let mut msg_from = 0;
        for (start, w) in words {
            let bracketed = w.starts_with(['[', '<']);
            let bare = w.trim_matches(|c: char| matches!(c, '[' | ']' | '<' | '>' | ':' | '|'));
            if let Some(level) = level_word(bare, !bracketed) {
                if p.level.is_none() {
                    p.level = Some(level);
                }
                msg_from = start + w.len();
                break;
            }
        }
        if p.level.is_none() && p.fields.is_empty() && p.msg.is_none() {
            return None;
        }
        if p.msg.is_none() {
            let rest = head[msg_from..].trim();
            if !rest.is_empty() {
                p.msg = Some(cap(rest.to_string(), MAX_VALUE));
            }
        }
    }
    Some(p)
}

/// Byte offset where token `index` starts (the line's length when there is none).
fn tokens_start(line: &str, index: usize) -> usize {
    tokens(line).get(index).map_or(line.len(), |t| t.start)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn json_keeps_key_order_and_takes_level_and_msg() {
        let p = parse(r#"{"ts":"2026","level":"warning","msg":"consumer lag","topic":"energy","lag":3,"ctx":{"a":1}}"#).unwrap();
        assert_eq!(p.level, Some(LogLevel::Warn));
        assert_eq!(p.msg.as_deref(), Some("consumer lag"));
        assert_eq!(p.fields, f(&[("ts", "2026"), ("topic", "energy"), ("lag", "3"), ("ctx", r#"{"a":1}"#)]));
    }

    #[test]
    fn json_numeric_levels_and_other_keys() {
        assert_eq!(parse(r#"{"level":50,"message":"boom"}"#).unwrap().level, Some(LogLevel::Error));
        assert_eq!(parse(r#"{"level":30}"#).unwrap().level, Some(LogLevel::Info));
        let p = parse(r#"{"@l":"Debug","@m":"hi"}"#).unwrap();
        assert_eq!((p.level, p.msg.as_deref()), (Some(LogLevel::Debug), Some("hi")));
        // an unknown level word stays a field
        let p = parse(r#"{"level":"verbose","msg":"x"}"#).unwrap();
        assert_eq!((p.level, p.fields), (None, f(&[("level", "verbose")])));
        // not an object
        assert_eq!(parse("{not json}"), None);
    }

    #[test]
    fn logfmt_pure() {
        let p = parse(r#"time=2026-11-22T10:00:00Z level=error msg="failed to connect \"kafka\"" err="dial tcp: refused" retry=3"#).unwrap();
        assert_eq!(p.level, Some(LogLevel::Error));
        assert_eq!(p.msg.as_deref(), Some(r#"failed to connect "kafka""#));
        assert_eq!(p.fields, f(&[("time", "2026-11-22T10:00:00Z"), ("err", "dial tcp: refused"), ("retry", "3")]));
        // one pair is not logfmt
        assert_eq!(parse("retries=3"), None);
        assert!(parse("level=info").is_some());
    }

    #[test]
    fn level_word_then_pairs_inside_ansi() {
        let p = parse("\u{1b}[32mINFO\u{1b}[0m  request completed path=/api/items status=200 dur=12ms").unwrap();
        assert_eq!(p.level, Some(LogLevel::Info));
        assert_eq!(p.msg.as_deref(), Some("request completed"));
        assert_eq!(p.fields, f(&[("path", "/api/items"), ("status", "200"), ("dur", "12ms")]));
        let p = parse("\u{1b}[31mERROR\u{1b}[0m failed to connect to kafka:9092: connection refused").unwrap();
        assert_eq!((p.level, p.msg.as_deref()), (Some(LogLevel::Error), Some("failed to connect to kafka:9092: connection refused")));
        assert!(p.fields.is_empty());
    }

    #[test]
    fn level_words_in_free_text() {
        assert_eq!(parse("2026-11-22 10:00:00.123 [warn] disk almost full").unwrap().level, Some(LogLevel::Warn));
        assert_eq!(parse("DEBUG cache hit key=user:42").unwrap().fields, f(&[("key", "user:42")]));
        assert_eq!(parse("E0102 15:04:05.000000       1 reflector.go:1] boom").unwrap().level, Some(LogLevel::Error));
        // prose: lowercase "error" deep in a sentence is not a level, and nothing else is found
        assert_eq!(parse("there was no error today"), None);
        assert_eq!(parse("error: lowercase first word"), None);
        assert_eq!(parse("GET /healthz 200 1ms"), None);
        assert_eq!(parse("GET /x?a=1&b=2 200"), None);
        assert_eq!(parse(""), None);
    }

    #[test]
    fn caps_fields_and_values() {
        let many: Vec<String> = (0..50).map(|i| format!("k{i}={i}")).collect();
        assert_eq!(parse(&many.join(" ")).unwrap().fields.len(), MAX_FIELDS);
        let long = format!(r#"{{"msg":"x","v":"{}"}}"#, "é".repeat(MAX_VALUE));
        let v = &parse(&long).unwrap().fields[0].1;
        assert!(v.len() <= MAX_VALUE && v.chars().all(|c| c == 'é'));
    }

    #[test]
    fn strips_ansi() {
        assert_eq!(strip_ansi("\u{1b}[1;31mred\u{1b}[0m \u{1b}]0;title\u{7}x"), "red x");
        assert_eq!(strip_ansi("plain"), "plain");
    }
}
