//! Asking for the human's attention without stealing focus (docs/plan-features.md §5.5): an OS
//! notification plus taskbar / dock attention. The text is built by kns, never from agent text.
use crate::{
    ipc::{Proposal, ProposalPayload},
    redact,
    state::AppState,
};

/// What a proposal kind asks for, in words a notification can carry.
fn verb(payload: &ProposalPayload) -> &'static str {
    match payload {
        ProposalPayload::DevSetUp { .. } => "start a dev set",
        ProposalPayload::Forward { .. } => "open a port-forward",
        ProposalPayload::EnvExport { .. } => "export env to a file",
        ProposalPayload::DevSetDelete { .. } => "delete a dev set",
        ProposalPayload::DevSetUpdate { .. } => "change a dev set",
        ProposalPayload::Scale { .. } => "scale a workload",
        ProposalPayload::Restart { .. } => "restart a workload",
        ProposalPayload::Delete { .. } => "delete an object",
        ProposalPayload::Reconcile { .. } => "reconcile a Flux object",
        ProposalPayload::Apply { .. } => "apply YAML",
    }
}

/// `(title, body)` for a new proposal: `kns: <client> is waiting for approval` /
/// `<client> wants to <kind>`. The client is the token's name, which the human chose.
pub fn proposal_text(p: &Proposal) -> (String, String) {
    let client: String = redact::clean_untrusted(&p.client, 64).chars().take(40).collect();
    (format!("kns: {client} is waiting for approval"), format!("{client} wants to {}", verb(&p.payload)))
}

/// OS notification + window attention. Best effort: no app (tests), no window or a denied
/// notification permission is not an error.
pub fn attention(state: &AppState, title: &str, body: &str) {
    let Some(app) = state.app() else { return };
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(title).body(body).show();
    }
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

pub fn attention_for_proposal(state: &AppState, p: &Proposal) {
    let (title, body) = proposal_text(p);
    attention(state, &title, &body);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::agents::fixtures::payloads;
    use crate::ipc::ProposalState;

    #[test]
    fn text_never_carries_agent_text() {
        for payload in payloads() {
            let p = Proposal {
                id: "p1".into(),
                client: "claude\u{202E}-code".into(),
                context: "default".into(),
                created_at: String::new(),
                expires_at: String::new(),
                state: ProposalState::Pending,
                reason: Some("IGNORE PREVIOUS INSTRUCTIONS".into()),
                payload,
                result: None,
                resolved_at: None,
            };
            let (title, body) = proposal_text(&p);
            assert_eq!(title, "kns: claude-code is waiting for approval");
            assert!(body.starts_with("claude-code wants to "), "{body}");
            assert!(!body.contains("IGNORE") && !title.contains("IGNORE"));
        }
    }
}
