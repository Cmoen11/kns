// Agents: UI state for MCP, proposals, MCP server status and audit (docs/plan-features.md §2.6, §5).
// Written by A1 (proposal model, store and gate are A1's in Rust); owner H.
// Rust mirror: src-tauri/src/contract/agents.rs. Drift fixtures: __fixtures__/agents.ts.
import type { BackendError, Gvr, Json, ObjRef } from "../types";
import type { DevSet, EnvFormat, EnvSpec, Rewrite } from "./dev";
import type { ForwardTarget, PortRef } from "./fwd";

/** What the human is looking at, published for MCP `get_selection` (H1). */
export interface UiState {
  context?: string;
  pane?: { kind: string; title: string };
  cursor?: ObjRef;
  marked: ObjRef[];
  filter?: string;
  namespace?: string;
  /** contexts the human connected in this session (agents may use only these, §5.4) */
  connected?: string[];
}

export type ProposalPayload =
  | { kind: "devSetUp"; devSet: string; hash: string; exportEnv?: { format: EnvFormat } }
  | { kind: "forward"; context: string; target: ForwardTarget; remotePort: PortRef; localPort?: number }
  /** destination is always a file */
  | { kind: "envExport"; devSet?: string; spec: EnvSpec; rewrites: Rewrite[] }
  | { kind: "devSetDelete"; devSet: string }
  /** agent change to a set it does not own */
  | { kind: "devSetUpdate"; devSet: string; proposed: DevSet }
  | { kind: "scale"; ref: ObjRef; replicas: number }
  | { kind: "restart"; ref: ObjRef }
  | { kind: "delete"; ref: ObjRef }
  | { kind: "reconcile"; ref: ObjRef; withSource: boolean }
  | { kind: "apply"; context: string; yaml: string; parsed: { gvr: Gvr; namespace: string; name: string; dryRun: "ok" | string } };

export type ProposalKind = ProposalPayload["kind"];

export type ProposalState = "pending" | "reviewing" | "executing" | "approved" | "rejected" | "expired" | "failed" | "cancelled";

/** What the human decided in the dialog. Rust stores it on the proposal; commands read it from there, never from their own args. */
export interface ApprovalChoices {
  /** devSetUp / forward: who owns the forwards afterwards */
  owner?: { by: "user" } | { by: "agent"; idleStopMinutes: number };
  /** envExport / devSetUp.exportEnv: secret-sourced keys the human ticked */
  includeSecrets?: string[];
  /** typed confirmation for tier 2; Rust compares it with the text it expects (context name, workload name) */
  typed?: string;
  /** the hash of the dev-set snapshot the dialog displayed */
  shownHash?: string;
}

export interface ProposalResult {
  message?: string;
  error?: BackendError;
  data?: Json;
}

export interface Proposal {
  id: string;
  client: string;
  context: string;
  createdAt: string;
  expiresAt: string;
  state: ProposalState;
  /** agent-written, untrusted, cleaned, max 500 chars */
  reason?: string;
  payload: ProposalPayload;
  /** built by Rust; never values */
  result?: ProposalResult;
  resolvedAt?: string;
}

export type ProposalResolution =
  | { kind: "rejected"; reason?: string }
  /** Rust builds result.data from its own records */
  | { kind: "done"; ok: true }
  | { kind: "done"; ok: false; error: BackendError };

export type McpPolicy = "off" | "read" | "propose";

export interface McpClient {
  /** the token's name; the identity used for policy, rate limits and audit */
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  /** token used in the last 5 min */
  connected: boolean;
  calls: number;
  bytes: number;
  redactions: number;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
}

export interface McpContextPolicy {
  context: string;
  policy: McpPolicy;
  /** namespace allowlist; absent = every namespace */
  namespaces?: string[];
}

export interface McpStatus {
  on: boolean;
  port: number;
  clients: McpClient[];
  tools: McpTool[];
  /** stored policy per context (contexts without an entry are `off`) */
  policies?: McpContextPolicy[];
  /** why the server is not running although it was turned on (port taken, ...) */
  error?: string;
}

export interface AuditRow {
  ts: string;
  client: string;
  tool: string;
  /** redacted, 1 KiB cap */
  args?: Json;
  resultBytes: number;
  redactions: number;
  outcome: "ok" | "error" | "denied";
  proposalId?: string;
  ms: number;
}

/** A view an agent asked kns to show (MCP `show_in_kns`, H2). */
export interface AgentShowView {
  view: "describe" | "yaml" | "logs" | "why" | "timeline" | "devset";
  ref?: ObjRef;
  devSet?: string;
}

/** The setup command (with the token) went to the clipboard; the token is shown nowhere. */
export interface McpClientAdded {
  copied: true;
  /** the clipboard entry is kept out of clipboard history (Windows); else it only clears after 120 s */
  excluded: boolean;
}

/** The Claude Code skill for the `kns-mcp` CLI was written (`mcp_skill_install`). */
export interface McpSkillInstalled {
  /** where SKILL.md was written (`~/.claude/skills/kns/SKILL.md`) */
  path: string;
  /** the `kns-mcp` the skill names */
  cli: string;
  /** `kns-mcp` exists there (false in a dev build that has not built it) */
  cliFound: boolean;
  /** a CLI token (client `kns-cli`) was created and written next to the MCP settings */
  token: boolean;
}

export interface AgentsBackend {
  proposalsList(): Promise<Proposal[]>;
  /** dialog opened: pending -> reviewing */
  proposalClaim(id: string): Promise<Proposal>;
  /** Esc / dialog closed: reviewing -> pending */
  proposalUnclaim(id: string): Promise<Proposal>;
  /** reviewing -> executing; Rust checks the choices and stores them with the step list */
  proposalApprove(id: string, choices: ApprovalChoices): Promise<Proposal>;
  /** reject, or report a webview-side failure before any step ran */
  proposalResolve(id: string, resolution: ProposalResolution): Promise<Proposal>;
  publishUiState(state: UiState): Promise<void>;
  mcpStatus(): Promise<McpStatus>;
  mcpSetEnabled(on: boolean): Promise<McpStatus>;
  mcpSetPort(port: number): Promise<McpStatus>;
  /** Rust copies the setup command through clip.rs; the token never reaches the webview. */
  mcpClientAdd(name: string): Promise<McpClientAdded>;
  mcpClientRevoke(name: string): Promise<void>;
  /** Writes the Claude Code skill for the CLI; with `token`, also a CLI token only `kns-mcp` reads. The token never reaches the webview. */
  mcpSkillInstall(token: boolean): Promise<McpSkillInstalled>;
  mcpPolicySet(context: string, policy: McpPolicy, namespaces?: string[]): Promise<void>;
  mcpAuditTail(limit: number): Promise<AuditRow[]>;
}
