// `leader c` / `:pack` (docs/plan-features.md §3 G): a redacted context pack of what "this" is,
// opened as a `text` preview. Small and eager; the pack itself is made in Rust when the view loads.
import { focusedContext, focusedPane, getSelection, openView, paneView, registerActions, type ActionContext } from "../foundation";
import { currentObject } from "../store/current";
import type { ObjectRef } from "../types";
import { MAX_PACK_REFS, packTitle } from "./model";

const plain = (r: ObjectRef): ObjectRef => ({ gvr: r.gvr, namespace: r.namespace, name: r.name });

/**
 * The objects a pack is made of: the marked rows (else the cursor row) of a table, the pod of a
 * containers view, the object of a describe / YAML / why / env view or of a logs pane, else
 * `currentObject()` (the table the focused view was opened over, or the last table).
 */
export function packTargets(): ObjectRef[] {
  const pane = focusedPane();
  const v = pane ? paneView(pane) : undefined;
  if (pane && v) {
    switch (v.kind) {
      case "table": {
        const sel = getSelection(pane);
        if (sel.marked.length) return sel.marked.map(plain);
        return sel.focused ? [plain(sel.focused)] : [];
      }
      case "containers":
        return [plain(v.pod)];
      case "doc":
      case "why":
      case "env":
      case "timeline":
        return [plain(v.ref)];
      case "logs":
        if (v.target.by === "object") return [plain(v.target.ref)];
        if (v.target.by === "objects") return v.target.refs.map(plain);
        break;
      default:
        break;
    }
  }
  const cur = currentObject();
  if (!cur) return [];
  return cur.marked.length ? cur.marked.map(plain) : [plain(cur.ref)];
}

function enabled(): true | string {
  if (!focusedContext()) return "not connected";
  const refs = packTargets();
  if (refs.length === 0) return "select a row first";
  if (refs.length > MAX_PACK_REFS) return `a pack takes at most ${MAX_PACK_REFS} objects (${refs.length} marked)`;
  return true;
}

function openPack(ctx: ActionContext): void {
  const refs = packTargets();
  if (refs.length === 0 || refs.length > MAX_PACK_REFS) return;
  openView({ kind: "text", title: packTitle(refs), source: { by: "pack", refs } }, ctx.newPane ? { newPane: ctx.newPane } : {});
}

registerActions({
  "res.pack": { enabled, run: openPack },
});
