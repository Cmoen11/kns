// Keeps the key engine's base scopes equal to the focused pane's view. One synchronous subscriber
// outside React: a key pressed right after a focus or view change must already resolve in the new
// scopes, which an effect cannot guarantee.
import { engine } from "../keys";
import { clusterStore } from "../store/cluster";
import { layoutStore, getWorkspace } from "../store/layout";
import { getSelection, onAnySelection } from "../store/selection";
import { viewOf } from "../store/workspace";
import { scopesOf, subscribePaneScopes, subscribeViews } from "../views/registry";

let last = "";

export function syncScopes(): void {
  const ws = getWorkspace();
  const view = ws && viewOf(ws, ws.focused);
  const { scopes, mode } = ws && view ? scopesOf(ws.focused, view) : { scopes: [], mode: "NORMAL" as const };
  const key = `${mode}|${scopes.join(" ")}`;
  if (key === last) {
    // same scopes, but `when` / `enabled` of pane and history actions read the workspace
    engine.invalidate();
    return;
  }
  last = key;
  engine.setBaseScopes(scopes, { mode });
}

let started = false;
export function initScopeSync(): void {
  if (started) return;
  started = true;
  layoutStore.subscribe(syncScopes);
  // discovery decides namespaced / scalable / flux
  clusterStore.subscribe((s, p) => {
    if (s.aliases !== p.aliases || s.conns !== p.conns) syncScopes();
  });
  // `enabled` of row actions reads the selection ("no row selected"): hints and buttons must
  // follow when a pane gains or loses its cursor row or its marks, whoever published it
  const shapes = new Map<string, string>();
  onAnySelection((pane) => {
    const s = getSelection(pane);
    const shape = `${s.focused ? 1 : 0}:${s.marked.length}`;
    if (shapes.get(pane) === shape) return;
    shapes.set(pane, shape);
    if (getWorkspace()?.focused === pane) engine.invalidate();
  });
  subscribePaneScopes(syncScopes);
  subscribeViews(syncScopes);
  syncScopes();
}
