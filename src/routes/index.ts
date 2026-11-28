// Feature: HTTP routes (`:routes`, docs/tools.md#routes). Every way into the cluster over HTTP
// (Ingresses, Gateway API HTTPRoutes) drawn as host and path → route → Service → pods, with the
// first broken link marked. The view loads lazily; the actions are eager.
import { registerView } from "../foundation";
import "./actions";

export function register(): void {
  registerView({
    kinds: ["routes"],
    component: () => import("./RoutesView"),
    crumbs: (v) => [{ label: v.namespace ?? "all namespaces" }, { label: "routes" }],
    toolbar: () => [
      "filter.open",
      { action: "routes.problems", icon: "fault" },
      { action: "routes.allNamespaces", icon: "wide" },
      "|",
      { action: "routes.copyUrl", icon: "copy" },
      { action: "view.refresh", icon: "refresh" },
      "|",
      "hub.help",
    ],
  });
}
