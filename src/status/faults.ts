// Where a health badge goes: the namespace's table with FAULTS on (the table's own `!` filter, so
// the same rule the badge counts with). Pods when a pod is faulty, else the workload kind; a table holds
// one kind, so a badge that also counts a degraded deployment shows one more than the pods view lists.
import type { Gvr } from "../ipc/types";
import { openView } from "../store/layout";
import { tableView } from "../store/workspace";
import { faultsResource, merged } from "./health-model";
import { getHealth } from "./health";

export function faultsGvr(ns: string | "*"): Gvr {
  const s = getHealth();
  const res = faultsResource(ns === "*" ? merged(s.snapshot) : s.byNs.get(ns));
  return res === "pods" ? { group: "", version: "v1", resource: "pods" } : { group: "apps", version: "v1", resource: res };
}

/** Opens the faults view of `ns` (`*` = every namespace) in the focused pane, or beside it. */
export function openFaults(ns: string | "*", newPane: "right" | "down" | null = null): string | null {
  return openView(tableView(faultsGvr(ns), ns, { faultsOnly: true }), { newPane });
}
