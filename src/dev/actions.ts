// Action handlers of dev sets and the env view (docs/plan-features.md §2.7, §3 B-dev). Eager and
// small: views and dialogs are lazy. No key is named here.
import {
  closeOverlay, focusedContext, flash, focusedPane, isOverlayOpen, openView, paneView, registerActions, registerViewActions, showOverlay, toasts,
  type ActionContext,
} from "../foundation";
import { backend } from "../foundation";
import type { EnvView, PaneId } from "../types";
import { selectionTarget } from "../views/shell/open";
import { deleteSet, editSet, openExport, OVERLAY, saveDraft, saveRunning, startSet, stopSet, type SaveSetProps } from "./flows";
import { draftFromReport, draftUpdate, parseDevCommand, specOf, suggestName, validSetName } from "./model";
import { envCount, envCursor, envPane, loadEnv, setEnvCursor, setRevealed, setSetsCursor, setsPane, toggleKey } from "./state";
import { setNames } from "./names";
import { devSetById, devSetByName, errorText, getDevSets, refreshDevSets, runningSetIds } from "./store";

/** Kinds whose env `E` reads (a pod template). */
const ENV_KINDS = new Set(["pods", "deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "cronjobs"]);

// ── the picker (an overlay; it tells us its selected set) ──

let pickerSelected: (() => string | undefined) | null = null;
/** Called by DevPicker while mounted. */
export function setPickerSelection(fn: (() => string | undefined) | null): void {
  pickerSelected = fn;
}
const pickerOpen = () => isOverlayOpen(OVERLAY.picker) && pickerSelected !== null;
const pickedSet = () => {
  const id = pickerSelected?.();
  return id ? devSetById(id) : undefined;
};

function openPicker(ctx: ActionContext): void {
  if (ctx.newPane) {
    openView({ kind: "devsets" }, { newPane: ctx.newPane });
    return;
  }
  if (isOverlayOpen(OVERLAY.picker)) return closeOverlay(OVERLAY.picker);
  void refreshDevSets();
  showOverlay(OVERLAY.picker, {});
}

// ── focused views ──

const envPaneId = (): PaneId | null => {
  const pane = focusedPane();
  return pane && paneView(pane)?.kind === "env" ? pane : null;
};
const envView = (): EnvView | null => {
  const pane = envPaneId();
  const v = pane ? paneView(pane) : undefined;
  return v?.kind === "env" ? v : null;
};
const setsPaneId = (): PaneId | null => {
  const pane = focusedPane();
  return pane && paneView(pane)?.kind === "devsets" ? pane : null;
};
const cursorSet = () => {
  const pane = setsPaneId();
  if (!pane) return undefined;
  return getDevSets()[setsPane(pane)?.cursor ?? 0];
};
const hasSet = () => cursorSet() !== undefined || "no dev set selected";
const envLoaded = () => {
  const pane = envPaneId();
  return (pane !== null && envPane(pane)?.report !== null && envPane(pane)?.report !== undefined) || "the env is not loaded";
};

/** The env view's spec, report and context, for export and save. */
function envState() {
  const pane = envPaneId();
  const view = envView();
  const p = pane ? envPane(pane) : undefined;
  if (!pane || !view || !p?.report || !view.ref.namespace) return null;
  const workload = { gvr: view.ref.gvr, namespace: view.ref.namespace, name: view.ref.name };
  const set = view.devSet ? devSetById(view.devSet) : undefined;
  const spec = specOf(p.report, workload, p.included, set?.env?.format ?? "dotenv", set?.env?.overrides ?? p.report.overrides);
  return { pane, view, p, report: p.report, spec, set, context: p.context };
}

const runningIn = (context: string) => getDevSets().filter((s) => s.context === context && runningSetIds().includes(s.id));

registerActions({
  "dev.picker": (ctx) => {
    const cmd = parseDevCommand(ctx.args);
    const context = focusedContext();
    switch (cmd.kind) {
      case "picker":
        return openPicker(ctx);
      case "error":
        return flash(cmd.message, "warn");
      case "names":
        return setNames(cmd.on, cmd.port);
      case "save":
        return saveRunning(cmd.name);
      case "up": {
        if (!cmd.name) return openPicker(ctx);
        const set = devSetByName(cmd.name, context) ?? devSetByName(cmd.name);
        return set ? startSet(set) : flash(`no dev set "${cmd.name}"`, "warn");
      }
      case "down": {
        const sets = cmd.name ? [devSetByName(cmd.name, context) ?? devSetByName(cmd.name)].filter((s) => s !== undefined) : runningIn(context);
        if (sets.length === 0) return flash(cmd.name ? `no dev set "${cmd.name}"` : "no dev set is up", "warn");
        return Promise.all(sets.map((s) => stopSet(s))).then(() => undefined);
      }
    }
  },
  "picker.devDown": {
    when: pickerOpen,
    enabled: () => {
      const s = pickedSet();
      return (s !== undefined && runningSetIds().includes(s.id)) || "this set is not up";
    },
    run: () => {
      const s = pickedSet();
      return s ? stopSet(s) : undefined;
    },
  },
  "picker.devEdit": {
    when: pickerOpen,
    enabled: () => pickedSet() !== undefined || "no dev set selected",
    run: (ctx) => {
      const s = pickedSet();
      if (!s) return;
      closeOverlay(OVERLAY.picker);
      editSet(s, ctx.newPane);
    },
  },

  "dev.fromWorkload": {
    enabled: () => {
      const t = selectionTarget();
      if (!t) return "no row selected";
      if (!ENV_KINDS.has(t.ref.gvr.resource) && paneView()?.kind !== "containers") return `${t.ref.gvr.resource} have no env`;
      return true;
    },
    run: (ctx) => {
      const t = selectionTarget();
      if (!t) return;
      openView({ kind: "env", ref: t.ref, container: t.container }, { newPane: ctx.newPane });
    },
  },

  "dev.up": {
    enabled: hasSet,
    run: () => {
      const s = cursorSet();
      return s ? startSet(s) : undefined;
    },
  },
  "dev.down": {
    enabled: () => {
      const s = cursorSet();
      return (s !== undefined && runningSetIds().includes(s.id)) || "this set is not up";
    },
    run: () => {
      const s = cursorSet();
      return s ? stopSet(s) : undefined;
    },
  },
  "dev.edit": {
    enabled: hasSet,
    run: (ctx) => {
      const s = cursorSet();
      if (s) editSet(s, ctx.newPane);
    },
  },
  "dev.delete": {
    enabled: hasSet,
    run: () => {
      const s = cursorSet();
      return s ? deleteSet(s) : undefined;
    },
  },

  "env.toggleKey": {
    enabled: () => {
      const pane = envPaneId();
      const c = pane ? envCursor(pane) : null;
      if (c?.type !== "row") return "no env key selected";
      return (c.row.source !== "field" && c.row.source !== "resourceField") || "a field reference exists only in the pod";
    },
    run: () => {
      const pane = envPaneId();
      const c = pane ? envCursor(pane) : null;
      if (pane && c?.type === "row") toggleKey(pane, c.row.key);
    },
  },
  "env.reveal": {
    enabled: () => {
      const pane = envPaneId();
      const c = pane ? envCursor(pane) : null;
      if (c?.type !== "row") return "no env key selected";
      return c.row.masked || "the value is shown";
    },
    run: async () => {
      const pane = envPaneId();
      const view = envView();
      const p = pane ? envPane(pane) : undefined;
      const c = pane ? envCursor(pane) : null;
      if (!pane || !view || !p?.report || c?.type !== "row") return;
      if (p.revealed?.key === c.row.key) return setRevealed(pane, null);
      try {
        const value = await backend.envReveal({ context: p.context, gvr: view.ref.gvr, namespace: view.ref.namespace, name: view.ref.name }, p.report.container, c.row.key);
        // only if the cursor is still there
        const now = envCursor(pane);
        if (now?.type === "row" && now.row.key === c.row.key) setRevealed(pane, { key: c.row.key, value });
      } catch (e) {
        toasts.error(`Could not reveal ${c.row.key}: ${errorText(e)}`);
      }
    },
  },
  "env.export": {
    enabled: envLoaded,
    run: () => {
      const st = envState();
      if (st) openExport({ spec: st.spec, context: st.context, devSet: st.set?.id, report: st.report, clipboardOnly: false });
    },
  },
  "env.copyAs": {
    enabled: envLoaded,
    run: () => {
      const st = envState();
      if (st) openExport({ spec: st.spec, context: st.context, devSet: st.set?.id, report: st.report, clipboardOnly: true });
    },
  },
  "env.saveSet": {
    enabled: envLoaded,
    run: () => {
      const st = envState();
      if (!st) return;
      const { report, spec, set, context } = st;
      const name = set?.name ?? suggestName(st.view.ref.name);
      showOverlay(OVERLAY.save, {
        name,
        title: set ? `Update dev set ${set.name}` : "Save as dev set",
        autoStart: set?.autoStart ?? false,
        lines: [
          ...(set
            ? set.forwards.map((f) => `forward ${f.key}: ${f.target.kind}/${f.target.name}:${f.remotePort} → 127.0.0.1:${f.localPort} (kept)`)
            : report.deps.map((d) => `forward ${d.suggestedForward.key}: svc/${d.service.name}:${d.suggestedForward.remotePort} → 127.0.0.1:${d.suggestedForward.localPort}`)),
          `env of ${st.view.ref.gvr.resource}/${st.view.ref.name}: ${spec.include ? spec.include.length : report.rows.length} keys, ${(spec.includeSecrets ?? []).length} secret`,
          ...(spec.overrides ?? []).map((o) => `override ${o.key}=${o.value}`),
        ],
        onSave: async (n, autoStart) => {
          if (!validSetName(n)) return "1-40 of a-z 0-9 -";
          try {
            await saveDraft(set ? draftUpdate(set, spec, n, autoStart) : draftFromReport(n, context, report, spec, autoStart));
            return null;
          } catch (e) {
            return errorText(e);
          }
        },
        onCancel: () => {},
      } satisfies SaveSetProps);
    },
  },
});

// ── list keys of the two views ──

const PAGE = 20;
const envMove = (delta: number | "top" | "bottom") => () => {
  const pane = envPaneId();
  if (!pane) return;
  const p = envPane(pane);
  const n = envCount(pane);
  setEnvCursor(pane, delta === "top" ? 0 : delta === "bottom" ? n - 1 : (p?.cursor ?? 0) + delta);
};
registerViewActions(["env"], {
  "nav.down": envMove(1),
  "nav.up": envMove(-1),
  "nav.pageDown": envMove(PAGE),
  "nav.pageUp": envMove(-PAGE),
  "nav.top": envMove("top"),
  "nav.bottom": envMove("bottom"),
  // §2.7: Enter jumps to the row's source (ConfigMap, Secret reference, Service dependency)
  "nav.open": {
    enabled: () => {
      const pane = envPaneId();
      const c = pane ? envCursor(pane) : null;
      if (!c) return "nothing selected";
      if (c.type === "row" && !c.row.from?.match(/^(configmap|secret)\//)) return "a literal has no source object";
      return true;
    },
    run: (ctx) => {
      const pane = envPaneId();
      const view = envView();
      const c = pane ? envCursor(pane) : null;
      if (!c || !view) return;
      if (c.type === "dep") {
        openView({ kind: "doc", ref: { gvr: c.dep.service.gvr, namespace: c.dep.service.namespace, name: c.dep.service.name }, format: "describe", mode: "view", managedFields: false, wrap: false }, { newPane: ctx.newPane });
        return;
      }
      const m = c.row.from?.match(/^(configmap|secret)\/([^:]+)/);
      if (!m) return;
      const gvr = { group: "", version: "v1", resource: m[1] === "configmap" ? "configmaps" : "secrets" };
      openView({ kind: "doc", ref: { gvr, namespace: view.ref.namespace, name: m[2] }, format: "describe", mode: "view", managedFields: false, wrap: false }, { newPane: ctx.newPane });
    },
  },
  "view.refresh": () => {
    const pane = envPaneId();
    const view = envView();
    if (pane && view) void loadEnv(pane, view, true);
  },
});

const setsMove = (delta: number | "top" | "bottom") => () => {
  const pane = setsPaneId();
  if (!pane) return;
  const n = getDevSets().length;
  const cur = setsPane(pane)?.cursor ?? 0;
  setSetsCursor(pane, delta === "top" ? 0 : delta === "bottom" ? n - 1 : cur + delta, n);
};
registerViewActions(["devsets"], {
  "nav.down": setsMove(1),
  "nav.up": setsMove(-1),
  "nav.pageDown": setsMove(PAGE),
  "nav.pageUp": setsMove(-PAGE),
  "nav.top": setsMove("top"),
  "nav.bottom": setsMove("bottom"),
  // §2.7: Enter opens the set (its env view)
  "nav.open": {
    enabled: hasSet,
    run: (ctx) => {
      const s = cursorSet();
      if (s) editSet(s, ctx.newPane);
    },
  },
  "view.refresh": () => void refreshDevSets(),
});
