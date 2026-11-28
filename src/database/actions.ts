// `res.database` (right-click a database row → "open database", `:db`) and the keys of the
// database view. Small and eager: the view loads lazily.
import { focusedPane, getSelection, openView, paneView, registerActions, registerViewActions } from "../foundation";
import type { ObjectRef, PaneId } from "../types";
import { canOpen } from "./model";

const PODS = { group: "", version: "v1", resource: "pods" };

/** The object the action opens: a table's cursor row, or the pod of a containers view. */
function target(): ObjectRef | null {
  const pane = focusedPane();
  if (!pane) return null;
  const v = paneView(pane);
  if (v?.kind === "containers") return { gvr: PODS, namespace: v.pod.namespace, name: v.pod.name };
  if (v?.kind === "table") {
    const r = getSelection(pane).focused;
    return r && canOpen(r) ? r : null;
  }
  return null;
}

// ── the view's controls, for the keys ─────────────────────────────────────────

export interface DatabaseControls {
  run(): void;
  refresh(): void;
  toggleWrites(): void;
  canRun(): boolean | string;
}
const controls = new Map<PaneId, DatabaseControls>();
export function setDatabaseControls(pane: PaneId, c: DatabaseControls): () => void {
  controls.set(pane, c);
  return () => {
    if (controls.get(pane) === c) controls.delete(pane);
  };
}
const ctrl = () => {
  const p = focusedPane();
  return p ? controls.get(p) : undefined;
};

registerActions({
  "res.database": {
    // any pod, workload or Service: Rust reads the pod spec and says when there is no database.
    // The row menu offers it only on rows named like one (rowMenu, src/table/pointer.ts).
    when: () => target() !== null,
    run: (ctx) => {
      const ref = target();
      if (!ref) return;
      openView({ kind: "database", ref }, { newPane: ctx.newPane ?? "right" });
    },
  },
  "db.run": { enabled: () => ctrl()?.canRun() ?? "loading", run: () => ctrl()?.run() },
  "db.writes": { enabled: () => !!ctrl() || "no database view", run: () => ctrl()?.toggleWrites() },
});

// Mod+R reloads the tables and the open table
registerViewActions(["database"], {
  "view.refresh": { enabled: () => !!ctrl() || "loading", run: () => ctrl()?.refresh() },
});
