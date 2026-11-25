// Table actions (docs/ux.md §5.4 Navigation, Table, and the view-opening part of Resource).
// Small and eager: every handler delegates to the focused pane's TableModel (./registry), which
// the lazy view registers when it mounts. No model = no table on screen = "no row selected".
import { flash, focusedPane, getSelection, getSettings, paneView, patchView, registerActions, registerViewActions, setNamespace, setSettings, type ActionContext } from "../foundation";
import type { ObjectRef } from "../types";
import { modelOf } from "./registry";
import type { OpenWhat, SortTarget } from "./model";

const m = () => modelOf();
const hasRow = (): true | string => (m()?.hasRow() ? true : "no row selected");
const open = (what: OpenWhat) => ({
  run: (ctx: ActionContext) => m()?.open(what, ctx.newPane),
  enabled: hasRow,
});
const sort = (target: SortTarget) => ({
  run: () => m()?.sortBy(target),
  enabled: (): true | string => (m()?.canSort(target) ? true : "this table has no such column"),
});
const inMenu = () => !!m()?.columnsOpen;

// Merged logs (plan-features §2.10a): with more than one row marked, `l` opens one logs pane over
// all of them once the logs feature (E) provides the opener (LogTarget `{ by: "objects" }`).
type ObjectsLogsOpener = (refs: readonly ObjectRef[], newPane: ActionContext["newPane"]) => void;
let objectsLogs: ObjectsLogsOpener | null = null;
/** E calls this from its register() when the logs view takes `{ by: "objects", refs }`. */
export function setObjectsLogsOpener(open: ObjectsLogsOpener | null): void {
  objectsLogs = open;
}
export const supportsObjectsTarget = (): boolean => objectsLogs !== null;

function openLogs(ctx: ActionContext): void {
  const pane = focusedPane();
  const marked = pane ? getSelection(pane).marked : [];
  // marks win over the cursor row, as for every bulk action (one mark included)
  if (marked.length > 0 && objectsLogs) objectsLogs(marked, ctx.newPane);
  else m()?.open("logs", ctx.newPane);
}

// Ids that other views implement too (logs, doc, home ...): dispatched on the focused view kind.
registerViewActions(["table", "containers"], {
  "nav.down": () => m()?.move(1),
  "nav.up": () => m()?.move(-1),
  "nav.top": () => m()?.moveTo("top"),
  "nav.bottom": () => m()?.moveTo("bottom"),
  "nav.pageDown": () => m()?.page(1),
  "nav.pageUp": () => m()?.page(-1),
  "nav.open": open("drill"),

  "filter.open": () => m()?.openFilter(),
  "filter.apply": { when: () => !!m()?.filter.open, run: () => m()?.applyFilter() },
  "filter.cancel": { when: () => !!m()?.filter.open, run: () => m()?.cancelFilter() },
  "filter.cycleMode": { when: () => !!m()?.filter.open, run: () => m()?.cycleMode() },
  "filter.clearText": { when: () => !!m()?.filter.open, run: () => m()?.setFilterText("") },
  "filter.chipFocusLeft": { when: () => !!m()?.filterInputEmpty(), run: () => m()?.chipFocus(-1) },
  "filter.chipFocusRight": { when: () => !!m()?.filterInputEmpty(), run: () => m()?.chipFocus(1) },
  "filter.chipRemove": { when: () => !!m()?.filterInputEmpty(), run: () => m()?.chipRemove() },
  // Esc ladder step 8 (§4.2): absent without chips, so Esc falls through to nav.back
  "filter.clear": { when: () => !!m()?.hasChips(), run: () => m()?.clearLastChip() },

  "view.refresh": () => m()?.refresh(),

  // The logs view is owned by src/views/logs; the cursor row is the target. describe / yaml / edit
  // and the shell are registered by their own features, which read the selection store.
  "res.logs": { run: openLogs, enabled: hasRow },
  "res.logsPrevious": open("logsPrevious"),
});

registerActions({
  "nav.scrollLeft": () => m()?.scrollH(-1),
  "nav.scrollRight": () => m()?.scrollH(1),

  "filter.faults": () => {
    const t = m();
    t?.src.setFaults(!t.src.faultsOnly);
  },
  "view.wide": () => {
    const t = m();
    t?.src.setWide(!t.src.wide);
  },
  // a setting, not per view: every table follows it (Settings: Hide namespace prefix)
  "view.stripNs": () => setSettings({ stripNsPrefix: !getSettings().stripNsPrefix }),

  "sort.name": sort("name"),
  "sort.age": sort("age"),
  "sort.status": sort("status"),
  "sort.namespace": sort("namespace"),
  "sort.selectedColumn": sort("selected"),
  "column.selectLeft": () => m()?.selectColumn(-1),
  "column.selectRight": () => m()?.selectColumn(1),
  "column.narrower": {
    run: () => (inMenu() ? m()?.menuResize(-1) : m()?.resizeColumn(-1)),
    enabled: () => inMenu() || m()?.selectedCol != null || "select a column first",
  },
  "column.wider": {
    run: () => (inMenu() ? m()?.menuResize(1) : m()?.resizeColumn(1)),
    enabled: () => inMenu() || m()?.selectedCol != null || "select a column first",
  },

  // no key by default: the column header's menu and the palette
  "column.hide": { run: () => m()?.hideSelected(), enabled: () => m()?.canHideSelected() ?? "no table" },

  "view.columns": () => m()?.toggleColumns(),
  "columns.close": () => m()?.closeColumns(),
  "columns.moveDown": () => m()?.menuMove(1),
  "columns.moveUp": () => m()?.menuMove(-1),
  "columns.toggle": () => m()?.menuToggle(),
  "columns.pin": () => m()?.menuPin(),
  "columns.reorderDown": () => m()?.menuReorder(1),
  "columns.reorderUp": () => m()?.menuReorder(-1),
  "columns.fit": () => m()?.menuFit(),
  "columns.reset": () => m()?.menuReset(),

  // a click on a row's checkbox (or "mark" in its menu) stays on that row; Space moves on
  "mark.toggle": { run: (ctx) => m()?.toggleMark(ctx.source !== "pointer" && ctx.source !== "menu"), enabled: hasRow },
  "mark.range": {
    run: (ctx) => m()?.markRange(ctx.chord?.endsWith("Down") ? 1 : ctx.chord?.endsWith("Up") ? -1 : 0),
    enabled: hasRow,
  },
  "mark.all": () => m()?.markAll(),
  // Esc ladder step 7: absent without marks
  "mark.clear": { when: () => (m()?.marks.size ?? 0) > 0, run: () => m()?.clearMarks() },

  "copy.name": { run: () => m()?.copy("name"), enabled: hasRow },
  "copy.namespace": {
    run: () => m()?.copy("namespace"),
    enabled: () => (m()?.cursorRow()?.namespace ? true : m()?.hasRow() ? "this kind is cluster-scoped" : "no row selected"),
  },
  "copy.cell": { run: () => m()?.copy("cell"), enabled: hasRow },

  // `0`: all namespaces (the scope table.namespaced keeps it off cluster-scoped kinds)
  "namespace.all": () => {
    const pane = focusedPane();
    const v = paneView();
    if (pane && v?.kind === "table" && v.namespace !== "*") setNamespace("*", pane);
  },
  // `u` on a namespace row: the pane's namespace becomes that one; nothing is pushed (§4.3)
  "namespace.use": {
    run: () => {
      const pane = focusedPane();
      const name = m()?.cursorRow()?.name;
      if (!pane || !name) return;
      patchView(pane, "table", { namespace: name });
      flash(`namespace: ${name}`);
    },
    enabled: hasRow,
  },
});
