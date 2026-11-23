// Feature F actions (docs/plan-features.md §2.7): `pod.debug` (B, :debug [copy]), `snippet.run`
// (:x), `res.kubectl` (:kubectl), `pod.mirrord` (:mirrord). Small and eager; dialogs are lazy.
// `:` commands skip the scope check, so every handler checks for a pod itself.
import { focusedPane, getSettings, registerActions } from "../foundation";
import { selectionTarget } from "../views/shell/open";
import { copyKubectl, copyMirrord, debugFlow, podPermitted, podTarget, snippetFlow } from "./flows";

const isCopy = (args: readonly string[] | undefined): boolean => args?.[0] === "copy";

registerActions({
  "pod.debug": {
    enabled: (ctx) => (isCopy(ctx.args) ? podPermitted("create") : podPermitted("patch", "ephemeralcontainers")),
    run: (ctx) => debugFlow(isCopy(ctx.args), ctx.newPane, getSettings().debugImages),
  },
  "snippet.run": {
    // save / rm need no pod; running one does (a workload row resolves to one of its pods)
    enabled: (ctx) => {
      const w = ctx.args?.[0];
      if (w === "save" || w === "rm") return true;
      if (podTarget()) return podPermitted("create", "exec");
      return selectionTarget(focusedPane()) ? true : "select a pod first";
    },
    run: (ctx) => snippetFlow(ctx.args ?? [], ctx.newPane),
  },
  "res.kubectl": { run: () => copyKubectl() },
  "pod.mirrord": {
    enabled: () => (podTarget() ? true : "select a pod first"),
    run: (ctx) => copyMirrord(ctx.args ?? []),
  },
});
