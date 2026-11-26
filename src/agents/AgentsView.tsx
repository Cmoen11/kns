// The agents view (`:agents`, docs/plan-features.md §3 H1): the MCP server, its clients (last
// used, calls, bytes, redactions), the agent policy per context and the audit tail. Keys: `a`
// connect, `x` revoke the client under the cursor, `X` stop the server, Enter on a row changes it.
import { useEffect, useMemo } from "react";
import type { ViewProps } from "../foundation";
import { contextFlags, showOverlay, useCluster } from "../foundation";
import { EmptyState } from "../ui";
import { ListPane } from "../views/tools/ListPane";
import type { ItemRow, ListRow } from "../views/tools/list-model";
import { clock } from "../views/tools/open";
import { CONNECT_OVERLAY, POLICY_OVERLAY, PORT_OVERLAY, SKILL_OVERLAY, setServer } from "./actions";
import { auditCells, auditGlyph, clientDetail, policyContexts, policyOf, policyText, statusLine } from "./model";
import { refreshStatus, useAudit, useMcpStatus, watchAudit } from "./store";

const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? clock(t) : iso;
};

export default function AgentsView({ pane, focused }: ViewProps<"agents">) {
  const status = useMcpStatus();
  const audit = useAudit();
  const contexts = useCluster((s) => s.contexts);
  useEffect(() => {
    refreshStatus();
    return watchAudit();
  }, []);

  const rows = useMemo<ListRow[]>(() => {
    const out: ListRow[] = [];
    const line = statusLine(status);
    out.push({ type: "group", key: "g:server", label: "Server" });
    out.push({
      type: "item",
      key: "server",
      glyph: status?.error ? "error" : status?.on ? "ok" : undefined,
      cells: ["MCP server", status?.error ?? (status?.on ? "agents on this machine can connect with a token" : "off: nothing listens")],
      value: line ? (status?.on ? `on · 127.0.0.1:${status.port}` : "off") : "…",
      title: line?.text,
      open: () => {
        if (status?.on) void setServer(false);
        else if (!status?.clients.length) showOverlay(CONNECT_OVERLAY, {});
        else void setServer(true);
      },
    });
    out.push({
      type: "item",
      key: "port",
      cells: ["Port", "loopback only (127.0.0.1); Enter to change"],
      value: String(status?.port ?? 7099),
      open: () => showOverlay(PORT_OVERLAY, {}),
    });
    out.push({
      type: "item",
      key: "connect",
      cells: ["Connect an agent…", "server on, client name, policy, setup command to the clipboard"],
      open: () => showOverlay(CONNECT_OVERLAY, {}),
    });
    out.push({
      type: "item",
      key: "skill",
      cells: ["Install agent skill…", "a Claude Code skill (all projects) that uses kns through the kns-mcp CLI, no MCP server to register"],
      open: () => showOverlay(SKILL_OVERLAY, {}),
    });

    out.push({ type: "group", key: "g:clients", label: "Clients" });
    if (!status?.clients.length) out.push({ type: "item", key: "noclients", cells: ["No clients yet", "a connects one"], open: () => showOverlay(CONNECT_OVERLAY, {}) });
    for (const c of status?.clients ?? []) {
      const detail = clientDetail(c, time);
      out.push({ type: "item", key: `client:${c.name}`, glyph: c.connected ? "ok" : undefined, cells: [c.name, detail], title: `${c.name} · ${detail} · x revokes` });
    }

    out.push({ type: "group", key: "g:policies", label: "Policy per context" });
    for (const ctx of policyContexts(contexts.map((c) => c.name), status)) {
      const p = policyOf(status, ctx);
      const f = contextFlags(ctx);
      const notes = [f.protected ? "protected: proposals are tier 2" : "", f.readOnly ? "read-only: agents can only read" : ""].filter(Boolean).join(" · ");
      out.push({
        type: "item",
        key: `policy:${ctx}`,
        cells: [ctx, notes || (p.policy === "off" ? "agents see nothing here" : "")],
        value: policyText(p.policy, p.namespaces),
        open: () => showOverlay(POLICY_OVERLAY, { context: ctx }),
      });
    }

    out.push({ type: "group", key: "g:audit", label: "Audit (newest first)" });
    if (!audit.length) out.push({ type: "item", key: "noaudit", cells: ["No agent calls yet", ""] });
    audit.forEach((r, i) => {
      const [a, b] = auditCells(r, time);
      out.push({ type: "item", key: `audit:${i}:${r.ts}`, glyph: auditGlyph(r), cells: [a, b], title: r.args ? `${a} · ${JSON.stringify(r.args)}` : a, search: `${a} ${b}` } satisfies ItemRow);
    });
    return out;
  }, [status, audit, contexts]);

  return <ListPane pane={pane} focused={focused} name="home" rows={rows} empty={<EmptyState compact>Loading…</EmptyState>} />;
}
