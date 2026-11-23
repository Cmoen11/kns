//! Audit trail (docs/plan-features.md §5.6): `<app_data_dir>/mcp-audit.jsonl`, one JSON line per
//! request, plus token add/revoke and policy changes. Written only by Rust, outside the webview's
//! store directory, append-only, rotated at 5 MB × 3 (`.1` newest … `.3` oldest).
use std::{
    io::{BufRead, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use crate::{
    ipc::{AuditOutcome, AuditRow, Json},
    redact::Redactor,
    state::lock,
};

pub const FILE: &str = "mcp-audit.jsonl";
pub const ROTATE_BYTES: u64 = 5 * 1024 * 1024;
pub const KEEP: usize = 3;
/// Cap on the serialized, redacted arguments of one row.
pub const ARGS_CAP: usize = 1024;

/// Serialises writers (one per process; the file has one owner).
#[derive(Default)]
pub struct AuditLock(Mutex<()>);

/// Redacted arguments, cut at 1 KiB (an over-long value becomes `{"truncated": "<prefix>"}`).
pub fn args_for_audit(args: &Json) -> (Json, u32) {
    let mut r = Redactor::new();
    let mut v = args.clone();
    redact_leaves(&mut r, &mut v);
    let text = v.to_string();
    let v = if text.len() > ARGS_CAP {
        let mut cut = ARGS_CAP;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        serde_json::json!({ "truncated": &text[..cut] })
    } else {
        v
    };
    (v, r.report().count)
}

/// Key rule and text patterns on every string leaf of an argument object.
fn redact_leaves(r: &mut Redactor, v: &mut Json) {
    match v {
        Json::Object(map) => {
            for (k, child) in map.iter_mut() {
                match child {
                    Json::String(s) => *s = r.env_value(k, &crate::redact::clean_untrusted(s, crate::redact::MAX_LINE)),
                    _ => redact_leaves(r, child),
                }
            }
        }
        Json::Array(items) => items.iter_mut().for_each(|i| redact_leaves(r, i)),
        Json::String(s) => *s = r.text(&crate::redact::clean_untrusted(s, crate::redact::MAX_LINE)),
        _ => {}
    }
}

fn path(dir: &Path, n: usize) -> PathBuf {
    if n == 0 { dir.join(FILE) } else { dir.join(format!("{FILE}.{n}")) }
}

/// Appends one row, rotating first when the file is over the limit.
pub fn append(lock_: &AuditLock, dir: &Path, row: &AuditRow) -> std::io::Result<()> {
    append_line(lock_, dir, &serde_json::to_string(row)?)
}

/// Appends an event that is not a request (token add/revoke, policy change), shaped as a row so
/// the Agents view lists it with the rest.
pub fn append_event(lock_: &AuditLock, dir: &Path, ts: &str, client: &str, what: &str, args: Option<Json>) -> std::io::Result<()> {
    let row = AuditRow {
        ts: ts.into(),
        client: client.into(),
        tool: what.into(),
        args,
        result_bytes: 0,
        redactions: 0,
        outcome: AuditOutcome::Ok,
        proposal_id: None,
        ms: 0,
    };
    append(lock_, dir, &row)
}

fn append_line(lock_: &AuditLock, dir: &Path, line: &str) -> std::io::Result<()> {
    let _g = lock(&lock_.0);
    std::fs::create_dir_all(dir)?;
    let current = path(dir, 0);
    if std::fs::metadata(&current).is_ok_and(|m| m.len() >= ROTATE_BYTES) {
        let _ = std::fs::remove_file(path(dir, KEEP));
        for n in (0..KEEP).rev() {
            let from = path(dir, n);
            if from.exists() {
                std::fs::rename(&from, path(dir, n + 1))?;
            }
        }
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&current)?;
    f.write_all(line.as_bytes())?;
    f.write_all(b"\n")
}

/// The newest `limit` rows (newest first), from the current file and, if needed, the rotated ones.
/// Unparsable lines are skipped.
pub fn tail(lock_: &AuditLock, dir: &Path, limit: usize) -> Vec<AuditRow> {
    let _g = lock(&lock_.0);
    let mut out = Vec::new();
    for n in 0..=KEEP {
        let Ok(f) = std::fs::File::open(path(dir, n)) else { continue };
        let mut rows: Vec<AuditRow> = std::io::BufReader::new(f)
            .lines()
            .map_while(std::result::Result::ok)
            .filter_map(|l| serde_json::from_str(&l).ok())
            .collect();
        rows.reverse();
        out.extend(rows);
        if out.len() >= limit {
            break;
        }
    }
    out.truncate(limit);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(i: usize) -> AuditRow {
        AuditRow {
            ts: format!("2026-11-22T10:00:{i:02}Z"),
            client: "claude-code".into(),
            tool: "get_status".into(),
            args: None,
            result_bytes: i as u64,
            redactions: 0,
            outcome: AuditOutcome::Ok,
            proposal_id: None,
            ms: 1,
        }
    }

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kns-audit-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn append_and_tail_newest_first() {
        let dir = temp("tail");
        let l = AuditLock::default();
        assert!(tail(&l, &dir, 10).is_empty());
        for i in 0..5 {
            append(&l, &dir, &row(i)).unwrap();
        }
        let t = tail(&l, &dir, 3);
        assert_eq!(t.iter().map(|r| r.result_bytes).collect::<Vec<_>>(), vec![4, 3, 2]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotates_and_keeps_three() {
        let dir = temp("rotate");
        let l = AuditLock::default();
        std::fs::create_dir_all(&dir).unwrap();
        for n in 0..6 {
            // a full file, then one row: each round rotates once
            std::fs::write(path(&dir, 0), vec![b'\n'; ROTATE_BYTES as usize]).unwrap();
            append(&l, &dir, &row(n)).unwrap();
        }
        assert!(path(&dir, 1).exists() && path(&dir, 2).exists() && path(&dir, 3).exists());
        assert!(!path(&dir, 4).exists());
        assert_eq!(tail(&l, &dir, 1)[0].result_bytes, 5);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn args_are_redacted_and_capped() {
        let (v, n) = args_for_audit(&json!({ "grep": "password=hunter2", "token": "abc123", "tail": 10 }));
        let s = v.to_string();
        assert!(!s.contains("hunter2") && !s.contains("abc123"), "{s}");
        assert!(n >= 2);
        let (v, _) = args_for_audit(&json!({ "grep": "x".repeat(5000) }));
        assert!(v["truncated"].as_str().unwrap().len() <= ARGS_CAP);
    }
}
