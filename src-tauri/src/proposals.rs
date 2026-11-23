//! Agent proposals: model, in-memory store and the Rust gate (docs/plan-features.md §2.6).
//!
//! An agent (MCP, H2) creates a proposal; the human claims it by opening its dialog, approves it
//! (Rust checks flags, policy, the shown dev-set hash and the typed confirmation, then stores the
//! choices and the step list), and the frontend runs each step through the same command a manual
//! action uses, passing `proposalId`. Every such command calls [`gate`] first: it requires state
//! `executing` and that the step is the next unfinished one, re-reads the context flags and the
//! effective policy, and hands back a [`GateTicket`] carrying the stored choices. Commands take the
//! forward owner and the secret keys **only from the ticket**, and report each step with
//! [`finish_step`]. Rust builds `result.data` itself, never from webview input.
//!
//! The store is pure (`Store`, clock passed in) so the state machine is tested without Tauri.
//! Expiry is computed lazily on every access: no timers.
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
    time::Duration,
};

use serde_json::json;

use crate::{
    ctxflags::{self, CtxFlags},
    events,
    ipc::{
        ApprovalChoices, BackendError, BackendEvent, ChoiceOwner, ForwardOwner, Json, McpPolicy, Proposal, ProposalPayload,
        ProposalResolution, ProposalResult, ProposalState, Result,
    },
    redact,
    state::{AppState, lock},
};

pub const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
pub const REVIEW_CAP: Duration = Duration::from_secs(30 * 60);
/// A proposal the human unclaims keeps at least this long before it can expire.
const UNCLAIM_GRACE: Duration = Duration::from_secs(60);
/// Final proposals kept in memory (open ones are never dropped).
pub const KEEP: usize = 100;
pub const PER_MINUTE: usize = 6;
pub const REASON_MAX: usize = 500;
/// An `executing` proposal with no step running that made no progress for this long is ended
/// (the window that ran it was reloaded or closed). Every executor calls its next step at once,
/// so a live one never waits this long; a step that holds a ticket is never ended this way.
pub const EXEC_STALL: Duration = Duration::from_secs(10 * 60);

/// Proof that a command may run one step of an approved proposal. Not constructible outside
/// this module; commands read owner and secret inclusion from here only.
#[derive(Debug, Clone)]
pub struct GateTicket {
    pub proposal_id: String,
    pub step: String,
    index: usize,
    pub client: String,
    pub context: String,
    pub payload: ProposalPayload,
    pub choices: ApprovalChoices,
}

impl GateTicket {
    /// Who owns forwards started by this step: the human's choice in the dialog (default: the human).
    pub fn owner(&self) -> ForwardOwner {
        match &self.choices.owner {
            Some(ChoiceOwner::Agent { idle_stop_minutes }) => {
                ForwardOwner::Agent { client: self.client.clone(), idle_stop_minutes: *idle_stop_minutes }
            }
            Some(ChoiceOwner::User) | None => ForwardOwner::User,
        }
    }

    /// Secret-sourced keys the human ticked (empty unless ticked).
    pub fn include_secrets(&self) -> &[String] {
        self.choices.include_secrets.as_deref().unwrap_or_default()
    }
}

/// What `approve` checks besides the proposal itself; gathered by the caller from the live state.
#[derive(Debug, Clone, Default)]
pub struct ApproveCheck {
    pub flags: CtxFlags,
    pub policy: Option<McpPolicy>,
    /// devSetUp: the set's current hash (`None` = the set is gone)
    pub current_hash: Option<String>,
    /// devSetUp with exportEnv: the workload the env comes from (for the typed confirmation)
    pub workload: Option<String>,
}

/// The step list of a payload (§2.6 "Steps").
pub fn steps(payload: &ProposalPayload) -> Vec<&'static str> {
    match payload {
        ProposalPayload::DevSetUp { export_env: Some(_), .. } => vec!["up", "export"],
        ProposalPayload::DevSetUp { .. } => vec!["up"],
        ProposalPayload::Forward { .. } => vec!["forward"],
        ProposalPayload::EnvExport { .. } => vec!["export"],
        ProposalPayload::DevSetDelete { .. } => vec!["delete"],
        ProposalPayload::DevSetUpdate { .. } => vec!["update"],
        ProposalPayload::Scale { .. } => vec!["scale"],
        ProposalPayload::Restart { .. } => vec!["restart"],
        ProposalPayload::Delete { .. } => vec!["delete"],
        ProposalPayload::Reconcile { .. } => vec!["reconcile"],
        ProposalPayload::Apply { .. } => vec!["apply"],
    }
}

/// The payload's kind as the wire calls it (`devSetUp`, `scale`, ...).
pub fn kind(payload: &ProposalPayload) -> &'static str {
    match payload {
        ProposalPayload::DevSetUp { .. } => "devSetUp",
        ProposalPayload::Forward { .. } => "forward",
        ProposalPayload::EnvExport { .. } => "envExport",
        ProposalPayload::DevSetDelete { .. } => "devSetDelete",
        ProposalPayload::DevSetUpdate { .. } => "devSetUpdate",
        ProposalPayload::Scale { .. } => "scale",
        ProposalPayload::Restart { .. } => "restart",
        ProposalPayload::Delete { .. } => "delete",
        ProposalPayload::Reconcile { .. } => "reconcile",
        ProposalPayload::Apply { .. } => "apply",
    }
}

/// Well-known default ports of data services (§5.5): forwarding them in a protected context is tier 2.
pub const WELL_KNOWN_PORTS: &[u16] = &[5432, 3306, 6379, 9092, 27017, 5672, 11211];

/// Kinds that are tier 2 by themselves: `apply` of RBAC / Secret / ServiceAccount objects (§5.3).
pub fn tier2_kind(payload: &ProposalPayload) -> bool {
    matches!(payload, ProposalPayload::Apply { parsed, .. }
        if matches!(parsed.gvr.resource.as_str(), "roles" | "rolebindings" | "secrets" | "serviceaccounts"))
}

/// The text the human must type to approve, or `None` when no typed confirmation is needed:
/// the workload name when secret keys are included, else the context name when the context is
/// protected or the kind is tier 2.
pub fn expected_typed(p: &Proposal, choices: &ApprovalChoices, check: &ApproveCheck) -> Option<String> {
    let secrets = choices.include_secrets.as_ref().is_some_and(|s| !s.is_empty());
    if secrets {
        let workload = match &p.payload {
            ProposalPayload::EnvExport { spec, .. } => Some(spec.workload.name.clone()),
            _ => check.workload.clone(),
        };
        return Some(workload.unwrap_or_else(|| p.context.clone()));
    }
    (check.flags.protected || tier2_kind(&p.payload)).then(|| p.context.clone())
}

fn rfc3339(ms: i64) -> String {
    jiff::Timestamp::from_millisecond(ms).map(|t| t.to_string()).unwrap_or_default()
}

fn conflict(p: &Proposal, wanted: &str) -> BackendError {
    BackendError::new(409, "Conflict", format!("proposal {} is {}, not {wanted}", p.id, state_name(p.state)))
}

fn state_name(s: ProposalState) -> String {
    serde_json::to_value(s).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

fn not_found(id: &str) -> BackendError {
    BackendError::new(404, "NotFound", format!("proposal {id} not found"))
}

fn denied(message: impl Into<String>) -> BackendError {
    BackendError::new(0, "PolicyDenied", message)
}


/// The context a payload acts on, when it names one (dev-set kinds take the set's context).
pub fn payload_context(payload: &ProposalPayload) -> Option<&str> {
    match payload {
        ProposalPayload::Forward { context, .. } | ProposalPayload::Apply { context, .. } => Some(context),
        ProposalPayload::Scale { obj_ref, .. }
        | ProposalPayload::Restart { obj_ref }
        | ProposalPayload::Delete { obj_ref }
        | ProposalPayload::Reconcile { obj_ref, .. } => Some(&obj_ref.context),
        ProposalPayload::DevSetUp { .. }
        | ProposalPayload::EnvExport { .. }
        | ProposalPayload::DevSetDelete { .. }
        | ProposalPayload::DevSetUpdate { .. } => None,
    }
}

const OPEN: [ProposalState; 2] = [ProposalState::Pending, ProposalState::Reviewing];

struct Entry {
    proposal: Proposal,
    created_ms: i64,
    expires_ms: i64,
    steps: Vec<&'static str>,
    /// set by `approve`
    choices: Option<ApprovalChoices>,
    /// finished steps and the data Rust recorded for each
    done: Vec<(String, Json)>,
    /// the step a command holds a ticket for (one ticket per step)
    in_flight: Option<usize>,
    /// when `executing` last moved (approval, a step started or finished): see [`EXEC_STALL`]
    progress_ms: i64,
}

impl Entry {
    fn finish(&mut self, state: ProposalState, result: ProposalResult, now: i64) {
        self.in_flight = None;
        self.proposal.state = state;
        self.proposal.result = Some(result);
        self.proposal.resolved_at = Some(rfc3339(now));
    }

    /// Ends an `executing` proposal whose next step will not run (H3): `failed` when no step ran,
    /// else `approved` with what ran and `data.<next step>.error`, like a failing later step
    /// (§2.6 "Partial failure"). The caller made sure no step holds a ticket.
    fn interrupt(&mut self, error: BackendError, now: i64) {
        if self.done.is_empty() {
            self.finish(ProposalState::Failed, ProposalResult { error: Some(error), ..Default::default() }, now);
            return;
        }
        let next = self.steps.get(self.done.len()).copied().unwrap_or("next");
        self.done.push((next.to_string(), json!({ "error": error })));
        let data = self.data();
        let text = format!("step \"{next}\" did not run; earlier steps stay in effect");
        self.finish(ProposalState::Approved, ProposalResult { data: Some(data), ..message(text) }, now);
    }

    fn data(&self) -> Json {
        Json::Object(self.done.iter().cloned().collect())
    }

    fn is_open(&self) -> bool {
        OPEN.contains(&self.proposal.state)
    }
}

fn message(text: impl Into<String>) -> ProposalResult {
    ProposalResult { message: Some(text.into()), ..Default::default() }
}

fn clean_reason(r: &str) -> Option<String> {
    let cleaned: String = redact::clean_untrusted(r, redact::MAX_LINE).chars().take(REASON_MAX).collect();
    (!cleaned.trim().is_empty()).then_some(cleaned)
}

/// The proposal store. Pure: every method takes `now` (ms since epoch).
#[derive(Default)]
pub struct Store {
    entries: VecDeque<Entry>,
    /// creation times per client in the last minute (rate limit)
    recent: HashMap<String, VecDeque<i64>>,
    next: u64,
}

impl Store {
    fn expire(&mut self, now: i64) {
        for e in &mut self.entries {
            if e.is_open() && e.expires_ms <= now {
                e.finish(ProposalState::Expired, message("the human did not answer in time"), now);
            } else if e.proposal.state == ProposalState::Executing && e.in_flight.is_none() && now - e.progress_ms >= EXEC_STALL.as_millis() as i64 {
                let error = BackendError::new(0, "Interrupted", "kns did not run the approved request (its window was reloaded or closed); nothing more will run");
                e.interrupt(error, now);
            }
        }
    }

    fn entry(&mut self, id: &str, now: i64) -> Result<&mut Entry> {
        self.expire(now);
        self.entries.iter_mut().find(|e| e.proposal.id == id).ok_or_else(|| not_found(id))
    }

    /// Open proposals the human still has to answer.
    pub fn pending(&self) -> u32 {
        self.entries.iter().filter(|e| e.is_open()).count() as u32
    }

    /// Creates a pending proposal. At most one waiting proposal per client and `PER_MINUTE` per minute.
    pub fn create(&mut self, client: &str, context: &str, payload: ProposalPayload, reason: Option<&str>, now: i64) -> Result<Proposal> {
        self.expire(now);
        if let Some(own) = payload_context(&payload)
            && own != context
        {
            return Err(BackendError::invalid(format!("the proposal is for context {context} but acts on {own}")));
        }
        if self.entries.iter().any(|e| e.proposal.client == client && e.is_open()) {
            return Err(BackendError::new(429, "RateLimited", "you already have a proposal waiting for the human; call wait_proposal"));
        }
        let recent = self.recent.entry(client.to_string()).or_default();
        recent.retain(|t| now - *t < 60_000);
        if recent.len() >= PER_MINUTE {
            return Err(BackendError::new(429, "RateLimited", format!("at most {PER_MINUTE} proposals per minute")));
        }
        recent.push_back(now);
        self.next += 1;
        let expires_ms = now + PENDING_TTL.as_millis() as i64;
        let steps = steps(&payload);
        let proposal = Proposal {
            id: format!("p{}", self.next),
            client: client.to_string(),
            context: context.to_string(),
            created_at: rfc3339(now),
            expires_at: rfc3339(expires_ms),
            state: ProposalState::Pending,
            reason: reason.and_then(clean_reason),
            payload,
            result: None,
            resolved_at: None,
        };
        self.entries.push_back(Entry { proposal: proposal.clone(), created_ms: now, expires_ms, steps, choices: None, done: Vec::new(), in_flight: None, progress_ms: now });
        self.trim();
        Ok(proposal)
    }

    fn trim(&mut self) {
        while self.entries.len() > KEEP {
            let Some(i) = self.entries.iter().position(|e| e.proposal.state.is_final()) else { break };
            self.entries.remove(i);
        }
    }

    pub fn list(&mut self, now: i64) -> Vec<Proposal> {
        self.expire(now);
        self.entries.iter().map(|e| e.proposal.clone()).collect()
    }

    pub fn get(&mut self, id: &str, now: i64) -> Result<Proposal> {
        Ok(self.entry(id, now)?.proposal.clone())
    }

    /// The dialog opened: `pending` -> `reviewing`, kept open until the 30-minute cap.
    pub fn claim(&mut self, id: &str, now: i64) -> Result<Proposal> {
        let e = self.entry(id, now)?;
        if e.proposal.state != ProposalState::Pending {
            return Err(conflict(&e.proposal, "pending"));
        }
        e.proposal.state = ProposalState::Reviewing;
        e.expires_ms = e.created_ms + REVIEW_CAP.as_millis() as i64;
        e.proposal.expires_at = rfc3339(e.expires_ms);
        Ok(e.proposal.clone())
    }

    /// Esc / dialog closed: `reviewing` -> `pending` (at least a minute left, at most the cap).
    pub fn unclaim(&mut self, id: &str, now: i64) -> Result<Proposal> {
        let e = self.entry(id, now)?;
        if e.proposal.state != ProposalState::Reviewing {
            return Err(conflict(&e.proposal, "reviewing"));
        }
        e.proposal.state = ProposalState::Pending;
        let at_least = (e.created_ms + PENDING_TTL.as_millis() as i64).max(now + UNCLAIM_GRACE.as_millis() as i64);
        e.expires_ms = at_least.min(e.created_ms + REVIEW_CAP.as_millis() as i64);
        e.proposal.expires_at = rfc3339(e.expires_ms);
        Ok(e.proposal.clone())
    }

    /// `reviewing` -> `executing`, after every check of §2.6; stores the choices and the steps.
    pub fn approve(&mut self, id: &str, choices: ApprovalChoices, check: &ApproveCheck, now: i64) -> Result<Proposal> {
        let e = self.entry(id, now)?;
        if e.proposal.state != ProposalState::Reviewing {
            return Err(conflict(&e.proposal, "reviewing"));
        }
        if check.flags.read_only {
            return Err(denied(format!("context {} is read-only", e.proposal.context)));
        }
        if check.policy != Some(McpPolicy::Propose) {
            return Err(denied(format!("the agent policy for {} is not \"propose\"", e.proposal.context)));
        }
        if matches!(e.proposal.payload, ProposalPayload::DevSetUp { .. }) {
            let shown = choices.shown_hash.as_deref();
            if shown.is_none() || shown != check.current_hash.as_deref() {
                let text = "the dev set changed while it was shown";
                e.finish(ProposalState::Expired, message(text), now);
                return Err(BackendError::new(0, "NeedsApproval", text));
            }
        }
        let exports = matches!(e.proposal.payload, ProposalPayload::EnvExport { .. } | ProposalPayload::DevSetUp { export_env: Some(_), .. });
        if !exports && choices.include_secrets.as_ref().is_some_and(|s| !s.is_empty()) {
            return Err(BackendError::invalid("this proposal exports no env; no secret keys can be included"));
        }
        if let Some(expected) = expected_typed(&e.proposal, &choices, check)
            && choices.typed.as_deref() != Some(expected.as_str())
        {
            return Err(BackendError::new(0, "NeedsApproval", format!("type \"{expected}\" to approve")));
        }
        e.proposal.state = ProposalState::Executing;
        e.choices = Some(choices);
        e.done.clear();
        e.in_flight = None;
        e.progress_ms = now;
        Ok(e.proposal.clone())
    }

    /// The webview rejects (from `pending`/`reviewing`), or reports that the next step of an
    /// `executing` proposal will not run (it failed before its command was called, or the page was
    /// reloaded): `failed` when no step ran, else `approved` with what ran ([`Entry::interrupt`]).
    /// A step that holds a ticket is still running in Rust and reports its own outcome, so it is
    /// never ended from here (`Conflict`).
    pub fn resolve(&mut self, id: &str, resolution: ProposalResolution, now: i64) -> Result<Proposal> {
        let e = self.entry(id, now)?;
        match resolution {
            ProposalResolution::Rejected { reason } => {
                if !e.is_open() {
                    return Err(conflict(&e.proposal, "pending or reviewing"));
                }
                let text = reason.as_deref().and_then(clean_reason).unwrap_or_else(|| "rejected by the human".into());
                e.finish(ProposalState::Rejected, message(text), now);
            }
            ProposalResolution::Done { ok: false, error } => {
                let error = error.ok_or_else(|| BackendError::invalid("a failed resolution needs an error"))?;
                if e.proposal.state != ProposalState::Executing {
                    return Err(conflict(&e.proposal, "executing"));
                }
                if let Some(i) = e.in_flight {
                    let step = e.steps.get(i).copied().unwrap_or_default();
                    return Err(BackendError::new(409, "Conflict", format!("proposal {id}: step \"{step}\" is still running and reports its own outcome")));
                }
                e.interrupt(error, now);
            }
            ProposalResolution::Done { ok: true, .. } => {
                if e.proposal.state != ProposalState::Executing || e.done.len() < e.steps.len() {
                    return Err(BackendError::new(409, "Conflict", "steps of this proposal have not run yet"));
                }
                let data = e.data();
                e.finish(ProposalState::Approved, ProposalResult { data: Some(data), ..Default::default() }, now);
            }
        }
        Ok(e.proposal.clone())
    }

    /// The Rust gate: the next step of an `executing` proposal, re-checked against the live flags
    /// and policy. A read-only context or a policy below `propose` cancels the proposal.
    pub fn gate(&mut self, id: &str, step: &str, flags: CtxFlags, policy: Option<McpPolicy>, now: i64) -> Result<GateTicket> {
        let e = self.entry(id, now)?;
        if e.proposal.state != ProposalState::Executing {
            return Err(conflict(&e.proposal, "executing (approve it in kns first)"));
        }
        let index = e.done.len();
        let next = e.steps.get(index).copied().unwrap_or_default();
        if next != step {
            return Err(BackendError::new(409, "Conflict", format!("proposal {id}: the next step is \"{next}\", not \"{step}\"")));
        }
        if e.in_flight == Some(index) {
            return Err(BackendError::new(409, "Conflict", format!("proposal {id}: step \"{step}\" is already running")));
        }
        let why = if flags.read_only {
            Some(format!("context {} became read-only", e.proposal.context))
        } else if policy != Some(McpPolicy::Propose) {
            Some(format!("the agent policy for {} is no longer \"propose\"", e.proposal.context))
        } else {
            None
        };
        if let Some(why) = why {
            e.finish(ProposalState::Cancelled, message(why.clone()), now);
            return Err(denied(why));
        }
        e.in_flight = Some(index);
        e.progress_ms = now;
        Ok(GateTicket {
            proposal_id: e.proposal.id.clone(),
            step: step.to_string(),
            index,
            client: e.proposal.client.clone(),
            context: e.proposal.context.clone(),
            payload: e.proposal.payload.clone(),
            choices: e.choices.clone().unwrap_or_default(),
        })
    }

    /// Records one step. The proposal ends after the last step (`approved`) or the first failing
    /// step (`failed`); a failure of a later step (the export after `up`) leaves what ran in place
    /// and ends `approved` with that step's error in `data` (§2.6 "Partial failure").
    pub fn finish_step(&mut self, ticket: &GateTicket, outcome: Result<Json>, now: i64) -> Result<Proposal> {
        let e = self.entry(&ticket.proposal_id, now)?;
        if e.proposal.state != ProposalState::Executing || e.done.len() != ticket.index || e.in_flight != Some(ticket.index) {
            return Err(conflict(&e.proposal, "executing at this step"));
        }
        e.in_flight = None;
        e.progress_ms = now;
        match outcome {
            Ok(data) => {
                e.done.push((ticket.step.clone(), data));
                if e.done.len() == e.steps.len() {
                    let data = e.data();
                    e.finish(ProposalState::Approved, ProposalResult { data: Some(data), ..Default::default() }, now);
                }
            }
            Err(error) if ticket.index == 0 => {
                e.finish(ProposalState::Failed, ProposalResult { error: Some(error), ..Default::default() }, now);
            }
            Err(error) => {
                e.done.push((ticket.step.clone(), json!({ "error": error })));
                let data = e.data();
                let text = format!("step \"{}\" failed; earlier steps stay in effect", ticket.step);
                e.finish(ProposalState::Approved, ProposalResult { data: Some(data), ..message(text) }, now);
            }
        }
        Ok(e.proposal.clone())
    }

    /// The agent withdraws its own proposal while it is still `pending`.
    pub fn cancel(&mut self, id: &str, client: &str, now: i64) -> Result<Proposal> {
        let e = self.entry(id, now)?;
        if e.proposal.client != client {
            return Err(not_found(id));
        }
        if e.proposal.state != ProposalState::Pending {
            return Err(conflict(&e.proposal, "pending"));
        }
        e.finish(ProposalState::Cancelled, message("withdrawn by the agent"), now);
        Ok(e.proposal.clone())
    }

    /// Cancels the open and executing proposals that match; returns their ids (§2.6 "Cancellation").
    pub fn cancel_where(&mut self, matches: impl Fn(&Proposal) -> bool, why: &str, now: i64) -> Vec<String> {
        self.expire(now);
        let mut ids = Vec::new();
        for e in &mut self.entries {
            let live = e.is_open() || e.proposal.state == ProposalState::Executing;
            if live && matches(&e.proposal) {
                e.finish(ProposalState::Cancelled, message(why), now);
                ids.push(e.proposal.id.clone());
            }
        }
        ids
    }

    /// A dev set changed: open proposals about it can no longer be approved as shown (§2.5).
    pub fn expire_dev_set(&mut self, dev_set: &str, now: i64) -> Vec<String> {
        self.expire(now);
        let mut ids = Vec::new();
        for e in &mut self.entries {
            let about_it = match &e.proposal.payload {
                ProposalPayload::DevSetUp { dev_set: d, .. }
                | ProposalPayload::DevSetDelete { dev_set: d }
                | ProposalPayload::DevSetUpdate { dev_set: d, .. } => d == dev_set,
                ProposalPayload::EnvExport { dev_set: Some(d), .. } => d == dev_set,
                _ => false,
            };
            if about_it && e.is_open() {
                e.finish(ProposalState::Expired, message("the dev set changed while waiting for approval"), now);
                ids.push(e.proposal.id.clone());
            }
        }
        ids
    }
}

// ───────────────────────── app-level API (§2.1 internal API) ─────────────────────────

#[derive(Default)]
pub struct Proposals(Mutex<Store>);

fn now_ms() -> i64 {
    jiff::Timestamp::now().as_millisecond()
}

fn with_store<T>(state: &AppState, f: impl FnOnce(&mut Store) -> T) -> T {
    let slot = state.ext::<Proposals>();
    let mut store = lock(&slot.0);
    f(&mut store)
}

/// Tells the webview to re-list (with the pending count for the bottom-row segment).
fn changed(state: &AppState) {
    let pending = with_store(state, |s| s.pending());
    events::emit(state, BackendEvent::Proposals { pending });
}

/// The effective MCP policy of a context (owned by H1). `None` until H1 lands; every check
/// treats it as "not propose", so nothing can be approved or executed before then.
fn policy(state: &AppState, context: &str) -> Option<McpPolicy> {
    crate::mcp::effective_policy(state, context)
}

/// Creates a proposal for `client` (H2's propose tools) and asks for the human's attention.
pub fn create(state: &AppState, client: &str, context: &str, payload: ProposalPayload, reason: Option<&str>) -> Result<Proposal> {
    let p = with_store(state, |s| s.create(client, context, payload, reason, now_ms()))?;
    changed(state);
    crate::notify::attention_for_proposal(state, &p);
    Ok(p)
}

pub fn get(state: &AppState, id: &str) -> Result<Proposal> {
    with_store(state, |s| s.get(id, now_ms()))
}

pub fn list(state: &AppState) -> Vec<Proposal> {
    with_store(state, |s| s.list(now_ms()))
}

/// The agent withdraws its own pending proposal (H2's `cancel_proposal`).
pub fn cancel(state: &AppState, id: &str, client: &str) -> Result<Proposal> {
    let p = with_store(state, |s| s.cancel(id, client, now_ms()));
    changed(state);
    audited(state, p)
}

/// The gate every proposal-executing command calls when it got a `proposalId`.
pub fn gate(state: &AppState, id: &str, step: &str) -> Result<GateTicket> {
    let context = get(state, id)?.context;
    let flags = ctxflags::effective(state, &context)?;
    // read outside the store lock: the policy has its own state (H1)
    let policy = policy(state, &context);
    let result = with_store(state, |s| s.gate(id, step, flags, policy, now_ms()));
    if result.is_err() {
        changed(state);
    }
    result
}

/// Records a step's outcome; `data` is built by the command from its own records, never values.
pub fn finish_step(state: &AppState, ticket: &GateTicket, outcome: Result<Json>) -> Result<Proposal> {
    let p = with_store(state, |s| s.finish_step(ticket, outcome, now_ms()));
    changed(state);
    audited(state, p)
}

/// Writes the state change of `p` to the MCP audit file (H2) and passes it through.
fn audited(state: &AppState, p: Result<Proposal>) -> Result<Proposal> {
    if let Ok(p) = &p {
        crate::mcp::audit_proposal(state, p);
    }
    p
}

/// Runs one gated step when `proposal_id` is set: gate, check the command's arguments against the
/// approved payload, run, record. Without a `proposal_id` it is a human action and just runs.
pub async fn run_step<T, F>(
    state: &AppState,
    proposal_id: Option<&str>,
    step: &str,
    matches: impl FnOnce(&ProposalPayload) -> bool,
    run: F,
) -> Result<T>
where
    F: std::future::Future<Output = Result<T>>,
{
    let Some(id) = proposal_id else { return run.await };
    let ticket = gate(state, id, step)?;
    if !matches(&ticket.payload) {
        let error = BackendError::invalid(format!("the request does not match proposal {id}"));
        let _ = finish_step(state, &ticket, Err(error.clone()));
        return Err(error);
    }
    let result = run.await;
    let outcome = match &result {
        Ok(_) => Ok(json!({ "ok": true })),
        Err(e) => Err(e.clone()),
    };
    finish_step(state, &ticket, outcome)?;
    result
}

pub fn cancel_context(state: &AppState, context: &str, why: &str) -> Vec<String> {
    let ids = with_store(state, |s| s.cancel_where(|p| p.context == context, why, now_ms()));
    if !ids.is_empty() {
        changed(state);
    }
    ids
}

pub fn cancel_client(state: &AppState, client: &str, why: &str) -> Vec<String> {
    let ids = with_store(state, |s| s.cancel_where(|p| p.client == client, why, now_ms()));
    if !ids.is_empty() {
        changed(state);
    }
    ids
}

/// Called by devset.rs whenever a set changes.
pub fn expire_dev_set(state: &AppState, dev_set: &str) -> Vec<String> {
    let ids = with_store(state, |s| s.expire_dev_set(dev_set, now_ms()));
    if !ids.is_empty() {
        changed(state);
    }
    ids
}

/// What `approve` checks, read from the live state.
async fn approve_check(state: &AppState, p: &Proposal) -> Result<ApproveCheck> {
    let flags = ctxflags::effective(state, &p.context)?;
    let mut check = ApproveCheck { flags, policy: policy(state, &p.context), ..Default::default() };
    if let ProposalPayload::DevSetUp { dev_set, .. } = &p.payload {
        let set = crate::devset::get(state, dev_set).await?;
        check.current_hash = set.as_ref().map(|s| s.hash.clone());
        check.workload = set.and_then(|s| s.env).map(|e| e.workload.name);
    }
    Ok(check)
}

pub mod cmd {
    use super::{AppState, approve_check, audited, changed, now_ms, with_store};
    use crate::ipc::{ApprovalChoices, Proposal, ProposalResolution, Result};

    #[tauri::command]
    pub fn proposals_list(state: tauri::State<'_, AppState>) -> Result<Vec<Proposal>> {
        Ok(super::list(&state))
    }

    #[tauri::command]
    pub fn proposal_claim(state: tauri::State<'_, AppState>, id: String) -> Result<Proposal> {
        let p = with_store(&state, |s| s.claim(&id, now_ms()));
        changed(&state);
        audited(&state, p)
    }

    #[tauri::command]
    pub fn proposal_unclaim(state: tauri::State<'_, AppState>, id: String) -> Result<Proposal> {
        let p = with_store(&state, |s| s.unclaim(&id, now_ms()));
        changed(&state);
        audited(&state, p)
    }

    #[tauri::command]
    pub async fn proposal_approve(state: tauri::State<'_, AppState>, id: String, choices: ApprovalChoices) -> Result<Proposal> {
        let p = super::get(&state, &id)?;
        let check = approve_check(&state, &p).await?;
        let p = with_store(&state, |s| s.approve(&id, choices, &check, now_ms()));
        changed(&state);
        audited(&state, p)
    }

    #[tauri::command]
    pub fn proposal_resolve(state: tauri::State<'_, AppState>, id: String, resolution: ProposalResolution) -> Result<Proposal> {
        let p = with_store(&state, |s| s.resolve(&id, resolution, now_ms()));
        changed(&state);
        audited(&state, p)
    }
}

#[cfg(test)]
mod tests;
