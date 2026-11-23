// `:mcp demo` (docs/plan-features.md §3 H2 "Mock"): a scripted agent that plays the R1 flow
// (§5.7) against the mock backend, so the whole approval path can be tried in a browser. Only in
// `pnpm dev` without Tauri (the mock ships in the production bundle; the guard is required).
//
// The script, as `claude-code`:
// get_status → get_selection → get_workload_dependencies(deploy/orders) → draft_dev_set_from_workload
// → save_dev_set → show_in_kns(devset) → propose_dev_set_up(exportEnv) → wait_proposal (until the
// human decides) → propose_scale on `staging` (denied by policy) → save_dev_set on the human's set
// `shop` (refused NotOwner). Each step is a toast, so the human sees what an agent does.
import { flash, isTauri, toast, toasts } from "../foundation";
import type { Json } from "../ipc/types";

export const DEMO_CLIENT = "claude-code";
export const demoAvailable = (): boolean => import.meta.env.DEV && !isTauri;

type Call = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: true; data: Json } | { ok: false; error: { code: string; message: string; hint?: string } }>;

let running = false;

const say = (text: string, kind: "info" | "ok" | "warn" = "info") => toast({ kind, text: `demo agent: ${text}`, ttl: 6000 });

/** The script; `call` plays one MCP tool call (the mock's). Returns a short outcome line. */
export async function demoScript(call: Call, wait: (ms: number) => Promise<void>, log: (s: string, kind?: "info" | "ok" | "warn") => void): Promise<string> {
  const status = await call("get_status");
  if (!status.ok) throw new Error(status.error.message);
  const contexts = ((status.data as { contexts?: { name: string; policy: string }[] }).contexts ?? []).filter((c) => c.policy === "propose");
  if (contexts.length === 0) {
    log(`get_status: no context allows proposals; ${String((status.data as { hint?: string }).hint ?? 'run ":mcp policy propose default"')}`, "warn");
    return "stopped: policy";
  }
  log(`get_status: ${contexts.map((c) => `${c.name} (${c.policy})`).join(", ")}`);
  await call("get_selection");
  const ref = { kind: "deployments", namespace: "shop", name: "orders" };
  const deps = await call("get_workload_dependencies", { ref });
  if (!deps.ok) throw new Error(deps.error.message);
  const depNames = ((deps.data as { deps?: { service: { name: string } }[] }).deps ?? []).map((d) => d.service.name);
  log(`get_workload_dependencies: deploy/orders talks to ${depNames.join(", ")}`);
  await wait(600);
  // a name not taken yet, so the demo runs more than once
  const listed = await call("list_dev_sets");
  const taken = listed.ok ? ((listed.data as { sets?: { name: string }[] }).sets ?? []).map((s) => s.name) : [];
  let name = "orders-agent";
  for (let n = 2; taken.includes(name); n++) name = `orders-agent-${n}`;
  const draft = await call("draft_dev_set_from_workload", { ref, name });
  if (!draft.ok) throw new Error(draft.error.message);
  const set = (draft.data as { set: Record<string, unknown> }).set;
  log(`draft_dev_set_from_workload: ${(set.forwards as unknown[]).length} forwards, ${(set.rewrites as unknown[]).length} rewrites, a -local consumer group`);
  await wait(600);
  const saved = await call("save_dev_set", { set });
  if (!saved.ok) throw new Error(saved.error.message);
  const id = String((saved.data as { id: string }).id);
  log(`save_dev_set: saved ${id} (inert, not approved)`);
  await call("show_in_kns", { view: "devset", devSet: id });
  const proposed = await call("propose_dev_set_up", { id, exportEnv: { format: "dotenv" }, reason: "forwards and a .env for running orders locally" });
  if (!proposed.ok) throw new Error(proposed.error.message);
  const pid = String((proposed.data as { proposal: { id: string } }).proposal.id);
  log(`propose_dev_set_up: ${pid} is waiting for you · leader y or "agent 1" in the bottom row`, "warn");
  let final: Record<string, unknown> | null = null;
  for (let i = 0; i < 60 && !final; i++) {
    const w = await call("wait_proposal", { id: pid, timeoutSeconds: 30 });
    if (!w.ok) throw new Error(w.error.message);
    const p = (w.data as { proposal: Record<string, unknown> }).proposal;
    if (!["pending", "reviewing", "executing"].includes(String(p.state))) final = p;
  }
  if (!final) return "gave up waiting";
  const result = final.result as { message?: string; data?: Json } | undefined;
  log(`wait_proposal: ${String(final.state)}${result?.message ? ` · ${result.message}` : ""}${result?.data ? ` · ${JSON.stringify(result.data)}` : ""}`, final.state === "approved" ? "ok" : "info");
  if (final.state === "rejected") return `rejected: ${result?.message ?? ""}`;
  await wait(800);
  const scale = await call("propose_scale", { ref: { kind: "deployments", namespace: "default", name: "web", context: "staging" }, replicas: 3, reason: "more replicas" });
  log(scale.ok ? "propose_scale on staging: created (policy allowed it)" : `propose_scale on staging: ${scale.error.code} · ${scale.error.hint ?? scale.error.message}`, scale.ok ? "warn" : "info");
  const human = await call("save_dev_set", { set: { id: "ds-shop", name: "shop", forwards: [] } });
  log(human.ok ? "save_dev_set on shop: saved (unexpected)" : `save_dev_set on your set shop: ${human.error.code}`, human.ok ? "warn" : "info");
  return String(final.state);
}

/** `:mcp demo`. */
export async function runDemo(): Promise<void> {
  if (!demoAvailable()) {
    flash("the scripted agent runs only in the browser dev build (pnpm dev)", "warn");
    return;
  }
  if (running) {
    flash("the demo agent is already running", "warn");
    return;
  }
  running = true;
  try {
    const m = await import("../ipc/mock/agents");
    const ready = await m.mockDemoSetup(DEMO_CLIENT);
    if (ready) say(ready);
    const out = await demoScript((tool, args) => m.mockMcpCallAsync(DEMO_CLIENT, tool, args ?? {}), (ms) => new Promise((r) => setTimeout(r, ms)), say);
    say(`done (${out})`, "ok");
  } catch (e) {
    toasts.error(`demo agent: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    running = false;
  }
}
