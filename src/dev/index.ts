// Dev sets, env view, dev from workload (docs/plan-features.md §3 B-dev). Owner: B-dev (wave 1), B2 (wave 2).
// Registers the env and devsets views, the picker and the dialogs, the bottom-row `dev` item, the
// Home "Dev sets" section and the Tools-hub status. Views and dialogs are lazy chunks.
import { createElement, useMemo } from "react";
import { engine, openView, registerOverlay, registerShellItem, registerView } from "../foundation";
import { registerToolStatus, setToolBuilt } from "../hub/catalog";
import type { DevSet, Forward } from "../ipc/types";
import { actionTip, keepFocus } from "../ui";
import { useForwards } from "../views/shell/forwards";
import type { ItemRow } from "../views/tools/list-model";
import { registerHomeSection } from "../views/tools/home-sections";
import "./actions";
import { CONN_OVERLAY } from "./conn";
import { OVERLAY, startSet } from "./flows";
import { initNames, namesStatusText, useNames } from "./names";
import { approved, originText, statusText } from "./model";
import { registerActivityGroup, type GroupRows } from "../sidepanels/groups";
import type { PanelRow } from "../sidepanels/model";
import { clearFailures, devSetById, initDevSets, useDevSets, useRunningSetIds } from "./store";

/** Name of the running set(s) for the bottom row and the hub; a stable string. */
function useStatus(): string | null {
  const sets = useDevSets((s) => s.sets);
  const running = useRunningSetIds();
  const forwards = useForwards((s) => s.list);
  return useMemo(() => statusText(sets, running, forwards as Forward[]), [sets, running, forwards]);
}

/** Bottom row: `dev orders-dev`, a click opens the picker. Nothing while no set is up. */
function DevIndicator() {
  const text = useStatus();
  if (!text) return null;
  return createElement(
    "button",
    {
      type: "button",
      className: "pf-indicator t-ui",
      tabIndex: -1,
      ...actionTip("dev.picker", "Dev sets"),
      "aria-label": `Dev sets: ${text}`,
      onMouseDown: keepFocus,
      onClick: () => engine.run("dev.picker", { source: "pointer" }),
    },
    `dev ${text.replace(/ · .*$/, "").replace(/ up$/, "")}`,
  );
}

function setRow(s: DevSet, running: readonly string[]): ItemRow {
  const up = running.includes(s.id);
  return {
    type: "item",
    key: s.id,
    cells: [s.name, `${s.context} · ${s.forwards.length} forward${s.forwards.length === 1 ? "" : "s"} · ${originText(s)}`],
    value: up ? "up" : approved(s) ? "" : "review",
    glyph: up ? "ok" : approved(s) ? undefined : "warn",
    open: (newPane) => (newPane || up ? openView({ kind: "devsets", selected: s.id }, { newPane }) : void startSet(s)),
  };
}

const NO_ROWS: GroupRows = { rows: [] };

/** Activity "Dev sets": autoStart failures until the set comes up or the row is cleared. */
function useFailureRows(): GroupRows {
  const failures = useDevSets((s) => s.failures);
  return useMemo(() => {
    if (failures.length === 0) return NO_ROWS;
    const rows: PanelRow[] = failures.map((f) => ({
      key: `devfail:${f.devSet}`,
      section: "devfail",
      label: `${f.name} did not start`,
      detail: `${f.context} · ${f.message} · Enter retries, x dismisses`,
      since: Date.parse(f.at) || undefined,
      glyph: "error",
      activate: () => {
        const s = devSetById(f.devSet);
        return s ? startSet(s) : clearFailures([f.devSet]);
      },
      stop: () => clearFailures([f.devSet]),
    }));
    return { rows, clear: () => clearFailures(failures.map((f) => f.devSet)) };
  }, [failures]);
}

function useHomeRows(): readonly ItemRow[] {
  const sets = useDevSets((s) => s.sets);
  const running = useRunningSetIds();
  return useMemo(() => sets.map((s) => setRow(s, running)), [sets, running]);
}

export function register(): void {
  registerView({
    kinds: ["env"],
    component: () => import("./EnvView"),
    crumbs: (v) => [
      ...(v.ref.namespace ? [{ label: v.ref.namespace }] : []),
      { label: `${v.ref.gvr.resource}/${v.ref.name}` },
      { label: v.container ? `env · ${v.container}` : "env" },
    ],
  });
  registerView({ kinds: ["devsets"], component: () => import("./DevSetsView"), crumbs: () => [{ label: "dev sets" }] });
  registerOverlay(OVERLAY.picker, () => import("./DevPicker"));
  registerOverlay(OVERLAY.approve, () => import("./ApproveSetDialog"));
  registerOverlay(OVERLAY.export, () => import("./ExportDialog"));
  registerOverlay(OVERLAY.save, () => import("./SaveSetDialog"));
  // B2: connection strings (pf.copyUrl) and names on one port (:dev names)
  registerOverlay(CONN_OVERLAY, () => import("./ConnDialog"));
  registerToolStatus("names", () => namesStatusText(useNames((s) => s.status)));
  setToolBuilt("names");
  initNames();
  registerShellItem({ id: "dev", area: "status", order: 12, component: DevIndicator });
  registerHomeSection({ id: "devsets", label: "Dev sets", order: 20, useRows: useHomeRows });
  registerActivityGroup({ id: "devfail", label: "Dev sets not started", order: 12, useRows: useFailureRows });
  registerToolStatus("devsets", () => {
    const text = useStatus();
    const count = useDevSets((s) => s.sets.length);
    if (text) return { text, state: "active" };
    return count > 0 ? { text: `${count} saved`, state: "off" } : null;
  });
  initDevSets();
}
