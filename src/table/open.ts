// Opens the views behind Enter and the row keys (d y e l p s). Everything goes through openView,
// with ctx.newPane passed straight through (§4.4).
import type { Json, Row } from "../ipc/types";
import type { ContainersView, ObjectRef, TableView } from "../types";
import { backend, openView, paneContext, resolveResource, toasts, toObjRef } from "../foundation";
import { textsOf } from "./cells";
import { docView, drill, logsView, podsBySelector, selectorString } from "./drill";
import type { OpenWhat } from "./model";

type NewPane = "right" | "down" | null;

const message = (e: unknown): string => (typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e));

async function openService(pane: string, ref: ObjectRef, newPane: NewPane): Promise<void> {
  try {
    const obj = await backend.getJson(toObjRef(ref, paneContext(pane)));
    const spec = typeof obj === "object" && obj !== null && !Array.isArray(obj) ? (obj.spec as Json | undefined) : undefined;
    const selector = selectorString(typeof spec === "object" && spec !== null && !Array.isArray(spec) ? spec.selector : null);
    openView(selector ? podsBySelector(ref.namespace, selector) : docView(ref, "describe"), { pane, newPane });
  } catch (e) {
    toasts.error(`Could not read service ${ref.name}: ${message(e)}`);
  }
}

export function openFromTable(pane: string, view: TableView, columns: readonly { name: string }[], what: OpenWhat, row: Row, newPane: NewPane): void | Promise<void> {
  const ref: ObjectRef = { gvr: view.gvr, namespace: row.namespace, name: row.name, uid: row.uid };
  const go = (v: Parameters<typeof openView>[0]) => void openView(v, { pane, newPane });
  switch (what) {
    case "drill": {
      const objectCol = columns.findIndex((c) => c.name.trim().toLowerCase() === "object");
      const d = drill({
        gvr: view.gvr, ref,
        eventObject: objectCol >= 0 ? textsOf(row)[objectCol] : undefined,
        resolve: (name) => {
          const r = resolveResource(name, paneContext(pane));
          return r && { gvr: r.gvr, namespaced: r.namespaced };
        },
      });
      return "view" in d ? go(d.view) : openService(pane, d.service, newPane);
    }
    case "logs":
      return go(logsView(ref, "*", false));
    case "logsPrevious":
      return go(logsView(ref, "*", true));
  }
}

/** Container rows (§12.5): Enter and `l` are the container's logs; `d` is the pod's describe. */
export function openFromContainers(pane: string, view: ContainersView, what: OpenWhat, row: Row, newPane: NewPane): void {
  const pod = view.pod;
  const go = (v: Parameters<typeof openView>[0]) => void openView(v, { pane, newPane });
  switch (what) {
    case "drill":
    case "logs":
      return go(logsView(pod, row.name, false));
    case "logsPrevious":
      return go(logsView(pod, row.name, true));

  }
}
