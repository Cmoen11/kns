//! Log streams: mirror of `src/ipc/contract/logs.ts`. Owner E (`sinceTime`/`parse` on the query,
//! `level`/`msg`/`fields` on a line; parsed by `crate::logparse`).
use std::sync::Arc;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogTarget {
    pub namespace: String,
    pub pod: String,
    pub container: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    pub context: String,
    pub targets: Vec<LogTarget>,
    pub follow: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail_lines: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since_seconds: Option<i64>,
    /// RFC3339; wins over `since_seconds` (the API takes only one of them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<bool>,
    /// Detect JSON / logfmt / a leading level word per line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parse: Option<bool>,
}

/// Normalised level, ordered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub ts: String,
    /// Shared by every line of a target.
    pub pod: Arc<str>,
    pub container: Arc<str>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<LogLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msg: Option<String>,
    /// At most 32 pairs, values at most 1 KiB.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<(String, String)>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LogEvent {
    Lines { lines: Vec<LogLine> },
    End { pod: String, container: String },
    Error { pod: String, container: String, message: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::drift::Fixtures;

    #[test]
    fn drift() {
        let line = LogLine {
            ts: "2026-11-22T10:00:00.000000001Z".into(),
            pod: "web-1".into(),
            container: "main".into(),
            text: "GET / 200".into(),
            level: None,
            msg: None,
            fields: None,
        };
        let parsed = LogLine {
            ts: "2026-11-22T10:00:01Z".into(),
            pod: "web-1".into(),
            container: "main".into(),
            text: r#"{"level":"warn","msg":"slow","ms":812}"#.into(),
            level: Some(LogLevel::Warn),
            msg: Some("slow".into()),
            fields: Some(vec![("ms".into(), "812".into())]),
        };
        let mut f = Fixtures::new("logs");
        f.add(
            "logQuery",
            "LogQuery",
            &LogQuery {
                context: "default".into(),
                targets: vec![LogTarget { namespace: "default".into(), pod: "web-1".into(), container: "main".into() }],
                follow: true,
                tail_lines: Some(200),
                since_seconds: None,
                since_time: Some("2026-11-22T09:00:00Z".into()),
                previous: Some(false),
                parse: Some(true),
            },
        );
        f.add(
            "logLevels",
            "LogLevel[]",
            &vec![LogLevel::Trace, LogLevel::Debug, LogLevel::Info, LogLevel::Warn, LogLevel::Error, LogLevel::Fatal],
        );
        f.add(
            "logEvents",
            "LogEvent[]",
            &vec![
                LogEvent::Lines { lines: vec![line, parsed] },
                LogEvent::End { pod: "web-1".into(), container: "main".into() },
                LogEvent::Error { pod: "web-1".into(), container: "main".into(), message: "gone".into() },
            ],
        );
        f.check();
    }
}
