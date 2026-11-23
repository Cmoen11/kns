// Feature D: diff anything (two marked rows, revision vs revision, live vs last-applied) and the
// field-ownership gutter in YAML (docs/plan-features.md §3 D). The view and the gutter are lazy;
// actions.ts is the small eager part.
import { getWorkspace, layoutStore, registerView } from "../foundation";
import { registerToolStatus } from "../hub/catalog";
import type { DiffSide, DiffView } from "../types";
import "./actions";
import { isApplied } from "./args";
import { clearOwners, ownersStore, useOwnersPaneCount } from "./owners-state";
import { useDiffPaneCount } from "./session";

const sideCrumb = (s: DiffSide, other: DiffSide): string => {
  if (!("ref" in s)) return isApplied(s) ? `${s.revision.owner.name} last-applied` : s.revision.id;
  // the same name in two namespaces (or kinds): say which
  const same = "ref" in other && other.ref.name === s.ref.name;
  return same && s.ref.namespace ? `${s.ref.namespace}/${s.ref.name}` : s.ref.name;
};

export function register(): void {
  registerView({
    kinds: ["diff"],
    component: () => import("./DiffView"),
    crumbs: (v: DiffView) => [{ label: "diff" }, { label: `${sideCrumb(v.left, v.right)} ↔ ${sideCrumb(v.right, v.left)}` }],
    toolbar: (v: DiffView) => [
      { action: "diff.prevHunk", icon: "up" },
      { action: "diff.nextHunk", icon: "caret" },
      "|",
      { action: "diff.split", icon: "columns", active: v.split },
      { action: "diff.managedFields", icon: "logs", active: v.managedFields },
      // Enter: the folded "n unchanged lines" bars open and close here too (mouse parity)
      { action: "nav.open", icon: "fold", label: "Show or hide unchanged lines" },
      "|",
      "view.refresh",
      { action: "hub.help", icon: "help" },
    ],
  });
  // a closed pane drops its owner toggles (a reused pane id must not start with letters on)
  layoutStore.subscribe(() => {
    const ws = getWorkspace();
    if (!ws) return;
    for (const p of Object.keys(ownersStore.getState())) if (!ws.panes[p]) clearOwners(p);
  });
  registerToolStatus("diff", () => {
    const n = useDiffPaneCount();
    return n > 0 ? { text: `${n} open`, state: "active" } : null;
  });
  registerToolStatus("owners", () => {
    const n = useOwnersPaneCount();
    return n > 0 ? { text: `on in ${n} ${n === 1 ? "pane" : "panes"}`, state: "active" } : null;
  });
}
