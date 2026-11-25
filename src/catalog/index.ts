// Feature: the organisation catalog (docs/catalog.md). Optional: without a catalog file nothing
// changes. With one, namespace lists, "all namespaces" tables and namespace health fall back on
// the team's namespaces where the cluster refuses to list, rows say which system and team a
// namespace is, and `:env` moves a view to another environment.
import "./actions";
import { initCatalog } from "./store";

export function register(): void {
  initCatalog();
}
