// Feature: pod traffic (`:traffic`, docs/tools.md#traffic). Who a pod talks to, in and out, from
// readings of its socket table (traffic.rs). The view loads lazily; the actions are eager.
import { registerView } from "../foundation";
import "./actions";

export function register(): void {
  registerView({
    kinds: ["traffic"],
    component: () => import("./TrafficView"),
    crumbs: (v) => [{ label: v.pod.namespace ?? "" }, { label: v.pod.name }, { label: "traffic" }],
    toolbar: () => ["filter.open", "|", { action: "traffic.pause", icon: "pause" }, { action: "traffic.clear", icon: "history" }],
  });
}
