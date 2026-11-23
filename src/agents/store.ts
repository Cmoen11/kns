// Live MCP state for the agents feature: the server status (one fetch, then the backend's `mcp`
// events), the audit tail (fetched while the agents view shows it, and on `agentActivity`
// events), and the contexts the human connected in this session. No timers.
import { useSyncExternalStore } from "react";
import { backend } from "../foundation";
import { clusterStore } from "../store/cluster";
import type { AuditRow, McpStatus } from "../ipc/types";

type Listener = () => void;

function cell<T>(initial: T) {
  let value = initial;
  const subs = new Set<Listener>();
  return {
    get: () => value,
    set: (v: T) => {
      value = v;
      for (const fn of [...subs]) fn();
    },
    subscribe: (fn: Listener) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}

const status = cell<McpStatus | null>(null);
const audit = cell<readonly AuditRow[]>([]);
const connected = cell<readonly string[]>([]);
/** the last agent call, for the activity group (client → tool, time, ok) */
const activity = cell<ReadonlyMap<string, { tool: string; at: number; ok: boolean }>>(new Map());

let started = false;
let auditWatchers = 0;

/** Starts listening (idempotent). Called from register(). */
export function startAgentsStore(): void {
  if (started) return;
  started = true;
  backend.onEvent((e) => {
    if (e.type === "mcp") {
      status.set(e.status);
      // token add/revoke and policy changes are audit rows too
      if (auditWatchers > 0) refreshAudit();
    } else if (e.type === "agentActivity") {
      const next = new Map(activity.get());
      next.set(e.client, { tool: e.tool, at: Date.parse(e.at) || Date.now(), ok: e.ok });
      activity.set(next);
      if (auditWatchers > 0) refreshAudit();
    }
  });
  refreshStatus();
  // contexts the human connected in this session (agents may use only these, §5.4)
  const note = () => {
    const s = clusterStore.getState();
    // the window's context and every context a pane of the human's connected (§8.3)
    const now = Object.entries(s.conns).filter(([, c]) => c.status === "connected").map(([name]) => name);
    if (s.status === "connected" && s.context) now.push(s.context);
    const add = now.filter((n, i) => now.indexOf(n) === i && !connected.get().includes(n));
    if (add.length > 0) connected.set([...connected.get(), ...add]);
  };
  clusterStore.subscribe(note);
  note();
}

export function refreshStatus(): void {
  backend.mcpStatus().then(status.set, () => {});
}

export function refreshAudit(): void {
  backend.mcpAuditTail(200).then(audit.set, () => {});
}

export const getMcpStatus = (): McpStatus | null => status.get();
export const setMcpStatus = (s: McpStatus): void => status.set(s);
export const connectedContexts = (): readonly string[] => connected.get();
export const subscribeConnected = connected.subscribe;

export const useMcpStatus = (): McpStatus | null => useSyncExternalStore(status.subscribe, status.get);
export const useAudit = (): readonly AuditRow[] => useSyncExternalStore(audit.subscribe, audit.get);
export const useAgentActivity = () => useSyncExternalStore(activity.subscribe, activity.get);

/** The agents view keeps the audit tail fresh while it is mounted. */
export function watchAudit(): () => void {
  auditWatchers++;
  refreshAudit();
  return () => void auditWatchers--;
}
