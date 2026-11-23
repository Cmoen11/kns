// Feature: agents (docs/plan-features.md §3 H1, H2, §5). H1: agents view, `:mcp`, the connect
// wizard, the Agents activity group, the UI-state publisher, the MCP status hook. H2: agent
// requests (proposals): the Agent requests activity group, the bottom-row `agent N` item, the
// review dialog and executor, `show_in_kns` panes, agent drafts and the `:mcp demo` agent.
import { createElement, useMemo } from "react";
import { engine, openView, registerOverlay, registerShellItem, registerView } from "../foundation";
import { registerTool, registerToolStatus } from "../hub/catalog";
import { actionTip, keepFocus } from "../ui";
import { cleanUntrusted } from "../ui/untrusted";
import { registerActivityGroup, type GroupRows } from "../sidepanels/groups";
import type { PanelRow } from "../sidepanels/model";
import { CONNECT_OVERLAY, POLICY_OVERLAY, PORT_OVERLAY, REVOKE_OVERLAY, setServer } from "./actions";
import { statusLine } from "./model";
import { startUiStatePublisher } from "./publish";
import { startAgentsStore, useAgentActivity, useMcpStatus } from "./store";
import { REVIEW_OVERLAY, review, reviewingId } from "./approve";
import { startAgentDrafts } from "./drafts";
import { askText, isOpen, titleText, waitingCount } from "./proposal-model";
import { refreshProposals, startProposals, useProposals } from "./proposals";
import { startShowHandler } from "./show";
import { devSetById } from "../dev/store";
import { backend } from "../foundation";

const NO_ROWS: GroupRows = { rows: [] };

/** The Agents activity group (order 90): the running server and each client's last call. */
function useAgentRows(): GroupRows {
  const status = useMcpStatus();
  const activity = useAgentActivity();
  return useMemo(() => {
    if (!status || (!status.on && !status.error)) return NO_ROWS;
    const open = () => openView({ kind: "agents" });
    const rows: PanelRow[] = [
      {
        key: "agents:server",
        section: "agents",
        label: "MCP server",
        detail: status.error ?? undefined,
        trailing: status.on ? `127.0.0.1:${status.port}` : "off",
        glyph: status.error ? "error" : "ok",
        activate: open,
        stop: status.on ? () => setServer(false) : undefined,
      },
    ];
    for (const c of status.clients) {
      const last = activity.get(c.name);
      if (!c.connected && !last) continue;
      rows.push({
        key: `agents:client:${c.name}`,
        section: "agents",
        label: c.name,
        detail: last ? `${last.tool}${last.ok ? "" : " · refused"}` : `${c.calls} calls`,
        since: last?.at ?? (c.lastUsedAt ? Date.parse(c.lastUsedAt) : undefined),
        glyph: last && !last.ok ? "warn" : "ok",
        activate: open,
      });
    }
    return { rows };
  }, [status, activity]);
}

/** The Agent requests activity group (order 5, above everything): waiting and running requests. */
function useRequestRows(): GroupRows {
  const list = useProposals();
  return useMemo(() => {
    const open = list.filter(isOpen);
    if (open.length === 0) return NO_ROWS;
    const rows: PanelRow[] = open.map((p) => ({
      key: `proposal:${p.id}`,
      section: "agent-requests",
      label: titleText(p, (id) => devSetById(id)?.name),
      detail: p.state === "pending" ? (p.reason ? `"${cleanUntrusted(p.reason, 120)}" · Enter to review` : "Enter to review") : p.state === "reviewing" ? (reviewingId() === p.id ? "open in a dialog" : "left open · Enter to review") : "running…",
      since: Date.parse(p.createdAt) || undefined,
      glyph: p.state === "executing" ? "progress" : "warn",
      // a request left in review by a reloaded window opens again
      activate: p.state === "pending" || (p.state === "reviewing" && reviewingId() !== p.id) ? () => review(p.id) : undefined,
      // activity.stop on the row = reject (no reason); the dialog takes a reason
      stop: p.state === "pending" || (p.state === "reviewing" && reviewingId() !== p.id) ? () => rejectFromRow(p.id) : undefined,
      stay: true,
    }));
    return { rows, count: waitingCount(open) };
  }, [list]);
}

async function rejectFromRow(id: string): Promise<void> {
  await backend.proposalResolve(id, { kind: "rejected", reason: "rejected from the activity panel" }).catch(() => {});
  void refreshProposals();
}

/** Bottom row: `agent 1` while requests wait; a click reviews the oldest (proposals.next). */
function AgentIndicator() {
  const list = useProposals();
  const n = waitingCount(list);
  if (n === 0) return null;
  const first = list.find((p) => p.state === "pending");
  return createElement(
    "button",
    {
      type: "button",
      className: "pf-indicator t-ui",
      tabIndex: -1,
      ...actionTip("proposals.next", first ? `${cleanUntrusted(first.client, 40)} asks to ${askText(first.payload, (id) => devSetById(id)?.name)}` : "Review agent request"),
      "aria-label": `${n} agent request${n === 1 ? "" : "s"} waiting`,
      "data-kind": "warn",
      onMouseDown: keepFocus,
      onClick: () => engine.run("proposals.next", { source: "pointer" }),
    },
    `agent ${n}`,
  );
}

export function register(): void {
  registerView({
    kinds: ["agents"],
    component: () => import("./AgentsView"),
    toolbar: () => ["agents.connect", "agents.revoke", "agents.stopServer", "|", "filter.open", "hub.help"],
  });
  registerOverlay(CONNECT_OVERLAY, () => import("./ConnectDialog"));
  registerOverlay(REVOKE_OVERLAY, () => import("./RevokeDialog"));
  registerOverlay(POLICY_OVERLAY, () => import("./PolicyDialog"));
  registerOverlay(PORT_OVERLAY, () => import("./PortDialog"));
  registerActivityGroup({ id: "agents", label: "Agents", order: 90, useRows: useAgentRows });
  registerToolStatus("mcp", () => statusLine(useMcpStatus()));
  registerOverlay(REVIEW_OVERLAY, () => import("./ProposalDialog"));
  registerActivityGroup({ id: "agent-requests", label: "Agent requests", order: 5, useRows: useRequestRows });
  registerShellItem({ id: "agent", area: "status", order: 5, component: AgentIndicator });
  registerToolStatus("proposals", () => {
    const list = useProposals();
    const n = waitingCount(list);
    const running = list.filter((p) => p.state === "executing").length;
    if (n > 0) return { text: `${n} waiting`, state: "warn" };
    if (running > 0) return { text: `${running} running`, state: "active" };
    return list.length > 0 ? { text: `${list.length} this session`, state: "off" } : null;
  });
  registerTool({
    id: "proposals", title: "Agent requests", group: "Agents",
    summary: "Review what an agent asks to do: dev sets, forwards, env exports, changes",
    help: {
      answers: "An agent connected through MCP cannot change anything itself: dev-set starts, forwards, env exports and writes arrive here as requests. Each opens one dialog with everything that would happen, \"requested by\" and the agent's note marked unverified; you approve, reject with a reason, or press Esc to decide later.",
      notFor: "Saving a dev set needs no request: an agent's saved set is inert until you approve starting it.",
      safety: "Nothing runs without your approval; no batch, no always-allow. Secret keys of an export stay out unless you tick them (tier 2). Protected contexts ask you to type the name; read-only contexts offer Reject only.",
      example: "Ask Claude Code \"set up a dev config against envdemo\", then leader y (or the agent item in the bottom row) to review its request. Try it here with `:mcp demo` in the browser dev build.",
    },
    actions: ["proposals.next"],
    commands: [":proposals", ":mcp demo"],
    try: { action: "proposals.next", needs: "none" },
  });
  startAgentsStore();
  startUiStatePublisher();
  startProposals();
  startShowHandler();
  startAgentDrafts();
}
