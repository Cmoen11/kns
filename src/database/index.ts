// Feature: the database view (`:db`, right-click a Postgres/MySQL row → "open database",
// docs/tools.md#database). The view loads lazily; the actions are eager.
import { registerView } from "../foundation";
import "./actions";

export function register(): void {
  registerView({
    kinds: ["database"],
    component: () => import("./DatabaseView"),
    crumbs: (v) => [{ label: v.ref.namespace ?? "" }, { label: v.ref.name }, { label: "database" }],
    toolbar: () => [{ action: "view.refresh", icon: "restart" }, { action: "db.writes", icon: "edit" }],
  });
}
