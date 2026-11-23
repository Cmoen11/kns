// Reach and relations actions (docs/plan-features.md §2.7, §3 C3). Small and eager: keys work
// before the lazy views load; handlers open views and the target dialog or call the focused pane's
// controller (./c3-controller). No key is named here. `:` commands skip the scope check, so each
// handler checks its own target.
import { focusedContext, engine, flash, focusedPane, getSelection, openView, paneView, registerActions, registerViewActions, showOverlay, type ActionContext } from "../foundation";
import type { ObjectRef } from "../types";
import { reachControllers, relationsControllers } from "./c3-controller";
import { isPod, parseReachArgs } from "./reach-model";

export const REACH_OVERLAY = "diag.reach";
const PAGE = 10;

export interface ReachDialogProps {
  from: ObjectRef;
  context: string;
}

/** The object the action is about: a table's cursor row, or the pod of a containers view. */
export function c3Target(): ObjectRef | null {
  const pane = focusedPane();
  if (!pane) return null;
  const v = paneView(pane);
  if (v?.kind === "containers") return v.pod;
  if (v?.kind === "table") return getSelection(pane).focused ?? null;
  // the reach view itself: `:reach other:80` starts again from the same pod
  if (v?.kind === "reach") return v.from;
  if (v?.kind === "relations") return v.ref;
  return null;
}

const bare = (r: ObjectRef): ObjectRef => ({ gvr: r.gvr, namespace: r.namespace, name: r.name });

function openReach(ctx: ActionContext): void {
  const from = c3Target();
  const context = focusedContext();
  if (!from || !isPod(from) || !context) return;
  if (!ctx.args?.length) {
    showOverlay(REACH_OVERLAY, { from: bare(from), context } satisfies ReachDialogProps);
    return;
  }
  const parsed = parseReachArgs(ctx.args, from.namespace ?? "default");
  if (typeof parsed === "string") {
    flash(parsed, "warn");
    return;
  }
  openView({ kind: "reach", from: bare(from), to: parsed.to, port: parsed.port }, ctx.newPane ? { newPane: ctx.newPane } : {});
}

function openRelations(ctx: ActionContext): void {
  const ref = c3Target();
  if (!ref) return;
  openView({ kind: "relations", ref: bare(ref) }, ctx.newPane ? { newPane: ctx.newPane } : {});
}

const rel = () => relationsControllers.get();
const rc = () => reachControllers.get();

registerActions({
  "res.reach": {
    enabled: () => {
      const t = c3Target();
      if (!t) return "no row selected";
      return isPod(t) || "reach starts from a pod";
    },
    run: openReach,
  },
  "res.relations": {
    enabled: () => (c3Target() ? true : "no row selected"),
    run: openRelations,
  },
  "relations.collapse": { enabled: () => rel()?.canFold("collapse") ?? "loading", run: () => rel()?.fold("collapse") },
  "relations.expand": { enabled: () => rel()?.canFold("expand") ?? "loading", run: () => rel()?.fold("expand") },
});

registerViewActions(["relations"], {
  "nav.down": () => rel()?.move(1),
  "nav.up": () => rel()?.move(-1),
  "nav.pageDown": () => rel()?.move(PAGE),
  "nav.pageUp": () => rel()?.move(-PAGE),
  "nav.top": () => rel()?.moveTo("top"),
  "nav.bottom": () => rel()?.moveTo("bottom"),
  "nav.open": { enabled: () => rel()?.canOpen() ?? "loading", run: (ctx) => rel()?.open(ctx.newPane) },
  "view.refresh": () => rel()?.refresh(),
});

registerViewActions(["reach"], {
  "nav.down": () => rc()?.move(1),
  "nav.up": () => rc()?.move(-1),
  "nav.pageDown": () => rc()?.move(PAGE),
  "nav.pageUp": () => rc()?.move(-PAGE),
  "nav.top": () => rc()?.moveTo("top"),
  "nav.bottom": () => rc()?.moveTo("bottom"),
  "nav.open": { enabled: () => rc()?.canOpen() ?? "loading", run: (ctx) => rc()?.open(ctx.newPane) },
  "view.refresh": () => rc()?.refresh(),
});

/** The views call this when their state changes what `enabled` reads. */
export const invalidateC3 = (): void => engine.invalidate();
