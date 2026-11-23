// Diff and field-owner actions (docs/plan-features.md §2.7, §3 D). Small and eager: keys work
// before the diff chunk or the CodeMirror chunk loads; handlers open views, flip per-pane state or
// call the focused pane's diff controller (session.ts), which the lazy DiffView registers.
import type { ActionContext } from "../actions";
import {
  backend, focusedContext, flash, focusedPane, getSelection, openView, paneView, patchView, registerActions, registerViewActions,
  replaceView, selectionTargets, toObjRef,
} from "../foundation";
import type { DiffView, DocView, ObjectRef, PaneId } from "../types";
import { APPLIED, diffView, hasRevisions, isSecretGvr, marksProblem, parseDiffArgs, prevPair } from "./args";
import { getOwners, patchOwners } from "./owners-state";
import { diffControllers, getDiffUi, type DiffController } from "./session";

const diff = (): DiffView | undefined => {
  const v = paneView();
  return v?.kind === "diff" ? v : undefined;
};
const ctl = (): DiffController | undefined => {
  const pane = focusedPane();
  return pane ? diffControllers.get(pane) : undefined;
};
const ready = (): true | string => (ctl() && !getDiffUi(focusedPane()).loading ? true : "loading");
const call = (fn: (c: DiffController) => void) => ({ run: () => { const c = ctl(); if (c) fn(c); }, enabled: ready });

/** The one object `:diff prev` / `:diff applied` / `:owners` act on: what the focused view shows, else its cursor row. */
function target(): ObjectRef | null {
  const pane = focusedPane();
  if (!pane) return null;
  const v = paneView(pane);
  if (v?.kind === "doc") return v.ref;
  if (v?.kind === "containers") return v.pod;
  return getSelection(pane).focused ?? selectionTargets(pane)[0] ?? null;
}

const errorText = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e);

async function openPrev(ref: ObjectRef, ctx: ActionContext): Promise<void> {
  if (!hasRevisions(ref.gvr)) return flash(`${ref.gvr.resource} have no revisions (deployments, statefulsets, daemonsets, helmreleases do)`, "warn");
  let revs;
  try {
    revs = await backend.revisions(toObjRef(ref, focusedContext()));
  } catch (e) {
    return flash(errorText(e), "warn");
  }
  const pair = prevPair(revs);
  if (typeof pair === "string") return flash(`${ref.name}: ${pair}`, "warn");
  const [older, newer] = pair;
  openView(diffView({ revision: { owner: ref, id: older.id } }, { revision: { owner: ref, id: newer.id } }), { newPane: ctx.newPane });
}

registerActions({
  // D on two marked rows; `:diff prev` / `:diff applied` on one object
  "res.diff": {
    enabled: (ctx) => {
      const pane = focusedPane();
      const parsed = parseDiffArgs(ctx.args);
      if ("error" in parsed) return true; // run says how
      if (parsed.mode !== "marks") return target() ? true : "no row selected";
      if (!pane || paneView(pane)?.kind !== "table") return "mark two rows in a table";
      return marksProblem(getSelection(pane).marked) ?? true;
    },
    run: async (ctx) => {
      const parsed = parseDiffArgs(ctx.args);
      if ("error" in parsed) return flash(parsed.error, "warn");
      if (parsed.mode === "marks") {
        const pane = focusedPane();
        const marked = pane ? getSelection(pane).marked : [];
        const problem = marksProblem(marked);
        if (problem) return flash(problem, "warn");
        openView(diffView({ ref: marked[0] }, { ref: marked[1] }), { newPane: ctx.newPane });
        return;
      }
      const ref = target();
      if (!ref) return flash("no row selected", "warn");
      if (parsed.mode === "prev") return openPrev(ref, ctx);
      if (isSecretGvr(ref.gvr)) return flash("A Secret's last-applied configuration holds its values; it is not diffed", "warn");
      openView(diffView({ revision: { owner: ref, id: APPLIED } }, { ref }), { newPane: ctx.newPane });
    },
  },
  "diff.managedFields": () => {
    const pane = focusedPane();
    const v = diff();
    if (pane && v) patchView(pane, "diff", { managedFields: !v.managedFields });
  },
  "diff.split": () => {
    const pane = focusedPane();
    const v = diff();
    if (pane && v) patchView(pane, "diff", { split: !v.split });
  },
  "diff.nextHunk": { run: () => ctl()?.hunk(1), enabled: () => (getDiffUi(focusedPane()).chunks > 0 ? true : "no changes") },
  "diff.prevHunk": { run: () => ctl()?.hunk(-1), enabled: () => (getDiffUi(focusedPane()).chunks > 0 ? true : "no changes") },

  // YAML field owners (the gutter is src/views/doc/ownership.ts)
  "doc.fieldOwners": { enabled: ownersEnabled, run: (ctx) => owners(ctx, "toggle") },
  "doc.driftOnly": { enabled: ownersEnabled, run: (ctx) => owners(ctx, "drift") },
});

function ownersEnabled(): true | string {
  const v = paneView();
  if (v?.kind === "doc") {
    if (v.mode !== "view") return "leave the edit first";
    if (v.format === "secret") return "a secret has no YAML view here";
    return true;
  }
  return target() ? true : "no row selected";
}

/**
 * `O` / `:owners` toggles the letters in a YAML view; from describe or JSON it switches that pane to
 * YAML; from a table it opens the cursor row's YAML. `:drift` does the same with drift-only on.
 */
function owners(ctx: ActionContext, what: "toggle" | "drift"): void {
  const pane = focusedPane();
  if (!pane) return;
  const v = paneView(pane);
  const turnOn = (p: PaneId) => patchOwners(p, what === "drift" ? { on: true, drift: true } : { on: true });
  if (v?.kind === "doc" && v.mode === "view" && v.format !== "secret" && !ctx.newPane) {
    if (v.format !== "yaml") {
      replaceView(pane, { ...v, format: "yaml" } satisfies DocView);
      return turnOn(pane);
    }
    const cur = getOwners(pane);
    if (what === "drift") patchOwners(pane, cur.drift ? { drift: false } : { on: true, drift: true });
    else patchOwners(pane, { on: !cur.on });
    return;
  }
  const ref = target();
  if (!ref) return flash("no row selected", "warn");
  if (isSecretGvr(ref.gvr)) return flash("a secret has no YAML view here", "warn");
  const opened = openView({ kind: "doc", ref, format: "yaml", mode: "view", managedFields: false, wrap: false }, { newPane: ctx.newPane });
  if (opened) turnOn(opened);
}

// Ids that other views implement too: dispatched by the focused pane's view kind.
registerViewActions(["diff"], {
  "nav.down": call((c) => c.scroll(1)),
  "nav.up": call((c) => c.scroll(-1)),
  "nav.top": call((c) => c.edge("top")),
  "nav.bottom": call((c) => c.edge("bottom")),
  "nav.pageUp": call((c) => c.page(-1)),
  "nav.pageDown": call((c) => c.page(1)),
  // Enter: show / hide the unchanged lines (the folded "n unchanged lines" bars)
  "nav.open": call((c) => c.toggleExpanded()),
  "view.refresh": call((c) => c.refresh()),
});
