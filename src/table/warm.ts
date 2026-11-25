// Warm tabs (docs/ux.md §8.2): the tables of an open tab that is not on screen keep their watch, so
// switching back paints current rows at once instead of `syncing`. One lease per query of a table
// or containers pane of those tabs; the shared, refcounted subscription is the same one the pane
// takes when its tab is on screen again.
import type { TableQuery } from "../ipc/types";
import type { ViewState, Workspace } from "../types";
import { CORE_PODS, currentView, layoutStore, openWorkspaces, resourceFor, tableKey, tables, type Lease } from "../foundation";
// subscribe-only: discovery decides whether a table's namespace is part of its query
import { clusterStore } from "../store/cluster";
import { labelSelectorOf } from "./filter";
import { scopeSelectors } from "./scope";

/** The query a pane's view watches, as TableView builds it; null for other views. */
export function warmQuery(view: ViewState, context: string): TableQuery | null {
  if (!context) return null;
  if (view.kind === "containers") return { context, gvr: CORE_PODS, namespace: view.pod.namespace };
  if (view.kind !== "table") return null;
  const namespaced = resourceFor(view.gvr, context)?.namespaced ?? true;
  const selectors = scopeSelectors(view.scope);
  return {
    context,
    gvr: view.gvr,
    namespace: namespaced && view.namespace !== "*" ? view.namespace : undefined,
    labelSelector: labelSelectorOf(view.filters, selectors.labelSelector),
    fieldSelector: selectors.fieldSelector,
  };
}

/** Every query the panes of the background tabs watch, by key. */
export function warmQueries(background: readonly Workspace[]): Map<string, TableQuery> {
  const out = new Map<string, TableQuery>();
  for (const ws of background) {
    for (const pane of Object.values(ws.panes)) {
      const q = warmQuery(currentView(pane), pane.context ?? ws.context);
      if (q) out.set(tableKey(q), q);
    }
  }
  return out;
}

const held = new Map<string, Lease>();

function hub(): ReturnType<typeof tables> | null {
  try {
    return tables();
  } catch {
    return null; // before initCluster: nothing is watched yet
  }
}

function sync(): void {
  const t = hub();
  if (!t) return;
  const s = layoutStore.getState();
  const background = openWorkspaces(s).filter((ws) => ws.context !== s.current);
  const want = warmQueries(background);
  for (const [key, lease] of held) {
    if (want.has(key)) continue;
    lease.release();
    held.delete(key);
  }
  for (const [key, q] of want) if (!held.has(key)) held.set(key, t.acquire(q));
}

let started = false;
export function initWarmTabs(): void {
  if (started) return;
  started = true;
  let lastTabs: unknown = null;
  let lastWs: unknown = null;
  layoutStore.subscribe((s) => {
    if (s.tabs === lastTabs && s.workspaces === lastWs) return;
    lastTabs = s.tabs;
    lastWs = s.workspaces;
    sync();
  });
  // a resource discovered later can turn out to be cluster-scoped: its query drops the namespace
  let lastConns: unknown = null;
  clusterStore.subscribe((c) => {
    if (c.conns === lastConns) return;
    lastConns = c.conns;
    if (held.size > 0 || layoutStore.getState().tabs.length > 1) sync();
  });
}
