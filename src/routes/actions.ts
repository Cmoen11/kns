// `:routes` and the keys of the routes view (docs/tools.md#routes). Small and eager: the view loads
// lazily, and its keys must work before it does. The view registers one controller per pane.
import { flash, focusedPane, openView, paneView, registerActions, registerViewActions, replaceView, type ActionContext } from "../foundation";
import { paneNamespace } from "../store/layout";
import type { PaneId } from "../types";

export interface RoutesController {
  move(delta: number): void;
  page(dir: 1 | -1): void;
  edge(where: "top" | "bottom"): void;
  /** h / l: the step of the row the cursor is on */
  step(delta: 1 | -1): void;
  open(newPane: ActionContext["newPane"]): void;
  canOpen(): true | string;
  copyUrl(): void;
  hasRow(): boolean;
  toggleProblems(): void;
  /** the namespace of the cursor row (for `a` in an all-namespaces view) */
  rowNamespace(): string | undefined;
  refresh(): void;
  filterOpen(): void;
  filterApply(): void;
  filterCancel(): void;
  isFiltering(): boolean;
  hasFilter(): boolean;
  filterClear(): void;
}

const controllers = new Map<PaneId, RoutesController>();
export function setRoutesController(pane: PaneId, c: RoutesController): () => void {
  controllers.set(pane, c);
  return () => {
    if (controllers.get(pane) === c) controllers.delete(pane);
  };
}
const ctl = () => {
  const p = focusedPane();
  return p ? controllers.get(p) : undefined;
};

/** `:routes` (the pane's namespace), `:routes all`, `:routes shop`. */
function openRoutes(ctx: ActionContext): void {
  const arg = ctx.args?.[0];
  const here = paneNamespace();
  const namespace = arg === "all" || arg === "*" || arg === "-A" ? undefined : arg || (here && here !== "*" ? here : undefined);
  const cur = paneView();
  if (!ctx.newPane && cur?.kind === "routes" && cur.namespace === namespace) return;
  openView({ kind: "routes", namespace }, ctx.newPane ? { newPane: ctx.newPane } : {});
}

const loading = "loading";
const noRow = "no row selected";

registerActions({
  "res.routes": openRoutes,
  "routes.left": { enabled: () => ctl()?.hasRow() || noRow, run: () => ctl()?.step(-1) },
  "routes.right": { enabled: () => ctl()?.hasRow() || noRow, run: () => ctl()?.step(1) },
  "routes.copyUrl": { enabled: () => ctl()?.hasRow() || noRow, run: () => ctl()?.copyUrl() },
  "routes.problems": { enabled: () => !!ctl() || loading, run: () => ctl()?.toggleProblems() },
  "routes.allNamespaces": {
    enabled: () => !!ctl() || loading,
    run: () => {
      const pane = focusedPane();
      const v = pane ? paneView(pane) : undefined;
      if (!pane || v?.kind !== "routes") return;
      if (v.namespace) return replaceView(pane, { kind: "routes" });
      const ns = ctl()?.rowNamespace() ?? (() => {
        const here = paneNamespace(pane);
        return here && here !== "*" ? here : undefined;
      })();
      if (!ns) return flash("no row: :routes <namespace>", "warn");
      replaceView(pane, { kind: "routes", namespace: ns });
    },
  },
});

registerViewActions(["routes"], {
  "nav.down": () => ctl()?.move(1),
  "nav.up": () => ctl()?.move(-1),
  "nav.pageDown": () => ctl()?.page(1),
  "nav.pageUp": () => ctl()?.page(-1),
  "nav.top": () => ctl()?.edge("top"),
  "nav.bottom": () => ctl()?.edge("bottom"),
  "nav.open": { enabled: () => ctl()?.canOpen() ?? loading, run: (ctx) => ctl()?.open(ctx.newPane) },
  "view.refresh": { enabled: () => !!ctl() || loading, run: () => ctl()?.refresh() },
  "filter.open": () => ctl()?.filterOpen(),
  "filter.apply": { when: () => !!ctl()?.isFiltering(), run: () => ctl()?.filterApply() },
  "filter.cancel": { when: () => !!ctl()?.isFiltering(), run: () => ctl()?.filterCancel() },
  "filter.clear": { when: () => !!ctl()?.hasFilter() && !ctl()?.isFiltering(), run: () => ctl()?.filterClear() },
});
