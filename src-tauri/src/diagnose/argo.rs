//! `:why` on Argo CD objects: Applications and ApplicationSets (`argoproj.io`).
//!
//! An Application lists every resource it manages in `status.resources` with its sync and health
//! status, so the rules need no read of the managed objects themselves (they may live in another
//! cluster). Evidence is therefore always a field of the Application. Pure over JSON and tested in
//! `argo_tests.rs`; every text is redacted and cleaned by `finish`.
use super::{Out, arr, field, finding, s, warning_events};
use crate::ipc::{EventRow, Json, ObjRef, Severity};

/// Managed resources named per finding.
const MAX_RESOURCES: usize = 5;
/// Failed sync results quoted.
const MAX_SYNC_RESULTS: usize = 3;

/// What the Argo CD rules read.
#[derive(Debug, Clone, Default)]
pub struct ArgoInput {
    pub obj: Json,
    pub events: Vec<EventRow>,
}

/// `Deployment shop/web` for one entry of `status.resources` or of a sync result.
pub fn resource_label(r: &Json) -> String {
    let ns = s(&r["namespace"]);
    let name = if ns.is_empty() { s(&r["name"]).to_string() } else { format!("{ns}/{}", s(&r["name"])) };
    format!("{} {name}", s(&r["kind"])).trim().to_string()
}

fn short(rev: &str) -> String {
    if rev.len() > 12 && rev.chars().all(|c| c.is_ascii_hexdigit()) { rev[..7].to_string() } else { rev.to_string() }
}

pub fn application_rules(r: &ObjRef, input: &ArgoInput, out: &mut Out) {
    let o = &input.obj;
    let st = &o["status"];
    let resources = arr(&st["resources"]);

    out.check("conditions");
    for (i, c) in arr(&st["conditions"]).iter().enumerate() {
        let kind = s(&c["type"]);
        let severity = if kind.ends_with("Error") {
            Severity::Error
        } else if kind.ends_with("Warning") {
            Severity::Warn
        } else {
            continue;
        };
        out.push(finding(severity, kind.to_string(), Some(s(&c["message"]).to_string()), vec![field(r, format!("/status/conditions/{i}/message"), s(&c["message"]))]));
    }

    out.check("last sync");
    let op = &st["operationState"];
    match s(&op["phase"]) {
        "Failed" | "Error" => {
            let mut ev = vec![field(r, "/status/operationState/message", s(&op["message"]))];
            let failed = arr(&op["syncResult"]["resources"]).iter().enumerate().filter(|(_, x)| matches!(s(&x["status"]), "SyncFailed" | "Failed"));
            for (i, x) in failed.take(MAX_SYNC_RESULTS) {
                ev.push(field(r, format!("/status/operationState/syncResult/resources/{i}/message"), format!("{}: {}", resource_label(x), s(&x["message"]))));
            }
            let rev = s(&op["syncResult"]["revision"]);
            let title = if rev.is_empty() { "last sync failed".to_string() } else { format!("last sync of {} failed", short(rev)) };
            out.push(finding(Severity::Error, title, Some(s(&op["message"]).to_string()), ev));
        }
        "Running" | "Terminating" => out.push(finding(
            Severity::Info,
            "a sync is running",
            Some(s(&op["message"]).to_string()),
            vec![field(r, "/status/operationState/phase", s(&op["phase"]))],
        )),
        _ => {}
    }

    out.check("health");
    let health = s(&st["health"]["status"]);
    let unhealthy: Vec<(usize, &Json)> = resources.iter().enumerate().filter(|(_, x)| matches!(s(&x["health"]["status"]), "Degraded" | "Missing")).collect();
    for (i, x) in unhealthy.iter().take(MAX_RESOURCES) {
        let h = s(&x["health"]["status"]);
        out.push(finding(
            if h == "Degraded" { Severity::Error } else { Severity::Warn },
            format!("{} is {h}", resource_label(x)),
            Some(s(&x["health"]["message"]).to_string()),
            vec![field(r, format!("/status/resources/{i}/health"), [h, s(&x["health"]["message"])].into_iter().filter(|t| !t.is_empty()).collect::<Vec<_>>().join(": "))],
        ));
    }
    match health {
        "Degraded" | "Missing" if unhealthy.is_empty() => out.push(finding(
            Severity::Error,
            format!("health {health}"),
            Some(s(&st["health"]["message"]).to_string()),
            vec![field(r, "/status/health/status", health)],
        )),
        "Suspended" => out.push(finding(Severity::Warn, "health Suspended", Some("a resource of the app is paused or suspended".into()), vec![field(r, "/status/health/status", health)])),
        "Progressing" => out.push(finding(Severity::Info, "progressing", Some("a rollout is under way".into()), vec![field(r, "/status/health/status", health)])),
        _ => {}
    }

    out.check("sync status");
    let sync = &st["sync"];
    if s(&sync["status"]) == "OutOfSync" {
        let drifted: Vec<(usize, &Json)> = resources.iter().enumerate().filter(|(_, x)| s(&x["status"]) == "OutOfSync").collect();
        let mut ev = vec![field(r, "/status/sync/status", "OutOfSync")];
        for (i, x) in drifted.iter().take(MAX_RESOURCES) {
            ev.push(field(r, format!("/status/resources/{i}/status"), format!("{} OutOfSync", resource_label(x))));
        }
        let automated = o["spec"]["syncPolicy"]["automated"].is_object();
        let rev = s(&sync["revision"]);
        let at = if rev.is_empty() { String::new() } else { format!(" (Git at {})", short(rev)) };
        let title = match drifted.len() {
            0 => format!("out of sync{at}"),
            1 => format!("{} is out of sync{at}", resource_label(drifted[0].1)),
            n => format!("{n} resources are out of sync{at}"),
        };
        let detail = if automated {
            "auto-sync is on: Argo CD applies Git on its next sync; a change made in the cluster is reverted when self-heal is on"
        } else {
            "auto-sync is off: nothing changes until the app is synced (Y)"
        };
        out.push(finding(if automated { Severity::Info } else { Severity::Warn }, title, Some(detail.into()), ev));
    }

    out.check("events");
    warning_events(&input.events, out, &[]);
}

pub fn applicationset_rules(r: &ObjRef, input: &ArgoInput, out: &mut Out) {
    out.check("conditions");
    for (i, c) in arr(&input.obj["status"]["conditions"]).iter().enumerate() {
        let (kind, status) = (s(&c["type"]), s(&c["status"]));
        let bad = match (kind, status) {
            ("ErrorOccurred", "True") => Some(Severity::Error),
            ("ParametersGenerated", "False") => Some(Severity::Error),
            ("ResourcesUpToDate", "False") => Some(Severity::Warn),
            _ => None,
        };
        if let Some(severity) = bad {
            let what = if s(&c["reason"]).is_empty() { format!("{kind}={status}") } else { format!("{kind}={status} ({})", s(&c["reason"])) };
            out.push(finding(severity, what, Some(s(&c["message"]).to_string()), vec![field(r, format!("/status/conditions/{i}/message"), s(&c["message"]))]));
        }
    }
    out.check("events");
    warning_events(&input.events, out, &[]);
}

#[cfg(test)]
#[path = "argo_tests.rs"]
mod tests;
