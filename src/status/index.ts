// Feature: status colours (state visible at a glance). The palette itself is tokens.css; this
// package adds what needs code:
//  - the html hooks of the Status colours / Row tint settings (appearance.ts)
//  - namespace health: one backend subscription per connected context (health.ts), the sidebar
//    badges (NsBadge, rendered by sidepanels/Frame.tsx), the titlebar summary, `:faults`
//  - the action log's central hooks that need no feature edit: context switches and fired traps
//    (forwards, sessions and logs are logged by sidepanels/activity.ts, writes by the write gate)
// Eager and small; no view kinds.
import { backend } from "../ipc";
import { registerShellItem } from "../shell/slots";
import { registerToolStatus, setToolBuilt } from "../hub/catalog";
import { actionLogOf, recordAction, useActionLog } from "../store/actionlog";
import { clusterStore } from "../store/cluster";
import { useWorkspace } from "../store/layout";
import "./actions";
import { initStatusAppearance } from "./appearance";
import { getHealth, initHealth, useHealth } from "./health";
import { HealthSummary } from "./HealthSummary";
import { registerAttentionHome } from "./home";
import "./status.css";

let hooked = false;
function initLogHooks(): void {
  if (hooked) return;
  hooked = true;
  let context = clusterStore.getState().context;
  clusterStore.subscribe((s) => {
    if (s.context === context) return;
    const from = context;
    context = s.context;
    // the first context of a session is not a switch
    if (from && s.context) recordAction({ text: `switched from ${from} to ${s.context}`, state: "info", context: s.context });
  });
  backend.onEvent((e) => {
    if (e.type === "trapFired") recordAction({ text: `trap ${e.trapId} fired · bundle ${e.bundleId}`, state: "warn", target: { kind: "view", view: "traps" } });
  });
}

export function register(): void {
  initStatusAppearance();
  initHealth();
  initLogHooks();
  // right group of the titlebar, before the tools button (90) and the activity toggle (100)
  registerShellItem({ id: "health", area: "titlebar", order: 80, component: HealthSummary });
  registerAttentionHome();
  setToolBuilt("status-colors");
  registerToolStatus("ns-health", () => {
    const t = useHealth((s) => s.totals);
    const state = useHealth((s) => s.snapshot?.state ?? null);
    if (state === null) return { text: "off or not connected", state: "off" };
    if (state === "syncing") return { text: "syncing", state: "active" };
    if (state === "forbidden" || state === "error") return { text: `unknown · ${state}`, state: "warn" };
    if (t.count === 0) return { text: "all healthy", state: "ok" };
    return { text: `${t.count} faulty in ${t.namespaces} namespace${t.namespaces === 1 ? "" : "s"}`, state: "warn" };
  });
  registerToolStatus("action-log", () => {
    const context = useWorkspace((ws) => (ws ? (ws.panes[ws.focused]?.context ?? ws.context) : null));
    const log = useActionLog(context);
    const failed = log.filter((e) => e.state === "error").length;
    return log.length === 0 ? { text: "empty", state: "off" } : { text: `${log.length} recent${failed ? ` · ${failed} failed` : ""}`, state: failed ? "warn" : "ok" };
  });
}

// for tests and the devtools hook
export { getHealth, actionLogOf };
