// Live status lines the hub hosts itself (docs/plan-features.md §2.10): the basics it documents
// (logs, shell, port-forward) and a fallback for the MCP server until H1 registers its own. A
// feature's registerToolStatus always wins over these. No timers: stores and backend events only.
import { useSyncExternalStore } from "react";
import { backend, currentView, useWorkspace } from "../foundation";
import type { McpStatus } from "../ipc/types";
import { useForwards } from "../views/shell/forwards";
import { toolStatusHook, type ToolId, type ToolStatus, type ToolStatusHook } from "./catalog";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Panes whose current view is one of `kinds` (a primitive, so other layout changes re-render nothing). */
function usePaneCount(kinds: readonly string[]): number {
  return useWorkspace((ws) => {
    if (!ws) return 0;
    let n = 0;
    for (const p of Object.values(ws.panes)) if (kinds.includes(currentView(p).kind)) n++;
    return n;
  });
}

const useLogsStatus: ToolStatusHook = () => {
  const n = usePaneCount(["logs"]);
  return n ? { text: `${plural(n, "pane")} open`, state: "active" } : null;
};
const useShellStatus: ToolStatusHook = () => {
  const n = usePaneCount(["shell", "attach"]);
  return n ? { text: `${plural(n, "session")} open`, state: "active" } : null;
};
const usePfStatus: ToolStatusHook = () => {
  const n = useForwards((s) => s.list.length);
  const broken = useForwards((s) => s.list.filter((f) => f.status === "error").length);
  if (broken) return { text: `${n} running · ${broken} broken`, state: "warn" };
  return n ? { text: `${n} running`, state: "active" } : null;
};

// MCP: one fetch on first use, then the backend's `mcp` events
let mcp: McpStatus | null = null;
let mcpStarted = false;
const mcpSubs = new Set<() => void>();
const setMcp = (s: McpStatus) => {
  mcp = s;
  for (const fn of [...mcpSubs]) fn();
};
function startMcp(): void {
  if (mcpStarted) return;
  mcpStarted = true;
  backend.onEvent((e) => {
    if (e.type === "mcp") setMcp(e.status);
  });
  backend.mcpStatus().then(setMcp, () => {});
}
/** The MCP server's status, live (null until the first answer). */
export function useMcpStatus(): McpStatus | null {
  startMcp();
  return useSyncExternalStore(
    (fn) => {
      mcpSubs.add(fn);
      return () => mcpSubs.delete(fn);
    },
    () => mcp,
  );
}
/** Re-reads the server status (the hub's MCP detail does it when shown). */
export const refreshMcpStatus = (): void => {
  startMcp();
  backend.mcpStatus().then(setMcp, () => {});
};

export function mcpStatusLine(s: McpStatus | null): ToolStatus | null {
  if (!s) return null;
  if (!s.on) return { text: "off", state: "off" };
  return { text: `on · 127.0.0.1:${s.port} · ${plural(s.clients.length, "client")}`, state: "ok" };
}
const useMcpLine: ToolStatusHook = () => mcpStatusLine(useMcpStatus());

/** The hub's own status hooks, used when no feature registered one for that tool. */
export const HUB_STATUS: Readonly<Partial<Record<ToolId, ToolStatusHook>>> = {
  logs: useLogsStatus,
  shell: useShellStatus,
  "port-forward": usePfStatus,
  mcp: useMcpLine,
};

/** The hook that reports `id`'s status: the feature's, else the hub's fallback. */
export const statusHookOf = (id: ToolId): ToolStatusHook | undefined => toolStatusHook(id) ?? HUB_STATUS[id];
