// Mock of AgentsBackend (contract/agents.ts). Owner H. The proposal state machine follows Rust's
// proposals.rs (§2.6) closely enough to drive the approval UI in a browser; `mockPropose` is what
// the dev-only `window.__knsMock.agent.propose` and H2's `:mcp demo` call. The MCP part follows
// mcp/mod.rs, policy.rs and scope.rs: `mockMcpCall` plays one tool call as a client.
import { cleanUntrusted } from "../../ui/untrusted";
import type {
  AgentShowView,
  AgentsBackend,
  ApprovalChoices,
  AuditRow,
  Backend,
  BackendError,
  DevForward,
  DevSet,
  DevSetDraft,
  EnvOverride,
  EnvSpec,
  Forward,
  Gvr,
  Json,
  McpPolicy,
  McpStatus,
  ObjRef,
  Proposal,
  ProposalPayload,
  Rewrite,
  UiState,
} from "../types";
import { devMock, mockDevSet, mockSaveDevSet } from "./dev";
import { emitMock } from "./events";
import { delay, mockContextFlags, mockForwards, mockId, nowIso } from "./shared";

const PENDING_MS = 10 * 60_000;
const REVIEW_CAP_MS = 30 * 60_000;

const proposals = new Map<string, Proposal>();
const policies = new Map<string, { policy: McpPolicy; namespaces?: string[] }>();
const clients = new Map<string, { createdAt: string; lastUsedAt?: string; calls: number; bytes?: number; redactions?: number }>();
const audit: AuditRow[] = [];
let uiState: UiState = { marked: [], connected: [] };
let status: { on: boolean; port: number; error?: string } = { on: false, port: 7099 };
/** Ports the mock pretends another program holds, so the "port in use" path is reachable. */
const TAKEN_PORTS = new Set([7100]);

const err = (reason: string, message: string, code = 0): BackendError => ({ code, reason, message });
const reject = (reason: string, message: string, code = 0) => Promise.reject(err(reason, message, code));
const pendingCount = () => [...proposals.values()].filter((p) => p.state === "pending" || p.state === "reviewing").length;
const changed = () => emitMock({ type: "proposals", pending: pendingCount() });

/** Lazy expiry, as in Rust: no timers. */
function expire(now = Date.now()): void {
  for (const p of proposals.values()) {
    if ((p.state === "pending" || p.state === "reviewing") && Date.parse(p.expiresAt) <= now) {
      Object.assign(p, { state: "expired", resolvedAt: nowIso(), result: { message: "the human did not answer in time" } });
    }
  }
}

/** Kinds that are tier 2 by themselves (the dialog asks to type the name). */
function expectedTyped(p: Proposal, choices: ApprovalChoices): string | null {
  const flags = mockContextFlags(p.context);
  if ((choices.includeSecrets ?? []).length > 0) {
    if (p.payload.kind === "envExport") return p.payload.spec.workload.name;
    if (p.payload.kind === "devSetUp") return mockDevSet(p.payload.devSet)?.env?.workload.name ?? p.context;
  }
  const tier2 = p.payload.kind === "apply" && ["roles", "rolebindings", "secrets", "serviceaccounts"].includes(p.payload.parsed.gvr.resource);
  return flags.protected || tier2 ? p.context : null;
}

function contextOf(payload: ProposalPayload, fallback: string): string {
  switch (payload.kind) {
    case "forward":
    case "apply":
      return payload.context;
    case "scale":
    case "restart":
    case "delete":
    case "reconcile":
      return payload.ref.context;
    case "devSetUp":
    case "devSetDelete":
    case "devSetUpdate":
      return mockDevSet(payload.devSet)?.context ?? fallback;
    default:
      return fallback;
  }
}

/** Creates a pending proposal as `client` (one pending per client, like Rust). */
export function mockPropose(client: string, payload: ProposalPayload, reason?: string, context = "default"): Proposal {
  expire();
  if ([...proposals.values()].some((p) => p.client === client && (p.state === "pending" || p.state === "reviewing"))) {
    throw err("RateLimited", `${client} already has a proposal waiting for the human`);
  }
  const now = Date.now();
  const p: Proposal = {
    id: mockId("p"),
    client,
    context: contextOf(payload, context),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PENDING_MS).toISOString(),
    state: "pending",
    reason: reason === undefined ? undefined : cleanUntrusted(reason, 500),
    payload,
  };
  proposals.set(p.id, p);
  const known = clients.get(client) ?? { createdAt: nowIso(), calls: 0 };
  clients.set(client, { ...known, lastUsedAt: nowIso(), calls: known.calls + 1 });
  audit.push({ ts: nowIso(), client, tool: `propose_${payload.kind}`, resultBytes: 64, redactions: 0, outcome: "ok", proposalId: p.id, ms: 3 });
  changed();
  return p;
}

function get(id: string): Proposal | BackendError {
  expire();
  return proposals.get(id) ?? err("NotFound", `proposal ${id} not found`, 404);
}

// ───────────────────────── MCP server ─────────────────────────

/** The tool table the real server serves (names and summaries; the full text lives in describe.rs). */
const MOCK_TOOLS: McpStatus["tools"] = [
  ["get_status", "Status", "Start here: what kns is connected to and what you may do in each context."],
  ["get_selection", "Selection", 'The object the human is looking at in kns right now: use it when they say "this pod" or "this service".'],
  ["list_resources", "List resources", "Table rows of one kind as kns shows them (the columns kubectl prints)."],
  ["get_object", "Get object", "One object as YAML or JSON, with managedFields stripped."],
  ["describe_object", "Describe object", "A kubectl-describe-like summary of one object: metadata, status, conditions, containers and recent events."],
  ["list_events", "List events", "Kubernetes events of one object (`ref`) or of a namespace, newest first."],
  ["get_logs", "Get logs", "Log lines of a pod's container (or of the first pod behind a workload or Service)."],
  ["explain_why", "Explain why", "Why an object is broken or not ready: deterministic findings with verbatim evidence (status, events, log lines)."],
  ["get_timeline", "Timeline", "What happened to an object, in order: events, restarts, rollouts and state changes in the last `sinceMinutes`."],
  ["get_service_info", "Service info", "A Service's ports, ready endpoints, backing workload and detected kind (HTTP, Postgres, Kafka listeners …)."],
  ["get_workload_dependencies", "Workload dependencies", "What a workload talks to inside the cluster, how a local process would reach each dependency, and the side effects of running it locally."],
  ["check_reach", "Check reach", "Can this pod reach that Service (or pod)? A static check of the chain: Service, port, endpoints, readiness, target port, the NetworkPolicies of both ends and DNS egress."],
  ["list_forwards", "List forwards", "Port-forwards kns is running in contexts you may see: target, local address and who owns each."],
  ["list_dev_sets", "List dev sets", "Saved dev sets (named groups of forwards plus an env export config) in contexts you may see."],
  ["get_proposal", "Get proposal", "The current state of one of your proposals and its result."],
  ["wait_proposal", "Wait for proposal", "Waits until your proposal changes state, or `timeoutSeconds` passes, then returns it."],
  ["make_pack", "Make pack", "A compact, redacted markdown bundle of up to 10 objects: diagnosis, YAML, events and log tails."],
  ["list_bundles", "List bundles", "Incident bundles captured by traps in contexts you may see (target, time)."],
].map(([name, title, description]) => ({ name, title, description }));

function mcpStatus(): McpStatus {
  const now = Date.now();
  return {
    ...status,
    clients: [...clients].map(([name, c]) => ({
      name,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
      connected: c.lastUsedAt !== undefined && now - Date.parse(c.lastUsedAt) < 5 * 60_000,
      calls: c.calls,
      bytes: c.bytes ?? c.calls * 512,
      redactions: c.redactions ?? 0,
    })),
    tools: MOCK_TOOLS,
    policies: [...policies].map(([context, p]) => ({ context, policy: p.policy, ...(p.namespaces ? { namespaces: p.namespaces } : {}) })),
  };
}

const emitStatus = () => emitMock({ type: "mcp", status: mcpStatus() });
const auditEvent = (client: string, tool: string, args?: Json) => audit.push({ ts: nowIso(), client, tool, args, resultBytes: 0, redactions: 0, outcome: "ok", ms: 0 });
const portTaken = (port: number) => `port ${port} is in use by another program; pick another with ":mcp port <n>"`;

type McpErr = { code: string; message: string; hint?: string };
export type MockCallResult = { ok: true; data: Json } | { ok: false; error: McpErr };
const RANK = { off: 0, read: 1, propose: 2 } as const;

/** The effective policy, as Rust computes it: read-only caps at read. */
export function mockEffectivePolicy(context: string): McpPolicy {
  const stored = policies.get(context)?.policy ?? "off";
  return mockContextFlags(context).readOnly && stored === "propose" ? "read" : stored;
}

function runTool(tool: string, args: Record<string, unknown>): MockCallResult {
  const ctx = typeof args.context === "string" ? args.context : uiState.context;
  const connected = uiState.connected ?? [];
  const deny = (need: "read" | "propose"): McpErr | null => {
    if (!ctx) return { code: "Invalid", message: "kns has no current context" };
    const p = mockEffectivePolicy(ctx);
    if (p === "off") return { code: "PolicyDenied", message: `agents may not use context "${ctx}"`, hint: `ask the human to run ":mcp policy read ${ctx}" in kns` };
    if (RANK[p] < RANK[need]) return { code: "PolicyDenied", message: `context "${ctx}" allows reading only`, hint: `ask the human to run ":mcp policy propose ${ctx}" in kns` };
    if (!connected.includes(ctx)) return { code: "NotConnected", message: `kns is not connected to context "${ctx}"` };
    return null;
  };
  switch (tool) {
    case "get_status": {
      const names = [...new Set([...policies.keys(), ...connected, ...(uiState.context ? [uiState.context] : [])])].sort();
      const shown = names.filter((n) => mockEffectivePolicy(n) !== "off");
      return {
        ok: true,
        data: {
          contexts: shown.map((n) => ({ name: n, current: n === uiState.context, connected: connected.includes(n), ...mockContextFlags(n), policy: mockEffectivePolicy(n) })),
          hiddenContexts: names.length - shown.length,
          ...(shown.length === 0 ? { hint: 'no context allows agents yet: ask the human to run ":mcp setup" in kns' } : {}),
        },
      };
    }
    case "get_selection": {
      const d = deny("read");
      if (d) return { ok: false, error: d };
      const ns = policies.get(ctx!)?.namespaces;
      const allowed = (r: { namespace?: string }) => !ns || (r.namespace !== undefined && ns.includes(r.namespace));
      return {
        ok: true,
        data: {
          context: ctx!,
          pane: uiState.pane ? { kind: uiState.pane.kind, title: cleanUntrusted(uiState.pane.title, 200) } : null,
          cursor: uiState.cursor && allowed(uiState.cursor) ? (uiState.cursor as unknown as Json) : null,
          marked: uiState.marked.filter(allowed) as unknown as Json,
          namespace: uiState.namespace ?? null,
        },
      };
    }
    default: {
      if (!MOCK_TOOLS.some((t) => t.name === tool)) return { ok: false, error: { code: "Invalid", message: `unknown tool "${cleanUntrusted(tool, 80)}"` } };
      const d = deny("read");
      if (d) return { ok: false, error: d };
      return { ok: false, error: { code: "NotAvailableYet", message: "the mock backend has no cluster data for this tool" } };
    }
  }
}

/**
 * One MCP tool call as `client` against the mock's state, with the policy, connection and scope
 * rules of policy.rs / scope.rs for get_status and get_selection ("not available" for the rest).
 * Records an audit row and an `agentActivity` event like the real server.
 */
export function mockMcpCall(client: string, tool: string, args: Record<string, unknown> = {}): MockCallResult {
  if (!status.on) return { ok: false, error: { code: "Unavailable", message: "the MCP server is off: turn it on with :mcp on" } };
  const known = clients.get(client);
  if (!known) return { ok: false, error: { code: "Unauthorized", message: "HTTP 401: unknown or revoked token" } };
  const started = Date.now();
  const res = runTool(tool, args);
  const bytes = JSON.stringify(res).length;
  clients.set(client, { ...known, lastUsedAt: nowIso(), calls: known.calls + 1, bytes: (known.bytes ?? known.calls * 512) + bytes });
  const outcome = res.ok ? "ok" : ["PolicyDenied", "NotConnected"].includes(res.error.code) ? "denied" : "error";
  audit.push({ ts: nowIso(), client, tool, args: Object.keys(args).length ? (args as Json) : undefined, resultBytes: bytes, redactions: 0, outcome, ms: Date.now() - started });
  emitMock({ type: "agentActivity", client, tool, at: nowIso(), ok: res.ok });
  emitStatus();
  return res;
}

export const agentsMock: AgentsBackend = {
  proposalsList: () => {
    expire();
    return delay([...proposals.values()].slice(-100).map((p) => ({ ...p })));
  },
  proposalClaim: (id) => {
    const p = get(id);
    if ("code" in p) return Promise.reject(p);
    if (p.state !== "pending") return reject("Conflict", `proposal is ${p.state}, not pending`, 409);
    p.state = "reviewing";
    p.expiresAt = new Date(Math.min(Date.now() + PENDING_MS, Date.parse(p.createdAt) + REVIEW_CAP_MS)).toISOString();
    changed();
    return delay({ ...p });
  },
  proposalUnclaim: (id) => {
    const p = get(id);
    if ("code" in p) return Promise.reject(p);
    if (p.state !== "reviewing") return reject("Conflict", `proposal is ${p.state}, not reviewing`, 409);
    p.state = "pending";
    changed();
    return delay({ ...p });
  },
  proposalApprove: (id, choices) => {
    const p = get(id);
    if ("code" in p) return Promise.reject(p);
    if (p.state !== "reviewing") return reject("Conflict", `proposal is ${p.state}, not reviewing`, 409);
    const flags = mockContextFlags(p.context);
    if (flags.readOnly) return reject("PolicyDenied", `context ${p.context} is read-only`);
    if (p.payload.kind === "devSetUp") {
      const set = mockDevSet(p.payload.devSet);
      if (!set || choices.shownHash !== set.hash) {
        Object.assign(p, { state: "expired", resolvedAt: nowIso(), result: { message: "the dev set changed while it was shown" } });
        changed();
        return reject("NeedsApproval", "the dev set changed; review it again");
      }
    }
    if (mockEffectivePolicy(p.context) !== "propose") return reject("PolicyDenied", `the agent policy for ${p.context} is not "propose"`);
    const typed = expectedTyped(p, choices);
    if (typed !== null && choices.typed !== typed) return reject("NeedsApproval", `type "${typed}" to approve`);
    // the gated commands of the other mocks read the choices from here (like Rust's ticket)
    return import("../mock").then((m) => {
      installMockGate(m.mockBackend);
      p.state = "executing";
      execs.set(p.id, { steps: mockSteps(p.payload), done: [], choices, inFlight: false });
      changed();
      return delay({ ...p });
    });
  },
  proposalResolve: (id, resolution) => {
    const p = get(id);
    if ("code" in p) return Promise.reject(p);
    if (resolution.kind === "rejected") {
      if (p.state !== "reviewing" && p.state !== "pending") return reject("Conflict", `proposal is ${p.state}`, 409);
      Object.assign(p, { state: "rejected", resolvedAt: nowIso(), result: { message: resolution.reason ? cleanUntrusted(resolution.reason, 500) : "rejected" } });
    } else {
      const e = execs.get(p.id);
      if (p.state !== "executing") return reject("Conflict", `proposal is ${p.state}`, 409);
      if (resolution.ok && e && e.done.length < e.steps.length) return reject("Conflict", "steps of this proposal have not run yet", 409);
      // like Rust (H3): a step holding a ticket reports its own outcome; after a finished step the
      // proposal ends approved with what ran and `data.<next step>.error`
      if (!resolution.ok && e?.inFlight) return reject("Conflict", "a step is still running and reports its own outcome", 409);
      if (!resolution.ok && e && e.done.length > 0) {
        const next = e.steps[e.done.length] ?? "next";
        const data = { ...Object.fromEntries(e.done), [next]: { error: resolution.error } };
        Object.assign(p, { state: "approved", resolvedAt: nowIso(), result: { data, message: `step "${next}" did not run; earlier steps stay in effect` } });
      } else {
        Object.assign(p, resolution.ok ? { state: "approved", resolvedAt: nowIso(), result: { data: Object.fromEntries(e?.done ?? []) } } : { state: "failed", resolvedAt: nowIso(), result: { error: resolution.error } });
      }
    }
    changed();
    return delay({ ...p });
  },
  publishUiState: (state) => {
    uiState = state;
    return delay(undefined, 0);
  },
  mcpStatus: () => delay(mcpStatus()),
  mcpSetEnabled: (on) => {
    const taken = on && TAKEN_PORTS.has(status.port);
    status = { ...status, on: on && !taken, error: taken ? portTaken(status.port) : undefined };
    auditEvent("kns", on ? "server on" : "server off", { port: status.port });
    const s = mcpStatus();
    emitMock({ type: "mcp", status: s });
    return delay(s);
  },
  mcpSetPort: (port) => {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return reject("Invalid", `port ${port} is outside 1024-65535`);
    const taken = status.on && TAKEN_PORTS.has(port);
    status = { ...status, port, on: status.on && !taken, error: taken ? portTaken(port) : undefined };
    emitStatus();
    return delay(mcpStatus());
  },
  mcpClientAdd: (name) => {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) return reject("Invalid", `invalid client name "${cleanUntrusted(name, 60)}": use 1-40 of A-Z a-z 0-9 . _ -`);
    const rekeyed = clients.has(name);
    clients.set(name, { createdAt: nowIso(), calls: 0 });
    auditEvent(name, rekeyed ? "token replaced" : "token added");
    emitStatus();
    return delay({ copied: true as const, excluded: true });
  },
  mcpSkillInstall: (token) => {
    if (token) {
      const rekeyed = clients.has("kns-cli");
      clients.set("kns-cli", { createdAt: nowIso(), calls: 0 });
      auditEvent("kns-cli", rekeyed ? "token replaced" : "token added");
      auditEvent("kns-cli", "cli token written");
    }
    auditEvent("kns", "agent skill installed", { path: "~/.claude/skills/kns/SKILL.md" });
    emitStatus();
    return delay({ path: "/home/you/.claude/skills/kns/SKILL.md", cli: "/opt/kns/kns-mcp", cliFound: true, token });
  },
  mcpClientRevoke: (name) => {
    if (!clients.has(name)) return reject("NotFound", `no MCP client named "${name}"`, 404);
    clients.delete(name);
    auditEvent(name, "token revoked");
    for (const p of proposals.values()) {
      if (p.client === name && (p.state === "pending" || p.state === "reviewing")) {
        Object.assign(p, { state: "cancelled", resolvedAt: nowIso(), result: { message: "the client's token was revoked" } });
      }
    }
    changed();
    emitStatus();
    return delay(undefined);
  },
  mcpPolicySet: (context, policy, namespaces) => {
    if (namespaces?.some((n) => !/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(n))) return reject("Invalid", "invalid namespace");
    const before = policies.get(context)?.policy ?? "off";
    const ns = namespaces && namespaces.length ? [...new Set(namespaces)].sort() : undefined;
    if (policy === "off" && !ns) policies.delete(context);
    else policies.set(context, { policy, namespaces: ns });
    auditEvent("kns", "policy", { context, policy, ...(ns ? { namespaces: ns } : {}) });
    const rank = { off: 0, read: 1, propose: 2 } as const;
    if (rank[policy] < rank[before]) {
      for (const p of proposals.values()) {
        if (p.context === context && (p.state === "pending" || p.state === "reviewing")) {
          Object.assign(p, { state: "cancelled", resolvedAt: nowIso(), result: { message: `policy for ${context} was lowered to ${policy}` } });
        }
      }
      changed();
    }
    emitStatus();
    return delay(undefined);
  },
  mcpAuditTail: (limit) => delay(audit.slice(-limit).reverse()),
};

/** The last UI state the frontend published (what `get_selection` would answer). */
export const mockUiState = (): UiState => uiState;

// ───────────────────────── H2: the mock gate ─────────────────────────
//
// Rust (proposals.rs) runs each step of an approved proposal through a gated command that takes
// the owner and the ticked secret keys from the stored choices, records the step, and ends the
// proposal after the last step (or the first failure) with `result.data` built from its own
// records. The other mocks (dev, fwd, base mutations) ignore `proposalId`, so this wraps those
// methods on the composed mock backend once, at the first approval: with a `proposalId` they gate,
// apply the choices and record the step; without one they are untouched.

interface Exec {
  steps: string[];
  done: [string, Json][];
  choices: ApprovalChoices;
  inFlight: boolean;
}
const execs = new Map<string, Exec>();

export function mockSteps(payload: ProposalPayload): string[] {
  switch (payload.kind) {
    case "devSetUp":
      return payload.exportEnv ? ["up", "export"] : ["up"];
    case "envExport":
      return ["export"];
    case "devSetDelete":
      return ["delete"];
    case "devSetUpdate":
      return ["update"];
    default:
      return [payload.kind];
  }
}

function mockGate(id: string, step: string): { p: Proposal; e: Exec } {
  const p = get(id);
  if ("code" in p) throw p;
  const e = execs.get(id);
  if (p.state !== "executing" || !e) throw err("Conflict", `proposal ${id} is ${p.state}, not executing (approve it in kns first)`, 409);
  const next = e.steps[e.done.length];
  if (next !== step) throw err("Conflict", `proposal ${id}: the next step is "${next ?? ""}", not "${step}"`, 409);
  if (e.inFlight) throw err("Conflict", `proposal ${id}: step "${step}" is already running`, 409);
  if (mockContextFlags(p.context).readOnly || mockEffectivePolicy(p.context) !== "propose") {
    Object.assign(p, { state: "cancelled", resolvedAt: nowIso(), result: { message: "the context or the agent policy changed" } });
    changed();
    throw err("PolicyDenied", "the context or the agent policy changed");
  }
  e.inFlight = true;
  return { p, e };
}

function mockFinish(id: string, step: string, outcome: { ok: true; data: Json } | { ok: false; error: BackendError }): void {
  const p = proposals.get(id);
  const e = execs.get(id);
  if (!p || !e) return;
  e.inFlight = false;
  const data = () => Object.fromEntries(e.done) as Json;
  if (outcome.ok) {
    e.done.push([step, outcome.data]);
    if (e.done.length === e.steps.length) Object.assign(p, { state: "approved", resolvedAt: nowIso(), result: { data: data() } });
  } else if (e.done.length === 0) {
    Object.assign(p, { state: "failed", resolvedAt: nowIso(), result: { error: outcome.error } });
  } else {
    e.done.push([step, { error: outcome.error } as unknown as Json]);
    Object.assign(p, { state: "approved", resolvedAt: nowIso(), result: { data: data(), message: `step "${step}" failed; earlier steps stay in effect` } });
  }
  audit.push({ ts: nowIso(), client: p.client, tool: `proposal ${p.state}`, resultBytes: 0, redactions: 0, outcome: "ok", proposalId: id, ms: 0 });
  changed();
}

/** Runs `run` as step `step` of `id` (or untouched without an id). */
async function gated<T>(id: string | undefined, step: string, matches: (p: ProposalPayload) => boolean, run: (e: Exec | null) => Promise<T>, dataOf: (r: T) => Json): Promise<T> {
  if (!id) return run(null);
  const { p, e } = mockGate(id, step);
  if (!matches(p.payload)) {
    const error = err("Invalid", `the request does not match proposal ${id}`);
    mockFinish(id, step, { ok: false, error });
    throw error;
  }
  try {
    const r = await run(e);
    mockFinish(id, step, { ok: true, data: dataOf(r) });
    return r;
  } catch (x) {
    mockFinish(id, step, { ok: false, error: x as BackendError });
    throw x;
  }
}

/** Forwards a step started take their owner from the human's choice (default: the human). */
function ownForwards(ids: readonly string[], client: string, choices: ApprovalChoices): void {
  const owner: Forward["owner"] = choices.owner?.by === "agent" ? { by: "agent", client, idleStopMinutes: choices.owner.idleStopMinutes } : { by: "user" };
  for (const id of ids) {
    const f = mockForwards.get(id);
    if (f) mockForwards.set(id, { ...f, owner, requestedBy: client });
  }
  emitMock({ type: "forwards" });
}

let gateInstalled = false;
/** Wraps the gated methods of the composed mock backend (idempotent). Exported for tests. */
export function installMockGate(b: Backend): void {
  if (gateInstalled) return;
  gateInstalled = true;
  const o = {
    devSetUp: b.devSetUp, envExport: b.envExport, startForward: b.startForward, devSetDelete: b.devSetDelete, devSetSave: b.devSetSave,
    scale: b.scale, restart: b.restart, deleteObject: b.deleteObject, patchObject: b.patchObject, applyYaml: b.applyYaml,
  };
  const clientOf = (id: string) => proposals.get(id)?.client ?? "agent";
  b.devSetUp = (id, hash, pid) =>
    gated(
      pid,
      "up",
      (p) => p.kind === "devSetUp" && p.devSet === id && p.hash === hash,
      async (e) => {
        const fs = await o.devSetUp(id, hash);
        if (e && pid) ownForwards(fs.map((f) => f.id), clientOf(pid), e.choices);
        return fs;
      },
      (fs) => ({ forwards: fs.map((f) => ({ key: f.label ?? f.id, localPort: f.localPort })) }),
    );
  b.envExport = (req) => {
    if (!req.proposalId) return o.envExport(req);
    const pid = req.proposalId;
    return gated(
      pid,
      "export",
      (p) => p.kind === "envExport" || (p.kind === "devSetUp" && !!p.exportEnv),
      async (e) => {
        if (req.destination !== "file") throw err("Invalid", "an agent's export goes to a file chosen in the save dialog");
        const p = proposals.get(pid)!;
        const ticked = e?.choices.includeSecrets ?? [];
        let spec: EnvSpec | undefined;
        let devSet: string | undefined;
        if (p.payload.kind === "envExport") {
          spec = { ...p.payload.spec, includeSecrets: ticked };
          devSet = p.payload.devSet;
        } else if (p.payload.kind === "devSetUp") {
          const set = mockDevSet(p.payload.devSet);
          if (!set?.env) throw err("Invalid", "the dev set has no env");
          spec = { ...set.env, format: p.payload.exportEnv!.format, includeSecrets: ticked };
          devSet = set.id;
        }
        // everything from the approved payload and the choices, nothing from the request
        // the approval dialog already asked for the typed context name (the gate checks it); the
        // inner human-export check of a protected context is satisfied with the workload name
        return o.envExport({ devSet, spec, rewrites: [], destination: "file", context: p.context, confirmText: spec?.workload.name });
      },
      (r): Json => (r.cancelled ? { cancelled: true } : { keys: r.keys, secretKeys: r.secretKeys, path: r.path ?? null }),
    );
  };
  b.startForward = (q) =>
    gated(
      q.proposalId,
      "forward",
      (p) => p.kind === "forward" && p.context === q.context && JSON.stringify(p.target) === JSON.stringify(q.target) && String(p.remotePort) === String(q.remotePort),
      async (e) => {
        const f = await o.startForward({ ...q, proposalId: undefined });
        if (e && q.proposalId) ownForwards([f.id], clientOf(q.proposalId), e.choices);
        return f;
      },
      (f) => ({ localPort: f.localPort, address: f.address }),
    );
  b.devSetDelete = (id, pid) => gated(pid, "delete", (p) => p.kind === "devSetDelete" && p.devSet === id, () => o.devSetDelete(id), () => ({ deleted: true }));
  b.devSetSave = (draft, pid) =>
    gated(
      pid,
      "update",
      (p) => p.kind === "devSetUpdate" && p.devSet === draft.id && JSON.stringify(p.proposed.forwards) === JSON.stringify(draft.forwards),
      () => o.devSetSave(draft),
      (r) => ({ set: r.set.id }),
    );
  b.scale = (ref, n, pid) => gated(pid, "scale", (p) => p.kind === "scale" && p.ref.name === ref.name && p.replicas === n, () => o.scale(ref, n), () => ({ ok: true }));
  b.restart = (ref, pid) => gated(pid, "restart", (p) => p.kind === "restart" && p.ref.name === ref.name, () => o.restart(ref), () => ({ ok: true }));
  b.deleteObject = (ref, opts, pid) => gated(pid, "delete", (p) => p.kind === "delete" && p.ref.name === ref.name, () => o.deleteObject(ref, opts), () => ({ ok: true }));
  b.patchObject = (ref, patch, type, sub, pid) =>
    gated(pid, "reconcile", (p) => p.kind === "reconcile" && p.ref.name === ref.name, () => o.patchObject(ref, patch, type, sub), () => ({ ok: true }));
  b.applyYaml = (ctx, yaml, opts, pid) => gated(pid, "apply", (p) => p.kind === "apply" && p.yaml === yaml, () => o.applyYaml(ctx, yaml, opts), () => ({ ok: true }));
}

// ───────────────────────── H2: the mock MCP tools ─────────────────────────

const H2_TOOLS: McpStatus["tools"] = [
  ["show_in_kns", "Show in kns", "Opens a view in the kns window beside what the human is looking at, labelled AGENT, without taking focus."],
  ["draft_dev_set_from_workload", "Draft dev set", 'Builds an unsaved dev set for running a workload locally, the way the human\'s own "dev from workload" does.'],
  ["save_dev_set", "Save dev set", "Saves a dev set (named forwards plus an env export config) as yours. Saving starts nothing, so it needs no approval."],
  ["delete_dev_set", "Delete dev set", "Deletes a dev set you created that was never approved, at once."],
  ["stop_dev_set", "Stop dev set", "Stops the forwards of a dev set that your approved proposal started."],
  ["propose_dev_set_up", "Propose dev set up", "Asks the human to start a saved dev set, optionally writing its env to a file, all in one approval."],
  ["propose_forward", "Propose forward", 'Asks the human to start one port-forward to 127.0.0.1 ("talk to X").'],
  ["propose_env_export", "Propose env export", "Asks the human to write a workload's environment to a file they pick in a save dialog, without starting forwards."],
  ["propose_scale", "Propose scale", "Asks the human to scale a Deployment, StatefulSet or ReplicaSet to `replicas`."],
  ["propose_restart", "Propose restart", "Asks the human to roll out a restart of a Deployment, StatefulSet or DaemonSet."],
  ["propose_delete", "Propose delete", "Asks the human to delete one namespaced object."],
  ["propose_reconcile", "Propose reconcile", "Asks the human to make Flux reconcile an object now."],
  ["propose_apply", "Propose apply", "Asks the human to apply one YAML document (server-side apply)."],
  ["cancel_proposal", "Cancel proposal", "Withdraws one of your proposals while it is still `pending`."],
].map(([name, title, description]) => ({ name, title, description }));
MOCK_TOOLS.push(...H2_TOOLS);

type Args = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The rule of Rust's devset::agent_override_ok (side-effect keys only, plain values). */
export function mockAgentOverrideOk(key: string, value: string): boolean {
  const k = key.toUpperCase();
  const group = k.includes("GROUP_ID") || k.includes("CONSUMER_GROUP") || k.includes("APPLICATION_ID");
  const migration = k.includes("MIGRATE") || k === "SPRING_FLYWAY_ENABLED" || k === "SPRING_LIQUIBASE_ENABLED" || ((k.startsWith("FLYWAY_") || k.startsWith("LIQUIBASE_")) && k.endsWith("ENABLED"));
  return value.length <= 200 && /^[A-Za-z0-9._-]*$/.test(value) && (group || migration);
}

const G = (group: string, resource: string): Gvr => ({ group, version: "v1", resource });
const KINDS: Record<string, Gvr> = {
  pod: G("", "pods"), pods: G("", "pods"), po: G("", "pods"),
  service: G("", "services"), services: G("", "services"), svc: G("", "services"),
  deployment: G("apps", "deployments"), deployments: G("apps", "deployments"), deploy: G("apps", "deployments"), "deployments.apps": G("apps", "deployments"),
  statefulset: G("apps", "statefulsets"), statefulsets: G("apps", "statefulsets"), sts: G("apps", "statefulsets"), "statefulsets.apps": G("apps", "statefulsets"),
  kustomization: G("kustomize.toolkit.fluxcd.io", "kustomizations"), kustomizations: G("kustomize.toolkit.fluxcd.io", "kustomizations"),
};
const kindName = (g: Gvr): string => (g.group ? `${g.resource}.${g.group}` : g.resource);

function refIn(a: unknown, fallback: string | undefined): ObjRef | McpErr {
  const r = (a ?? {}) as Args;
  const gvr = KINDS[String(r.kind ?? "").toLowerCase()];
  if (!gvr) return { code: "Invalid", message: `unknown kind "${cleanUntrusted(String(r.kind ?? ""), 60)}"` };
  const name = str(r.name);
  if (!name) return { code: "Invalid", message: "invalid object name" };
  const context = str(r.context) ?? fallback;
  if (!context) return { code: "Invalid", message: "kns has no current context" };
  return { context, gvr, namespace: str(r.namespace), name };
}
const isErr = (v: unknown): v is McpErr => typeof v === "object" && v !== null && "code" in v && "message" in v && !("gvr" in v) && !("forwards" in v);

function access(ctx: string | undefined, need: "read" | "propose"): McpErr | null {
  if (!ctx) return { code: "Invalid", message: "kns has no current context" };
  const p = mockEffectivePolicy(ctx);
  if (p === "off") return { code: "PolicyDenied", message: `agents may not use context "${ctx}"`, hint: `ask the human to run ":mcp policy read ${ctx}" in kns` };
  if (RANK[p] < RANK[need]) return { code: "PolicyDenied", message: `context "${ctx}" allows reading only`, hint: `ask the human to run ":mcp policy propose ${ctx}" in kns` };
  if (!(uiState.connected ?? []).includes(ctx)) return { code: "NotConnected", message: `kns is not connected to context "${ctx}"`, hint: `ask the human to open "${ctx}" in kns` };
  return null;
}
function scopeOk(ctx: string, namespaces: readonly (string | undefined)[]): McpErr | null {
  const ns = policies.get(ctx)?.namespaces;
  if (!ns) return null;
  const bad = namespaces.find((n) => !n || !ns.includes(n));
  return bad === undefined && !namespaces.some((n) => !n) ? null : { code: "PolicyDenied", message: `namespace ${bad ?? "(cluster)"} is outside this context's allowlist`, hint: `allowed: ${ns.join(", ")}` };
}

function setArgOut(set: DevSet): Args {
  return {
    id: set.id,
    name: set.name,
    context: set.context,
    forwards: set.forwards.map((f) => ({
      key: f.key,
      target: { kind: f.target.kind === "workload" ? kindName(f.target.gvr) : f.target.kind, namespace: f.target.namespace, name: f.target.name },
      remotePort: f.remotePort,
      localPort: f.localPort,
      pin: f.pin,
      ...(f.label ? { label: f.label } : {}),
    })),
    rewrites: set.rewrites.map((r) => ({ service: r.match.service, namespace: r.match.namespace, port: r.match.port, forward: r.to.forward, ...(r.envKey ? { envKey: r.envKey } : {}) })),
    ...(set.env
      ? {
          env: {
            workload: { kind: kindName(set.env.workload.gvr), namespace: set.env.workload.namespace, name: set.env.workload.name },
            ...(set.env.container ? { container: set.env.container } : {}),
            ...(set.env.overrides ? { overrides: set.env.overrides } : {}),
            format: set.env.format,
          },
        }
      : {}),
  };
}

function draftIn(a: Args, context: string): DevSetDraft | McpErr {
  const allowed = new Set(["id", "name", "context", "forwards", "rewrites", "env"]);
  const extra = Object.keys(a).find((k) => !allowed.has(k));
  if (extra) return { code: "Invalid", message: `bad arguments: unknown field \`${cleanUntrusted(extra, 40)}\``, hint: "see the tool's input schema" };
  const forwards: DevForward[] = [];
  for (const f of (a.forwards as Args[] | undefined) ?? []) {
    const t = (f.target ?? {}) as Args;
    const kind = String(t.kind ?? "").toLowerCase();
    const where = { namespace: String(t.namespace), name: String(t.name) };
    let target: DevForward["target"];
    if (kind === "pod" || kind === "pods") target = { kind: "pod", ...where };
    else if (kind === "service" || kind === "services" || kind === "svc") target = { kind: "service", ...where };
    else if (KINDS[kind]?.group === "apps") target = { kind: "workload", gvr: KINDS[kind], ...where };
    else return { code: "Invalid", message: `cannot forward to kind "${cleanUntrusted(kind, 40)}"` };
    forwards.push({ key: String(f.key), target, remotePort: f.remotePort as number | string, localPort: Number(f.localPort), pin: f.pin !== false, ...(str(f.label) ? { label: String(f.label) } : {}) });
  }
  const rewrites: Rewrite[] = ((a.rewrites as Args[] | undefined) ?? []).map((r) => ({
    match: { service: String(r.service), namespace: String(r.namespace), port: Number(r.port) },
    to: { forward: String(r.forward) },
    ...(str(r.envKey) ? { envKey: String(r.envKey) } : {}),
  }));
  let env: EnvSpec | undefined;
  if (a.env) {
    const e = a.env as Args;
    if ("includeSecrets" in e) return { code: "Invalid", message: "bad arguments: unknown field `includeSecrets`", hint: "the human ticks secret keys in kns" };
    const w = (e.workload ?? {}) as Args;
    const gvr = KINDS[String(w.kind ?? "").toLowerCase()];
    if (!gvr) return { code: "Invalid", message: "the env workload kind is unknown" };
    const overrides = (e.overrides as EnvOverride[] | undefined) ?? undefined;
    const bad = overrides?.find((o) => !mockAgentOverrideOk(String(o.key), String(o.value)));
    if (bad) {
      return {
        code: "Invalid",
        message: `override ${cleanUntrusted(String(bad.key), 80)}: agents may only override consumer-group, Streams application and migration keys, with a plain value`,
        hint: "drop the override, or ask the human to set it in kns",
      };
    }
    env = { workload: { gvr, namespace: String(w.namespace), name: String(w.name) }, container: str(e.container), include: e.include as string[] | undefined, exclude: e.exclude as string[] | undefined, overrides, format: (str(e.format) as EnvSpec["format"]) ?? "dotenv" };
  }
  return { id: str(a.id), name: String(a.name ?? ""), context, forwards, rewrites, env, autoStart: false };
}

function propose(client: string, context: string, payload: ProposalPayload, reason: unknown): MockCallResult {
  try {
    const p = mockPropose(client, payload, str(reason), context);
    return {
      ok: true,
      data: { proposal: { id: p.id, state: "pending", kind: p.payload.kind, expiresAt: p.expiresAt }, next: "Tell the human to look at kns, then call wait_proposal with this id until the state is final." },
    };
  } catch (e) {
    const x = e as BackendError;
    return { ok: false, error: { code: x.reason, message: x.message, ...(x.reason === "RateLimited" ? { hint: "call wait_proposal on your open proposal, or cancel_proposal it" } : {}) } };
  }
}

const ownSet = (set: DevSet, client: string) => set.origin.by === "agent" && set.origin.client === client;
const failWith = (error: McpErr): MockCallResult => ({ ok: false, error });
const FINAL = ["approved", "rejected", "expired", "failed", "cancelled"];

async function runToolAsync(client: string, tool: string, args: Args): Promise<MockCallResult> {
  const cur = uiState.context;
  switch (tool) {
    case "get_workload_dependencies": {
      const ref = refIn(args.ref, cur);
      if (isErr(ref)) return failWith(ref);
      const d = access(ref.context, "read");
      if (d) return failWith(d);
      const report = await devMock.envResolve(ref, str(args.container));
      const rows = report.rows.map((r) => (r.source === "secret" || r.masked ? { key: r.key, source: r.source, from: r.from, masked: true, hits: r.hits } : r));
      return { ok: true, data: { container: report.container, rows, deps: report.deps, warnings: report.warnings, overrides: report.overrides } as unknown as Json };
    }
    case "list_dev_sets": {
      const sets = (await devMock.devSetsList(str(args.context))).filter((s) => !access(s.context, "read"));
      return { ok: true, data: { sets: sets.map((s) => ({ ...setArgOut(s), createdByYou: ownSet(s, client), approved: s.approvedHash === s.hash, origin: s.origin })) } as unknown as Json };
    }
    case "draft_dev_set_from_workload": {
      const ref = refIn(args.ref, cur);
      if (isErr(ref)) return failWith(ref);
      const d = access(ref.context, "propose");
      if (d) return failWith(d);
      const report = await devMock.envResolve(ref);
      const inc = args.include as string[] | undefined;
      const deps = report.deps.filter((x) => !inc || inc.includes(x.service.name));
      const set: DevSet = {
        id: "",
        name: String(args.name ?? ""),
        context: ref.context,
        forwards: deps.map((x) => x.suggestedForward),
        rewrites: deps.map((x) => x.suggestedRewrite),
        env: { workload: { gvr: ref.gvr, namespace: ref.namespace ?? "", name: ref.name }, container: report.container, ...(report.overrides.length ? { overrides: report.overrides } : {}), format: "dotenv" },
        autoStart: false,
        origin: { by: "user" },
        hash: "",
        updatedAt: nowIso(),
      };
      const out = setArgOut(set);
      delete out.id;
      return {
        ok: true,
        data: {
          set: out,
          warnings: [...report.warnings, ...deps.flatMap((x) => x.notes.map((n) => `${x.service.name}: ${n}`))],
          dependencies: deps.map((x) => ({ service: { namespace: x.service.namespace ?? null, name: x.service.name }, port: x.port, kind: x.kind, ready: x.ready, forward: x.suggestedForward.key, notes: x.notes })),
          secretKeys: report.rows.filter((r) => r.source === "secret").map((r) => r.key),
          next: "Show the human the forwards and warnings, adjust if they want less, then save_dev_set with `set`.",
        } as unknown as Json,
      };
    }
    case "save_dev_set": {
      const a = (args.set ?? {}) as Args;
      const ctx = str(a.context) ?? cur;
      const d = access(ctx, "propose");
      if (d) return failWith(d);
      const draft = draftIn(a, ctx!);
      if (isErr(draft)) return failWith(draft);
      const sc = scopeOk(ctx!, [...draft.forwards.map((f) => f.target.namespace), ...draft.rewrites.map((r) => r.match.namespace), ...(draft.env ? [draft.env.workload.namespace] : [])]);
      if (sc) return failWith(sc);
      const existing = draft.id ? mockDevSet(draft.id) : undefined;
      if (draft.id && !existing) return failWith({ code: "NotFound", message: `no dev set "${cleanUntrusted(draft.id, 60)}"`, hint: "list_dev_sets lists the ids" });
      if (existing && !ownSet(existing, client)) {
        if (args.asProposal !== true) {
          return failWith({ code: "NotOwner", message: `set "${existing.name}" was not created by you`, hint: "save a copy (omit `id`, pick a new `name`), or pass `asProposal: true` to ask the human to accept the change" });
        }
        const { approvedSnapshot: _s, ...snapshot } = existing;
        const proposed: DevSet = { ...existing, forwards: draft.forwards, rewrites: draft.rewrites, env: draft.env ? { ...draft.env, includeSecrets: existing.env?.includeSecrets } : undefined, approvedHash: undefined, approvedSnapshot: snapshot };
        return propose(client, existing.context, { kind: "devSetUpdate", devSet: existing.id, proposed }, args.reason);
      }
      try {
        const saved = mockSaveDevSet(draft, { by: "agent", client, at: nowIso() });
        return { ok: true, data: { set: setArgOut(saved.set), id: saved.set.id, approved: false, warnings: saved.warnings, next: `propose_dev_set_up with id "${saved.set.id}"` } as unknown as Json };
      } catch (e) {
        const x = e as BackendError;
        return failWith({ code: x.reason, message: x.message });
      }
    }
    case "delete_dev_set":
    case "stop_dev_set": {
      const set = mockDevSet(String(args.id ?? ""));
      if (!set) return failWith({ code: "NotFound", message: `no dev set "${cleanUntrusted(String(args.id ?? ""), 60)}"` });
      const d = access(set.context, "propose");
      if (d) return failWith(d);
      const running = [...mockForwards.values()].filter((f) => f.devSet === set.id);
      if (tool === "stop_dev_set") {
        if (running.length === 0) return { ok: true, data: { stopped: 0, note: "the set is not running" } };
        if (running.some((f) => f.requestedBy !== client)) return failWith({ code: "PolicyDenied", message: `the human started dev set ${set.name} themselves`, hint: 'ask the human to run ":dev down" in kns' });
        await devMock.devSetDown(set.id);
        return { ok: true, data: { stopped: running.length, id: set.id } };
      }
      if (ownSet(set, client) && !set.approvedHash && !set.approvedSnapshot) {
        await devMock.devSetDelete(set.id);
        return { ok: true, data: { deleted: true, id: set.id } };
      }
      return propose(client, set.context, { kind: "devSetDelete", devSet: set.id }, args.reason);
    }
    case "show_in_kns": {
      const view = String(args.view ?? "") as AgentShowView["view"];
      if (view === "devset") {
        const set = mockDevSet(String(args.devSet ?? ""));
        if (!set) return failWith({ code: "NotFound", message: "no such dev set" });
        const d = access(set.context, "read");
        if (d) return failWith(d);
        emitMock({ type: "agentShow", client, view: { view, devSet: set.id } });
      } else {
        if (!["describe", "yaml", "logs", "why", "timeline"].includes(view)) return failWith({ code: "Invalid", message: "unknown view" });
        const ref = refIn(args.ref, cur);
        if (isErr(ref)) return failWith(ref);
        const d = access(ref.context, "read");
        if (d) return failWith(d);
        emitMock({ type: "agentShow", client, view: { view, ref } });
      }
      return { ok: true, data: { shown: true } };
    }
    case "propose_dev_set_up": {
      const set = mockDevSet(String(args.id ?? ""));
      if (!set) return failWith({ code: "NotFound", message: `no dev set "${cleanUntrusted(String(args.id ?? ""), 60)}"`, hint: "list_dev_sets lists the ids" });
      const d = access(set.context, "propose");
      if (d) return failWith(d);
      const ee = args.exportEnv as { format?: EnvSpec["format"] } | undefined;
      if (ee && !set.env) return failWith({ code: "Invalid", message: `dev set ${set.name} has no env to export` });
      return propose(client, set.context, { kind: "devSetUp", devSet: set.id, hash: set.hash, ...(ee ? { exportEnv: { format: ee.format ?? "dotenv" } } : {}) }, args.reason);
    }
    case "propose_forward": {
      const ctx = str(args.context) ?? cur;
      const d = access(ctx, "propose");
      if (d) return failWith(d);
      const t = (args.target ?? {}) as Args;
      const where = { namespace: String(t.namespace), name: String(t.name) };
      const target = String(t.kind ?? "").toLowerCase() === "pod" ? { kind: "pod" as const, ...where } : { kind: "service" as const, ...where };
      return propose(client, ctx!, { kind: "forward", context: ctx!, target, remotePort: args.remotePort as number | string, ...(typeof args.localPort === "number" ? { localPort: args.localPort } : {}) }, args.reason);
    }
    case "propose_env_export": {
      if (!!args.devSet === !!args.ref) return failWith({ code: "Invalid", message: "give either `devSet` or `ref`" });
      const format = (str(args.format) as EnvSpec["format"]) ?? "dotenv";
      if (args.devSet) {
        const set = mockDevSet(String(args.devSet));
        if (!set?.env) return failWith({ code: "Invalid", message: "that dev set has no env" });
        const d = access(set.context, "propose");
        if (d) return failWith(d);
        return propose(client, set.context, { kind: "envExport", devSet: set.id, spec: { ...set.env, format, includeSecrets: undefined }, rewrites: set.rewrites }, args.reason);
      }
      const ref = refIn(args.ref, cur);
      if (isErr(ref)) return failWith(ref);
      const d = access(ref.context, "propose");
      if (d) return failWith(d);
      const overrides = args.overrides as EnvOverride[] | undefined;
      if (overrides?.some((o) => !mockAgentOverrideOk(o.key, o.value))) return failWith({ code: "Invalid", message: "agents may only override consumer-group, Streams application and migration keys, with a plain value" });
      return propose(client, ref.context, { kind: "envExport", spec: { workload: { gvr: ref.gvr, namespace: ref.namespace ?? "", name: ref.name }, container: str(args.container), overrides, format }, rewrites: [] }, args.reason);
    }
    case "propose_scale":
    case "propose_restart":
    case "propose_delete":
    case "propose_reconcile": {
      const ref = refIn(args.ref, cur);
      if (isErr(ref)) return failWith(ref);
      const d = access(ref.context, "propose");
      if (d) return failWith(d);
      const payload: ProposalPayload =
        tool === "propose_scale"
          ? { kind: "scale", ref, replicas: Number(args.replicas) }
          : tool === "propose_restart"
            ? { kind: "restart", ref }
            : tool === "propose_delete"
              ? { kind: "delete", ref }
              : { kind: "reconcile", ref, withSource: args.withSource === true };
      return propose(client, ref.context, payload, args.reason);
    }
    case "propose_apply": {
      const ctx = str(args.context) ?? cur;
      const d = access(ctx, "propose");
      if (d) return failWith(d);
      const yaml = String(args.yaml ?? "");
      if (/\n---\s*\n\s*\S/.test(`\n${yaml.trim()}\n`.replace(/^\n---\s*\n/, "\n"))) return failWith({ code: "Invalid", message: "propose_apply takes exactly one YAML document" });
      const field = (k: string) => yaml.match(new RegExp(`^\\s*${k}:\\s*(\\S+)`, "m"))?.[1];
      const kind = field("kind");
      const name = field("name");
      const namespace = field("namespace");
      if (!kind || !name) return failWith({ code: "Invalid", message: "the document has no kind or metadata.name" });
      if (!namespace) return failWith({ code: "Invalid", message: "the document has no metadata.namespace", hint: "set metadata.namespace explicitly" });
      if (["CustomResourceDefinition", "ValidatingWebhookConfiguration", "MutatingWebhookConfiguration", "ClusterRole", "ClusterRoleBinding", "Namespace"].includes(kind)) {
        return failWith({ code: "PolicyDenied", message: `agents cannot propose applying a ${kind}` });
      }
      const gvr = G(kind === "Deployment" || kind === "StatefulSet" ? "apps" : "", `${kind.toLowerCase()}s`);
      return propose(client, ctx!, { kind: "apply", context: ctx!, yaml, parsed: { gvr, namespace, name, dryRun: "ok" } }, args.reason);
    }
    case "get_proposal":
    case "wait_proposal":
    case "cancel_proposal": {
      const id = String(args.id ?? "");
      let p = proposals.get(id);
      if (!p || p.client !== client) return failWith({ code: "NotFound", message: `you have no proposal "${cleanUntrusted(id, 40)}"` });
      if (tool === "cancel_proposal") {
        if (p.state !== "pending") return failWith({ code: "Conflict", message: `proposal ${id} is ${p.state}, not pending` });
        Object.assign(p, { state: "cancelled", resolvedAt: nowIso(), result: { message: "withdrawn by the agent" } });
        changed();
      }
      if (tool === "wait_proposal") {
        const start = p.state;
        const until = Date.now() + Math.min(60, Math.max(1, Number(args.timeoutSeconds ?? 50))) * 1000;
        // polls only while the call waits (bounded by the timeout), like Rust
        while (p && p.state === start && !FINAL.includes(p.state) && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 250));
          expire();
          p = proposals.get(id);
        }
      }
      const out: Args = { proposal: { ...p! } };
      if (p && (p.state === "pending" || p.state === "reviewing")) out.hint = "the human has not decided yet: call wait_proposal again";
      return { ok: true, data: out as Json };
    }
    default:
      return runTool(tool, args);
  }
}

/** An MCP tool call as `client`, every tool of the table (async: some tools wait or read the mock cluster). */
export async function mockMcpCallAsync(client: string, tool: string, args: Args = {}): Promise<MockCallResult> {
  if (!status.on) return { ok: false, error: { code: "Unavailable", message: "the MCP server is off: turn it on with :mcp on" } };
  const known = clients.get(client);
  if (!known) return { ok: false, error: { code: "Unauthorized", message: "HTTP 401: unknown or revoked token" } };
  const started = Date.now();
  const res = await runToolAsync(client, tool, args);
  const bytes = JSON.stringify(res).length;
  const k = clients.get(client) ?? known;
  clients.set(client, { ...k, lastUsedAt: nowIso(), calls: k.calls + 1, bytes: (k.bytes ?? k.calls * 512) + bytes });
  const outcome = res.ok ? "ok" : ["PolicyDenied", "NotConnected"].includes(res.error.code) ? "denied" : "error";
  const pid = res.ok && tool.startsWith("propose") ? (res.data as { proposal?: { id?: string } } | null)?.proposal?.id : undefined;
  audit.push({ ts: nowIso(), client, tool, args: Object.keys(args).length ? (args as Json) : undefined, resultBytes: bytes, redactions: 0, outcome, ...(pid ? { proposalId: pid } : {}), ms: Date.now() - started });
  emitMock({ type: "agentActivity", client, tool, at: nowIso(), ok: res.ok });
  emitStatus();
  return res;
}

/**
 * `:mcp demo` setup: the server on, the client known, the current context at `propose`. Returns
 * what it changed, or null when nothing was needed.
 */
export async function mockDemoSetup(client: string): Promise<string | null> {
  const did: string[] = [];
  if (!status.on) {
    await agentsMock.mcpSetEnabled(true);
    did.push("MCP server on");
  }
  if (!clients.has(client)) {
    clients.set(client, { createdAt: nowIso(), calls: 0 });
    did.push(`client ${client} added`);
  }
  const ctx = uiState.context ?? "default";
  if (mockEffectivePolicy(ctx) !== "propose" && !mockContextFlags(ctx).readOnly) {
    await agentsMock.mcpPolicySet(ctx, "propose");
    did.push(`agents may propose in ${ctx}`);
  }
  emitStatus();
  return did.length ? `set up for the demo: ${did.join(", ")}` : null;
}
