// Feature: logs (docs/ux.md §13.3, docs/plan-features.md §3 E). View kinds: logs, patterns.
// Actions: res.logs, res.logsPrevious, logs.* (incl. structured, patterns, goToPod),
// patterns.errorsOnly, and for the logs and patterns views nav.*, filter.*, search.*, select.*,
// view.refresh (./actions, eager and small). The views, the line list, the container picker and
// the patterns miner (a module worker) load lazily.
import { crumbsOf, defaultCrumbs, openView, paneView, registerOverlay, registerView, type Crumb } from "../../foundation";
import { setToolBuilt } from "../../hub/catalog";
import { setObjectsLogsOpener } from "../../table/actions";
import type { LogsView } from "../../types";
import { CONTAINER_OVERLAY } from "./actions";
import { objectsTarget, targetName } from "./targets";

/** Merged logs: one pane over every marked row (plan-features §2.10a), all containers. */
function openMerged(refs: Parameters<typeof objectsTarget>[0], newPane: "right" | "down" | null): void {
  const view: LogsView = {
    kind: "logs", target: objectsTarget(refs), container: "*", since: "tail", previous: false, wrap: false, timestamps: false, filterLines: false,
  };
  openView(view, { newPane });
}

export function register(): void {
  registerView({
    kinds: ["logs"],
    component: () => import("./LogsView"),
    crumbs: (v): Crumb[] => {
      if (v.target.by !== "objects") return defaultCrumbs(v);
      const namespaces = new Set(v.target.refs.map((r) => r.namespace ?? ""));
      const ns = namespaces.size === 1 ? [...namespaces][0] : "";
      return [...(ns ? [{ label: ns }] : []), { label: targetName(v.target) }, { label: "logs" }];
    },
  });
  registerView({
    kinds: ["patterns"],
    component: () => import("./PatternsView"),
    crumbs: (v): Crumb[] => {
      const source = paneView(v.source);
      const head = source?.kind === "logs" ? crumbsOf(source).slice(0, -1).map((c) => ({ label: c.label })) : [];
      return [...head, { label: "patterns" }];
    },
  });
  registerOverlay(CONTAINER_OVERLAY, () => import("./ContainerPicker"));
  setObjectsLogsOpener(openMerged);
  setToolBuilt("logs-merged");
}
