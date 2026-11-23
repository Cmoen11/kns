// `show_in_kns` (docs/plan-features.md §5.3): an agent points the human at something. The view
// opens beside the focused pane, labelled `AGENT · <client>` in its header, and focus stays where
// it was. At most two agent panes exist; a third show reuses the older one. Agent panes are never
// persisted (workspace.ts drops them on load), so a reload does not leave unlabelled ones behind.
import { backend, closePane, windowContext, getWorkspace, openView, setWorkspace, toast } from "../foundation";
import type { AgentShowView, ObjRef } from "../ipc/types";
import type { ObjectRef, PaneId, ViewState } from "../types";
import { cleanUntrusted } from "../ui/untrusted";

export const MAX_AGENT_PANES = 2;

const toObject = (r: ObjRef): ObjectRef => ({ gvr: r.gvr, namespace: r.namespace, name: r.name });

/** The view an agent's show maps to (pure); null when it needs a ref or set it did not give. */
export function viewFor(show: AgentShowView): ViewState | null {
  if (show.view === "devset") return show.devSet ? { kind: "devsets", selected: show.devSet } : null;
  if (!show.ref) return null;
  const ref = toObject(show.ref);
  switch (show.view) {
    case "describe":
      return { kind: "doc", ref, format: "describe", mode: "view", managedFields: false, wrap: false };
    case "yaml":
      return { kind: "doc", ref, format: "yaml", mode: "view", managedFields: false, wrap: false };
    case "logs":
      return { kind: "logs", target: { by: "object", ref }, container: "*", since: "tail", previous: false, wrap: false, timestamps: false, filterLines: false };
    case "why":
      return { kind: "why", ref };
    case "timeline":
      return { kind: "timeline", ref, sinceMinutes: 60 };
  }
}

/** Agent panes in the workspace, oldest first (pure over the panes' `agent` field and the order of `known`). */
export function agentPanes(panes: Record<PaneId, { agent?: string }>, known: readonly PaneId[]): PaneId[] {
  const live = Object.keys(panes).filter((id) => panes[id].agent !== undefined);
  return [...known.filter((id) => live.includes(id)), ...live.filter((id) => !known.includes(id))];
}

let order: PaneId[] = [];

/** Opens `show` for `client`; returns the pane, or null when it could not be shown. */
export function showForAgent(client: string, show: AgentShowView): PaneId | null {
  const ws = getWorkspace();
  const view = viewFor(show);
  if (!ws || !view) return null;
  const context = show.ref?.context;
  // agent panes open in the window's context only: an agent never puts a pane in another cluster (§8.3)
  if (context && context !== windowContext()) {
    toast({ kind: "info", text: `${cleanUntrusted(client, 40)} wanted to show ${show.view} of ${cleanUntrusted(show.ref?.name ?? "", 80)} in ${context}; kns is on ${windowContext()}` });
    return null;
  }
  const focused = ws.focused;
  order = agentPanes(ws.panes, order);
  let pane: PaneId | null;
  const old = order[0];
  const oldView = old ? getWorkspace()?.panes[old] : undefined;
  const live = oldView ? ["logs", "shell", "attach"].includes(oldView.history[oldView.index]?.kind ?? "") : false;
  if (order.length >= MAX_AGENT_PANES && !live) {
    // reuse the older agent pane in place (its own history, not the human's pane)
    pane = old;
    openView(view, { pane, context: windowContext() });
    order = [...order.slice(1), pane];
  } else if (order.length >= MAX_AGENT_PANES) {
    // a live view would make openView split instead of replace: close it, then open in its place
    void closePane(old);
    order = order.slice(1);
    pane = openView(view, { pane: order[order.length - 1] ?? focused, newPane: "down", follow: false, context: windowContext() });
    if (pane) order = [...order, pane];
  } else {
    const source = order[order.length - 1] ?? focused;
    pane = openView(view, { pane: source, newPane: order.length ? "down" : "right", follow: false, context: windowContext() });
    if (pane) order = [...order, pane];
  }
  if (!pane) return null;
  const after = getWorkspace();
  if (after?.panes[pane]) {
    // the label, and focus back where the human had it
    const keep = after.panes[focused] ? focused : after.focused;
    setWorkspace({
      ...after,
      panes: { ...after.panes, [pane]: { ...after.panes[pane], agent: cleanUntrusted(client, 40) } },
      focused: keep,
      mru: [keep, ...after.mru.filter((id) => id !== keep)],
    });
  }
  return pane;
}

let started = false;
export function startShowHandler(): void {
  if (started) return;
  started = true;
  backend.onEvent((e) => {
    if (e.type === "agentShow") showForAgent(e.client, e.view);
  });
}
