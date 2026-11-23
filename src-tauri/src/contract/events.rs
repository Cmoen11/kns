//! Backend -> UI events: mirror of `src/ipc/contract/events.ts` (docs/plan-features.md §2.2). Owner A1.
//! Emitted by `events::emit` on the Tauri event `kns://event`. Hints, not state.
use serde::{Deserialize, Serialize};

use super::agents::{AgentShowView, McpStatus};
use super::update::UpdateStatus;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum BackendEvent {
    Proposals { pending: u32 },
    DevSets { context: String },
    Forwards,
    AgentActivity { client: String, tool: String, at: String, ok: bool },
    AgentShow { client: String, view: AgentShowView },
    TrapFired { trap_id: String, bundle_id: String },
    Mcp { status: McpStatus },
    Journal { context: String, rows: u64 },
    Update { status: UpdateStatus },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{agents::ShowView, drift::Fixtures, update::UpdateState};

    #[test]
    fn drift() {
        let mut f = Fixtures::new("events");
        f.add(
            "events",
            "BackendEvent[]",
            &vec![
                BackendEvent::Proposals { pending: 1 },
                BackendEvent::DevSets { context: "default".into() },
                BackendEvent::Forwards,
                BackendEvent::AgentActivity { client: "claude-code".into(), tool: "get_status".into(), at: "2026-11-22T10:00:00Z".into(), ok: true },
                BackendEvent::AgentShow { client: "claude-code".into(), view: AgentShowView { view: ShowView::Devset, obj_ref: None, dev_set: Some("ds1".into()) } },
                BackendEvent::TrapFired { trap_id: "t1".into(), bundle_id: "b1".into() },
                BackendEvent::Mcp { status: McpStatus { on: false, port: 7099, clients: vec![], tools: vec![], policies: vec![], error: None } },
                BackendEvent::Journal { context: "default".into(), rows: 3 },
                BackendEvent::Update { status: UpdateStatus { state: UpdateState::Ready, current: "0.2.0".into(), version: Some("0.3.0".into()), ..Default::default() } },
            ],
        );
        f.check();
    }
}
