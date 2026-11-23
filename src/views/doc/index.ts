// Feature: the document view (describe, YAML, JSON, secrets; edit, review, apply) on CodeMirror 6
// (docs/ux.md §13.1, §13.2). View kind: doc. The editor itself is a lazy chunk (DocView).
import { registerPaneGuard, registerView } from "../../foundation";
import "./actions";
import { getUi } from "./session";

export function register(): void {
  registerView({
    kinds: ["doc"],
    component: () => import("./DocView"),
  });
  // A dirty edit is a live session (§4.6): a YAML edit keeps its draft, a secret edit has none.
  registerPaneGuard((pane, view) => {
    if (view.kind !== "doc" || view.mode === "view" || !getUi(pane).dirty) return null;
    return { label: `unsaved edit of ${view.ref.name}`, onClose: view.format === "secret" ? "ends" : "kept" };
  });
}
