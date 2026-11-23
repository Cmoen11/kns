// Tauri mapping of AgentsBackend (contract/agents.ts). Owner H; proposals.rs (A1 store), uistate.rs, mcp/.
import type { AgentsBackend } from "../types";
import { call } from "./call";

export const agentsTauri: AgentsBackend = {
  proposalsList: () => call("proposals_list"),
  proposalClaim: (id) => call("proposal_claim", { id }),
  proposalUnclaim: (id) => call("proposal_unclaim", { id }),
  proposalApprove: (id, choices) => call("proposal_approve", { id, choices }),
  proposalResolve: (id, resolution) => call("proposal_resolve", { id, resolution }),
  publishUiState: (state) => call("publish_ui_state", { state }),
  mcpStatus: () => call("mcp_status"),
  mcpSetEnabled: (on) => call("mcp_set_enabled", { on }),
  mcpSetPort: (port) => call("mcp_set_port", { port }),
  mcpClientAdd: (name) => call("mcp_client_add", { name }),
  mcpClientRevoke: (name) => call("mcp_client_revoke", { name }),
  mcpPolicySet: (context, policy, namespaces) => call("mcp_policy_set", { context, policy, namespaces }),
  mcpAuditTail: (limit) => call("mcp_audit_tail", { limit }),
};
