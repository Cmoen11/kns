//! Proposal state machine and gate (docs/plan-features.md §2.6).
use super::*;
use crate::contract::agents::fixtures::payloads;
use crate::ipc::{ApplyParsed, Gvr};

const T0: i64 = 1_763_805_600_000;
const MIN: i64 = 60_000;

fn scale() -> ProposalPayload {
    payloads().remove(5)
}

fn scale_in(context: &str) -> ProposalPayload {
    match scale() {
        ProposalPayload::Scale { mut obj_ref, replicas } => {
            obj_ref.context = context.into();
            ProposalPayload::Scale { obj_ref, replicas }
        }
        other => other,
    }
}

fn dev_set_up(export: bool) -> ProposalPayload {
    match payloads().remove(0) {
        ProposalPayload::DevSetUp { dev_set, hash, export_env } => {
            ProposalPayload::DevSetUp { dev_set, hash, export_env: if export { export_env } else { None } }
        }
        other => other,
    }
}

fn ok_check() -> ApproveCheck {
    ApproveCheck { policy: Some(McpPolicy::Propose), current_hash: Some("bb".into()), ..Default::default() }
}

const LIVE: (CtxFlags, Option<McpPolicy>) = (CtxFlags { protected: false, read_only: false }, Some(McpPolicy::Propose));

fn shown() -> ApprovalChoices {
    ApprovalChoices { shown_hash: Some("bb".into()), ..Default::default() }
}

/// pending -> reviewing -> executing
fn approved(s: &mut Store, payload: ProposalPayload, choices: ApprovalChoices) -> Proposal {
    approved_at(s, payload, choices, T0)
}

fn approved_at(s: &mut Store, payload: ProposalPayload, choices: ApprovalChoices, at: i64) -> Proposal {
    let p = s.create("claude-code", "default", payload, Some("why"), at).unwrap();
    s.claim(&p.id, at).unwrap();
    s.approve(&p.id, choices, &ok_check(), at).unwrap()
}

#[test]
fn lifecycle_with_unclaim() {
    let mut s = Store::default();
    let p = s.create("claude-code", "default", scale(), Some("scale \u{202E}web\u{200B} up\u{1b}[31m"), T0).unwrap();
    assert_eq!(p.state, ProposalState::Pending);
    assert_eq!(p.reason.as_deref(), Some("scale web up"));
    assert_eq!(s.pending(), 1);
    assert_eq!(s.claim(&p.id, T0).unwrap().state, ProposalState::Reviewing);
    assert_eq!(s.unclaim(&p.id, T0 + MIN).unwrap().state, ProposalState::Pending);
    s.claim(&p.id, T0 + 2 * MIN).unwrap();
    let p = s.approve(&p.id, ApprovalChoices::default(), &ok_check(), T0 + 3 * MIN).unwrap();
    assert_eq!(p.state, ProposalState::Executing);
    let ticket = s.gate(&p.id, "scale", LIVE.0, LIVE.1, T0 + 4 * MIN).unwrap();
    assert_eq!(ticket.owner(), ForwardOwner::User, "default owner is the human");
    let done = s.finish_step(&ticket, Ok(json!({ "replicas": 2 })), T0 + 4 * MIN).unwrap();
    assert_eq!(done.state, ProposalState::Approved);
    assert_eq!(done.result.and_then(|r| r.data), Some(json!({ "scale": { "replicas": 2 } })));
    assert_eq!(s.pending(), 0);
}

#[test]
fn wrong_state_transitions_conflict() {
    let mut s = Store::default();
    let p = s.create("a", "default", scale(), None, T0).unwrap();
    assert_eq!(s.unclaim(&p.id, T0).unwrap_err().reason, "Conflict");
    assert_eq!(s.approve(&p.id, ApprovalChoices::default(), &ok_check(), T0).unwrap_err().reason, "Conflict");
    assert_eq!(s.gate(&p.id, "scale", LIVE.0, LIVE.1, T0).unwrap_err().reason, "Conflict", "unapproved");
    s.claim(&p.id, T0).unwrap();
    assert_eq!(s.claim(&p.id, T0).unwrap_err().reason, "Conflict");
    assert_eq!(s.get("p999", T0).unwrap_err().code, 404);
}

#[test]
fn expiry_is_lazy_and_capped() {
    let mut s = Store::default();
    let p = s.create("a", "default", scale(), None, T0).unwrap();
    assert_eq!(s.get(&p.id, T0 + 10 * MIN).unwrap().state, ProposalState::Expired);
    let q = s.create("a", "default", scale(), None, T0 + 11 * MIN).unwrap();
    s.claim(&q.id, T0 + 20 * MIN).unwrap();
    assert_eq!(s.get(&q.id, T0 + 40 * MIN).unwrap().state, ProposalState::Reviewing, "reviewing outlives 10 min");
    assert_eq!(s.get(&q.id, T0 + 41 * MIN).unwrap().state, ProposalState::Expired, "but not the 30 min cap");
}

#[test]
fn rate_limits() {
    let mut s = Store::default();
    let p = s.create("a", "default", scale(), None, T0).unwrap();
    assert_eq!(s.create("a", "default", scale(), None, T0).unwrap_err().reason, "RateLimited", "one waiting per client");
    s.create("b", "default", scale(), None, T0).unwrap();
    s.resolve(&p.id, ProposalResolution::Rejected { reason: None }, T0).unwrap();
    for i in 1..6 {
        let p = s.create("a", "default", scale(), None, T0 + i).unwrap();
        s.resolve(&p.id, ProposalResolution::Rejected { reason: None }, T0 + i).unwrap();
    }
    assert_eq!(s.create("a", "default", scale(), None, T0 + 10).unwrap_err().reason, "RateLimited", "6 per minute");
    assert!(s.create("a", "default", scale(), None, T0 + MIN).is_ok());
}

#[test]
fn approve_checks_flags_policy_and_typed() {
    let mut s = Store::default();
    let p = s.create("a", "default", dev_set_up(false), None, T0).unwrap();
    s.claim(&p.id, T0).unwrap();
    let ro = ApproveCheck { flags: CtxFlags { read_only: true, ..Default::default() }, ..ok_check() };
    assert_eq!(s.approve(&p.id, shown(), &ro, T0).unwrap_err().reason, "PolicyDenied");
    let read = ApproveCheck { policy: Some(McpPolicy::Read), ..ok_check() };
    assert_eq!(s.approve(&p.id, shown(), &read, T0).unwrap_err().reason, "PolicyDenied");
    let unknown = ApproveCheck { policy: None, ..ok_check() };
    assert_eq!(s.approve(&p.id, shown(), &unknown, T0).unwrap_err().reason, "PolicyDenied");
    let protected = ApproveCheck { flags: CtxFlags { protected: true, ..Default::default() }, ..ok_check() };
    let err = s.approve(&p.id, shown(), &protected, T0).unwrap_err();
    assert_eq!((err.reason.as_str(), err.message.as_str()), ("NeedsApproval", "type \"default\" to approve"));
    let typed = ApprovalChoices { typed: Some("default".into()), ..shown() };
    assert_eq!(s.approve(&p.id, typed, &protected, T0).unwrap().state, ProposalState::Executing);
}

#[test]
fn wrong_shown_hash_expires_the_proposal() {
    let mut s = Store::default();
    let p = s.create("a", "default", dev_set_up(false), None, T0).unwrap();
    s.claim(&p.id, T0).unwrap();
    let stale = ApprovalChoices { shown_hash: Some("aa".into()), ..Default::default() };
    assert_eq!(s.approve(&p.id, stale, &ok_check(), T0).unwrap_err().reason, "NeedsApproval");
    assert_eq!(s.get(&p.id, T0).unwrap().state, ProposalState::Expired);
    let q = s.create("b", "default", dev_set_up(false), None, T0).unwrap();
    s.claim(&q.id, T0).unwrap();
    let gone = ApproveCheck { current_hash: None, ..ok_check() };
    assert_eq!(s.approve(&q.id, shown(), &gone, T0).unwrap_err().reason, "NeedsApproval", "set deleted");
}

#[test]
fn secrets_need_an_export_and_the_workload_name() {
    let mut s = Store::default();
    let p = s.create("a", "default", scale(), None, T0).unwrap();
    s.claim(&p.id, T0).unwrap();
    let secrets = ApprovalChoices { include_secrets: Some(vec!["DATABASE_URL".into()]), ..Default::default() };
    assert_eq!(s.approve(&p.id, secrets.clone(), &ok_check(), T0).unwrap_err().reason, "Invalid");
    s.resolve(&p.id, ProposalResolution::Rejected { reason: None }, T0).unwrap();

    let export = payloads().remove(2); // envExport of deploy/orders
    let q = s.create("a", "default", export, None, T0 + 1).unwrap();
    s.claim(&q.id, T0 + 1).unwrap();
    let err = s.approve(&q.id, secrets.clone(), &ok_check(), T0 + 1).unwrap_err();
    assert_eq!(err.message, "type \"orders\" to approve");
    let typed = ApprovalChoices { typed: Some("orders".into()), ..secrets };
    s.approve(&q.id, typed, &ok_check(), T0 + 1).unwrap();
    let ticket = s.gate(&q.id, "export", LIVE.0, LIVE.1, T0 + 2).unwrap();
    assert_eq!(ticket.include_secrets(), ["DATABASE_URL".to_string()]);
}

#[test]
fn tier2_kinds_need_the_context_name() {
    let mut s = Store::default();
    let payload = ProposalPayload::Apply {
        context: "default".into(),
        yaml: String::new(),
        parsed: ApplyParsed {
            gvr: Gvr::new("rbac.authorization.k8s.io", "v1", "rolebindings"),
            namespace: "default".into(),
            name: "x".into(),
            dry_run: "ok".into(),
        },
    };
    let p = s.create("a", "default", payload, None, T0).unwrap();
    s.claim(&p.id, T0).unwrap();
    assert_eq!(s.approve(&p.id, ApprovalChoices::default(), &ok_check(), T0).unwrap_err().reason, "NeedsApproval");
}

#[test]
fn gate_enforces_step_order_and_live_flags() {
    let mut s = Store::default();
    let owner = ApprovalChoices { owner: Some(ChoiceOwner::Agent { idle_stop_minutes: 15 }), ..shown() };
    let p = approved(&mut s, dev_set_up(true), owner);
    assert_eq!(s.gate(&p.id, "export", LIVE.0, LIVE.1, T0).unwrap_err().reason, "Conflict", "export before up");
    let up = s.gate(&p.id, "up", LIVE.0, LIVE.1, T0).unwrap();
    assert_eq!(up.owner(), ForwardOwner::Agent { client: "claude-code".into(), idle_stop_minutes: 15 });
    assert_eq!(s.finish_step(&up, Ok(json!({ "forwards": 3 })), T0).unwrap().state, ProposalState::Executing);
    assert_eq!(s.finish_step(&up, Ok(json!({})), T0).unwrap_err().reason, "Conflict", "a step finishes once");
    let ro = CtxFlags { read_only: true, ..Default::default() };
    assert_eq!(s.gate(&p.id, "export", ro, LIVE.1, T0).unwrap_err().reason, "PolicyDenied");
    assert_eq!(s.get(&p.id, T0).unwrap().state, ProposalState::Cancelled, "flags flipped -> cancelled");
}

#[test]
fn lowered_policy_at_the_gate_cancels() {
    let mut s = Store::default();
    let p = approved(&mut s, scale(), ApprovalChoices::default());
    assert_eq!(s.gate(&p.id, "scale", CtxFlags::default(), Some(McpPolicy::Read), T0).unwrap_err().reason, "PolicyDenied");
    assert_eq!(s.get(&p.id, T0).unwrap().state, ProposalState::Cancelled);
}

#[test]
fn partial_failure() {
    let mut s = Store::default();
    let p = approved(&mut s, dev_set_up(true), shown());
    let up = s.gate(&p.id, "up", LIVE.0, LIVE.1, T0).unwrap();
    let failed = s.finish_step(&up, Err(BackendError::new(0, "AddrInUse", "9094")), T0).unwrap();
    assert_eq!(failed.state, ProposalState::Failed, "first step fails -> failed");

    let mut s = Store::default();
    let p = approved(&mut s, dev_set_up(true), shown());
    let up = s.gate(&p.id, "up", LIVE.0, LIVE.1, T0).unwrap();
    s.finish_step(&up, Ok(json!({ "forwards": 3 })), T0).unwrap();
    let export = s.gate(&p.id, "export", LIVE.0, LIVE.1, T0).unwrap();
    let p = s.finish_step(&export, Err(BackendError::new(0, "Io", "disk full")), T0).unwrap();
    assert_eq!(p.state, ProposalState::Approved, "later step fails -> approved, forwards stay");
    let data = p.result.and_then(|r| r.data).unwrap_or_default();
    assert_eq!(data["export"]["error"]["reason"], "Io");
    assert_eq!(data["up"]["forwards"], 3);
}

#[test]
fn resolve_rules() {
    let mut s = Store::default();
    let p = s.create("a", "default", scale(), None, T0).unwrap();
    let r = s.resolve(&p.id, ProposalResolution::Rejected { reason: Some("not \u{2066}now".into()) }, T0).unwrap();
    assert_eq!(r.state, ProposalState::Rejected);
    assert_eq!(r.result.and_then(|r| r.message).as_deref(), Some("not now"));
    let p = approved(&mut s, scale(), ApprovalChoices::default());
    assert_eq!(s.resolve(&p.id, ProposalResolution::Rejected { reason: None }, T0).unwrap_err().reason, "Conflict");
    assert_eq!(s.resolve(&p.id, ProposalResolution::Done { ok: false, error: None }, T0).unwrap_err().reason, "Invalid");
    assert_eq!(s.resolve(&p.id, ProposalResolution::Done { ok: true, error: None }, T0).unwrap_err().reason, "Conflict");
    let failed = s.resolve(&p.id, ProposalResolution::Done { ok: false, error: Some(BackendError::invalid("x")) }, T0).unwrap();
    assert_eq!(failed.state, ProposalState::Failed);
}

#[test]
fn cancellation_and_dev_set_changes() {
    let mut s = Store::default();
    let a = s.create("a", "default", scale(), None, T0).unwrap();
    let b = s.create("b", "staging", scale_in("staging"), None, T0).unwrap();
    let c = approved(&mut s, dev_set_up(false), shown());
    assert_eq!(s.cancel_where(|p| p.client == "a", "revoked", T0), vec![a.id.clone()]);
    assert_eq!(s.cancel_where(|p| p.context == "staging", "flags", T0), vec![b.id.clone()]);
    assert_eq!(s.cancel_where(|p| p.client == "claude-code", "revoked", T0), vec![c.id.clone()], "executing too");
    let d = s.create("d", "default", dev_set_up(false), None, T0).unwrap();
    assert!(s.expire_dev_set("other", T0).is_empty());
    assert_eq!(s.expire_dev_set("ds1", T0), vec![d.id.clone()]);
    assert_eq!(s.get(&d.id, T0).unwrap().state, ProposalState::Expired);
}

#[test]
fn agent_cancel_only_own_pending() {
    let mut s = Store::default();
    let p = s.create("a", "default", scale(), None, T0).unwrap();
    assert_eq!(s.cancel(&p.id, "b", T0).unwrap_err().code, 404);
    assert_eq!(s.cancel(&p.id, "a", T0).unwrap().state, ProposalState::Cancelled);
}

#[test]
fn keeps_the_last_hundred_final_proposals() {
    let mut s = Store::default();
    for i in 0..150 {
        let p = s.create(&format!("c{i}"), "default", scale(), None, T0).unwrap();
        if i < 140 {
            s.resolve(&p.id, ProposalResolution::Rejected { reason: None }, T0).unwrap();
        }
    }
    let all = s.list(T0);
    assert_eq!(all.len(), KEEP);
    assert_eq!(all.iter().filter(|p| p.state == ProposalState::Pending).count(), 10, "open ones are never dropped");
}

#[test]
fn steps_per_kind() {
    let kinds: Vec<(&str, Vec<&str>)> = payloads().iter().map(|p| (kind(p), steps(p))).collect();
    assert_eq!(kinds[0], ("devSetUp", vec!["up", "export"]));
    assert_eq!(kinds[1], ("forward", vec!["forward"]));
    assert_eq!(kinds.len(), 10);
    assert!(kinds.iter().all(|(_, s)| s.len() == 1 || s.len() == 2));
}

#[tokio::test]
async fn run_step_without_proposal_is_a_human_action() {
    let state = AppState::default();
    let out = run_step(&state, None, "scale", |_| false, async { Ok(7) }).await.unwrap();
    assert_eq!(out, 7);
    let err = run_step(&state, Some("p1"), "scale", |_| true, async { Ok(7) }).await.unwrap_err();
    assert_eq!(err.reason, "NotFound");
}

#[tokio::test]
async fn gate_denies_until_settings_are_loaded_and_while_policy_is_unknown() {
    let state = AppState::default();
    // approved now (the live `gate` uses the real clock; at T0 the stall rule would end it)
    let p = with_store(&state, |s| approved_at(s, scale(), ApprovalChoices::default(), now_ms()));
    assert_eq!(gate(&state, &p.id, "scale").unwrap_err().reason, "NotLoaded");
    crate::ctxflags::set(&state, Some(Default::default()));
    assert_eq!(gate(&state, &p.id, "scale").unwrap_err().reason, "PolicyDenied", "no MCP policy before H1");
}

#[test]
fn a_step_gets_one_ticket_at_a_time() {
    let mut s = Store::default();
    let p = approved(&mut s, scale(), ApprovalChoices::default());
    let first = s.gate(&p.id, "scale", LIVE.0, LIVE.1, T0).unwrap();
    assert_eq!(s.gate(&p.id, "scale", LIVE.0, LIVE.1, T0).unwrap_err().reason, "Conflict", "no second concurrent run");
    assert_eq!(s.finish_step(&first, Ok(json!({})), T0).unwrap().state, ProposalState::Approved);
}

/// H3 (was: a webview failure ends a step left in flight). A step holding a ticket is a Rust
/// command still running (Tauri commands outlive a page reload), so the webview cannot end it:
/// the command reports its own outcome and the proposal never says `failed` over a live forward.
#[test]
fn a_step_in_flight_reports_its_own_outcome() {
    let mut s = Store::default();
    let p = approved(&mut s, scale(), ApprovalChoices::default());
    let ticket = s.gate(&p.id, "scale", LIVE.0, LIVE.1, T0).unwrap();
    let reload = || ProposalResolution::Done { ok: false, error: Some(BackendError::new(0, "Interrupted", "reload")) };
    assert_eq!(s.resolve(&p.id, reload(), T0).unwrap_err().reason, "Conflict");
    // not even after a long time: the stall rule skips a step in flight
    assert_eq!(s.get(&p.id, T0 + 60 * MIN).unwrap().state, ProposalState::Executing);
    assert_eq!(s.finish_step(&ticket, Ok(json!({ "ok": true })), T0 + 60 * MIN).unwrap().state, ProposalState::Approved);
}

/// H3: a reload after approval, before the first step: the next page ends it `failed` at boot.
#[test]
fn executing_before_the_first_step_fails_cleanly() {
    let mut s = Store::default();
    let p = approved(&mut s, dev_set_up(true), shown());
    let r = s.resolve(&p.id, ProposalResolution::Done { ok: false, error: Some(BackendError::new(0, "Interrupted", "reloaded")) }, T0).unwrap();
    assert_eq!(r.state, ProposalState::Failed);
    assert_eq!(r.result.unwrap().error.unwrap().reason, "Interrupted");
    assert!(s.gate(&p.id, "up", LIVE.0, LIVE.1, T0).is_err(), "nothing runs afterwards");
}

/// H3: a reload between `up` and `export`: the forwards stay, the proposal ends `approved` with
/// `data.export.error` (§2.6 partial failure), like a failing export.
#[test]
fn executing_between_steps_ends_with_what_ran() {
    let mut s = Store::default();
    let p = approved(&mut s, dev_set_up(true), shown());
    let up = s.gate(&p.id, "up", LIVE.0, LIVE.1, T0).unwrap();
    s.finish_step(&up, Ok(json!({ "forwards": [] })), T0).unwrap();
    let r = s.resolve(&p.id, ProposalResolution::Done { ok: false, error: Some(BackendError::new(0, "Interrupted", "reloaded")) }, T0).unwrap();
    assert_eq!(r.state, ProposalState::Approved);
    let res = r.result.unwrap();
    let data = res.data.unwrap();
    assert!(data["up"].is_object() && data["export"]["error"]["reason"] == "Interrupted", "{data}");
    assert!(res.message.unwrap().contains("\"export\" did not run"));
}

/// H3 backstop: with no window left to run it, an `executing` proposal with nothing in flight ends
/// after `EXEC_STALL` of no progress (lazily, on the next access; no timer).
#[test]
fn a_stalled_execution_ends_after_the_stall_time() {
    let mut s = Store::default();
    let p = approved(&mut s, scale(), ApprovalChoices::default());
    let stall = EXEC_STALL.as_millis() as i64;
    assert_eq!(s.get(&p.id, T0 + stall - 1).unwrap().state, ProposalState::Executing);
    let r = s.get(&p.id, T0 + stall).unwrap();
    assert_eq!(r.state, ProposalState::Failed);
    assert_eq!(r.result.unwrap().error.unwrap().reason, "Interrupted");
    // progress resets the clock: a finished first step of two moves it
    let q = approved_at(&mut s, dev_set_up(true), shown(), T0 + stall);
    let up = s.gate(&q.id, "up", LIVE.0, LIVE.1, T0 + stall).unwrap();
    s.finish_step(&up, Ok(json!({})), T0 + stall).unwrap();
    assert_eq!(s.get(&q.id, T0 + 2 * stall - 1).unwrap().state, ProposalState::Executing);
    assert_eq!(s.get(&q.id, T0 + 2 * stall).unwrap().state, ProposalState::Approved);
}

#[test]
fn the_payload_must_act_on_the_proposal_context() {
    let mut s = Store::default();
    assert_eq!(s.create("a", "staging", scale(), None, T0).unwrap_err().reason, "Invalid", "scale of a default object");
    assert!(s.create("a", "staging", scale_in("staging"), None, T0).is_ok());
    assert!(s.create("b", "anything", dev_set_up(false), None, T0).is_ok(), "dev-set kinds carry no context");
}
