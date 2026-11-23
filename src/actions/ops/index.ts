// Feature: mutating actions and their dialog (docs/ux.md §14). No view kinds.
// Built: res.delete, pod.kill, workload.scale, workload.restart, cronjob.trigger, cronjob.suspend,
// flux.reconcile, flux.reconcileWithSource, flux.suspendResume, node.cordon, node.uncordon, and the
// jumps res.owner, pod.node, deploy.replicaSets.
// Not built (no handler, so hidden): workload.setImage, rs.rollback, node.drain, pod.transfer,
// pod.sanitize, flux.trace, flux.notReady, res.usedBy, res.warp.
import { registerOverlay } from "../../foundation";
import { OPS_DIALOG } from "./ask";
import "./actions";

export function register(): void {
  registerOverlay(OPS_DIALOG, () => import("./OpDialog"));
}
