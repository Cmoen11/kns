// `:traffic` and the keys of the traffic view (docs/tools.md#traffic). Small and eager: the view
// loads lazily. The handlers ask first (an exec in the pod), then open the view, which reads.
import {
  backend, confirm, contextFlags, flash, focusedContext, focusedPane, getSelection, objectFacts, openView, paneView, registerActions, registerViewActions, toObjRef, toasts,
} from "../foundation";
import type { ObjectRef, PaneId } from "../types";
import { ctl } from "../views/tools/controllers";

const PODS = { group: "", version: "v1", resource: "pods" };
const isPod = (r: ObjectRef) => r.gvr.group === "" && r.gvr.resource === "pods";
const errorText = (e: unknown) => (e as { message?: string } | null)?.message ?? String(e);

/** The object the action is about: a table's cursor row, the pod of a containers view, the pod of this view. */
function target(): { ref: ObjectRef; container?: string } | null {
  const pane = focusedPane();
  if (!pane) return null;
  const v = paneView(pane);
  if (v?.kind === "containers") return { ref: v.pod };
  if (v?.kind === "table") {
    const r = getSelection(pane).focused;
    return r ? { ref: r } : null;
  }
  if (v?.kind === "traffic") return { ref: v.pod, container: v.container };
  return null;
}

/** The pod behind a row: the pod itself, else a running pod of the workload. */
async function podOf(ref: ObjectRef, context: string): Promise<ObjectRef | null> {
  if (isPod(ref)) return { gvr: ref.gvr, namespace: ref.namespace, name: ref.name };
  try {
    const pods = await backend.podsFor(toObjRef(ref, context));
    const p = pods.find((x) => x.phase === "Running") ?? pods[0];
    if (!p) {
      flash(`no pod behind ${ref.name}`, "warn");
      return null;
    }
    return { gvr: PODS, namespace: p.namespace, name: p.name };
  } catch (e) {
    toasts.error(`Could not find the pods of ${ref.name}: ${errorText(e)}`);
    return null;
  }
}

// ── the view's controls, for the keys ─────────────────────────────────────────

export interface TrafficControls {
  togglePause(): void;
  clear(): void;
  paused(): boolean;
}
const controls = new Map<PaneId, TrafficControls>();
export function setTrafficControls(pane: PaneId, c: TrafficControls): () => void {
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
  "res.traffic": {
    enabled: () => (target() ? true : "no row selected"),
    run: async (ctx) => {
      const t = target();
      const context = focusedContext();
      if (!t || !context) return;
      const workload = t.ref.gvr.resource !== "pods" ? t.ref.name : undefined;
      const pod = await podOf(t.ref, context);
      if (!pod) return;
      const ok = await confirm({
        tier: 1,
        title: "Read the pod's connections",
        body: `Runs \`cat /proc/net/tcp /proc/net/tcp6 /proc/net/udp /proc/net/udp6\` in ${pod.name}${workload ? ` (a pod of ${workload})` : ""} every 3 seconds while the view is open, to list who it talks to. Nothing is changed.`,
        facts: objectFacts({ kind: "Pod", name: pod.name, namespace: pod.namespace, context, protected: contextFlags(context).protected }),
        confirmLabel: "Read",
      });
      if (!ok) return;
      openView({ kind: "traffic", pod, container: isPod(t.ref) ? t.container : undefined }, ctx.newPane ? { newPane: ctx.newPane } : {});
    },
  },
  "traffic.pause": { enabled: () => !!ctrl() || "loading", run: () => ctrl()?.togglePause() },
  "traffic.clear": { enabled: () => !!ctrl() || "loading", run: () => ctrl()?.clear() },
});

const current = () => ctl()?.current();
registerViewActions(["traffic"], {
  "nav.down": () => ctl()?.move(1),
  "nav.up": () => ctl()?.move(-1),
  "nav.top": () => ctl()?.top(),
  "nav.bottom": () => ctl()?.bottom(),
  "nav.pageDown": () => ctl()?.page(1),
  "nav.pageUp": () => ctl()?.page(-1),
  "nav.open": {
    enabled: () => (!current() ? "no row selected" : !!current()?.open || "an address outside the cluster"),
    run: (ctx) => current()?.open?.(ctx.newPane),
  },
  "filter.open": () => ctl()?.filterOpen(),
  "filter.apply": { when: () => !!ctl()?.isFiltering(), run: () => ctl()?.filterApply() },
  "filter.cancel": { when: () => !!ctl()?.isFiltering(), run: () => ctl()?.filterCancel() },
  "filter.clear": { when: () => !!ctl()?.hasFilter() && !ctl()?.isFiltering(), run: () => ctl()?.filterClear() },
});
