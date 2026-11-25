// Feature: the organisation catalog (docs/catalog.md). Optional: without a catalog file nothing
// changes. With one, namespace lists, "all namespaces" tables and namespace health fall back on
// the team's namespaces where the cluster refuses to list, rows say which system and team a
// namespace is, `:env` moves a view to another environment, and `:deploys` shows what each
// environment of a system runs (GitHub, through the gh CLI).
import { registerView } from "../foundation";
import { registerTextSource } from "../views/text";
import "./actions";
import "./deploys-actions";
import { loadChanges } from "./deploys";
import { initCatalog } from "./store";

export function register(): void {
  initCatalog();
  registerView({
    kinds: ["deploys"],
    component: () => import("./DeploysView"),
    crumbs: (v) => [{ label: v.namespace, action: "namespace.pick" }, { label: "deploys" }],
    toolbar: () => ["filter.open", "|", { action: "deploys.reload", icon: "history" }],
  });
  registerTextSource("changes", loadChanges);
}
