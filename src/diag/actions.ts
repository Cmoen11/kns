// `:why` actions (docs/plan-features.md §2.7, §3 C1). Small and eager: keys work before the lazy
// view loads; handlers open the view or call the focused pane's controller (./controller).
import { engine, focusedPane, getSelection, openView, paneView, registerActions, registerViewActions, type ActionContext } from "../foundation";
import type { ObjectRef } from "../types";
import { whyController } from "./controller";
import { canWhy, WHY_SCOPE_REASON } from "./why-model";

const PAGE = 10;

/** The object `W` explains: the cursor row of a table, or the pod of a containers view. */
export function whyTarget(): ObjectRef | null {
  const pane = focusedPane();
  if (!pane) return null;
  const v = paneView(pane);
  if (v?.kind === "containers") return v.pod;
  if (v?.kind === "table") return getSelection(pane).focused ?? null;
  return null;
}

/** Applicable: a containers view, or a table of a kind with rules (else `W` is absent, no dead button). */
function applies(): boolean {
  const v = paneView();
  return v?.kind === "containers" || (v?.kind === "table" && canWhy(v.gvr));
}

function openWhy(ctx: ActionContext): void {
  const ref = whyTarget();
  if (!ref || !canWhy(ref.gvr)) return;
  const view = { kind: "why" as const, ref: { gvr: ref.gvr, namespace: ref.namespace, name: ref.name, uid: ref.uid } };
  // §2.10a: opened beside it follows the source like describe (followsByDefault lists only doc/logs)
  openView(view, ctx.newPane ? { newPane: ctx.newPane, follow: true } : {});
}

const ctl = whyController;
const loaded = (): true | string => (ctl()?.loaded() ? true : "loading");

registerActions({
  "res.why": {
    when: applies,
    enabled: () => {
      const ref = whyTarget();
      if (!ref) return "no row selected";
      return canWhy(ref.gvr) || WHY_SCOPE_REASON;
    },
    run: openWhy,
  },
  "why.copy": { enabled: loaded, run: () => void ctl()?.copy() },
});

registerViewActions(["why"], {
  "nav.down": () => ctl()?.move(1),
  "nav.up": () => ctl()?.move(-1),
  "nav.pageDown": () => ctl()?.move(PAGE),
  "nav.pageUp": () => ctl()?.move(-PAGE),
  "nav.top": () => ctl()?.moveTo("top"),
  "nav.bottom": () => ctl()?.moveTo("bottom"),
  "nav.open": { enabled: () => ctl()?.canOpen() ?? "loading", run: (ctx) => ctl()?.open(ctx.newPane) },
  "view.refresh": () => ctl()?.refresh(),
});

/** The view calls this when its state changes what `enabled` reads. */
export const invalidateWhy = (): void => engine.invalidate();
