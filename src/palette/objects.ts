// Live objects in the palette: typing a name finds the pod, deployment, service ... itself, not
// just the resource kind. While the palette is open it lists a fixed set of common kinds across
// all namespaces (server-side tables, one snapshot each) and drops the streams when it closes.
import { useEffect, useState } from "react";
import { backend } from "../ipc";
import { openView, paneContext, tableView } from "../foundation";
import { resolveResource } from "../store/cluster";
import type { PaneId } from "../types";
import type { Item } from "./sources";

/** Kinds searched by name. Anything else is reachable through its resource table. */
export const OBJECT_KINDS: readonly string[] = [
  "pods", "deployments", "statefulsets", "daemonsets", "services", "ingresses", "configmaps", "secrets",
  "jobs", "cronjobs", "persistentvolumeclaims", "nodes", "kustomizations", "helmreleases",
];

/** Below this the list would be every object in the cluster. */
export const OBJECT_QUERY_MIN = 2;

export function useObjectItems(pane: PaneId | null): Item[] {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    // the pane's context (§8.3): objects found here open in that pane
    const context = paneContext(pane ?? undefined);
    if (!context) return;
    const byKind = new Map<string, Item[]>();
    const stops: (() => void)[] = [];
    const seen = new Set<string>();
    for (const name of OBJECT_KINDS) {
      const r = resolveResource(name, context);
      if (!r) continue;
      const id = `${r.gvr.group}/${r.gvr.resource}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const kind = r.singular || r.kind.toLowerCase();
      let done = false;
      let stop: (() => void) | null = null;
      stop = backend.subscribeTable({ context, gvr: r.gvr }, (e) => {
        if (e.type !== "snapshot" || done) return;
        byKind.set(
          id,
          e.rows.map((row): Item => ({
            key: `obj:${id}:${row.namespace ?? ""}/${row.name}`,
            group: kind,
            label: row.name,
            scope: row.namespace ?? "",
            keywords: [kind, row.namespace ?? ""].filter(Boolean),
            run: (newPane) => {
              openView(tableView(r.gvr, r.namespaced ? (row.namespace ?? "*") : "*", { cursorUid: row.uid }), { pane: pane ?? undefined, newPane });
            },
          })),
        );
        setItems([...byKind.values()].flat());
        // one snapshot is enough for a palette that lives for seconds
        done = true;
        stop?.();
      });
      if (done) stop();
      stops.push(stop);
    }
    return () => stops.forEach((s) => s());
    // the palette is remounted per open: read the cluster once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return items;
}
