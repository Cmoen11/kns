// The app's RBAC cache and the `enabled` predicate built on it (docs/ux.md §14).
import type { Gvr } from "../../ipc/types";
import { backend, engine, focusedContext } from "../../foundation";
import { createAccessCache } from "./rbac";
import { firstTarget } from "./targets";

export const access = createAccessCache({
  canI: (k) =>
    backend.canI({
      context: k.context,
      verb: k.verb,
      gvr: { group: k.group, version: k.version, resource: k.resource },
      subresource: k.subresource,
      namespace: k.namespace,
    }),
  onChange: () => engine.invalidate(),
});

/**
 * For `enabled`: "no row selected", a "forbidden" reason when RBAC is known to deny the verb on the
 * first target, else true. `on` overrides the resource (CronJob trigger creates a Job).
 */
export function permitted(verb: string, opts: { subresource?: string; on?: () => Gvr | undefined } = {}): true | string {
  const target = firstTarget();
  if (!target) return "no row selected";
  const context = focusedContext();
  if (!context) return true;
  const gvr = opts.on?.() ?? target.gvr;
  const allowed = access.check({
    context, verb, group: gvr.group, version: gvr.version, resource: gvr.resource,
    subresource: opts.subresource, namespace: target.namespace,
  });
  if (allowed !== false) return true;
  const what = opts.subresource ? `${gvr.resource}/${opts.subresource}` : gvr.resource;
  return `forbidden: cannot ${verb} ${what}${target.namespace ? ` in ${target.namespace}` : ""}`;
}
