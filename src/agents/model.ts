// Pure logic of the agents feature (docs/plan-features.md §3 H1, §5): the `:mcp` command words,
// the status line, the rows of the agents view and the published UI state. No stores, no DOM.
import type { AuditRow, McpClient, McpContextPolicy, McpPolicy, McpStatus, ObjRef, UiState } from "../ipc/types";
import type { ToolStatus } from "../hub/catalog";

export type McpCommand =
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "setup" }
  | { kind: "status" }
  | { kind: "demo" }
  | { kind: "add"; name: string }
  | { kind: "revoke"; name: string }
  | { kind: "port"; port: number }
  | { kind: "policy"; policy: McpPolicy; context?: string; namespaces?: string[] }
  | { kind: "error"; message: string };

export const MCP_USAGE = ":mcp on | off | setup | status | add <name> | revoke <name> | port <n> | policy off|read|propose [context] [ns,ns…]";

export const CLIENT_NAME = /^[A-Za-z0-9._-]{1,40}$/;
const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** Parses the words after `:mcp`. No words = setup (the one command a newcomer needs). */
export function parseMcpArgs(args: readonly string[]): McpCommand {
  const [verb = "setup", ...rest] = args;
  switch (verb) {
    case "on":
    case "off":
    case "setup":
    case "status":
    case "demo":
      return rest.length ? { kind: "error", message: `":mcp ${verb}" takes no arguments` } : { kind: verb };
    case "add":
    case "revoke": {
      const name = rest[0] ?? "";
      if (rest.length !== 1 || !CLIENT_NAME.test(name)) return { kind: "error", message: `usage: :mcp ${verb} <name>  (1-40 of A-Z a-z 0-9 . _ -)` };
      return { kind: verb, name };
    }
    case "port": {
      const port = Number(rest[0]);
      if (rest.length !== 1 || !Number.isInteger(port) || port < 1024 || port > 65535) return { kind: "error", message: "usage: :mcp port <1024-65535>" };
      return { kind: "port", port };
    }
    case "policy": {
      const [policy, context, ns] = rest;
      if (policy !== "off" && policy !== "read" && policy !== "propose") return { kind: "error", message: "usage: :mcp policy off|read|propose [context] [ns,ns…]" };
      if (rest.length > 3) return { kind: "error", message: "usage: :mcp policy off|read|propose [context] [ns,ns…]" };
      const namespaces = ns ? ns.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const bad = namespaces?.find((n) => !NAMESPACE.test(n));
      if (bad) return { kind: "error", message: `"${bad}" is not a namespace name` };
      return { kind: "policy", policy, ...(context ? { context } : {}), ...(namespaces?.length ? { namespaces } : {}) };
    }
    default:
      return { kind: "error", message: `unknown ":mcp ${verb}"; ${MCP_USAGE}` };
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The hub's status line for the MCP tool: `on · 127.0.0.1:7099 · 1 client`. */
export function statusLine(s: McpStatus | null): ToolStatus | null {
  if (!s) return null;
  if (s.error) return { text: `off · ${s.error}`, state: "warn" };
  if (!s.on) return { text: "off", state: "off" };
  const live = s.clients.filter((c) => c.connected).length;
  const clients = live ? `${plural(live, "client")} connected` : plural(s.clients.length, "client");
  return { text: `on · 127.0.0.1:${s.port} · ${clients}`, state: live ? "active" : "ok" };
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** `connected · 12 calls · 3.1 KB · redacted 2 · used 10:01` */
export function clientDetail(c: McpClient, clock: (iso: string) => string): string {
  const parts = [c.connected ? "connected" : "idle", plural(c.calls, "call"), bytes(c.bytes)];
  if (c.redactions) parts.push(`redacted ${c.redactions}`);
  parts.push(c.lastUsedAt ? `used ${clock(c.lastUsedAt)}` : "never used");
  return parts.join(" · ");
}

/** `propose · namespaces a, b` */
export function policyText(p: McpPolicy, namespaces?: readonly string[]): string {
  return namespaces?.length ? `${p} · namespaces ${namespaces.join(", ")}` : p;
}

export function policyOf(s: McpStatus | null, context: string): McpContextPolicy {
  return s?.policies?.find((p) => p.context === context) ?? { context, policy: "off" };
}

/** Contexts the policy section lists: every kube context plus any with a stored policy. */
export function policyContexts(contexts: readonly string[], s: McpStatus | null): string[] {
  const names = new Set(contexts);
  for (const p of s?.policies ?? []) names.add(p.context);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** One audit row as list cells: `10:01:02  claude-code  get_logs` / `ok · 12 ms · 2 KB`. */
export function auditCells(r: AuditRow, clock: (iso: string) => string): [string, string] {
  const detail = r.resultBytes || r.ms ? `${r.outcome} · ${r.ms} ms · ${bytes(r.resultBytes)}` : r.outcome;
  return [`${clock(r.ts)}  ${r.client}  ${r.tool}`, r.redactions ? `${detail} · redacted ${r.redactions}` : detail];
}

export const auditGlyph = (r: AuditRow): "ok" | "warn" | "error" => (r.outcome === "ok" ? "ok" : r.outcome === "denied" ? "warn" : "error");

/** What the UI publishes for `get_selection`. Capped and plain; Rust filters and redacts it. */
export interface UiStateInput {
  context: string | null;
  connected: readonly string[];
  pane: { kind: string; title: string } | null;
  cursor: ObjRef | null;
  marked: readonly ObjRef[];
  filter?: string;
  namespace?: string;
}

export function buildUiState(i: UiStateInput): UiState {
  const out: UiState = { marked: i.marked.slice(0, 200), connected: [...i.connected] };
  if (i.context) out.context = i.context;
  if (i.pane) out.pane = { kind: i.pane.kind, title: i.pane.title.slice(0, 200) };
  if (i.cursor) out.cursor = i.cursor;
  if (i.filter) out.filter = i.filter.slice(0, 200);
  if (i.namespace) out.namespace = i.namespace;
  return out;
}

/** Same content (so an unchanged state is not published again). */
export const sameUiState = (a: UiState | null, b: UiState): boolean => a !== null && JSON.stringify(a) === JSON.stringify(b);
