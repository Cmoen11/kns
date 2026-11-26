// Handlers of the agents feature (docs/plan-features.md §2.7, §3 H1): `:mcp`, the agents view and
// its keys. Small and eager; the view and the dialogs load lazily.
import {
  backend, confirm, contextFlags, focusedContext, flash, openView, paneView, registerActions, registerViewActions, showOverlay, toast, toasts,
  type ActionContext,
} from "../foundation";
import type { BackendError, McpPolicy } from "../ipc/types";
import { ctl } from "../views/tools/controllers";
import { MCP_USAGE, parseMcpArgs, policyText, statusLine } from "./model";
import { getMcpStatus, refreshStatus, setMcpStatus } from "./store";
import { review } from "./approve";
import { nextToReview } from "./proposal-model";
import { getProposals } from "./proposals";

export const CONNECT_OVERLAY = "agents.connect";
export const REVOKE_OVERLAY = "agents.revoke";
export const POLICY_OVERLAY = "agents.policy";
export const PORT_OVERLAY = "agents.port";
export const SKILL_OVERLAY = "agents.skill";

const message = (e: unknown): string => (e as Partial<BackendError>)?.message ?? String(e);

/** Turns the server on or off and says what happened (a taken port is an error, not silence). */
export async function setServer(on: boolean): Promise<boolean> {
  try {
    const s = await backend.mcpSetEnabled(on);
    setMcpStatus(s);
    if (on && !s.on) {
      toasts.error(`MCP server did not start: ${s.error ?? "unknown error"}`);
      return false;
    }
    toast({ kind: on ? "ok" : "info", text: on ? `MCP server on · 127.0.0.1:${s.port}` : "MCP server off" });
    return true;
  } catch (e) {
    toasts.error(`MCP server: ${message(e)}`);
    return false;
  }
}

export async function setPort(port: number): Promise<boolean> {
  try {
    const s = await backend.mcpSetPort(port);
    setMcpStatus(s);
    if (s.error) toasts.error(s.error);
    else toast(`MCP port ${port}${s.on ? " · server restarted" : ""}`);
    return !s.error;
  } catch (e) {
    toasts.error(`MCP port: ${message(e)}`);
    return false;
  }
}

/**
 * Stores a context's agent policy. `propose` on a protected context is a tier-2 confirm (type the
 * context name), §5.4. A read-only context keeps agents at `read` whatever is stored.
 */
export async function setPolicy(context: string, policy: McpPolicy, namespaces?: string[], opts: { confirmed?: boolean } = {}): Promise<boolean> {
  const flags = contextFlags(context);
  if (policy === "propose" && flags.protected && !opts.confirmed) {
    const ok = await confirm({
      tier: 2,
      title: "Let agents propose changes",
      body: `${context} is protected. Agents may then ask to start forwards, export env files and change objects there; you still approve each request, at tier 2.`,
      typeToConfirm: context,
      confirmLabel: "Allow proposals",
    });
    if (!ok) return false;
  }
  try {
    await backend.mcpPolicySet(context, policy, namespaces);
    refreshStatus();
    const capped = policy === "propose" && flags.readOnly ? " (read-only in kns: agents can only read until you lift it)" : "";
    toast(`Agents in ${context}: ${policyText(policy, namespaces)}${capped}`);
    return true;
  } catch (e) {
    toasts.error(`Agent policy: ${message(e)}`);
    return false;
  }
}

/** Adds (or re-keys) a client; Rust copies the setup command. The token never reaches the webview. */
export async function addClient(name: string): Promise<boolean> {
  try {
    const r = await backend.mcpClientAdd(name);
    refreshStatus();
    const where = r.excluded ? "kept out of clipboard history, clears in 2 min" : "clears in 2 min";
    toast({ kind: "ok", text: `Setup command for ${name} copied (${where}). Paste it in a terminal; the token is shown nowhere else.` });
    return true;
  } catch (e) {
    toasts.error(`Add agent: ${message(e)}`);
    return false;
  }
}

/** Writes the Claude Code skill for the CLI (and, with `token`, a CLI token only kns-mcp reads). */
export async function installSkill(token: boolean): Promise<boolean> {
  try {
    const r = await backend.mcpSkillInstall(token);
    refreshStatus();
    const tokenText = r.token ? " · CLI token created" : " · the agent needs KNS_MCP_TOKEN";
    toast({ kind: "ok", text: `Agent skill installed: ${r.path}${tokenText}. Start a new Claude Code session to load it.` });
    if (!r.cliFound) toasts.error(`kns-mcp was not found at ${r.cli}: the skill names it, but this build has no CLI there`);
    return true;
  } catch (e) {
    toasts.error(`Install agent skill: ${message(e)}`);
    return false;
  }
}

function openAgents(ctx: ActionContext): void {
  if (!ctx.newPane && paneView()?.kind === "agents") return;
  openView({ kind: "agents" }, { newPane: ctx.newPane });
}

/** The client name on the agents view's cursor row (`client:<name>`), if any. */
export function cursorClient(): string | undefined {
  if (paneView()?.kind !== "agents") return undefined;
  const key = ctl()?.current()?.key;
  return key?.startsWith("client:") ? key.slice("client:".length) : undefined;
}

async function runMcp(ctx: ActionContext): Promise<void> {
  const cmd = parseMcpArgs(ctx.args);
  switch (cmd.kind) {
    case "error":
      flash(cmd.message, "warn");
      return;
    case "setup":
      showOverlay(CONNECT_OVERLAY, {});
      return;
    case "skill":
      showOverlay(SKILL_OVERLAY, {});
      return;
    case "on":
      await setServer(true);
      return;
    case "off":
      await setServer(false);
      return;
    case "status": {
      const s = getMcpStatus() ?? (await backend.mcpStatus().catch(() => null));
      const line = statusLine(s);
      flash(`MCP ${line ? line.text : "status unknown"}`, line?.state === "warn" ? "warn" : "info");
      return;
    }
    case "demo": {
      const { runDemo } = await import("./demo");
      await runDemo();
      return;
    }
    case "add":
      await addClient(cmd.name);
      return;
    case "revoke":
      if (!getMcpStatus()?.clients.some((c) => c.name === cmd.name)) {
        flash(`no MCP client named ${cmd.name}`, "warn");
        return;
      }
      showOverlay(REVOKE_OVERLAY, { name: cmd.name });
      return;
    case "port":
      await setPort(cmd.port);
      return;
    case "policy": {
      const context = cmd.context ?? focusedContext();
      if (!context) {
        flash("no context: :mcp policy <policy> <context>", "warn");
        return;
      }
      await setPolicy(context, cmd.policy, cmd.namespaces);
      return;
    }
  }
}

registerActions({
  "mcp.command": { run: runMcp },
  "proposals.next": {
    run: (ctx) => {
      const id = ctx.args[0];
      const p = id ? getProposals().find((x) => x.id === id) : nextToReview(getProposals());
      if (!p) {
        flash(id ? `no agent request ${id}` : "no agent request is waiting");
        return;
      }
      void review(p.id);
    },
  },
  "agents.open": openAgents,
  "agents.connect": () => showOverlay(CONNECT_OVERLAY, {}),
  "agents.installSkill": () => showOverlay(SKILL_OVERLAY, {}),
  "agents.revoke": {
    enabled: () => !!cursorClient() || "put the cursor on a client row",
    run: () => {
      const name = cursorClient();
      if (name) showOverlay(REVOKE_OVERLAY, { name });
    },
  },
  "agents.stopServer": {
    enabled: () => !!getMcpStatus()?.on || "the MCP server is off",
    run: () => void setServer(false),
  },
});

const noRow = "no row selected";
const current = () => ctl()?.current();

// list navigation in the agents view (the same list as the tool views)
registerViewActions(["agents"], {
  "nav.down": () => ctl()?.move(1),
  "nav.up": () => ctl()?.move(-1),
  "nav.top": () => ctl()?.top(),
  "nav.bottom": () => ctl()?.bottom(),
  "nav.pageDown": () => ctl()?.page(1),
  "nav.pageUp": () => ctl()?.page(-1),
  "nav.open": {
    when: () => !!current()?.open,
    enabled: () => !!current() || noRow,
    run: (ctx) => current()?.open?.(ctx.newPane),
  },
  "filter.open": () => ctl()?.filterOpen(),
  "filter.apply": { when: () => !!ctl()?.isFiltering(), run: () => ctl()?.filterApply() },
  "filter.cancel": { when: () => !!ctl()?.isFiltering(), run: () => ctl()?.filterCancel() },
  "filter.clear": { when: () => !!ctl()?.hasFilter() && !ctl()?.isFiltering(), run: () => ctl()?.filterClear() },
});

export { MCP_USAGE };
